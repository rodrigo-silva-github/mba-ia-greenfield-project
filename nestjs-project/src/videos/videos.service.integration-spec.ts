import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import databaseConfig from '../config/database.config';
import storageConfig from '../config/storage.config';
import { Channel } from '../channels/entities/channel.entity';
import { QueueModule } from '../queue/queue.module';
import { StorageModule } from '../storage/storage.module';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { UploadAlreadyCompletedException } from './exceptions/video.exception';
import { Video, VideoStatus } from './entities/video.entity';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, Video];

async function createVideosTestModule(): Promise<TestingModule> {
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
    providers: [VideosService],
  }).compile();
}

describe('VideosService (integration)', () => {
  let module: TestingModule;
  let videosService: VideosService;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let dataSource: DataSource;

  beforeAll(async () => {
    module = await createVideosTestModule();
    await module.init();

    videosService = module.get(VideosService);
    dataSource = module.get(DataSource);
    userRepository = module.get(getRepositoryToken(User));
    channelRepository = module.get(getRepositoryToken(Channel));
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createChannel(): Promise<Channel> {
    const user = await userRepository.save(
      userRepository.create({
        email: `video_svc_${++counter}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: 'Channel',
        nickname: `video_svc_${counter}`,
        user_id: user.id,
      }),
    );
  }

  it('createDraftAndInitiateUpload persists a draft and starts a real multipart upload', async () => {
    const channel = await createChannel();

    const video = await videosService.createDraftAndInitiateUpload(channel.id, {
      title: 'Integration video',
      mime_type: 'video/mp4',
      size_bytes: 1024,
    });

    expect(video.status).toBe(VideoStatus.DRAFT);
    expect(video.upload_id).toBeTruthy();
    expect(video.storage_key).toBe(
      `videos/${channel.id}/${video.id}/original.mp4`,
    );
  });

  it('completeUpload transitions status and publishes to the real pg-boss queue', async () => {
    const channel = await createChannel();
    const video = await videosService.createDraftAndInitiateUpload(channel.id, {
      title: 'Completed video',
      mime_type: 'video/mp4',
      size_bytes: 10,
    });

    const [{ url }] = await videosService.generatePresignedPartUrls(
      video.id,
      channel.id,
      [1],
    );
    expect(url).toContain(video.storage_key);

    const uploadResponse = await fetch(url, {
      method: 'PUT',
      body: Buffer.from('0123456789'),
    });
    const etag = uploadResponse.headers.get('etag')!;

    const completed = await videosService.completeUpload(video.id, channel.id, [
      { part_number: 1, etag },
    ]);

    expect(completed.status).toBe(VideoStatus.PROCESSING);
    expect(completed.upload_id).toBeNull();

    await expect(
      videosService.completeUpload(video.id, channel.id, [
        { part_number: 1, etag },
      ]),
    ).rejects.toThrow(UploadAlreadyCompletedException);
  });
});
