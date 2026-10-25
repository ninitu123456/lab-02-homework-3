import { useCallback, useEffect, useRef, useState } from 'react';
import type { Product, Reservation, ReservationResponse, SaleSnapshot } from '../shared/types.js';
import { api, ApiError } from './api.js';
import { createAntiDriftTimer } from './anti-drift-timer.js';

const money = (value: number) => new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(value);
const storageKey = 'chop-sale-v1';
interface Saved { ids: string[]; pending: Record<string, { key: string; quantity: number }> }
function readSaved(): Saved {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) || '{}') as Partial<Saved>;
    return {
      ids: Array.isArray(value.ids) ? value.ids.filter(id => typeof id === 'string') : [],
      pending: value.pending && typeof value.pending === 'object' ? value.pending : {},
    };
  } catch { return { ids: [], pending: {} }; }
}

function Countdown({ target, offset, compact = false, onDone }: { target: number; offset: number; compact?: boolean; onDone?: () => void }) {
  const [remaining, setRemaining] = useState(() => Math.max(0, target - Date.now() - offset));
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  useEffect(() => {
    let done = false;
    return createAntiDriftTimer(target - Date.now() - offset, (value) => {
      setRemaining(value);
      if (value === 0 && !done) { done = true; doneRef.current?.(); }
    });
  }, [target, offset]);
  const hours = String(Math.floor(remaining / 3_600_000)).padStart(2, '0');
  const minutes = String(Math.floor(remaining / 60_000) % 60).padStart(2, '0');
  const seconds = String(Math.floor(remaining / 1000) % 60).padStart(2, '0');
  const ms = String(Math.floor(remaining % 1000)).padStart(3, '0');
  if (compact) return <span className="small-countdown" aria-label="Thời gian giữ hàng còn lại">{minutes}:{seconds}<small>.{ms}</small></span>;
  return <div className="clock" aria-label="Đồng hồ flash sale">
    {[['GIỜ', hours], ['PHÚT', minutes], ['GIÂY', seconds]].map(([label, value], i) => <div className="clock-part" key={label}>
      {i > 0 && <span className="colon">:</span>}<div><strong>{value}</strong><span>{label}</span></div>
    </div>)}<div className="milliseconds">.{ms}<span>MILI GIÂY</span></div>
  </div>;
}

function ProductCard({ product: p, canBuy, busy, retryQuantity, onReserve }: {
  product: Product; canBuy: boolean; busy: boolean; retryQuantity?: number;
  onReserve: (product: Product, quantity: number) => void;
}) {
  const [quantity, setQuantity] = useState(1);
  const discount = Math.round((1 - p.price / p.originalPrice) * 100);
  const used = p.initialStock - p.available;
  return <article className="product-card">
    <div className={`product-art ${p.color}`}><span className="discount">−{discount}%</span><span className="product-emoji" role="img" aria-label={p.name}>{p.emoji}</span><span className="art-tag">11.11 EXCLUSIVE</span></div>
    <div className="product-body"><div className="product-category">{p.category}</div><h3>{p.name}</h3>
      <div className="prices"><strong>{money(p.price)}</strong><del>{money(p.originalPrice)}</del></div>
      <div className="stock-label"><span>{p.available === 0 ? 'Đã được giữ hết' : `Còn ${p.available} sản phẩm`}</span><span>{used}/{p.initialStock}</span></div>
      <div className="stock-track"><span style={{ width: `${used / p.initialStock * 100}%` }} /></div>
      <div className="buy-row"><label className="quantity">SL <select aria-label={`Số lượng ${p.name}`} value={retryQuantity ?? quantity} disabled={busy || retryQuantity !== undefined} onChange={e => setQuantity(Number(e.target.value))}>
        {Array.from({ length: 10 }, (_, i) => i + 1).map(n => <option key={n} value={n}>{n}</option>)}
      </select></label><button className="buy-button" disabled={busy || !canBuy || (p.available === 0 && retryQuantity === undefined)} onClick={() => onReserve(p, retryQuantity ?? quantity)}>
        {busy ? 'Đang xử lý…' : retryQuantity !== undefined ? 'Thử lại yêu cầu' : p.available === 0 ? 'Hết hàng' : 'Giữ hàng →'}
      </button></div>
    </div>
  </article>;
}

const labels = { RESERVED: 'Đang giữ hàng', CHECKED_OUT: 'Đã thanh toán', EXPIRED: 'Đã hết hạn', CANCELLED: 'Đã hủy' };

