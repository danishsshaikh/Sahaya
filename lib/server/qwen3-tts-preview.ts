import { createHash } from 'node:crypto';
import { markVoiceConfigured } from '@/lib/auth/server';
import { getVoicePreviewText } from '@/lib/voice-cloning/phrases';
import {
  isQwen3TtsClassroomEnabled,
  isQwen3TtsPreviewEnabled,
  isVoiceEnhancementAllowed,
} from '@/lib/voice-cloning/config';
import { processVoiceAudioVariants } from '@/lib/voice-cloning/audio-enhancement';
import { Qwen3TtsVoiceCloningProvider } from '@/lib/voice-cloning/providers/qwen3-preview';
import {
  activateVoiceProfile,
  referenceAudioExists,
  resolveReferenceAudioPath,
  writeVoiceProfile,
} from '@/lib/voice-cloning/storage';
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
  previewText = getVoicePreviewText('en', 'chatterbox'),
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
    text: previewText,
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
    previewText,
  };
}

export function createQwen3TtsPreviewCacheKey(
  profile: VoiceProfile,
  previewText = profile.qwenPreviewCache?.result.previewText ??
    getVoicePreviewText('en', 'chatterbox'),
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        profileId: profile.id,
        profileVersion: profile.profileVersion,
        referenceAudioKey: profile.referenceAudioKey ?? null,
        referenceText: profile.referenceText ?? null,
        previewText,
        cloneMode: 'speaker-embedding',
      }),
    )
    .digest('hex');
}

export function currentQwen3TtsPreview(profile: VoiceProfile): VoiceModelPreviewResult | undefined {
  const cache = profile.qwenPreviewCache;
  return cache?.cacheKey === createQwen3TtsPreviewCacheKey(profile) ? cache.result : undefined;
}

export async function activateEnhancedQwenTeachingVoice(
  profile: VoiceProfile,
  ownerId: string,
): Promise<VoiceProfile> {
  if (profile.ownerId !== ownerId) {
    throw new TeachingVoiceError('Teaching Voice profile does not belong to this account.', 403);
  }
  if (profile.language !== 'en' || !profile.referenceText?.trim()) {
    throw new TeachingVoiceError(
      'An accurate English transcript is required to generate this Teaching Voice.',
    );
  }
  if (!isQwen3TtsPreviewEnabled() || !isQwen3TtsClassroomEnabled()) {
    throw new TeachingVoiceError('Voice generation is not enabled on this deployment.', 503);
  }
  if (
    !isVoiceEnhancementAllowed('qwen3-tts', 'en', 'preview') ||
    !isVoiceEnhancementAllowed('qwen3-tts', 'en', 'classroom')
  ) {
    throw new TeachingVoiceError(
      'Enhanced Teaching Voice output is not enabled for both samples and classroom narration.',
      503,
    );
  }

  const modelPreview =
    currentQwen3TtsPreview(profile) ??
    (await generateQwen3TtsModelPreview(profile, 'resemble-enhance'));
  if (!modelPreview.comparison.enhanced) {
    throw new TeachingVoiceError(
      modelPreview.comparison.enhancementError || 'Voice enhancement did not produce audio.',
      502,
    );
  }

  const next: VoiceProfile = {
    ...profile,
    status: 'ready',
    activeEngine: 'qwen3-tts',
    qwenEnhancementMode: 'resemble-enhance',
    qwenPreviewCache: {
      cacheKey: createQwen3TtsPreviewCacheKey(profile, modelPreview.previewText),
      result: modelPreview,
    },
    failureReason: undefined,
    failurePhase: undefined,
    updatedAt: new Date().toISOString(),
  };
  await writeVoiceProfile(next);
  await activateVoiceProfile(ownerId, next.id);
  await markVoiceConfigured(ownerId);
  return next;
}
