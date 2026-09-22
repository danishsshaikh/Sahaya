import { getVoiceCloningBaseUrl, getVoiceCloningTimeoutMs } from '@/lib/voice-cloning/config';
import {
  isChatterboxModelVariant,
  VoiceProviderProfileNotFoundError,
  type VoiceCloningProvider,
  type VoiceGenerationSettings,
} from '@/lib/voice-cloning/types';
import type { ChatterboxModelVariant } from '@/lib/voice-cloning/types';

function assertModelVariant(value: ChatterboxModelVariant | undefined): ChatterboxModelVariant {
  if (!isChatterboxModelVariant(value)) {
    throw new Error(`Unsupported Chatterbox model variant: ${String(value)}`);
  }
  return value;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), getVoiceCloningTimeoutMs());
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      const detail = await response.text().catch(() => response.statusText);
      throw new Error(
        `Voice cloning service error ${response.status}: ${detail || response.statusText}`,
      );
    }
    return (await response.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchAudio(
  url: string,
  init: RequestInit,
  options: { providerReferenceId?: string } = {},
): Promise<{ audio: Uint8Array; format: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), getVoiceCloningTimeoutMs());
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      const detail = await response.text().catch(() => response.statusText);
      if (response.status === 404 && detail.toLowerCase().includes('voice profile not found')) {
        throw new VoiceProviderProfileNotFoundError(
          `Voice cloning provider profile not found: ${options.providerReferenceId ?? 'unknown'}`,
          { providerReferenceId: options.providerReferenceId },
        );
      }
      throw new Error(
        `Voice cloning service error ${response.status}: ${detail || response.statusText}`,
      );
    }
    const contentType = response.headers.get('content-type') || '';
    const format = contentType.includes('wav')
      ? 'wav'
      : contentType.includes('mpeg')
        ? 'mp3'
        : 'wav';
    return { audio: new Uint8Array(await response.arrayBuffer()), format };
  } finally {
    clearTimeout(timeout);
  }
}

export class ChatterboxVoiceCloningProvider implements VoiceCloningProvider {
  private baseUrl(): string {
    const baseUrl = getVoiceCloningBaseUrl();
    if (!baseUrl) throw new Error('VOICE_CLONING_BASE_URL is required for Chatterbox');
    return baseUrl;
  }

  async healthCheck(): Promise<{ ok: boolean; provider: string; modelLoaded?: boolean }> {
    return fetchJson<{ ok: boolean; provider: string; modelLoaded?: boolean }>(
      `${this.baseUrl()}/health`,
    );
  }

  async createProfile(input: {
    profileId: string;
    referenceAudioKey: string;
    language: string;
    modelVariant?: ChatterboxModelVariant;
    generationSettings?: VoiceGenerationSettings;
  }): Promise<{ providerReferenceId: string }> {
    const modelVariant = assertModelVariant(input.modelVariant);
    const result = await fetchJson<{ providerReferenceId?: string }>(`${this.baseUrl()}/profiles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        profileId: input.profileId,
        referenceAudioPath: input.referenceAudioKey,
        language: input.language,
        modelVariant,
      }),
    });
    return { providerReferenceId: result.providerReferenceId || input.profileId };
  }

  async generatePreview(input: {
    providerReferenceId: string;
    text: string;
    language: string;
    modelVariant?: ChatterboxModelVariant;
    generationSettings?: VoiceGenerationSettings;
  }): Promise<{ audio: Uint8Array; format: string }> {
    return this.synthesize(input);
  }

  async synthesize(input: {
    providerReferenceId: string;
    text: string;
    language: string;
    modelVariant?: ChatterboxModelVariant;
    generationSettings?: VoiceGenerationSettings;
  }): Promise<{ audio: Uint8Array; format: string }> {
    const modelVariant = assertModelVariant(input.modelVariant);
    return fetchAudio(
      `${this.baseUrl()}/synthesize`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          profileId: input.providerReferenceId,
          text: input.text,
          language: input.language,
          modelVariant,
          generationSettings: input.generationSettings,
        }),
      },
      { providerReferenceId: input.providerReferenceId },
    );
  }

  async deleteProfile(input: { providerReferenceId: string }): Promise<void> {
    await fetchJson<{ ok: boolean }>(
      `${this.baseUrl()}/profiles/${encodeURIComponent(input.providerReferenceId)}`,
      { method: 'DELETE' },
    );
  }
}
