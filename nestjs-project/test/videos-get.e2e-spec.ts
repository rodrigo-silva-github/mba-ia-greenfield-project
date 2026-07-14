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

interface VideoMetadataResponseBody {
  id: string;
  title: string;
  description: string | null;
  status: string;
  duration_seconds: number | null;
  created_at: string;
}

interface ErrorResponseBody {
  error: string;
}

describe('videos-get', () => {
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
    status: 'ready' | 'draft',
  ): Promise<string> {
    const createRes = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        title: 'Get video',
        mime_type: 'video/mp4',
        size_bytes: 1024,
      });
    const videoId = (createRes.body as IdResponseBody).id;

    if (status === 'ready') {
      await dataSource.query(
        `UPDATE videos SET status = 'ready' WHERE id = $1`,
        [videoId],
      );
    }

    return videoId;
  }

  describe('1. GET /videos/:id', () => {
    it('1.1 retorna-metadados-de-video-ready-sem-autenticacao', async () => {
      const ownerToken = await registerConfirmAndLogin(
        app,
        'getter1@example.com',
      );
      const videoId = await createVideo(ownerToken, 'ready');

      const res = await request(app.getHttpServer())
        .get(`/videos/${videoId}`)
        .expect(200);

      const body = res.body as VideoMetadataResponseBody;
      expect(body).toMatchObject({
        id: videoId,
        status: 'ready',
      });
      expect(body.title).toBeDefined();
      expect(body.description).toBeDefined();
      expect(body.duration_seconds).toBeDefined();
      expect(body.created_at).toBeDefined();
    });

    it('1.2 oculta-rascunho-de-outro-canal', async () => {
      const ownerToken = await registerConfirmAndLogin(
        app,
        'getter2@example.com',
      );
      const videoId = await createVideo(ownerToken, 'draft');
      const otherToken = await registerConfirmAndLogin(
        app,
        'other-getter2@example.com',
      );

      const res = await request(app.getHttpServer())
        .get(`/videos/${videoId}`)
        .set('Authorization', `Bearer ${otherToken}`)
        .expect(404);

      expect((res.body as ErrorResponseBody).error).toBe('VIDEO_NOT_FOUND');
    });

    it('1.3 rejeita-id-inexistente', async () => {
      const res = await request(app.getHttpServer())
        .get('/videos/00000000-0000-0000-0000-000000000000')
        .expect(404);

      expect((res.body as ErrorResponseBody).error).toBe('VIDEO_NOT_FOUND');
    });
  });
});
