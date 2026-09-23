import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  generateTTS,
  TTSInvalidResponseError,
  TTSRateLimitError,
  TTSRequestTimeoutError,
} from '@/lib/audio/tts-providers';
import {
  DEFAULT_TTS_MODELS,
  DEFAULT_TTS_VOICES,
  isKnownTTSProviderId,
  TTS_PROVIDERS,
} from '@/lib/audio/constants';
import { INDIC_PARLER_VOICES } from '@/lib/audio/indic-parler';
import { isTTSProviderEnabled } from '@/lib/audio/provider-enablement';
import {
  getEnabledProvidersWithVoices,
  resolveNarratorVoiceBinding,
  getServerVoiceList,
} from '@/lib/audio/voice-resolver';
import { buildVoiceCatalog } from '@/lib/audio/voice-catalog';
import { splitLongSpeechActions } from '@/lib/audio/tts-utils';
import { resolveTTSProviderName } from '@/lib/audio/provider-display';

const providerId = 'indic-parler-tts' as const;
const fetchMock = vi.fn<typeof fetch>();
const wav = new Uint8Array([82, 73, 70, 70, 8, 0, 0, 0, 87, 65, 86, 69, 0, 0, 0, 0]);
beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock
    .mockReset()
    .mockImplementation(
      async () => new Response(wav, { headers: { 'content-type': 'audio/wav' } }),
    );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('Indic Parler normal TTS', () => {
  it('registers a keyless WAV provider without pretending the service has selectable models', () => {
    expect(isKnownTTSProviderId(providerId)).toBe(true);
    expect(TTS_PROVIDERS[providerId]).toMatchObject({
      requiresApiKey: false,
      defaultBaseUrl: 'http://127.0.0.1:8770',
      models: [],
      supportedFormats: ['wav'],
    });
    expect(DEFAULT_TTS_VOICES[providerId]).toBe('default');
    expect(DEFAULT_TTS_MODELS[providerId]).toBe('');
    expect(resolveTTSProviderName(providerId, (key) => key)).toBe(
      'settings.providerIndicParlerTTS',
    );
    expect(DEFAULT_TTS_MODELS['lemonade-tts']).toBe('kokoro-v1');
  });

  it('uses only the documented descriptions, with English/Hindi/Marathi choices', () => {
    const readme = readFileSync('services/indic-parler-tts/README.md', 'utf8');
    expect(INDIC_PARLER_VOICES.map((v) => v.language)).toEqual(['en', 'hi', 'mr']);
    for (const voice of INDIC_PARLER_VOICES) expect(readme).toContain(voice.description);
  });

  it('requires explicit configuration, honors opt-out, and participates in voice resolution/catalogs', () => {
    expect(isTTSProviderEnabled(providerId, {})).toBe(false);
    const config = { [providerId]: { isServerConfigured: true } };
    expect(isTTSProviderEnabled(providerId, config[providerId])).toBe(true);
    expect(isTTSProviderEnabled(providerId, { baseUrl: 'http://127.0.0.1:8770' })).toBe(true);
    expect(isTTSProviderEnabled(providerId, { ...config[providerId], enabled: false })).toBe(false);
    expect(isTTSProviderEnabled(providerId, { ...config[providerId], serverDisabled: true })).toBe(
      false,
    );
    const enabled = getEnabledProvidersWithVoices(config);
    expect(enabled.map((p) => p.providerId)).toEqual([providerId]);
    expect(getServerVoiceList(providerId)).toEqual([
      'default',
      'hindi-description',
      'marathi-description',
    ]);
    const global = { providerId, voiceId: 'marathi-description' };
    expect(resolveNarratorVoiceBinding(undefined, global, config)).toMatchObject(global);
    expect(
      buildVoiceCatalog(enabled.map((p) => ({ id: p.providerId, voices: p.voices }))),
    ).toContainEqual(expect.objectContaining({ binding: 'indic-parler-tts::marathi-description' }));
  });

  it.each(INDIC_PARLER_VOICES)(
    'sends only text/description for $id and returns normal WAV results',
    async (voice) => {
      const result = await generateTTS(
        { providerId, voice: voice.id, apiKey: 'must-not-send', modelId: 'ignored', speed: 2 },
        'Lesson text',
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('http://127.0.0.1:8770/synthesize');
      expect(JSON.parse(String(init?.body))).toEqual({
        text: 'Lesson text',
        description: voice.description,
      });
      expect(new Headers(init?.headers).has('authorization')).toBe(false);
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(result).toEqual({ audio: wav, format: 'wav' });
    },
  );

  it('resolves an explicit base URL and empty voice to the app default', async () => {
    await generateTTS(
      { providerId, baseUrl: 'http://configured.example/tts/', voice: '' },
      'Lesson',
    );
    expect(fetchMock.mock.calls[0][0]).toBe('http://configured.example/tts/synthesize');
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).description).toBe(
      INDIC_PARLER_VOICES[0].description,
    );
  });

  it.each([400, 429, 500, 503])(
    'surfaces HTTP %i without switching provider or leaking service details',
    async (status) => {
      fetchMock.mockResolvedValue(new Response('private backend details', { status }));
      const pending = generateTTS({ providerId, voice: 'default' }, 'Lesson');
      if (status === 429) await expect(pending).rejects.toBeInstanceOf(TTSRateLimitError);
      else await expect(pending).rejects.toThrow(`Indic Parler TTS API error (HTTP ${status}).`);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:8770/synthesize');
    },
  );

  it.each(['text/html', 'application/json'])('rejects non-audio %s responses', async (type) => {
    fetchMock.mockResolvedValue(
      new Response(type === 'text/html' ? '<html>error</html>' : '{}', {
        headers: { 'content-type': type },
      }),
    );
    await expect(generateTTS({ providerId, voice: 'default' }, 'Lesson')).rejects.toBeInstanceOf(
      TTSInvalidResponseError,
    );
  });

  it('rejects empty WAV, invalid descriptions and oversized text', async () => {
    fetchMock.mockResolvedValue(new Response('', { headers: { 'content-type': 'audio/wav' } }));
    await expect(generateTTS({ providerId, voice: 'default' }, 'Lesson')).rejects.toBeInstanceOf(
      TTSInvalidResponseError,
    );
    fetchMock.mockClear();
    await expect(generateTTS({ providerId, voice: 'fake-speaker' }, 'Lesson')).rejects.toThrow(
      'description choice',
    );
    await expect(generateTTS({ providerId, voice: 'default' }, 'x'.repeat(4001))).rejects.toThrow(
      '4000',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('splits long normal speech into service-sized actions', () => {
    const actions = splitLongSpeechActions(
      [{ id: 's', type: 'speech', text: 'x'.repeat(8001) }],
      providerId,
    );
    expect(actions).toHaveLength(3);
    expect(actions.map((a) => (a.type === 'speech' ? a.text.length : 0))).toEqual([4000, 4000, 1]);
  });

  it('keeps provider-specific timeout and caller cancellation in the normal TTS error contract', async () => {
    vi.stubEnv('TTS_INDIC_PARLER_TIMEOUT_MS', '10');
    const timeout = new DOMException('deadline', 'TimeoutError');
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(AbortSignal.abort(timeout));
    fetchMock.mockImplementation(async (_url, init) => {
      init?.signal?.throwIfAborted();
      return new Response(wav);
    });
    await expect(generateTTS({ providerId, voice: 'default' }, 'Lesson')).rejects.toBeInstanceOf(
      TTSRequestTimeoutError,
    );
    expect(AbortSignal.timeout).toHaveBeenCalledWith(10);
    const controller = new AbortController();
    const reason = new DOMException('caller', 'AbortError');
    controller.abort(reason);
    vi.mocked(AbortSignal.timeout).mockReturnValue(new AbortController().signal);
    await expect(
      generateTTS({ providerId, voice: 'default', signal: controller.signal }, 'Lesson'),
    ).rejects.toBe(reason);
  });
});
