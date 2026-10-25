import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface SeedOptions {
  now?: number;
  saleDelayMs?: number;
  saleDurationMs?: number;
}

export function openDatabase(path: string) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS sale (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      starts_at INTEGER NOT NULL,
      ends_at INTEGER NOT NULL CHECK(ends_at > starts_at)
    );
    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      emoji TEXT NOT NULL,
      color TEXT NOT NULL,
      price INTEGER NOT NULL CHECK(price > 0),
      original_price INTEGER NOT NULL CHECK(original_price >= price),
      initial_stock INTEGER NOT NULL CHECK(initial_stock >= 0),
      available INTEGER NOT NULL CHECK(available >= 0 AND available <= initial_stock)
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS reservations (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      product_id TEXT NOT NULL REFERENCES products(id),
      quantity INTEGER NOT NULL CHECK(quantity > 0),
      unit_price INTEGER NOT NULL CHECK(unit_price > 0),
      status TEXT NOT NULL CHECK(status IN ('RESERVED', 'CHECKED_OUT', 'EXPIRED', 'CANCELLED')),
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      idempotency_key TEXT NOT NULL,
      UNIQUE(session_id, idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS reservations_expiry ON reservations(status, expires_at);
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      reservation_id TEXT NOT NULL UNIQUE REFERENCES reservations(id),
      total INTEGER NOT NULL CHECK(total > 0),
      created_at INTEGER NOT NULL
    );
  `);
  return db;
}

export function transaction<T>(db: DatabaseSync, action: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = action();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function seedDatabase(db: DatabaseSync, options: SeedOptions = {}) {
  const startsAt = (options.now ?? Date.now()) + (options.saleDelayMs ?? 30_000);
  transaction(db, () => {
    if (db.prepare('SELECT id FROM sale WHERE id = 1').get()) return;
    db.prepare('INSERT INTO sale VALUES (1, ?, ?)').run(startsAt, startsAt + (options.saleDurationMs ?? 600_000));
    const insert = db.prepare('INSERT INTO products VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const products = [
      ['headphones', 'Tai nghe AirBeat Pro', 'Âm thanh', '🎧', 'lavender', 499000, 1290000, 10],
      ['keyboard', 'Bàn phím cơ Cloud 75', 'Góc làm việc', '⌨️', 'peach', 790000, 1590000, 15],
      ['camera', 'Máy ảnh Instax Mini', 'Lifestyle', '📸', 'mint', 1490000, 2290000, 8],
      ['watch', 'Đồng hồ Active S2', 'Thiết bị thông minh', '⌚', 'sky', 890000, 1990000, 20],
      ['speaker', 'Loa Pocket Sound', 'Âm thanh', '🔊', 'yellow', 299000, 690000, 12],
      ['bag', 'Balo Daily Essential', 'Lifestyle', '🎒', 'pink', 249000, 590000, 25],
    ] as const;
    for (const p of products) insert.run(...p, p[7]);
  });
}
