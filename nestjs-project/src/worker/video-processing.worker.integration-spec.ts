import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigModule, ConfigType } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm';
import {
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { DataSource, Repository } from 'typeorm';
import databaseConfig from '../config/database.config';
import storageConfig from '../config/storage.config';
import { Channel } from '../channels/entities/channel.entity';
import { QueueModule } from '../queue/queue.module';
import { S3_CLIENT, StorageModule } from '../storage/storage.module';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { VideoProcessingWorker } from './video-processing.worker';

const ALL_ENTITIES = [User, Channel, Video];
const FIXTURE_PATH = join(__dirname, 'fixtures', 'sample-video.mp4');

async function createWorkerTestModule(): Promise<TestingModule> {
  const ds = createTestDataSource(ALL_ENTITIES);
  return Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        load: [databaseConfig, storageConfig],
      }),
      TypeOrmModule.forRoot(ds.options),
      TypeOrmModule.forFeature([User, Channel, Video]),
      QueueModule,
      StorageModule,
    ],
    providers: [VideoProcessingWorker],
  }).compile();
}

describe('VideoProcessingWorker (integration)', () => {
  let module: TestingModule;
  let worker: VideoProcessingWorker;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;
  let s3Client: S3Client;
  let dataSource: DataSource;
  let bucket: string;

  beforeAll(async () => {
    module = await createWorkerTestModule();
    await module.init();

    worker = module.get(VideoProcessingWorker);
    dataSource = module.get(DataSource);
    userRepository = module.get(getRepositoryToken(User));
    channelRepository = module.get(getRepositoryToken(Channel));
    videoRepository = module.get(getRepositoryToken(Video));
    s3Client = module.get(S3_CLIENT);
    bucket = module.get<ConfigType<typeof storageConfig>>(
      storageConfig.KEY,
    ).bucket;
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createProcessingVideo(storageKey: string): Promise<Video> {
    const user = await userRepository.save(
      userRepository.create({
        email: `worker_${++counter}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await channelRepository.save(
      channelRepository.create({
        name: 'Channel',
        nickname: `worker_${counter}`,
        user_id: user.id,
      }),
    );
    return videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        title: 'Worker video',
        status: VideoStatus.PROCESSING,
        storage_key: storageKey,
      }),
    );
  }

  it('processes a real video: extracts duration, generates thumbnail, marks ready', async () => {
    const storageKey = `videos/fixtures/${++counter}/original.mp4`;
    await s3Client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: storageKey,
        Body: readFileSync(FIXTURE_PATH),
      }),
    );
    const video = await createProcessingVideo(storageKey);

    await worker.processVideo(video.id);

    const updated = await videoRepository.findOne({
      where: { id: video.id },
    });
    expect(updated!.status).toBe(VideoStatus.READY);
    expect(updated!.duration_seconds).toBeGreaterThan(0);
    expect(updated!.thumbnail_storage_key).toBe(
      `videos/${video.channel_id}/${video.id}/thumbnail.jpg`,
    );
    expect(updated!.error_message).toBeNull();

    await expect(
      s3Client.send(
        new HeadObjectCommand({
          Bucket: bucket,
          Key: updated!.thumbnail_storage_key!,
        }),
      ),
    ).resolves.toBeDefined();
  }, 30000);

  it('marks the video as error and rethrows when the storage object is missing', async () => {
    const video = await createProcessingVideo(
      `videos/fixtures/missing-${++counter}/original.mp4`,
    );

    await expect(worker.processVideo(video.id)).rejects.toThrow();

    const updated = await videoRepository.findOne({
      where: { id: video.id },
    });
    expect(updated!.status).toBe(VideoStatus.ERROR);
    expect(updated!.error_message).toBeTruthy();
  });
});
