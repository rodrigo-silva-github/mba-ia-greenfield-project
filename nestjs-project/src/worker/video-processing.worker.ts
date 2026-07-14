import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import ffmpeg from 'fluent-ffmpeg';
import PgBoss from 'pg-boss';
import { Repository } from 'typeorm';
import storageConfig from '../config/storage.config';
import { PG_BOSS } from '../queue/queue.module';
import { S3_CLIENT } from '../storage/storage.module';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { VIDEO_PROCESSING_QUEUE } from '../videos/videos.constants';

@Injectable()
export class VideoProcessingWorker implements OnModuleInit {
  private readonly logger = new Logger(VideoProcessingWorker.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    @Inject(S3_CLIENT) private readonly s3Client: S3Client,
    @Inject(PG_BOSS) private readonly boss: PgBoss,
    @Inject(storageConfig.KEY)
    private readonly storage: ConfigType<typeof storageConfig>,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.boss.work<{ video_id: string }>(
      VIDEO_PROCESSING_QUEUE,
      async ([job]) => {
        await this.processVideo(job.data.video_id);
      },
    );
  }

  async processVideo(videoId: string): Promise<void> {
    const video = await this.videoRepository.findOne({
      where: { id: videoId },
    });
    if (!video) {
      this.logger.warn(`Video ${videoId} not found, skipping processing`);
      return;
    }

    const uniqueSuffix = randomUUID();
    const tempVideoPath = join(
      tmpdir(),
      `${videoId}-${uniqueSuffix}${extname(video.storage_key) || '.bin'}`,
    );
    const thumbnailFilename = `${videoId}-${uniqueSuffix}-thumbnail.jpg`;
    const thumbnailLocalPath = join(tmpdir(), thumbnailFilename);
    const thumbnailStorageKey = `videos/${video.channel_id}/${video.id}/thumbnail.jpg`;

    try {
      await this.downloadToTempFile(video.storage_key, tempVideoPath);
      const durationSeconds = await this.extractDurationSeconds(tempVideoPath);
      await this.generateThumbnail(tempVideoPath, tmpdir(), thumbnailFilename);
      await this.uploadToStorage(thumbnailLocalPath, thumbnailStorageKey);

      video.status = VideoStatus.READY;
      video.duration_seconds = Math.round(durationSeconds);
      video.thumbnail_storage_key = thumbnailStorageKey;
      video.error_message = null;
      await this.videoRepository.save(video);
    } catch (err) {
      video.status = VideoStatus.ERROR;
      video.error_message = err instanceof Error ? err.message : String(err);
      await this.videoRepository.save(video);
      throw err;
    } finally {
      await rm(tempVideoPath, { force: true });
      await rm(thumbnailLocalPath, { force: true });
    }
  }

  private async downloadToTempFile(
    storageKey: string,
    destPath: string,
  ): Promise<void> {
    const { Body } = await this.s3Client.send(
      new GetObjectCommand({ Bucket: this.storage.bucket, Key: storageKey }),
    );
    await pipeline(Body as NodeJS.ReadableStream, createWriteStream(destPath));
  }

  private extractDurationSeconds(filePath: string): Promise<number> {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(filePath, (err, metadata) => {
        if (err) {
          return reject(err instanceof Error ? err : new Error(String(err)));
        }
        resolve(metadata.format.duration ?? 0);
      });
    });
  }

  private generateThumbnail(
    filePath: string,
    outputFolder: string,
    outputFilename: string,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      ffmpeg(filePath)
        .on('end', () => resolve())
        .on('error', (err: Error) => reject(err))
        .screenshots({
          timestamps: ['50%'],
          filename: outputFilename,
          folder: outputFolder,
        });
    });
  }

  private async uploadToStorage(localPath: string, key: string): Promise<void> {
    const upload = new Upload({
      client: this.s3Client,
      params: {
        Bucket: this.storage.bucket,
        Key: key,
        Body: createReadStream(localPath),
      },
    });
    await upload.done();
  }
}
