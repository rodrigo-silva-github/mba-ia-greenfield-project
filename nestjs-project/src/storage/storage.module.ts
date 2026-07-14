import { Global, Module } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { S3Client } from '@aws-sdk/client-s3';
import storageConfig from '../config/storage.config';

export const S3_CLIENT = Symbol('S3_CLIENT');

@Global()
@Module({
  providers: [
    {
      provide: S3_CLIENT,
      inject: [storageConfig.KEY],
      useFactory: (storage: ConfigType<typeof storageConfig>) =>
        new S3Client({
          endpoint: storage.endpoint,
          region: storage.region,
          forcePathStyle: true,
          credentials: {
            accessKeyId: storage.accessKeyId,
            secretAccessKey: storage.secretAccessKey,
          },
        }),
    },
  ],
  exports: [S3_CLIENT],
})
export class StorageModule {}
