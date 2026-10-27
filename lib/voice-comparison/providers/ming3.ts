import { readWavMetadata } from '@/lib/voice-comparison/audio';
import { getMing3TtsPreviewServiceConfig } from '@/lib/voice-cloning/config';
import {
  TeachingVoiceError,
  TeachingVoiceProviderOperationError,
  type TeachingVoiceProviderOperation,
} from '@/lib/voice-cloning/types';

export interface Ming3ProfileRegistration {
  profileId: string;
  referenceAudioPath: string;
  referenceText: string;
}

type Ming3Config = ReturnType<typeof getMing3TtsPreviewServiceConfig>;

function providerError(
  message: string,
  status: number,
  endpoint: string,
  operation: TeachingVoiceProviderOperation,
  response?: Response,
  detail?: string,
): TeachingVoiceProviderOperationError {
  return new TeachingVoiceProviderOperationError(message, status, {
    provider: 'ming3-tts',
    endpoint,
    operation,
    providerStatus: response?.status,
    providerContentType: response?.headers.get('content-type') || undefined,
    providerDetail: detail?.replace(/\s+/g, ' ').trim().slice(0, 180) || undefined,
  });
}

async function safeDetail(response: Response): Promise<string | undefined> {
  const body = (await response.json().catch(() => null)) as { detail?: unknown } | null;
  return typeof body?.detail === 'string' ? body.detail : undefined;
}

export class Ming3TtsPreviewProvider {
  constructor(private readonly config: Ming3Config = getMing3TtsPreviewServiceConfig()) {}

  private async request(
    endpoint: string,
    init: RequestInit,
    operation: TeachingVoiceProviderOperation,
    signal?: AbortSignal,
  ): Promise<Response> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, this.config.timeoutMs);
    try {
      const response = await fetch(`${this.config.baseUrl}${endpoint}`, {
        ...init,
        signal: controller.signal,
      });
      if (!response.ok) {
        const detail = await safeDetail(response);
        const status = response.status === 400 || response.status === 404 ? 409 : response.status;
        const message =
          response.status === 429
            ? 'Ming 3.0 TTS is busy. Try again after the current preview finishes.'
            : response.status === 503
              ? 'Ming 3.0 TTS is unavailable. Check the isolated model service.'
              : response.status === 404
                ? 'Ming 3.0 TTS voice prompt must be prepared again.'
                : 'Ming 3.0 TTS could not generate audio.';
        throw providerError(message, status, endpoint, operation, response, detail);
      }
      return response;
    } catch (error) {
      if (error instanceof TeachingVoiceError) throw error;
      throw providerError(
        controller.signal.aborted
          ? 'Ming 3.0 TTS generation timed out. Your Teaching Voice is unchanged.'
          : 'Ming 3.0 TTS service is unreachable.',
        controller.signal.aborted ? 504 : 502,
        endpoint,
        operation,
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }

  async healthCheck(): Promise<{ ok: boolean; modelLoaded: boolean }> {
    const response = await this.request('/health', {}, 'health_check');
    const body = (await response.json()) as {
      ok?: unknown;
      provider?: unknown;
      modelLoaded?: unknown;
    };
    if (body.provider !== 'ming3-tts' || typeof body.modelLoaded !== 'boolean') {
      throw providerError('Invalid Ming 3.0 TTS health response.', 502, '/health', 'health_check');
    }
    return { ok: body.ok === true, modelLoaded: body.modelLoaded };
  }

  async registerProfile(input: Ming3ProfileRegistration, signal?: AbortSignal): Promise<void> {
    const response = await this.request(
      '/profiles',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          profileId: input.profileId,
          referenceAudioPath: input.referenceAudioPath,
          referenceText: input.referenceText,
          referenceLanguage: 'en',
        }),
      },
      'provider_registration',
      signal,
    );
    const body = (await response.json()) as {
      providerReferenceId?: unknown;
      referencePreparation?: unknown;
    };
    if (body.providerReferenceId !== input.profileId) {
      throw providerError(
        'Ming 3.0 TTS returned an invalid profile ID.',
        502,
        '/profiles',
        'provider_registration',
      );
    }
  }

  async synthesize(input: {
    profileId: string;
    text: string;
    language: 'en';
    signal?: AbortSignal;
  }): Promise<{
    audio: Uint8Array;
    durationSeconds: number;
    requestId?: string;
    referenceTransformation?: string;
  }> {
    const response = await this.request(
      '/synthesize',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          profileId: input.profileId,
          text: input.text,
          language: input.language,
        }),
      },
      'preview_generation',
      input.signal,
    );
    const audio = new Uint8Array(await response.arrayBuffer());
    try {
      const metadata = readWavMetadata(audio);
      return {
        audio,
        durationSeconds: metadata.durationSeconds,
        ...(response.headers.get('x-request-id')
          ? { requestId: response.headers.get('x-request-id')! }
          : {}),
        ...(response.headers.get('x-reference-preparation')
          ? { referenceTransformation: response.headers.get('x-reference-preparation')! }
          : {}),
      };
    } catch {
      throw providerError(
        'Ming 3.0 TTS returned invalid WAV audio.',
        502,
        '/synthesize',
        'preview_generation',
        response,
      );
    }
  }
}
