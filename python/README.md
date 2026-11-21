# raceloom for Python (asyncio) 🧶

**Find race conditions in asyncio code before your users do.** raceloom re-runs your test under every ordering of its `await`s, shrinks the failure to the one reordering that matters, and prints exactly what happened.

```sh
pip install raceloom   # zero dependencies, Python 3.11+
```

```python
import asyncio
from raceloom import explore

def test_search_box_shows_latest_results():          # a plain (sync) pytest test
    async def scenario(sim):
        api = sim.wrap("api", FakeSearchApi())       # every call becomes a schedulable operation
        box = SearchBox(api)                         # your real code
        async with asyncio.TaskGroup() as tg:
            tg.create_task(box.on_input("r"), name="keystroke 1")
            tg.create_task(box.on_input("ra"), name="keystroke 2")
        assert all(r.startswith(box.query) for r in box.results)

    explore(scenario)
```

```
AssertionError: showing ['rust', 'rce'] for 'ra'

raceloom found a failing interleaving on schedule #2 (exhaustive, seed 1).
Minimal reproduction: 1 out-of-order step.

1  keystroke 1 │ → api.search('r')
2  keystroke 2 │ → api.search('ra')
3  keystroke 2 │ ← api.search('ra') = ['raust', 'race']   ⚡ overtook 1 earlier pending op
4  keystroke 1 │ ← api.search('r') = ['rust', 'rce']

Replay exactly: explore(fn, replay="1:1")
```

## How it differs from the JavaScript version

The engine is the same (exhaustive enumeration → random + PCT sampling, shrinking, replay tokens). The Python version runs each schedule on its own event loop whose clock is virtual, so **every asyncio timer is simulated automatically**: `asyncio.sleep`, `wait_for`, `asyncio.timeout` — no patching. An hour of `sleep` takes microseconds, and timeouts race against your operations in both directions.

| | |
|---|---|
| `explore(body, *, runs=1000, strategy="auto", seed=None, replay=None, shrink=True, max_steps=10000, pct_depth=3, time_limit=None)` | Synchronous; call it from a normal test (inside async code: `await asyncio.to_thread(explore, body)`). Raises `RaceError` (an `AssertionError`) whose `__cause__` is your original error. |
| `sim.wrap(name, obj, network=False)` | Proxy every public method; sync and async methods both become awaitable operations. |
| `sim.fn(name, impl, network=False)` | The same for one function. |
| `network=True` | Two scheduling points per call: the implementation executes, then the response arrives later. |
| `sim.checkpoint(label)` | An explicit preemption point. |
| `sim.random` / `sim.now()` / `sim.log(...)` | Seeded `random.Random`, virtual time, notes in the timeline. |

Task names (`create_task(..., name=...)`, `TaskGroup.create_task(..., name=...)`) label the timeline. Detected failures: assertion/exception in the body, deadlocks, runaway loops, exceptions in callbacks, and errors in tasks nobody awaited.

Requires CPython's default asyncio event loop (not uvloop). Full docs, examples and the JS version: see the [main README](https://github.com/Anime5hka/raceloom#readme).
