"""A queue with a visibility timeout (like SQS): a received job is hidden for 30 s and
re-delivered if it isn't acked in time. If the payment call is slower than the timeout,
the customer is charged twice. Plain asyncio.sleep code: raceloom's virtual clock makes
the 30-second timeout instant and explores it racing against the payment."""
import asyncio

from raceloom import explore


class Queue:
    def __init__(self, jobs):
        self.ready = list(jobs)

    def receive(self):
        if not self.ready:
            return None
        job = self.ready.pop(0)

        async def visibility_timeout():
            await asyncio.sleep(30)
            if not job.get("acked"):
                self.ready.append(job)

        job["timer"] = asyncio.create_task(visibility_timeout(), name="visibility timeout")
        return job

    def ack(self, job):
        job["acked"] = True


async def worker(queue, payments):
    for _ in range(5):
        job = queue.receive()
        if job is None:
            await asyncio.sleep(10)
            continue
        await payments.charge(job["order"], job["amount"])
        queue.ack(job)


def test_every_order_is_charged_exactly_once():
    async def scenario(sim):
        charges = []

        class Payments:
            async def charge(self, order, amount):
                charges.append(order)

        payments = sim.wrap("payments", Payments())
        queue = Queue([{"order": "A-1", "amount": 42}])
        async with asyncio.TaskGroup() as tg:
            tg.create_task(worker(queue, payments), name="worker 1")
            tg.create_task(worker(queue, payments), name="worker 2")
        assert charges == ["A-1"]

    explore(scenario)
