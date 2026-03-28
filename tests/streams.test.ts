import express from 'express';
import request from 'supertest';
import { streams, streamsRouter, resetStreamIdempotencyStore } from '../src/routes/streams.js';
import { authenticate } from '../src/middleware/auth.js';
import { correlationIdMiddleware } from '../src/middleware/correlationId.js';
import { errorHandler } from '../src/middleware/errorHandler.js';
import { initializeConfig, resetConfig } from '../src/config/env.js';

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use(correlationIdMiddleware);
  app.use(authenticate);
  app.use('/api/streams', streamsRouter);
  app.use(errorHandler);
  return app;
}

const validStream = {
  sender: 'GCSX2XXXXXXXXXXXXXXXXXXXXXXX',
  recipient: 'GDRX2XXXXXXXXXXXXXXXXXXXXXXX',
  depositAmount: '1000.0',
  ratePerSecond: '0.1',
};

describe('Streams API', () => {
  let app: any;

  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    process.env.API_KEYS = 'test-api-key';
    resetConfig();
    initializeConfig();
    streams.length = 0;
    resetStreamIdempotencyStore();
    app = createTestApp();
  });

  describe('POST /api/streams', () => {
    it('creates a stream with valid API key', async () => {
      const res = await request(app)
        .post('/api/streams')
        .set('X-API-Key', 'test-api-key')
        .set('Idempotency-Key', 'test-key-1')
        .send(validStream)
        .expect(201);
      expect(res.body.status).toBe('active');
    });

    it('returns 401 without API key', async () => {
      await request(app).post('/api/streams').set('Idempotency-Key', 'test-key-2').send(validStream).expect(401);
    });

    it('enforces idempotency', async () => {
      const res1 = await request(app)
        .post('/api/streams')
        .set('X-API-Key', 'test-api-key')
        .set('Idempotency-Key', 'test-key-3')
        .send(validStream)
        .expect(201);
      const res2 = await request(app)
        .post('/api/streams')
        .set('X-API-Key', 'test-api-key')
        .set('Idempotency-Key', 'test-key-3')
        .send(validStream)
        .expect(201);
      expect(res2.header['idempotency-replayed']).toBe('true');
      expect(res1.body.id).toBe(res2.body.id);
    });
  });
});
