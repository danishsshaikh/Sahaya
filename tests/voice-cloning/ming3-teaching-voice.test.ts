import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { VoiceProfile } from '@/lib/voice-cloning/types';

const mocks = vi.hoisted(() => ({
  enabled: vi.fn(),
  resolveReference: vi.fn(),
  register: vi.fn(),
  synthesize: vi.fn(),
  writeProfile: vi.fn(),
  markConfigured: vi.fn(),
}));

vi.mock('@/lib/voice-cloning/config', () => ({
  isMing3TtsPreviewEnabled: mocks.enabled,
}));
vi.mock('@/lib/voice-cloning/storage', () => ({
  resolveAuthorizedProfileReference: mocks.resolveReference,
  writeVoiceProfile: mocks.writeProfile,
}));
vi.mock('@/lib/auth/server', () => ({ markVoiceConfigured: mocks.markConfigured }));
vi.mock('@/lib/voice-comparison/providers/ming3', () => ({
  Ming3TtsPreviewProvider: class {
    registerProfile = mocks.register;
    synthesize = mocks.synthesize;
  },
}));

import {
  activateMing3TeachingVoice,
  ming3ServiceProfileId,
  synthesizeMing3TeachingVoice,
} from '@/lib/server/ming3-tts';

const profile: VoiceProfile = {
  id: 'vcp_ming_default',
  ownerId: 'faculty-a',
  displayName: 'My Teaching Voice',
  provider: 'chatterbox',
  language: 'en',
  languageId: 'en',
  status: 'ready',
  activeEngine: 'ming3-tts',
  referenceAudioKey: '/private/reference.wav',
  referenceText: 'Exact saved reference transcript.',
  profileVersion: 3,
  createdAt: '2026-11-17T00:00:00.000Z',
  updatedAt: '2026-11-17T00:00:00.000Z',
  consentTimestamp: '2026-11-17T00:00:00.000Z',
  consentVersion: 'test',
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.enabled.mockReturnValue(true);
  mocks.resolveReference.mockResolvedValue({
    path: '/authorized/faculty-a/vcp_ming_default/reference.wav',
    provenance: 'processed-reference',
  });
  mocks.register.mockResolvedValue(undefined);
  mocks.synthesize.mockResolvedValue({
    audio: new Uint8Array([82, 73, 70, 70]),
    durationSeconds: 1.25,
    conditioningMode: 'acoustic-reference',
  });
  mocks.writeProfile.mockResolvedValue(undefined);
  mocks.markConfigured.mockResolvedValue(undefined);
});

describe('Ming Teaching Voice integration', () => {
  it('registers the authorized reference and preserves exact narration text', async () => {
    const text = "Newton's first law stays unchanged.";
    const result = await synthesizeMing3TeachingVoice({ profile, text });
    const serviceProfileId = ming3ServiceProfileId(profile);

    expect(mocks.resolveReference).toHaveBeenCalledExactlyOnceWith({
      ownerId: profile.ownerId,
      profileId: profile.id,
      preferOriginalMimeTypes: [
        'audio/wav',
        'audio/x-wav',
        'audio/flac',
        'audio/ogg',
        'audio/opus',
      ],
      allowPreReady: undefined,
    });
    expect(mocks.register).toHaveBeenCalledExactlyOnceWith(
      {
        profileId: serviceProfileId,
        referenceAudioPath: '/authorized/faculty-a/vcp_ming_default/reference.wav',
        referenceText: profile.referenceText,
      },
      undefined,
    );
    expect(mocks.synthesize).toHaveBeenCalledExactlyOnceWith({
      profileId: serviceProfileId,
      text,
      language: 'en',
      signal: undefined,
    });
    expect(result).toMatchObject({ format: 'wav', conditioningMode: 'acoustic-reference' });
  });

  it('activates Ming only after a valid sample is returned', async () => {
    const result = await activateMing3TeachingVoice(profile, profile.ownerId);

    expect(result).toMatchObject({ status: 'ready', activeEngine: 'ming3-tts' });
    expect(result.preview).toMatchObject({ format: 'wav', base64: 'UklGRg==' });
    expect(mocks.writeProfile).toHaveBeenCalledExactlyOnceWith(result);
    expect(mocks.markConfigured).toHaveBeenCalledExactlyOnceWith(profile.ownerId);
  });

  it('surfaces service configuration and reference failures without fallback', async () => {
    mocks.enabled.mockReturnValue(false);
    await expect(synthesizeMing3TeachingVoice({ profile, text: 'Hello.' })).rejects.toMatchObject({
      status: 503,
    });
    expect(mocks.register).not.toHaveBeenCalled();

    mocks.enabled.mockReturnValue(true);
    mocks.resolveReference.mockRejectedValue(new Error('missing'));
    await expect(synthesizeMing3TeachingVoice({ profile, text: 'Hello.' })).rejects.toMatchObject({
      status: 409,
    });
    expect(mocks.register).not.toHaveBeenCalled();
  });
});