export function App() {
  const [sale, setSale] = useState<SaleSnapshot | null>(null);
  const [offset, setOffset] = useState(0);
  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const [connected, setConnected] = useState(false);
  const [category, setCategory] = useState('Tất cả');
  const [search, setSearch] = useState('');
  const [, setRevision] = useState(0);
  const saved = useRef<Saved>(readSaved());
  const loading = useRef(false);
  const mounted = useRef(true);

  const persist = () => localStorage.setItem(storageKey, JSON.stringify(saved.current));
  const merge = useCallback((reservation: Reservation) => {
    setReservations(previous => {
      const current = previous.find(r => r.id === reservation.id);
      // An older in-flight poll must not overwrite a completed user action.
      if (current && current.status !== 'RESERVED' && reservation.status === 'RESERVED') return previous;
      return [reservation, ...previous.filter(r => r.id !== reservation.id)].sort((a, b) => b.createdAt - a.createdAt);
    });
  }, []);
  const refresh = useCallback(async () => {
    if (loading.current) return;
    loading.current = true;
    try {
      const sent = Date.now();
      const snapshot = await api<SaleSnapshot>('/sale');
      if (!mounted.current) return;
      setOffset(snapshot.serverTime - (sent + Date.now()) / 2);
      setSale(snapshot); setConnected(true);
      const restored = await Promise.allSettled(saved.current.ids.map(id => api<ReservationResponse>(`/reservations/${id}`)));
      if (!mounted.current) return;
      restored.forEach((r, i) => {
        if (r.status === 'fulfilled') merge(r.value.reservation);
        else if (r.reason instanceof ApiError && r.reason.status === 404) {
          const id = saved.current.ids[i];
          setReservations(previous => previous.filter(item => item.id !== id));
        }
      });
    } catch {
      if (mounted.current) setConnected(false);
    } finally { loading.current = false; }
  }, [merge]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const interval = window.setInterval(() => { if (!document.hidden) void refresh(); }, 2000);
    const resume = () => { if (!document.hidden) void refresh(); };
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('online', resume);
    return () => { mounted.current = false; clearInterval(interval); document.removeEventListener('visibilitychange', resume); window.removeEventListener('online', resume); };
  }, [refresh]);

  const deadlineReached = useCallback(() => { setRevision(n => n + 1); void refresh(); }, [refresh]);

  async function reserve(product: Product, quantity: number) {
    if (busy) return;
    setBusy(product.id); setNotice(null);
    try {
      const request = saved.current.pending[product.id] ?? { key: crypto.randomUUID(), quantity };
      saved.current.pending[product.id] = request;
      persist(); // Save BEFORE sending: retry after a lost response uses the same key.
      const result = await api<ReservationResponse>('/reservations', {
        method: 'POST', headers: { 'Idempotency-Key': request.key },
        body: JSON.stringify({ productId: product.id, quantity: request.quantity }),
      });
      if (!saved.current.ids.includes(result.reservation.id)) saved.current.ids.push(result.reservation.id);
      delete saved.current.pending[product.id]; persist();
      merge(result.reservation);
      setNotice({ text: result.reservation.status === 'RESERVED' ? 'Đã giữ hàng! Hoàn tất thanh toán trước khi hết thời gian.' : `Yêu cầu trước đó: ${labels[result.reservation.status]}.`, error: false });
      document.getElementById('my-orders')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (error) {
      if (error instanceof ApiError && error.status < 500) { delete saved.current.pending[product.id]; persist(); }
      setNotice({ text: error instanceof ApiError ? error.message : 'Mất kết nối. Bấm “Thử lại yêu cầu” để kiểm tra kết quả, tránh giữ hàng trùng.', error: true });
    } finally { setBusy(null); void refresh(); }
  }

  async function act(reservation: Reservation, action: 'checkout' | 'cancel') {
    if (busy) return;
    setBusy(reservation.id); setNotice(null);
    try {
      const result = await api<ReservationResponse>(`/reservations/${reservation.id}/${action}`, { method: 'POST' });
      merge(result.reservation);
      setNotice({ text: action === 'checkout' ? 'Thanh toán mô phỏng thành công! Đơn hàng của bạn đã được xác nhận.' : 'Đã hủy lượt giữ hàng và cập nhật tồn kho.', error: false });
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : 'Không thể thực hiện yêu cầu.', error: true });
    } finally { setBusy(null); void refresh(); }
  }

  const now = Date.now() + offset;
  const phase = !sale ? 'loading' : now < sale.startsAt ? 'waiting' : now < sale.endsAt ? 'live' : 'ended';
  const categories = ['Tất cả', 'Âm thanh', 'Góc làm việc', 'Thiết bị thông minh', 'Lifestyle'];
  const visible = sale?.products.filter(p => (category === 'Tất cả' || p.category === category) && p.name.toLocaleLowerCase('vi').includes(search.toLocaleLowerCase('vi'))) ?? [];
  const held = reservations.filter(r => r.status === 'RESERVED');

  return <>
    <div className="top-strip"><span>11.11 · DEAL CHỚP NHOÁNG, NIỀM VUI DÀI LÂU</span><span className="strip-right">Dự án mô phỏng · Không thanh toán thật</span></div>
    <header className="header"><div className="header-inner">
      <a className="brand" href="#" aria-label="Chớp trang chủ"><span className="brand-icon">ϟ</span>chớp<span className="brand-dot">!</span></a>
      <div className="header-divider" /><span className="header-title">Đại tiệc mua sắm 11.11</span>
      <label className="search"><span aria-hidden="true">⌕</span><input type="search" aria-label="Tìm sản phẩm" placeholder="Tìm deal bạn thích…" value={search} onChange={e => setSearch(e.target.value)} /><kbd>11.11</kbd></label>
      <a className="cart-link" href="#my-orders"><span aria-hidden="true">▣</span> Đơn của tôi <b>{held.length}</b></a>
    </div></header>
    <main>
      <div className="breadcrumbs">Trang chủ <span>/</span> Sự kiện <span>/</span> <strong>Flash Sale 11.11</strong></div>
      <section className="hero" aria-label="Sự kiện flash sale">
        <div className="hero-copy"><div className="hero-eyebrow"><span className="live-dot" /> VIETNAM MEGA SALE</div>
          <h1>Deal đến chớp nhoáng.<br /><em>Chốt ngay kẻo lỡ!</em></h1>
          <p>Giá chạm đáy. Số lượng có hạn.<br />Một cú chớp, ngàn deal hời.</p>
          <a className="hero-cta" href="#deals">Săn deal ngay <span>↗</span></a>
          <div className="hero-note">✦ Ưu đãi đến 62% <span>·</span> Giữ hàng trong 60 giây</div>
        </div>
        <div className="hero-number" aria-hidden="true">11<span>.</span>11<div>FLASH SALE</div></div>
        <div className="timer-panel"><div className="timer-heading"><span className={`status-dot ${phase === 'live' ? 'green' : ''}`} />{phase === 'live' ? 'FLASH SALE ĐANG DIỄN RA' : phase === 'ended' ? 'HẸN BẠN Ở ĐỢT SALE TIẾP THEO' : 'SẴN SÀNG SĂN DEAL'}</div>
          <p>{phase === 'live' ? 'Ưu đãi kết thúc sau' : phase === 'ended' ? 'Chương trình đã kết thúc' : 'Chương trình bắt đầu sau'}</p>
          {sale && phase !== 'ended' ? <Countdown target={phase === 'waiting' ? sale.startsAt : sale.endsAt} offset={offset} onDone={deadlineReached} /> : <div className="clock-placeholder">{sale ? '00 : 00 : 00' : 'Đang đồng bộ…'}</div>}
          <div className="timer-footer"><span>◷ Đồng bộ thời gian máy chủ</span><span className="precision-badge">MILLISECOND</span></div>
        </div>
      </section>
      <div className="benefits"><span><i>✓</i> Giữ hàng tức thì</span><span><i>◷</i> 60 giây để chốt đơn</span><span><i>↻</i> Hết hạn tự động hoàn kho</span><span><i>◇</i> Mỗi lượt mua đều được xác nhận</span></div>

      {notice && <div className={`notice ${notice.error ? 'error' : 'success'}`} role={notice.error ? 'alert' : 'status'}><span>{notice.text}</span><button onClick={() => setNotice(null)} aria-label="Đóng thông báo">×</button></div>}
      {!connected && <div className="connection" role="status">{sale ? 'Đang kết nối lại máy chủ. Dữ liệu hiển thị có thể chưa được cập nhật.' : 'Đang kết nối máy chủ…'} <button onClick={() => void refresh()}>Thử lại</button></div>}

      <section id="deals" className="deals"><div className="section-heading"><div><div className="eyebrow">CHỈ CÓ TRONG ĐỢT NÀY</div><h2>ϟ Flash deals <span>Giá tốt, chốt nhanh</span></h2></div><div className="inventory-live"><span className={`status-dot ${connected ? 'green' : ''}`} />{connected ? 'Tồn kho cập nhật trực tiếp' : 'Đang kết nối'}</div></div>
        <div className="filter-row"><div className="categories" aria-label="Danh mục">{categories.map(c => <button className={category === c ? 'active' : ''} key={c} onClick={() => setCategory(c)} aria-pressed={category === c}>{c}</button>)}</div><span className="result-count">{visible.length} sản phẩm</span></div>
        <div className="product-grid">{visible.map(product => <ProductCard key={product.id} product={product} canBuy={connected && (phase === 'live' || saved.current.pending[product.id] !== undefined)} busy={busy !== null} retryQuantity={saved.current.pending[product.id]?.quantity} onReserve={(p, qty) => void reserve(p, qty)} />)}</div>
        {sale && visible.length === 0 && <div className="empty-search">Không tìm thấy sản phẩm. Thử từ khóa hoặc danh mục khác nhé.</div>}
      </section>

      <section id="my-orders" className="orders"><div className="section-heading"><div><div className="eyebrow">DEAL CỦA RIÊNG BẠN</div><h2>Đơn của tôi <span>{reservations.length} lượt giữ hàng</span></h2></div><span className="session-note">Phiên mua riêng trên trình duyệt này</span></div>
        {reservations.length === 0 ? <div className="empty-orders"><div className="empty-icon">▣</div><h3>Deal ngon đang đợi bạn</h3><p>Chọn “Giữ hàng” ở sản phẩm yêu thích.<br />Bạn có 60 giây để hoàn tất thanh toán mô phỏng.</p><a href="#deals">Khám phá flash deals ↑</a></div> : <div className="reservation-list">
          {reservations.map(r => { const p = sale?.products.find(item => item.id === r.productId); return <article className={`reservation ${r.status.toLowerCase()}`} key={r.id} data-testid="reservation">
            <div className={`reservation-art ${p?.color ?? 'peach'}`}>{p?.emoji ?? '📦'}</div>
            <div className="reservation-info"><span className={`state ${r.status.toLowerCase()}`}>{labels[r.status]}</span><h3>{p?.name ?? r.productId}</h3><p>{r.quantity} sản phẩm · {money(r.unitPrice * r.quantity)}</p>{r.orderId && <code>Mã đơn: {r.orderId.slice(0, 8).toUpperCase()}</code>}</div>
            {r.status === 'RESERVED' && <div className="reservation-actions"><div className="expiry-label">Hoàn tất trong <Countdown compact target={r.expiresAt} offset={offset} onDone={deadlineReached} /></div><div><button className="cancel-button" disabled={busy !== null} onClick={() => void act(r, 'cancel')}>Hủy giữ hàng</button><button className="checkout-button" disabled={busy !== null || !connected} onClick={() => void act(r, 'checkout')}>{busy === r.id ? 'Đang xử lý…' : 'Thanh toán mô phỏng'}</button></div></div>}
            {r.status === 'EXPIRED' && <span className="terminal-note">Đã hoàn lại tồn kho</span>}
            {r.status === 'CHECKED_OUT' && <span className="terminal-note paid">✓ Đơn hàng đã xác nhận</span>}
          </article>; })}
        </div>}
      </section>
      <section className="how-it-works"><div><span className="step-number">01</span><h3>Chọn deal yêu thích</h3><p>Canh giờ sale, chọn sản phẩm và số lượng.</p></div><span className="step-arrow">→</span><div><span className="step-number">02</span><h3>Giữ hàng trong 60 giây</h3><p>Sản phẩm tạm thời được dành riêng cho bạn.</p></div><span className="step-arrow">→</span><div><span className="step-number">03</span><h3>Chốt đơn, nhận niềm vui</h3><p>Thanh toán mô phỏng trước khi hết thời gian.</p></div></section>
    </main>
    <footer><a className="brand" href="#"><span className="brand-icon">ϟ</span>chớp!</a><span>HW3 · High-Concurrency Flash-Sale Engine</span><span>Mô phỏng học thuật · Made in Vietnam 🇻🇳</span></footer>
  </>;
}
