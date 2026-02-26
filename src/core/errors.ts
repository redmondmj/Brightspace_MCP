export type ErrorCode =
  | 'AUTHORIZATION_FAILED'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'BRIGHTSPACE_UNAVAILABLE'
  | 'BAD_REQUEST'
  | 'UNKNOWN';

export interface ErrorData {
  requestId?: string;
  brightspaceStatus?: number;
  details?: unknown;
}

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly httpStatus: number,
    public readonly data?: ErrorData
  ) {
    super(message);
    this.name = 'AppError';
  }
}

const STATUS_TO_CODE: Record<number, ErrorCode> = {
  400: 'BAD_REQUEST',
  401: 'AUTHORIZATION_FAILED',
  403: 'AUTHORIZATION_FAILED',
  404: 'NOT_FOUND',
  429: 'RATE_LIMITED'
};

const STATUS_TO_MESSAGE: Record<number, string> = {
  400: 'Invalid request sent to Brightspace.',
  401: 'Authorization failed: check Brightspace token/scopes.',
  403: 'Authorization failed: check Brightspace token/scopes.',
  404: 'Not found: course or item id.',
  429: 'Rate limited by Brightspace; retry later.'
};

export function brightspaceError(
  status: number,
  requestId: string | undefined,
  fallbackMessage?: string,
  details?: unknown
): AppError {
  const code = STATUS_TO_CODE[status] ?? 'BRIGHTSPACE_UNAVAILABLE';
  let httpStatus = status;

  if (status >= 500) {
    httpStatus = 503;
  }

  if (code === 'BRIGHTSPACE_UNAVAILABLE') {
    httpStatus = 503;
  }

  const message =
    STATUS_TO_MESSAGE[status] ?? 'Brightspace temporarily unavailable.';

  return new AppError(code, fallbackMessage ?? message, httpStatus, {
    requestId,
    brightspaceStatus: status,
    details
  });
}

export function unknownError(
  message: string,
  details?: unknown
): AppError {
  return new AppError('UNKNOWN', message, 500, { details });
}

export function brightspaceTimeoutError(
  timeoutMs: number,
  url: string,
  details?: Record<string, unknown>
): AppError {
  return new AppError(
    'BRIGHTSPACE_UNAVAILABLE',
    `Brightspace request timed out after ${timeoutMs}ms.`,
    503,
    {
      details: {
        timeoutMs,
        url,
        ...details
      }
    }
  );
}
