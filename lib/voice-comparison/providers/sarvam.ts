import { SARVAM_LANGUAGE_CODES } from '@/lib/voice-comparison/catalog';
import { MAX_COMPARISON_AUDIO_BYTES, readWavMetadata } from '@/lib/voice-comparison/audio';
import type { VoiceComparisonLanguageCode } from '@/lib/voice-comparison/types';
import {
  ExternalVoiceProviderError,
  fetchExternalVoiceProvider,
  providerStatusMessage,
  requestIdFromResponse,
} from '@/lib/server/voice-comparison-http';
import {
  externalVoiceProviderConfigured,
  getSarvamVoiceCloningConfig,
  type ExternalVoiceProviderConfig,
} from '@/lib/server/voice-comparison-config';
import { TeachingVoiceError } from '@/lib/voice-cloning/types';

interface SarvamVoiceCreationResponse {
  status?: unknown;
  data?: {
    voice_id?: unknown;
    status?: unknown;
    reference_text?: unknown;
  };
}

interface SarvamSynthesisResponse {
  audio_b64?: unknown;
  audio?: unknown;
  request_id?: unknown;
  audio_duration?: unknown;
}

export interface SarvamVoiceCreationResult {
  voiceId: string;
  referenceText?: string;
  requestId?: string;
}

export interface SarvamSynthesisResult {
  audio: Uint8Array;
  durationSeconds: number;
  format: 'wav';
  requestId?: string;
}

const SARVAM_REFERENCE_MIME_TYPES = new Map<string, { type: string; extension: string }>([
  ['audio/wav', { type: 'audio/wav', extension: 'wav' }],
  ['audio/x-wav', { type: 'audio/wav', extension: 'wav' }],
  ['audio/mpeg', { type: 'audio/mpeg', extension: 'mp3' }],
  ['audio/flac', { type: 'audio/flac', extension: 'flac' }],
  ['audio/ogg', { type: 'audio/ogg', extension: 'opus' }],
  ['audio/ogg;codecs=opus', { type: 'audio/ogg', extension: 'opus' }],
  ['audio/aac', { type: 'audio/aac', extension: 'aac' }],
]);

export function sarvamReferenceUploadType(mimeType: string) {
  return SARVAM_REFERENCE_MIME_TYPES.get(mimeType.trim().toLowerCase()) ?? null;
}

function providerCode(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const value = body as { code?: unknown; error?: { code?: unknown } };
  const code = value.error?.code ?? value.code;
  return typeof code === 'string' ? code.slice(0, 80) : undefined;
}

async function responseJson(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}

function decodeAudio(value: unknown): Uint8Array {
  if (typeof value !== 'string' || !value) {
    throw new TeachingVoiceError('Sarvam AI returned no preview audio.', 502);
  }
  const bytes = new Uint8Array(Buffer.from(value, 'base64'));
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_COMPARISON_AUDIO_BYTES) {
    throw new TeachingVoiceError('Sarvam AI returned invalid preview audio.', 502);
  }
  readWavMetadata(bytes);
  return bytes;
}

export class SarvamVoiceCloningPreviewProvider {
  constructor(
    private readonly config: ExternalVoiceProviderConfig = getSarvamVoiceCloningConfig(),
  ) {}

  isConfigured(): boolean {
    return externalVoiceProviderConfigured(this.config);
  }

