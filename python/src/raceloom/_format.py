from __future__ import annotations

import reprlib
from dataclasses import dataclass

_repr = reprlib.Repr()
_repr.maxstring = 40
_repr.maxother = 60
_repr.maxlist = _repr.maxtuple = _repr.maxdict = _repr.maxset = 5
_repr.maxlevel = 3

MAX = 60


def format_value(v: object) -> str:
    try:
        s = _repr.repr(v)
    except Exception:  # pragma: no cover - exotic __repr__
        s = object.__repr__(v)
    return s if len(s) <= MAX else s[: MAX - 1] + "…"


def format_error(e: BaseException) -> str:
    msg = str(e).strip().splitlines()
    return f"{type(e).__name__}: {msg[0]}" if msg else type(e).__name__


@dataclass
class Event:
    type: str  # call | exec | return | raise | timer | checkpoint | log | error
    task: str
    label: str = ""
    value: str | None = None
    at: float | None = None
    overtook: int = 0


def _describe(ev: Event) -> str:
    if ev.type == "call":
        return f"→ {ev.label}"
    if ev.type == "exec":
        return f"⚙ {ev.label} executed"
    if ev.type == "return":
        return f"← {ev.label}" + ("" if ev.value == "None" else f" = {ev.value}")
    if ev.type == "raise":
        return f"✗ {ev.label} raised {ev.value}"
    if ev.type == "timer":
        return f"⏰ {ev.label} fired  @ t={ev.at:g}s"
    if ev.type == "checkpoint":
        return f"↷ {ev.label}"
    if ev.type == "log":
        return f"• {ev.label}"
    if ev.type == "error":
        return f"💥 {ev.value}"
    return ev.label


def format_trace(trace: list[Event], color: bool = False) -> str:
    if not trace:
        return "(no simulated operations ran)"
    width = min(24, max(4, *(len(e.task) for e in trace)))
    num = len(str(len(trace)))
    lines = []
    for i, ev in enumerate(trace, 1):
        task = ev.task if len(ev.task) <= width else ev.task[: width - 1] + "…"
        line = f"{str(i).rjust(num)}  {task.ljust(width)} │ {_describe(ev)}"
        if ev.overtook:
            n = ev.overtook
            line += f"   ⚡ overtook {n} earlier pending {'op' if n == 1 else 'ops'}"
            if color:
                line = f"\x1b[33m{line}\x1b[39m"
        lines.append(line)
    return "\n".join(lines)
