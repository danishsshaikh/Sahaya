import {
  isQwen3TtsClassroomEnabled,
  isVoiceCloningServerEnabled,
  isVoiceEnhancementAllowed,
} from '@/lib/voice-cloning/config';
import { getVoiceCloningProvider } from '@/lib/voice-cloning/provider';
import {
  readVoiceProfile,
  referenceAudioExists,
  writeVoiceProfile,
  resolveReferenceAudioPath,
} from '@/lib/voice-cloning/storage';
import {
  resolveTeachingVoiceLanguage,
  resolveVoiceProfileReferenceLanguage,
  validateTeachingVoiceLanguage,
} from '@/lib/voice-cloning/language';
import { masterGeneratedVoiceAudio } from '@/lib/voice-cloning/audio-validation';
import {
  processChatterboxAudioVariants,
  processVoiceAudioVariants,
} from '@/lib/voice-cloning/audio-enhancement';
import { createLogger } from '@/lib/logger';
import {
  isVoiceProviderProfileNotFoundError,
  resolveVoiceProfileActiveEngine,
  resolveVoiceProfileGenerationSettings,
  resolveVoiceProfileEnhancementMode,
  resolveVoiceProfileLanguageId,
  resolveVoiceProfileModelVariant,
  resolveVoiceProfileQwenEnhancementMode,
  TeachingVoiceError,
  TeachingVoiceProviderOperationError,
} from '@/lib/voice-cloning/types';

const log = createLogger('VoiceCloningSynthesis');

const DEFAULT_BUSY_RETRY_BASE_MS = 3000;
const DEFAULT_BUSY_RETRY_MAX_RETRIES = 20;
const DEFAULT_BUSY_RETRY_MAX_WAIT_MS = 5 * 60 * 1000;
const DEFAULT_QWEN_BUSY_MAX_RETRIES = 1;
const DEFAULT_QWEN_BUSY_MAX_WAIT_MS = 90 * 1000;
const MAX_BUSY_RETRY_DELAY_MS = 30000;

function traceTeachingVoiceSynthesis(event: string, extra: Record<string, unknown>) {
  log.info('[TeachingVoiceSynthesis]', { event, ...extra });
}

