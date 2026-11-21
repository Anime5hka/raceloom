from __future__ import annotations

import asyncio
import inspect
import os
import random
import re
import sys
import time
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Literal

from ._format import Event, format_error, format_trace
from ._sim import Sim, SimLoop, _Choice

Body = Callable[[Sim], Awaitable[Any]]
Decider = Callable[[int, int, list[_Choice]], int]


@dataclass
class ExploreResult:
    schedules: int
    complete: bool
    strategy: str


class RaceError(AssertionError):
    """A schedule failed. ``__cause__`` is the original error."""

    def __init__(
        self,
        error: BaseException,
        *,
        trace: list[Event],
        decisions: list[int],
        seed: int,
        strategy: str,
        schedule: int,
    ) -> None:
        self.error = error
        self.trace = trace
        self.decisions = decisions
        self.seed = seed
        self.strategy = strategy
        self.schedule = schedule
        self.replay = _to_replay(seed, decisions)
        super().__init__(self._render())

    def _render(self) -> str:
        k = sum(1 for d in self.decisions if d)
        where = (
            f"on schedule #{self.schedule} ({self.strategy}, seed {self.seed})"
            if self.schedule
            else f"while replaying {self.replay!r}"
        )
        color = sys.stdout.isatty() and not os.environ.get("NO_COLOR")
        return "\n".join(
            [
                format_error(self.error),
                "",
                f"raceloom found a failing interleaving {where}.",
                "It fails even in the default order (no reordering needed)."
                if k == 0
                else f"Minimal reproduction: {k} out-of-order {'step' if k == 1 else 'steps'}.",
                "",
                format_trace(self.trace, color=color),
                "",
                f'Replay exactly: explore(fn, replay="{self.replay}")',
            ]
        )


@dataclass
class _Run:
    error: BaseException | None
    decisions: list[int]
    sizes: list[int]
    trace: list[Event]


def _run_schedule(body: Body, seed: int, decide: Decider, max_steps: int) -> _Run:
    sim = Sim(seed, decide, max_steps)
    loop = SimLoop(sim)
    loop.set_task_factory(sim._task_factory)
    loop.set_exception_handler(sim._exception_handler)
    try:

        async def main() -> None:
            result = body(sim)
            if inspect.isawaitable(result):
                await result

        sim.main = asyncio.Task(main(), loop=loop, name="main")
        loop.run_forever()
        main_task = sim.main
        if sim.error is None and main_task.done() and not main_task.cancelled() and main_task.exception():
            sim.error = main_task.exception()
        elif sim.error is None and not main_task.done():
            sim.error = RuntimeError("raceloom: event loop stopped before the test body finished")
        sim._collect_unretrieved()
        if main_task.done() and not main_task.cancelled():
            main_task.exception()  # mark retrieved
        _shutdown(loop, sim)
    finally:
        loop.close()
    return _Run(sim.error, sim.decisions, sim.sizes, sim.trace)


def _shutdown(loop: SimLoop, sim: Sim) -> None:
    """Cancel whatever is still running, like asyncio.run() does, without letting it affect the result."""
    sim.closing = True
    leftovers = [t for t in asyncio.all_tasks(loop) if not t.done()]
    for t in leftovers:
        t.cancel()
    for f in sim._ops:
        if not f.done():
            f.cancel()
    if leftovers:
        try:
            loop.run_until_complete(asyncio.gather(*leftovers, return_exceptions=True))
        except RuntimeError:
            pass  # a task refused to finish after cancellation; the schedule is over anyway


def _replay_decider(prefix: list[int]) -> Decider:
    return lambda i, n, choices: prefix[i] if i < len(prefix) else 0


def _pct_decider(rng: random.Random, steps: int, max_depth: int) -> Decider:
    """PCT (Burckhardt et al., ASPLOS 2010) with a per-run random depth in 1..max_depth."""
    priority: dict[str, float] = {}
    depth = 1 + rng.randrange(max_depth)
    change_points = {rng.randrange(steps) for _ in range(depth - 1)}
    low = [0.0]

    def prio(task: str) -> float:
        if task not in priority:
            priority[task] = 1 + rng.random()
        return priority[task]

    def best(choices: list[_Choice]) -> int:
        b = 0
        for j in range(1, len(choices)):
            if prio(choices[j].task) > prio(choices[b].task):
                b = j
        return b

    def decide(i: int, n: int, choices: list[_Choice]) -> int:
        b = best(choices)
        if i in change_points:
            low[0] -= 1
            priority[choices[b].task] = low[0]
            b = best(choices)
        return b

    return decide


def _to_replay(seed: int, decisions: list[int]) -> str:
    d = list(decisions)
    while d and d[-1] == 0:
        d.pop()
    return f"{seed}:{'.'.join(map(str, d))}"


