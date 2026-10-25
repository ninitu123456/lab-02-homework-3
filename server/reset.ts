import { config } from './config.js';
import { openDatabase, seedDatabase, transaction } from './database.js';

if (process.env.NODE_ENV === 'production') throw new Error('Reset is only available for the local demo.');
const db = openDatabase(config.dbPath);
try {
  transaction(db, () => {
    db.exec('DELETE FROM orders; DELETE FROM reservations; DELETE FROM sessions; DELETE FROM products; DELETE FROM sale;');
  });
  seedDatabase(db, config);
  console.log('Đã reset dữ liệu demo. Sale mới sẽ bắt đầu sau', config.saleDelayMs / 1000, 'giây.');
} finally {
  db.close();
}
