import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  generatePreview: vi.fn(),
  enhance: vi.fn(),
  writeCache: vi.fn(),
}));

vi.mock('@/lib/server/voice-comparison', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/server/voice-comparison')>();
  return { ...original, generateVoiceComparisonPreview: mocks.generatePreview };
});
vi.mock('@/lib/voice-cloning/resemble-enhance', () => ({
  enhanceGeneratedVoiceAudio: mocks.enhance,
}));
vi.mock('@/lib/server/voice-comparison-cache', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/server/voice-comparison-cache')>();
  return { ...original, writeVoiceComparisonCache: mocks.writeCache };
});
vi.mock('@/lib/config/feature-flags', () => ({
  isExperimentalCourseNarrationEnabled: () => true,
}));
vi.mock('@/lib/voice-cloning/config', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/voice-cloning/config')>();
  return { ...original, isVoiceEnhancementAllowed: () => true };
});

import { synthesizeCourseNarration } from '@/lib/server/course-narration';

describe('course narration provider routing', () => {
  beforeEach(() => {
    mocks.generatePreview.mockReset().mockResolvedValue({
      providerId: 'sarvam',
      providerName: 'Sarvam AI',
      audio: { format: 'wav', base64: Buffer.from('provider-bytes').toString('base64') },
      cacheKey: 'raw-key',
    });
    mocks.enhance.mockReset();
    mocks.writeCache.mockReset().mockResolvedValue(undefined);
  });

  it('reuses Sarvam through the existing adapter without clone-creation flags or enhancement', async () => {
    const result = await synthesizeCourseNarration({
      ownerId: 'owner-1',
      stageId: 'course-1',
      profileId: 'profile-1',
      providerId: 'sarvam',
      text: '  Exact Sarvam text.  ',
      language: 'en',
      enhancementMode: 'standard',
    });

    expect(mocks.generatePreview).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: 'owner-1',
        request: {
          profileId: 'profile-1',
          providerId: 'sarvam',
          text: '  Exact Sarvam text.  ',
          language: 'en',
        },
      }),
    );
    expect(mocks.enhance).not.toHaveBeenCalled();
    expect(Buffer.from(result.audio.base64, 'base64').toString()).toBe('provider-bytes');
  });

  it('never applies enhancement to providers that do not support it', async () => {
    await expect(
      synthesizeCourseNarration({
        ownerId: 'owner-1',
        stageId: 'course-1',
        profileId: 'profile-1',
        providerId: 'sarvam',
        text: 'Exact text',
        language: 'en',
        enhancementMode: 'resemble-enhance',
      }),
    ).rejects.toThrow(/unavailable/);
    expect(mocks.enhance).not.toHaveBeenCalled();
  });

  it('caches enhanced previews separately from original provider output', async () => {
    mocks.generatePreview.mockResolvedValue({
      profileId: 'profile-1',
      providerId: 'chatterbox',
      providerName: 'Chatterbox V3',
      audio: { format: 'wav', base64: Buffer.from('original').toString('base64') },
      cacheKey: 'original-key',
      request: { text: 'Exact text', language: 'en' },
    });
    mocks.enhance.mockResolvedValue({
      audio: new Uint8Array(Buffer.from('enhanced')),
      format: 'wav',
      enhancedDurationSeconds: 2.5,
    });

    const result = await synthesizeCourseNarration({
      ownerId: 'owner-1',
      stageId: 'course-1',
      profileId: 'profile-1',
      providerId: 'chatterbox',
      text: 'Exact text',
      language: 'en',
      enhancementMode: 'resemble-enhance',
    });

    expect(result.request?.enhancementMode).toBe('resemble-enhance');
    expect(Buffer.from(result.audio.base64, 'base64').toString()).toBe('enhanced');
    expect(mocks.writeCache).toHaveBeenCalledWith('owner-1', result);
  });
});
