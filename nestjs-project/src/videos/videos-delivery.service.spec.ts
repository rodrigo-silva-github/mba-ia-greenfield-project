import { getRepositoryToken } from '@nestjs/typeorm';
import { Test } from '@nestjs/testing';
import { Repository } from 'typeorm';
import storageConfig from '../config/storage.config';
import { S3_CLIENT } from '../storage/storage.module';
import { Video, VideoStatus } from './entities/video.entity';
import {
  VideoNotFoundException,
  VideoNotReadyException,
} from './exceptions/video.exception';
import { VideosDeliveryService } from './videos-delivery.service';

const mockStorageConfig = {
  endpoint: 'http://minio:9000',
  bucket: 'streamtube',
  region: 'us-east-1',
  accessKeyId: 'test',
  secretAccessKey: 'test',
};

function buildVideo(overrides: Partial<Video> = {}): Video {
  return {
    id: 'video-1',
    channel_id: 'channel-1',
    title: 'Title',
    description: null,
    status: VideoStatus.READY,
    error_message: null,
    storage_key: 'videos/channel-1/video-1/original.mp4',
    thumbnail_storage_key: null,
    upload_id: null,
    duration_seconds: 60,
    size_bytes: null,
    mime_type: null,
    created_at: new Date(),
    updated_at: new Date(),
    channel: undefined as never,
    ...overrides,
  };
}

describe('VideosDeliveryService', () => {
  let deliveryService: VideosDeliveryService;
  let videoRepository: jest.Mocked<Repository<Video>>;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        VideosDeliveryService,
        {
          provide: getRepositoryToken(Video),
          useValue: { findOne: jest.fn() },
        },
        {
          provide: S3_CLIENT,
          useValue: { send: jest.fn() },
        },
        {
          provide: storageConfig.KEY,
          useValue: mockStorageConfig,
        },
      ],
    }).compile();

    deliveryService = module.get(VideosDeliveryService);
    videoRepository = module.get(getRepositoryToken(Video));
  });

  describe('findByIdForViewer', () => {
    it('should throw VideoNotFoundException when the video does not exist', async () => {
      videoRepository.findOne.mockResolvedValue(null);

      await expect(
        deliveryService.findByIdForViewer('missing', null),
      ).rejects.toThrow(VideoNotFoundException);
    });

    it('should return a ready video for an anonymous viewer', async () => {
      videoRepository.findOne.mockResolvedValue(
        buildVideo({ status: VideoStatus.READY }),
      );

      await expect(
        deliveryService.findByIdForViewer('video-1', null),
      ).resolves.toMatchObject({ status: VideoStatus.READY });
    });

    it('should return a draft video to its owner', async () => {
      videoRepository.findOne.mockResolvedValue(
        buildVideo({ status: VideoStatus.DRAFT, channel_id: 'channel-1' }),
      );

      await expect(
        deliveryService.findByIdForViewer('video-1', 'channel-1'),
      ).resolves.toMatchObject({ status: VideoStatus.DRAFT });
    });

    it('should hide a draft video from a non-owner behind VideoNotFoundException', async () => {
      videoRepository.findOne.mockResolvedValue(
        buildVideo({ status: VideoStatus.DRAFT, channel_id: 'channel-1' }),
      );

      await expect(
        deliveryService.findByIdForViewer('video-1', 'other-channel'),
      ).rejects.toThrow(VideoNotFoundException);
    });

    it('should hide a draft video from an anonymous viewer behind VideoNotFoundException', async () => {
      videoRepository.findOne.mockResolvedValue(
        buildVideo({ status: VideoStatus.DRAFT, channel_id: 'channel-1' }),
      );

      await expect(
        deliveryService.findByIdForViewer('video-1', null),
      ).rejects.toThrow(VideoNotFoundException);
    });
  });

  describe('getPresignedReadUrl', () => {
    it('should throw VideoNotFoundException when the video does not exist', async () => {
      videoRepository.findOne.mockResolvedValue(null);

      await expect(
        deliveryService.getPresignedReadUrl('missing', false),
      ).rejects.toThrow(VideoNotFoundException);
    });

    it('should throw VideoNotReadyException when status is not ready', async () => {
      videoRepository.findOne.mockResolvedValue(
        buildVideo({ status: VideoStatus.PROCESSING }),
      );

      await expect(
        deliveryService.getPresignedReadUrl('video-1', false),
      ).rejects.toThrow(VideoNotReadyException);
    });
  });
});
