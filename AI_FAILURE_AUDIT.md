# AI Failure Audit — HW3

Ngày kiểm chứng: **25/10/2026**. Phạm vi: code do AI tạo trong phiên triển khai repository này. Bốn mục dưới đây là **lỗi thực tế trong bản đầu**, đã được tái hiện trước khi sửa; không phải các lỗi giả định được gán cho AI. Ba lỗi đầu có regression test thất bại trước sửa; lỗi thứ tư được phát hiện bằng smoke test lệnh dev và có regression test sau sửa.

## 1. Reset dữ liệu chia thành hai transaction gây mất dữ liệu khi seed lỗi

**Quyết định sai của AI:** bản đầu `server/reset.ts` commit thao tác DELETE trong một transaction, sau đó gọi `seedDatabase()` trong transaction thứ hai. AI coi việc từng bước có transaction là đủ để toàn bộ reset nguyên tử.

```ts
// Bản đầu, đã được thay thế
transaction(db, () => db.exec('DELETE FROM orders; ... DELETE FROM sale;'));
seedDatabase(db, config);
```

**Tác động:** nếu seed lỗi, dữ liệu cũ đã bị xóa vĩnh viễn khỏi database demo. Giữa hai bước cũng tồn tại trạng thái không có sale/sản phẩm cho các kết nối khác.

**Tái hiện đã chạy:** test `failed reset rolls back deletions and preserves the original demo` tạo database 6 sản phẩm, cài SQLite trigger `BEFORE INSERT ON products` dùng `RAISE(ABORT, 'simulated seed failure')`, rồi thực thi script reset thật bằng tiến trình con.

**Kết quả trước sửa:** script thất bại đúng như dự kiến nhưng assertion số sản phẩm báo **`0 !== 6`**. Đây là dữ liệu bị mất thật trong database thử nghiệm, không chỉ suy luận từ code.

**Sửa:** đưa DELETE và seed vào một `BEGIN IMMEDIATE` duy nhất thông qua `resetDatabase()`; tách phần seed nội bộ để không mở transaction lồng nhau. Lỗi seed rollback cả thao tác xóa.

**Xác minh sau sửa:** regression test trong `tests/database.test.ts` qua, giữ nguyên 6 sản phẩm và `starts_at = 1000` sau lỗi. Chạy bằng `npm.cmd test`.

**Bài học:** tính nguyên tử phải bao trùm trọn hành động nghiệp vụ; hai transaction riêng không tạo thành một transaction lớn.

## 2. Tin rằng Origin luôn parse được thành URL

**Code sai của AI:** middleware bản đầu gọi trực tiếp `new URL(origin).host`. AI chỉ xét Origin dạng URL thông thường.

```ts
// Bản đầu, đã được thay thế
if (origin && new URL(origin).host !== req.get('host')) { /* reject */ }
```

**Tác động:** `Origin: null` (có thể xuất hiện từ opaque origin) gây `TypeError: Invalid URL`, rơi vào error handler chung và trả `500 INTERNAL_ERROR`, thay vì từ chối rõ ràng. Server không crash nhưng xử lý sai loại lỗi và ghi log lỗi nội bộ không cần thiết.

**Tái hiện đã chạy:** gửi HTTP GET `/api/sale` với `Origin: null` trong `tests/api.test.ts`.

**Kết quả trước sửa:** stack trace `ERR_INVALID_URL`, assertion **`500 !== 403`**.

**Sửa:** kiểm tra `URL.canParse(origin)` trước khi parse; so sánh origin đầy đủ (scheme + host + port) với origin của request. Origin không hợp lệ hoặc khác origin trả `403 INVALID_ORIGIN`.

**Xác minh sau sửa:** HTTP test qua với cả Origin từ domain khác và `Origin: null`; session/ownership tests vẫn qua. Chạy bằng `npm.cmd test`.

**Bài học:** header là dữ liệu đầu vào không đáng tin; không suy ra tính hợp lệ chỉ từ việc nó có giá trị.

## 3. Hardcode thời hạn giữ hàng trên giao diện dù backend cho phép cấu hình

**Quyết định sai của AI:** backend đọc `RESERVATION_TTL_MS`, đồng hồ reservation đọc `expiresAt`, nhưng phần mô tả giao diện lại ghi cứng “60 giây”. Hai nguồn thời gian không thống nhất.

