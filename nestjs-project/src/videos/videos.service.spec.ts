import { getRepositoryToken } from '@nestjs/typeorm';
import { Test } from '@nestjs/testing';
import { Repository } from 'typeorm';
import storageConfig from '../config/storage.config';
import { PG_BOSS } from '../queue/queue.module';
import { S3_CLIENT } from '../storage/storage.module';
import { Video, VideoStatus } from './entities/video.entity';
import {
  InvalidPartNumbersException,
  UploadAlreadyCompletedException,
  VideoNotFoundException,
  VideoNotOwnedException,
} from './exceptions/video.exception';
import { VideosService } from './videos.service';
import {
  VIDEO_PROCESSING_QUEUE,
  VIDEO_PROCESSING_RETRY_POLICY,
} from './videos.constants';

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
    status: VideoStatus.DRAFT,
    error_message: null,
    storage_key: 'videos/channel-1/video-1/original.mp4',
    thumbnail_storage_key: null,
    upload_id: 'upload-1',
    duration_seconds: null,
    size_bytes: null,
    mime_type: null,
    created_at: new Date(),
    updated_at: new Date(),
    channel: undefined as never,
    ...overrides,
  };
}

describe('VideosService', () => {
  let videosService: VideosService;
  let videoRepository: jest.Mocked<Repository<Video>>;
  let s3Client: { send: jest.Mock };
  let boss: { createQueue: jest.Mock; send: jest.Mock };

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        VideosService,
        {
          provide: getRepositoryToken(Video),
          useValue: {
            create: jest.fn((v: Partial<Video>) => v as Video),
            save: jest.fn((v: Video) => Promise.resolve(v)),
            findOne: jest.fn(),
          },
        },
        {
          provide: S3_CLIENT,
          useValue: { send: jest.fn() },
        },
        {
          provide: PG_BOSS,
          useValue: { createQueue: jest.fn(), send: jest.fn() },
        },
        {
          provide: storageConfig.KEY,
          useValue: mockStorageConfig,
        },
      ],
    }).compile();

    videosService = module.get(VideosService);
    videoRepository = module.get(getRepositoryToken(Video));
    s3Client = module.get(S3_CLIENT);
    boss = module.get(PG_BOSS);
  });

  describe('onModuleInit', () => {
    it('should register the video-processing queue and ensure the bucket exists', async () => {
      s3Client.send.mockResolvedValue({});

      await videosService.onModuleInit();

      expect(boss.createQueue).toHaveBeenCalledWith(
        VIDEO_PROCESSING_QUEUE,
        VIDEO_PROCESSING_RETRY_POLICY,
      );
      expect(s3Client.send).toHaveBeenCalled();
    });

    it('should ignore a BucketAlreadyOwnedByYou error', async () => {
      s3Client.send.mockRejectedValue({ name: 'BucketAlreadyOwnedByYou' });

      await expect(videosService.onModuleInit()).resolves.not.toThrow();
    });

    it('should rethrow unexpected bucket-creation errors', async () => {
      s3Client.send.mockRejectedValue({ name: 'SomeOtherError' });

      await expect(videosService.onModuleInit()).rejects.toEqual({
        name: 'SomeOtherError',
      });
    });
  });

  describe('generatePresignedPartUrls', () => {
    it('should throw VideoNotFoundException when the video does not exist', async () => {
      videoRepository.findOne.mockResolvedValue(null);

      await expect(
        videosService.generatePresignedPartUrls('missing', 'channel-1', [1]),
      ).rejects.toThrow(VideoNotFoundException);
    });

    it('should throw VideoNotOwnedException when the video belongs to another channel', async () => {
      videoRepository.findOne.mockResolvedValue(
        buildVideo({ channel_id: 'other-channel' }),
      );

      await expect(
        videosService.generatePresignedPartUrls('video-1', 'channel-1', [1]),
      ).rejects.toThrow(VideoNotOwnedException);
    });

    it('should throw UploadAlreadyCompletedException when upload_id is null', async () => {
      videoRepository.findOne.mockResolvedValue(
        buildVideo({ upload_id: null }),
      );

      await expect(
        videosService.generatePresignedPartUrls('video-1', 'channel-1', [1]),
      ).rejects.toThrow(UploadAlreadyCompletedException);
    });

    it('should throw InvalidPartNumbersException when a part number is out of range', async () => {
      videoRepository.findOne.mockResolvedValue(buildVideo());

      await expect(
        videosService.generatePresignedPartUrls('video-1', 'channel-1', [0]),
      ).rejects.toThrow(InvalidPartNumbersException);

      await expect(
        videosService.generatePresignedPartUrls(
          'video-1',
          'channel-1',
          [10001],
        ),
      ).rejects.toThrow(InvalidPartNumbersException);
    });
  });

  describe('completeUpload', () => {
    it('should throw UploadAlreadyCompletedException when upload_id is null', async () => {
      videoRepository.findOne.mockResolvedValue(
        buildVideo({ upload_id: null }),
      );

      await expect(
        videosService.completeUpload('video-1', 'channel-1', [
          { part_number: 1, etag: 'abc' },
        ]),
      ).rejects.toThrow(UploadAlreadyCompletedException);
    });

    it('should complete the multipart upload and enqueue the processing job', async () => {
      videoRepository.findOne.mockResolvedValue(buildVideo());
      s3Client.send.mockResolvedValue({});

      const result = await videosService.completeUpload(
        'video-1',
        'channel-1',
        [{ part_number: 1, etag: 'abc' }],
      );

      expect(result.status).toBe(VideoStatus.PROCESSING);
      expect(result.upload_id).toBeNull();
      expect(boss.send).toHaveBeenCalledWith(VIDEO_PROCESSING_QUEUE, {
        video_id: 'video-1',
      });
    });
  });
});
