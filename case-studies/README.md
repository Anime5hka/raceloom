# Case studies: raceloom vs. real libraries

Small scenarios run against unmodified, popular async libraries. Each one asks the same kind of question: *if these two things overlap, is there any ordering where the result is wrong?*

| Library | Scenario | Result |
|---|---|---|
| [`lru-cache`](https://www.npmjs.com/package/lru-cache) 11.5.3 (JS) | `cache.fetch(k)` is in flight, a writer saves a new row and calls `cache.delete(k)` | ✅ **Safe in every ordering.** All 15 schedules enumerated (`complete: true`) — lru-cache discards a fetch result that lands after a delete. |
| [`async-lru`](https://pypi.org/project/async-lru/) 2.4.0 (Python) | `get(k)` in flight, writer calls `get.cache_invalidate(k)` | ✅ **Safe in every ordering.** |
| [`aiolimiter`](https://pypi.org/project/aiolimiter/) 1.3.0 (Python) | 6 clients, 2 of them cancel via `wait_for` timeouts, limiter 2/s | ✅ No bucket overflow and no lost wake-ups in 3000 schedules. |
| [`aiocache`](https://pypi.org/project/aiocache/) 0.12.3 (Python) | `@cached` call in flight, writer updates the DB and calls `cache.delete(k)` | ⚠️ **Stale value cached.** Found on schedule #2, see below. |

The aiocache result is not a bug in the sense of "the code is wrong" — `@cached` is a plain cache-aside decorator and this is the classic cache-aside race. But it's exactly the kind of thing that's invisible in a normal test and shows up in production as "users sometimes see old data until the TTL expires". `lru-cache` and `async-lru` close the window; `@cached` doesn't:

```
AssertionError: cache serves stale 'v1' after invalidation

raceloom found a failing interleaving on schedule #2 (exhaustive, seed 1).
Minimal reproduction: 1 out-of-order step.

1  reader │ → db.get('alice')
2  writer │ → db.put('alice', 'v2')
3  reader │ ⚙ db.get('alice') executed
4  writer │ ⚙ db.put('alice', 'v2') executed
5  writer │ ← db.put('alice', 'v2')   ⚡ overtook 1 earlier pending op
6  reader │ ← db.get('alice') = 'v1'

Replay exactly: explore(fn, replay="1:0.0.1")
```

Read it as: the reader's query ran on the database *before* the write, but its response arrived *after* the writer had already invalidated the cache — so the old row was written back into the cache.

## Running them

```sh
# JavaScript (from the repo root)
npm install --no-save lru-cache && node case-studies/lru-cache-fetch-vs-delete.mjs

# Python
pip install ./python async-lru aiocache aiolimiter
python case-studies/async_lru_invalidate.py
python case-studies/aiolimiter_window.py
python case-studies/aiocache_cached_vs_delete.py   # fails on purpose
```

These are not part of the test suite (they depend on third-party packages and their versions).
