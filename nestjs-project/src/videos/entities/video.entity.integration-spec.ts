import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { Video, VideoStatus } from './video.entity';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createChannel(): Promise<Channel> {
    const user = await userRepository.save(
      userRepository.create({
        email: `video_test_${++counter}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: 'Channel',
        nickname: `chan_${counter}`,
        user_id: user.id,
      }),
    );
  }

  it('should default status to draft when not provided', async () => {
    const channel = await createChannel();

    const video = await videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        title: 'My video',
        storage_key: 'videos/x/y/original.mp4',
      }),
    );

    expect(video.status).toBe(VideoStatus.DRAFT);
  });

  it('should enforce FK constraint on channel_id', async () => {
    await expect(
      videoRepository.save(
        videoRepository.create({
          channel_id: '00000000-0000-0000-0000-000000000000',
          title: 'Orphan video',
          storage_key: 'videos/x/y/original.mp4',
        }),
      ),
    ).rejects.toThrow();
  });

  it('should reject an invalid status enum value', async () => {
    const channel = await createChannel();

    await expect(
      dataSource.query(
        `INSERT INTO "videos" ("channel_id", "title", "storage_key", "status") VALUES ($1, $2, $3, $4)`,
        [channel.id, 'Bad status', 'videos/x/y/original.mp4', 'not_a_status'],
      ),
    ).rejects.toThrow();
  });

  it('should allow null description, thumbnail_storage_key, upload_id, duration_seconds, size_bytes and mime_type', async () => {
    const channel = await createChannel();

    const video = await videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        title: 'Minimal video',
        storage_key: 'videos/x/y/original.mp4',
      }),
    );

    expect(video.description).toBeNull();
    expect(video.thumbnail_storage_key).toBeNull();
    expect(video.upload_id).toBeNull();
    expect(video.duration_seconds).toBeNull();
    expect(video.size_bytes).toBeNull();
    expect(video.mime_type).toBeNull();
  });

  it('should auto-generate id, created_at, and updated_at', async () => {
    const channel = await createChannel();

    const video = await videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        title: 'Timestamped video',
        storage_key: 'videos/x/y/original.mp4',
      }),
    );

    expect(video.id).toBeDefined();
    expect(video.created_at).toBeInstanceOf(Date);
    expect(video.updated_at).toBeInstanceOf(Date);
  });

  it('should load the related channel via the ManyToOne relation', async () => {
    const channel = await createChannel();
    await videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        title: 'Related video',
        storage_key: 'videos/x/y/original.mp4',
      }),
    );

    const found = await videoRepository.findOne({
      where: { channel_id: channel.id },
      relations: ['channel'],
    });

    expect(found?.channel.nickname).toBe(channel.nickname);
  });
});
