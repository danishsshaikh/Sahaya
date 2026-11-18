import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_QWEN_SYNTHESIS_CHUNK_CHARACTERS,
  Qwen3TtsVoiceCloningProvider,
  splitQwenSynthesisTextPreservingText,
} from '@/lib/voice-cloning/providers/qwen3-preview';
import { clearQwen3TtsCapacityForTests } from '@/lib/server/qwen3-tts-capacity';
import { readWavMetadata } from '@/lib/voice-comparison/audio';

function pcmWav(samples: number[]): Uint8Array {
  const output = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(output.buffer);
  output.set(new TextEncoder().encode('RIFF'), 0);
  view.setUint32(4, output.length - 8, true);
  output.set(new TextEncoder().encode('WAVEfmt '), 8);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 24000, true);
  view.setUint32(28, 48000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  output.set(new TextEncoder().encode('data'), 36);
  view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, index) => view.setInt16(44 + index * 2, sample, true));
  return output;
}

function responseBody(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

afterEach(() => {
  clearQwen3TtsCapacityForTests();
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
        new Response(responseBody(pcmWav([1])), {
          headers: { 'content-type': 'audio/wav' },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const provider = new Qwen3TtsVoiceCloningProvider();

    await provider.createProfile({
      profileId: 'vcp_existing',
      referenceAudioKey: '/private/reference.wav',
      referenceText: 'This is the exact English transcript.',
      language: 'en',
    });
    const result = await provider.generatePreview({
      providerReferenceId: 'vcp_existing',
      text: 'Welcome to today’s lesson.',
      language: 'en',
    });

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      profileId: 'vcp_existing',
      referenceAudioPath: '/private/reference.wav',
      referenceText: 'This is the exact English transcript.',
      referenceLanguage: 'en',
      cloneMode: 'speaker-embedding',
    });
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      profileId: 'vcp_existing',
      text: 'Welcome to today’s lesson.',
      language: 'en',
      cloneMode: 'speaker-embedding',
    });
    expect(result).toEqual({ audio: pcmWav([1]), format: 'wav' });
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
      new Qwen3TtsVoiceCloningProvider().generatePreview({
        providerReferenceId: 'vcp_existing',
        text: 'Hello',
        language: 'en',
      }),
    ).rejects.toMatchObject({
      status: 429,
      metadata: { provider: 'qwen3-tts', endpoint: '/synthesize' },
    });
  });

  it('does not send a queued request while another Qwen operation owns capacity', async () => {
    let finishFirst!: (response: Response) => void;
    const firstResponse = new Promise<Response>((resolve) => {
      finishFirst = resolve;
    });
    const fetchMock = vi
      .fn()
      .mockReturnValueOnce(firstResponse)
      .mockResolvedValueOnce(
        new Response(responseBody(pcmWav([1])), {
          headers: { 'content-type': 'audio/wav' },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const provider = new Qwen3TtsVoiceCloningProvider();
    const first = provider.synthesize({
      providerReferenceId: 'vcp_existing',
      text: 'First slide narration.',
      language: 'en',
    });
    const second = provider.generatePreview({
      providerReferenceId: 'vcp_existing',
      text: 'Relevant preview.',
      language: 'en',
    });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    finishFirst(
      new Response(responseBody(pcmWav([1])), {
        headers: { 'content-type': 'audio/wav' },
      }),
    );
    await expect(first).resolves.toMatchObject({ format: 'wav' });
    await expect(second).resolves.toMatchObject({ format: 'wav' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('splits a 372-character narration at safe boundaries without changing its text', async () => {
    vi.stubEnv('QWEN3_TTS_CHUNK_CHARACTERS', String(DEFAULT_QWEN_SYNTHESIS_CHUNK_CHARACTERS));
    const text =
      'Newton’s first law explains inertia in a system at rest. ' +
      'An object keeps its existing state unless an external force acts upon it. ' +
      'This principle lets us predict motion while keeping every word of the classroom narration unchanged. ' +
      'A final example makes the relationship between force and motion clear for every learner in the room today.';
    const paddedText = `${text}${' Exactly preserved.'.repeat(4)}`.slice(0, 372);
    expect(paddedText).toHaveLength(372);
    const chunks = splitQwenSynthesisTextPreservingText(
      paddedText,
      DEFAULT_QWEN_SYNTHESIS_CHUNK_CHARACTERS,
    );
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join('')).toBe(paddedText);
    expect(chunks.every((chunk) => chunk.length <= DEFAULT_QWEN_SYNTHESIS_CHUNK_CHARACTERS)).toBe(
      true,
    );

    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(responseBody(pcmWav([fetchMock.mock.calls.length])), {
          headers: { 'content-type': 'audio/wav' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await new Qwen3TtsVoiceCloningProvider().synthesize({
      providerReferenceId: 'vcp_existing',
      text: paddedText,
      language: 'en',
    });

    const requestChunks = fetchMock.mock.calls.map(([_, init]) => {
      const body = JSON.parse(String(init?.body)) as { text: string };
      return body.text;
    });
    expect(requestChunks).toEqual(chunks);
    expect(requestChunks.join('')).toBe(paddedText);
    const metadata = readWavMetadata(result.audio);
    expect(metadata.dataLength).toBe(chunks.length * 2);
    const output = new DataView(
      result.audio.buffer,
      result.audio.byteOffset,
      result.audio.byteLength,
    );
    expect(
      chunks.map((_, index) => output.getInt16(metadata.dataOffset + index * 2, true)),
    ).toEqual(chunks.map((_, index) => index + 1));
  });

  it('surfaces the bounded service inference deadline without retrying a partial result', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          detail: 'Qwen3-TTS inference timed out before complete audio was produced',
        }),
        { status: 504, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      new Qwen3TtsVoiceCloningProvider().synthesize({
        providerReferenceId: 'vcp_existing',
        text: 'A narration that exceeded its bounded inference deadline.',
        language: 'en',
      }),
    ).rejects.toMatchObject({ status: 504, metadata: { providerStatus: 504 } });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('registers ICL separately with the exact saved transcript', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ providerReferenceId: 'vcp_existing' }), {
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await new Qwen3TtsVoiceCloningProvider().registerProfile({
      profileId: 'vcp_existing',
      referenceAudioPath: '/private/reference.wav',
      referenceText: 'This is the exact English transcript.',
      cloneMode: 'icl',
    });

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      referenceText: 'This is the exact English transcript.',
      cloneMode: 'icl',
    });
  });

  it('reports a missing in-memory prompt as recoverable after service restart', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ detail: 'voice profile not found' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    await expect(
      new Qwen3TtsVoiceCloningProvider().synthesize({
        providerReferenceId: 'vcp_existing',
        text: 'Resume the lesson.',
        language: 'en',
      }),
    ).rejects.toMatchObject({ name: 'VoiceProviderProfileNotFoundError' });
  });
});
