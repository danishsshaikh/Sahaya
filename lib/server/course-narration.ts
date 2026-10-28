import { Buffer } from 'node:buffer';
import {
  BODHAN_STYLES,
  BODHAN_VOICES,
  VOICE_COMPARISON_LANGUAGES,
  VOICE_COMPARISON_PROVIDERS,
  getVoiceComparisonProvider,
  isBodhanStyle,
  isBodhanVoice,
} from '@/lib/voice-comparison/catalog';
import {
  concatenatePcmWav,
  readWavMetadata,
  splitSpeechTextPreservingText,
} from '@/lib/voice-comparison/audio';
import { BodhanIndicSpeakPreviewProvider } from '@/lib/voice-comparison/providers/bodhan';
import type {
  VoiceComparisonBootstrap,
  VoiceComparisonLanguageCode,
  VoiceComparisonPreviewRequest,
  VoiceComparisonPreviewResult,
  VoiceComparisonProviderId,
} from '@/lib/voice-comparison/types';
import {
  generateVoiceComparisonPreview,
  getVoiceComparisonBootstrap,
  requireOwnedReadyProfile,
} from '@/lib/server/voice-comparison';
import {
  createVoiceComparisonCacheKey,
  readVoiceComparisonCache,
  readVoiceComparisonCacheEntries,
  writeVoiceComparisonCache,
} from '@/lib/server/voice-comparison-cache';
import {
  externalVoiceProviderConfigured,
  getBodhanTtsConfig,
} from '@/lib/server/voice-comparison-config';
import { runControlledVoicePreview } from '@/lib/server/voice-comparison-control';
import { isExperimentalCourseNarrationEnabled } from '@/lib/config/feature-flags';
import { TeachingVoiceError, toPublicVoiceProfile } from '@/lib/voice-cloning/types';
import { enhanceGeneratedVoiceAudio } from '@/lib/voice-cloning/resemble-enhance';
import { isVoiceEnhancementAllowed } from '@/lib/voice-cloning/config';

export async function getCourseNarrationBootstrap(input: {
  ownerId: string;
  stageId: string;
  profileId?: string;
}): Promise<VoiceComparisonBootstrap> {
  const coursePreviews = await readVoiceComparisonCacheEntries(
    input.ownerId,
    `course:${input.stageId}`,
  );
  if (input.profileId) {
    try {
      const profile = await requireOwnedReadyProfile(input.ownerId, input.profileId);
      const bootstrap = await getVoiceComparisonBootstrap(input.ownerId, profile);
      const publicProfile = toPublicVoiceProfile(profile);
      return {
        ...bootstrap,
        savedPreviews: [...coursePreviews, ...bootstrap.savedPreviews].sort((left, right) =>
          right.generatedAt.localeCompare(left.generatedAt),
        ),
        ...(publicProfile ? { profile: publicProfile } : {}),
      };
    } catch (error) {
      // A legacy course may retain a profile id whose private profile was
      // removed. The course still exists and preset Bodhan remains usable.
      if (!(error instanceof TeachingVoiceError) || error.status !== 404) throw error;
    }
  }
  const bodhanConfigured = externalVoiceProviderConfigured(getBodhanTtsConfig());
  return {
    providers: VOICE_COMPARISON_PROVIDERS.map((provider) => {
      const presetAvailable = provider.id === 'bodhan' && bodhanConfigured;
      return {
        ...provider,
        configured: presetAvailable,
        available: presetAvailable,
        courseNarrationEnabled:
          provider.supportsCourseNarration &&
          (!provider.experimental || isExperimentalCourseNarrationEnabled()),
        ...(presetAvailable
          ? {}
          : {
              unavailableReason:
                provider.id === 'bodhan'
                  ? 'Not configured'
                  : 'Select an existing Teaching Voice profile.',
            }),
      };
    }),
    languages: VOICE_COMPARISON_LANGUAGES,
    bodhanVoices: BODHAN_VOICES,
    bodhanStyles: [...BODHAN_STYLES],
    savedPreviews: coursePreviews,
  };
}

