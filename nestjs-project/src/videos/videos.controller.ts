import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Redirect,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { ChannelsService } from '../channels/channels.service';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { OptionalAuth } from '../auth/decorators/optional-auth.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { CreateVideoDto } from './dto/create-video.dto';
import { UploadUrlsDto } from './dto/upload-urls.dto';
import { Video, VideoStatus } from './entities/video.entity';
import { VideosDeliveryService } from './videos-delivery.service';
import { PresignedPartUrl, VideosService } from './videos.service';

@ApiTags('videos')
@ApiBearerAuth('access-token')
@Controller('videos')
export class VideosController {
  constructor(
    private readonly videosService: VideosService,
    private readonly videosDeliveryService: VideosDeliveryService,
    private readonly channelsService: ChannelsService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Pre-cadastra um vídeo e inicia o upload multipart',
    description:
      'Cria o vídeo como rascunho no canal do usuário autenticado e inicia um multipart upload no object storage, retornando o uploadId para as próximas etapas.',
  })
  @ApiResponse({
    status: 201,
    description: 'Vídeo pré-cadastrado e upload multipart iniciado',
    schema: {
      properties: {
        id: { type: 'string', format: 'uuid' },
        status: { type: 'string', example: 'draft' },
        upload_id: { type: 'string' },
        storage_key: { type: 'string' },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async create(
    @Body() dto: CreateVideoDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<Video> {
    const channel = await this.channelsService.findByUserId(user.sub);
    return this.videosService.createDraftAndInitiateUpload(channel!.id, dto);
  }

  @Post(':id/upload-urls')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Gera URLs pré-assinadas para as partes do multipart upload',
    description:
      'Devolve uma URL pré-assinada de escrita por parte solicitada, para o cliente enviar os bytes diretamente ao object storage.',
  })
  @ApiResponse({
    status: 200,
    description: 'URLs pré-assinadas geradas',
    schema: {
      properties: {
        urls: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              part_number: { type: 'number' },
              url: { type: 'string' },
            },
          },
        },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed / INVALID_PART_NUMBERS',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 403,
    description: 'VIDEO_NOT_OWNED',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'VIDEO_NOT_FOUND',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'UPLOAD_ALREADY_COMPLETED',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async uploadUrls(
    @Param('id') id: string,
    @Body() dto: UploadUrlsDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<{ urls: PresignedPartUrl[] }> {
    const channel = await this.channelsService.findByUserId(user.sub);
    const urls = await this.videosService.generatePresignedPartUrls(
      id,
      channel!.id,
      dto.part_numbers,
    );
    return { urls };
  }

  @Post(':id/complete-upload')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Conclui o multipart upload e inicia o processamento do vídeo',
    description:
      'Finaliza o upload multipart no object storage e publica o evento de processamento assíncrono na fila.',
  })
  @ApiResponse({
    status: 200,
    description: 'Upload concluído e processamento iniciado',
    schema: {
      properties: {
        id: { type: 'string', format: 'uuid' },
        status: { type: 'string', example: 'processing' },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 403,
    description: 'VIDEO_NOT_OWNED',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'VIDEO_NOT_FOUND',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'UPLOAD_ALREADY_COMPLETED',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async completeUpload(
    @Param('id') id: string,
    @Body() dto: CompleteUploadDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<{ id: string; status: string }> {
    const channel = await this.channelsService.findByUserId(user.sub);
    const video = await this.videosService.completeUpload(
      id,
      channel!.id,
      dto.parts,
    );
    return { id: video.id, status: video.status };
  }

  @Get(':id')
  @OptionalAuth()
  @ApiOperation({
    summary: 'Consulta os metadados de um vídeo',
    description:
      'Vídeos com status ready são visíveis a qualquer requisitante; vídeos em draft/processing/error só são visíveis ao dono do canal.',
  })
  @ApiResponse({
    status: 200,
    description: 'Metadados do vídeo',
    schema: {
      properties: {
        id: { type: 'string', format: 'uuid' },
        title: { type: 'string' },
        description: { type: 'string', nullable: true },
        status: { type: 'string', example: 'ready' },
        duration_seconds: { type: 'number', nullable: true },
        created_at: { type: 'string', format: 'date-time' },
      },
    },
  })
  @ApiResponse({
    status: 404,
    description: 'VIDEO_NOT_FOUND',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async findOne(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload | undefined,
  ): Promise<{
    id: string;
    title: string;
    description: string | null;
    status: VideoStatus;
    duration_seconds: number | null;
    created_at: Date;
  }> {
    const channel = user
      ? await this.channelsService.findByUserId(user.sub)
      : null;
    const video = await this.videosDeliveryService.findByIdForViewer(
      id,
      channel?.id ?? null,
    );
    return {
      id: video.id,
      title: video.title,
      description: video.description,
      status: video.status,
      duration_seconds: video.duration_seconds,
      created_at: video.created_at,
    };
  }

  @Get(':id/stream')
  @Public()
  @Redirect()
  @ApiOperation({
    summary: 'Redireciona para a URL de streaming do vídeo',
    description:
      'Valida que o vídeo está com status ready e redireciona (302) para uma URL pré-assinada de leitura no storage, que trata Range/206 Partial Content nativamente.',
  })
  @ApiResponse({
    status: 302,
    description: 'Redirecionamento para a URL pré-assinada de leitura',
  })
  @ApiResponse({
    status: 404,
    description: 'VIDEO_NOT_FOUND',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'VIDEO_NOT_READY',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async stream(
    @Param('id') id: string,
  ): Promise<{ url: string; statusCode: number }> {
    const url = await this.videosDeliveryService.getPresignedReadUrl(id, false);
    return { url, statusCode: HttpStatus.FOUND };
  }

  @Get(':id/download')
  @Public()
  @Redirect()
  @ApiOperation({
    summary: 'Redireciona para a URL de download do vídeo',
    description:
      'Valida que o vídeo está com status ready e redireciona (302) para uma URL pré-assinada de leitura no storage com Content-Disposition: attachment.',
  })
  @ApiResponse({
    status: 302,
    description:
      'Redirecionamento para a URL pré-assinada de leitura (attachment)',
  })
  @ApiResponse({
    status: 404,
    description: 'VIDEO_NOT_FOUND',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'VIDEO_NOT_READY',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async download(
    @Param('id') id: string,
  ): Promise<{ url: string; statusCode: number }> {
    const url = await this.videosDeliveryService.getPresignedReadUrl(id, true);
    return { url, statusCode: HttpStatus.FOUND };
  }
}
