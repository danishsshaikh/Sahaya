import { getQwen3TtsPreviewServiceConfig } from '@/lib/voice-cloning/config';
import { runWithQwen3TtsCapacity } from '@/lib/server/qwen3-tts-capacity';
import { concatenatePcmWav } from '@/lib/voice-comparison/audio';
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
    let timedOut = false;
    const callerSignal = init.signal;
    const abortFromCaller = () => controller.abort(callerSignal?.reason);
    if (callerSignal?.aborted) abortFromCaller();
    else callerSignal?.addEventListener('abort', abortFromCaller, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
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
            : response.status === 504
              ? 'Qwen3-TTS generation timed out before complete audio was produced. Retry this narration segment.'
              : response.status === 503
                ? 'Qwen3-TTS is unavailable. Check the Teaching Voice service health.'
                : 'Qwen3-TTS could not generate audio.';
        throw providerError(
          message,
          response.status === 429 ? 429 : response.status === 504 ? 504 : 502,
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
        timedOut
          ? 'Qwen3-TTS generation timed out. Your saved Teaching Voice is unchanged.'
          : callerSignal?.aborted
            ? 'Qwen3-TTS generation was cancelled. Your saved Teaching Voice is unchanged.'
            : 'Qwen3-TTS Teaching Voice service is unreachable.',
        timedOut ? 504 : 502,
        endpoint,
        operation,
      );
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', abortFromCaller);
    }
  };
  return operation === 'provider_registration' ||
    operation === 'preview_generation' ||
    operation === 'synthesis'
    ? runWithQwen3TtsCapacity(execute, init.signal ?? undefined)
    : execute();
}

export const DEFAULT_QWEN_SYNTHESIS_CHUNK_CHARACTERS = 220;

function configuredChunkCharacters(): number {
  const parsed = Number(process.env.QWEN3_TTS_CHUNK_CHARACTERS);
  if (!Number.isFinite(parsed)) return DEFAULT_QWEN_SYNTHESIS_CHUNK_CHARACTERS;
  return Math.max(80, Math.min(400, Math.floor(parsed)));
}

function lastBoundaryEnd(window: string, expression: RegExp): number | undefined {
  let last: number | undefined;
  for (const match of window.matchAll(expression)) {
    last = (match.index ?? 0) + match[0].length;
  }
  return last;
}

/**
 * Split a long Qwen request without rewriting it. Boundary whitespace stays in
 * exactly one chunk, so concatenating the request strings recreates the input.
 */
export function splitQwenSynthesisTextPreservingText(
  text: string,
  maxCharacters = configuredChunkCharacters(),
): string[] {
  if (text.length <= maxCharacters) return [text];
  const chunks: string[] = [];
  let offset = 0;
  while (text.length - offset > maxCharacters) {
    const window = text.slice(offset, offset + maxCharacters);
    const boundary =
      lastBoundaryEnd(window, /[.!?](?:["'\u2019\u201d)\]]*)\s+/gu) ??
      lastBoundaryEnd(window, /[;:,](?:["'\u2019\u201d)\]]*)\s+/gu) ??
      lastBoundaryEnd(window, /\s+/gu) ??
      maxCharacters;
    const end = offset + Math.max(1, boundary);
    chunks.push(text.slice(offset, end));
    offset = end;
  }
  if (offset < text.length) chunks.push(text.slice(offset));
  return chunks;
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
    const chunks = splitQwenSynthesisTextPreservingText(input.text);
    const parts: Uint8Array[] = [];
    for (const text of chunks) {
      const response = await request(
        '/synthesize',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            profileId: input.providerReferenceId,
            text,
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
      parts.push(audio);
    }
    return { audio: concatenatePcmWav(parts), format: 'wav' };
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
