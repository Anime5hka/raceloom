import { test } from 'node:test';
import assert from 'node:assert/strict';
import { explore, RaceError } from '../src/index.js';

const staleSearch = async (sim) => {
  const api = sim.wrap('api', { async search(q) { return q.toUpperCase(); } });
  const ui = { query: '', shown: '' };
  const onInput = async (q) => {
    ui.query = q;
    ui.shown = await api.search(q);
  };
  await Promise.all([onInput('a'), onInput('ab')]);
  assert.equal(ui.shown, ui.query.toUpperCase());
};

test('exhaustively enumerates every ordering of independent ops (3! = 6)', async () => {
  const seen = new Set();
  const res = await explore(async (sim) => {
    const order = [];
    const op = sim.fn('op', async (x) => order.push(x));
    await Promise.all([op(1), op(2), op(3)]);
    seen.add(order.join(''));
  });
  assert.equal(res.complete, true);
  assert.equal(res.strategy, 'exhaustive');
  assert.equal(res.schedules, 6);
  assert.deepEqual([...seen].sort(), ['123', '132', '213', '231', '312', '321']);
});

test('sequential code has exactly one schedule', async () => {
  const res = await explore(async (sim) => {
    const op = sim.fn('op', async (x) => x * 2);
    assert.equal(await op(1), 2);
    assert.equal(await op(2), 4);
  });
  assert.deepEqual(res, { schedules: 1, complete: true, strategy: 'exhaustive' });
});

test('finds a stale-response race, shrinks it, and the replay token reproduces it', async () => {
  const err = await explore(staleSearch).catch((e) => e);
  assert.ok(err instanceof RaceError, String(err));
  assert.ok(err.cause instanceof assert.AssertionError);
  assert.deepEqual(err.decisions, [1]);
  assert.equal(err.replay, '1:1');
  assert.match(err.message, /overtook 1 earlier pending op/);
  assert.match(err.message, /api\.search\('ab'\)/);

  const again = await explore(staleSearch, { replay: err.replay }).catch((e) => e);
  assert.ok(again instanceof RaceError);
  assert.equal(again.replay, err.replay);

  // The default order (no reordering) passes.
  assert.deepEqual(await explore(staleSearch, { replay: '1:' }), { schedules: 1, complete: false, strategy: 'replay' });
});

test('random strategy finds the race too', async () => {
  const err = await explore(staleSearch, { strategy: 'random', runs: 50 }).catch((e) => e);
  assert.ok(err instanceof RaceError);
  assert.equal(err.strategy, 'random');
  assert.deepEqual(err.decisions, [1], 'shrunk to one reordering');
});

test('shrinks a long random failure down to the essential reordering', async () => {
  // 6 unrelated noise ops + the stale search: lots of irrelevant reorderings to strip.
  const body = async (sim) => {
    const noise = sim.fn('noise', async () => {});
    await Promise.all([noise(), noise(), noise(), staleSearch(sim), noise(), noise(), noise()]);
  };
  const err = await explore(body, { strategy: 'random', runs: 200 }).catch((e) => e);
  assert.ok(err instanceof RaceError);
  assert.equal(err.decisions.filter((d) => d !== 0).length, 1);
});

test('without shrinking, the raw failing schedule is reported', async () => {
  const err = await explore(staleSearch, { strategy: 'random', shrink: false, seed: 7, runs: 100 }).catch((e) => e);
  assert.ok(err instanceof RaceError);
  const again = await explore(staleSearch, { replay: err.replay }).catch((e) => e);
  assert.ok(again instanceof RaceError);
});

test('detects deadlocks', async () => {
  const err = await explore(async (sim) => {
    await sim.fn('load')();
    await new Promise(() => {}); // nobody resolves this
  }).catch((e) => e);
  assert.ok(err instanceof RaceError);
  assert.equal(err.cause.name, 'Deadlock');
  assert.match(err.message, /never finished/);
});

