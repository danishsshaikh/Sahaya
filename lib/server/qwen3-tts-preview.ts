import { getVoicePreviewText } from '@/lib/voice-cloning/phrases';
import { isVoiceEnhancementAllowed } from '@/lib/voice-cloning/config';
import { processVoiceAudioVariants } from '@/lib/voice-cloning/audio-enhancement';
import { Qwen3TtsPreviewProvider } from '@/lib/voice-cloning/providers/qwen3-preview';
import { referenceAudioExists, resolveReferenceAudioPath } from '@/lib/voice-cloning/storage';
import {
  TeachingVoiceError,
  type Qwen3TtsCloneMode,
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
  cloneMode: Qwen3TtsCloneMode,
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

  const provider = new Qwen3TtsPreviewProvider();
  await provider.registerProfile({
    profileId: profile.id,
    referenceAudioPath: resolveReferenceAudioPath(profile.referenceAudioKey),
    referenceText,
    cloneMode,
  });
  const raw = await provider.generatePreview({
    profileId: profile.id,
    text: getVoicePreviewText('en', 'chatterbox'),
    cloneMode,
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
    qwenCloneMode: cloneMode,
    enhancementMode,
    preview: comparison.original,
    comparison,
  };
}
