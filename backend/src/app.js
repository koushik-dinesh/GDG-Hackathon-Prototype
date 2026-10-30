import cookieParser from 'cookie-parser';
import express from 'express';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { apiRouter } from './routes/index.js';
import { TRANSCRIPT_UPLOAD_PATH } from './routes/meetings.js';
import { WEBHOOK_PATH } from './routes/webhooks.js';
import { logger, redactUrl } from './utils/logger.js';

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  // The frontend reaches the API through the Vite proxy (same origin), so no CORS is configured.
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
    });
    next();
  });
  // Transcript uploads are parsed by their own route (after auth) with a larger limit. Webhooks
  // keep their raw body: the signature is computed over the exact bytes.
  const json = express.json({ limit: '100kb' });
  app.use((req, res, next) => (TRANSCRIPT_UPLOAD_PATH.test(req.path) || WEBHOOK_PATH.test(req.path) ? next() : json(req, res, next)));
  app.use(cookieParser());

  app.use((req, res, next) => {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      logger.info('request', {
        method: req.method,
        path: redactUrl(req.originalUrl),
        status: res.statusCode,
        ms: Number((process.hrtime.bigint() - start) / 1_000_000n),
      });
    });
    next();
  });

  app.use('/api/v1', apiRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
