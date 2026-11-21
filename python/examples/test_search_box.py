"""The classic "stale response" race: type "r", then "ra". If the response for "r"
arrives last, the UI shows results for the wrong query. A plain test passes; raceloom doesn't."""
import asyncio

from raceloom import explore


class SearchBox:
    def __init__(self, api):
        self.api, self.query, self.results = api, "", []

    async def on_input(self, query):
        self.query = query
        self.results = await self.api.search(query)  # BUG: no check that this is still the latest query


class FakeSearchApi:
    async def search(self, q):
        return [f"{q}ust", f"{q}ce"]


def test_search_box_shows_results_for_the_latest_query():
    async def scenario(sim):
        box = SearchBox(sim.wrap("api", FakeSearchApi()))
        async with asyncio.TaskGroup() as tg:
            tg.create_task(box.on_input("r"), name="keystroke 1")
            tg.create_task(box.on_input("ra"), name="keystroke 2")
        assert all(r.startswith(box.query) for r in box.results), f"showing {box.results} for {box.query!r}"

    explore(scenario)
