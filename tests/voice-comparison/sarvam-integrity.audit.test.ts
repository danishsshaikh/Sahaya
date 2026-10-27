// Synthetic-only end-to-end integrity proof; never reads a faculty recording.
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function pcmWav(marker: number): Uint8Array {
  const bytes = new Uint8Array(52);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode('RIFF'), 0);
  view.setUint32(4, 44, true);
  bytes.set(new TextEncoder().encode('WAVEfmt '), 8);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 24000, true);
  view.setUint32(28, 48000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  bytes.set(new TextEncoder().encode('data'), 36);
  view.setUint32(40, 8, true);
  bytes.fill(marker, 44);
  return bytes;
}

let storageDir = '';

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
  if (storageDir) await rm(storageDir, { recursive: true, force: true });
});

it('preserves synthetic upload bytes through Sarvam multipart and response/cache/API transport', async () => {
  storageDir = await mkdtemp(join(tmpdir(), 'sahaya-sarvam-audit-'));
  vi.stubEnv('VOICE_CLONING_STORAGE_DIR', storageDir);
  vi.stubEnv('SARVAM_VOICE_CLONING_ENABLED', 'true');
  vi.stubEnv('SARVAM_API_KEY', 'synthetic-test-key');
  vi.stubEnv('SARVAM_API_BASE_URL', 'https://sarvam.invalid');

  const source = new Uint8Array(256);
  source.set(new TextEncoder().encode('OggS-synthetic-browser-recording'));
  for (let index = 32; index < source.length; index += 1) source[index] = index % 251;

  const { getVoiceEnrollmentPhrases } = await import('@/lib/voice-cloning/phrases');
  const phrase = getVoiceEnrollmentPhrases('en')[0];
  const form = new FormData();
  form.set('attemptId', 'audit_attempt_123');
  form.set('consent', 'true');
  form.set('displayName', 'Synthetic audit voice');
  form.set('languageId', 'en');
  form.set('phraseId', phrase.id);
  form.set('referenceText', phrase.text);
  form.set('recording', new Blob([source], { type: 'audio/ogg;codecs=opus' }), 'capture.ogg');

  const { parseVoiceEnrollmentForm } = await import('@/lib/server/voice-enrollment-jobs');
  const parsed = await parseVoiceEnrollmentForm(form, 'usr_audit');
  expect(sha256(parsed.recording.bytes)).toBe(sha256(source));

  const storage = await import('@/lib/voice-cloning/storage');
  const profileId = 'vcp_audit';
  const originalRecording = await storage.writeOriginalRecording(
    profileId,
    'usr_audit',
    parsed.recording,
  );
  const diskOriginal = new Uint8Array(await readFile(originalRecording.key));
  expect(sha256(diskOriginal)).toBe(sha256(source));

  const processedReference = pcmWav(0x11);
  const referenceAudioKey = await storage.writeReferenceAudio(
    profileId,
    'usr_audit',
    processedReference,
  );
  expect(sha256(processedReference)).not.toBe(sha256(source));
  await storage.writeVoiceProfile({
    id: profileId,
    ownerId: 'usr_audit',
    displayName: 'Synthetic audit voice',
    provider: 'chatterbox',
    language: 'en',
    languageId: 'en',
    status: 'ready',
    createdAt: '2026-10-27T00:00:00.000Z',
    updatedAt: '2026-10-27T00:00:00.000Z',
    consentTimestamp: '2026-10-27T00:00:00.000Z',
    consentVersion: 'faculty-self-voice-v1',
    profileVersion: 1,
    referenceAudioKey,
    referenceText: phrase.text,
    providerReferenceId: profileId,
    originalRecording,
  });

  const providerAudio = pcmWav(0x7a);
  let multipartFileBytes: Uint8Array | undefined;
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    if (url.endsWith('/voices/create')) {
      const file = (init.body as FormData).get('file') as File;
      multipartFileBytes = new Uint8Array(await file.arrayBuffer());
      return new Response(JSON.stringify({ data: { voice_id: 'svc-audit12345678' } }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.endsWith('/voices/clone')) {
      return new Response(
        JSON.stringify({ audio_b64: Buffer.from(providerAudio).toString('base64') }),
        { headers: { 'content-type': 'application/json' } },
      );
    }
    throw new Error(`Unexpected URL: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);

  const { generateVoiceComparisonPreview } = await import('@/lib/server/voice-comparison');
  const result = await generateVoiceComparisonPreview({
    ownerId: 'usr_audit',
    request: {
      profileId,
      providerId: 'sarvam',
      text: "Newton's first law.",
      language: 'en',
      sarvamExternalConsent: true,
    },
  });

  expect(multipartFileBytes).toBeDefined();
  expect(sha256(multipartFileBytes!)).toBe(sha256(source));
  expect(sha256(multipartFileBytes!)).not.toBe(sha256(processedReference));
  const resultBytes = new Uint8Array(Buffer.from(result.audio.base64, 'base64'));
  expect(sha256(resultBytes)).toBe(sha256(providerAudio));

  const cacheFile = join(storageDir, 'users', 'usr_audit', 'voice-comparisons', 'cache.json');
  const cache = JSON.parse(await readFile(cacheFile, 'utf8')) as {
    entries: Array<{ audio: { base64: string } }>;
  };
  const cachedBytes = new Uint8Array(Buffer.from(cache.entries[0].audio.base64, 'base64'));
  expect(sha256(cachedBytes)).toBe(sha256(providerAudio));

  const { apiSuccess } = await import('@/lib/server/api-response');
  const served = (await apiSuccess({ preview: result }).json()) as {
    preview: { audio: { base64: string } };
  };
  const servedBytes = new Uint8Array(Buffer.from(served.preview.audio.base64, 'base64'));
  expect(sha256(servedBytes)).toBe(sha256(providerAudio));
});