test('op errors propagate to the caller and show up in the trace', async () => {
  const err = await explore(async (sim) => {
    const boom = sim.fn('boom', async () => {
      throw new Error('kaboom');
    });
    await boom(1);
  }).catch((e) => e);
  assert.ok(err instanceof RaceError);
  assert.equal(err.cause.message, 'kaboom');
  assert.match(err.message, /✗ boom\(1\) threw Error: kaboom/);
});

test('caught op errors do not fail the run', async () => {
  const res = await explore(async (sim) => {
    const boom = sim.fn('boom', async () => {
      throw new Error('kaboom');
    });
    await assert.rejects(boom(), /kaboom/);
  });
  assert.equal(res.complete, true);
});

test('nested operations inside an op implementation are scheduled too', async () => {
  const orders = new Set();
  await explore(async (sim) => {
    const log = [];
    const inner = sim.fn('inner', async (x) => log.push(x));
    const outer = sim.fn('outer', async (x) => {
      await inner(`${x}1`);
      await inner(`${x}2`);
    });
    await Promise.all([outer('a'), outer('b')]);
    orders.add(log.join(' '));
    assert.ok(log.indexOf('a1') < log.indexOf('a2'));
  });
  assert.ok(orders.size > 1);
});

test('timers fire in deadline order and advance virtual time', async () => {
  await explore(async (sim) => {
    const fired = [];
    await Promise.all([
      sim.sleep(100).then(() => fired.push(['slow', sim.now()])),
      sim.sleep(50).then(() => fired.push(['fast', sim.now()])),
    ]);
    assert.deepEqual(fired, [['fast', 50], ['slow', 100]]);
  });
});

test('an op and a timer race in both directions', async () => {
  const winners = new Set();
  await explore(async (sim) => {
    const fetch = sim.fn('fetch', async () => 'data');
    winners.add(await Promise.race([fetch(), sim.sleep(1000).then(() => 'timeout')]));
  });
  assert.deepEqual([...winners].sort(), ['data', 'timeout']);
});

test('clearTimeout cancels and setInterval repeats', async () => {
  await explore(async (sim) => {
    let ticks = 0;
    const t = sim.setTimeout(() => assert.fail('should be cancelled'), 10);
    sim.clearTimeout(t);
    await new Promise((resolve) => {
      const id = sim.setInterval(() => {
        if (++ticks === 3) {
          sim.clearInterval(id);
          resolve();
        }
      }, 10);
    });
    assert.equal(sim.now(), 30);
  });
});

test('an uncaught exception in a timer callback fails the run', async () => {
  const err = await explore(async (sim) => {
    sim.setTimeout(() => {
      throw new Error('in timer');
    }, 5);
    await sim.sleep(10);
  }).catch((e) => e);
  assert.ok(err instanceof RaceError);
  assert.equal(err.cause.message, 'in timer');
});

test('leftover intervals after the body finishes do not hang', async () => {
  const res = await explore(async (sim) => {
    sim.setInterval(() => {}, 10);
  });
  assert.equal(res.complete, true);
});

test('maxSteps stops runaway loops', async () => {
  const err = await explore(
    async (sim) => {
      for (;;) await sim.yield();
    },
    { maxSteps: 50 },
  ).catch((e) => e);
  assert.ok(err instanceof RaceError);
  assert.match(err.cause.message, /maxSteps/);
});

test('patchGlobals virtualizes setTimeout, Date and Math.random, then restores them', async () => {
  const realSetTimeout = globalThis.setTimeout;
  const realDate = Date;
  const realRandom = Math.random;
  const randoms = [];
  await explore(
    async () => {
      const t0 = Date.now();
      await new Promise((r) => setTimeout(r, 5000)); // would take 5s for real
      assert.equal(Date.now() - t0, 5000);
      assert.equal(new Date().getTime(), Date.now());
      randoms.push(Math.random());
    },
    { patchGlobals: true },
  );
  assert.equal(globalThis.setTimeout, realSetTimeout);
  assert.equal(Date, realDate);
  assert.equal(Math.random, realRandom);
  assert.ok(randoms[0] >= 0 && randoms[0] < 1);
});

test('sim.random is reproducible per seed', async () => {
  const draw = async (seed) => {
    let v;
    await explore((sim) => void (v = [sim.random(), sim.random()]), { seed });
    return v;
  };
  assert.deepEqual(await draw(42), await draw(42));
  assert.notDeepEqual(await draw(42), await draw(43));
});

