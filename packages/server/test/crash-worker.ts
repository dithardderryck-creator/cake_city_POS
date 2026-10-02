/**
 * Run as a separate process by durability.test.ts, which then kills it without warning.
 *   mode "committed":  write 100 rows in committed transactions, announce DONE, then idle.
 *   mode "midway":     open a transaction, write 50 rows, announce INTX, then idle without committing.
 */
import { openSqliteStore } from '../src/sqlite-store';

const [file, mode] = process.argv.slice(2);
const store = openSqliteStore(file!);

if (mode === 'committed') {
  for (let i = 0; i < 100; i++) {
    await store.transaction(async () => {
      await store.put('payments', { id: `p${i}`, amount: i });
    });
  }
  console.log('DONE');
} else {
  store.db.exec('BEGIN IMMEDIATE');
  for (let i = 0; i < 50; i++) store.db.prepare(`INSERT INTO payments (id, data) VALUES (?, ?)`).run(`x${i}`, JSON.stringify({ id: `x${i}` }));
  console.log('INTX');
}
setInterval(() => undefined, 1000);
