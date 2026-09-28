import { describe, expect, it, vi } from 'vitest';
import { resolveGenerationTeachingVoiceProfileId } from '@/lib/voice-cloning/selection-client';

function response(body: unknown, ok = true): Response {
  return {
    ok,
    json: vi.fn(async () => body),
  } as unknown as Response;
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
});
