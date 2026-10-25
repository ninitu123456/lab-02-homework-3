import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'vite';
import viteConfig from '../vite.config.js';
import { openDatabase, seedDatabase } from '../server/database.js';
import { createApp } from '../server/app.js';

test('Vite dev proxy preserves origin for reserve/cancel and still rejects cross-origin requests', async () => {
  const db = openDatabase(':memory:');
  seedDatabase(db, { saleDelayMs: 0 });
  const { app } = createApp(db);
  const api = app.listen(0, '127.0.0.1');
  await once(api, 'listening');
  const port = (api.address() as { port: number }).port;
  const configured = viteConfig.server!.proxy!['/api'];
  assert.equal(typeof configured, 'object');
  const proxy = await createServer({
    configFile: false, logLevel: 'silent',
    server: { host: '127.0.0.1', port: 0, proxy: { '/api': { ...configured as object, target: `http://127.0.0.1:${port}` } } },
  });
  try {
    await proxy.listen();
    const base = `http://127.0.0.1:${(proxy.httpServer!.address() as { port: number }).port}`;
    const snapshot = await fetch(`${base}/api/sale`);
    assert.equal(snapshot.status, 200);
    const cookie = snapshot.headers.get('set-cookie')!.split(';')[0];
    const hold = await fetch(`${base}/api/reservations`, {
      method: 'POST', headers: { Origin: base, Cookie: cookie, 'Content-Type': 'application/json', 'Idempotency-Key': 'proxy-request-01' },
      body: JSON.stringify({ productId: 'headphones', quantity: 1 }),
    });
    assert.equal(hold.status, 201);
    const { reservation } = await hold.json();
    const cancel = await fetch(`${base}/api/reservations/${reservation.id}/cancel`, { method: 'POST', headers: { Origin: base, Cookie: cookie } });
    assert.equal(cancel.status, 200);
    const bad = await fetch(`${base}/api/sale`, { headers: { Origin: 'https://attacker.example' } });
    assert.equal(bad.status, 403);
  } finally {
    await proxy.close();
    await new Promise<void>(resolve => api.close(() => resolve()));
    db.close();
  }
});
