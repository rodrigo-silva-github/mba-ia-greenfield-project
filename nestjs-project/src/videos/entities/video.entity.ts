import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';

export enum VideoStatus {
  DRAFT = 'draft',
  PROCESSING = 'processing',
  READY = 'ready',
  ERROR = 'error',
}

@Entity('videos')
export class Video {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid' })
  channel_id: string;

  @Column({ type: 'varchar', length: 255 })
  title: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Index()
  @Column({
    type: 'enum',
    enum: VideoStatus,
    default: VideoStatus.DRAFT,
  })
  status: VideoStatus;

  @Column({ type: 'text', nullable: true })
  error_message: string | null;

  @Column({ type: 'varchar', length: 1024 })
  storage_key: string;

  @Column({ type: 'varchar', length: 1024, nullable: true })
  thumbnail_storage_key: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  upload_id: string | null;

  @Column({ type: 'int', nullable: true })
  duration_seconds: number | null;

  @Column({ type: 'bigint', nullable: true })
  size_bytes: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  mime_type: string | null;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;

  @ManyToOne(() => Channel, (channel) => channel.videos)
  @JoinColumn({ name: 'channel_id' })
  channel: Channel;
}
