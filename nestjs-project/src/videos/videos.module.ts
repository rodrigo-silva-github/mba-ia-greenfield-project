import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChannelsModule } from '../channels/channels.module';
import { Video } from './entities/video.entity';
import { VideosController } from './videos.controller';
import { VideosDeliveryService } from './videos-delivery.service';
import { VideosService } from './videos.service';

@Module({
  imports: [TypeOrmModule.forFeature([Video]), ChannelsModule],
  controllers: [VideosController],
  providers: [VideosService, VideosDeliveryService],
  exports: [VideosService, VideosDeliveryService],
})
export class VideosModule {}
