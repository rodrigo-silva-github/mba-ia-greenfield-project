import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { AppModule } from '../src/app.module';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { registerConfirmAndLogin } from './helpers/auth';

interface IdResponseBody {
  id: string;
}

interface UploadUrlsResponseBody {
  urls: { part_number: number; url: string }[];
}

interface CompleteUploadResponseBody {
  id: string;
  status: string;
}

interface ErrorResponseBody {
  error: string;
}

describe('videos-complete-upload', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await dataSource.query(
      `DELETE FROM pgboss.job WHERE name = 'video-processing'`,
    );
    throttlerStorage.storage.clear();
  });

  async function createVideoWithUploadedPart(
    accessToken: string,
  ): Promise<{ videoId: string; partNumber: number; etag: string }> {
    const createRes = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        title: 'Complete upload video',
        mime_type: 'video/mp4',
        size_bytes: 10,
      });
    const videoId = (createRes.body as IdResponseBody).id;

    const urlsRes = await request(app.getHttpServer())
      .post(`/videos/${videoId}/upload-urls`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ part_numbers: [1] });
    const url = (urlsRes.body as UploadUrlsResponseBody).urls[0].url;

    const uploadResponse = await fetch(url, {
      method: 'PUT',
      body: Buffer.from('0123456789'),
    });
    const etag = uploadResponse.headers.get('etag')!;

    return { videoId, partNumber: 1, etag };
  }

  describe('1. POST /videos/:id/complete-upload', () => {
    it('1.1 conclui-upload-e-inicia-processamento', async () => {
      const accessToken = await registerConfirmAndLogin(
        app,
        'completer1@example.com',
      );
      const { videoId, partNumber, etag } =
        await createVideoWithUploadedPart(accessToken);

      const res = await request(app.getHttpServer())
        .post(`/videos/${videoId}/complete-upload`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ parts: [{ part_number: partNumber, etag }] })
        .expect(200);

      const body = res.body as CompleteUploadResponseBody;
      expect(body.id).toBe(videoId);
      expect(body.status).toBe('processing');
    });

    it('1.2 rejeita-conclusao-duplicada', async () => {
      const accessToken = await registerConfirmAndLogin(
        app,
        'completer2@example.com',
      );
      const { videoId, partNumber, etag } =
        await createVideoWithUploadedPart(accessToken);

      await request(app.getHttpServer())
        .post(`/videos/${videoId}/complete-upload`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ parts: [{ part_number: partNumber, etag }] })
        .expect(200);

      const res = await request(app.getHttpServer())
        .post(`/videos/${videoId}/complete-upload`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ parts: [{ part_number: partNumber, etag }] })
        .expect(409);

      expect((res.body as ErrorResponseBody).error).toBe(
        'UPLOAD_ALREADY_COMPLETED',
      );
    });

    it('1.3 publica-job-de-processamento-na-fila', async () => {
      const accessToken = await registerConfirmAndLogin(
        app,
        'completer3@example.com',
      );
      const { videoId, partNumber, etag } =
        await createVideoWithUploadedPart(accessToken);

      await request(app.getHttpServer())
        .post(`/videos/${videoId}/complete-upload`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ parts: [{ part_number: partNumber, etag }] })
        .expect(200);

      const jobs: unknown[] = await dataSource.query(
        `SELECT data FROM pgboss.job WHERE name = 'video-processing' AND data->>'video_id' = $1`,
        [videoId],
      );
      expect(jobs).toHaveLength(1);
    });
  });
});
