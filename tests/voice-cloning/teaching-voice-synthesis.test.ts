import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { VoiceProfile } from '@/lib/voice-cloning/types';
import {
  TeachingVoiceProviderOperationError,
  VoiceProviderProfileNotFoundError,
} from '@/lib/voice-cloning/types';
import {
  resolveFacultyVoiceSelection,
  synthesizeFacultyVoice,
} from '@/lib/voice-cloning/synthesis';

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  write: vi.fn(),
  synthesize: vi.fn(),
  register: vi.fn(),
  resolve: vi.fn(),
  processAudio: vi.fn(),
  processQwenAudio: vi.fn(),
  masterAudio: vi.fn(),
}));
vi.mock('@/lib/voice-cloning/config', () => ({
  isVoiceCloningServerEnabled: () => true,
  isQwen3TtsClassroomEnabled: () => true,
  isVoiceEnhancementAllowed: () => true,
}));
vi.mock('@/lib/voice-cloning/storage', () => ({
  readVoiceProfile: mocks.read,
  writeVoiceProfile: mocks.write,
  referenceAudioExists: async () => true,
  resolveReferenceAudioPath: () => '/shared/reference.wav',
}));
vi.mock('@/lib/voice-cloning/provider', () => ({ getVoiceCloningProvider: mocks.resolve }));
vi.mock('@/lib/voice-cloning/audio-validation', () => ({
  masterGeneratedVoiceAudio: mocks.masterAudio,
}));
vi.mock('@/lib/voice-cloning/audio-enhancement', () => ({
  processChatterboxAudioVariants: mocks.processAudio,
  processVoiceAudioVariants: mocks.processQwenAudio,
}));

let profile: VoiceProfile;
beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  mocks.synthesize.mockReset();
  mocks.register.mockReset();
  mocks.masterAudio.mockReset();
  profile = {
    id: 'vcp_example',
    ownerId: 'usr_example',
    displayName: 'Teaching Voice',
    provider: 'chatterbox',
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
  mocks.masterAudio.mockImplementation(async (audio: Uint8Array, format: string) => ({
    audio,
    format,
  }));
  mocks.processAudio.mockImplementation(async (raw: { audio: Uint8Array; format: string }) => ({
    original: raw,
  }));
  mocks.processQwenAudio.mockImplementation(async (raw: { audio: Uint8Array; format: string }) => ({
    original: raw,
  }));
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
      provider: 'chatterbox',
      endpoint: '/synthesize',
      operation: 'synthesis',
      providerStatus: 429,
    },
  );
}

