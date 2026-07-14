import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { MailService } from '../../src/mail/mail.service';

interface LoginResponseBody {
  access_token: string;
}

export async function registerConfirmAndLogin(
  app: INestApplication<App>,
  email: string,
  password = 'password123',
): Promise<string> {
  const mailService = app.get(MailService);
  let capturedToken = '';
  jest
    .spyOn(mailService, 'sendConfirmationEmail')
    .mockImplementationOnce((_e: string, _n: string, t: string) => {
      capturedToken = t;
      return Promise.resolve();
    });

  await request(app.getHttpServer()).post('/auth/register').send({
    email,
    password,
  });
  await request(app.getHttpServer())
    .get('/auth/confirm-email')
    .query({ token: capturedToken });
  const res = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ email, password });
  return (res.body as LoginResponseBody).access_token;
}
