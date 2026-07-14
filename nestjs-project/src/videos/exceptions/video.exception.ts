import { DomainException } from '../../common/exceptions/domain.exception';

export class VideoNotFoundException extends DomainException {
  constructor() {
    super('VIDEO_NOT_FOUND', 404, 'Video not found');
  }
}

export class VideoNotOwnedException extends DomainException {
  constructor() {
    super('VIDEO_NOT_OWNED', 403, 'Video does not belong to your channel');
  }
}

export class UploadAlreadyCompletedException extends DomainException {
  constructor() {
    super(
      'UPLOAD_ALREADY_COMPLETED',
      409,
      'Upload for this video has already been completed',
    );
  }
}

export class InvalidPartNumbersException extends DomainException {
  constructor() {
    super(
      'INVALID_PART_NUMBERS',
      400,
      'One or more part numbers are outside the valid multipart upload range',
    );
  }
}

export class VideoNotReadyException extends DomainException {
  constructor() {
    super('VIDEO_NOT_READY', 409, 'Video is not ready for delivery yet');
  }
}
