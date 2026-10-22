import { createHash } from 'node:crypto';
import { getVoicePreviewText } from '@/lib/voice-cloning/phrases';
import { isVoiceEnhancementAllowed } from '@/lib/voice-cloning/config';
import { processVoiceAudioVariants } from '@/lib/voice-cloning/audio-enhancement';
import { Qwen3TtsVoiceCloningProvider } from '@/lib/voice-cloning/providers/qwen3-preview';
import { referenceAudioExists, resolveReferenceAudioPath } from '@/lib/voice-cloning/storage';
import {
  TeachingVoiceError,
  type VoiceEnhancementMode,
  type VoiceModelPreviewResult,
  type VoicePreview,
  type VoiceProfile,
} from '@/lib/voice-cloning/types';

function voicePreview(audio: Uint8Array, format: string): VoicePreview {
  return {
    format,
    base64: Buffer.from(audio).toString('base64'),
    createdAt: new Date().toISOString(),
  };
}

export async function generateQwen3TtsModelPreview(
  profile: VoiceProfile,
  enhancementMode: VoiceEnhancementMode,
): Promise<VoiceModelPreviewResult> {
  if (!profile.referenceAudioKey || !(await referenceAudioExists(profile.referenceAudioKey))) {
    throw new TeachingVoiceError('Teaching Voice reference audio was not found.', 404);
  }
  const referenceText = profile.referenceText?.trim();
  if (!referenceText) {
    throw new TeachingVoiceError(
      'Qwen3-TTS needs the transcript saved with this Teaching Voice recording.',
    );
  }
  if (profile.language !== 'en') {
    throw new TeachingVoiceError(
      'Qwen3-TTS preview currently supports English Teaching Voice recordings only.',
    );
  }

  const provider = new Qwen3TtsVoiceCloningProvider();
  const { providerReferenceId } = await provider.createProfile({
    profileId: profile.id,
    referenceAudioKey: resolveReferenceAudioPath(profile.referenceAudioKey),
    referenceText,
    language: profile.language,
  });
  const raw = await provider.generatePreview({
    providerReferenceId,
    text: getVoicePreviewText('en', 'chatterbox'),
    language: 'en',
  });
  const enhancementAllowed = isVoiceEnhancementAllowed('qwen3-tts', 'en', 'preview');
  const variants = await processVoiceAudioVariants(raw, {
    attemptEnhancement: enhancementAllowed,
    context: 'preview',
    profileId: profile.id,
    languageId: 'en',
    source: 'qwen3-tts',
    originalMasteringPreset: null,
    enhancedMasteringPreset: null,
  });
  const original = voicePreview(variants.original.audio, variants.original.format);
  const enhanced = variants.enhanced
    ? voicePreview(variants.enhanced.audio, variants.enhanced.format)
    : undefined;
  const comparison = {
    original,
    ...(enhanced ? { enhanced } : {}),
    ...(variants.enhancementError
      ? { enhancementError: variants.enhancementError }
      : !enhancementAllowed
        ? { enhancementError: 'Enhanced preview is disabled for this deployment.' }
        : {}),
  };
  return {
    previewModel: 'qwen3-tts-1.7b-base',
    qwenCloneMode: 'speaker-embedding',
    enhancementMode,
    preview: comparison.original,
    comparison,
  };
}

export function createQwen3TtsPreviewCacheKey(profile: VoiceProfile): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        profileId: profile.id,
        profileVersion: profile.profileVersion,
        referenceAudioKey: profile.referenceAudioKey ?? null,
        referenceText: profile.referenceText ?? null,
        previewText: getVoicePreviewText('en', 'chatterbox'),
        cloneMode: 'speaker-embedding',
      }),
    )
    .digest('hex');
}

export function currentQwen3TtsPreview(profile: VoiceProfile): VoiceModelPreviewResult | undefined {
  const cache = profile.qwenPreviewCache;
  return cache?.cacheKey === createQwen3TtsPreviewCacheKey(profile) ? cache.result : undefined;
}
