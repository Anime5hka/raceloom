// Every example demonstrates a real bug, so each one must FAIL with a RaceError.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('../examples/', import.meta.url));
const env = { ...process.env, NO_COLOR: '1' };
delete env.NODE_TEST_CONTEXT; // otherwise the child thinks it is nested inside this runner

for (const file of readdirSync(dir).filter((f) => f.endsWith('.test.js'))) {
  test(`example ${file} catches its race`, async () => {
    const { code, out } = await new Promise((resolve) => {
      execFile(process.execPath, ['--test', file], { cwd: dir, env }, (err, stdout, stderr) =>
        resolve({ code: err?.code ?? 0, out: stdout + stderr }),
      );
    });
    assert.equal(code, 1, out);
    assert.match(out, /RaceError/);
    assert.match(out, /⚡ overtook/);
    assert.match(out, /Replay exactly: explore\(fn, \{ replay: "\d+:[\d.]+" \}\)/);
  });
}
