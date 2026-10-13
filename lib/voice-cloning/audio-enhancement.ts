import { masterGeneratedVoiceAudio } from '@/lib/voice-cloning/audio-validation';
import { enhanceGeneratedVoiceAudio } from '@/lib/voice-cloning/resemble-enhance';
import { createLogger } from '@/lib/logger';

const log = createLogger('VoiceAudioEnhancement');

export interface ProcessedVoiceAudio {
  audio: Uint8Array;
  format: 'wav';
}

export interface ChatterboxAudioVariants {
  original: ProcessedVoiceAudio;
  enhanced?: ProcessedVoiceAudio;
  enhancementError?: string;
}

export async function processChatterboxAudioVariants(
  raw: { audio: Uint8Array; format: string },
  options: {
    attemptEnhancement: boolean;
    context: 'preview' | 'classroom';
    profileId: string;
    languageId: string;
  },
): Promise<ChatterboxAudioVariants> {
  const original = await masterGeneratedVoiceAudio(raw.audio, raw.format, 'chatterbox-clarity');
  if (!options.attemptEnhancement) return { original };

  const startedAt = Date.now();
  try {
    const enhanced = await enhanceGeneratedVoiceAudio(raw);
    const mastered = await masterGeneratedVoiceAudio(
      enhanced.audio,
      enhanced.format,
      'chatterbox-enhanced',
    );
    log.info('[VoiceEnhancement]', {
      event: 'completed',
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
      context: options.context,
      profileId: options.profileId,
      languageId: options.languageId,
      totalMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      original,
      enhancementError: 'Enhancement is unavailable. The original Chatterbox audio is available.',
    };
  }
}
