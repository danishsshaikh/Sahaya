import { TeachingVoiceError } from '@/lib/voice-cloning/types';
import type { VoiceComparisonProviderId } from '@/lib/voice-comparison/types';

interface ProviderState {
  running: number;
  pending: Array<() => void>;
}

const providerStates = new Map<VoiceComparisonProviderId, ProviderState>();
const inFlight = new Map<string, Promise<unknown>>();
const MAX_PENDING_PER_PROVIDER = 8;

function stateFor(providerId: VoiceComparisonProviderId): ProviderState {
  const existing = providerStates.get(providerId);
  if (existing) return existing;
  const created = { running: 0, pending: [] };
  providerStates.set(providerId, created);
  return created;
}

async function acquire(providerId: VoiceComparisonProviderId, concurrency: number): Promise<void> {
  const state = stateFor(providerId);
  if (state.running < concurrency) {
    state.running += 1;
    return;
  }
  if (state.pending.length >= MAX_PENDING_PER_PROVIDER) {
    throw new TeachingVoiceError('Too many voice previews are waiting. Try again shortly.', 429);
  }
  await new Promise<void>((resolve) => state.pending.push(resolve));
  state.running += 1;
}

function release(providerId: VoiceComparisonProviderId): void {
  const state = stateFor(providerId);
  state.running = Math.max(0, state.running - 1);
  state.pending.shift()?.();
}

export function runControlledVoicePreview<T>(input: {
  providerId: VoiceComparisonProviderId;
  requestKey: string;
  concurrency: number;
  task: () => Promise<T>;
}): Promise<T> {
  const existing = inFlight.get(input.requestKey);
  if (existing) return existing as Promise<T>;

  const operation = (async () => {
    await acquire(input.providerId, Math.max(1, Math.floor(input.concurrency)));
    try {
      return await input.task();
    } finally {
      release(input.providerId);
    }
  })();
  inFlight.set(input.requestKey, operation);
  void operation.then(
    () => inFlight.delete(input.requestKey),
    () => inFlight.delete(input.requestKey),
  );
  return operation;
}

export function clearVoiceComparisonControlForTests(): void {
  providerStates.clear();
  inFlight.clear();
}
