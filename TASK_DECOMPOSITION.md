# Task Decomposition — HW3 Flash Sale

**Mục tiêu:** mô phỏng sale 11.11 với countdown chống trôi, giữ hàng có hạn và checkout không bán vượt tồn kho.

Mỗi dòng là một phần việc và một commit riêng; push lần lượt theo thứ tự phụ thuộc dưới đây.

| # | Phần việc | Commit (Conventional Commits) |
| --- | --- | --- |
| 1 | Khởi tạo TypeScript, React/Vite và scripts | `chore: initialize TypeScript full-stack workspace` |
| 2 | Tạo schema SQLite, seed sản phẩm và cấu hình | `feat: add SQLite schema and demo seed` |
| 3 | Transaction giữ hàng, idempotency và state machine | `feat: implement transactional inventory reservations` |
| 4 | API checkout, phiên mua và tự thu hồi hàng hết hạn | `feat: add checkout API and reservation expiry sweeper` |
| 5 | Countdown bằng Date.now() và requestAnimationFrame | `feat: implement anti-drift countdown timer` |
| 6 | Giao diện tiếng Việt, lọc sản phẩm và luồng mua | `feat: build Vietnamese flash-sale interface` |
| 7 | Sửa reset nguyên tử, Origin và thời hạn hiển thị | `fix: make reset atomic and validate origin and sale timing` |
| 8 | Test đồng thời, race condition và trình duyệt | `test: verify inventory races and concurrent purchases` |
| 9 | Sửa proxy Vite và watcher cho môi trường dev | `fix: preserve browser origin through the Vite dev proxy` |
| 10 | README và báo cáo 4 lỗi AI đã kiểm chứng | `docs: add AI failure audit and setup guide` |
| 11 | Tổng hợp phân rã công việc và thứ tự bàn giao | `docs: add concise task decomposition` |

**Điều kiện hoàn thành:** typecheck/build thành công; 14 test backend/timer/proxy và 12 test trình duyệt qua; 100 yêu cầu qua 4 tiến trình tranh 10 sản phẩm chỉ có 10 lượt giữ thành công. Audit có ít nhất 3 lỗi AI, lịch sử có ít nhất 8 commit.

**Bàn giao:** push các commit lên `origin/main` theo thứ tự trên, giữ nguyên lịch sử và không force-push.
