import pino from 'pino';

const isProduction = process.env.NODE_ENV === 'production';

const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  // In development, print readable lines. In production keep one JSON line per log.
  ...(isProduction ? {} : { transport: { target: 'pino-pretty' } }),
});

export { logger };