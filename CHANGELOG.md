# Changelog

## 0.1.0 (2026-11-21)

First release.

- `explore(body, options)`: run a test under many interleavings of its simulated async operations.
- Strategies: depth-first `exhaustive` enumeration (reports `complete: true` when every ordering was covered), seeded `random`, `pct` (probabilistic concurrency testing), and `auto` (exhaustive, then alternating random and PCT).
- Automatic shrinking to the fewest out-of-order steps, keeping the same kind of failure.
- Readable task-labelled timelines, plus `replay` tokens that reproduce one schedule exactly.
- `sim.wrap`, `sim.fn`, `sim.mockFetch`, `sim.go`, `sim.yield`, `sim.log`.
- `{ network: true }` operations: the request executes and the response arrives as two separate steps.
- Virtual time: `sim.sleep` and friends, plus `patchGlobals` for unmodified `setTimeout`/`setInterval`/`setImmediate`/`Date`/`Math.random` code.
- Detects deadlocks, runaway loops (`maxSteps`), uncaught timer errors and unhandled rejections of simulated operations.
- TypeScript types, zero dependencies, Node ≥ 20. Tested with node:test, vitest and jest.
- **Python / asyncio port** (`python/`, Python ≥ 3.11, zero dependencies): same engine, strategies, shrinking and replay tokens. Each schedule runs on an event loop with a virtual clock, so `asyncio.sleep`, `wait_for` and `asyncio.timeout` are simulated without patching. Detects unretrieved task errors and callback exceptions.
