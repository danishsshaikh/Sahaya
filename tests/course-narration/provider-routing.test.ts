import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  generatePreview: vi.fn(),
  getBootstrap: vi.fn(),
  requireProfile: vi.fn(),
  findCurrentProfile: vi.fn(),
  enhance: vi.fn(),
  readEntries: vi.fn(),
  writeCache: vi.fn(),
}));

vi.mock('@/lib/server/voice-comparison', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/server/voice-comparison')>();
  return {
    ...original,
    generateVoiceComparisonPreview: mocks.generatePreview,
    getVoiceComparisonBootstrap: mocks.getBootstrap,
    requireOwnedReadyProfile: mocks.requireProfile,
  };
});
vi.mock('@/lib/voice-cloning/resemble-enhance', () => ({
  enhanceGeneratedVoiceAudio: mocks.enhance,
}));
vi.mock('@/lib/voice-cloning/storage', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/voice-cloning/storage')>();
  return { ...original, findCurrentVoiceProfile: mocks.findCurrentProfile };
});
vi.mock('@/lib/server/voice-comparison-cache', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/server/voice-comparison-cache')>();
  return {
    ...original,
    readVoiceComparisonCacheEntries: mocks.readEntries,
    writeVoiceComparisonCache: mocks.writeCache,
  };
});
vi.mock('@/lib/config/feature-flags', () => ({
  isExperimentalCourseNarrationEnabled: () => true,
}));
vi.mock('@/lib/voice-cloning/config', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/voice-cloning/config')>();
  return { ...original, isVoiceEnhancementAllowed: () => true };
});

import {
  getCourseNarrationBootstrap,
  synthesizeCourseNarration,
} from '@/lib/server/course-narration';
import { TeachingVoiceError } from '@/lib/voice-cloning/types';

describe('course narration provider routing', () => {
  beforeEach(() => {
    mocks.generatePreview.mockReset().mockResolvedValue({
      providerId: 'sarvam',
      providerName: 'Sarvam AI',
      audio: { format: 'wav', base64: Buffer.from('provider-bytes').toString('base64') },
      cacheKey: 'raw-key',
    });
    mocks.enhance.mockReset();
    mocks.getBootstrap.mockReset();
    mocks.requireProfile.mockReset();
    mocks.findCurrentProfile.mockReset().mockResolvedValue(null);
    mocks.readEntries.mockReset().mockResolvedValue([]);
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

  it('does not report the course missing when a retained legacy profile id is stale', async () => {
    mocks.requireProfile.mockRejectedValue(new TeachingVoiceError('Voice profile not found.', 404));

    const bootstrap = await getCourseNarrationBootstrap({
      ownerId: 'owner-1',
      stageId: 'course-1',
      profileId: 'missing-profile',
    });

    expect(bootstrap.profile).toBeUndefined();
    expect(bootstrap.providers.map((provider) => provider.id)).toContain('bodhan');
  });

  it('uses the same current ready profile lookup as Customize Voice for an older course', async () => {
    const currentProfile = {
      id: 'profile-current',
      ownerId: 'owner-1',
      displayName: 'Current Teaching Voice',
      provider: 'chatterbox',
      language: 'hi',
      status: 'ready',
      activeEngine: 'chatterbox',
      referenceAudioKey: '/private/reference.wav',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
      consentTimestamp: '2026-01-01T00:00:00.000Z',
      consentVersion: 'v1',
      profileVersion: 1,
    };
    mocks.findCurrentProfile.mockResolvedValue(currentProfile);
    mocks.getBootstrap.mockResolvedValue({
      providers: [{ id: 'chatterbox', available: true }],
      languages: [],
      bodhanVoices: [],
      bodhanStyles: [],
      savedPreviews: [],
    });

    const bootstrap = await getCourseNarrationBootstrap({
      ownerId: 'owner-1',
      stageId: 'browser-course',
      language: 'hi',
    });

    expect(mocks.findCurrentProfile).toHaveBeenNthCalledWith(1, 'owner-1', 'hi', true);
    expect(mocks.getBootstrap).toHaveBeenCalledWith('owner-1', currentProfile);
    expect(bootstrap.profile).toMatchObject({ id: 'profile-current', language: 'hi' });
    expect(bootstrap.profile).not.toHaveProperty('referenceAudioKey');
  });

  it('returns the authenticated profile active engine without exposing private provider ids', async () => {
    mocks.requireProfile.mockResolvedValue({
      id: 'profile-1',
      ownerId: 'owner-1',
      displayName: 'Faculty Voice',
      provider: 'chatterbox',
      language: 'en',
      status: 'ready',
      activeEngine: 'qwen3-tts',
      providerReferenceId: 'private-provider-id',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      consentTimestamp: '2026-01-01T00:00:00.000Z',
      consentVersion: 'v1',
      profileVersion: 1,
    });
    mocks.getBootstrap.mockResolvedValue({
      providers: [],
      languages: [],
      bodhanVoices: [],
      bodhanStyles: [],
      savedPreviews: [],
    });

    const bootstrap = await getCourseNarrationBootstrap({
      ownerId: 'owner-1',
      stageId: 'course-1',
      profileId: 'profile-1',
    });

    expect(bootstrap.profile).toMatchObject({
      id: 'profile-1',
      displayName: 'Faculty Voice',
      activeEngine: 'qwen3-tts',
    });
    expect(bootstrap.profile).not.toHaveProperty('providerReferenceId');
  });
});
