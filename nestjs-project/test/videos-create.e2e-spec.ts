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

interface CreateVideoResponseBody {
  id: string;
  status: string;
  upload_id: string;
  storage_key: string;
}

describe('videos-create', () => {
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

  describe('1. POST /videos', () => {
    it('1.1 cria-rascunho-e-inicia-multipart-upload', async () => {
      const accessToken = await registerConfirmAndLogin(
        app,
        'creator@example.com',
      );

      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          title: 'My video',
          mime_type: 'video/mp4',
          size_bytes: 104857600,
        })
        .expect(201);

      const body = res.body as CreateVideoResponseBody;
      expect(body.id).toBeDefined();
      expect(body.status).toBe('draft');
      expect(body.upload_id).toBeTruthy();
      expect(body.storage_key).toBeDefined();
    });

    it('1.2 rejeita-sem-autenticacao', async () => {
      await request(app.getHttpServer())
        .post('/videos')
        .send({
          title: 'My video',
          mime_type: 'video/mp4',
          size_bytes: 1024,
        })
        .expect(401);
    });

    it('1.3 rejeita-payload-invalido', async () => {
      const accessToken = await registerConfirmAndLogin(
        app,
        'invalid@example.com',
      );

      await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          title: 'My video',
          mime_type: 'application/pdf',
          size_bytes: 1024,
        })
        .expect(400);

      await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          title: 'My video',
          mime_type: 'video/mp4',
          size_bytes: 10 * 1024 ** 3 + 1,
        })
        .expect(400);
    });
  });
});
