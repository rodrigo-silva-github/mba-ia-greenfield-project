import {
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
  Matches,
  Max,
  MaxLength,
  MinLength,
} from 'class-validator';

const MAX_VIDEO_SIZE_BYTES = 10 * 1024 * 1024 * 1024;

export class CreateVideoDto {
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  title: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsInt()
  @IsPositive()
  @Max(MAX_VIDEO_SIZE_BYTES)
  size_bytes: number;

  @IsString()
  @Matches(/^video\//)
  mime_type: string;
}