async function generateBodhanCourseAudio(input: {
  ownerId: string;
  stageId: string;
  text: string;
  language: VoiceComparisonLanguageCode;
  voice?: string;
  style?: string;
  signal?: AbortSignal;
}): Promise<VoiceComparisonPreviewResult> {
  if (!input.text.trim()) throw new TeachingVoiceError('Narration text is empty.');
  if (!isBodhanVoice(input.voice)) throw new TeachingVoiceError('Select a supported Bodhan voice.');
  if (input.style && !isBodhanStyle(input.style)) {
    throw new TeachingVoiceError('Select a supported Bodhan speaking style.');
  }
  const capability = getVoiceComparisonProvider('bodhan');
  if (!capability.supportedLanguages.includes(input.language)) {
    throw new TeachingVoiceError('Bodhan Indic-Speak does not support the selected language.');
  }
  const cacheKey = createVoiceComparisonCacheKey({
    ownerId: input.ownerId,
    stageId: input.stageId,
    providerId: 'bodhan',
    language: input.language,
    voice: input.voice,
    style: input.style ?? null,
    text: input.text,
    purpose: 'course-narration-v1',
  });
  const cached = await readVoiceComparisonCache(input.ownerId, cacheKey);
  if (cached) return cached;
  const config = getBodhanTtsConfig();
  return runControlledVoicePreview({
    providerId: 'bodhan',
    requestKey: `course-narration:${input.ownerId}:${cacheKey}`,
    concurrency: config.maxConcurrency,
    task: async () => {
      const secondCached = await readVoiceComparisonCache(input.ownerId, cacheKey);
      if (secondCached) return secondCached;
      const startedAt = Date.now();
      const chunks =
        input.text.length <= 700 ? [input.text] : splitSpeechTextPreservingText(input.text, 700);
      const provider = new BodhanIndicSpeakPreviewProvider(config);
      const parts: Uint8Array[] = [];
      let requestId: string | undefined;
      for (const text of chunks) {
        const generated = await provider.synthesize({
          text,
          language: input.language,
          voice: input.voice!,
          style: input.style,
          signal: input.signal,
        });
        parts.push(generated.audio);
        requestId ??= generated.requestId;
      }
      const audio = concatenatePcmWav(parts);
      const generatedAt = new Date().toISOString();
      const result: VoiceComparisonPreviewResult = {
        profileId: `course:${input.stageId}`,
        providerId: 'bodhan',
        providerName: capability.name,
        voiceType: capability.voiceType,
        language: input.language,
        voice: input.voice,
        ...(input.style ? { style: input.style } : {}),
        audio: {
          format: 'wav',
          base64: Buffer.from(audio).toString('base64'),
          createdAt: generatedAt,
        },
        durationSeconds: readWavMetadata(audio).durationSeconds,
        generationLatencyMs: Date.now() - startedAt,
        generatedAt,
        cached: false,
        cacheKey,
        processingMode: 'standard',
        outputCodec: 'wav',
        ...(requestId ? { providerRequestId: requestId } : {}),
        chunked: chunks.length > 1,
        request: {
          text: input.text,
          language: input.language,
          voice: input.voice,
          ...(input.style ? { style: input.style } : {}),
        },
      };
      await writeVoiceComparisonCache(input.ownerId, result);
      return result;
    },
  });
}

export async function synthesizeCourseNarration(input: {
  ownerId: string;
  stageId: string;
  profileId?: string;
  providerId: VoiceComparisonProviderId;
  text: string;
  language: VoiceComparisonLanguageCode;
  voice?: string;
  style?: string;
  enhancementMode?: 'standard' | 'resemble-enhance';
  signal?: AbortSignal;
}): Promise<VoiceComparisonPreviewResult> {
  const capability = getVoiceComparisonProvider(input.providerId);
  if (!capability.supportsCourseNarration) {
    throw new TeachingVoiceError(`${capability.name} is not enabled for course narration.`, 403);
  }
  if (capability.experimental && !isExperimentalCourseNarrationEnabled()) {
    throw new TeachingVoiceError('Experimental course narration is disabled.', 403);
  }
  if (input.providerId === 'bodhan') return generateBodhanCourseAudio(input);
  if (!input.profileId) throw new TeachingVoiceError('Select an existing Teaching Voice profile.');
  const request: VoiceComparisonPreviewRequest = {
    profileId: input.profileId,
    providerId: input.providerId,
    text: input.text,
    language: input.language,
    ...(input.voice ? { voice: input.voice } : {}),
    ...(input.style ? { style: input.style } : {}),
  };
  // In particular, no Sarvam consent/create flags are passed here: course narration
  // may reuse an existing clone, but can never create or replace one implicitly.
  const raw = await generateVoiceComparisonPreview({
    ownerId: input.ownerId,
    request,
    signal: input.signal,
    preserveTextChunks: true,
  });
  if (input.enhancementMode !== 'resemble-enhance') return raw;
  if (
    (input.providerId !== 'chatterbox' && input.providerId !== 'qwen3-tts') ||
    !isVoiceEnhancementAllowed(input.providerId, input.language, 'classroom')
  ) {
    throw new TeachingVoiceError('Resemble Enhance is unavailable for this provider and language.');
  }
  const enhanced = await enhanceGeneratedVoiceAudio({
    audio: new Uint8Array(Buffer.from(raw.audio.base64, 'base64')),
    format: raw.audio.format,
  });
  const result: VoiceComparisonPreviewResult = {
    ...raw,
    audio: {
      format: enhanced.format,
      base64: Buffer.from(enhanced.audio).toString('base64'),
      createdAt: new Date().toISOString(),
    },
    durationSeconds: enhanced.enhancedDurationSeconds,
    processingMode: 'standard',
    request: raw.request
      ? { ...raw.request, enhancementMode: 'resemble-enhance' }
      : {
          text: input.text,
          language: input.language,
          enhancementMode: 'resemble-enhance',
        },
    cacheKey: createVoiceComparisonCacheKey({
      source: raw.cacheKey,
      enhancementMode: 'resemble-enhance',
      purpose: 'course-narration-v1',
    }),
    cached: false,
  };
  await writeVoiceComparisonCache(input.ownerId, result);
  return result;
}
