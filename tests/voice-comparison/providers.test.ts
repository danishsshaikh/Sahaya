import { afterEach, describe, expect, it, vi } from 'vitest';
import { BodhanIndicSpeakPreviewProvider } from '@/lib/voice-comparison/providers/bodhan';
import { SarvamVoiceCloningPreviewProvider } from '@/lib/voice-comparison/providers/sarvam';

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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Sarvam voice cloning preview provider', () => {
  const config = {
    enabled: true,
    apiKey: 'sarvam-secret',
    baseUrl: 'https://api.sarvam.test',
    timeoutMs: 5000,
    maxConcurrency: 1,
  };

  it('creates a reusable voice with the documented multipart contract', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ data: { voice_id: 'svc-12345678', reference_text: 'Reference text' } }),
          { headers: { 'content-type': 'application/json' } },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      new SarvamVoiceCloningPreviewProvider(config).createVoice({
        profileId: 'vcp_owner_voice',
        referenceAudio: pcmWav(),
        referenceLanguage: 'en',
      }),
    ).resolves.toEqual({ voiceId: 'svc-12345678', referenceText: 'Reference text' });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.sarvam.test/voices/create');
    expect(init.headers).toEqual({ 'api-subscription-key': 'sarvam-secret' });
    const form = init.body as FormData;
    expect(form.get('language')).toBe('en-IN');
    expect(form.get('name')).toBe('Sahaya-vcp_owner_voice');
    expect(form.get('file')).toBeInstanceOf(Blob);
  });

  it('synthesizes WAV with a saved voice id and retries one short 429', async () => {
    const wav = pcmWav();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'retry-after': '0' } }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ audio_b64: Buffer.from(wav).toString('base64') }), {
          headers: { 'content-type': 'application/json', 'x-request-id': 'req-sarvam' },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      new SarvamVoiceCloningPreviewProvider(config).synthesize({
        voiceId: 'svc-12345678',
        text: 'A classroom preview.',
        language: 'hi',
      }),
    ).resolves.toMatchObject({ audio: wav, requestId: 'req-sarvam' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const body = fetchMock.mock.calls[1]?.[1]?.body as FormData;
    expect(body.get('voice_id')).toBe('svc-12345678');
    expect(body.get('language_code')).toBe('hi-IN');
  });

  it('does not operate without explicit server configuration', async () => {
    const provider = new SarvamVoiceCloningPreviewProvider({ ...config, enabled: false });
    await expect(
      provider.createVoice({
        profileId: 'vcp_owner_voice',
        referenceAudio: pcmWav(),
        referenceLanguage: 'en',
      }),
    ).rejects.toMatchObject({ status: 503 });
  });
});

describe('Bodhan Indic-Speak preview provider', () => {
  const config = {
    enabled: true,
    apiKey: 'bodhan-secret',
    baseUrl: 'https://api.bodhan.test/v1',
    timeoutMs: 5000,
    maxConcurrency: 2,
  };

  it('uses the documented model, voice and JSON-encoded instructions', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(pcmWav(), {
        headers: { 'content-type': 'audio/wav', 'x-request-id': 'req-bodhan' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      new BodhanIndicSpeakPreviewProvider(config).synthesize({
        text: 'आज आपण न्यूटनचा नियम शिकू.',
        language: 'mr',
        voice: 'Anagha',
        style: 'educational lecture',
      }),
    ).resolves.toMatchObject({ requestId: 'req-bodhan' });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.bodhan.test/v1/audio/speech');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer bodhan-secret' });
    expect(JSON.parse(String(init.body))).toEqual({
      model: 'indic-speak',
      input: 'आज आपण न्यूटनचा नियम शिकू.',
      voice: 'Anagha',
      instructions: JSON.stringify({ lang: 'mr', style: 'educational lecture' }),
    });
  });

  it('rejects invented voices and styles before making a paid request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      new BodhanIndicSpeakPreviewProvider(config).synthesize({
        text: 'Preview',
        language: 'en',
        voice: 'Invented',
      }),
    ).rejects.toThrow('Unsupported Bodhan voice');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
