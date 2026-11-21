import { inspect } from 'node:util';

const MAX = 60;

export function formatValue(v) {
  let s;
  try {
    s = inspect(v, { depth: 2, breakLength: Infinity, maxStringLength: 40, maxArrayLength: 5, compact: true });
  } catch {
    s = String(v);
  }
  return s.length > MAX ? s.slice(0, MAX - 1) + '…' : s;
}

export function formatError(e, { lines = 1 } = {}) {
  if (!(e instanceof Error)) return formatValue(e);
  // node:assert's generated messages are multi-line diffs; summarize them on one line.
  if (e.code === 'ERR_ASSERTION' && e.generatedMessage && 'expected' in e) {
    return `${e.name}: expected ${formatValue(e.expected)}, got ${formatValue(e.actual)}`;
  }
  const msg = e.message
    .split('\n')
    .map((l) => l.trimEnd())
    .filter(Boolean)
    .slice(0, lines)
    .join(' ');
  return `${e.name}: ${msg}`;
}

function describe(ev) {
  const t = ev.at ? `  @ t=${ev.at}ms` : '';
  switch (ev.type) {
    case 'call':
      return `→ ${ev.label}`;
    case 'return':
      return `← ${ev.label}${ev.value === 'undefined' ? '' : ` = ${ev.value}`}`;
    case 'throw':
      return `✗ ${ev.label} threw ${ev.value}`;
    case 'timer':
      return `⏰ ${ev.label} fired${t}`;
    case 'yield':
      return `↷ ${ev.label}`;
    case 'log':
      return `• ${ev.label}`;
    case 'error':
      return `💥 ${ev.value}`;
    default:
      return ev.label;
  }
}

/** Render a trace as an aligned, human-readable timeline. */
export function formatTrace(trace, { color = false } = {}) {
  const width = Math.min(24, Math.max(4, ...trace.map((e) => e.task.length)));
  const num = String(trace.length).length;
  const dim = (s) => (color ? `\x1b[2m${s}\x1b[22m` : s);
  const hot = (s) => (color ? `\x1b[33m${s}\x1b[39m` : s);
  return trace
    .map((ev, i) => {
      const task = ev.task.length > width ? ev.task.slice(0, width - 1) + '…' : ev.task.padEnd(width);
      let line = `${dim(String(i + 1).padStart(num))}  ${task} │ ${describe(ev)}`;
      if (ev.overtook) {
        const n = ev.overtook;
        line = hot(`${line}   ⚡ overtook ${n} earlier pending ${n === 1 ? 'op' : 'ops'}`);
      }
      return line;
    })
    .join('\n');
}
