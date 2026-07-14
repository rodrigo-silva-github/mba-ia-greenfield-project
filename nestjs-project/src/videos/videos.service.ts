import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import {
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import PgBoss from 'pg-boss';
import { Repository } from 'typeorm';
import storageConfig from '../config/storage.config';
import { PG_BOSS } from '../queue/queue.module';
import { S3_CLIENT } from '../storage/storage.module';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { CreateVideoDto } from './dto/create-video.dto';
import { Video, VideoStatus } from './entities/video.entity';
import {
  InvalidPartNumbersException,
  UploadAlreadyCompletedException,
  VideoNotFoundException,
  VideoNotOwnedException,
} from './exceptions/video.exception';
import {
  S3_MULTIPART_PART_NUMBER_RANGE,
  VIDEO_PROCESSING_QUEUE,
  VIDEO_PROCESSING_RETRY_POLICY,
} from './videos.constants';

export interface PresignedPartUrl {
  part_number: number;
  url: string;
}

const PRESIGNED_URL_EXPIRATION_SECONDS = 3600;

@Injectable()
export class VideosService implements OnModuleInit {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    @Inject(S3_CLIENT) private readonly s3Client: S3Client,
    @Inject(PG_BOSS) private readonly boss: PgBoss,
    @Inject(storageConfig.KEY)
    private readonly storage: ConfigType<typeof storageConfig>,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.boss.createQueue(
      VIDEO_PROCESSING_QUEUE,
      VIDEO_PROCESSING_RETRY_POLICY,
    );
    await this.ensureBucketExists();
  }

  private async ensureBucketExists(): Promise<void> {
    try {
      await this.s3Client.send(
        new CreateBucketCommand({ Bucket: this.storage.bucket }),
      );
    } catch (err) {
      const name = (err as { name?: string }).name;
      if (
        name !== 'BucketAlreadyOwnedByYou' &&
        name !== 'BucketAlreadyExists'
      ) {
        throw err;
      }
    }
  }

  async createDraftAndInitiateUpload(
    channelId: string,
    dto: CreateVideoDto,
  ): Promise<Video> {
    const draft = await this.videoRepository.save(
      this.videoRepository.create({
        channel_id: channelId,
        title: dto.title,
        description: dto.description ?? null,
        size_bytes: String(dto.size_bytes),
        mime_type: dto.mime_type,
        storage_key: '',
      }),
    );

    const extension = dto.mime_type.split('/')[1] ?? 'bin';
    const storageKey = `videos/${channelId}/${draft.id}/original.${extension}`;

    const { UploadId } = await this.s3Client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.storage.bucket,
        Key: storageKey,
      }),
    );

    draft.storage_key = storageKey;
    draft.upload_id = UploadId ?? null;
    return this.videoRepository.save(draft);
  }

  async generatePresignedPartUrls(
    videoId: string,
    channelId: string,
    partNumbers: number[],
  ): Promise<PresignedPartUrl[]> {
    const video = await this.findOwnedVideoOrThrow(videoId, channelId);
    this.assertUploadInProgress(video);

    for (const partNumber of partNumbers) {
      if (
        partNumber < S3_MULTIPART_PART_NUMBER_RANGE.MIN ||
        partNumber > S3_MULTIPART_PART_NUMBER_RANGE.MAX
      ) {
        throw new InvalidPartNumbersException();
      }
    }

    return Promise.all(
      partNumbers.map(async (partNumber) => ({
        part_number: partNumber,
        url: await getSignedUrl(
          this.s3Client,
          new UploadPartCommand({
            Bucket: this.storage.bucket,
            Key: video.storage_key,
            UploadId: video.upload_id!,
            PartNumber: partNumber,
          }),
          { expiresIn: PRESIGNED_URL_EXPIRATION_SECONDS },
        ),
      })),
    );
  }

  async completeUpload(
    videoId: string,
    channelId: string,
    parts: CompleteUploadDto['parts'],
  ): Promise<Video> {
    const video = await this.findOwnedVideoOrThrow(videoId, channelId);
    this.assertUploadInProgress(video);

    await this.s3Client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.storage.bucket,
        Key: video.storage_key,
        UploadId: video.upload_id!,
        MultipartUpload: {
          Parts: parts.map((part) => ({
            ETag: part.etag,
            PartNumber: part.part_number,
          })),
        },
      }),
    );

    video.status = VideoStatus.PROCESSING;
    video.upload_id = null;
    const saved = await this.videoRepository.save(video);

    await this.boss.send(VIDEO_PROCESSING_QUEUE, { video_id: saved.id });

    return saved;
  }

  private async findOwnedVideoOrThrow(
    videoId: string,
    channelId: string,
  ): Promise<Video> {
    const video = await this.videoRepository.findOne({
      where: { id: videoId },
    });
    if (!video) throw new VideoNotFoundException();
    if (video.channel_id !== channelId) throw new VideoNotOwnedException();
    return video;
  }

  private assertUploadInProgress(video: Video): void {
    if (!video.upload_id) throw new UploadAlreadyCompletedException();
  }
}
