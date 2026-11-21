import asyncio
import random
import time

import pytest

from raceloom import Deadlock, RaceError, StepLimitExceeded, explore


async def stale_search(sim):
    class Api:
        async def search(self, q):
            return q.upper()

    api = sim.wrap("api", Api())
    ui = {"q": "", "shown": ""}

    async def on_input(q):
        ui["q"] = q
        ui["shown"] = await api.search(q)

    await asyncio.gather(on_input("a"), on_input("ab"))
    assert ui["shown"] == ui["q"].upper()


def test_enumerates_every_ordering_of_independent_ops():
    seen = set()

    async def body(sim):
        order = []
        op = sim.fn("op", lambda x: order.append(x))
        await asyncio.gather(op(1), op(2), op(3))
        seen.add("".join(map(str, order)))

    res = explore(body)
    assert (res.schedules, res.complete, res.strategy) == (6, True, "exhaustive")
    assert seen == {"123", "132", "213", "231", "312", "321"}


def test_sequential_code_has_one_schedule():
    async def body(sim):
        double = sim.fn("double", lambda x: x * 2)
        assert await double(1) == 2
        assert await double(2) == 4

    res = explore(body)
    assert (res.schedules, res.complete) == (1, True)


def test_finds_shrinks_and_replays_a_stale_response():
    with pytest.raises(RaceError) as info:
        explore(stale_search)
    err = info.value
    assert isinstance(err.__cause__, AssertionError)
    assert err.decisions == [1]
    assert err.replay == "1:1"
    assert "overtook 1 earlier pending op" in str(err)
    assert "api.search('ab')" in str(err)
    with pytest.raises(RaceError):
        explore(stale_search, replay=err.replay)
    assert explore(stale_search, replay="1:").strategy == "replay"


def test_random_and_pct_strategies_find_it_too():
    for strategy in ("random", "pct"):
        with pytest.raises(RaceError) as info:
            explore(stale_search, strategy=strategy, runs=50)
        assert sum(1 for d in info.value.decisions if d) == 1


def test_pct_finds_a_long_stall_that_uniform_random_misses():
    async def body(sim):
        op = sim.fn("op")
        state = {"b_done": False}

        async def a():
            await op("a")
            if state["b_done"]:
                raise RuntimeError("A finished last")

        async def b():
            for i in range(16):
                await op(f"b{i}")
            state["b_done"] = True

        async with asyncio.TaskGroup() as tg:
            tg.create_task(a(), name="A")
            tg.create_task(b(), name="B")

    explore(body, strategy="random", runs=100)  # misses (2^-16 per run)
    with pytest.raises(RaceError) as info:
        explore(body, strategy="pct", runs=100)
    assert info.value.strategy == "pct"
    with pytest.raises(RaceError):
        explore(body, replay=info.value.replay)


def test_task_names_label_the_timeline():
    async def body(sim):
        op = sim.fn("op")

        async def worker():
            sim.log("starting", {"n": 1})
            await op()

        await asyncio.create_task(worker(), name="worker-A")
        raise ValueError("done")

    with pytest.raises(RaceError) as info:
        explore(body)
    msg = str(info.value)
    assert "worker-A │ • starting {'n': 1}" in msg
    assert "worker-A │ → op()" in msg


def test_unnamed_tasks_get_deterministic_names():
    names = set()

    async def body(sim):
        await asyncio.create_task(asyncio.sleep(0))
        names.add(asyncio.current_task().get_name())
        t = asyncio.create_task(asyncio.sleep(0))
        names.add(t.get_name())
        await t

    explore(body, runs=3)
    assert names == {"main", "task-2"}  # task-1 was the first create_task


def test_detects_deadlocks():
    async def body(sim):
        await sim.fn("load")()
        await asyncio.Event().wait()

    with pytest.raises(RaceError) as info:
        explore(body)
    assert isinstance(info.value.__cause__, Deadlock)
    assert "never finished" in str(info.value)


def test_op_errors_propagate_and_show_in_trace():
    def boom(x):
        raise KeyError("kaboom")

    async def body(sim):
        await sim.fn("boom", boom)(1)

    with pytest.raises(RaceError) as info:
        explore(body)
    assert isinstance(info.value.__cause__, KeyError)
    assert "✗ boom(1) raised KeyError: 'kaboom'" in str(info.value)


def test_caught_op_errors_are_fine():
    async def body(sim):
        async def boom():
            raise KeyError("x")

        with pytest.raises(KeyError):
            await sim.fn("boom", boom)()

    assert explore(body).complete


def test_nested_ops_are_scheduled():
    orders = set()

    async def body(sim):
        log = []
        inner = sim.fn("inner", lambda x: log.append(x))

        async def outer_impl(x):
            await inner(f"{x}1")
            await inner(f"{x}2")

        outer = sim.fn("outer", outer_impl)
        await asyncio.gather(outer("a"), outer("b"))
        orders.add(" ".join(log))
        assert log.index("a1") < log.index("a2")

    explore(body)
    assert len(orders) > 1


def test_asyncio_time_is_virtual():
    async def body(sim):
        loop = asyncio.get_running_loop()
        fired = []

        async def nap(name, d):
            await asyncio.sleep(d)
            fired.append((name, loop.time()))

        t0 = time.monotonic()
        await asyncio.gather(nap("slow", 3600), nap("fast", 60))
        assert time.monotonic() - t0 < 1, "an hour of virtual sleep must be instant"
        assert fired == [("fast", 60), ("slow", 3600)]
        assert sim.now() == 3600

    assert explore(body).complete


