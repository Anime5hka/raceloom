import { explore, RaceError, type ExploreResult } from 'raceloom';

const result: Promise<ExploreResult> = explore(
  async (sim) => {
    const db = sim.wrap('db', {
      rows: new Map<string, number>(),
      async get(k: string) { return 1; },
      put(k: string, v: number) { return true; },
    });
    const n: number = await db.get('a');
    const ok: boolean = await db.put('a', 1); // sync methods become async
    const size: number = db.rows.size;
    const load = sim.fn('load', async (id: number) => ({ id }));
    const row: { id: number } = await load(1);
    await sim.go('task', () => sim.sleep(10));
    const t: number = sim.setTimeout((a: string) => void a, 5, 'x');
    sim.clearTimeout(t);
    sim.log('note', { n, ok, size, row });
  },
  { strategy: 'random', runs: 10, patchGlobals: true },
);

result.catch((e) => {
  if (e instanceof RaceError) {
    const replay: string = e.replay;
    return explore(() => {}, { replay });
  }
});
