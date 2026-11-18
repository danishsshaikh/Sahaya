import { TeachingVoiceError } from '@/lib/voice-cloning/types';

interface PendingQwenTask {
  resolve: () => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface QwenCapacityState {
  running: boolean;
  pending: PendingQwenTask[];
}

const MAX_PENDING_QWEN_TASKS = 64;

const capacityGlobal = globalThis as typeof globalThis & {
  __openmaicQwen3TtsCapacity?: QwenCapacityState;
};
const state =
  capacityGlobal.__openmaicQwen3TtsCapacity ??
  (capacityGlobal.__openmaicQwen3TtsCapacity = {
    running: false,
    pending: [],
  });

function abortError(): Error {
  if (typeof DOMException !== 'undefined') return new DOMException('Aborted', 'AbortError');
  const error = new Error('Aborted');
  error.name = 'AbortError';
  return error;
}

function dispatchNext(): void {
  while (state.pending.length > 0) {
    const next = state.pending.shift()!;
    if (next.onAbort) next.signal?.removeEventListener('abort', next.onAbort);
    if (next.signal?.aborted) {
      next.reject(abortError());
      continue;
    }
    state.running = true;
    next.resolve();
    return;
  }
  state.running = false;
}

async function acquire(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw abortError();
  if (!state.running && state.pending.length === 0) {
    state.running = true;
    return;
  }
  if (state.pending.length >= MAX_PENDING_QWEN_TASKS) {
    throw new TeachingVoiceError(
      'Qwen3-TTS has too many requests waiting. Retry this narration shortly.',
      429,
    );
  }

  await new Promise<void>((resolve, reject) => {
    const pending: PendingQwenTask = { resolve, reject, signal };
    if (signal) {
      pending.onAbort = () => {
        const index = state.pending.indexOf(pending);
        if (index >= 0) state.pending.splice(index, 1);
        reject(abortError());
      };
      signal.addEventListener('abort', pending.onAbort, { once: true });
    }
    state.pending.push(pending);
  });
}

/**
 * The one in-process admission gate for every Qwen3-TTS model operation.
 *
 * Classroom narration, single-action retries, comparison/course previews, and
 * Teaching Voice previews all use the same provider adapter and therefore the
 * same FIFO gate. Waiting here happens before an HTTP request is sent, so a
 * queued operation cannot consume the provider's busy-retry budget. The gate
 * covers only the Qwen request; Resemble enhancement runs after it is released.
 */
export async function runWithQwen3TtsCapacity<T>(
  task: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  await acquire(signal);
  try {
    return await task();
  } finally {
    dispatchNext();
  }
}

export function qwen3TtsCapacitySnapshotForTests(): { running: boolean; pending: number } {
  return { running: state.running, pending: state.pending.length };
}

export function clearQwen3TtsCapacityForTests(): void {
  for (const pending of state.pending.splice(0)) {
    if (pending.onAbort) pending.signal?.removeEventListener('abort', pending.onAbort);
    pending.reject(new Error('Qwen3-TTS capacity queue cleared for tests.'));
  }
  state.running = false;
}
