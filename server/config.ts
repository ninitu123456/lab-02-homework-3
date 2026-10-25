import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';

if (existsSync('.env')) loadEnvFile('.env');

function integer(name: string, fallback: number, min: number) {
  const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
  if (!Number.isSafeInteger(value) || value < min) throw new Error(`${name} must be an integer >= ${min}`);
  return value;
}

export const config = {
  port: integer('PORT', 3001, 1),
  dbPath: resolve(process.env.DB_PATH || 'data/flash-sale.sqlite'),
  saleDelayMs: integer('SALE_DELAY_MS', 30_000, 0),
  saleDurationMs: integer('SALE_DURATION_MS', 600_000, 1),
  reservationTtlMs: integer('RESERVATION_TTL_MS', 60_000, 1),
};
