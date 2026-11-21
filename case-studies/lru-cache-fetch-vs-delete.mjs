import { LRUCache } from 'lru-cache';
import { explore } from 'raceloom';
const r = await explore(async (sim) => {
  const rows = new Map([[1, 'old']]);
  const db = sim.wrap('db', { async load(k) { return rows.get(k); }, async save(k, v) { rows.set(k, v); } }, { network: true });
  const cache = new LRUCache({ max: 10, fetchMethod: (k) => db.load(k) });
  await Promise.all([
    sim.go('reader', () => cache.fetch(1).catch(() => {})),
    sim.go('writer', async () => { await db.save(1, 'new'); cache.delete(1); }),
  ]);
  const v = await cache.fetch(1);
  if (v !== 'new') throw new Error(`stale value ${v} served after delete`);
});
console.log('no race found', r);