def test_ops_race_against_timeouts_in_both_directions():
    outcomes = set()

    async def body(sim):
        fetch = sim.fn("fetch", lambda: "data")
        try:
            outcomes.add(await asyncio.wait_for(fetch(), timeout=5))
        except TimeoutError:
            outcomes.add("timeout")

    explore(body)
    assert outcomes == {"data", "timeout"}


def test_timer_labels():
    async def body(sim):
        await asyncio.sleep(1.5)
        raise ValueError("x")

    with pytest.raises(RaceError) as info:
        explore(body)
    assert "⏰ sleep(1.5) fired  @ t=1.5s" in str(info.value)


def test_unretrieved_task_errors_fail_the_run():
    async def body(sim):
        class Conn:
            closed = False

            async def send(self, msg):
                if self.closed:
                    raise ConnectionError(f"send after close: {msg}")

            async def close(self):
                self.closed = True

        conn = sim.wrap("conn", Conn())
        asyncio.create_task(conn.send("bye"), name="sender")  # fire-and-forget
        await conn.close()
        await sim.checkpoint()

    with pytest.raises(RaceError) as info:
        explore(body)
    assert isinstance(info.value.__cause__, ConnectionError)
    assert "unhandled error in task 'sender'" in str(info.value)


def test_callback_exceptions_fail_the_run():
    async def body(sim):
        asyncio.get_running_loop().call_soon(lambda: 1 / 0)
        await sim.checkpoint()

    with pytest.raises(RaceError) as info:
        explore(body)
    assert isinstance(info.value.__cause__, ZeroDivisionError)


def test_background_periodic_tasks_do_not_hang():
    async def body(sim):
        async def heartbeat():
            while True:
                await asyncio.sleep(1)

        asyncio.create_task(heartbeat())
        await asyncio.sleep(3)

    assert explore(body).complete


def test_max_steps_stops_runaway_loops():
    async def body(sim):
        while True:
            await sim.checkpoint()

    with pytest.raises(RaceError) as info:
        explore(body, max_steps=50)
    assert isinstance(info.value.__cause__, StepLimitExceeded)


def test_network_mode_splits_execution_and_delivery():
    def scenario(network):
        async def body(sim):
            rows = {1: "old"}
            cache = {}

            class Db:
                async def load(self, k):
                    return rows[k]

                async def save(self, k, v):
                    rows[k] = v

            db = sim.wrap("db", Db(), network=network)

            async def read():
                if 1 in cache:
                    return cache[1]
                v = await db.load(1)
                cache[1] = v
                return v

            async def write():
                await db.save(1, "new")
                cache.pop(1, None)

            async with asyncio.TaskGroup() as tg:
                tg.create_task(read(), name="reader")
                tg.create_task(write(), name="writer")
            assert await read() == "new"

        return body

    assert explore(scenario(False)).complete
    with pytest.raises(RaceError) as info:
        explore(scenario(True))
    assert "reader │ ⚙ db.load(1) executed" in str(info.value)


def test_shrinking_keeps_the_same_failure_kind():
    class LostUpdate(Exception):
        pass

    async def body(sim):
        op = sim.fn("op", lambda x: x)
        order = []

        async def run(x):
            await op(x)
            order.append(x)

        await asyncio.gather(run("a"), run("b"), run("c"))
        o = "".join(order)
        if o == "abc":
            raise TypeError("default order")
        if o == "cba":
            raise LostUpdate(o)

    seed = next(
        s for s in range(200)
        if isinstance(_cause(lambda: explore(body, strategy="random", seed=s, shrink=False)), LostUpdate)
    )
    err = _cause(lambda: explore(body, strategy="random", seed=seed))
    assert isinstance(err, LostUpdate)


def _cause(fn):
    try:
        fn()
    except RaceError as e:
        return e.__cause__
    return None


def test_sim_random_is_seeded():
    def draw(seed):
        out = []

        async def body(sim):
            out.append((sim.random.random(), sim.random.random()))

        explore(body, seed=seed)
        return out[0]

    assert draw(42) == draw(42)
    assert draw(42) != draw(43)


def test_wrap_passes_through_attributes():
    async def body(sim):
        class Store:
            size = 3

            def __init__(self):
                self.items = [1, 2, 3]

            async def first(self):
                return self.items[0]

            def sync_len(self):
                return len(self.items)

        store = sim.wrap("store", Store())
        assert store.size == 3
        assert await store.first() == 1
        assert await store.sync_len() == 3  # sync methods become awaitable operations
        assert store.first is store.first

    explore(body)


def test_ops_work_with_create_task():
    async def body(sim):
        op = sim.fn("op", lambda: 42)
        assert await asyncio.create_task(op()) == 42

    explore(body)


def test_rejects_bad_arguments():
    with pytest.raises(TypeError):
        explore(None)
    with pytest.raises(ValueError, match="unknown strategy"):
        explore(stale_search, strategy="nope")
    with pytest.raises(ValueError, match="invalid replay token"):
        explore(stale_search, replay="garbage")


def test_budget_stops_exhaustive_search():
    async def body(sim):
        op = sim.fn("op")
        await asyncio.gather(*(op() for _ in range(8)))

    res = explore(body, runs=20)
    assert (res.complete, res.schedules) == (False, 20)


def test_does_not_leak_a_running_loop():
    explore(stale_search, replay="1:")
    with pytest.raises(RuntimeError):
        asyncio.get_running_loop()
    assert asyncio.run(asyncio.sleep(0, result=7)) == 7


def test_inside_a_running_loop_gives_a_helpful_error_and_to_thread_works():
    async def outer():
        with pytest.raises(RuntimeError, match="asyncio.to_thread"):
            explore(stale_search)
        with pytest.raises(RaceError):
            await asyncio.to_thread(explore, stale_search)

    asyncio.run(outer())
