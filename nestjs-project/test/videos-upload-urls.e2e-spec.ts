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

interface ErrorResponseBody {
  error: string;
}

describe('videos-upload-urls', () => {
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
    throttlerStorage.storage.clear();
  });

  async function createVideo(accessToken: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        title: 'Upload urls video',
        mime_type: 'video/mp4',
        size_bytes: 1024,
      });
    return (res.body as IdResponseBody).id;
  }

  describe('1. POST /videos/:id/upload-urls', () => {
    it('1.1 retorna-uma-url-por-parte-solicitada', async () => {
      const accessToken = await registerConfirmAndLogin(
        app,
        'owner1@example.com',
      );
      const videoId = await createVideo(accessToken);

      const res = await request(app.getHttpServer())
        .post(`/videos/${videoId}/upload-urls`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ part_numbers: [1, 2, 3] })
        .expect(200);

      const body = res.body as UploadUrlsResponseBody;
      expect(body.urls).toHaveLength(3);
      expect(body.urls.map((u) => u.part_number)).toEqual([1, 2, 3]);
    });

    it('1.2 rejeita-vídeo-de-outro-canal', async () => {
      const ownerToken = await registerConfirmAndLogin(
        app,
        'owner2@example.com',
      );
      const videoId = await createVideo(ownerToken);
      const otherToken = await registerConfirmAndLogin(
        app,
        'other2@example.com',
      );

      const res = await request(app.getHttpServer())
        .post(`/videos/${videoId}/upload-urls`)
        .set('Authorization', `Bearer ${otherToken}`)
        .send({ part_numbers: [1] })
        .expect(403);

      expect((res.body as ErrorResponseBody).error).toBe('VIDEO_NOT_OWNED');
    });

    it('1.3 rejeita-vídeo-inexistente', async () => {
      const accessToken = await registerConfirmAndLogin(
        app,
        'owner3@example.com',
      );

      const res = await request(app.getHttpServer())
        .post('/videos/00000000-0000-0000-0000-000000000000/upload-urls')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ part_numbers: [1] })
        .expect(404);

      expect((res.body as ErrorResponseBody).error).toBe('VIDEO_NOT_FOUND');
    });
  });
});
