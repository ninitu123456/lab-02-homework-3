import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { openDatabase, seedDatabase } from '../server/database.js';
import { Inventory } from '../server/inventory.js';
import type { ReservationResponse } from '../shared/types.js';

interface Worker { child: ChildProcess; url: string }
function message(child: ChildProcess, predicate: (message: any) => boolean) {
  return new Promise<any>((resolve, reject) => {
    const timeout = setTimeout(() => { cleanup(); reject(new Error('Worker response timeout')); }, 15_000);
    function cleanup() { clearTimeout(timeout); child.off('message', handler); child.off('exit', exited); }
    function handler(value: unknown) { if (predicate(value)) { cleanup(); resolve(value); } }
    function exited(code: number | null) { cleanup(); reject(new Error(`Worker exited early: ${code}`)); }
    child.on('message', handler); child.on('exit', exited);
  });
}

async function startWorker(path: string): Promise<Worker> {
  const child = fork(fileURLToPath(new URL('./fixtures/api-worker.ts', import.meta.url)), [], {
    env: { ...process.env, TEST_DB: path }, execArgv: ['--import', 'tsx'], stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  try {
    const ready = await message(child, m => m.type === 'ready');
    return { child, url: `http://127.0.0.1:${ready.port}/api` };
  } catch (error) { child.kill(); throw error; }
}
async function clock(worker: Worker, now: number) {
  const id = crypto.randomUUID();
  const ack = message(worker.child, m => m.type === 'ack' && m.id === id);
  worker.child.send({ type: 'clock', now, id });
  await ack;
}
async function stop(worker: Worker) {
  const exited = once(worker.child, 'exit');
  worker.child.send({ type: 'stop' });
  await exited;
}

test('100 HTTP requests across 4 independent processes reserve exactly 10 units; races preserve invariants', { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chop-concurrency-'));
  const path = join(dir, 'inventory.sqlite');
  let db = openDatabase(path);
  seedDatabase(db, { now: 1000, saleDelayMs: 0, saleDurationMs: 100_000 });
  const workers: Worker[] = [];
  try {
    // Start sequentially so startup failure cannot strand an untracked child process.
    for (let i = 0; i < 4; i++) workers.push(await startWorker(path));
    const responses = await Promise.all(Array.from({ length: 100 }, async (_, i) => {
      const worker = workers[i % workers.length];
      const response = await fetch(`${worker.url}/reservations`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `concurrent-${i}` },
        body: JSON.stringify({ productId: 'headphones', quantity: 1 }),
      });
      const body = await response.json();
      return { status: response.status, body, cookie: response.headers.get('set-cookie')!.split(';')[0] };
    }));
    const successful = responses.filter(r => r.status === 201);
    assert.equal(successful.length, 10);
    assert.equal(responses.filter(r => r.status === 409 && r.body.error.code === 'OUT_OF_STOCK').length, 90);
    assert.equal(db.prepare("SELECT available FROM products WHERE id = 'headphones'").get()!.available, 0);
    assert.equal(db.prepare('SELECT count(*) AS n FROM reservations').get()!.n, 10);

    // Competing checkouts on independent connections must produce a single order.
    const first = successful[0];
    const paid = await Promise.all(Array.from({ length: 20 }, async (_, i) => {
      const response = await fetch(`${workers[i % 4].url}/reservations/${first.body.reservation.id}/checkout`, { method: 'POST', headers: { Cookie: first.cookie } });
      assert.equal(response.status, 200);
      return (await response.json() as ReservationResponse).reservation;
    }));
    assert.equal(new Set(paid.map(r => r.orderId)).size, 1);

    // Cancel and checkout compete: exactly one terminal state wins.
    const second = successful[1];
    await Promise.all(['checkout', 'cancel'].map((action, i) => fetch(`${workers[i].url}/reservations/${second.body.reservation.id}/${action}`, { method: 'POST', headers: { Cookie: second.cookie } })));
    const secondState = db.prepare('SELECT status FROM reservations WHERE id = ?').get(second.body.reservation.id)!.status;
    assert.ok(secondState === 'CHECKED_OUT' || secondState === 'CANCELLED');

    // At the deadline all remaining reservations expire; checkout cannot win at equality.
    await Promise.all(workers.map(w => clock(w, 1100)));
    const expired = await fetch(`${workers[0].url}/reservations/${successful[2].body.reservation.id}/checkout`, { method: 'POST', headers: { Cookie: successful[2].cookie } });
    assert.equal(expired.status, 409);
    assert.equal((await expired.json()).error.code, 'RESERVATION_EXPIRED');
    const orders = Number(db.prepare('SELECT count(*) AS n FROM orders').get()!.n);
    const available = Number(db.prepare("SELECT available FROM products WHERE id = 'headphones'").get()!.available);
    assert.equal(available + orders, 10);
    assert.equal(db.prepare("SELECT count(*) AS n FROM reservations WHERE status = 'RESERVED'").get()!.n, 0);
    assert.equal(db.prepare('SELECT count(*) AS n FROM products WHERE available < 0').get()!.n, 0);

    // A real checkout-versus-expiry race: one worker checks time before deadline,
    // another sweeps at deadline. Either winner is valid; never both terminal effects.
    await Promise.all(workers.map(w => clock(w, 2000)));
    const newHold = await fetch(`${workers[0].url}/reservations`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'expiry-race-key' }, body: JSON.stringify({ productId: 'headphones', quantity: 1 }) });
    const hold = (await newHold.json() as ReservationResponse).reservation;
    const holdCookie = newHold.headers.get('set-cookie')!.split(';')[0];
    await Promise.all([
      fetch(`${workers[0].url}/reservations/${hold.id}/checkout`, { method: 'POST', headers: { Cookie: holdCookie } }),
      clock(workers[1], 2100),
    ]);
    const raceState = db.prepare('SELECT status FROM reservations WHERE id = ?').get(hold.id)!.status;
    assert.ok(raceState === 'CHECKED_OUT' || raceState === 'EXPIRED');
    assert.equal(db.prepare('SELECT count(*) AS n FROM orders WHERE reservation_id = ?').get(hold.id)!.n, raceState === 'CHECKED_OUT' ? 1 : 0);
    const finalOrders = Number(db.prepare('SELECT count(*) AS n FROM orders').get()!.n);
    assert.equal(Number(db.prepare("SELECT available FROM products WHERE id = 'headphones'").get()!.available) + finalOrders, 10);

    // Persistence and startup recovery with a genuinely closed/reopened connection.
    await Promise.all(workers.map(stop)); workers.length = 0;
    db.close(); db = openDatabase(path);
    seedDatabase(db, { now: 50_000 });
    assert.equal(db.prepare('SELECT starts_at FROM sale').get()!.starts_at, 1000);
    const store = new Inventory(db, 100, () => 3000);
    db.prepare('INSERT INTO sessions VALUES (?, ?)').run('restart-buyer', 3000);
    const restart = store.reserve('restart-buyer', 'headphones', 1, 'restart-request');
    db.close(); db = openDatabase(path);
    const recovered = new Inventory(db, 100, () => 3100);
    recovered.expire();
    assert.equal(recovered.get(restart.id, 'restart-buyer').status, 'EXPIRED');
    assert.equal(recovered.snapshot().products[0].available + finalOrders, 10);
  } finally {
    await Promise.all(workers.map(w => stop(w).catch(() => { w.child.kill(); })));
    db.close(); rmSync(dir, { recursive: true, force: true });
  }
});
