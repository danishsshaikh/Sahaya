import { afterEach, describe, expect, it, vi } from 'vitest';
import { Qwen3TtsPreviewProvider } from '@/lib/voice-cloning/providers/qwen3-preview';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('Qwen3-TTS preview provider', () => {
  it('registers the saved reference transcript and generates English WAV audio', async () => {
    vi.stubEnv('QWEN3_TTS_BASE_URL', 'http://127.0.0.1:8771');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ providerReferenceId: 'vcp_existing' }), {
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(new Uint8Array([82, 73, 70, 70]), {
          headers: { 'content-type': 'audio/wav' },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const provider = new Qwen3TtsPreviewProvider();

    await provider.registerProfile({
      profileId: 'vcp_existing',
      referenceAudioPath: '/private/reference.wav',
      referenceText: 'This is the exact English transcript.',
    });
    const result = await provider.generatePreview({
      profileId: 'vcp_existing',
      text: 'Welcome to today’s lesson.',
    });

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      profileId: 'vcp_existing',
      referenceAudioPath: '/private/reference.wav',
      referenceText: 'This is the exact English transcript.',
      referenceLanguage: 'en',
    });
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      profileId: 'vcp_existing',
      text: 'Welcome to today’s lesson.',
      language: 'en',
    });
    expect(result).toEqual({ audio: new Uint8Array([82, 73, 70, 70]), format: 'wav' });
  });

  it('returns an actionable busy error without falling back to another provider', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ detail: 'generation in progress' }), {
          status: 429,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    await expect(
      new Qwen3TtsPreviewProvider().generatePreview({ profileId: 'vcp_existing', text: 'Hello' }),
    ).rejects.toMatchObject({
      status: 429,
      metadata: { provider: 'qwen3-tts', endpoint: '/synthesize' },
    });
  });
});
