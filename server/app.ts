import express, { type ErrorRequestHandler } from 'express';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { DomainError, Inventory } from './inventory.js';

declare global {
  namespace Express { interface Request { sessionId: string } }
}

export function createApp(db: DatabaseSync, options: { ttlMs?: number; clock?: () => number } = {}) {
  const app = express();
  const inventory = new Inventory(db, options.ttlMs, options.clock);
  app.disable('x-powered-by');
  app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.use('/api', (req, _res, next) => {
    // Browser requests must originate from the same host (Vite proxies /api in development).
    const origin = req.get('origin');
    if (origin && (!URL.canParse(origin) || new URL(origin).origin !== `${req.protocol}://${req.get('host')}`)) {
      next(new DomainError(403, 'INVALID_ORIGIN', 'Yêu cầu phải đến từ cùng ứng dụng.'));
      return;
    }
    next();
  });
  app.use(express.json({ limit: '8kb' }));
  app.use('/api', (req, res, next) => {
    const cookie = req.headers.cookie?.split(';').map(v => v.trim()).find(v => v.startsWith('flash_session='))?.slice('flash_session='.length);
    let id = cookie && /^[a-f0-9-]{36}$/.test(cookie) && db.prepare('SELECT id FROM sessions WHERE id = ?').get(cookie) ? cookie : undefined;
    if (!id) {
      id = randomUUID();
      db.prepare('INSERT INTO sessions VALUES (?, ?)').run(id, Date.now());
      res.cookie('flash_session', id, { httpOnly: true, sameSite: 'strict', path: '/', maxAge: 7 * 24 * 60 * 60 * 1000 });
    }
    req.sessionId = id;
    next();
  });

  app.get('/api/sale', (_req, res) => res.json(inventory.snapshot()));
  app.post('/api/reservations', (req, res) => {
    const body = req.body ?? {};
    const reservation = inventory.reserve(req.sessionId, body.productId, body.quantity, req.get('Idempotency-Key'));
    res.status(201).json({ serverTime: (options.clock ?? Date.now)(), reservation });
  });
  app.get('/api/reservations/:id', (req, res) => {
    res.json({ serverTime: (options.clock ?? Date.now)(), reservation: inventory.get(req.params.id, req.sessionId) });
  });
  app.post('/api/reservations/:id/checkout', (req, res) => {
    res.json({ serverTime: (options.clock ?? Date.now)(), reservation: inventory.checkout(req.params.id, req.sessionId) });
  });
  app.post('/api/reservations/:id/cancel', (req, res) => {
    res.json({ serverTime: (options.clock ?? Date.now)(), reservation: inventory.cancel(req.params.id, req.sessionId) });
  });
  app.use('/api', (_req, _res, next) => next(new DomainError(404, 'NOT_FOUND', 'API không tồn tại.')));
  const errorHandler: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    if (error instanceof DomainError) {
      res.status(error.status).json({ error: { code: error.code, message: error.message } });
    } else if (error instanceof SyntaxError && 'body' in error) {
      res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Nội dung JSON không hợp lệ.' } });
    } else if (error && typeof error === 'object' && 'type' in error && error.type === 'entity.too.large') {
      res.status(413).json({ error: { code: 'BODY_TOO_LARGE', message: 'Nội dung yêu cầu quá lớn.' } });
    } else if (error instanceof Error && /database is (locked|busy)/i.test(error.message)) {
      res.status(503).json({ error: { code: 'BUSY', message: 'Hệ thống đang bận, vui lòng thử lại với cùng khóa yêu cầu.' } });
    } else {
      console.error(error);
      res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Có lỗi hệ thống. Vui lòng thử lại.' } });
    }
  };
  app.use(errorHandler);
  return { app, inventory };
}
