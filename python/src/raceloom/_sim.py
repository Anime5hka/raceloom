from __future__ import annotations

import asyncio
import functools
import inspect
import random
import time
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

from ._format import Event, format_error, format_value


class Deadlock(Exception):
    """The body never finished and nothing was left to run."""


class StepLimitExceeded(Exception):
    """A schedule took more scheduling steps than ``max_steps``."""


class UnhandledTaskError(Exception):
    """A task (or fire-and-forget operation) failed and nobody ever retrieved the error."""


@dataclass(eq=False)
class _Choice:
    kind: str  # op | deliver | checkpoint | timer
    label: str
    task: str
    fire: Callable[[int], None] = field(repr=False)
    handle: Any = None  # asyncio.TimerHandle for timers


_SLEEP_CALLBACKS = {"_set_result_unless_cancelled"}
_TIMEOUT_CALLBACKS = {"_release_waiter", "_on_timeout", "_timeout_handle_timeout", "on_timeout"}


def _timer_label(callback: Any, delay: float) -> str:
    name = getattr(callback, "__name__", "") or type(callback).__name__
    inner = getattr(callback, "__func__", None)
    if inner is not None:
        name = inner.__name__
    if name in _SLEEP_CALLBACKS:
        return f"sleep({delay:g})"
    if name in _TIMEOUT_CALLBACKS or "timeout" in name.lower():
        return f"timeout({delay:g})"
    qual = getattr(callback, "__qualname__", name)
    return f"{qual}() after {delay:g}s"


class SimLoop(asyncio.SelectorEventLoop):
    """An event loop on a virtual clock that asks the Sim what to run whenever it is idle."""

    def __init__(self, sim: Sim) -> None:
        super().__init__()
        self._sim = sim
        self._vt = 0.0

    def time(self) -> float:  # every asyncio timer (sleep, wait_for, timeout) is virtual
        return self._vt

    def call_at(self, when, callback, *args, context=None):  # type: ignore[override]
        handle = super().call_at(when, callback, *args, context=context)
        self._sim._timer_meta[handle] = (self._sim._task_name(), _timer_label(callback, when - self._vt))
        return handle

    def _run_once(self) -> None:
        if not self._ready and not self._stopping:
            self._sim._step(self)
        super()._run_once()  # type: ignore[misc]


