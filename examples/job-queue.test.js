// A queue with a visibility timeout (like SQS): a received job is hidden for 30s and
// re-delivered if it isn't acked in time. If the payment call is slower than the
// timeout, a second worker charges the customer again.
//
// This code uses plain setTimeout — `patchGlobals: true` puts it on raceloom's
// virtual clock, so 30-second timeouts take microseconds and are explored like any
// other event.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { explore } from 'raceloom';

class Queue {
  constructor(jobs) { this.ready = [...jobs]; }
  receive() {
    const job = this.ready.shift();
    if (job) setTimeout(() => { if (!job.acked) this.ready.push(job); }, 30_000);
    return job;
  }
  ack(job) { job.acked = true; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function worker(queue, payments) {
  for (let polls = 0; polls < 5; polls++) {
    const job = queue.receive();
    if (!job) { await sleep(10_000); continue; }
    await payments.charge(job.order, job.amount);
    queue.ack(job);
  }
}

test('every order is charged exactly once', async () => {
  await explore(async (sim) => {
    const charges = [];
    const payments = sim.wrap('payments', {
      async charge(order, amount) { charges.push(order); },
    });
    const queue = new Queue([{ order: 'A-1', amount: 42 }]);

    await Promise.all([
      sim.go('worker 1', () => worker(queue, payments)),
      sim.go('worker 2', () => worker(queue, payments)),
    ]);

    assert.deepEqual(charges, ['A-1']);
  }, { patchGlobals: true });
});
