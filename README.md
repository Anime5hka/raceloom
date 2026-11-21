<h1 align="center">raceloom 🧶</h1>

<p align="center">
  <b>Find race conditions in async JavaScript and Python before your users do.</b><br>
  raceloom re-runs your test under every ordering of its <code>await</code>s, shrinks the failure<br>
  to the one reordering that matters, and prints exactly what happened.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/dependencies-0-brightgreen" alt="zero dependencies">
  <img src="https://img.shields.io/badge/node-%3E%3D20-339933" alt="node >= 20">
  <img src="https://img.shields.io/badge/python-%3E%3D3.11-3776ab" alt="python >= 3.11">
  <img src="https://img.shields.io/badge/types-included-3178c6" alt="TypeScript types included">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT"></a>
</p>

<p align="center">
  <img src="assets/demo.svg" alt="raceloom finding a stale-response race in a search box" width="820">
</p>

Your tests pass because fake promises resolve in the order you wrote them. Production doesn't care about that order: the second request comes back first, the cache invalidation lands before the stale write, the 30-second timeout fires while the payment call is still in flight.

raceloom is a tiny, zero-dependency library that makes those orderings **testable, exhaustive and reproducible** — like [loom](https://github.com/tokio-rs/loom) for Rust or deterministic simulation testing, but as a 5-line change to a test you already have.

## Quick start

**JavaScript / TypeScript** (Node ≥ 20, any test runner):

```sh
npm install --save-dev github:Anime5hka/raceloom
```

**Python** (asyncio, Python ≥ 3.11, pytest or anything else) — see [python/README.md](python/README.md):

```sh
pip install "git+https://github.com/Anime5hka/raceloom#subdirectory=python"
```

Wrap the async boundaries of your test (your fake db, API client, cache…) with `sim.wrap` / `sim.fn`, and put the test body inside `explore`:

```js
import { test } from 'node:test';           // or vitest, or jest (ESM mode)
import assert from 'node:assert/strict';
import { explore } from 'raceloom';

test('search box shows results for the latest query', async () => {
  await explore(async (sim) => {
    const api = sim.wrap('api', {
      async search(q) { return [`${q}ust`, `${q}ce`]; },
    });
    const box = createSearchBox(api);        // your real code

    await Promise.all([
      sim.go('keystroke 1', () => box.onInput('r')),
      sim.go('keystroke 2', () => box.onInput('ra')),
    ]);

    assert.ok(box.ui.results.every((r) => r.startsWith(box.ui.query)));
  });
});
```

A plain version of this test passes. With raceloom it fails with the timeline above: the response for `"ra"` overtook the response for `"r"`, so the UI shows results for the wrong query. Paste the replay token into `explore(fn, { replay: "1:1" })` and you get that exact interleaving every time — perfect for a debugger.

<details>
<summary><b>The same test in Python</b></summary>

```python
import asyncio
from raceloom import explore

def test_search_box_shows_latest_results():
    async def scenario(sim):
        api = sim.wrap("api", FakeSearchApi())
        box = SearchBox(api)                     # your real code
        async with asyncio.TaskGroup() as tg:
            tg.create_task(box.on_input("r"), name="keystroke 1")
            tg.create_task(box.on_input("ra"), name="keystroke 2")
        assert all(r.startswith(box.query) for r in box.results)

    explore(scenario)
```

In Python every asyncio timer (`sleep`, `wait_for`, `asyncio.timeout`) runs on the virtual clock automatically.
</details>

## What it catches

Every example in [`examples/`](examples) (and its Python twin in [`python/examples/`](python/examples)) is a real bug that a normal unit test misses:

| Example | Bug | Found in |
|---|---|---|
| [search-box](examples/search-box.test.js) | Stale response overwrites newer results | 2 schedules |
| [cache-invalidation](examples/cache-invalidation.test.js) | Reader re-populates the cache with stale data after a writer invalidated it | 5 schedules |
| [job-queue](examples/job-queue.test.js) | Visibility timeout fires during a slow payment → customer charged twice (plain `setTimeout` code, virtual clock) | 4 schedules |

```sh
git clone https://github.com/Anime5hka/raceloom && cd raceloom && npm run examples
# Python: cd python && pip install -e . pytest && pytest examples/
```

## How it works

1. **Every wrapped call becomes a pending operation.** `sim.wrap('db', fakeDb)` returns a proxy; calling `db.get('alice')` doesn't run the fake yet — it parks the call.
2. **raceloom decides what runs next.** Whenever your code is idle (all microtasks drained), it picks one pending operation or timer to complete. In the default order, operations complete in the order they were called — that's the schedule your plain test already covers.
3. **It explores the others.** First it enumerates every ordering depth-first. If the space is too large for the budget, it switches to seeded sampling: uniform random choices alternating with [PCT](https://www.microsoft.com/en-us/research/publication/a-randomized-scheduler-with-probabilistic-guarantees-of-finding-bugs/) (probabilistic concurrency testing), which finds bugs where one task has to stall for a long time — the ones uniform random almost never hits. When enumeration finishes without a failure, `explore` tells you so (`{ complete: true }`) — that's a proof, not a sample.
4. **It shrinks failures.** The failing schedule is minimized to the fewest out-of-order steps, so the timeline shows the cause, not noise. Steps marked `⚡ overtook N earlier pending ops` are where reality diverged from the happy path.
5. **It replays.** The `replay` token (`seed:choices`) re-runs exactly that schedule, deterministically.

**Network round trips.** By default an operation runs and returns in one step. With `{ network: true }` it becomes two: the implementation *executes* (`⚙ db.load(1) executed`) and, at a later point, the *response arrives*. That exposes a whole extra class of bugs — e.g. a read that executes before a write but whose response lands after the cache was invalidated. `sim.mockFetch` uses this mode by default.

Time is virtual. `sim.sleep(30_000)` takes microseconds, timers fire in deadline order, and an operation may complete before *or after* any timer — which is exactly how timeouts race in production. With `patchGlobals: true`, unmodified code that uses `setTimeout`, `setInterval`, `setImmediate`, `Date` and `Math.random` runs on the virtual clock too.

## API

### `explore(body, options?) → Promise<{ schedules, complete, strategy }>`

Runs `body(sim)` once per schedule. **Create your fakes inside `body`** — every schedule gets a fresh world. Rejects with a `RaceError` on the first failing schedule (an assertion, a thrown error, an unhandled rejection, a deadlock, or a runaway loop).

| Option | Default | |
|---|---|---|
| `runs` | `1000` | Maximum schedules to try |
| `strategy` | `'auto'` | `'exhaustive'`, `'random'`, `'pct'`, or `'auto'` (exhaustive for half the budget, then alternating random and PCT) |
| `pctDepth` | `3` | Max bug depth (number of ordering constraints) PCT targets |
| `seed` | `1` | Base seed (`RACELOOM_SEED` env var overrides the default) |
| `replay` | — | Re-run one schedule from a `RaceError`'s token |
| `patchGlobals` | `false` | Virtualize `setTimeout`/`setInterval`/`setImmediate`/`Date`/`Math.random` |
| `unhandledRejections` | `true` | Fail when a wrapped operation rejects and nothing ever handles it (e.g. a fire-and-forget `send()` that only fails in some orderings) |
| `shrink` | `true` | Minimize failing schedules (`shrinkRuns`: budget, default 500) |
| `maxSteps` | `10000` | Fail a schedule that takes more scheduling steps than this |
| `timeLimit` | — | Stop exploring after N ms of real time |

### The `sim` object

| | |
|---|---|
| `sim.wrap(name, obj, { network? })` | Proxy every method of `obj`; each call is a schedulable op labelled `name.method(args)` |
| `sim.fn(name, impl, { network? })` | Same for a single function |
| `sim.mockFetch(handler, { global? })` | A `fetch` whose requests are schedulable ops (`fetch GET /search?q=r`). `handler(request)` returns a `Response`, string or JSON value. `global: true` swaps `globalThis.fetch` for the schedule |
| `sim.go(name, fn)` | Run `fn` as a named task — the name appears in the timeline |
| `sim.sleep(ms)` / `sim.setTimeout` / `sim.setInterval` / `sim.clear*` | Virtual timers |
| `sim.yield(label?)` | An explicit preemption point inside synchronous-looking code |
| `sim.now()` / `sim.random()` | Virtual clock and seeded randomness |
| `sim.log(...)` | Add a note to the timeline |

### `RaceError`

`err.cause` is your original error. Also: `err.replay`, `err.trace` (structured timeline events), `err.decisions`, `err.seed`, `err.schedule`.

## FAQ

**Which async operations get reordered?** Only the ones you route through `sim` (wrapped fakes, virtual timers, `sim.yield`). Ordinary `await`s of already-resolved promises stay where they are — those can't race. This keeps the search space small and the timelines readable.

**Can my fakes do real I/O?** They can, but the result depends on real timing, so a schedule is no longer perfectly reproducible. Prefer in-memory fakes — that's what makes `replay` exact.

**How is this different from fast-check's scheduler?** Same family of idea. raceloom is a focused tool for one job: zero-config exhaustive enumeration (with a completeness answer), automatic shrinking, task-labelled timelines, virtual time for timeouts, and drop-in use in any test runner.

**Is it fast?** Roughly 10,000 schedules per second for small tests: all 5,040 orderings of 7 concurrent operations are explored (and proven race-free) in about 0.4 s on a single core. The examples above find, shrink and report their bug in 10–20 ms.

**Which test runners?** Tested with `node:test`, vitest and jest. raceloom is ESM-only, so jest needs its ESM mode (`NODE_OPTIONS=--experimental-vm-modules jest`).

**Caveats.** `patchGlobals` swaps process-wide globals, so don't run those tests concurrently in the same worker. Exhaustive search grows factorially with the number of *concurrently* pending operations — keep each test focused on 2–4 racing actors, which is where real bugs live.

## Roadmap

- [ ] Partial-order reduction (skip orderings of independent operations) for much larger exhaustive searches
- [x] PCT strategy (probabilistic concurrency testing) for deep bugs in big state spaces
- [x] Two-phase operations (`{ network: true }`: request executes, response arrives later)
- [x] `sim.mockFetch` so code that calls `fetch` can be tested with zero glue
- [x] Unhandled-rejection detection inside schedules
- [ ] Browser build
- [x] Python / asyncio port
- [ ] Trio and AnyIO support for the Python port

Ideas and bug reports welcome — especially real-world races that raceloom should (or can't yet) catch.

## License

[MIT](LICENSE)
