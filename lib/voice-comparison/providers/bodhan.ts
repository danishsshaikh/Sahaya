import { BODHAN_STYLES, isBodhanStyle, isBodhanVoice } from '@/lib/voice-comparison/catalog';
import {
  MAX_COMPARISON_AUDIO_BYTES,
  readWavMetadata,
  recognizeAudioFileSignature,
} from '@/lib/voice-comparison/audio';
import type { VoiceComparisonLanguageCode } from '@/lib/voice-comparison/types';
import {
  boundedProviderDetail,
  ExternalVoiceProviderError,
  fetchExternalVoiceProvider,
  requestIdFromResponse,
  type ExternalVoiceProviderErrorCode,
} from '@/lib/server/voice-comparison-http';
import {
  externalVoiceProviderConfigured,
  getBodhanTtsConfig,
  type ExternalVoiceProviderConfig,
} from '@/lib/server/voice-comparison-config';
import { createLogger } from '@/lib/logger';
import { TeachingVoiceError } from '@/lib/voice-cloning/types';

const log = createLogger('BodhanIndicSpeak');

export interface BodhanSynthesisResult {
  audio: Uint8Array;
  durationSeconds: number;
  requestId?: string;
}

interface BodhanErrorBody {
  code?: unknown;
  message?: unknown;
  detail?: unknown;
  error?: { code?: unknown; message?: unknown; detail?: unknown } | string;
}

