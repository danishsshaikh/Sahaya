import { getQwen3TtsPreviewServiceConfig } from '@/lib/voice-cloning/config';
import { runWithQwen3TtsCapacity } from '@/lib/server/qwen3-tts-capacity';
import {
  TeachingVoiceError,
  TeachingVoiceProviderOperationError,
  VoiceProviderProfileNotFoundError,
  type Qwen3TtsCloneMode,
  type TeachingVoiceProviderOperation,
  type VoiceCloningProvider,
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
  const execute = async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${baseUrl}${endpoint}`, { ...init, signal: controller.signal });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { detail?: unknown } | null;
        const detail = typeof body?.detail === 'string' ? body.detail : undefined;
        if (
          endpoint === '/synthesize' &&
          response.status === 404 &&
          (detail === 'voice profile not found' || detail === 'voice clone mode is not registered')
        ) {
          throw new VoiceProviderProfileNotFoundError('Qwen3-TTS voice prompt must be recreated.');
        }
        const message =
          response.status === 429
            ? 'Qwen3-TTS capacity remained busy. Retry this narration after the current generation finishes.'
            : response.status === 503
              ? 'Qwen3-TTS is unavailable. Check the Teaching Voice service health.'
              : 'Qwen3-TTS could not generate audio.';
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
      if (
        error instanceof TeachingVoiceError ||
        error instanceof VoiceProviderProfileNotFoundError
      ) {
        throw error;
      }
      throw providerError(
        controller.signal.aborted
          ? 'Qwen3-TTS generation timed out. Your saved Teaching Voice is unchanged.'
          : 'Qwen3-TTS Teaching Voice service is unreachable.',
        502,
        endpoint,
        operation,
      );
    } finally {
      clearTimeout(timer);
    }
  };
  return operation === 'provider_registration' ||
    operation === 'preview_generation' ||
    operation === 'synthesis'
    ? runWithQwen3TtsCapacity(execute, init.signal ?? undefined)
    : execute();
}

export class Qwen3TtsVoiceCloningProvider implements VoiceCloningProvider {
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

  async createProfile(input: Parameters<VoiceCloningProvider['createProfile']>[0]): Promise<{
    providerReferenceId: string;
  }> {
    if (!input.referenceText?.trim()) {
      throw new TeachingVoiceError('Qwen3-TTS requires the saved reference transcript.');
    }
    if (input.language !== 'en') {
      throw new TeachingVoiceError('Qwen3-TTS requires an English reference recording.');
    }
    await this.registerProfile({
      profileId: input.profileId,
      referenceAudioPath: input.referenceAudioKey,
      referenceText: input.referenceText,
      cloneMode: 'speaker-embedding',
    });
    return { providerReferenceId: input.profileId };
  }

  async generatePreview(
    input: Parameters<VoiceCloningProvider['generatePreview']>[0],
  ): Promise<{ audio: Uint8Array; format: 'wav' }> {
    return this.synthesizeWithOperation(input, 'preview_generation');
  }

  async synthesize(
    input: Parameters<VoiceCloningProvider['synthesize']>[0],
  ): Promise<{ audio: Uint8Array; format: 'wav' }> {
    return this.synthesizeWithOperation(input, 'synthesis');
  }

  private async synthesizeWithOperation(
    input: Parameters<VoiceCloningProvider['synthesize']>[0],
    operation: 'preview_generation' | 'synthesis',
  ): Promise<{ audio: Uint8Array; format: 'wav' }> {
    if (input.language !== 'en') {
      throw new TeachingVoiceError('Qwen3-TTS currently supports English narration only.');
    }
    const response = await request(
      '/synthesize',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          profileId: input.providerReferenceId,
          text: input.text,
          language: 'en',
          cloneMode: 'speaker-embedding',
        }),
      },
      operation,
    );
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('audio/wav') && !contentType.includes('audio/x-wav')) {
      throw providerError(
        'Qwen3-TTS returned non-WAV audio.',
        502,
        '/synthesize',
        operation,
        response,
      );
    }
    const audio = new Uint8Array(await response.arrayBuffer());
    if (audio.byteLength === 0) {
      throw providerError(
        'Qwen3-TTS returned empty audio.',
        502,
        '/synthesize',
        operation,
        response,
      );
    }
    return { audio, format: 'wav' };
  }

  async deleteProfile(input: { providerReferenceId: string }): Promise<void> {
    await request(
      `/profiles/${encodeURIComponent(input.providerReferenceId)}`,
      { method: 'DELETE' },
      'profile_deletion',
    );
  }
}

export { Qwen3TtsVoiceCloningProvider as Qwen3TtsPreviewProvider };
