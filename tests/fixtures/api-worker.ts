import { openDatabase } from '../../server/database.js';
import { createApp } from '../../server/app.js';

const db = openDatabase(process.env.TEST_DB!);
let now = 1000;
const { app, inventory } = createApp(db, { ttlMs: 100, clock: () => now });
const server = app.listen(0, '127.0.0.1', () => {
  process.send?.({ type: 'ready', port: (server.address() as { port: number }).port });
});
process.on('message', (message: { type: string; now?: number; id?: string }) => {
  if (message.type === 'clock') {
    now = message.now!;
    inventory.expire();
    process.send?.({ type: 'ack', id: message.id });
  }
  if (message.type === 'stop') server.close(() => { db.close(); process.exit(0); });
});
