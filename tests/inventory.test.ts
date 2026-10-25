import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, seedDatabase } from '../server/database.js';
import { DomainError, Inventory } from '../server/inventory.js';

function fixture() {
  const db = openDatabase(':memory:');
  let now = 1000;
  seedDatabase(db, { now, saleDelayMs: 0, saleDurationMs: 10_000 });
  db.prepare('INSERT INTO sessions VALUES (?, ?)').run('buyer', now);
  const inventory = new Inventory(db, 100, () => now);
  return { db, inventory, setNow: (value: number) => { now = value; } };
}

function code(expected: string) {
  return (error: unknown) => error instanceof DomainError && error.code === expected;
}

test('reservation is atomic, idempotent, and rejects conflicting payloads', () => {
  const { db, inventory } = fixture();
  try {
    const r = inventory.reserve('buyer', 'headphones', 2, 'request-01');
    assert.equal(r.status, 'RESERVED');
    assert.equal(inventory.snapshot().products[0].available, 8);
    assert.equal(inventory.reserve('buyer', 'headphones', 2, 'request-01').id, r.id);
    assert.equal(inventory.snapshot().products[0].available, 8);
    assert.throws(() => inventory.reserve('buyer', 'headphones', 3, 'request-01'), code('IDEMPOTENCY_CONFLICT'));
    assert.throws(() => inventory.reserve('buyer', 'headphones', 9, 'request-02'), code('OUT_OF_STOCK'));
    assert.equal(inventory.snapshot().products[0].available, 8);
    assert.throws(() => inventory.get(r.id, 'another-buyer'), code('NOT_FOUND'));
  } finally { db.close(); }
});

test('checkout repeats return one order, preserve price and do not decrement inventory twice', () => {
  const { db, inventory, setNow } = fixture();
  try {
    const r = inventory.reserve('buyer', 'headphones', 2, 'request-01');
    db.prepare("UPDATE products SET price = 600000 WHERE id = 'headphones'").run();
    const paid = inventory.checkout(r.id, 'buyer');
    assert.equal(paid.status, 'CHECKED_OUT');
    assert.ok(paid.orderId);
    assert.deepEqual(inventory.checkout(r.id, 'buyer'), paid);
    assert.throws(() => inventory.cancel(r.id, 'buyer'), code('INVALID_STATE'));
    setNow(1200); inventory.expire();
    assert.equal(inventory.snapshot().products[0].available, 8);
    assert.equal(db.prepare('SELECT count(*) AS n, total FROM orders').get()!.n, 1);
    assert.equal(db.prepare('SELECT total FROM orders').get()!.total, 998000);
  } finally { db.close(); }
});

test('expiry boundary is inclusive and a rejected checkout still commits returned inventory', () => {
  const { db, inventory, setNow } = fixture();
  try {
    const r = inventory.reserve('buyer', 'headphones', 10, 'request-01');
    setNow(r.expiresAt);
    assert.throws(() => inventory.checkout(r.id, 'buyer'), code('RESERVATION_EXPIRED'));
    // Inspect directly, without a snapshot that could hide a rolled-back expiry by expiring again.
    assert.equal(db.prepare("SELECT status FROM reservations WHERE id = ?").get(r.id)!.status, 'EXPIRED');
    assert.equal(db.prepare("SELECT available FROM products WHERE id = 'headphones'").get()!.available, 10);
    assert.equal(inventory.cancel(r.id, 'buyer').status, 'EXPIRED');
    assert.equal(inventory.expire(), 0);
    assert.equal(inventory.reserve('buyer', 'headphones', 10, 'request-01').status, 'EXPIRED');
  } finally { db.close(); }
});

test('cancel returns stock once and cannot subsequently checkout', () => {
  const { db, inventory, setNow } = fixture();
  try {
    const r = inventory.reserve('buyer', 'headphones', 10, 'request-01');
    assert.equal(inventory.cancel(r.id, 'buyer').status, 'CANCELLED');
    inventory.cancel(r.id, 'buyer'); setNow(1500); inventory.expire();
    assert.equal(inventory.snapshot().products[0].available, 10);
    assert.throws(() => inventory.checkout(r.id, 'buyer'), code('INVALID_STATE'));
  } finally { db.close(); }
});

test('sale boundaries, quantities, unknown products and missing reservations are enforced', () => {
  const { db, inventory, setNow } = fixture();
  try {
    for (const quantity of [0, -1, 1.5, '1', NaN, Infinity, 101]) {
      assert.throws(() => inventory.reserve('buyer', 'headphones', quantity, 'request-01'), code('INVALID_INPUT'));
    }
    assert.throws(() => inventory.reserve('buyer', 'none', 1, 'request-01'), code('PRODUCT_NOT_FOUND'));
    assert.throws(() => inventory.get('none', 'buyer'), code('NOT_FOUND'));
    setNow(999);
    assert.throws(() => inventory.reserve('buyer', 'headphones', 1, 'request-01'), code('SALE_NOT_STARTED'));
    setNow(1000);
    const r = inventory.reserve('buyer', 'headphones', 1, 'request-01');
    setNow(11_000);
    assert.throws(() => inventory.reserve('buyer', 'headphones', 1, 'request-02'), code('SALE_ENDED'));
    assert.equal(inventory.reserve('buyer', 'headphones', 1, 'request-01').id, r.id);
  } finally { db.close(); }
});

test('unexpected write failure rolls back stock decrement', () => {
  const { db, inventory } = fixture();
  try {
    assert.throws(() => inventory.reserve('missing-session', 'headphones', 3, 'request-01'), /FOREIGN KEY/);
    assert.equal(inventory.snapshot().products[0].available, 10);
    assert.equal(db.prepare('SELECT count(*) AS n FROM reservations').get()!.n, 0);
  } finally { db.close(); }
});
