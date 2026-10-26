import {
  masterGeneratedVoiceAudio,
  type GeneratedVoiceMasteringPreset,
} from '@/lib/voice-cloning/audio-validation';
import { enhanceGeneratedVoiceAudio } from '@/lib/voice-cloning/resemble-enhance';
import { createLogger } from '@/lib/logger';

const log = createLogger('VoiceAudioEnhancement');

export interface ProcessedVoiceAudio {
  audio: Uint8Array;
  format: 'wav';
}

export interface VoiceAudioVariants {
  original: ProcessedVoiceAudio;
  enhanced?: ProcessedVoiceAudio;
  enhancementError?: string;
}

interface VoiceAudioVariantOptions {
  attemptEnhancement: boolean;
  context: 'preview' | 'classroom';
  profileId: string;
  languageId: string;
  source: 'chatterbox' | 'qwen3-tts';
  originalMasteringPreset: GeneratedVoiceMasteringPreset | null;
  enhancedMasteringPreset: GeneratedVoiceMasteringPreset | null;
}

export async function processVoiceAudioVariants(
  raw: { audio: Uint8Array; format: string },
  options: VoiceAudioVariantOptions,
): Promise<VoiceAudioVariants> {
  const original = options.originalMasteringPreset
    ? await masterGeneratedVoiceAudio(raw.audio, raw.format, options.originalMasteringPreset)
    : { audio: raw.audio, format: 'wav' as const };
  if (!options.attemptEnhancement) return { original };

  const startedAt = Date.now();
  try {
    const enhanced = await enhanceGeneratedVoiceAudio(raw);
    const mastered = options.enhancedMasteringPreset
      ? await masterGeneratedVoiceAudio(
          enhanced.audio,
          enhanced.format,
          options.enhancedMasteringPreset,
        )
      : { audio: enhanced.audio, format: 'wav' as const };
    log.info('[VoiceEnhancement]', {
      event: 'completed',
      source: options.source,
      context: options.context,
      profileId: options.profileId,
      languageId: options.languageId,
      backend: enhanced.backend,
      inferenceMs: enhanced.processingMs,
      totalMs: Date.now() - startedAt,
      originalDurationSeconds: enhanced.originalDurationSeconds,
      enhancedDurationSeconds: enhanced.enhancedDurationSeconds,
    });
    return { original, enhanced: mastered };
  } catch (error) {
    log.warn('[VoiceEnhancement]', {
      event: 'bypassed',
      source: options.source,
      context: options.context,
      profileId: options.profileId,
      languageId: options.languageId,
      totalMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    });
    const sourceLabel = options.source === 'chatterbox' ? 'Chatterbox' : 'Qwen3-TTS';
    return {
      original,
      enhancementError: `Enhancement is unavailable. The original ${sourceLabel} audio is available.`,
    };
  }
}

export async function processChatterboxAudioVariants(
  raw: { audio: Uint8Array; format: string },
  options: {
    attemptEnhancement: boolean;
    context: 'preview' | 'classroom';
    profileId: string;
    languageId: string;
  },
): Promise<VoiceAudioVariants> {
  return processVoiceAudioVariants(raw, {
    ...options,
    source: 'chatterbox',
    originalMasteringPreset: 'chatterbox-clarity',
    enhancedMasteringPreset: 'chatterbox-enhanced',
  });
}
