import { Sim, taskStore } from './sim.js';
import { createRng } from './rng.js';
import { formatTrace, formatError } from './format.js';

const realSetImmediate = globalThis.setImmediate;
// Macrotask boundary: by the time it fires, every pending microtask has run.
const quiesce = () => new Promise((r) => realSetImmediate(r));

export class RaceError extends Error {
  constructor(info) {
    super(renderMessage(info), { cause: info.error });
    this.name = 'RaceError';
    // Non-enumerable so test runners don't dump them next to the nicely formatted message.
    for (const [k, v] of Object.entries(info)) Object.defineProperty(this, k, { value: v, enumerable: false });
    // Point the stack at the user's failing line, not at raceloom internals.
    const frames = info.error instanceof Error && typeof info.error.stack === 'string' ? info.error.stack.split('\n').filter((l) => /^\s+at /.test(l)) : [];
    if (frames.length) this.stack = `${this.name}: ${this.message}\n${frames.join('\n')}`;
  }
}

class DeadlockError extends Error {
  constructor() {
    super('deadlock — the test body never finished, and nothing is left to run. Either a promise is awaited that nothing will ever resolve, or the body awaited real I/O / a real timer that raceloom cannot see (route it through sim.fn / sim.sleep, or use patchGlobals).');
    this.name = 'Deadlock';
  }
}

function renderMessage({ error, schedule, strategy, seed, replay, trace, decisions }) {
  const k = decisions.filter((d) => d !== 0).length;
  const where = schedule ? `on schedule #${schedule} (${strategy}, seed ${seed})` : `while replaying ${JSON.stringify(replay)}`;
  return [
    formatError(error, { lines: 3 }),
    '',
    `raceloom found a failing interleaving ${where}.`,
    k === 0 ? 'It fails even in the default order (no reordering needed).' : `Minimal reproduction: ${k} out-of-order ${k === 1 ? 'step' : 'steps'}.`,
    '',
    formatTrace(trace, { color: !!process.stdout?.isTTY && !process.env.NO_COLOR }),
    '',
    `Replay exactly: explore(fn, { replay: ${JSON.stringify(replay)} })`,
  ].join('\n');
}

/** Execute the body once, letting `decide` pick at every point where more than one thing can run. */
async function runSchedule(body, { seed, decide, maxSteps, patchGlobals }) {
  const sim = new Sim({ seed });
  const decisions = [];
  const sizes = [];
  let settled = false;
  let error = null;
  const restore = patchGlobals ? sim._installGlobals() : null;
  try {
    Promise.resolve()
      .then(() => taskStore.run('main', () => body(sim)))
      .then(
        () => (settled = true),
        (e) => {
          settled = true;
          error ??= e;
        },
      );
    let steps = 0;
    for (;;) {
      await quiesce();
      if (sim._uncaught) error ??= sim._uncaught;
      if (error) break;
      const choices = sim._choices();
      if (settled && choices.every((c) => c.repeat)) break; // only leftover intervals
      if (choices.length === 0) {
        if (sim._inflight.size) {
          await Promise.race(sim._inflight);
          continue;
        }
        break;
      }
      if (++steps > maxSteps) {
        error = new Error(`exceeded maxSteps (${maxSteps}) — an infinite loop, or a setInterval that is never cleared?`);
        break;
      }
      let k = 0;
      if (choices.length > 1) {
        k = Math.min(decide(decisions.length, choices.length), choices.length - 1);
        decisions.push(k);
        sizes.push(choices.length);
      }
      sim._fire(choices[k], k);
    }
    if (!error && !settled) error = new DeadlockError();
  } finally {
    sim._active = false;
    restore?.();
  }
  return { error, decisions, sizes, trace: sim._trace };
}

const replayDecider = (prefix) => (i) => (i < prefix.length ? prefix[i] : 0);

function parseReplay(token) {
  const m = /^(\d+):([\d.]*)$/.exec(String(token).trim());
  if (!m) throw new TypeError(`raceloom: invalid replay token ${JSON.stringify(token)} (expected "seed:choices", e.g. "1:0.2.1")`);
  return { seed: Number(m[1]), decisions: m[2] ? m[2].split('.').map(Number) : [] };
}

const toReplay = (seed, decisions) => {
  const d = decisions.slice();
  while (d.length && d[d.length - 1] === 0) d.pop();
  return `${seed}:${d.join('.')}`;
};

