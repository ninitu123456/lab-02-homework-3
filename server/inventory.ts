import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Product, Reservation, SaleSnapshot } from '../shared/types.js';
import { transaction } from './database.js';

export class DomainError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

const reservationSelect = `SELECT r.id, r.product_id AS productId, r.quantity, r.status,
  r.expires_at AS expiresAt, r.created_at AS createdAt, r.unit_price AS unitPrice,
  o.id AS orderId FROM reservations r LEFT JOIN orders o ON o.reservation_id = r.id`;

export class Inventory {
  constructor(public readonly db: DatabaseSync, private ttlMs = 60_000, private clock = Date.now) {}

  private expireAt(now: number) {
    const expired = this.db.prepare("SELECT id, product_id, quantity FROM reservations WHERE status = 'RESERVED' AND expires_at <= ?")
      .all(now) as { id: string; product_id: string; quantity: number }[];
    for (const r of expired) {
      const result = this.db.prepare("UPDATE reservations SET status = 'EXPIRED' WHERE id = ? AND status = 'RESERVED'").run(r.id);
      if (result.changes === 1) this.db.prepare('UPDATE products SET available = available + ? WHERE id = ?').run(r.quantity, r.product_id);
    }
    return expired.length;
  }

  // Commit expiry even when the requested operation is rejected. Unexpected errors still roll back.
  private run<T>(action: (now: number) => T): T {
    const result = transaction(this.db, () => {
      const now = this.clock(); // Sample after acquiring the write lock, not before waiting for it.
      this.expireAt(now);
      try { return { value: action(now) }; }
      catch (error) {
        if (error instanceof DomainError) return { error };
        throw error;
      }
    });
    if ('error' in result) throw result.error;
    return result.value;
  }

  expire() { return transaction(this.db, () => this.expireAt(this.clock())); }

  snapshot(): SaleSnapshot {
    return this.run((now) => {
      const sale = this.db.prepare('SELECT starts_at AS startsAt, ends_at AS endsAt FROM sale WHERE id = 1').get() as { startsAt: number; endsAt: number };
      const products = this.db.prepare(`SELECT id, name, category, emoji, color, price,
        original_price AS originalPrice, initial_stock AS initialStock, available FROM products ORDER BY rowid`).all() as unknown as Product[];
      return { serverTime: now, reservationTtlMs: this.ttlMs, ...sale, products };
    });
  }

  private owned(id: string, sessionId: string): Reservation {
    const row = this.db.prepare(`${reservationSelect} WHERE r.id = ? AND r.session_id = ?`).get(id, sessionId);
    if (!row) throw new DomainError(404, 'NOT_FOUND', 'Không tìm thấy lượt giữ hàng trong phiên của bạn.');
    return row as unknown as Reservation;
  }

  get(id: string, sessionId: string) { return this.run(() => this.owned(id, sessionId)); }

  reserve(sessionId: string, productId: unknown, quantity: unknown, key: unknown) {
    if (typeof productId !== 'string' || productId.length > 100 || !Number.isSafeInteger(quantity) || (quantity as number) < 1 || (quantity as number) > 100 ||
        typeof key !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(key)) {
      throw new DomainError(400, 'INVALID_INPUT', 'Sản phẩm, số lượng (1–100) hoặc khóa idempotency không hợp lệ.');
    }
    const qty = quantity as number;
    return this.run((now) => {
      const prior = this.db.prepare('SELECT id, product_id, quantity FROM reservations WHERE session_id = ? AND idempotency_key = ?').get(sessionId, key);
      if (prior) {
        if (prior.product_id !== productId || prior.quantity !== qty) throw new DomainError(409, 'IDEMPOTENCY_CONFLICT', 'Khóa yêu cầu đã được dùng cho nội dung khác.');
        return this.owned(prior.id as string, sessionId);
      }
      const sale = this.db.prepare('SELECT starts_at, ends_at FROM sale WHERE id = 1').get()!;
      if (now < (sale.starts_at as number)) throw new DomainError(409, 'SALE_NOT_STARTED', 'Sale chưa bắt đầu. Hãy quay lại khi đồng hồ về 0!');
      if (now >= (sale.ends_at as number)) throw new DomainError(409, 'SALE_ENDED', 'Chương trình flash sale đã kết thúc.');
      const product = this.db.prepare('SELECT price FROM products WHERE id = ?').get(productId);
      if (!product) throw new DomainError(404, 'PRODUCT_NOT_FOUND', 'Không tìm thấy sản phẩm.');
      const updated = this.db.prepare('UPDATE products SET available = available - ? WHERE id = ? AND available >= ?').run(qty, productId, qty);
      if (updated.changes !== 1) throw new DomainError(409, 'OUT_OF_STOCK', 'Không đủ hàng. Một người mua khác có thể đã giữ sản phẩm này.');
      const id = randomUUID();
      this.db.prepare(`INSERT INTO reservations
        (id, session_id, product_id, quantity, unit_price, status, expires_at, created_at, idempotency_key)
        VALUES (?, ?, ?, ?, ?, 'RESERVED', ?, ?, ?)`).run(id, sessionId, productId, qty, product.price, now + this.ttlMs, now, key);
      return this.owned(id, sessionId);
    });
  }

  checkout(id: string, sessionId: string) {
    return this.run((now) => {
      const r = this.owned(id, sessionId);
      if (r.status === 'CHECKED_OUT') return r;
      if (r.status !== 'RESERVED') throw new DomainError(409, r.status === 'EXPIRED' ? 'RESERVATION_EXPIRED' : 'INVALID_STATE', 'Lượt giữ hàng đã hết hạn hoặc đã hủy.');
      this.db.prepare("UPDATE reservations SET status = 'CHECKED_OUT' WHERE id = ? AND status = 'RESERVED'").run(id);
      this.db.prepare('INSERT INTO orders VALUES (?, ?, ?, ?)').run(randomUUID(), id, r.quantity * r.unitPrice, now);
      return this.owned(id, sessionId);
    });
  }

  cancel(id: string, sessionId: string) {
    return this.run(() => {
      const r = this.owned(id, sessionId);
      if (r.status === 'CANCELLED' || r.status === 'EXPIRED') return r;
      if (r.status === 'CHECKED_OUT') throw new DomainError(409, 'INVALID_STATE', 'Đơn đã thanh toán, không thể hủy lượt giữ hàng.');
      const updated = this.db.prepare("UPDATE reservations SET status = 'CANCELLED' WHERE id = ? AND status = 'RESERVED'").run(id);
      if (updated.changes === 1) this.db.prepare('UPDATE products SET available = available + ? WHERE id = ?').run(r.quantity, r.productId);
      return this.owned(id, sessionId);
    });
  }
}
