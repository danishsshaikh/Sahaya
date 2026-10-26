import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  BodhanIndicSpeakPreviewProvider,
  bodhanSpeechEndpoint,
} from '@/lib/voice-comparison/providers/bodhan';
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
    const reference = pcmWav();
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
        referenceAudio: reference,
        referenceMimeType: 'audio/wav',
        referenceLanguage: 'en',
      }),
    ).resolves.toEqual({ voiceId: 'svc-12345678', referenceText: 'Reference text' });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.sarvam.test/voices/create');
    expect(init.headers).toEqual({ 'api-subscription-key': 'sarvam-secret' });
    const form = init.body as FormData;
    expect(form.get('language')).toBe('en-IN');
    expect(form.get('name')).toBe('Sahaya-vcp_owner_voice');
    expect(form.get('style')).toBeNull();
    const uploaded = form.get('file') as File;
    expect(uploaded).toBeInstanceOf(Blob);
    expect(uploaded.name).toBe('reference.wav');
    expect(
      createHash('sha256')
        .update(Buffer.from(await uploaded.arrayBuffer()))
        .digest('hex'),
    ).toBe(createHash('sha256').update(reference).digest('hex'));
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
        text: '  A classroom preview.  ',
        language: 'hi',
      }),
    ).resolves.toMatchObject({ audio: wav, requestId: 'req-sarvam' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const body = fetchMock.mock.calls[1]?.[1]?.body as FormData;
    expect(body.get('voice_id')).toBe('svc-12345678');
    expect(body.get('language_code')).toBe('hi-IN');
    expect(body.get('text')).toBe('  A classroom preview.  ');
    expect(body.get('output_audio_codec')).toBe('wav');
    expect(body.get('enable_vad')).toBe('false');
    expect(body.get('enable_text_normalization')).toBe('false');
    expect(body.get('enable_qc')).toBe('false');
    expect(body.get('speech_sample_rate')).toBeNull();
  });

  it('does not operate without explicit server configuration', async () => {
    const provider = new SarvamVoiceCloningPreviewProvider({ ...config, enabled: false });
    await expect(
      provider.createVoice({
        profileId: 'vcp_owner_voice',
        referenceAudio: pcmWav(),
        referenceMimeType: 'audio/wav',
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
      new Response(Buffer.from(pcmWav()), {
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

  it('constructs exactly one versioned speech endpoint', () => {
    expect(bodhanSpeechEndpoint('https://api.bodhan.ai')).toBe(
      'https://api.bodhan.ai/v1/audio/speech',
    );
    expect(bodhanSpeechEndpoint('https://api.bodhan.ai/v1')).toBe(
      'https://api.bodhan.ai/v1/audio/speech',
    );
    expect(bodhanSpeechEndpoint('https://api.bodhan.ai/v1/v1/')).toBe(
      'https://api.bodhan.ai/v1/audio/speech',
    );
  });

  it('accepts valid RIFF/WAVE bytes with a generic binary content type', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(Buffer.from(pcmWav()), {
          headers: { 'content-type': 'application/octet-stream' },
        }),
      ),
    );
    await expect(
      new BodhanIndicSpeakPreviewProvider(config).synthesize({
        text: 'Newton stays at rest.',
        language: 'en',
        voice: 'Prastuti',
        style: 'educational lecture',
      }),
    ).resolves.toMatchObject({ audio: pcmWav() });
  });

  it.each([
    [401, 'BODHAN_AUTH_ERROR', 401, 'authentication failed'],
    [403, 'BODHAN_PERMISSION_ERROR', 403, 'does not have access'],
    [429, 'BODHAN_RATE_LIMITED', 429, 'rate limit'],
    [503, 'BODHAN_UPSTREAM_ERROR', 502, 'temporarily unavailable'],
  ] as const)('classifies upstream HTTP %s safely', async (upstream, code, status, message) => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { code: 'SAFE_CODE', message: 'Safe detail' } }), {
          status: upstream,
          headers: { 'content-type': 'application/json', 'x-request-id': 'req-safe' },
        }),
      ),
    );
    await expect(
      new BodhanIndicSpeakPreviewProvider(config).synthesize({
        text: 'Private transcript.',
        language: 'en',
        voice: 'Prastuti',
      }),
    ).rejects.toMatchObject({ code, status, message: expect.stringContaining(message) });
  });

  it.each([
    [
      'JSON',
      JSON.stringify({ error: { code: 'MODEL_ERROR', message: 'Model unavailable' } }),
      'BODHAN_UPSTREAM_ERROR',
    ],
    ['HTML', '<!doctype html><html><body>gateway error</body></html>', 'BODHAN_UPSTREAM_ERROR'],
    ['empty', '', 'BODHAN_INVALID_AUDIO'],
    ['MP3', 'ID3not-wave', 'BODHAN_INVALID_AUDIO'],
    ['unknown binary', '\u0001\u0002\u0003\u0004', 'BODHAN_INVALID_AUDIO'],
  ])('does not mislabel a successful %s response as WAV', async (_label, body, code) => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(body, { headers: { 'content-type': 'application/octet-stream' } }),
        ),
    );
    await expect(
      new BodhanIndicSpeakPreviewProvider(config).synthesize({
        text: 'Preview',
        language: 'en',
        voice: 'Prastuti',
      }),
    ).rejects.toMatchObject({ code });
  });

  it('rejects truncated RIFF/WAVE data', async () => {
    const truncated = pcmWav().subarray(0, 46);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(Buffer.from(truncated), { status: 200 })),
    );
    await expect(
      new BodhanIndicSpeakPreviewProvider(config).synthesize({
        text: 'Preview',
        language: 'en',
        voice: 'Prastuti',
      }),
    ).rejects.toMatchObject({ code: 'BODHAN_INVALID_AUDIO' });
  });

  it('classifies timeouts without exposing request text', async () => {
    const timeout = new Error('timed out');
    timeout.name = 'TimeoutError';
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(timeout));
    await expect(
      new BodhanIndicSpeakPreviewProvider(config).synthesize({
        text: 'Private classroom transcript',
        language: 'en',
        voice: 'Prastuti',
      }),
    ).rejects.toMatchObject({ code: 'BODHAN_TIMEOUT', status: 504 });
  });

  it('redacts an echoed transcript from bounded provider diagnostics', async () => {
    const transcript = 'Private classroom transcript';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { message: transcript } }), {
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    try {
      await new BodhanIndicSpeakPreviewProvider(config).synthesize({
        text: transcript,
        language: 'en',
        voice: 'Prastuti',
      });
      throw new Error('Expected Bodhan synthesis to fail');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'BODHAN_UPSTREAM_ERROR',
        metadata: { safeDetail: '[input omitted]' },
      });
      expect((error as Error).message).not.toContain(transcript);
    }
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
