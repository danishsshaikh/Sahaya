import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { VoiceProfile } from '@/lib/voice-cloning/types';

const mocks = vi.hoisted(() => ({
  createProfile: vi.fn(),
  generatePreview: vi.fn(),
  referenceAudioExists: vi.fn(),
  processVoiceAudioVariants: vi.fn(),
  isVoiceEnhancementAllowed: vi.fn(),
}));

vi.mock('@/lib/voice-cloning/providers/qwen3-preview', () => ({
  Qwen3TtsVoiceCloningProvider: class {
    createProfile = mocks.createProfile;
    generatePreview = mocks.generatePreview;
  },
}));
vi.mock('@/lib/voice-cloning/storage', () => ({
  referenceAudioExists: mocks.referenceAudioExists,
  resolveReferenceAudioPath: (key: string) => key,
}));
vi.mock('@/lib/voice-cloning/audio-enhancement', () => ({
  processVoiceAudioVariants: mocks.processVoiceAudioVariants,
}));
vi.mock('@/lib/voice-cloning/config', () => ({
  isVoiceEnhancementAllowed: mocks.isVoiceEnhancementAllowed,
}));

import {
  createQwen3TtsPreviewCacheKey,
  currentQwen3TtsPreview,
  generateQwen3TtsModelPreview,
} from '@/lib/server/qwen3-tts-preview';

const profile: VoiceProfile = {
  id: 'vcp_existing',
  ownerId: 'faculty',
  displayName: 'My Teaching Voice',
  provider: 'chatterbox',
  language: 'en',
  languageId: 'hi',
  status: 'ready',
  referenceAudioKey: '/private/reference.wav',
  referenceText: 'This exact transcript is English.',
  providerReferenceId: 'accepted-chatterbox-reference',
  createdAt: '2026-10-19T00:00:00.000Z',
  updatedAt: '2026-10-19T00:00:00.000Z',
  consentTimestamp: '2026-10-19T00:00:00.000Z',
  consentVersion: '1',
  profileVersion: 1,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createProfile.mockResolvedValue({ providerReferenceId: profile.id });
  mocks.referenceAudioExists.mockResolvedValue(true);
  mocks.generatePreview.mockResolvedValue({ audio: new Uint8Array([1, 2]), format: 'wav' });
  mocks.isVoiceEnhancementAllowed.mockReturnValue(true);
  mocks.processVoiceAudioVariants.mockResolvedValue({
    original: { audio: new Uint8Array([1, 2]), format: 'wav' },
    enhanced: { audio: new Uint8Array([3, 4]), format: 'wav' },
  });
});

describe('Qwen3-TTS model preview generation', () => {
  it('uses the saved English recording transcript even when Chatterbox languageId is hi', async () => {
    const result = await generateQwen3TtsModelPreview(profile, 'resemble-enhance');

    expect(mocks.createProfile).toHaveBeenCalledExactlyOnceWith({
      profileId: profile.id,
      referenceAudioKey: profile.referenceAudioKey,
      referenceText: profile.referenceText,
      language: 'en',
    });
    expect(mocks.generatePreview).toHaveBeenCalledWith(
      expect.objectContaining({ providerReferenceId: profile.id, language: 'en' }),
    );
    expect(mocks.isVoiceEnhancementAllowed).toHaveBeenCalledWith('qwen3-tts', 'en', 'preview');
    expect(mocks.processVoiceAudioVariants).toHaveBeenCalledWith(
      { audio: new Uint8Array([1, 2]), format: 'wav' },
      expect.objectContaining({
        source: 'qwen3-tts',
        originalMasteringPreset: null,
        enhancedMasteringPreset: null,
      }),
    );
    expect(result).toMatchObject({
      previewModel: 'qwen3-tts-1.7b-base',
      qwenCloneMode: 'speaker-embedding',
      preview: { base64: Buffer.from([1, 2]).toString('base64') },
      comparison: {
        original: { base64: Buffer.from([1, 2]).toString('base64') },
        enhanced: { base64: Buffer.from([3, 4]).toString('base64') },
      },
    });
  });

  it('isolates persisted previews by profile and reference identity', () => {
    const result = {
      previewModel: 'qwen3-tts-1.7b-base' as const,
      qwenCloneMode: 'speaker-embedding' as const,
      enhancementMode: 'standard' as const,
      preview: { format: 'wav', base64: 'audio', createdAt: 'now' },
      comparison: {
        original: { format: 'wav', base64: 'audio', createdAt: 'now' },
      },
    };
    const cacheKey = createQwen3TtsPreviewCacheKey(profile);
    expect(
      currentQwen3TtsPreview({
        ...profile,
        qwenPreviewCache: { cacheKey, result },
      }),
    ).toBe(result);
    expect(
      currentQwen3TtsPreview({
        ...profile,
        referenceAudioKey: '/private/replacement.wav',
        qwenPreviewCache: { cacheKey, result },
      }),
    ).toBeUndefined();
    expect(createQwen3TtsPreviewCacheKey({ ...profile, id: 'vcp_other' })).not.toBe(cacheKey);
  });
});
