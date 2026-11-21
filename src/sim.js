import { AsyncLocalStorage } from 'node:async_hooks';
import { createRng } from './rng.js';
import { formatValue, formatError } from './format.js';

export const taskStore = new AsyncLocalStorage();

/**
 * The promise returned by a simulated operation. It records whether anyone subscribed
 * (then/catch/await/Promise.all all go through `then` for subclasses), so a rejection
 * nobody handles can be reported with a timeline instead of crashing the runner.
 */
class OpPromise extends Promise {
  static get [Symbol.species]() {
    return Promise;
  }
  then(onFulfilled, onRejected) {
    this.handled = true;
    return super.then(onFulfilled, onRejected);
  }
}

function toResponse(v) {
  if (v instanceof Response) return v;
  if (typeof v === 'string') return new Response(v);
  return Response.json(v ?? null);
}

// Virtual wall clock starts here so patched Date looks realistic but stays reproducible.
const EPOCH = Date.UTC(2026, 0, 1);

/**
 * One simulated world. A fresh Sim is created for every schedule that explore() runs,
 * so all state the test touches must be created inside the test body.
 */
export class Sim {
  constructor({ seed = 1, trackRejections = true } = {}) {
    this.seed = seed;
    this._trackRejections = trackRejections;
    this._rejected = [];
    this._cleanups = []; // run when the schedule ends // op promises that rejected; checked for handlers at each idle point
    this._rng = createRng(seed);
    this._now = 0;
    this._seq = 0;
    this._pending = []; // ops + yields, in call order
    this._timers = []; // sorted by (deadline, id)
    this._inflight = new Set(); // impl promises currently settling
    this._trace = [];
    this._uncaught = null;
    this._active = true;
    // Bind so methods can be destructured: const { fn, sleep } = sim
    for (const k of ['fn', 'wrap', 'mockFetch', 'go', 'yield', 'sleep', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'now', 'random', 'log']) {
      this[k] = this[k].bind(this);
    }
  }

  // ---------------------------------------------------------------- public API

  /** Wrap an async function so each call becomes a schedulable operation. */
  fn(name, impl = async () => {}, { network = false } = {}) {
    if (typeof name === 'function') [name, impl] = [name.name || 'fn', name];
    const sim = this;
    return function simulated(...args) {
      return sim._op(name, args, () => impl.apply(this, args), { network });
    };
  }

  /** Proxy every method of an object (e.g. a fake db/client) through sim.fn. */
  wrap(name, obj, { network = false } = {}) {
    const cache = new Map();
    return new Proxy(obj, {
      get: (target, prop, receiver) => {
        const v = Reflect.get(target, prop, receiver);
        if (typeof v !== 'function' || typeof prop === 'symbol') return v;
        if (!cache.has(prop)) {
          const sim = this;
          cache.set(prop, function (...args) {
            return sim._op(`${name}.${String(prop)}`, args, () => v.apply(target, args), { network });
          });
        }
        return cache.get(prop);
      },
    });
  }

  /**
   * A fetch() whose requests are schedulable operations, answered by `handler(request)`.
   * The handler may return a Response, a string, or any JSON-serializable value.
   * With { global: true } it also replaces globalThis.fetch for the rest of the schedule.
   */
  mockFetch(handler, { global = false, network = true } = {}) {
    const fetch = (input, init) => {
      const req = new Request(typeof input === 'string' && input.startsWith('/') ? `http://localhost${input}` : input, init);
      const url = new URL(req.url);
      const where = url.host === 'localhost' ? url.pathname + url.search : req.url;
      return this._op('fetch', null, async () => toResponse(await handler(req)), { network, label: `fetch ${req.method} ${where}` });
    };
    if (global) {
      const saved = globalThis.fetch;
      globalThis.fetch = fetch;
      this._cleanups.push(() => (globalThis.fetch = saved));
    }
    return fetch;
  }

  /** Run fn as a named concurrent task; its operations are labelled with that name in traces. */
  go(name, fn) {
    return taskStore.run(String(name), fn);
  }

  /** An explicit preemption point: other pending work may run before this resolves. */
  yield(label = 'yield') {
    return this._op(label, null, () => undefined, { kind: 'yield' });
  }

  sleep(ms = 0, label) {
    return new Promise((resolve) => this._timer(ms, resolve, label ?? `sleep(${ms})`, false));
  }

  setTimeout(cb, ms = 0, ...args) {
    return this._timer(ms, () => cb(...args), `setTimeout(${ms})`, false);
  }

  setInterval(cb, ms = 0, ...args) {
    return this._timer(ms, () => cb(...args), `setInterval(${ms})`, true);
  }

  clearTimeout(id) {
    const i = this._timers.findIndex((t) => t.id === id);
    if (i !== -1) this._timers.splice(i, 1);
  }

  clearInterval(id) {
    this.clearTimeout(id);
  }

  /** Virtual time in ms since the start of this schedule. */
  now() {
    return this._now;
  }

  /** Seeded random in [0, 1). */
  random() {
    return this._rng();
  }

  /** Add a note to the trace. */
  log(...parts) {
    this._event({ type: 'log', label: parts.map((p) => (typeof p === 'string' ? p : formatValue(p))).join(' ') });
  }

  // ---------------------------------------------------------------- internals

  _task() {
    return taskStore.getStore() ?? 'main';
  }

  _event(ev) {
    ev.task ??= this._task();
    this._trace.push(ev);
  }

  _checkActive() {
    if (!this._active) {
      throw new Error('raceloom: this sim has finished. Create fakes inside the explore() body so each schedule gets fresh ones.');
    }
  }

