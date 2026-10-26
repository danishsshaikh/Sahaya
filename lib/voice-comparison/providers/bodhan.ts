import { BODHAN_STYLES, isBodhanStyle, isBodhanVoice } from '@/lib/voice-comparison/catalog';
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
  getBodhanTtsConfig,
  type ExternalVoiceProviderConfig,
} from '@/lib/server/voice-comparison-config';
import { TeachingVoiceError } from '@/lib/voice-cloning/types';

export interface BodhanSynthesisResult {
  audio: Uint8Array;
  durationSeconds: number;
  requestId?: string;
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
        url: `${this.config.baseUrl}/audio/speech`,
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
      throw new ExternalVoiceProviderError('Bodhan Indic-Speak could not be reached.', 502, {
        provider: 'bodhan',
        operation: 'preview_generation',
      });
    }
    if (!response.ok) {
      const mapped = providerStatusMessage('Bodhan Indic-Speak', response.status);
      throw new ExternalVoiceProviderError(mapped.message, mapped.status, {
        provider: 'bodhan',
        operation: 'preview_generation',
        providerStatus: response.status,
        requestId: requestIdFromResponse(response),
      });
    }
    const contentType = response.headers.get('content-type')?.toLowerCase() || '';
    if (!contentType.includes('audio/wav') && !contentType.includes('audio/x-wav')) {
      throw new ExternalVoiceProviderError('Bodhan Indic-Speak returned non-WAV audio.', 502, {
        provider: 'bodhan',
        operation: 'preview_generation',
        providerStatus: response.status,
        requestId: requestIdFromResponse(response),
      });
    }
    const audio = new Uint8Array(await response.arrayBuffer());
    if (audio.byteLength === 0 || audio.byteLength > MAX_COMPARISON_AUDIO_BYTES) {
      throw new ExternalVoiceProviderError('Bodhan Indic-Speak returned invalid audio.', 502, {
        provider: 'bodhan',
        operation: 'preview_generation',
        requestId: requestIdFromResponse(response),
      });
    }
    const metadata = readWavMetadata(audio);
    return {
      audio,
      durationSeconds: metadata.durationSeconds,
      ...(requestIdFromResponse(response) ? { requestId: requestIdFromResponse(response) } : {}),
    };
  }
}

export const DEFAULT_BODHAN_STYLE = BODHAN_STYLES[0];