async function shrink(body, seed, decisions, opts) {
  let budget = opts.shrinkRuns;
  const fails = async (prefix) => {
    if (budget-- <= 0) return false;
    return (await runSchedule(body, { ...opts, seed, decide: replayDecider(prefix) })).error != null;
  };
  let best = decisions;
  // 1. Shortest failing prefix (everything after it falls back to the default order).
  for (let len = 0; len < best.length; len++) {
    if (await fails(best.slice(0, len))) {
      best = best.slice(0, len);
      break;
    }
  }
  // 2. Drop individual reorderings, then try to make the remaining ones smaller.
  for (let i = 0; i < best.length; i++) {
    for (let v = 0; v < best[i]; v++) {
      const cand = best.slice();
      cand[i] = v;
      if (await fails(cand)) {
        best = cand;
        break;
      }
    }
  }
  return best;
}

/**
 * Run `body` under many different interleavings of its simulated async operations.
 * Throws a RaceError (with a readable timeline and replay token) on the first failure.
 */
export async function explore(body, options = {}) {
  if (typeof body !== 'function') throw new TypeError('raceloom: explore(body) expects a function');
  const envSeed = process.env.RACELOOM_SEED;
  const opts = {
    runs: 1000,
    strategy: 'auto',
    seed: envSeed != null ? Number(envSeed) : 1,
    shrink: true,
    shrinkRuns: 500,
    maxSteps: 10_000,
    patchGlobals: false,
    replay: undefined,
    timeLimit: undefined,
    ...options,
  };
  if (!['auto', 'exhaustive', 'random'].includes(opts.strategy)) {
    throw new TypeError(`raceloom: unknown strategy ${JSON.stringify(opts.strategy)}`);
  }
  const runOpts = { maxSteps: opts.maxSteps, patchGlobals: opts.patchGlobals, shrinkRuns: opts.shrinkRuns };

  const fail = (info) => {
    throw new RaceError({ ...info, replay: toReplay(info.seed, info.decisions) });
  };

  if (opts.replay != null) {
    const { seed, decisions } = parseReplay(opts.replay);
    const r = await runSchedule(body, { ...runOpts, seed, decide: replayDecider(decisions) });
    if (r.error) fail({ ...r, seed, strategy: 'replay', schedule: 0 });
    return { schedules: 1, complete: false, strategy: 'replay' };
  }

  const deadline = opts.timeLimit ? Date.now() + opts.timeLimit : Infinity;
  const exhaustiveBudget = opts.strategy === 'exhaustive' ? opts.runs : opts.strategy === 'auto' ? Math.ceil(opts.runs / 2) : 0;
  let schedules = 0;

  const onFailure = async (r, seed, strategy) => {
    let decisions = r.decisions;
    let final = r;
    if (opts.shrink) {
      decisions = await shrink(body, seed, r.decisions, runOpts);
      final = await runSchedule(body, { ...runOpts, seed, decide: replayDecider(decisions) });
      if (!final.error) [final, decisions] = [r, r.decisions]; // flaky body: keep the original
    }
    fail({ error: final.error, trace: final.trace, decisions, seed, strategy, schedule: schedules });
  };

  // Phase 1: systematic depth-first enumeration of every interleaving.
  let prefix = [];
  let complete = false;
  while (schedules < exhaustiveBudget && Date.now() < deadline) {
    schedules++;
    const r = await runSchedule(body, { ...runOpts, seed: opts.seed, decide: replayDecider(prefix) });
    if (r.error) await onFailure(r, opts.seed, 'exhaustive');
    let i = r.decisions.length - 1;
    while (i >= 0 && r.decisions[i] >= r.sizes[i] - 1) i--;
    if (i < 0) {
      complete = true;
      break;
    }
    prefix = [...r.decisions.slice(0, i), r.decisions[i] + 1];
  }
  if (complete) return { schedules, complete: true, strategy: 'exhaustive' };

  // Phase 2: seeded random sampling for spaces too large to enumerate.
  const base = opts.seed;
  while (schedules < opts.runs && Date.now() < deadline) {
    const seed = base + schedules;
    schedules++;
    const rng = createRng(seed ^ 0x9e3779b9);
    const r = await runSchedule(body, { ...runOpts, seed, decide: (_, n) => rng.int(n) });
    if (r.error) await onFailure(r, seed, 'random');
  }
  return { schedules, complete: false, strategy: opts.strategy };
}