def _parse_replay(token: str) -> tuple[int, list[int]]:
    m = re.fullmatch(r"(\d+):([\d.]*)", str(token).strip())
    if not m:
        raise ValueError(f'raceloom: invalid replay token {token!r} (expected "seed:choices", e.g. "1:0.2.1")')
    return int(m.group(1)), [int(x) for x in m.group(2).split(".") if x]


def _shrink(body: Body, seed: int, decisions: list[int], original: BaseException, max_steps: int, budget: int) -> list[int]:
    kind = type(original)
    left = [budget]

    def fails(prefix: list[int]) -> bool:
        if left[0] <= 0:
            return False
        left[0] -= 1
        err = _run_schedule(body, seed, _replay_decider(prefix), max_steps).error
        return err is not None and type(err) is kind

    best = decisions
    for length in range(len(best)):
        if fails(best[:length]):
            best = best[:length]
            break
    for i in range(len(best)):
        for v in range(best[i]):
            cand = list(best)
            cand[i] = v
            if fails(cand):
                best = cand
                break
    return best


def explore(
    body: Body,
    *,
    runs: int = 1000,
    strategy: Literal["auto", "exhaustive", "random", "pct"] = "auto",
    seed: int | None = None,
    replay: str | None = None,
    shrink: bool = True,
    shrink_runs: int = 500,
    max_steps: int = 10_000,
    pct_depth: int = 3,
    time_limit: float | None = None,
) -> ExploreResult:
    """Run ``body(sim)`` under many interleavings of its simulated async operations.

    Returns stats when every schedule passes; raises :class:`RaceError` on the first failure.
    """
    if not callable(body):
        raise TypeError("raceloom: explore(body) expects an async function")
    if strategy not in ("auto", "exhaustive", "random", "pct"):
        raise ValueError(f"raceloom: unknown strategy {strategy!r}")
    if seed is None:
        seed = int(os.environ.get("RACELOOM_SEED", "1"))
    seed = seed & 0xFFFFFFFF

    def fail(run: _Run, run_seed: int, strat: str, schedule: int) -> None:
        decisions, final = run.decisions, run
        if shrink and run.error is not None:
            decisions = _shrink(body, run_seed, run.decisions, run.error, max_steps, shrink_runs)
            final = _run_schedule(body, run_seed, _replay_decider(decisions), max_steps)
            if final.error is None:  # flaky body: keep the original
                final, decisions = run, run.decisions
        assert final.error is not None
        raise RaceError(
            final.error, trace=final.trace, decisions=decisions, seed=run_seed, strategy=strat, schedule=schedule
        ) from final.error

    if replay is not None:
        rseed, rdecisions = _parse_replay(replay)
        run = _run_schedule(body, rseed, _replay_decider(rdecisions), max_steps)
        if run.error is not None:
            raise RaceError(
                run.error, trace=run.trace, decisions=rdecisions, seed=rseed, strategy="replay", schedule=0
            ) from run.error
        return ExploreResult(1, False, "replay")

    deadline = time.monotonic() + time_limit if time_limit else float("inf")
    budget = runs if strategy == "exhaustive" else (runs + 1) // 2 if strategy == "auto" else 0
    schedules = 0

    # Phase 1: depth-first enumeration of every interleaving.
    prefix: list[int] = []
    while schedules < budget and time.monotonic() < deadline:
        schedules += 1
        run = _run_schedule(body, seed, _replay_decider(prefix), max_steps)
        if run.error is not None:
            fail(run, seed, "exhaustive", schedules)
        i = len(run.decisions) - 1
        while i >= 0 and run.decisions[i] >= run.sizes[i] - 1:
            i -= 1
        if i < 0:
            return ExploreResult(schedules, True, "exhaustive")
        prefix = run.decisions[:i] + [run.decisions[i] + 1]

    # Phase 2: seeded sampling; `auto` alternates uniform random with PCT.
    depth_hint = 8
    while schedules < runs and time.monotonic() < deadline:
        run_seed = (seed + schedules) & 0xFFFFFFFF
        use_pct = strategy == "pct" or (strategy == "auto" and schedules % 2 == 1)
        schedules += 1
        rng = random.Random(run_seed ^ 0x9E3779B9)
        decide: Decider = (
            _pct_decider(rng, depth_hint, pct_depth) if use_pct else (lambda i, n, c, rng=rng: rng.randrange(n))
        )
        run = _run_schedule(body, run_seed, decide, max_steps)
        depth_hint = max(depth_hint, len(run.decisions))
        if run.error is not None:
            fail(run, run_seed, "pct" if use_pct else "random", schedules)
    return ExploreResult(schedules, False, strategy)
