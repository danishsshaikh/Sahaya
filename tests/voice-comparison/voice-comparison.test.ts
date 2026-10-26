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
    const originalBytes = pcmWav();
    const originalRecording = await storage.writeOriginalRecording(original.id, original.ownerId, {
      bytes: originalBytes,
      mimeType: 'audio/wav',
      fileName: 'original.wav',
    });
    await storage.writeVoiceProfile({ ...original, referenceAudioKey, originalRecording });
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
    expect(first.processingMode).toBe('raw-provider-output');
    expect(first.referenceProvenance).toBe('original-upload');
    expect(Buffer.from(first.audio.base64, 'base64')).toEqual(Buffer.from(wav));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const stored = await storage.readVoiceProfile(original.id, original.ownerId);
    expect(stored?.providerReferenceId).toBe('vcp_existing');
    expect(stored?.provider).toBe('chatterbox');
    expect(stored?.sarvamRawVoice?.voiceId).toBe('svc-12345678');
    expect(stored?.sarvamRawVoice?.referenceProvenance).toBe('original-upload');
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
    expect((fetchMock.mock.calls[2]?.[1]?.body as FormData).get('text')).toBe(
      'Teach the second law of motion.',
    );
  });

  it('preserves and reuses an existing processed-reference clone without recreating it', async () => {
    const storage = await import('@/lib/voice-cloning/storage');
    const original = profile();
    const referenceAudioKey = await storage.writeReferenceAudio(
      original.id,
      original.ownerId,
      pcmWav(),
    );
    await storage.writeVoiceProfile({
      ...original,
      referenceAudioKey,
      sarvamVoice: {
        voiceId: 'svc-legacy1234',
        consentTimestamp: '2026-10-26T00:00:00.000Z',
        consentVersion: 'sarvam-external-voice-v1',
        createdAt: '2026-10-26T00:00:00.000Z',
        referenceAudioKey,
        profileVersion: 1,
        referenceLanguage: 'en',
      },
    });
    const wav = pcmWav();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ audio_b64: Buffer.from(wav).toString('base64') }), {
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { generateVoiceComparisonPreview, getVoiceComparisonBootstrap } =
      await import('@/lib/server/voice-comparison');
    const result = await generateVoiceComparisonPreview({
      ownerId: original.ownerId,
      request: {
        profileId: original.id,
        providerId: 'sarvam',
        text: ' Unchanged text. ',
        language: 'en',
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/voices/clone');
    expect((fetchMock.mock.calls[0]?.[1]?.body as FormData).get('voice_id')).toBe('svc-legacy1234');
    expect((fetchMock.mock.calls[0]?.[1]?.body as FormData).get('text')).toBe(' Unchanged text. ');
    expect(result.referenceProvenance).toBe('processed-reference');
    expect(
      getVoiceComparisonBootstrap(
        (await storage.readVoiceProfile(original.id, original.ownerId)) as VoiceProfile,
      ).providers.find(({ id }) => id === 'sarvam'),
    ).toMatchObject({
      externalVoiceReady: true,
      requiresExternalConsent: false,
      sarvamReferenceProvenance: 'processed-reference',
    });
  });

  it('does not create a new remote voice from a transformed legacy reference', async () => {
    const storage = await import('@/lib/voice-cloning/storage');
    const original = profile();
    const referenceAudioKey = await storage.writeReferenceAudio(
      original.id,
      original.ownerId,
      pcmWav(),
    );
    await storage.writeVoiceProfile({ ...original, referenceAudioKey });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { generateVoiceComparisonPreview } = await import('@/lib/server/voice-comparison');
    await expect(
      generateVoiceComparisonPreview({
        ownerId: original.ownerId,
        request: {
          profileId: original.id,
          providerId: 'sarvam',
          text: 'Preview',
          language: 'en',
          sarvamExternalConsent: true,
        },
      }),
    ).rejects.toThrow('original recording was not retained');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects text over the single-response Sarvam limit before any paid voice creation', async () => {
    const storage = await import('@/lib/voice-cloning/storage');
    const original = profile();
    const referenceAudioKey = await storage.writeReferenceAudio(
      original.id,
      original.ownerId,
      pcmWav(),
    );
    const originalRecording = await storage.writeOriginalRecording(original.id, original.ownerId, {
      bytes: pcmWav(),
      mimeType: 'audio/wav',
      fileName: 'original.wav',
    });
    await storage.writeVoiceProfile({ ...original, referenceAudioKey, originalRecording });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { generateVoiceComparisonPreview } = await import('@/lib/server/voice-comparison');
    await expect(
      generateVoiceComparisonPreview({
        ownerId: original.ownerId,
        request: {
          profileId: original.id,
          providerId: 'sarvam',
          text: 'x'.repeat(1001),
          language: 'en',
          sarvamExternalConsent: true,
        },
      }),
    ).rejects.toThrow('limited to 1000 characters');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('creates a raw-reference clone only by explicit consent and preserves the legacy id', async () => {
    const storage = await import('@/lib/voice-cloning/storage');
    const original = profile();
    const referenceAudioKey = await storage.writeReferenceAudio(
      original.id,
      original.ownerId,
      pcmWav(),
    );
    const originalRecording = await storage.writeOriginalRecording(original.id, original.ownerId, {
      bytes: pcmWav(),
      mimeType: 'audio/wav',
      fileName: 'original.wav',
    });
    await storage.writeVoiceProfile({
      ...original,
      referenceAudioKey,
      originalRecording,
      sarvamVoice: {
        voiceId: 'svc-legacy1234',
        consentTimestamp: '2026-10-26T00:00:00.000Z',
        consentVersion: 'sarvam-external-voice-v1',
        createdAt: '2026-10-26T00:00:00.000Z',
        referenceAudioKey,
        profileVersion: 1,
        referenceLanguage: 'en',
      },
    });
    const wav = pcmWav();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { voice_id: 'svc-raw123456' } }), {
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
      text: 'Raw preview',
      language: 'en' as const,
      sarvamCreateRawVoice: true,
    };
    await expect(
      generateVoiceComparisonPreview({ ownerId: original.ownerId, request }),
    ).rejects.toThrow('Consent is required');
    expect(fetchMock).not.toHaveBeenCalled();

    await generateVoiceComparisonPreview({
      ownerId: original.ownerId,
      request: { ...request, sarvamExternalConsent: true },
    });
    const stored = await storage.readVoiceProfile(original.id, original.ownerId);
    expect(stored?.sarvamVoice?.voiceId).toBe('svc-legacy1234');
    expect(stored?.sarvamRawVoice?.voiceId).toBe('svc-raw123456');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/voices/create');
    expect((fetchMock.mock.calls[1]?.[1]?.body as FormData).get('voice_id')).toBe('svc-raw123456');
  });

  it('does not present a legacy processed cache entry as a raw Sarvam result', async () => {
    const storage = await import('@/lib/voice-cloning/storage');
    const cache = await import('@/lib/server/voice-comparison-cache');
    const original = profile();
    const referenceAudioKey = await storage.writeReferenceAudio(
      original.id,
      original.ownerId,
      pcmWav(),
    );
    const originalRecording = await storage.writeOriginalRecording(original.id, original.ownerId, {
      bytes: pcmWav(),
      mimeType: 'audio/wav',
      fileName: 'original.wav',
    });
    await storage.writeVoiceProfile({
      ...original,
      referenceAudioKey,
      originalRecording,
      sarvamRawVoice: {
        voiceId: 'svc-rawcache123',
        consentTimestamp: '2026-10-26T00:00:00.000Z',
        consentVersion: 'sarvam-external-voice-raw-v2',
        createdAt: '2026-10-26T00:00:00.000Z',
        referenceAudioKey: originalRecording.key,
        profileVersion: 1,
        referenceLanguage: 'en',
        referenceProvenance: 'original-upload',
        referenceMimeType: 'audio/wav',
      },
    });
    const text = 'Raw cache check.';
    const legacyKey = cache.createVoiceComparisonCacheKey({
      ownerId: original.ownerId,
      profileId: original.id,
      profileVersion: 1,
      referenceAudioKey,
      providerId: 'sarvam',
      language: 'en',
      text,
      voice: null,
      style: null,
      sarvamVoiceId: 'svc-rawcache123',
      modelVariant: null,
      generationSettings: null,
      qwenCloneMode: null,
    });
    await cache.writeVoiceComparisonCache(original.ownerId, {
      providerId: 'sarvam',
      providerName: 'Sarvam AI',
      voiceType: 'cloned',
      language: 'en',
      audio: {
        format: 'wav',
        base64: Buffer.from(pcmWav().map(() => 7)).toString('base64'),
        createdAt: '2026-10-26T00:00:00.000Z',
      },
      durationSeconds: 1,
      generationLatencyMs: 1,
      generatedAt: '2026-10-26T00:00:00.000Z',
      cached: false,
      cacheKey: legacyKey,
    });
    const providerAudio = pcmWav();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ audio_b64: Buffer.from(providerAudio).toString('base64') }), {
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { generateVoiceComparisonPreview } = await import('@/lib/server/voice-comparison');
    const result = await generateVoiceComparisonPreview({
      ownerId: original.ownerId,
      request: {
        profileId: original.id,
        providerId: 'sarvam',
        text,
        language: 'en',
      },
    });
    expect(result.cached).toBe(false);
    expect(result.cacheKey).not.toBe(legacyKey);
    expect(Buffer.from(result.audio.base64, 'base64')).toEqual(Buffer.from(providerAudio));
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
