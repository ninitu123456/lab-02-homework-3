import { test, expect, type Page } from '@playwright/test';

function product(page: Page, name: string) { return page.locator('.product-card').filter({ has: page.getByRole('heading', { name, exact: true }) }); }
async function open(page: Page) {
  await page.goto('/');
  await expect(page.getByText('Tồn kho cập nhật trực tiếp')).toBeVisible();
}

test('buy, restore on reload, checkout and display a responsive layout', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await open(page);
  await expect(page.getByRole('heading', { name: 'Deal đến chớp nhoáng.' })).toBeVisible();
  await expect(page.locator('.hero-note')).toContainText('Giữ hàng trong 10 giây');
  await page.getByRole('button', { name: 'Âm thanh', exact: true }).click();
  await expect(page.locator('.product-card')).toHaveCount(2);
  await page.getByRole('button', { name: 'Tất cả', exact: true }).click();
  await page.getByRole('searchbox').fill('AirBeat');
  await expect(page.locator('.product-card')).toHaveCount(1);
  await page.getByRole('searchbox').fill('');
  const card = product(page, 'Tai nghe AirBeat Pro');
  await card.getByRole('combobox').selectOption('2');
  await card.getByRole('button', { name: 'Giữ hàng →' }).click();
  await expect(page.getByTestId('reservation').getByText('Đang giữ hàng', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('reservation').getByText('Đang giữ hàng', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Thanh toán mô phỏng', exact: true }).click();
  await expect(page.getByTestId('reservation').getByText('Đã thanh toán', { exact: true })).toBeVisible();
  await expect(page.getByText('✓ Đơn hàng đã xác nhận')).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(overflow).toBe(false);
  await page.screenshot({ path: info.outputPath('flash-sale.png'), fullPage: true });
  expect(errors).toEqual([]);
});

test('independent browser sessions cannot inspect or mutate another buyer reservation; cancel returns stock', async ({ page, browser }) => {
  await open(page);
  const before = await (await page.request.get('/api/sale')).json();
  const stock = before.products.find((p: { id: string }) => p.id === 'keyboard').available;
  await product(page, 'Bàn phím cơ Cloud 75').getByRole('button', { name: 'Giữ hàng →' }).click();
  await expect(page.getByText('Đang giữ hàng', { exact: true })).toBeVisible();
  const id = await page.evaluate(() => JSON.parse(localStorage.getItem('chop-sale-v1')!).ids[0] as string);
  const other = await browser.newContext();
  try {
    for (const [method, suffix] of [['GET', ''], ['POST', '/checkout'], ['POST', '/cancel']]) {
      const response = await other.request.fetch(`http://127.0.0.1:3001/api/reservations/${id}${suffix}`, { method });
      expect(response.status()).toBe(404);
    }
  } finally { await other.close(); }
  await page.getByRole('button', { name: 'Hủy giữ hàng' }).click();
  await expect(page.getByText('Đã hủy', { exact: true })).toBeVisible();
  await page.request.post(`/api/reservations/${id}/cancel`);
  const after = await (await page.request.get('/api/sale')).json();
  expect(after.products.find((p: { id: string }) => p.id === 'keyboard').available).toBe(stock);
});

test('reservation expires and cannot checkout, inventory is returned', async ({ page }) => {
  await open(page);
  const before = await (await page.request.get('/api/sale')).json();
  const stock = before.products.find((p: { id: string }) => p.id === 'speaker').available;
  await product(page, 'Loa Pocket Sound').getByRole('button', { name: 'Giữ hàng →' }).click();
  await expect(page.getByText('Đang giữ hàng', { exact: true })).toBeVisible();
  await expect(page.getByText('Đã hết hạn', { exact: true })).toBeVisible({ timeout: 16_000 });
  await expect(page.getByRole('button', { name: 'Thanh toán mô phỏng', exact: true })).toHaveCount(0);
  const id = await page.evaluate(() => JSON.parse(localStorage.getItem('chop-sale-v1')!).ids[0] as string);
  const response = await page.request.post(`/api/reservations/${id}/checkout`);
  expect(response.status()).toBe(409);
  const after = await (await page.request.get('/api/sale')).json();
  expect(after.products.find((p: { id: string }) => p.id === 'speaker').available).toBe(stock);
});

test('lost successful reserve response retries the same key without locking twice', async ({ page }) => {
  await open(page);
  const keys: string[] = [];
  await page.route('**/api/reservations', async route => {
    keys.push(route.request().headers()['idempotency-key']);
    if (keys.length === 1) { await route.fetch(); await route.abort('failed'); }
    else await route.continue();
  });
  const before = await (await page.request.get('/api/sale')).json();
  const stock = before.products.find((p: { id: string }) => p.id === 'bag').available;
  const card = product(page, 'Balo Daily Essential');
  await card.getByRole('button', { name: 'Giữ hàng →' }).click();
  await expect(page.getByRole('alert')).toContainText('Mất kết nối');
  await page.reload();
  await expect(card.getByRole('button', { name: 'Thử lại yêu cầu' })).toBeEnabled();
  await card.getByRole('button', { name: 'Thử lại yêu cầu' }).click();
  await expect(page.getByText('Đang giữ hàng', { exact: true })).toBeVisible();
  expect(keys).toHaveLength(2); expect(keys[0]).toBe(keys[1]);
  const after = await (await page.request.get('/api/sale')).json();
  expect(after.products.find((p: { id: string }) => p.id === 'bag').available).toBe(stock - 1);
  await page.getByRole('button', { name: 'Hủy giữ hàng' }).click();
});

test('API failure is visible and search has a useful empty state', async ({ page }) => {
  await open(page);
  await page.route('**/api/reservations', route => route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: { code: 'OUT_OF_STOCK', message: 'Không đủ hàng.' } }) }));
  await product(page, 'Máy ảnh Instax Mini').getByRole('button', { name: 'Giữ hàng →' }).click();
  await expect(page.getByRole('alert')).toContainText('Không đủ hàng.');
  await page.getByRole('searchbox').fill('không tồn tại');
  await expect(page.getByText('Không tìm thấy sản phẩm.', { exact: false })).toBeVisible();
});

test('waiting/live/ended boundaries use server time even when the browser clock is 30 seconds ahead', async ({ page }) => {
  const real = await (await page.request.get('/api/sale')).json();
  const startsAt = Date.now() + 3000;
  const endsAt = startsAt + 3000;
  await page.addInitScript(() => {
    const originalNow = Date.now;
    Date.now = () => originalNow() + 30_000;
  });
  await page.route('**/api/sale', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ ...real, startsAt, endsAt, serverTime: Date.now() }),
  }));
  await open(page);
  const buy = product(page, 'Máy ảnh Instax Mini').getByRole('button', { name: 'Giữ hàng →' });
  await expect(page.getByText('Chương trình bắt đầu sau', { exact: true })).toBeVisible();
  await expect(buy).toBeDisabled();
  await expect(page.getByText('FLASH SALE ĐANG DIỄN RA', { exact: true })).toBeVisible();
  await expect(buy).toBeEnabled();
  await expect(page.getByText('Chương trình đã kết thúc', { exact: true })).toBeVisible();
  await expect(buy).toBeDisabled();
});
