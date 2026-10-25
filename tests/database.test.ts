import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, seedDatabase } from '../server/database.js';

test('failed reset rolls back deletions and preserves the original demo', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chop-reset-'));
  const path = join(dir, 'demo.sqlite');
  const db = openDatabase(path);
  try {
    seedDatabase(db, { now: 1000, saleDelayMs: 0 });
    db.exec("CREATE TRIGGER reject_seed BEFORE INSERT ON products BEGIN SELECT RAISE(ABORT, 'simulated seed failure'); END;");
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'server/reset.ts'], {
      env: { ...process.env, DB_PATH: path }, encoding: 'utf8', timeout: 15_000,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /simulated seed failure/);
    assert.equal(db.prepare('SELECT count(*) AS n FROM products').get()!.n, 6);
    assert.equal(db.prepare('SELECT starts_at FROM sale').get()!.starts_at, 1000);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('database constraints reject negative inventory and invalid reservation states', () => {
  const db = openDatabase(':memory:');
  try {
    seedDatabase(db);
    assert.throws(() => db.prepare("UPDATE products SET available = -1 WHERE id = 'headphones'").run(), /CHECK/);
    assert.throws(() => db.prepare("UPDATE products SET available = 11 WHERE id = 'headphones'").run(), /CHECK/);
  } finally { db.close(); }
});
