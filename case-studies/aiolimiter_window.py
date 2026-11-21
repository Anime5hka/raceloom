import asyncio
from aiolimiter import AsyncLimiter
from raceloom import explore

RATE, PERIOD = 2, 1.0

def check(times):
    level, last = 0.0, 0.0
    for t in sorted(times):
        level = max(level - (t - last) * RATE / PERIOD, 0.0); last = t
        level += 1
        assert level <= RATE + 1e-9, f"bucket overflow at t={t}: level {level}; acquisitions {sorted(times)}"

async def scenario(sim):
    lim = AsyncLimiter(RATE, PERIOD)
    times = []
    work = sim.fn("work", lambda i: i)
    async def client(i, timeout):
        await work(i)
        try:
            await asyncio.wait_for(lim.acquire(), timeout)
        except TimeoutError:
            sim.log(f"client {i} gave up"); return
        times.append(sim.now()); sim.log(f"client {i} acquired")
    async with asyncio.TaskGroup() as tg:
        for i, to in enumerate([5, 5, 0.4, 0.6, 5, 5]):
            tg.create_task(client(i, to), name=f"client {i}")
    check(times)
    assert len(times) >= 4, f"only {len(times)} acquired: {times}"

r = explore(scenario, runs=3000)
print(r)