  async createVoice(input: {
    profileId: string;
    referenceAudio: Uint8Array;
    referenceMimeType: string;
    referenceLanguage: VoiceComparisonLanguageCode;
    signal?: AbortSignal;
  }): Promise<SarvamVoiceCreationResult> {
    if (!this.isConfigured()) throw new TeachingVoiceError('Sarvam AI is not configured.', 503);
    const language = SARVAM_LANGUAGE_CODES[input.referenceLanguage];
    if (!language)
      throw new TeachingVoiceError('Sarvam AI does not support this reference language.');
    if (
      input.referenceAudio.byteLength === 0 ||
      input.referenceAudio.byteLength > 50 * 1024 * 1024
    ) {
      throw new TeachingVoiceError('Teaching Voice reference audio exceeds Sarvam AI limits.');
    }
    const uploadType = sarvamReferenceUploadType(input.referenceMimeType);
    if (!uploadType) {
      throw new TeachingVoiceError(
        'The original recording format is not supported by Sarvam AI. Re-record in a supported format; Sahaya will not transcode it.',
      );
    }
    const response = await this.request(
      '/voices/create',
      () => {
        const form = new FormData();
        form.set(
          'file',
          new Blob([Buffer.from(input.referenceAudio)], { type: uploadType.type }),
          `reference.${uploadType.extension}`,
        );
        form.set('name', `Sahaya-${input.profileId}`.slice(0, 100));
        form.set('language', language);
        return {
          method: 'POST',
          headers: { 'api-subscription-key': this.config.apiKey },
          body: form,
        };
      },
      'voice_creation',
      input.signal,
      false,
    );
    const body = (await responseJson(response)) as SarvamVoiceCreationResponse | null;
    if (!response.ok) this.throwProviderError(response, body, 'voice_creation');
    const voiceId = body?.data?.voice_id;
    if (typeof voiceId !== 'string' || !/^svc-[a-zA-Z0-9-]{8,}$/.test(voiceId)) {
      throw new ExternalVoiceProviderError(
        'Sarvam AI returned an invalid voice identifier.',
        502,
        'SARVAM_UPSTREAM_ERROR',
        {
          provider: 'sarvam',
          operation: 'voice_creation',
          requestId: requestIdFromResponse(response),
        },
      );
    }
    return {
      voiceId,
      ...(typeof body?.data?.reference_text === 'string'
        ? { referenceText: body.data.reference_text }
        : {}),
      ...(requestIdFromResponse(response) ? { requestId: requestIdFromResponse(response) } : {}),
    };
  }

  async synthesize(input: {
    voiceId: string;
    text: string;
    language: VoiceComparisonLanguageCode;
    signal?: AbortSignal;
  }): Promise<SarvamSynthesisResult> {
    if (!this.isConfigured()) throw new TeachingVoiceError('Sarvam AI is not configured.', 503);
    const languageCode = SARVAM_LANGUAGE_CODES[input.language];
    if (!languageCode) throw new TeachingVoiceError('Sarvam AI does not support this language.');
    if (input.text.length < 1 || input.text.length > 1000) {
      throw new TeachingVoiceError('Sarvam AI preview segments must contain 1 to 1000 characters.');
    }
    const response = await this.request(
      '/voices/clone',
      () => {
        const form = new FormData();
        form.set('voice_id', input.voiceId);
        form.set('text', input.text);
        form.set('language_code', languageCode);
        form.set('output_audio_codec', 'wav');
        form.set('enable_vad', 'false');
        form.set('enable_text_normalization', 'false');
        form.set('enable_qc', 'false');
        return {
          method: 'POST',
          headers: { 'api-subscription-key': this.config.apiKey },
          body: form,
        };
      },
      'preview_generation',
      input.signal,
      true,
    );
    const body = (await responseJson(response)) as SarvamSynthesisResponse | null;
    if (!response.ok) this.throwProviderError(response, body, 'preview_generation');
    const audio = decodeAudio(body?.audio_b64 ?? body?.audio);
    const parsedDuration = readWavMetadata(audio).durationSeconds;
    return {
      audio,
      format: 'wav',
      durationSeconds: parsedDuration,
      ...(typeof body?.request_id === 'string'
        ? { requestId: body.request_id }
        : requestIdFromResponse(response)
          ? { requestId: requestIdFromResponse(response) }
          : {}),
    };
  }

  private async request(
    endpoint: string,
    init: () => RequestInit,
    operation: 'voice_creation' | 'preview_generation',
    signal: AbortSignal | undefined,
    retryRateLimit: boolean,
  ): Promise<Response> {
    try {
      return await fetchExternalVoiceProvider({
        url: `${this.config.baseUrl}${endpoint}`,
        init,
        timeoutMs: this.config.timeoutMs,
        signal,
        retryRateLimit,
      });
    } catch (error) {
      if (error instanceof ExternalVoiceProviderError || error instanceof TeachingVoiceError) {
        throw error;
      }
      throw new ExternalVoiceProviderError(
        'Sarvam AI could not be reached.',
        502,
        'SARVAM_UPSTREAM_ERROR',
        { provider: 'sarvam', operation },
      );
    }
  }

  private throwProviderError(
    response: Response,
    body: unknown,
    operation: 'voice_creation' | 'preview_generation',
  ): never {
    const mapped = providerStatusMessage('Sarvam AI', response.status);
    throw new ExternalVoiceProviderError(mapped.message, mapped.status, 'SARVAM_UPSTREAM_ERROR', {
      provider: 'sarvam',
      operation,
      providerStatus: response.status,
      providerCode: providerCode(body),
      requestId: requestIdFromResponse(response),
    });
  }
}