test('sim.go labels tasks in the trace; sim.log adds notes', async () => {
  const err = await explore(async (sim) => {
    const op = sim.fn('op');
    await sim.go('worker-A', async () => {
      sim.log('starting', { n: 1 });
      await op();
    });
    throw new Error('done');
  }).catch((e) => e);
  assert.match(err.message, /worker-A │ • starting \{ n: 1 \}/);
  assert.match(err.message, /worker-A │ → op\(\)/);
});

test('wrap passes through non-function properties and keeps `this`', async () => {
  await explore(async (sim) => {
    const store = sim.wrap('store', {
      size: 3,
      items: [1, 2, 3],
      async first() {
        return this.items[0];
      },
    });
    assert.equal(store.size, 3);
    assert.equal(await store.first(), 1);
    assert.equal(store.first, store.first, 'stable method identity');
  });
});

test('fakes captured from a finished schedule throw a helpful error', async () => {
  let leaked;
  await explore((sim) => void (leaked = sim.fn('op')), { runs: 1 });
  assert.throws(() => leaked(), /Create fakes inside the explore\(\) body/);
});

test('rejects bad arguments', async () => {
  await assert.rejects(explore(), TypeError);
  await assert.rejects(explore(() => {}, { strategy: 'nope' }), /unknown strategy/);
  await assert.rejects(explore(() => {}, { replay: 'garbage' }), /invalid replay token/);
});

test('budget: exhaustive search stops at `runs` and reports incomplete', async () => {
  const res = await explore(
    async (sim) => {
      const op = sim.fn('op');
      await Promise.all(Array.from({ length: 8 }, () => op())); // 8! = 40320 orderings
    },
    { runs: 20 },
  );
  assert.equal(res.complete, false);
  assert.equal(res.schedules, 20);
});

test('patched Date still works without `new`, with arguments, and with instanceof', async () => {
  const RealDate = Date;
  await explore(
    async () => {
      assert.equal(typeof Date(), 'string');
      assert.ok(new Date() instanceof RealDate);
      assert.equal(new Date(0).getTime(), 0);
      assert.equal(Date.UTC(2020, 0, 1), RealDate.UTC(2020, 0, 1));
      const t0 = Date.now();
      await new Promise((r) => setTimeout(r, 1234));
      assert.equal(Date.now() - t0, 1234);
    },
    { patchGlobals: true },
  );
});

test('the body finishing does not cut off operations still settling', async () => {
  let finished = false;
  const res = await explore(async (sim) => {
    const slow = sim.fn('slow', () => new Promise((r) => setTimeout(r, 5))); // real timer inside the fake
    const after = sim.fn('after');
    slow().then(() => after()).then(() => (finished = true));
  }, { runs: 1 });
  assert.equal(res.schedules, 1);
  assert.equal(finished, true);
});

test('shrinking keeps the same kind of failure', async () => {
  class LostUpdate extends Error { name = 'LostUpdate'; }
  // The default order fails with a *different* error; shrinking must not drift to it.
  const body = async (sim) => {
    const op = sim.fn('op', async (x) => x);
    const order = [];
    await Promise.all(['a', 'b', 'c'].map((x) => op(x).then(() => order.push(x))));
    const o = order.join('');
    if (o === 'abc') throw new TypeError('default order');
    if (o === 'cba') throw new LostUpdate(o);
  };
  // seed 5: the first random schedule that fails is the 'cba' LostUpdate.
  const err = await explore(body, { strategy: 'random', seed: 5 }).catch((e) => e);
  assert.equal(err.cause.name, 'LostUpdate');
  assert.match(err.message, /LostUpdate: cba/);
});

test('odd seeds still produce valid replay tokens', async () => {
  const err = await explore(staleSearch, { seed: -5, strategy: 'random' }).catch((e) => e);
  assert.match(err.replay, /^\d+:[\d.]+$/);
  await assert.rejects(explore(staleSearch, { replay: err.replay }), RaceError);
});