describe('profile-specific synthesis and recovery', () => {
  it.each([
    ['chatterbox', 'en'],
    ['indicf5', 'hi'],
    ['indicf5', 'mr'],
  ])('recreates only %s once with exact reference metadata', async (provider, language) => {
    profile = { ...profile, provider, language };
    mocks.synthesize.mockRejectedValueOnce(new VoiceProviderProfileNotFoundError('missing'));
    await synthesizeFacultyVoice({ ...request, language });
    expect(mocks.resolve).toHaveBeenCalledExactlyOnceWith(provider);
    expect(mocks.register).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        profileId: profile.id,
        referenceAudioKey: '/shared/reference.wav',
        language,
      }),
    );
    expect(mocks.synthesize).toHaveBeenCalledTimes(2);
  });

  it('does not retry again when the second synthesis fails', async () => {
    mocks.synthesize.mockRejectedValue(new VoiceProviderProfileNotFoundError('missing'));
    await expect(synthesizeFacultyVoice(request)).rejects.toThrow('missing');
    expect(mocks.register).toHaveBeenCalledTimes(1);
    expect(mocks.synthesize).toHaveBeenCalledTimes(2);
    expect(mocks.resolve).toHaveBeenCalledExactlyOnceWith('chatterbox');
  });

  it('surfaces a failed same-provider registration without retrying synthesis', async () => {
    mocks.synthesize.mockRejectedValueOnce(new VoiceProviderProfileNotFoundError('missing'));
    mocks.register.mockRejectedValueOnce(new Error('registration unavailable'));
    await expect(synthesizeFacultyVoice(request)).rejects.toThrow('registration unavailable');
    expect(mocks.register).toHaveBeenCalledTimes(1);
    expect(mocks.synthesize).toHaveBeenCalledTimes(1);
    expect(mocks.resolve).toHaveBeenCalledExactlyOnceWith('chatterbox');
  });

  it('surfaces ordinary failure without recreation or switching provider', async () => {
    mocks.synthesize.mockRejectedValue(new Error('service unavailable'));
    await expect(synthesizeFacultyVoice(request)).rejects.toThrow('service unavailable');
    expect(mocks.register).not.toHaveBeenCalled();
    expect(mocks.synthesize).toHaveBeenCalledTimes(1);
    expect(mocks.resolve).toHaveBeenCalledExactlyOnceWith('chatterbox');
  });

  it('rejects Indic language mismatch and absent transcript before service access', async () => {
    profile = { ...profile, provider: 'indicf5', language: 'hi', languageId: 'hi' };
    await expect(synthesizeFacultyVoice({ ...request, language: 'mr' })).rejects.toThrow(
      'does not match',
    );
    profile = { ...profile, provider: 'indicf5', language: 'hi', referenceText: undefined };
    await expect(synthesizeFacultyVoice({ ...request, language: 'hi' })).rejects.toThrow(
      'transcript',
    );
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it('uses saved Hindi Chatterbox synthesis for unchanged English lesson text', async () => {
    profile = { ...profile, language: 'en', languageId: 'hi', modelVariant: 'v3' };

    await synthesizeFacultyVoice({ ...request, text: 'Welcome to class.', language: 'en' });

    expect(mocks.synthesize).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ text: 'Welcome to class.', language: 'hi', modelVariant: 'v3' }),
    );
  });

  it('rejects unsupported saved Chatterbox synthesis without rerouting providers', async () => {
    profile = { ...profile, language: 'en', languageId: 'mr', modelVariant: 'v3' };

    await expect(synthesizeFacultyVoice(request)).rejects.toThrow('English or Hindi synthesis');
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it('retains Chatterbox routing for profiles without new metadata', async () => {
    profile = { ...profile, provider: 'chatterbox', referenceText: undefined };
    await synthesizeFacultyVoice(request);
    expect(mocks.resolve).toHaveBeenCalledExactlyOnceWith('chatterbox');
    expect(mocks.synthesize).toHaveBeenCalledWith(expect.objectContaining({ modelVariant: 'v2' }));
  });

  it('retries a temporary Chatterbox provider-busy response and then succeeds', async () => {
    vi.stubEnv('TEACHING_VOICE_BUSY_RETRY_BASE_MS', '1');
    vi.stubEnv('TEACHING_VOICE_BUSY_MAX_RETRIES', '2');
    mocks.synthesize
      .mockRejectedValueOnce(busyError())
      .mockResolvedValueOnce({ audio: new Uint8Array([1]), format: 'wav' });

    await expect(synthesizeFacultyVoice(request)).resolves.toMatchObject({ format: 'wav' });
    expect(mocks.synthesize).toHaveBeenCalledTimes(2);
  });

  it('fails deterministically when Chatterbox stays busy beyond the retry budget', async () => {
    vi.stubEnv('TEACHING_VOICE_BUSY_RETRY_BASE_MS', '1');
    vi.stubEnv('TEACHING_VOICE_BUSY_MAX_RETRIES', '1');
    mocks.synthesize.mockRejectedValue(busyError());

    await expect(synthesizeFacultyVoice(request)).rejects.toMatchObject({ status: 429 });
    expect(mocks.synthesize).toHaveBeenCalledTimes(2);
  });

  it('recovers an IndicF5 synthesis after a transient provider-busy response', async () => {
    profile = { ...profile, provider: 'indicf5', language: 'hi', languageId: 'hi' };
    vi.stubEnv('TEACHING_VOICE_BUSY_RETRY_BASE_MS', '1');
    mocks.synthesize
      .mockRejectedValueOnce(busyError())
      .mockResolvedValueOnce({ audio: new Uint8Array([1]), format: 'wav' });

    await expect(synthesizeFacultyVoice({ ...request, language: 'hi' })).resolves.toMatchObject({
      format: 'wav',
    });
    expect(mocks.synthesize).toHaveBeenCalledTimes(2);
    expect(mocks.masterAudio).toHaveBeenCalledExactlyOnceWith(
      new Uint8Array([1]),
      'wav',
      'indicf5-natural',
    );
  });

  it('bounds provider-busy retries by elapsed wait time', async () => {
    vi.stubEnv('TEACHING_VOICE_BUSY_RETRY_BASE_MS', '1');
    vi.stubEnv('TEACHING_VOICE_BUSY_MAX_RETRIES', '20');
    vi.stubEnv('TEACHING_VOICE_BUSY_MAX_WAIT_MS', '2');
    mocks.synthesize.mockRejectedValue(busyError());

    await expect(synthesizeFacultyVoice(request)).rejects.toMatchObject({ status: 429 });
    expect(mocks.synthesize).toHaveBeenCalledTimes(2);
  });

  it('does not duplicate a successful Chatterbox synthesis request', async () => {
    await synthesizeFacultyVoice(request);
    expect(mocks.synthesize).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ providerReferenceId: 'vcp_example' }),
    );
  });

  it('keeps standard profiles on original mastering without enhancement', async () => {
    await synthesizeFacultyVoice(request);

    expect(mocks.processAudio).toHaveBeenCalledWith(
      expect.objectContaining({ audio: new Uint8Array([1]) }),
      expect.objectContaining({ attemptEnhancement: false, context: 'classroom' }),
    );
  });

  it('selects enhanced audio when the saved profile opts in', async () => {
    profile = { ...profile, enhancementMode: 'resemble-enhance' };
    mocks.processAudio.mockResolvedValue({
      original: { audio: new Uint8Array([1]), format: 'wav' },
      enhanced: { audio: new Uint8Array([9]), format: 'wav' },
    });

    const result = await synthesizeFacultyVoice(request);

    expect(result.audio).toEqual(new Uint8Array([9]));
    expect(mocks.processAudio).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ attemptEnhancement: true, languageId: 'en' }),
    );
    expect(mocks.synthesize).toHaveBeenCalledTimes(1);
  });

  it('leaves serialization to the resource queue rather than direct synthesis', async () => {
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

  it('migrates retained Qwen metadata to Chatterbox before new synthesis', async () => {
    profile = { ...profile, provider: 'qwen3', modelVariant: undefined };

    await synthesizeFacultyVoice(request);

    expect(mocks.resolve).toHaveBeenCalledExactlyOnceWith('chatterbox');
    expect(mocks.register).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        profileId: 'vcp_example',
        referenceAudioKey: '/shared/reference.wav',
        language: 'en',
        modelVariant: 'v3',
      }),
    );
    expect(mocks.synthesize).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ providerReferenceId: 'vcp_example' }),
    );
    expect(mocks.write).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'chatterbox', providerReferenceId: 'vcp_example' }),
    );
  });

  it('routes an active Qwen profile to Qwen with exact narration and no profile mutation', async () => {
    profile = { ...profile, activeEngine: 'qwen3-tts', languageId: 'hi' };

    await expect(resolveFacultyVoiceSelection(profile.id, profile.ownerId, 'en')).resolves.toEqual({
      providerId: 'qwen3-tts',
      synthesisLanguage: 'en',
    });

    const result = await synthesizeFacultyVoice({
      ...request,
      text: 'Exact classroom narration.',
      language: 'en',
    });

    expect(mocks.resolve).toHaveBeenCalledExactlyOnceWith('qwen3-tts');
    expect(mocks.synthesize).toHaveBeenCalledExactlyOnceWith({
      providerReferenceId: profile.id,
      text: 'Exact classroom narration.',
      language: 'en',
    });
    expect(mocks.processQwenAudio).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        attemptEnhancement: false,
        source: 'qwen3-tts',
        originalMasteringPreset: null,
        enhancedMasteringPreset: null,
      }),
    );
    expect(result.audio).toEqual(new Uint8Array([1]));
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it('recreates a Qwen speaker prompt after service restart without overwriting Chatterbox IDs', async () => {
    profile = { ...profile, activeEngine: 'qwen3-tts' };
    mocks.synthesize
      .mockRejectedValueOnce(new VoiceProviderProfileNotFoundError('missing prompt'))
      .mockResolvedValueOnce({ audio: new Uint8Array([2]), format: 'wav' });

    await synthesizeFacultyVoice(request);

    expect(mocks.register).toHaveBeenCalledExactlyOnceWith({
      profileId: profile.id,
      referenceAudioKey: '/shared/reference.wav',
      referenceText: 'Exact transcript.',
      language: 'en',
    });
    expect(mocks.synthesize).toHaveBeenCalledTimes(2);
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it('uses explicitly selected Qwen Enhanced output and fails visibly when enhancement fails', async () => {
    profile = {
      ...profile,
      activeEngine: 'qwen3-tts',
      qwenEnhancementMode: 'resemble-enhance',
    };
    mocks.processQwenAudio.mockResolvedValueOnce({
      original: { audio: new Uint8Array([1]), format: 'wav' },
      enhanced: { audio: new Uint8Array([9]), format: 'wav' },
    });
    await expect(synthesizeFacultyVoice(request)).resolves.toEqual({
      audio: new Uint8Array([9]),
      format: 'wav',
    });

    mocks.processQwenAudio.mockResolvedValueOnce({
      original: { audio: new Uint8Array([1]), format: 'wav' },
      enhancementError: 'Enhancement unavailable.',
    });
    await expect(synthesizeFacultyVoice(request)).rejects.toThrow('Enhancement unavailable');
    expect(mocks.resolve).toHaveBeenCalledWith('qwen3-tts');
  });

  it('does not fall back to Chatterbox when active Qwen synthesis fails', async () => {
    profile = { ...profile, activeEngine: 'qwen3-tts' };
    mocks.synthesize.mockRejectedValue(new Error('Qwen unavailable'));

    await expect(synthesizeFacultyVoice(request)).rejects.toThrow('Qwen unavailable');
    expect(mocks.resolve).toHaveBeenCalledExactlyOnceWith('qwen3-tts');
    expect(mocks.register).not.toHaveBeenCalled();
  });
});
