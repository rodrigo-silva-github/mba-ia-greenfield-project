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

interface ErrorResponseBody {
  error: string;
}

describe('videos-download', () => {
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

  async function createVideo(
    accessToken: string,
    status: 'ready' | 'error',
  ): Promise<string> {
    const createRes = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        title: 'Download video',
        mime_type: 'video/mp4',
        size_bytes: 1024,
      });
    const videoId = (createRes.body as IdResponseBody).id;

    await dataSource.query(`UPDATE videos SET status = $1 WHERE id = $2`, [
      status,
      videoId,
    ]);

    return videoId;
  }

  describe('1. GET /videos/:id/download', () => {
    it('1.1 redireciona-para-url-pre-assinada-de-download-quando-ready', async () => {
      const accessToken = await registerConfirmAndLogin(
        app,
        'downloader1@example.com',
      );
      const videoId = await createVideo(accessToken, 'ready');

      const res = await request(app.getHttpServer())
        .get(`/videos/${videoId}/download`)
        .expect(302);

      expect(res.headers.location).toBeDefined();
      expect(res.headers.location.toLowerCase()).toContain(
        'response-content-disposition=attachment',
      );
    });

    it('1.2 rejeita-video-nao-pronto', async () => {
      const accessToken = await registerConfirmAndLogin(
        app,
        'downloader2@example.com',
      );
      const videoId = await createVideo(accessToken, 'error');

      const res = await request(app.getHttpServer())
        .get(`/videos/${videoId}/download`)
        .expect(409);

      expect((res.body as ErrorResponseBody).error).toBe('VIDEO_NOT_READY');
    });

    it('1.3 rejeita-id-inexistente', async () => {
      const res = await request(app.getHttpServer())
        .get('/videos/00000000-0000-0000-0000-000000000000/download')
        .expect(404);

      expect((res.body as ErrorResponseBody).error).toBe('VIDEO_NOT_FOUND');
    });
  });
});
