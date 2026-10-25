import { config } from './config.js';
import { openDatabase, resetDatabase } from './database.js';

if (process.env.NODE_ENV === 'production') throw new Error('Reset is only available for the local demo.');
const db = openDatabase(config.dbPath);
try {
  resetDatabase(db, config);
  console.log('Đã reset dữ liệu demo. Sale mới sẽ bắt đầu sau', config.saleDelayMs / 1000, 'giây.');
} finally {
  db.close();
}
