import express from 'express';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from './config.js';
import { openDatabase, seedDatabase } from './database.js';
import { createApp } from './app.js';

const db = openDatabase(config.dbPath);
seedDatabase(db, config);
const { app, inventory } = createApp(db, { ttlMs: config.reservationTtlMs });
inventory.expire();
const sweeper = setInterval(() => {
  try { inventory.expire(); } catch (error) { console.error('Expiry sweep failed:', error); }
}, 1000);
sweeper.unref();

const dist = resolve('dist');
if (existsSync(resolve(dist, 'index.html'))) {
  app.use(express.static(dist));
  app.get('/{*path}', (_req, res) => res.sendFile(resolve(dist, 'index.html')));
}
const server = app.listen(config.port, '127.0.0.1', () => console.log(`API / ứng dụng: http://127.0.0.1:${config.port}`));
function shutdown() {
  clearInterval(sweeper);
  server.close(() => { db.close(); process.exit(0); });
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
