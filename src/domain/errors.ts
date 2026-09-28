export const ErrorCodes = {
  VALIDATION: 'VALIDATION_ERROR',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  DUPLICATE_EVENT: 'DUPLICATE_EVENT',
  EDGE_BUSY: 'EDGE_MOUNT_CONFLICT',
  GAUGE_EXPIRED: 'GAUGE_CALIBRATION_EXPIRED',
  OUT_OF_TOLERANCE: 'OUT_OF_TOLERANCE',
  INVALID_STATE: 'INVALID_STATE',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = 'AppError';
  }
}
