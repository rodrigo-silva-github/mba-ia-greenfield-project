import { ArrayNotEmpty, IsInt, Min } from 'class-validator';

export class UploadUrlsDto {
  @ArrayNotEmpty()
  @IsInt({ each: true })
  @Min(1, { each: true })
  part_numbers: number[];
}
