import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ResembleEnhancePool,
  type VoiceEnhancementResult,
  type VoiceEnhancementWorker,
} from '@/lib/voice-cloning/resemble-enhance';
import {
  getVoiceEnhancementConfig,
  isVoiceEnhancementAllowed,
  type VoiceEnhancementConfig,
} from '@/lib/voice-cloning/config';

function config(overrides: Partial<VoiceEnhancementConfig> = {}): VoiceEnhancementConfig {
  return {
    enabled: true,
    backend: 'resemble-enhance',
    previewEnabled: true,
    classroomEnabled: false,
    hindiEnabled: false,
    timeoutMs: 1000,
    maxConcurrency: 1,
    pythonExecutable: 'python3',
    workerPath: '/tmp/worker.py',
    device: 'cuda',
    nfe: 32,
    solver: 'midpoint',
    denoiseStrength: 0.1,
    priorTemperature: 0.5,
    ...overrides,
  };
}

function result(value: number): VoiceEnhancementResult {
  return {
    audio: new Uint8Array([value]),
    format: 'wav',
    backend: 'resemble-enhance',
    processingMs: 1,
    originalDurationSeconds: 1,
    enhancedDurationSeconds: 1,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('Resemble Enhance worker pool', () => {
  it('coalesces duplicate audio while enhancement is in flight', async () => {
    const pending = deferred<VoiceEnhancementResult>();
    const worker: VoiceEnhancementWorker = {
      enhance: vi.fn(() => pending.promise),
      close: vi.fn(),
    };
    const pool = new ResembleEnhancePool(config(), () => worker);
    const input = { audio: new Uint8Array([1]), format: 'wav' };

    const first = pool.enhance(input);
    const second = pool.enhance(input);
    expect(first).toBe(second);
    expect(worker.enhance).toHaveBeenCalledTimes(1);

    pending.resolve(result(7));
    await expect(Promise.all([first, second])).resolves.toEqual([result(7), result(7)]);
    pool.close();
  });

  it('bounds concurrent work and starts the next clip after completion', async () => {
    const first = deferred<VoiceEnhancementResult>();
    const second = deferred<VoiceEnhancementResult>();
    const worker: VoiceEnhancementWorker = {
      enhance: vi
        .fn()
        .mockImplementationOnce(() => first.promise)
        .mockImplementationOnce(() => second.promise),
      close: vi.fn(),
    };
    const pool = new ResembleEnhancePool(config(), () => worker);

    const firstRequest = pool.enhance({ audio: new Uint8Array([1]), format: 'wav' });
    const secondRequest = pool.enhance({ audio: new Uint8Array([2]), format: 'wav' });
    expect(worker.enhance).toHaveBeenCalledTimes(1);

    first.resolve(result(1));
    await expect(firstRequest).resolves.toEqual(result(1));
    await vi.waitFor(() => expect(worker.enhance).toHaveBeenCalledTimes(2));
    second.resolve(result(2));
    await expect(secondRequest).resolves.toEqual(result(2));
    pool.close();
  });

  it('closes a failed worker and releases its slot for the next clip', async () => {
    const failedWorker: VoiceEnhancementWorker = {
      enhance: vi.fn().mockRejectedValue(new Error('inference timed out')),
      close: vi.fn(),
    };
    const replacementWorker: VoiceEnhancementWorker = {
      enhance: vi.fn().mockResolvedValue(result(2)),
      close: vi.fn(),
    };
    const factory = vi
      .fn<() => VoiceEnhancementWorker>()
      .mockReturnValueOnce(failedWorker)
      .mockReturnValueOnce(replacementWorker);
    const pool = new ResembleEnhancePool(config(), factory);

    await expect(pool.enhance({ audio: new Uint8Array([1]), format: 'wav' })).rejects.toThrow(
      'inference timed out',
    );
    expect(failedWorker.close).toHaveBeenCalledExactlyOnceWith('inference timed out');

    await expect(pool.enhance({ audio: new Uint8Array([2]), format: 'wav' })).resolves.toEqual(
      result(2),
    );
    expect(factory).toHaveBeenCalledTimes(2);
    pool.close();
  });
});

describe('enhancement activation policy', () => {
  it('keeps classroom and Hindi processing opt-in', () => {
    vi.stubEnv('VOICE_ENHANCEMENT_ENABLED', 'true');
    expect(isVoiceEnhancementAllowed('chatterbox', 'en', 'preview')).toBe(true);
    expect(isVoiceEnhancementAllowed('qwen3-tts', 'en', 'preview')).toBe(true);
    expect(isVoiceEnhancementAllowed('qwen3-tts', 'en', 'classroom')).toBe(false);
    expect(isVoiceEnhancementAllowed('chatterbox', 'en', 'classroom')).toBe(false);
    expect(isVoiceEnhancementAllowed('chatterbox', 'hi', 'preview')).toBe(false);

    vi.stubEnv('VOICE_ENHANCEMENT_CLASSROOM_ENABLED', 'true');
    vi.stubEnv('VOICE_ENHANCEMENT_HINDI_ENABLED', 'true');
    expect(isVoiceEnhancementAllowed('chatterbox', 'hi', 'classroom')).toBe(true);
    expect(isVoiceEnhancementAllowed('indicf5', 'hi', 'classroom')).toBe(false);
    expect(isVoiceEnhancementAllowed('chatterbox', 'mr', 'classroom')).toBe(false);
  });

  it('uses conservative defaults and a single worker', () => {
    vi.stubEnv('VOICE_ENHANCEMENT_ENABLED', 'true');
    const resolved = getVoiceEnhancementConfig();
    expect(resolved).toMatchObject({
      maxConcurrency: 1,
      nfe: 32,
      solver: 'midpoint',
      denoiseStrength: 0.1,
      priorTemperature: 0.5,
    });
  });
});
