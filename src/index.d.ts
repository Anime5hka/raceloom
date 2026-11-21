export interface ExploreOptions {
  /** Maximum number of schedules to try. Default: 1000. */
  runs?: number;
  /**
   * - `auto` (default): enumerate orderings depth-first for half the budget; if the space is
   *   bigger than that, alternate random and PCT sampling for the rest.
   * - `exhaustive`: depth-first enumeration only. Proves the absence of races when it completes.
   * - `random`: seeded uniform random sampling only.
   * - `pct`: probabilistic concurrency testing (random task priorities with a few priority
   *   change points). Finds "one task stalls for a long time" bugs that uniform random misses.
   */
  strategy?: 'auto' | 'exhaustive' | 'random' | 'pct';
  /** Maximum bug depth targeted by PCT (each run picks 1..pctDepth). Default: 3. */
  pctDepth?: number;
  /** Base seed. Default: 1, or the RACELOOM_SEED environment variable. */
  seed?: number;
  /** Re-run exactly one schedule, using the token printed in a RaceError. */
  replay?: string;
  /** Minimize the failing schedule before reporting it. Default: true. */
  shrink?: boolean;
  /** Maximum schedules spent shrinking. Default: 500. */
  shrinkRuns?: number;
  /** Fail a schedule after this many scheduling steps. Default: 10000. */
  maxSteps?: number;
  /**
   * Replace setTimeout/setInterval/setImmediate/Date/Math.random with virtual, seeded versions
   * while each schedule runs. Default: false. Don't combine with tests that run concurrently
   * in the same process.
   */
  patchGlobals?: boolean;
  /**
   * Fail a schedule when a simulated operation rejects and nothing subscribed to its promise
   * by the next idle point. Default: true.
   */
  unhandledRejections?: boolean;
  /** Stop exploring after this many milliseconds of real time. */
  timeLimit?: number;
}

export interface ExploreResult {
  /** How many schedules were executed. */
  schedules: number;
  /** True when every possible ordering was explored (no race exists for this test). */
  complete: boolean;
  strategy: 'exhaustive' | 'random' | 'pct' | 'auto' | 'replay';
}

export interface TraceEvent {
  type: 'call' | 'return' | 'throw' | 'timer' | 'yield' | 'log' | 'error';
  task: string;
  label?: string;
  value?: string;
  /** Virtual time (timers only). */
  at?: number;
  /** How many earlier-pending operations this step jumped ahead of. */
  overtook?: number;
}

export declare class RaceError extends Error {
  name: 'RaceError';
  /** The original failure: your assertion error, a thrown error, or a Deadlock. */
  cause: unknown;
  error: unknown;
  /** Pass as `{ replay }` to re-run exactly this schedule. */
  replay: string;
  trace: TraceEvent[];
  decisions: number[];
  seed: number;
  strategy: string;
  /** 1-based index of the schedule that failed (0 when replaying). */
  schedule: number;
}

type AnyAsync = (...args: any[]) => any;
type Asyncify<F> = F extends (...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : F;
export type Wrapped<T> = { [K in keyof T]: T[K] extends AnyAsync ? Asyncify<T[K]> : T[K] };

export declare class Sim {
  /** Seed for this schedule's `random()`. */
  readonly seed: number;
  /** Wrap a function so every call becomes a schedulable operation. */
  fn<F extends AnyAsync>(name: string, impl?: F): Asyncify<F>;
  fn<F extends AnyAsync>(impl: F): Asyncify<F>;
  /** Proxy every method of an object through `fn`, labelled `name.method`. */
  wrap<T extends object>(name: string, obj: T): Wrapped<T>;
  /**
   * A fetch() whose requests are schedulable operations answered by `handler`.
   * Return a Response, a string, or any JSON-serializable value. Relative URLs resolve against http://localhost.
   * `global: true` replaces globalThis.fetch until the schedule ends.
   */
  mockFetch(
    handler: (request: Request) => unknown,
    options?: { global?: boolean },
  ): (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  /** Run `fn` as a named task; its operations are labelled with that name in the timeline. */
  go<R>(name: string, fn: () => R): R;
  /** An explicit preemption point: anything else pending may run first. */
  yield(label?: string): Promise<void>;
  /** Virtual sleep. Timers fire in deadline order; pending operations may complete before or after. */
  sleep(ms?: number, label?: string): Promise<void>;
  setTimeout<A extends unknown[]>(cb: (...args: A) => void, ms?: number, ...args: A): number;
  clearTimeout(id: number | undefined): void;
  setInterval<A extends unknown[]>(cb: (...args: A) => void, ms?: number, ...args: A): number;
  clearInterval(id: number | undefined): void;
  /** Virtual milliseconds since the schedule started. */
  now(): number;
  /** Seeded random number in [0, 1). */
  random(): number;
  /** Add a note to the timeline. */
  log(...parts: unknown[]): void;
}

/**
 * Run `body` under many interleavings of its simulated async operations.
 * Resolves with stats when every schedule passes; rejects with a RaceError otherwise.
 */
export declare function explore(body: (sim: Sim) => unknown, options?: ExploreOptions): Promise<ExploreResult>;

/** Render trace events as an aligned timeline. */
export declare function formatTrace(trace: TraceEvent[], options?: { color?: boolean }): string;
