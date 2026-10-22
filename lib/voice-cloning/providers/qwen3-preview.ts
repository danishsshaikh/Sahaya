import { getQwen3TtsPreviewServiceConfig } from '@/lib/voice-cloning/config';
import {
  TeachingVoiceError,
  TeachingVoiceProviderOperationError,
  type Qwen3TtsCloneMode,
  type TeachingVoiceProviderOperation,
} from '@/lib/voice-cloning/types';

function providerError(
  message: string,
  status: number,
  endpoint: string,
  operation: TeachingVoiceProviderOperation,
  response?: Response,
  detail?: string,
): TeachingVoiceProviderOperationError {
  return new TeachingVoiceProviderOperationError(message, status, {
    provider: 'qwen3-tts',
    endpoint,
    operation,
    providerStatus: response?.status,
    providerContentType: response?.headers.get('content-type') || undefined,
    providerDetail: detail?.replace(/\s+/g, ' ').trim().slice(0, 180) || undefined,
  });
}

async function request(
  endpoint: string,
  init: RequestInit,
  operation: TeachingVoiceProviderOperation,
): Promise<Response> {
  const { baseUrl, timeoutMs } = getQwen3TtsPreviewServiceConfig();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}${endpoint}`, { ...init, signal: controller.signal });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { detail?: unknown } | null;
      const detail = typeof body?.detail === 'string' ? body.detail : undefined;
      const message =
        response.status === 429
          ? 'Qwen3-TTS is busy. Try again after the current preview finishes.'
          : response.status === 503
            ? 'Qwen3-TTS is unavailable. Check the preview service health.'
            : 'Qwen3-TTS could not generate this preview.';
      throw providerError(
        message,
        response.status === 429 ? 429 : 502,
        endpoint,
        operation,
        response,
        detail,
      );
    }
    return response;
  } catch (error) {
    if (error instanceof TeachingVoiceError) throw error;
    throw providerError(
      controller.signal.aborted
        ? 'Qwen3-TTS preview timed out. Your saved Teaching Voice is unchanged.'
        : 'Qwen3-TTS preview service is unreachable.',
      502,
      endpoint,
      operation,
    );
  } finally {
    clearTimeout(timer);
  }
}

export class Qwen3TtsPreviewProvider {
  async healthCheck(): Promise<{ ok: boolean; provider: string; modelLoaded: boolean }> {
    const response = await request('/health', {}, 'health_check');
    const result = (await response.json()) as {
      ok?: unknown;
      provider?: unknown;
      modelLoaded?: unknown;
    };
    if (result.provider !== 'qwen3-tts' || typeof result.modelLoaded !== 'boolean') {
      throw providerError('Invalid Qwen3-TTS health response.', 502, '/health', 'health_check');
    }
    return { ok: result.ok === true, provider: result.provider, modelLoaded: result.modelLoaded };
  }

  async registerProfile(input: {
    profileId: string;
    referenceAudioPath: string;
    referenceText: string;
    cloneMode: Qwen3TtsCloneMode;
  }): Promise<void> {
    const response = await request(
      '/profiles',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          profileId: input.profileId,
          referenceAudioPath: input.referenceAudioPath,
          referenceText: input.referenceText,
          referenceLanguage: 'en',
          cloneMode: input.cloneMode,
        }),
      },
      'provider_registration',
    );
    const result = (await response.json()) as { providerReferenceId?: unknown };
    if (result.providerReferenceId !== input.profileId) {
      throw providerError(
        'Qwen3-TTS returned an invalid profile ID.',
        502,
        '/profiles',
        'provider_registration',
      );
    }
  }

  async generatePreview(input: {
    profileId: string;
    text: string;
    cloneMode: Qwen3TtsCloneMode;
  }): Promise<{ audio: Uint8Array; format: 'wav' }> {
    const response = await request(
      '/synthesize',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          profileId: input.profileId,
          text: input.text,
          language: 'en',
          cloneMode: input.cloneMode,
        }),
      },
      'preview_generation',
    );
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('audio/wav') && !contentType.includes('audio/x-wav')) {
      throw providerError(
        'Qwen3-TTS returned non-WAV audio.',
        502,
        '/synthesize',
        'preview_generation',
        response,
      );
    }
    const audio = new Uint8Array(await response.arrayBuffer());
    if (audio.byteLength === 0) {
      throw providerError(
        'Qwen3-TTS returned empty audio.',
        502,
        '/synthesize',
        'preview_generation',
        response,
      );
    }
    return { audio, format: 'wav' };
  }
}
