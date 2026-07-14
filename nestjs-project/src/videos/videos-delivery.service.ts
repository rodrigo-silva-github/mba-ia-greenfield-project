import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Repository } from 'typeorm';
import storageConfig from '../config/storage.config';
import { S3_CLIENT } from '../storage/storage.module';
import { Video, VideoStatus } from './entities/video.entity';
import {
  VideoNotFoundException,
  VideoNotReadyException,
} from './exceptions/video.exception';

const PRESIGNED_URL_EXPIRATION_SECONDS = 3600;

@Injectable()
export class VideosDeliveryService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    @Inject(S3_CLIENT) private readonly s3Client: S3Client,
    @Inject(storageConfig.KEY)
    private readonly storage: ConfigType<typeof storageConfig>,
  ) {}

  async findByIdForViewer(
    videoId: string,
    viewerChannelId: string | null,
  ): Promise<Video> {
    const video = await this.videoRepository.findOne({
      where: { id: videoId },
    });
    if (!video) throw new VideoNotFoundException();
    if (video.status === VideoStatus.READY) return video;
    if (viewerChannelId && video.channel_id === viewerChannelId) return video;
    throw new VideoNotFoundException();
  }

  async getPresignedReadUrl(
    videoId: string,
    forDownload: boolean,
  ): Promise<string> {
    const video = await this.videoRepository.findOne({
      where: { id: videoId },
    });
    if (!video) throw new VideoNotFoundException();
    if (video.status !== VideoStatus.READY) throw new VideoNotReadyException();

    return getSignedUrl(
      this.s3Client,
      new GetObjectCommand({
        Bucket: this.storage.bucket,
        Key: video.storage_key,
        ...(forDownload ? { ResponseContentDisposition: 'attachment' } : {}),
      }),
      { expiresIn: PRESIGNED_URL_EXPIRATION_SECONDS },
    );
  }
}
