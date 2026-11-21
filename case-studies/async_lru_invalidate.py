import asyncio
from async_lru import alru_cache
from raceloom import explore

async def scenario(sim):
    rows = {1: "old"}
    class Db:
        async def load(self, k): return rows[k]
        async def save(self, k, v): rows[k] = v
    db = sim.wrap("db", Db(), network=True)

    @alru_cache(maxsize=32)
    async def get(k):
        return await db.load(k)

    async def write():
        await db.save(1, "new")
        get.cache_invalidate(1)

    async with asyncio.TaskGroup() as tg:
        tg.create_task(get(1), name="reader")
        tg.create_task(write(), name="writer")
    assert await get(1) == "new", "stale value cached after invalidation"

explore(scenario)
print("no race found")