**Tác động:** khi backend giữ hàng 10 giây, người mua vẫn được thông báo có 60 giây. Countdown vận hành đúng nhưng hướng dẫn mua sai, có thể khiến người mua chậm checkout.

**Tái hiện đã chạy:** Playwright khởi động backend với `RESERVATION_TTL_MS=10000`; test `buy, restore on reload, checkout and display a responsive layout` kiểm tra `.hero-note`.

**Kết quả trước sửa:**

```text
Expected substring: "Giữ hàng trong 10 giây"
Received string:    "✦ Ưu đãi đến 62% · Giữ hàng trong 60 giây"
```

**Sửa:** thêm `reservationTtlMs` vào `SaleSnapshot`, lấy từ cấu hình đang dùng của Inventory; mọi đoạn hướng dẫn thời hạn trên UI dùng giá trị server trả về. Đồng thời sửa số phần trăm ưu đãi tối đa từ 62% thành 61% theo dữ liệu seed.

**Xác minh sau sửa:** browser test kiểm tra “10 giây”; cùng bộ test kiểm tra expiry thật và hoàn kho trên desktop/mobile. Mặc định vẫn là 60 giây. Chạy `npm.cmd run build` rồi `npm.cmd run test:e2e`.

**Bài học:** nội dung hiển thị ảnh hưởng quyết định người dùng cũng phải dùng cùng nguồn dữ liệu với nghiệp vụ.

## 4. Bỏ sót hành vi rewrite Host của proxy Vite dạng chuỗi

**Quyết định sai của AI:** cấu hình ban đầu dùng `proxy: { '/api': 'http://127.0.0.1:3001' }` và giả định Host được giữ nguyên. Source Vite thực tế chuyển cấu hình chuỗi thành `{ target, changeOrigin: true }`.

**Tác động:** frontend GET lấy sản phẩm thành công, nhưng POST từ browser có `Origin: http://127.0.0.1:5173` bị backend từ chối vì Host đã thành `127.0.0.1:3001`. E2E production không bắt được lỗi riêng của môi trường dev.

**Tái hiện đã chạy:** khởi động `npm.cmd run dev`, gửi GET và POST qua cổng 5173 với cookie phiên cùng Origin của frontend. Kết quả trước sửa: `UI 200`, `API proxy 200`, `reserve through proxy 403` với `INVALID_ORIGIN`.

**Sửa:** dùng cấu hình proxy object và đặt `changeOrigin: false`, giữ nguyên Host để kiểm tra cùng origin hoạt động cả dev và production. Đồng thời thay `tsx watch` bị treo trong smoke test Windows bằng `node --watch --import tsx`; backend đã khởi động được bằng lệnh dev thực tế.

**Xác minh sau sửa:** cùng smoke test trả `UI 200`, `API proxy 200`, `reserve through proxy 201`, `cancel 200`. Test `tests/proxy.test.ts` khởi động Vite proxy thật trên cổng ngẫu nhiên, xác nhận reserve/cancel thành công và Origin khác vẫn bị chặn. Toàn bộ **14 test backend/timer/proxy** và build qua; bộ **12 browser tests** desktop/mobile qua.

**Bài học:** phải kiểm thử cả đường chạy dev được hướng dẫn cho người dùng; không suy ra cấu hình proxy từ tên tùy chọn hoặc kết quả production.

## Các rủi ro đã được kiểm thử, không khai báo là lỗi đã xảy ra

Không quan sát thấy oversell trong kiểm thử: 100 HTTP requests qua 4 tiến trình SQLite độc lập tạo đúng 10 lượt giữ từ 10 sản phẩm. Checkout lặp 20 lần chỉ tạo một đơn; cancel/checkout và expiry/checkout không tạo hai hiệu ứng cuối; restart thu hồi đúng reservation quá hạn.

Timer tests xác minh callback trễ/tab nền không tích lũy sai số, và browser tests xác minh hiệu chỉnh khi đồng hồ client nhanh hơn server 30 giây. Đây là bằng chứng trong các kịch bản kiểm thử, không phải chứng nhận độ chính xác mạng tuyệt đối hay năng lực tải production.

## Cách kiểm tra độc lập

```powershell
npm.cmd ci
npm.cmd test
npm.cmd run build
npm.cmd run test:e2e
git log --oneline --reverse
```

Các bản đầu có thể đối chiếu trong lịch sử Git trước commit `fix: make reset atomic and validate origin and sale timing`; regression tests được giữ lại trong repository. Không cần rollback repository chính để xác minh kết quả bản hiện tại.
