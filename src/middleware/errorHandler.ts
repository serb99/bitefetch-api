import { Request, Response, NextFunction } from 'express';
import { DatabaseError } from 'pg';
import { AppError } from '../errors/AppError';

interface HttpErrorInfo {
  status: number;
  code: string;
  message: string;
}

// Postgres SQLSTATE codes we translate into client-facing errors.
const PG_ERRORS: Record<string, HttpErrorInfo> = {
  '23505': { status: 409, code: 'CONFLICT', message: 'Resource already exists' },
  '23514': { status: 409, code: 'CONSTRAINT_VIOLATION', message: 'Value not allowed' },
  '23503': { status: 409, code: 'REFERENCE_VIOLATION', message: 'Related resource missing or in use' },
  '22P02': { status: 400, code: 'INVALID_INPUT', message: 'Invalid input format' },
};

// Body parser errors we translate into client-facing errors.
const BODY_PARSER_ERRORS: Record<string, HttpErrorInfo> = {
  'entity.parse.failed': { status: 400, code: 'INVALID_JSON', message: 'Request body is not valid JSON' },
  'entity.too.large': { status: 413, code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large' },
};

function isBodyParserError(err: unknown): err is { type: string } {
  return (
    typeof err === 'object' &&
    err !== null &&
    'type' in err &&
    typeof err.type === 'string'
  );
}

function errorHandler(err: unknown, req: Request, res: Response, next: NextFunction): void {
  // 1. Response already started: we can't send JSON anymore, let Express close it.
  if (res.headersSent) {
    next(err);
    return;
  }

  // 2. Errors we threw on purpose.
  if (err instanceof AppError) {
    res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details ?? null },
    });
    return;
  }
  
  // 2b. Body parser errors (malformed JSON, body too large)
  if (isBodyParserError(err)){
    const mapped = BODY_PARSER_ERRORS[err.type];
    if (mapped){
      res.status(mapped.status).json({
        error: { code: mapped.code, message: mapped.message, details: null },
      });
      return;
    }
  }

  // 3. Postgres errors with a known SQLSTATE code.
  if (err instanceof DatabaseError) {
    const mapped = err.code ? PG_ERRORS[err.code] : undefined;
    if (mapped) {
      res.status(mapped.status).json({
        error: {
          code: mapped.code,
          message: mapped.message,
          details: { constraint: err.constraint ?? null },
        },
      });
      return;
    }
  }

  // 4. Anything else: log the full error, return a generic 500.
  req.log.error(err, 'Unhandled error'); // log the error 
  res.status(500).json({
    error: { code: 'INTERNAL_ERROR', message: 'Internal server error', details: null },
  });
}

export { errorHandler };