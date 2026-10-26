import { describe, expect, it, vi } from 'vitest';
import { ResourceJobQueue } from '@/lib/server/resource-job-queue';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function enqueue(
  queue: ResourceJobQueue,
  key: string,
  run: (jobId: string) => Promise<string>,
  ownerId = 'faculty-a',
) {
  return queue.enqueue({
    resourceKey: 'teaching-voice:chatterbox',
    concurrency: 1,
    ownerId,
    idempotencyKey: key,
    metadata: { provider: 'chatterbox', stageId: `stage-${key}` },
    run,
  });
}

describe('process-local constrained resource queue', () => {
  it('runs concurrent faculty requests FIFO with one provider slot', async () => {
    const queue = new ResourceJobQueue();
    const gates = [deferred<string>(), deferred<string>(), deferred<string>()];
    const order: string[] = [];
    let active = 0;
    let maxActive = 0;
    const jobs = gates.map((gate, index) =>
      enqueue(
        queue,
        String(index),
        async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          order.push(`start-${index}`);
          try {
            return await gate.promise;
          } finally {
            active -= 1;
          }
        },
        `faculty-${index}`,
      ),
    );

    await vi.waitFor(() => expect(queue.read(jobs[0].job.id, 'faculty-0')?.status).toBe('running'));
    expect(queue.read(jobs[1].job.id, 'faculty-1')).toMatchObject({
      status: 'queued',
      queuePosition: 2,
      jobsAhead: 1,
    });
    expect(queue.read(jobs[2].job.id, 'faculty-2')).toMatchObject({
      status: 'queued',
      queuePosition: 3,
      jobsAhead: 2,
    });

    gates[0].resolve('a');
    await vi.waitFor(() => expect(queue.read(jobs[1].job.id, 'faculty-1')?.status).toBe('running'));
    gates[1].resolve('b');
    await vi.waitFor(() => expect(queue.read(jobs[2].job.id, 'faculty-2')?.status).toBe('running'));
    gates[2].resolve('c');
    await vi.waitFor(() =>
      expect(queue.read(jobs[2].job.id, 'faculty-2')?.status).toBe('completed'),
    );

    expect(order).toEqual(['start-0', 'start-1', 'start-2']);
    expect(maxActive).toBe(1);
  });

  it.each(['queued', 'running', 'completed'] as const)(
    'reuses the same idempotent job while %s',
    async (expectedStatus) => {
      const queue = new ResourceJobQueue();
      const gate = deferred<string>();
      const run = vi.fn(() => gate.promise);
      const first = enqueue(queue, 'same-request', run);
      if (expectedStatus !== 'queued') {
        await vi.waitFor(() =>
          expect(queue.read(first.job.id, 'faculty-a')?.status).toBe('running'),
        );
      }
      if (expectedStatus === 'completed') {
        gate.resolve('audio');
        await vi.waitFor(() =>
          expect(queue.read(first.job.id, 'faculty-a')?.status).toBe('completed'),
        );
      }

      const duplicate = enqueue(queue, 'same-request', run);
      expect(duplicate.reused).toBe(true);
      expect(duplicate.job.id).toBe(first.job.id);
      expect(run).toHaveBeenCalledTimes(expectedStatus === 'queued' ? 0 : 1);
      if (expectedStatus === 'queued') gate.resolve('audio');
    },
  );

  it('releases the slot after failure and starts the next job', async () => {
    const queue = new ResourceJobQueue();
    const firstGate = deferred<string>();
    const secondRun = vi.fn(async () => 'second');
    const first = enqueue(queue, 'first', () => firstGate.promise);
    const second = enqueue(queue, 'second', secondRun, 'faculty-b');

    await vi.waitFor(() => expect(queue.read(first.job.id, 'faculty-a')?.status).toBe('running'));
    firstGate.reject(new Error('provider retry budget exhausted'));
    await vi.waitFor(() => expect(queue.read(first.job.id, 'faculty-a')?.status).toBe('failed'));
    await vi.waitFor(() =>
      expect(queue.read(second.job.id, 'faculty-b')?.status).toBe('completed'),
    );
    expect(secondRun).toHaveBeenCalledTimes(1);
  });

  it('cancels a queued job without dispatching it', async () => {
    const queue = new ResourceJobQueue();
    const blocker = deferred<string>();
    const queuedRun = vi.fn(async () => 'never');
    enqueue(queue, 'blocker', () => blocker.promise);
    const queued = enqueue(queue, 'cancel-me', queuedRun, 'faculty-b');
    await vi.waitFor(() => expect(queuedRun).not.toHaveBeenCalled());

    expect(queue.cancel(queued.job.id, 'faculty-b')?.status).toBe('cancelled');
    blocker.resolve('done');
    await Promise.resolve();
    expect(queuedRun).not.toHaveBeenCalled();
  });

  it('does not expose jobs or results across owners', async () => {
    const queue = new ResourceJobQueue();
    const job = enqueue(queue, 'private', async () => 'audio');
    await vi.waitFor(() => expect(queue.read(job.job.id, 'faculty-a')?.status).toBe('completed'));
    expect(queue.read(job.job.id, 'faculty-b')).toBeNull();
    expect(queue.result(job.job.id, 'faculty-b')).toBeNull();
    expect(queue.result(job.job.id, 'faculty-a')).toBe('audio');
  });

  it('returns no ETA without samples, then estimates from successful durations', async () => {
    let now = 1000;
    const unsampledQueue = new ResourceJobQueue(1000, () => now);
    const unsampledBlocker = deferred<string>();
    enqueue(unsampledQueue, 'unsampled-running', () => unsampledBlocker.promise);
    const unsampledWaiting = enqueue(
      unsampledQueue,
      'unsampled-waiting',
      async () => 'waiting',
      'faculty-b',
    );
    expect(unsampledQueue.read(unsampledWaiting.job.id, 'faculty-b')?.estimatedWaitMs).toBeNull();
    unsampledBlocker.resolve('done');

    const queue = new ResourceJobQueue(1000, () => now);
    const firstGate = deferred<string>();
    const first = enqueue(queue, 'sample', () => firstGate.promise);
    await vi.waitFor(() => expect(queue.read(first.job.id, 'faculty-a')?.status).toBe('running'));
    now += 120_000;
    firstGate.resolve('sample');
    await vi.waitFor(() => expect(queue.read(first.job.id, 'faculty-a')?.status).toBe('completed'));

    const blocker = deferred<string>();
    const running = enqueue(queue, 'running', () => blocker.promise);
    await vi.waitFor(() => expect(queue.read(running.job.id, 'faculty-a')?.status).toBe('running'));
    const estimated = enqueue(queue, 'estimated', async () => 'estimated', 'faculty-c');
    expect(queue.read(estimated.job.id, 'faculty-c')?.estimatedWaitMs).toBe(120_000);
    blocker.resolve('done');
  });

  it('cleans retained terminal jobs after the configured TTL', async () => {
    let now = 1000;
    const queue = new ResourceJobQueue(100, () => now);
    const job = enqueue(queue, 'expiring', async () => 'audio');
    await vi.waitFor(() => expect(queue.read(job.job.id, 'faculty-a')?.status).toBe('completed'));
    now += 101;
    queue.cleanup(now);
    expect(queue.read(job.job.id, 'faculty-a')).toBeNull();
  });
});
