import { afterEach, describe, expect, it, vi } from 'vitest';
import { Qwen3VoiceCloningProvider } from '@/lib/voice-cloning/providers/qwen3';
import { IndicF5VoiceCloningProvider } from '@/lib/voice-cloning/providers/indicf5';
import { getVoiceCloningProvider } from '@/lib/voice-cloning/provider';
import { getTeachingVoiceServiceConfig } from '@/lib/voice-cloning/config';
import { normalizeIndicTeachingText } from '@/lib/voice-cloning/indic-text-normalizer';
import { getVoiceEnrollmentPhrases, getVoicePreviewText } from '@/lib/voice-cloning/phrases';
import { newTeachingVoiceProvider, resolveTeachingVoiceLanguage, validateTeachingVoiceLanguage } from '@/lib/voice-cloning/language';
import { resolveVoiceProfileProvider, toPublicVoiceProfile, VoiceProviderProfileNotFoundError, type VoiceProfile } from '@/lib/voice-cloning/types';

function profile(provider = 'indicf5', language = 'hi'): VoiceProfile {
  return {
    id: 'vcp_example', ownerId: 'usr_example', displayName: 'Teaching Voice',
    provider, language, status: 'ready', profileVersion: 1,
    createdAt: '', updatedAt: '', consentTimestamp: '', consentVersion: 'test',
    referenceText: 'Exact approved transcript',
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('Teaching Voice language boundary', () => {
  it.each([
    ['en-US', 'en'], ['Teach in Hindi.', 'hi'], ['Teach in Marathi.', 'mr'],
    ['मराठी', 'mr'], ['hi_IN', 'hi'], ['English and Hindi', null], ['Unspecified', null],
  ])('resolves %s without silently defaulting to English', (input, expected) => {
    expect(resolveTeachingVoiceLanguage(input)).toBe(expected);
  });

  it('routes new enrollments while retaining absent legacy provider metadata', () => {
    expect(newTeachingVoiceProvider('en')).toBe('qwen3');
    expect(newTeachingVoiceProvider('hi')).toBe('indicf5');
    expect(newTeachingVoiceProvider('mr')).toBe('indicf5');
    expect(() => newTeachingVoiceProvider('fr')).toThrow();
    expect(resolveVoiceProfileProvider({})).toBe('chatterbox');
    expect(() => getVoiceCloningProvider('unknown')).toThrow('Unsupported');
    vi.stubEnv('VOICE_CLONING_PROVIDER', 'chatterbox');
    expect(getVoiceCloningProvider('qwen3')).toBeInstanceOf(Qwen3VoiceCloningProvider);
  });

  it('rejects cross-language references, missing transcripts and missing target language', () => {
    expect(() => validateTeachingVoiceLanguage(profile(), 'mr')).toThrow('does not match');
    expect(() => validateTeachingVoiceLanguage(profile('qwen3', 'hi'), 'hi')).toThrow('English');
    expect(() => validateTeachingVoiceLanguage(profile('indicf5', 'en'), 'en')).toThrow('Hindi or Marathi');
    expect(() => validateTeachingVoiceLanguage({ ...profile(), referenceText: undefined }, 'hi')).toThrow('transcript');
    expect(() => validateTeachingVoiceLanguage(profile())).toThrow('narration language');
    expect(validateTeachingVoiceLanguage({ ...profile('chatterbox', 'en'), referenceText: undefined })).toBe('en');
  });

  it('keeps private transcripts and Chatterbox fields out of new public profiles', () => {
    const result = toPublicVoiceProfile(profile());
    expect(result).not.toHaveProperty('referenceText');
    expect(result).not.toHaveProperty('modelVariant');
    expect(result).not.toHaveProperty('generationSettings');
  });

  it.each(['hi', 'mr'])('has an approved recording phrase and Indic preview for %s', (language) => {
    expect(getVoiceEnrollmentPhrases(language)[0].text).toMatch(/[\u0900-\u097f]/);
    expect(getVoicePreviewText(language, 'indicf5')).not.toMatch(/[a-z]/i);
  });
});

describe('Indic outgoing text only', () => {
  it('replaces phrases before tokens and preserves punctuation and existing Indic text', () => {
    const original = 'आज Neural Networks, TRAINING process; prediction! न्यूरल नेटवर्क pretraining.';
    expect(normalizeIndicTeachingText(original, 'hi')).toBe(
      'आज न्यूरल नेटवर्क, ट्रेनिंग प्रक्रिया; प्रेडिक्शन! न्यूरल नेटवर्क pretraining.',
    );
    expect(original).toContain('Neural Networks');
    expect(normalizeIndicTeachingText(original, 'en')).toBe(original);
    expect(normalizeIndicTeachingText('backpropagation, gradient descent, internal weights, loss function', 'mr'))
      .toBe('बॅकप्रोपेगेशन, ग्रेडियंट डिसेंट, इंटरनल वेट्स, लॉस फंक्शन');
  });
});

describe('isolated Teaching Voice adapters', () => {
  it('accepts reachable lazy health but surfaces a model-load error', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ ok: false, modelLoaded: false, error: null }))
      .mockResolvedValueOnce(Response.json({ ok: false, modelLoaded: false, error: 'private error' }));
    vi.stubGlobal('fetch', fetchMock);
    const provider = new Qwen3VoiceCloningProvider();
    await expect(provider.healthCheck()).resolves.toMatchObject({ ok: true, modelLoaded: false });
    await expect(provider.healthCheck()).rejects.toThrow('model failed to load');
  });

  it('sends the exact reference transcript and no Chatterbox settings', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ providerReferenceId: 'vcp_example' }));
    vi.stubGlobal('fetch', fetchMock);
    await new Qwen3VoiceCloningProvider().createProfile({
      profileId: 'vcp_example', referenceAudioKey: '/shared/reference.wav',
      referenceText: ' Exact transcript. ', language: 'en', modelVariant: 'v3',
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      profileId: 'vcp_example', referenceAudioPath: '/shared/reference.wav',
      referenceText: ' Exact transcript. ', language: 'en',
    });
  });

  it('normalizes only IndicF5 payloads and rejects unsupported languages before fetch', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response(new Uint8Array([1]), {
      headers: { 'Content-Type': 'audio/wav' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const input = { providerReferenceId: 'vcp_example', text: 'training process', language: 'hi' };
    await new IndicF5VoiceCloningProvider().synthesize(input);
    expect(input.text).toBe('training process');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).text).toBe('ट्रेनिंग प्रक्रिया');
    await new Qwen3VoiceCloningProvider().synthesize({ ...input, language: 'en' });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).text).toBe('training process');
    await expect(new IndicF5VoiceCloningProvider().synthesize({ ...input, language: 'en' })).rejects.toThrow('Unsupported');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('classifies only a missing profile as recoverable and never retries transport errors', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ detail: 'voice profile not found' }, { status: 404 }))
      .mockRejectedValueOnce(new Error('private server path'));
    vi.stubGlobal('fetch', fetchMock);
    const provider = new Qwen3VoiceCloningProvider();
    const request = { providerReferenceId: 'vcp_example', text: 'Hello', language: 'en' };
    await expect(provider.synthesize(request)).rejects.toBeInstanceOf(VoiceProviderProfileNotFoundError);
    await expect(provider.synthesize(request)).rejects.toThrow('unreachable');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('uses provider-specific overrides and times out without another provider request', async () => {
    vi.stubEnv('QWEN3_VOICE_CLONING_BASE_URL', 'http://127.0.0.1:9871');
    vi.stubEnv('QWEN3_VOICE_CLONING_TIMEOUT_MS', '10');
    vi.stubEnv('INDICF5_VOICE_CLONING_TIMEOUT_MS', '900000');
    expect(getTeachingVoiceServiceConfig('indicf5').timeoutMs).toBe(900000);
    vi.useFakeTimers();
    const fetchMock = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    vi.stubGlobal('fetch', fetchMock);
    const result = new Qwen3VoiceCloningProvider().synthesize({ providerReferenceId: 'vcp_example', text: 'Hello', language: 'en' });
    const assertion = expect(result).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(10);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:9871/synthesize');
  });
});