export function bodhanSpeechEndpoint(baseUrl: string): string {
  const url = new URL(baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  const path = url.pathname.replace(/\/+$/, '').replace(/(?:\/v1){2,}$/, '/v1');
  url.pathname = `${path.endsWith('/v1') ? path : `${path}/v1`}/audio/speech`.replace(
    /\/{2,}/g,
    '/',
  );
  url.search = '';
  url.hash = '';
  return url.toString();
}

function providerErrorFields(
  bytes: Uint8Array,
  privateText: string,
): {
  code?: string;
  detail?: string;
} {
  try {
    const body = JSON.parse(new TextDecoder().decode(bytes)) as BodhanErrorBody;
    const nested = typeof body.error === 'object' && body.error ? body.error : undefined;
    const code = nested?.code ?? body.code;
    const detail =
      nested?.message ??
      nested?.detail ??
      body.message ??
      body.detail ??
      (typeof body.error === 'string' ? body.error : undefined);
    const safeDetail = boundedProviderDetail(detail, privateText);
    return {
      ...(typeof code === 'string' ? { code: code.slice(0, 80) } : {}),
      ...(safeDetail ? { detail: safeDetail } : {}),
    };
  } catch {
    return {};
  }
}

function statusError(status: number): {
  code: ExternalVoiceProviderErrorCode;
  status: number;
  message: string;
} {
  if (status === 401) {
    return {
      code: 'BODHAN_AUTH_ERROR',
      status: 401,
      message: 'Bodhan API authentication failed. Check the configured API key.',
    };
  }
  if (status === 402 || status === 403) {
    return {
      code: 'BODHAN_PERMISSION_ERROR',
      status: 403,
      message: 'Your Bodhan API key does not have access to this model.',
    };
  }
  if (status === 429) {
    return {
      code: 'BODHAN_RATE_LIMITED',
      status: 429,
      message: 'Bodhan rate limit or credit limit reached. Try again later.',
    };
  }
  if (status >= 500) {
    return {
      code: 'BODHAN_UPSTREAM_ERROR',
      status: 502,
      message: 'Bodhan is temporarily unavailable. Try again later.',
    };
  }
  return {
    code: 'BODHAN_UPSTREAM_ERROR',
    status: status >= 400 && status < 500 ? status : 502,
    message: 'Bodhan rejected this preview request.',
  };
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && error.name === 'TimeoutError';
}

export class BodhanIndicSpeakPreviewProvider {
  constructor(private readonly config: ExternalVoiceProviderConfig = getBodhanTtsConfig()) {}

  isConfigured(): boolean {
    return externalVoiceProviderConfigured(this.config);
  }

  async synthesize(input: {
    text: string;
    language: VoiceComparisonLanguageCode;
    voice: string;
    style?: string;
    signal?: AbortSignal;
  }): Promise<BodhanSynthesisResult> {
    if (!this.isConfigured())
      throw new TeachingVoiceError('Bodhan Indic-Speak is not configured.', 503);
    if (!isBodhanVoice(input.voice)) throw new TeachingVoiceError('Unsupported Bodhan voice.');
    if (input.style && !isBodhanStyle(input.style)) {
      throw new TeachingVoiceError('Unsupported Bodhan speaking style.');
    }
    if (input.text.length < 1 || input.text.length > 700) {
      throw new TeachingVoiceError('Bodhan preview segments must contain 1 to 700 characters.');
    }
    const instructions = JSON.stringify({
      lang: input.language,
      ...(input.style ? { style: input.style } : {}),
    });
    let response: Response;
    try {
      response = await fetchExternalVoiceProvider({
        url: bodhanSpeechEndpoint(this.config.baseUrl),
        init: () => ({
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.config.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'indic-speak',
            input: input.text,
            voice: input.voice,
            instructions,
          }),
        }),
        timeoutMs: this.config.timeoutMs,
        signal: input.signal,
        retryRateLimit: true,
      });
    } catch (error) {
      if (error instanceof ExternalVoiceProviderError || error instanceof TeachingVoiceError) {
        throw error;
      }
      if (isTimeout(error)) {
        throw new ExternalVoiceProviderError(
          'Bodhan synthesis timed out. Try again later.',
          504,
          'BODHAN_TIMEOUT',
          { provider: 'bodhan', operation: 'preview_generation' },
        );
      }
      throw new ExternalVoiceProviderError(
        'Bodhan Indic-Speak could not be reached.',
        502,
        'BODHAN_UPSTREAM_ERROR',
        { provider: 'bodhan', operation: 'preview_generation' },
      );
    }

    const contentType = response.headers.get('content-type')?.toLowerCase() || 'unknown';
    const requestId = requestIdFromResponse(response);
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_COMPARISON_AUDIO_BYTES) {
      throw new ExternalVoiceProviderError(
        'Bodhan returned an audio response that is too large.',
        502,
        'BODHAN_INVALID_AUDIO',
        {
          provider: 'bodhan',
          operation: 'preview_generation',
          providerStatus: response.status,
          providerContentType: contentType,
          responseBytes: declaredLength,
          ...(requestId ? { requestId } : {}),
        },
      );
    }
    const audio = new Uint8Array(await response.arrayBuffer());
    const signature = recognizeAudioFileSignature(audio);
    const fields = signature === 'json' ? providerErrorFields(audio, input.text) : {};
    const diagnostics = {
      provider: 'bodhan' as const,
      operation: 'preview_generation' as const,
      providerStatus: response.status,
      providerContentType: contentType,
      responseBytes: audio.byteLength,
      responseSignature: signature,
      ...(requestId ? { requestId } : {}),
      ...(fields.code ? { providerCode: fields.code } : {}),
      ...(fields.detail ? { safeDetail: fields.detail } : {}),
    };

    if (!response.ok) {
      const mapped = statusError(response.status);
      log.warn('Bodhan synthesis rejected', diagnostics);
      const actionableDetail =
        fields.detail &&
        response.status >= 400 &&
        response.status < 500 &&
        response.status !== 401 &&
        response.status !== 402 &&
        response.status !== 403 &&
        response.status !== 429
          ? ` ${fields.detail}`
          : '';
      throw new ExternalVoiceProviderError(
        `${mapped.message}${actionableDetail}`,
        mapped.status,
        mapped.code,
        diagnostics,
      );
    }
    if (signature !== 'wav') {
      const isProviderError = signature === 'json' || signature === 'html';
      log.warn('Bodhan synthesis returned non-WAV bytes', diagnostics);
      throw new ExternalVoiceProviderError(
        fields.detail
          ? `Bodhan returned an error instead of audio: ${fields.detail}`
          : isProviderError
            ? 'Bodhan returned an error response instead of audio.'
            : 'Bodhan returned an invalid audio response.',
        502,
        isProviderError ? 'BODHAN_UPSTREAM_ERROR' : 'BODHAN_INVALID_AUDIO',
        diagnostics,
      );
    }
    if (audio.byteLength > MAX_COMPARISON_AUDIO_BYTES) {
      throw new ExternalVoiceProviderError(
        'Bodhan returned an audio response that is too large.',
        502,
        'BODHAN_INVALID_AUDIO',
        diagnostics,
      );
    }
    try {
      const metadata = readWavMetadata(audio);
      if (
        metadata.audioFormat !== 1 ||
        metadata.channels !== 1 ||
        metadata.sampleRate !== 24000 ||
        metadata.bitsPerSample !== 16
      ) {
        log.warn('Bodhan WAV differs from documented PCM16 24 kHz mono output', {
          ...diagnostics,
          audioFormat: metadata.audioFormat,
          channels: metadata.channels,
          sampleRate: metadata.sampleRate,
          bitsPerSample: metadata.bitsPerSample,
        });
      }
      return {
        audio,
        durationSeconds: metadata.durationSeconds,
        ...(requestId ? { requestId } : {}),
      };
    } catch {
      log.warn('Bodhan synthesis returned malformed WAV bytes', diagnostics);
      throw new ExternalVoiceProviderError(
        'Bodhan returned an invalid audio response.',
        502,
        'BODHAN_INVALID_AUDIO',
        diagnostics,
      );
    }
  }
}

export const DEFAULT_BODHAN_STYLE = BODHAN_STYLES[0];
