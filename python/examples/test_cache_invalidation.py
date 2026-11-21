"""Cache-aside with an async cache (think Redis). A reader and a writer race:
   reader: load from db (old value) ....................... cache.set(old)
   writer:            db.save(new) -> cache.delete
The reader's late cache.set re-populates the cache with stale data, forever."""
import asyncio

from raceloom import explore


class UserService:
    def __init__(self, db, cache):
        self.db, self.cache = db, cache

    async def get_user(self, uid):
        if (hit := await self.cache.get(uid)) is not None:
            return hit
        user = await self.db.load(uid)
        await self.cache.set(uid, user)
        return user

    async def rename_user(self, uid, name):
        await self.db.save(uid, {"name": name})
        await self.cache.delete(uid)  # invalidate


class FakeDb:
    def __init__(self):
        self.rows = {1: {"name": "Ada"}}

    async def load(self, uid):
        return self.rows[uid]

    async def save(self, uid, row):
        self.rows[uid] = row


class FakeCache:
    def __init__(self):
        self.entries = {}

    async def get(self, k):
        return self.entries.get(k)

    async def set(self, k, v):
        self.entries[k] = v

    async def delete(self, k):
        self.entries.pop(k, None)


def test_cache_never_serves_stale_data_after_a_rename():
    async def scenario(sim):
        users = UserService(sim.wrap("db", FakeDb()), sim.wrap("cache", FakeCache()))
        async with asyncio.TaskGroup() as tg:
            tg.create_task(users.get_user(1), name="reader")
            tg.create_task(users.rename_user(1, "Grace"), name="writer")
        assert (await users.get_user(1))["name"] == "Grace"

    explore(scenario)
