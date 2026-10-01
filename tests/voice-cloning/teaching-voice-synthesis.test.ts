import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { VoiceProfile } from '@/lib/voice-cloning/types';
import {
  TeachingVoiceProviderOperationError,
  VoiceProviderProfileNotFoundError,
} from '@/lib/voice-cloning/types';
import { synthesizeFacultyVoice } from '@/lib/voice-cloning/synthesis';

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  write: vi.fn(),
  synthesize: vi.fn(),
  register: vi.fn(),
  resolve: vi.fn(),
}));
vi.mock('@/lib/voice-cloning/config', () => ({ isVoiceCloningServerEnabled: () => true }));
vi.mock('@/lib/voice-cloning/storage', () => ({
  readVoiceProfile: mocks.read,
  writeVoiceProfile: mocks.write,
  referenceAudioExists: async () => true,
  resolveReferenceAudioPath: () => '/shared/reference.wav',
}));
vi.mock('@/lib/voice-cloning/provider', () => ({ getVoiceCloningProvider: mocks.resolve }));
vi.mock('@/lib/voice-cloning/audio-validation', () => ({
  masterGeneratedVoiceAudio: async (audio: Uint8Array, format: string) => ({ audio, format }),
}));

let profile: VoiceProfile;
beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  mocks.synthesize.mockReset();
  mocks.register.mockReset();
  profile = {
    id: 'vcp_example',
    ownerId: 'usr_example',
    displayName: 'Teaching Voice',
    provider: 'qwen3',
    language: 'en',
    status: 'ready',
    profileVersion: 1,
    referenceAudioKey: 'data/reference.wav',
    referenceText: 'Exact transcript.',
    providerReferenceId: 'vcp_example',
    createdAt: '',
    updatedAt: '',
    consentTimestamp: '',
    consentVersion: 'test',
  };
  mocks.read.mockImplementation(async () => profile);
  mocks.resolve.mockReturnValue({ synthesize: mocks.synthesize, createProfile: mocks.register });
  mocks.synthesize.mockResolvedValue({ audio: new Uint8Array([1]), format: 'wav' });
  mocks.register.mockResolvedValue({ providerReferenceId: 'vcp_example' });
});

const request = { profileId: 'vcp_example', ownerId: 'usr_example', text: 'Hello', language: 'en' };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function busyError() {
  return new TeachingVoiceProviderOperationError(
    'Teaching Voice service is busy. Try again after the current generation finishes.',
    429,
    {
      provider: 'qwen3',
      endpoint: '/synthesize',
      operation: 'synthesis',
      providerStatus: 429,
    },
  );
}