function traceTeachingVoiceQueue(event: string, extra: Record<string, unknown>) {
  log.info('[TeachingVoiceQueue]', { event, ...extra });
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function busyRetryConfig(provider?: unknown) {
  const qwen = provider === 'qwen3-tts';
  return {
    baseDelayMs: parsePositiveInteger(
      process.env.TEACHING_VOICE_BUSY_RETRY_BASE_MS,
      DEFAULT_BUSY_RETRY_BASE_MS,
    ),
    maxRetries: parsePositiveInteger(
      qwen ? process.env.QWEN3_TTS_BUSY_MAX_RETRIES : process.env.TEACHING_VOICE_BUSY_MAX_RETRIES,
      qwen ? DEFAULT_QWEN_BUSY_MAX_RETRIES : DEFAULT_BUSY_RETRY_MAX_RETRIES,
    ),
    maxWaitMs: parsePositiveInteger(
      qwen ? process.env.QWEN3_TTS_BUSY_MAX_WAIT_MS : process.env.TEACHING_VOICE_BUSY_MAX_WAIT_MS,
      qwen ? DEFAULT_QWEN_BUSY_MAX_WAIT_MS : DEFAULT_BUSY_RETRY_MAX_WAIT_MS,
    ),
  };
}

function busyRetryDelayMs(attempt: number, provider?: unknown): number {
  const { baseDelayMs } = busyRetryConfig(provider);
  return Math.min(baseDelayMs * 2 ** Math.max(0, attempt - 1), MAX_BUSY_RETRY_DELAY_MS);
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function isProviderBusyError(error: unknown): error is TeachingVoiceProviderOperationError {
  return (
    error instanceof TeachingVoiceProviderOperationError &&
    error.metadata.operation === 'synthesis' &&
    error.metadata.providerStatus === 429
  );
}

function isProviderTimeoutError(error: unknown): boolean {
  return (
    error instanceof TeachingVoiceProviderOperationError &&
    error.metadata.operation === 'synthesis' &&
    /timed out/i.test(error.message)
  );
}

function resolveSynthesisLanguage(
  profile: Parameters<typeof resolveVoiceProfileActiveEngine>[0] &
    Parameters<typeof validateTeachingVoiceLanguage>[0],
  providerId: string,
  requestedLanguage?: string,
): string {
  if (providerId !== 'qwen3-tts') {
    return validateTeachingVoiceLanguage(
      profile,
      providerId === 'chatterbox' ? resolveVoiceProfileLanguageId(profile) : requestedLanguage,
    );
  }
  if (resolveVoiceProfileReferenceLanguage(profile) !== 'en') {
    throw new TeachingVoiceError('Qwen3-TTS requires an English reference recording.');
  }
  if (requestedLanguage && resolveTeachingVoiceLanguage(requestedLanguage) !== 'en') {
    throw new TeachingVoiceError('Qwen3-TTS currently supports English narration only.');
  }
  if (!profile.referenceText?.trim()) {
    throw new TeachingVoiceError('Qwen3-TTS requires the saved reference transcript.');
  }
  return 'en';
}

async function synthesizeWithBusyRetry<T>(
  metadata: Record<string, unknown>,
  operation: (attempt: number) => Promise<T>,
): Promise<T> {
  const { maxRetries, maxWaitMs } = busyRetryConfig(metadata.provider);
  const startedAt = Date.now();
  let attempt = 1;

  while (true) {
    const attemptStartedAt = Date.now();
    traceTeachingVoiceSynthesis('attempt-start', { attempt, ...metadata });
    if (metadata.queueJobId) {
      traceTeachingVoiceQueue('provider-attempt', { attempt, ...metadata });
    }
    try {
      const result = await operation(attempt);
      traceTeachingVoiceSynthesis('completed', {
        attempt,
        durationMs: Date.now() - attemptStartedAt,
        ...metadata,
      });
      return result;
    } catch (error) {
      const durationMs = Date.now() - attemptStartedAt;
      const retryDelayMs = busyRetryDelayMs(attempt, metadata.provider);
      const busyWaitElapsedMs = Date.now() - startedAt;
      if (
        isProviderBusyError(error) &&
        attempt <= maxRetries &&
        busyWaitElapsedMs + retryDelayMs <= maxWaitMs
      ) {
        traceTeachingVoiceSynthesis('provider-busy', {
          attempt,
          durationMs,
          retryDelayMs,
          busyWaitElapsedMs,
          maxBusyWaitMs: maxWaitMs,
          ...metadata,
        });
        if (metadata.queueJobId) {
          traceTeachingVoiceQueue('provider-busy', {
            attempt,
            durationMs,
            retryDelayMs,
            ...metadata,
          });
        }
        traceTeachingVoiceSynthesis('retry-scheduled', {
          attempt,
          nextAttempt: attempt + 1,
          retryDelayMs,
          ...metadata,
        });
        if (metadata.queueJobId) {
          traceTeachingVoiceQueue('provider-retry', {
            attempt,
            nextAttempt: attempt + 1,
            retryDelayMs,
            ...metadata,
          });
        }
        await sleep(retryDelayMs);
        attempt += 1;
        continue;
      }

      traceTeachingVoiceSynthesis(isProviderTimeoutError(error) ? 'timeout' : 'failed', {
        attempt,
        durationMs,
        busyRetryExhausted: isProviderBusyError(error),
        busyWaitElapsedMs: Date.now() - startedAt,
        maxBusyWaitMs: maxWaitMs,
        ...metadata,
      });
      throw error;
    }
  }
}

export async function resolveFacultyVoiceSelection(
  profileId: string,
  ownerId: string,
  requestedLanguage?: string,
): Promise<{ providerId: string; synthesisLanguage?: string }> {
  if (!isVoiceCloningServerEnabled()) {
    throw new TeachingVoiceError('Voice cloning is disabled.', 403);
  }
  const profile = await readVoiceProfile(profileId, ownerId);
  if (!profile || profile.ownerId !== ownerId || profile.status === 'deleted') {
    throw new TeachingVoiceError('Voice profile not found.', 404);
  }
  const providerId = resolveVoiceProfileActiveEngine(profile);
  if (providerId === 'qwen3-tts' && !isQwen3TtsClassroomEnabled()) {
    throw new TeachingVoiceError('Qwen3-TTS classroom narration is disabled.', 503);
  }
  const synthesisLanguage = resolveSynthesisLanguage(profile, providerId, requestedLanguage);
  return {
    providerId,
    synthesisLanguage,
  };
}

export async function resolveFacultyVoiceProviderId(
  profileId: string,
  ownerId: string,
): Promise<string> {
  return (await resolveFacultyVoiceSelection(profileId, ownerId)).providerId;
}

export async function synthesizeFacultyVoice(input: {
  profileId: string;
  ownerId: string;
  text: string;
  language?: string;
  queueJobId?: string;
}): Promise<{ audio: Uint8Array; format: string }> {
  if (!isVoiceCloningServerEnabled()) {
    throw new TeachingVoiceError('Voice cloning is disabled.', 403);
  }
  const profile = await readVoiceProfile(input.profileId, input.ownerId);
  if (!profile || profile.ownerId !== input.ownerId || profile.status === 'deleted') {
    throw new TeachingVoiceError('Voice profile not found.', 404);
  }
  if (profile.status !== 'ready') {
    throw new TeachingVoiceError('Voice profile is not ready.');
  }
  if (!(await referenceAudioExists(profile.referenceAudioKey))) {
    throw new TeachingVoiceError('Voice profile reference audio not found. Re-enroll this voice.');
  }
  const providerId = resolveVoiceProfileActiveEngine(profile);
  if (providerId === 'qwen3-tts' && !isQwen3TtsClassroomEnabled()) {
    throw new TeachingVoiceError('Qwen3-TTS classroom narration is disabled.', 503);
  }
  if (providerId !== 'qwen3-tts' && !profile.providerReferenceId) {
    throw new TeachingVoiceError('Voice profile is not ready.');
  }
  const language = resolveSynthesisLanguage(profile, providerId, input.language);
  const qwenEnhancementRequested =
    providerId === 'qwen3-tts' &&
    resolveVoiceProfileQwenEnhancementMode(profile) === 'resemble-enhance';
  if (qwenEnhancementRequested && !isVoiceEnhancementAllowed('qwen3-tts', language, 'classroom')) {
    throw new TeachingVoiceError(
      'Enhanced Qwen3-TTS classroom narration is disabled for this deployment.',
      503,
    );
  }
  const chatterboxEnhancementRequested =
    providerId === 'chatterbox' &&
    resolveVoiceProfileEnhancementMode(profile) === 'resemble-enhance';
  if (
    chatterboxEnhancementRequested &&
    !isVoiceEnhancementAllowed('chatterbox', language, 'classroom')
  ) {
    throw new TeachingVoiceError(
      'Enhanced Chatterbox classroom narration is disabled for this deployment or language.',
      503,
    );
  }
  const settings =
    providerId === 'chatterbox'
      ? {
          modelVariant: resolveVoiceProfileModelVariant(profile),
          generationSettings: resolveVoiceProfileGenerationSettings(profile),
        }
      : {};
  const provider = getVoiceCloningProvider(providerId);
  const synthesize = async (providerReferenceId: string) => {
    const metadata = {
      profileId: profile.id,
      provider: providerId,
      textLength: input.text.length,
      language,
      ...(input.queueJobId ? { queueJobId: input.queueJobId } : {}),
    };
    const run = () =>
      synthesizeWithBusyRetry(metadata, () =>
        provider.synthesize({
          providerReferenceId,
          text: input.text,
          language,
          ...settings,
        }),
      );
    const result = await run();
    const masteringStartedAt = Date.now();
    traceTeachingVoiceSynthesis('mastering-start', {
      ...metadata,
    });
    let mastered: { audio: Uint8Array; format: string };
    if (providerId === 'chatterbox') {
      const variants = await processChatterboxAudioVariants(result, {
        attemptEnhancement: chatterboxEnhancementRequested,
        context: 'classroom',
        profileId: profile.id,
        languageId: language,
      });
      mastered = variants.enhanced ?? variants.original;
      if (chatterboxEnhancementRequested && !variants.enhanced) {
        throw new TeachingVoiceError(
          variants.enhancementError || 'Enhanced Chatterbox narration could not be generated.',
          502,
        );
      }
    } else if (providerId === 'qwen3-tts') {
      const variants = await processVoiceAudioVariants(result, {
        attemptEnhancement: qwenEnhancementRequested,
        context: 'classroom',
        profileId: profile.id,
        languageId: language,
        source: 'qwen3-tts',
        originalMasteringPreset: null,
        enhancedMasteringPreset: null,
      });
      if (qwenEnhancementRequested && !variants.enhanced) {
        throw new TeachingVoiceError(
          variants.enhancementError || 'Enhanced Qwen3-TTS narration could not be generated.',
          502,
        );
      }
      mastered = variants.enhanced ?? variants.original;
    } else {
      mastered = await masterGeneratedVoiceAudio(result.audio, result.format, 'indicf5-natural');
    }
    traceTeachingVoiceSynthesis('mastering-complete', {
      profileId: profile.id,
      provider: providerId,
      operation: 'synthesize',
      format: mastered.format,
      durationMs: Date.now() - masteringStartedAt,
    });
    return mastered;
  };

  if (profile.provider === 'qwen3' && providerId === 'chatterbox') {
    const { providerReferenceId } = await provider.createProfile({
      profileId: profile.id,
      referenceAudioKey: resolveReferenceAudioPath(profile.referenceAudioKey!),
      language: profile.language,
      ...settings,
    });
    await writeVoiceProfile({
      ...profile,
      provider: 'chatterbox',
      providerReferenceId,
      modelVariant: settings.modelVariant,
      generationSettings: settings.generationSettings,
      enhancementMode: 'standard',
      preview: undefined,
      previewComparison: undefined,
      previewTextLanguageId: undefined,
      previewVariants: undefined,
      draftPreview: undefined,
      updatedAt: new Date().toISOString(),
    });
    return synthesize(providerReferenceId);
  }

  const providerReferenceId =
    providerId === 'qwen3-tts' ? profile.id : profile.providerReferenceId!;
  try {
    return await synthesize(providerReferenceId);
  } catch (error) {
    if (!isVoiceProviderProfileNotFoundError(error)) {
      throw error;
    }
  }

  const { providerReferenceId: recreatedProviderReferenceId } = await provider.createProfile({
    profileId: profile.id,
    referenceAudioKey: resolveReferenceAudioPath(profile.referenceAudioKey!),
    ...(profile.referenceText ? { referenceText: profile.referenceText } : {}),
    language: profile.language,
    ...settings,
  });
  if (providerId !== 'qwen3-tts' && recreatedProviderReferenceId !== profile.providerReferenceId) {
    await writeVoiceProfile({
      ...profile,
      providerReferenceId: recreatedProviderReferenceId,
      updatedAt: new Date().toISOString(),
    });
  }
  return synthesize(recreatedProviderReferenceId);
}
