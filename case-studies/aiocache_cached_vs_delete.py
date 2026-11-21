import asyncio
from aiocache import cached, SimpleMemoryCache
from raceloom import explore

class DB:
    def __init__(self): self.rows = {"alice": "v1"}
    def get(self, k): return self.rows[k]
    def put(self, k, v): self.rows[k] = v

async def scenario(sim):
    db = sim.wrap("db", DB(), network=True)
    @cached(cache=SimpleMemoryCache, key_builder=lambda f, k: k)
    async def get_user(k):
        return await db.get(k)
    async def reader():
        await get_user("alice")
    async def writer():
        await db.put("alice", "v2")
        await get_user.cache.delete("alice")
    async with asyncio.TaskGroup() as tg:
        tg.create_task(reader(), name="reader")
        tg.create_task(writer(), name="writer")
    v = await get_user("alice")
    assert v == "v2", f"cache serves stale {v!r} after invalidation"

explore(scenario)  # raises RaceError with the timeline below
