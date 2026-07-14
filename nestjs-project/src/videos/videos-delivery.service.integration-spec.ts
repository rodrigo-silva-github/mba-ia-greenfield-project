import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import databaseConfig from '../config/database.config';
import storageConfig from '../config/storage.config';
import { Channel } from '../channels/entities/channel.entity';
import { StorageModule } from '../storage/storage.module';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from './entities/video.entity';
import { VideosDeliveryService } from './videos-delivery.service';

const ALL_ENTITIES = [User, Channel, Video];

async function createDeliveryTestModule(): Promise<TestingModule> {
  const ds = createTestDataSource(ALL_ENTITIES);
  return Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        load: [databaseConfig, storageConfig],
      }),
      TypeOrmModule.forRoot(ds.options),
      TypeOrmModule.forFeature([User, Channel, Video]),
      StorageModule,
    ],
    providers: [VideosDeliveryService],
  }).compile();
}

describe('VideosDeliveryService (integration)', () => {
  let module: TestingModule;
  let deliveryService: VideosDeliveryService;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;
  let dataSource: DataSource;

  beforeAll(async () => {
    module = await createDeliveryTestModule();
    await module.init();

    deliveryService = module.get(VideosDeliveryService);
    dataSource = module.get(DataSource);
    userRepository = module.get(getRepositoryToken(User));
    channelRepository = module.get(getRepositoryToken(Channel));
    videoRepository = module.get(getRepositoryToken(Video));
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createReadyVideo(): Promise<Video> {
    const user = await userRepository.save(
      userRepository.create({
        email: `video_delivery_${++counter}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await channelRepository.save(
      channelRepository.create({
        name: 'Channel',
        nickname: `video_delivery_${counter}`,
        user_id: user.id,
      }),
    );
    return videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        title: 'Ready video',
        status: VideoStatus.READY,
        storage_key: `videos/${channel.id}/ready-${counter}/original.mp4`,
      }),
    );
  }

  it('getPresignedReadUrl resolves a URL pointing at the correct object key', async () => {
    const video = await createReadyVideo();

    const url = await deliveryService.getPresignedReadUrl(video.id, false);

    expect(url).toContain(video.storage_key);
    expect(url).not.toContain('response-content-disposition');
  });

  it('getPresignedReadUrl sets ResponseContentDisposition attachment in download mode', async () => {
    const video = await createReadyVideo();

    const url = await deliveryService.getPresignedReadUrl(video.id, true);

    expect(url).toContain(video.storage_key);
    expect(url.toLowerCase()).toContain(
      'response-content-disposition=attachment',
    );
  });
});
