import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { openDatabase, seedDatabase } from '../server/database.js';
import { createApp } from '../server/app.js';

test('HTTP contract: session cookie, validation, ownership, idempotency and checkout', async () => {
  const db = openDatabase(':memory:');
  seedDatabase(db, { saleDelayMs: 0 });
  const { app } = createApp(db);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const start = await fetch(`${base}/api/sale`);
    assert.equal(start.status, 200);
    assert.equal(start.headers.get('cache-control'), 'no-store');
    const fullCookie = start.headers.get('set-cookie')!;
    assert.match(fullCookie, /HttpOnly/i); assert.match(fullCookie, /SameSite=Strict/i);
    const cookie = fullCookie.split(';')[0];
    const post = (path: string, body: unknown, key = 'api-request-01') => fetch(`${base}/api${path}`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(body),
    });
    const invalid = await post('/reservations', { productId: 'headphones', quantity: -1 });
    assert.equal(invalid.status, 400);
    const a = await post('/reservations', { productId: 'headphones', quantity: 1 });
    assert.equal(a.status, 201);
    const { reservation } = await a.json();
    const b = await post('/reservations', { productId: 'headphones', quantity: 1 });
    assert.equal((await b.json()).reservation.id, reservation.id);
    const stranger = await fetch(`${base}/api/reservations/${reservation.id}`);
    assert.equal(stranger.status, 404);
    for (const action of ['checkout', 'cancel']) {
      const forbidden = await fetch(`${base}/api/reservations/${reservation.id}/${action}`, { method: 'POST' });
      assert.equal(forbidden.status, 404);
    }
    const paid = await post(`/reservations/${reservation.id}/checkout`, {});
    assert.equal(paid.status, 200);
    assert.equal((await paid.json()).reservation.status, 'CHECKED_OUT');
    const again = await post(`/reservations/${reservation.id}/checkout`, {});
    assert.equal((await again.json()).reservation.status, 'CHECKED_OUT');
    const origin = await fetch(`${base}/api/sale`, { headers: { Origin: 'https://attacker.example' } });
    assert.equal(origin.status, 403);
    const opaqueOrigin = await fetch(`${base}/api/sale`, { headers: { Origin: 'null' } });
    assert.equal(opaqueOrigin.status, 403);
    const malformed = await fetch(`${base}/api/reservations`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: '{' });
    assert.equal(malformed.status, 400);
    const unknown = await fetch(`${base}/api/missing`);
    assert.equal(unknown.status, 404);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    db.close();
  }
});
