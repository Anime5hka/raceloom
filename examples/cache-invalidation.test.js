// Cache-aside with an async cache (think Redis). A reader and a writer race:
//   reader: load from db (old value) ......................... cache.set(old)
//   writer:            db.save(new) → cache.del
// The reader's late cache.set re-populates the cache with stale data — forever.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { explore } from 'raceloom';

function createUserService(db, cache) {
  return {
    async getUser(id) {
      const hit = await cache.get(id);
      if (hit) return hit;
      const user = await db.load(id);
      await cache.set(id, user);
      return user;
    },
    async renameUser(id, name) {
      await db.save(id, { name });
      await cache.del(id); // invalidate
    },
  };
}

test('cache never serves stale data after a rename', async () => {
  await explore(async (sim) => {
    const rows = new Map([[1, { name: 'Ada' }]]);
    const entries = new Map();
    const db = sim.wrap('db', {
      async load(id) { return rows.get(id); },
      async save(id, row) { rows.set(id, row); },
    });
    const cache = sim.wrap('cache', {
      async get(id) { return entries.get(id); },
      async set(id, v) { entries.set(id, v); },
      async del(id) { entries.delete(id); },
    });
    const users = createUserService(db, cache);

    await Promise.all([
      sim.go('reader', () => users.getUser(1)),
      sim.go('writer', () => users.renameUser(1, 'Grace')),
    ]);

    // Once everything settles, a fresh read must see the new name.
    assert.equal((await users.getUser(1)).name, 'Grace');
  });
});
