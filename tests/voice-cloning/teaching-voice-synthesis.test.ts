import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { VoiceProfile } from '@/lib/voice-cloning/types';
import { VoiceProviderProfileNotFoundError } from '@/lib/voice-cloning/types';
import { synthesizeFacultyVoice } from '@/lib/voice-cloning/synthesis';

const mocks = vi.hoisted(() => ({
  read: vi.fn(), write: vi.fn(), synthesize: vi.fn(), register: vi.fn(), resolve: vi.fn(),
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
  mocks.synthesize.mockReset();
  mocks.register.mockReset();
  profile = {
    id: 'vcp_example', ownerId: 'usr_example', displayName: 'Teaching Voice',
    provider: 'qwen3', language: 'en', status: 'ready', profileVersion: 1,
    referenceAudioKey: 'data/reference.wav', referenceText: 'Exact transcript.',
    providerReferenceId: 'vcp_example', createdAt: '', updatedAt: '',
    consentTimestamp: '', consentVersion: 'test',
  };
  mocks.read.mockImplementation(async () => profile);
  mocks.resolve.mockReturnValue({ synthesize: mocks.synthesize, createProfile: mocks.register });
  mocks.synthesize.mockResolvedValue({ audio: new Uint8Array([1]), format: 'wav' });
  mocks.register.mockResolvedValue({ providerReferenceId: 'vcp_example' });
});

const request = { profileId: 'vcp_example', ownerId: 'usr_example', text: 'Hello', language: 'en' };

describe('profile-specific synthesis and recovery', () => {
  it.each([['qwen3', 'en'], ['indicf5', 'hi'], ['indicf5', 'mr']])(
    'recreates only %s once with exact reference metadata', async (provider, language) => {
      profile = { ...profile, provider, language };
      mocks.synthesize.mockRejectedValueOnce(new VoiceProviderProfileNotFoundError('missing'));
      await synthesizeFacultyVoice({ ...request, language });
      expect(mocks.resolve).toHaveBeenCalledExactlyOnceWith(provider);
      expect(mocks.register).toHaveBeenCalledExactlyOnceWith({
        profileId: profile.id, referenceAudioKey: '/shared/reference.wav',
        referenceText: profile.referenceText, language,
      });
      expect(mocks.synthesize).toHaveBeenCalledTimes(2);
    },
  );

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
    await expect(synthesizeFacultyVoice({ ...request, language: 'hi' })).rejects.toThrow('does not match');
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
});
