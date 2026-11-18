import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearQwen3TtsCapacityForTests,
  qwen3TtsCapacitySnapshotForTests,
  runWithQwen3TtsCapacity,
} from '@/lib/server/qwen3-tts-capacity';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  clearQwen3TtsCapacityForTests();
});

describe('Qwen3-TTS shared provider capacity', () => {
  it('admits concurrent classroom and preview work one-at-a-time in FIFO order', async () => {
    const gates = [deferred<void>(), deferred<void>(), deferred<void>()];
    const order: string[] = [];
    let active = 0;
    let maxActive = 0;
    const tasks = gates.map((gate, index) =>
      runWithQwen3TtsCapacity(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        order.push(`start-${index}`);
        try {
          await gate.promise;
          return index;
        } finally {
          active -= 1;
        }
      }),
    );

    await vi.waitFor(() =>
      expect(qwen3TtsCapacitySnapshotForTests()).toEqual({ running: true, pending: 2 }),
    );
    expect(order).toEqual(['start-0']);

    gates[0].resolve();
    await vi.waitFor(() => expect(order).toEqual(['start-0', 'start-1']));
    gates[1].resolve();
    await vi.waitFor(() => expect(order).toEqual(['start-0', 'start-1', 'start-2']));
    gates[2].resolve();

    await expect(Promise.all(tasks)).resolves.toEqual([0, 1, 2]);
    expect(maxActive).toBe(1);
    expect(qwen3TtsCapacitySnapshotForTests()).toEqual({ running: false, pending: 0 });
  });

  it('releases the model slot after failure so a single-segment retry can run', async () => {
    const blocker = deferred<void>();
    const first = runWithQwen3TtsCapacity(async () => {
      await blocker.promise;
      throw new Error('provider failed');
    });
    const retry = vi.fn(async () => 'regenerated-audio');
    const second = runWithQwen3TtsCapacity(retry);

    await vi.waitFor(() => expect(qwen3TtsCapacitySnapshotForTests().pending).toBe(1));
    blocker.resolve();
    await expect(first).rejects.toThrow('provider failed');
    await expect(second).resolves.toBe('regenerated-audio');
    expect(retry).toHaveBeenCalledOnce();
    expect(qwen3TtsCapacitySnapshotForTests()).toEqual({ running: false, pending: 0 });
  });

  it('removes an aborted waiter without consuming the next provider turn', async () => {
    const blocker = deferred<void>();
    const first = runWithQwen3TtsCapacity(() => blocker.promise);
    const controller = new AbortController();
    const cancelled = runWithQwen3TtsCapacity(async () => 'cancelled', controller.signal);
    const next = vi.fn(async () => 'next');
    const third = runWithQwen3TtsCapacity(next);

    await vi.waitFor(() => expect(qwen3TtsCapacitySnapshotForTests().pending).toBe(2));
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    expect(next).not.toHaveBeenCalled();
    blocker.resolve();
    await first;
    await expect(third).resolves.toBe('next');
    expect(next).toHaveBeenCalledOnce();
  });
});
