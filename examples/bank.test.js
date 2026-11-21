import { test } from 'node:test';
import assert from 'node:assert/strict';
import { explore } from 'raceloom';

// A tiny "bank" with a classic read-modify-write bug.
function makeBank(db) {
  return {
    async withdraw(user, amount) {
      const balance = await db.get(user);
      if (balance < amount) throw new Error('insufficient funds');
      await db.set(user, balance - amount);
    },
  };
}

test('two concurrent withdrawals never lose money', async () => {
  await explore(async (sim) => {
    const store = new Map([['alice', 100]]);
    const db = sim.wrap('db', {
      async get(k) { return store.get(k); },
      async set(k, v) { store.set(k, v); },
    });
    const bank = makeBank(db);

    await Promise.all([
      sim.go('withdraw 30', () => bank.withdraw('alice', 30)),
      sim.go('withdraw 50', () => bank.withdraw('alice', 50)),
    ]);

    assert.equal(store.get('alice'), 20);
  });
});
