import { getRepositoryToken } from '@nestjs/typeorm';
import { Test } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import { PG_BOSS } from '../queue/queue.module';
import { S3_CLIENT } from '../storage/storage.module';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { VIDEO_PROCESSING_QUEUE } from '../videos/videos.constants';
import { VideoProcessingWorker } from './video-processing.worker';

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
    status: VideoStatus.PROCESSING,
    error_message: null,
    storage_key: 'videos/channel-1/video-1/original.mp4',
    thumbnail_storage_key: null,
    upload_id: null,
    duration_seconds: null,
    size_bytes: null,
    mime_type: null,
    created_at: new Date(),
    updated_at: new Date(),
    channel: undefined as never,
    ...overrides,
  };
}

describe('VideoProcessingWorker', () => {
  let worker: VideoProcessingWorker;
  let videoRepository: { findOne: jest.Mock; save: jest.Mock };
  let boss: { work: jest.Mock };

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        VideoProcessingWorker,
        {
          provide: getRepositoryToken(Video),
          useValue: {
            findOne: jest.fn(),
            save: jest.fn((v: Video) => Promise.resolve(v)),
          },
        },
        {
          provide: S3_CLIENT,
          useValue: { send: jest.fn() },
        },
        {
          provide: PG_BOSS,
          useValue: { work: jest.fn() },
        },
        {
          provide: storageConfig.KEY,
          useValue: mockStorageConfig,
        },
      ],
    }).compile();

    worker = module.get(VideoProcessingWorker);
    videoRepository = module.get(getRepositoryToken(Video));
    boss = module.get(PG_BOSS);
  });

  describe('onModuleInit', () => {
    it('registers a worker on the video-processing queue', async () => {
      await worker.onModuleInit();

      expect(boss.work).toHaveBeenCalledWith(
        VIDEO_PROCESSING_QUEUE,
        expect.any(Function),
      );
    });
  });

  describe('processVideo', () => {
    it('does nothing when the video does not exist', async () => {
      videoRepository.findOne.mockResolvedValue(null);

      await expect(worker.processVideo('missing')).resolves.toBeUndefined();
      expect(videoRepository.save).not.toHaveBeenCalled();
    });

    it('marks the video ready and stores duration/thumbnail on success', async () => {
      const video = buildVideo();
      videoRepository.findOne.mockResolvedValue(video);

      jest
        .spyOn(worker as any, 'downloadToTempFile')
        .mockResolvedValue(undefined);
      jest
        .spyOn(worker as any, 'extractDurationSeconds')
        .mockResolvedValue(42.7);
      jest
        .spyOn(worker as any, 'generateThumbnail')
        .mockResolvedValue(undefined);
      jest.spyOn(worker as any, 'uploadToStorage').mockResolvedValue(undefined);

      await worker.processVideo('video-1');

      expect(videoRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          status: VideoStatus.READY,
          duration_seconds: 43,
          thumbnail_storage_key: `videos/${video.channel_id}/${video.id}/thumbnail.jpg`,
          error_message: null,
        }),
      );
    });

    it('marks the video as error and rethrows when processing fails', async () => {
      const video = buildVideo();
      videoRepository.findOne.mockResolvedValue(video);

      jest
        .spyOn(worker as any, 'downloadToTempFile')
        .mockRejectedValue(new Error('storage unreachable'));

      await expect(worker.processVideo('video-1')).rejects.toThrow(
        'storage unreachable',
      );

      expect(videoRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          status: VideoStatus.ERROR,
          error_message: 'storage unreachable',
        }),
      );
    });
  });
});
