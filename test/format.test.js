import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatError } from '../src/format.js';

// Found by rubberstamp (https://github.com/Anime5hka/rubberstamp): every other test still passed
// when formatError returned the error object itself.
test('formatError: a generated assertion diff is summarised on one line', () => {
  let err;
  try { assert.deepEqual({ a: 1 }, { a: 2 }); } catch (e) { err = e; }
  assert.equal(formatError(err), 'AssertionError: expected { a: 2 }, got { a: 1 }');
});

test('formatError: keeps the first lines of a message, and formats non-errors as values', () => {
  assert.equal(formatError(new TypeError('bad\n\nworse\nworst'), { lines: 2 }), 'TypeError: bad worse');
  assert.equal(formatError('nope'), "'nope'");
});
