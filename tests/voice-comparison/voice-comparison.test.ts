import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VoiceProfile } from '@/lib/voice-cloning/types';

let storageDir: string;

function pcmWav(): Uint8Array {
  const bytes = new Uint8Array(48);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode('RIFF'), 0);
  view.setUint32(4, 40, true);
  bytes.set(new TextEncoder().encode('WAVEfmt '), 8);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 24000, true);
  view.setUint32(28, 48000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  bytes.set(new TextEncoder().encode('data'), 36);
  view.setUint32(40, 4, true);
  return bytes;
}

function profile(ownerId = 'usr_owner'): VoiceProfile {
  return {
    id: 'vcp_existing',
    ownerId,
    displayName: 'Teaching Voice',
    provider: 'chatterbox',
    language: 'en',
    status: 'ready',
    createdAt: '2026-10-26T00:00:00.000Z',
    updatedAt: '2026-10-26T00:00:00.000Z',
    consentTimestamp: '2026-10-26T00:00:00.000Z',
    consentVersion: 'faculty-self-voice-v1',
    referenceText: 'This is the exact reference transcript.',
    providerReferenceId: 'vcp_existing',
    modelVariant: 'v3',
    profileVersion: 1,
  };
}

describe('voice comparison coordinator', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    storageDir = await mkdtemp(join(tmpdir(), 'sahaya-comparison-'));
    vi.stubEnv('VOICE_CLONING_STORAGE_DIR', storageDir);
    vi.stubEnv('SARVAM_VOICE_CLONING_ENABLED', 'true');
    vi.stubEnv('SARVAM_API_KEY', 'sarvam-secret');
    vi.stubEnv('SARVAM_API_BASE_URL', 'https://api.sarvam.test');
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await rm(storageDir, { recursive: true, force: true });
  });

  it('requires external consent, stores a private remote id, and reuses it and cached audio', async () => {
    const storage = await import('@/lib/voice-cloning/storage');
    const original = profile();
    const referenceAudioKey = await storage.writeReferenceAudio(
      original.id,
      original.ownerId,
      pcmWav(),
    );
    await storage.writeVoiceProfile({ ...original, referenceAudioKey });
    const wav = pcmWav();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { voice_id: 'svc-12345678' } }), {
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ audio_b64: Buffer.from(wav).toString('base64') }), {
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ audio_b64: Buffer.from(wav).toString('base64') }), {
          headers: { 'content-type': 'application/json' },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const { generateVoiceComparisonPreview } = await import('@/lib/server/voice-comparison');
    const request = {
      profileId: original.id,
      providerId: 'sarvam' as const,
      text: 'Teach the first law of motion.',
      language: 'en' as const,
    };

    await expect(
      generateVoiceComparisonPreview({ ownerId: original.ownerId, request }),
    ).rejects.toThrow('Consent is required');
    expect(fetchMock).not.toHaveBeenCalled();

    const first = await generateVoiceComparisonPreview({
      ownerId: original.ownerId,
      request: { ...request, sarvamExternalConsent: true },
    });
    expect(first.cached).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const stored = await storage.readVoiceProfile(original.id, original.ownerId);
    expect(stored?.providerReferenceId).toBe('vcp_existing');
    expect(stored?.provider).toBe('chatterbox');
    expect(stored?.sarvamVoice?.voiceId).toBe('svc-12345678');
    const { toPublicVoiceProfile } = await import('@/lib/voice-cloning/types');
    const publicProfile = toPublicVoiceProfile(stored);
    expect(publicProfile?.sarvamVoice).toMatchObject({ ready: true });
    expect(JSON.stringify(publicProfile)).not.toContain('svc-12345678');

    const cached = await generateVoiceComparisonPreview({ ownerId: original.ownerId, request });
    expect(cached.cached).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await generateVoiceComparisonPreview({
      ownerId: original.ownerId,
      request: { ...request, text: 'Teach the second law of motion.' },
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect((fetchMock.mock.calls[2]?.[1]?.body as FormData).get('voice_id')).toBe('svc-12345678');
  });

  it('does not expose or use another owner profile', async () => {
    const storage = await import('@/lib/voice-cloning/storage');
    await storage.writeVoiceProfile(profile('usr_owner'));
    const { requireOwnedReadyProfile } = await import('@/lib/server/voice-comparison');
    await expect(requireOwnedReadyProfile('usr_other', 'vcp_existing')).rejects.toMatchObject({
      status: 404,
    });
  });

  it('reports disabled metered providers without affecting local capabilities', async () => {
    vi.stubEnv('SARVAM_VOICE_CLONING_ENABLED', 'false');
    const { getVoiceComparisonBootstrap } = await import('@/lib/server/voice-comparison');
    const bootstrap = getVoiceComparisonBootstrap({
      ...profile(),
      referenceAudioKey: '/private/reference.wav',
    });
    expect(bootstrap.providers.find(({ id }) => id === 'sarvam')).toMatchObject({
      configured: false,
      available: false,
      unavailableReason: 'Not configured',
    });
    expect(bootstrap.providers.find(({ id }) => id === 'chatterbox')).toMatchObject({
      configured: true,
      available: true,
      supportsClassroom: true,
    });
  });
});