  /**
   * Park a call until the scheduler picks it. With `network`, the call is a round trip with two
   * scheduling points: the implementation runs ("executed"), and later the response is delivered.
   */
  _op(name, args, run, { kind = 'op', network = false, label = args ? `${name}(${args.map(formatValue).join(', ')})` : name } = {}) {
    this._checkActive();
    const id = ++this._seq;
    const task = this._task();
    if (kind === 'op') this._event({ type: 'call', label, task });
    const Ctor = this._trackRejections ? OpPromise : Promise;
    const promise = new Ctor((resolve, reject) => {
      this._pending.push({
        id,
        kind,
        label,
        task,
        fire: (overtook) => {
          if (kind === 'yield') {
            this._event({ type: 'yield', label, task, overtook });
            resolve();
            return;
          }
          let r;
          try {
            r = taskStore.run(task, run);
          } catch (e) {
            r = Promise.reject(e);
          }
          const deliver = (ok, value) => (overtook2) => {
            if (ok) {
              this._event({ type: 'return', label, task, value: formatValue(value), overtook: overtook2 });
              resolve(value);
            } else {
              this._event({ type: 'throw', label, task, value: formatError(value), overtook: overtook2 });
              reject(value);
              if (this._trackRejections) this._rejected.push({ promise, error: value, label, task });
            }
          };
          const settle = (ok) => (value) => {
            if (!network) return deliver(ok, value)(overtook);
            this._event({ type: 'exec', label, task, overtook });
            this._pending.push({ id: ++this._seq, kind: 'deliver', label, task, fire: deliver(ok, value) });
          };
          const p = Promise.resolve(r).then(settle(true), settle(false));
          this._inflight.add(p);
          p.finally(() => this._inflight.delete(p));
        },
      });
    });
    // Mark the native promise handled; OpPromise.handled tracks *user* subscriptions.
    if (this._trackRejections) Promise.prototype.then.call(promise, undefined, () => {});
    return promise;
  }

  /** Called when the world is idle: any rejected op nobody subscribed to is an unhandled rejection. */
  _checkUnhandled() {
    for (const r of this._rejected) {
      if (!r.promise.handled) {
        this._event({ type: 'error', task: r.task, value: `unhandled rejection from ${r.label}: ${formatError(r.error)}` });
        this._uncaught ??= r.error;
      }
    }
    this._rejected.length = 0;
  }

  _timer(ms, cb, label, repeat) {
    this._checkActive();
    ms = Math.max(0, Number(ms) || 0);
    const id = ++this._seq;
    const task = this._task();
    const t = {
      id,
      kind: 'timer',
      label,
      task,
      deadline: this._now + ms,
      fire: (overtook) => {
        this._now = Math.max(this._now, t.deadline);
        this._event({ type: 'timer', label, task, at: this._now, overtook });
        if (repeat) {
          t.deadline = this._now + Math.max(1, ms);
          this._insertTimer(t);
        }
        try {
          taskStore.run(task, cb);
        } catch (e) {
          this._event({ type: 'error', task, value: `uncaught ${formatError(e)}` });
          this._uncaught ??= e;
        }
      },
    };
    t.repeat = repeat;
    this._insertTimer(t);
    return id;
  }

  _insertTimer(t) {
    let i = this._timers.length;
    while (i > 0 && this._timers[i - 1].deadline > t.deadline) i--;
    this._timers.splice(i, 0, t);
  }

  /** What may run next: every pending op, plus the earliest timer (timers fire in deadline order). */
  _choices() {
    return this._timers.length ? [...this._pending, this._timers[0]] : this._pending.slice();
  }

  _fire(choice, overtook) {
    if (choice.kind === 'timer') this._timers.shift();
    else this._pending.splice(this._pending.indexOf(choice), 1);
    choice.fire(overtook || undefined);
  }

  // ---------------------------------------------------------------- global patching

  _installGlobals() {
    const g = globalThis;
    const saved = {
      setTimeout: g.setTimeout,
      clearTimeout: g.clearTimeout,
      setInterval: g.setInterval,
      clearInterval: g.clearInterval,
      setImmediate: g.setImmediate,
      Date: g.Date,
      random: Math.random,
    };
    const sim = this;
    const RealDate = saved.Date;
    const virtualNow = () => EPOCH + sim._now;
    // A Proxy (not a subclass) so `Date()` without `new`, `instanceof Date`, Date.UTC/parse all keep working.
    const SimDate = new Proxy(RealDate, {
      construct: (target, args, newTarget) => Reflect.construct(target, args.length ? args : [virtualNow()], newTarget),
      apply: () => new RealDate(virtualNow()).toString(),
      get: (target, prop, receiver) => (prop === 'now' ? virtualNow : Reflect.get(target, prop, receiver)),
    });
    g.setTimeout = this.setTimeout;
    g.clearTimeout = this.clearTimeout;
    g.setInterval = this.setInterval;
    g.clearInterval = this.clearInterval;
    g.setImmediate = (cb, ...args) => this._timer(0, () => cb(...args), 'setImmediate', false);
    g.Date = SimDate;
    Math.random = this.random;
    return () => {
      Object.assign(g, {
        setTimeout: saved.setTimeout,
        clearTimeout: saved.clearTimeout,
        setInterval: saved.setInterval,
        clearInterval: saved.clearInterval,
        setImmediate: saved.setImmediate,
        Date: saved.Date,
      });
      Math.random = saved.random;
    };
  }
}
