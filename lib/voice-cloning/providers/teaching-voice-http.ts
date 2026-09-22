import { getTeachingVoiceServiceConfig } from '../config';
import {
  TeachingVoiceError,
  VoiceProviderProfileNotFoundError,
  type VoiceCloningProvider,
} from '../types';

type Registration = Parameters<VoiceCloningProvider['createProfile']>[0];
type Synthesis = Parameters<VoiceCloningProvider['synthesize']>[0];

// Qwen3 and IndicF5 expose the same isolated service contract.
export abstract class TeachingVoiceHttpProvider implements VoiceCloningProvider {
  constructor(private readonly provider: 'qwen3' | 'indicf5') {}

  protected abstract prepareText(text: string, language: string): string;

  private validateLanguage(language: string): void {
    if (this.provider === 'qwen3' ? language !== 'en' : !['hi', 'mr'].includes(language)) {
      throw new TeachingVoiceError('Unsupported language for the selected Teaching Voice provider.');
    }
  }

  private async request<T>(
    endpoint: string,
    init: RequestInit,
    decode: (response: Response) => Promise<T>,
  ): Promise<T> {
    const { baseUrl, timeoutMs } = getTeachingVoiceServiceConfig(this.provider);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${baseUrl}${endpoint}`, { ...init, signal: controller.signal });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { detail?: unknown } | null;
        if (
          endpoint === '/synthesize' &&
          response.status === 404 &&
          body?.detail === 'voice profile not found'
        ) {
          throw new VoiceProviderProfileNotFoundError('Teaching Voice registration is missing.');
        }
        const message =
          response.status === 429
            ? 'Teaching Voice service is busy. Try again after the current generation finishes.'
            : response.status === 503
              ? 'Teaching Voice model is unavailable. Check the selected service health.'
              : 'Teaching Voice service rejected the request or failed to generate audio.';
        throw new TeachingVoiceError(message, response.status === 429 ? 429 : 502);
      }
      return await decode(response);
    } catch (error) {
      if (error instanceof TeachingVoiceError || error instanceof VoiceProviderProfileNotFoundError) {
        throw error;
      }
      throw new TeachingVoiceError(
        controller.signal.aborted
          ? 'Teaching Voice generation timed out. No alternate voice was used.'
          : 'Teaching Voice service is unreachable or returned an invalid response.',
        502,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async healthCheck() {
    return this.request('/health', {}, async (response) => {
      const health = (await response.json()) as { modelLoaded?: boolean; error?: unknown };
      if (health.error != null) {
        throw new TeachingVoiceError('Teaching Voice model failed to load.', 503);
      }
      if (typeof health.modelLoaded !== 'boolean') {
        throw new TeachingVoiceError('Invalid Teaching Voice health response.', 502);
      }
      // Reachable lazy services are usable even before the first model load.
      return { ok: true, provider: this.provider, modelLoaded: health.modelLoaded };
    });
  }

  async createProfile(input: Registration): Promise<{ providerReferenceId: string }> {
    this.validateLanguage(input.language);
    if (!input.referenceText?.trim()) {
      throw new TeachingVoiceError('The exact reference transcript is required.');
    }
    return this.request('/profiles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        profileId: input.profileId,
        referenceAudioPath: input.referenceAudioKey,
        referenceText: input.referenceText,
        language: input.language,
      }),
    }, async (response) => {
      const result = (await response.json()) as { providerReferenceId?: unknown };
      if (result.providerReferenceId !== input.profileId) {
        throw new TeachingVoiceError('Teaching Voice registration returned an invalid profile ID.', 502);
      }
      return { providerReferenceId: input.profileId };
    });
  }

  async generatePreview(input: Synthesis) {
    return this.synthesize(input);
  }

  async synthesize(input: Synthesis): Promise<{ audio: Uint8Array; format: string }> {
    this.validateLanguage(input.language);
    if (!input.text.trim()) throw new TeachingVoiceError('Teaching Voice narration cannot be empty.');
    return this.request('/synthesize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        profileId: input.providerReferenceId,
        text: this.prepareText(input.text, input.language),
        language: input.language,
      }),
    }, async (response) => {
      if (!response.headers.get('content-type')?.includes('audio/wav')) {
        throw new TeachingVoiceError('Teaching Voice service returned non-WAV audio.', 502);
      }
      const audio = new Uint8Array(await response.arrayBuffer());
      if (audio.length === 0) {
        throw new TeachingVoiceError('Teaching Voice service returned empty audio.', 502);
      }
      return { audio, format: 'wav' };
    });
  }

  async deleteProfile(input: { providerReferenceId: string }): Promise<void> {
    await this.request(
      `/profiles/${encodeURIComponent(input.providerReferenceId)}`,
      { method: 'DELETE' },
      async (response) => {
        const result = (await response.json()) as { ok?: boolean };
        if (result.ok !== true) {
          throw new TeachingVoiceError('Teaching Voice profile deletion failed.', 502);
        }
      },
    );
  }
}