class Sim:
    """One simulated world. A fresh Sim (and event loop) is created for every schedule."""

    def __init__(self, seed: int, decide: Callable[[int, int, list[_Choice]], int], max_steps: int) -> None:
        self.seed = seed
        self.random = random.Random(seed)
        self._decide = decide
        self._max_steps = max_steps
        self._steps = 0
        self.decisions: list[int] = []
        self.sizes: list[int] = []
        self.trace: list[Event] = []
        self._pending: list[_Choice] = []
        self._timer_meta: dict[Any, tuple[str, str]] = {}
        self._inflight: set[asyncio.Task] = set()
        self._tasks: list[asyncio.Task] = []
        self._ops: list[asyncio.Future] = []
        self._task_names: dict[str, str] = {}
        self._task_counter = 0
        self.main: asyncio.Task | None = None
        self.error: BaseException | None = None
        self.closing = False
        self._internal: set[Any] = set()  # real-time poll timers, invisible to the schedule
        self._waiting_since: float | None = None
        self.real_wait_limit = 10.0

    # ------------------------------------------------------------------ public API

    def fn(self, name: str | Callable[..., Any], impl: Callable[..., Any] | None = None, *, network: bool = False):
        """Wrap a function so every call becomes a schedulable operation."""
        if callable(name):
            name, impl = getattr(name, "__name__", "fn"), name
        impl = impl or _noop

        @functools.wraps(impl)
        def simulated(*args: Any, **kwargs: Any):
            return self._op(_label(name, args, kwargs), lambda: impl(*args, **kwargs), network=network)

        return simulated

    def wrap(self, name: str, obj: Any, *, network: bool = False) -> Any:
        """Proxy every public method of ``obj``; each call is an operation labelled ``name.method(args)``."""
        return _Wrapped(self, name, obj, network)

    async def checkpoint(self, label: str = "checkpoint") -> None:
        """An explicit preemption point: anything else pending may run first."""
        loop = asyncio.get_running_loop()
        fut = loop.create_future()
        task = self._task_name()

        def fire(overtook: int) -> None:
            self.trace.append(Event("checkpoint", task, label, overtook=overtook))
            if not fut.done():
                fut.set_result(None)

        self._pending.append(_Choice("checkpoint", label, task, fire))
        await fut

    def now(self) -> float:
        """Virtual time in seconds since the schedule started (same as ``loop.time()``)."""
        return asyncio.get_running_loop().time()

    def log(self, *parts: Any) -> None:
        """Add a note to the timeline."""
        text = " ".join(p if isinstance(p, str) else format_value(p) for p in parts)
        self.trace.append(Event("log", self._task_name(), text))

    # ------------------------------------------------------------------ internals

    def _task_name(self) -> str:
        try:
            task = asyncio.current_task()
        except RuntimeError:
            task = None
        return task.get_name() if task is not None else "main"

    def _task_factory(self, loop: asyncio.AbstractEventLoop, coro: Any, **kwargs: Any) -> asyncio.Task:
        task = asyncio.Task(coro, loop=loop, **kwargs)
        self._task_counter += 1
        task.set_name(f"task-{self._task_counter}")  # deterministic; create_task(name=...) overrides
        self._tasks.append(task)
        return task

    def _op(self, label: str, run: Callable[[], Any], *, network: bool) -> Awaitable[Any]:
        if self.closing:
            raise RuntimeError("raceloom: this sim has finished. Create fakes inside the explore() body.")
        loop = asyncio.get_running_loop()
        fut: asyncio.Future = loop.create_future()
        self._ops.append(fut)
        task = self._task_name()
        self.trace.append(Event("call", task, label))

        def deliver(ok: bool, value: Any) -> Callable[[int], None]:
            def fire(overtook: int) -> None:
                if fut.done():
                    return
                if ok:
                    self.trace.append(Event("return", task, label, format_value(value), overtook=overtook))
                    fut.set_result(value)
                else:
                    self.trace.append(Event("raise", task, label, format_error(value), overtook=overtook))
                    fut.set_exception(value)

            return fire

        def start(overtook: int) -> None:
            async def execute() -> Any:
                result = run()
                if inspect.isawaitable(result):
                    result = await result
                return result

            runner = loop.create_task(execute(), name=task)
            self._tasks.remove(runner)  # internal; its outcome is reported through `fut`
            self._inflight.add(runner)

            def done(t: asyncio.Task) -> None:
                self._inflight.discard(t)
                if t.cancelled():
                    if not fut.done():
                        fut.cancel()
                    return
                exc = t.exception()
                ok, value = (exc is None), (t.result() if exc is None else exc)
                if network:
                    self.trace.append(Event("exec", task, label, overtook=overtook))
                    self._pending.append(_Choice("deliver", label, task, deliver(ok, value)))
                else:
                    deliver(ok, value)(overtook)

            runner.add_done_callback(done)

        self._pending.append(_Choice("op", label, task, start))

        async def awaiting() -> Any:
            return await fut

        return awaiting()

    def _choices(self, loop: SimLoop) -> list[_Choice]:
        choices = list(self._pending)
        live = [h for h in loop._scheduled if not h.cancelled() and h not in self._internal]  # type: ignore[attr-defined]
        if live:
            h = min(live, key=lambda h: h.when())
            task, label = self._timer_meta.get(h, ("main", "timer"))
            choices.append(_Choice("timer", label, task, lambda overtook, h=h: self._fire_timer(loop, h, overtook), h))
        return choices

    def _fire_timer(self, loop: SimLoop, handle: Any, overtook: int) -> None:
        loop._vt = max(loop._vt, handle.when())
        task, label = self._timer_meta.get(handle, ("main", "timer"))
        self.trace.append(Event("timer", task, label, at=loop._vt, overtook=overtook))

    def _step(self, loop: SimLoop) -> None:
        """Called whenever the loop has nothing ready to run: pick what happens next."""
        if self.closing:
            live = [h for h in loop._scheduled if not h.cancelled() and h not in self._internal]  # type: ignore[attr-defined]
            if live:
                loop._vt = max(loop._vt, min(h.when() for h in live))
            else:
                loop.stop()
            return
        if self.error is not None:
            loop.stop()
            return
        choices = self._choices(loop)
        main_done = self.main is not None and self.main.done()
        if main_done:
            # The test is over: finish fire-and-forget work, but don't run background timers forever.
            choices = [c for c in choices if c.kind != "timer"]
            if not choices and not self._inflight:
                loop.stop()
                return
        if not choices:
            if self._inflight:
                # An implementation is awaiting something outside the simulation (real I/O, a thread).
                # Poll in small real-time slices instead of blocking forever.
                now = time.monotonic()
                self._waiting_since = self._waiting_since or now
                if now - self._waiting_since < self.real_wait_limit:
                    # Never "due" on the virtual clock: it only bounds how long select() blocks.
                    for old in self._internal:
                        old.cancel()
                    self._internal = {loop.call_at(loop._vt + 0.01, _noop_cb)}
                    return
                self.error = Deadlock(
                    f"deadlock — an operation's implementation waited {self.real_wait_limit:g}s of real time on "
                    "something outside the simulation and never finished."
                )
                loop.stop()
                return
            self.error = Deadlock(
                "deadlock — the test body never finished, and nothing is left to run. Either it awaits "
                "something nothing will ever complete, or it awaited real I/O raceloom cannot see "
                "(route it through sim.fn / sim.wrap)."
            )
            loop.stop()
            return
        self._waiting_since = None
        self._steps += 1
        if self._steps > self._max_steps:
            self.error = StepLimitExceeded(
                f"exceeded max_steps ({self._max_steps}) — an infinite loop, or a periodic task that never stops?"
            )
            loop.stop()
            return
        k = 0
        if len(choices) > 1:
            k = min(self._decide(len(self.decisions), len(choices), choices), len(choices) - 1)
            self.decisions.append(k)
            self.sizes.append(len(choices))
        choice = choices[k]
        if choice.kind != "timer":
            self._pending.remove(choice)
        choice.fire(k)

    def _exception_handler(self, loop: asyncio.AbstractEventLoop, context: dict[str, Any]) -> None:
        exc = context.get("exception")
        if exc is None or self.closing:
            return
        self.trace.append(Event("error", self._task_name(), value=f"uncaught {format_error(exc)}"))
        if self.error is None:
            self.error = exc

    def _collect_unretrieved(self) -> None:
        """Errors nobody ever looked at (Python would log them at garbage collection)."""
        for t in self._tasks:
            if t is self.main or not t.done() or t.cancelled():
                continue
            if getattr(t, "_log_traceback", False):
                exc = t.exception()  # marks it retrieved, silencing the GC warning
                self.trace.append(Event("error", t.get_name(), value=f"unhandled error in task {t.get_name()!r}: {format_error(exc)}"))
                if self.error is None:
                    self.error = exc
        for f in self._ops:
            if f.done() and not f.cancelled() and getattr(f, "_log_traceback", False):
                f.exception()


class _Wrapped:
    def __init__(self, sim: Sim, name: str, obj: Any, network: bool) -> None:
        self._sim, self._name, self._obj, self._network = sim, name, obj, network
        self._cache: dict[str, Any] = {}

    def __getattr__(self, attr: str) -> Any:
        value = getattr(self._obj, attr)
        if attr.startswith("_") or not callable(value):
            return value
        if attr not in self._cache:
            self._cache[attr] = self._sim.fn(f"{self._name}.{attr}", value, network=self._network)
        return self._cache[attr]

    def __repr__(self) -> str:
        return f"<raceloom wrapped {self._name}: {self._obj!r}>"


def _noop_cb() -> None:
    return None


async def _noop(*args: Any, **kwargs: Any) -> None:
    return None


def _label(name: str, args: tuple, kwargs: dict) -> str:
    parts = [format_value(a) for a in args] + [f"{k}={format_value(v)}" for k, v in kwargs.items()]
    return f"{name}({', '.join(parts)})"
