import { describe, expect, it, vi } from 'vitest';
import {
  activateTeachingVoiceSelection,
  disableTeachingVoiceSelection,
  readTeachingVoiceSelection,
  resolveGenerationTeachingVoiceProfileId,
} from '@/lib/voice-cloning/selection-client';

function response(body: unknown, ok = true): Response {
  return {
    ok,
    json: vi.fn(async () => body),
  } as unknown as Response;
}

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
}

describe('resolveGenerationTeachingVoiceProfileId', () => {
  it('uses the selected Teaching Voice without fetching', async () => {
    const fetchProfile = vi.fn();

    await expect(
      resolveGenerationTeachingVoiceProfileId('  vcp_selected  ', fetchProfile as typeof fetch),
    ).resolves.toBe('vcp_selected');

    expect(fetchProfile).not.toHaveBeenCalled();
  });

  it('waits for the ready Teaching Voice profile when selection has not hydrated yet', async () => {
    const fetchProfile = vi.fn(async () =>
      response({
        profile: {
          id: 'vcp_ready',
          status: 'ready',
        },
      }),
    );

    await expect(
      resolveGenerationTeachingVoiceProfileId(undefined, fetchProfile as typeof fetch),
    ).resolves.toBe('vcp_ready');

    expect(fetchProfile).toHaveBeenCalledWith('/api/voice-cloning/profile?language=en');
  });

  it('does not select a profile that is still previewing or absent', async () => {
    await expect(
      resolveGenerationTeachingVoiceProfileId(
        undefined,
        vi.fn(async () =>
          response({ profile: { id: 'vcp_preview', status: 'preview-ready' } }),
        ) as typeof fetch,
      ),
    ).resolves.toBeUndefined();

    await expect(
      resolveGenerationTeachingVoiceProfileId(
        undefined,
        vi.fn(async () => response({ profile: null })) as typeof fetch,
      ),
    ).resolves.toBeUndefined();
  });

  it('keeps visual generation available when profile lookup is unavailable', async () => {
    await expect(
      resolveGenerationTeachingVoiceProfileId(
        undefined,
        vi.fn(async () => {
          throw new Error('profile service unavailable');
        }) as typeof fetch,
      ),
    ).resolves.toBeUndefined();
  });

  it('persists a ready profile and its selected output mode per language', () => {
    const storage = memoryStorage();

    activateTeachingVoiceSelection('en', 'vcp_ready', 'resemble-enhance', storage);

    expect(readTeachingVoiceSelection('en', storage)).toEqual({
      enabled: true,
      profileId: 'vcp_ready',
      enhancementMode: 'resemble-enhance',
    });
    expect(readTeachingVoiceSelection('hi', storage)).toBeUndefined();
  });

  it('persists the Qwen-specific enhanced mode for new course generation', async () => {
    const storage = memoryStorage();
    const fetchProfile = vi.fn(async () =>
      response({
        profile: {
          id: 'vcp_qwen_enhanced',
          status: 'ready',
          activeEngine: 'qwen3-tts',
          enhancementMode: 'standard',
          qwenEnhancementMode: 'resemble-enhance',
        },
      }),
    );

    await expect(
      resolveGenerationTeachingVoiceProfileId(undefined, fetchProfile as typeof fetch, storage),
    ).resolves.toBe('vcp_qwen_enhanced');
    expect(readTeachingVoiceSelection('en', storage)).toEqual({
      enabled: true,
      profileId: 'vcp_qwen_enhanced',
      enhancementMode: 'resemble-enhance',
    });
  });

  it('respects an intentional Teaching Voice disable for the same ready profile', async () => {
    const storage = memoryStorage();
    const fetchProfile = vi.fn(async () =>
      response({ profile: { id: 'vcp_ready', status: 'ready' } }),
    );
    disableTeachingVoiceSelection('en', 'vcp_ready', storage);

    await expect(
      resolveGenerationTeachingVoiceProfileId(undefined, fetchProfile as typeof fetch, storage),
    ).resolves.toBeUndefined();
    expect(fetchProfile).toHaveBeenCalledOnce();
    expect(fetchProfile).toHaveBeenCalledWith(
      '/api/voice-cloning/profile?language=en&profileId=vcp_ready',
    );
  });

  it('preserves a legacy explicit disable for the language', async () => {
    const storage = memoryStorage();
    storage.setItem('sahaya.teachingVoice.selection.v1.en', JSON.stringify({ enabled: false }));
    const fetchProfile = vi.fn(async () =>
      response({
        profile: {
          id: 'vcp_ready',
          status: 'ready',
          enhancementMode: 'resemble-enhance',
        },
      }),
    );

    await expect(
      resolveGenerationTeachingVoiceProfileId(undefined, fetchProfile as typeof fetch, storage),
    ).resolves.toBeUndefined();
    expect(readTeachingVoiceSelection('en', storage)).toEqual({ enabled: false });
  });

  it('reconciles a stale saved profile id to the latest ready profile', async () => {
    const storage = memoryStorage();
    activateTeachingVoiceSelection('en', 'vcp_old', 'standard', storage);
    const fetchProfile = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      return url.includes('profileId=vcp_old')
        ? response({ profile: null }, false)
        : response({ profile: { id: 'vcp_current', status: 'ready' } });
    });

    await expect(
      resolveGenerationTeachingVoiceProfileId(undefined, fetchProfile as typeof fetch, storage),
    ).resolves.toBe('vcp_current');
    expect(fetchProfile).toHaveBeenNthCalledWith(
      1,
      '/api/voice-cloning/profile?language=en&profileId=vcp_old',
    );
    expect(fetchProfile).toHaveBeenNthCalledWith(2, '/api/voice-cloning/profile?language=en');
    expect(readTeachingVoiceSelection('en', storage)?.profileId).toBe('vcp_current');
  });

  it('restores only a persisted ready profile', async () => {
    const storage = memoryStorage();
    activateTeachingVoiceSelection('en', 'vcp_saved', 'standard', storage);
    const fetchProfile = vi.fn(async () =>
      response({ profile: { id: 'vcp_saved', status: 'ready', enhancementMode: 'standard' } }),
    );

    await expect(
      resolveGenerationTeachingVoiceProfileId(undefined, fetchProfile as typeof fetch, storage),
    ).resolves.toBe('vcp_saved');
    expect(fetchProfile).toHaveBeenCalledWith(
      '/api/voice-cloning/profile?language=en&profileId=vcp_saved',
    );
  });

  it('resolves a language-compatible profile without replacing another language selection', async () => {
    const storage = memoryStorage();
    activateTeachingVoiceSelection('en', 'vcp_english', 'standard', storage);
    activateTeachingVoiceSelection('hi', 'vcp_hindi', 'standard', storage);
    const fetchProfile = vi.fn(async () =>
      response({ profile: { id: 'vcp_hindi', status: 'ready', enhancementMode: 'standard' } }),
    );

    await expect(
      resolveGenerationTeachingVoiceProfileId(
        undefined,
        fetchProfile as typeof fetch,
        storage,
        'hi',
      ),
    ).resolves.toBe('vcp_hindi');
    expect(fetchProfile).toHaveBeenCalledWith(
      '/api/voice-cloning/profile?language=hi&profileId=vcp_hindi',
    );
    expect(readTeachingVoiceSelection('en', storage)?.profileId).toBe('vcp_english');
  });
});
