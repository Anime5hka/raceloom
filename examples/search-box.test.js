// The classic "stale response" race: type "r", then "ra". If the response for "r"
// arrives last, the UI shows results for the wrong query.
// A plain unit test passes (responses arrive in order). raceloom finds the bug.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { explore } from 'raceloom';

function createSearchBox(api) {
  const ui = { query: '', results: [] };
  return {
    ui,
    async onInput(query) {
      ui.query = query;
      ui.results = await api.search(query); // BUG: no check that this is still the latest query
    },
  };
}

test('search box shows results for the latest query', async () => {
  await explore(async (sim) => {
    const api = sim.wrap('api', {
      async search(q) { return [`${q}ust`, `${q}ce`]; },
    });
    const box = createSearchBox(api);

    await Promise.all([
      sim.go('keystroke 1', () => box.onInput('r')),
      sim.go('keystroke 2', () => box.onInput('ra')),
    ]);

    assert.ok(
      box.ui.results.every((r) => r.startsWith(box.ui.query)),
      `showing ${JSON.stringify(box.ui.results)} for query "${box.ui.query}"`,
    );
  });
});
