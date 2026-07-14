export const VIDEO_PROCESSING_QUEUE = 'video-processing' as const;

export const VIDEO_PROCESSING_RETRY_POLICY = {
  retryLimit: 3,
  retryBackoff: true,
} as const;

export const S3_MULTIPART_PART_NUMBER_RANGE = {
  MIN: 1,
  MAX: 10000,
} as const;