describe('profile-specific synthesis and recovery', () => {
  it.each([
    ['qwen3', 'en'],
    ['indicf5', 'hi'],
    ['indicf5', 'mr'],
  ])('recreates only %s once with exact reference metadata', async (provider, language) => {
    profile = { ...profile, provider, language };
    mocks.synthesize.mockRejectedValueOnce(new VoiceProviderProfileNotFoundError('missing'));
    await synthesizeFacultyVoice({ ...request, language });
    expect(mocks.resolve).toHaveBeenCalledExactlyOnceWith(provider);
    expect(mocks.register).toHaveBeenCalledExactlyOnceWith({
      profileId: profile.id,
      referenceAudioKey: '/shared/reference.wav',
      referenceText: profile.referenceText,
      language,
    });
    expect(mocks.synthesize).toHaveBeenCalledTimes(2);
  });

  it('does not retry again when the second synthesis fails', async () => {
    mocks.synthesize.mockRejectedValue(new VoiceProviderProfileNotFoundError('missing'));
    await expect(synthesizeFacultyVoice(request)).rejects.toThrow('missing');
    expect(mocks.register).toHaveBeenCalledTimes(1);
    expect(mocks.synthesize).toHaveBeenCalledTimes(2);
    expect(mocks.resolve).toHaveBeenCalledExactlyOnceWith('qwen3');
  });

  it('surfaces a failed same-provider registration without retrying synthesis', async () => {
    mocks.synthesize.mockRejectedValueOnce(new VoiceProviderProfileNotFoundError('missing'));
    mocks.register.mockRejectedValueOnce(new Error('registration unavailable'));
    await expect(synthesizeFacultyVoice(request)).rejects.toThrow('registration unavailable');
    expect(mocks.register).toHaveBeenCalledTimes(1);
    expect(mocks.synthesize).toHaveBeenCalledTimes(1);
    expect(mocks.resolve).toHaveBeenCalledExactlyOnceWith('qwen3');
  });

  it('surfaces ordinary failure without recreation or switching provider', async () => {
    mocks.synthesize.mockRejectedValue(new Error('service unavailable'));
    await expect(synthesizeFacultyVoice(request)).rejects.toThrow('service unavailable');
    expect(mocks.register).not.toHaveBeenCalled();
    expect(mocks.synthesize).toHaveBeenCalledTimes(1);
    expect(mocks.resolve).toHaveBeenCalledExactlyOnceWith('qwen3');
  });

  it('rejects language mismatch and absent transcript before service access', async () => {
    await expect(synthesizeFacultyVoice({ ...request, language: 'hi' })).rejects.toThrow(
      'does not match',
    );
    profile.referenceText = undefined;
    await expect(synthesizeFacultyVoice(request)).rejects.toThrow('transcript');
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it('retains Chatterbox routing for profiles without new metadata', async () => {
    profile = { ...profile, provider: 'chatterbox', referenceText: undefined };
    await synthesizeFacultyVoice(request);
    expect(mocks.resolve).toHaveBeenCalledExactlyOnceWith('chatterbox');
    expect(mocks.synthesize).toHaveBeenCalledWith(expect.objectContaining({ modelVariant: 'v2' }));
  });

  it('retries a temporary Qwen provider-busy response and then succeeds', async () => {
    vi.stubEnv('TEACHING_VOICE_BUSY_RETRY_BASE_MS', '1');
    vi.stubEnv('TEACHING_VOICE_BUSY_MAX_RETRIES', '2');
    mocks.synthesize
      .mockRejectedValueOnce(busyError())
      .mockResolvedValueOnce({ audio: new Uint8Array([1]), format: 'wav' });

    await expect(synthesizeFacultyVoice(request)).resolves.toMatchObject({ format: 'wav' });
    expect(mocks.synthesize).toHaveBeenCalledTimes(2);
  });

  it('fails deterministically when Qwen stays busy beyond the retry budget', async () => {
    vi.stubEnv('TEACHING_VOICE_BUSY_RETRY_BASE_MS', '1');
    vi.stubEnv('TEACHING_VOICE_BUSY_MAX_RETRIES', '1');
    mocks.synthesize.mockRejectedValue(busyError());

    await expect(synthesizeFacultyVoice(request)).rejects.toMatchObject({ status: 429 });
    expect(mocks.synthesize).toHaveBeenCalledTimes(2);
  });

  it('does not duplicate a successful Qwen synthesis request', async () => {
    await synthesizeFacultyVoice(request);
    expect(mocks.synthesize).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ providerReferenceId: 'vcp_example' }),
    );
  });

  it('does not serialize legacy Chatterbox synthesis behind the Qwen queue', async () => {
    profile = { ...profile, provider: 'chatterbox', referenceText: undefined };
    const first = deferred<{ audio: Uint8Array; format: string }>();
    const second = deferred<{ audio: Uint8Array; format: string }>();
    mocks.synthesize.mockImplementation(() =>
      mocks.synthesize.mock.calls.length === 1 ? first.promise : second.promise,
    );

    const firstRequest = synthesizeFacultyVoice(request);
    await vi.waitFor(() => expect(mocks.synthesize).toHaveBeenCalledTimes(1));
    const secondRequest = synthesizeFacultyVoice(request);
    await vi.waitFor(() => expect(mocks.synthesize).toHaveBeenCalledTimes(2));

    first.resolve({ audio: new Uint8Array([1]), format: 'wav' });
    second.resolve({ audio: new Uint8Array([2]), format: 'wav' });
    await expect(Promise.all([firstRequest, secondRequest])).resolves.toHaveLength(2);
  });
});
