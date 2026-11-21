---
name: raceloom
description: Find race conditions in async JavaScript/TypeScript or Python asyncio code by writing a raceloom test that explores every ordering of the awaits. Use when code has two or more async actors touching shared state (caches, debounced search, job queues, retries, timeouts, optimistic UI, locks, rate limiters), when a bug is "flaky" or "only happens in production", when reviewing async code for races, or when the user asks to prove that some async code is race-free.
---

# Hunting races with raceloom

A normal async test passes because fakes resolve in the order they are called. raceloom re-runs the test body under other orderings of the operations you route through it, shrinks a failure to the fewest out-of-order steps, and prints a timeline with a replay token. If exhaustive search finishes without a failure, the result says `complete: true` — the scenario is proven race-free.

Install (no registry release yet):

- JS/TS (Node ≥ 20, ESM): `npm install --save-dev github:Anime5hka/raceloom`
- Python (≥ 3.11, asyncio): `pip install "git+https://github.com/Anime5hka/raceloom#subdirectory=python"`

## Workflow

1. **Find the actors.** Name the 2–4 things that overlap in real life: two keystrokes, a reader and a writer, a worker and a timeout, two retries. More than 4 concurrent actors makes exhaustive search explode; split into several focused tests instead.
2. **Find the boundaries.** Every place the real code waits on the outside world (DB, HTTP, cache, queue, file) becomes a fake that is *wrapped*. Only wrapped calls, virtual timers and explicit `yield`/`checkpoint`s are reordered — plain `await` on an already-resolved value is not a race point.
3. **Build a fresh world inside the body.** Create the in-memory state, fakes and the code under test *inside* `explore`'s callback, so every schedule starts clean. Shared state outside the body is the #1 cause of confusing results.
4. **Assert an invariant, not a sequence.** Check what must hold in every ordering: "the UI shows results for the current query", "the cache never holds a value older than the DB", "the customer was charged at most once", "every waiter eventually ran". Asserting exact call order makes every reordering fail.
5. **Use `network: true` for request/response I/O.** It splits a call into "executed on the server" and "response arrived", which exposes the read-executed-before-write-but-arrived-after class of bugs (stale cache writes). Use it for DB/HTTP fakes; leave it off for pure in-process calls.
6. **Run it and read the timeline.** `⚡ overtook N earlier pending ops` marks the step where reality diverged from the happy path — that is the cause. Use the replay token to reproduce exactly that ordering while fixing.
7. **Fix, then keep the test.** After the fix the same test should pass; if the search is small enough it will say `complete: true`. Keep it in the suite as a regression test.

## JavaScript template

```js
import { test } from 'node:test';            // vitest / jest (ESM) work too
import assert from 'node:assert/strict';
import { explore } from 'raceloom';

test('cache never serves stale data after a rename', async () => {
  await explore(async (sim) => {
    const rows = new Map([[1, 'old']]);
    const db = sim.wrap('db', {
      async load(id) { return rows.get(id); },
      async save(id, v) { rows.set(id, v); },
    }, { network: true });
    const service = createService(db);       // the real code under test

    await Promise.all([
      sim.go('reader', () => service.get(1)),
      sim.go('writer', () => service.rename(1, 'new')),
    ]);

    assert.equal(await service.get(1), 'new');
  });
});
```

Other tools on `sim`: `sim.fn(name, impl)` for one function, `sim.mockFetch(handler, { global: true })` for code that calls `fetch`, `sim.sleep(ms)` / `sim.setTimeout` for virtual time, `sim.yield(label)` to add a preemption point inside code that has none, `sim.log(...)` to annotate the timeline. For unmodified code that uses `setTimeout`/`setInterval`/`Date`/`Math.random`, pass `{ patchGlobals: true }` (do not run such tests concurrently in one worker).

## Python template

```python
import asyncio
from raceloom import explore

def test_cache_never_serves_stale_data():          # a plain sync pytest test
    async def scenario(sim):
        rows = {1: "old"}
        class Db:
            async def load(self, k): return rows[k]
            async def save(self, k, v): rows[k] = v
        db = sim.wrap("db", Db(), network=True)
        service = Service(db)                       # the real code under test
        async with asyncio.TaskGroup() as tg:
            tg.create_task(service.get(1), name="reader")
            tg.create_task(service.rename(1, "new"), name="writer")
        assert await service.get(1) == "new"

    explore(scenario)
```

In Python the whole event loop runs on a virtual clock, so `asyncio.sleep`, `wait_for` and `asyncio.timeout` are simulated with no patching. `explore` is synchronous; inside async code call `await asyncio.to_thread(explore, scenario)`. Use `sim.checkpoint(label)` as an explicit preemption point.

## Options worth knowing

- `runs` (default 1000): schedule budget. `strategy`: `auto` (default: exhaustive, then random + PCT), `exhaustive`, `random`, `pct`.
- `replay`: the token from a `RaceError` — re-runs one schedule exactly (`{ replay: "1:0.1" }` in JS, `replay="1:0.1"` in Python).
- `maxSteps` / `max_steps`: catches runaway loops. Deadlocks and unhandled rejections / unretrieved task errors are reported automatically.

## Reporting back to the user

When raceloom finds a race, show the shrunk timeline verbatim, then explain it in one or two sentences in terms of the user's domain ("the response for 'r' arrived after the response for 'ra', so the box shows results for the old query"), then propose the fix. When it finds nothing, say whether the search was `complete` (proof for this scenario) or sampled (evidence, not proof), and what the scenario did not cover.

## Common mistakes

- Fakes created outside the body → state leaks between schedules.
- Nothing wrapped → only one schedule exists; raceloom reports `complete: true` after 1 run. If `schedules` is 1, the test is not exercising any race.
- Real I/O in fakes → orderings are no longer reproducible; keep fakes in memory.
- Asserting call order instead of an invariant → every reordering "fails".
