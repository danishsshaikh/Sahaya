import { isVoiceCloningServerEnabled, isVoiceEnhancementAllowed } from '@/lib/voice-cloning/config';
import { getVoiceCloningProvider } from '@/lib/voice-cloning/provider';
import {
  readVoiceProfile,
  referenceAudioExists,
  writeVoiceProfile,
  resolveReferenceAudioPath,
} from '@/lib/voice-cloning/storage';
import { validateTeachingVoiceLanguage } from '@/lib/voice-cloning/language';
import { masterGeneratedVoiceAudio } from '@/lib/voice-cloning/audio-validation';
import { processChatterboxAudioVariants } from '@/lib/voice-cloning/audio-enhancement';
import { createLogger } from '@/lib/logger';
import {
  isVoiceProviderProfileNotFoundError,
  resolveVoiceProfileGenerationSettings,
  resolveVoiceProfileEnhancementMode,
  resolveVoiceProfileLanguageId,
  resolveVoiceProfileProvider,
  resolveVoiceProfileModelVariant,
  TeachingVoiceError,
  TeachingVoiceProviderOperationError,
} from '@/lib/voice-cloning/types';

const log = createLogger('VoiceCloningSynthesis');

const DEFAULT_BUSY_RETRY_BASE_MS = 3000;
const DEFAULT_BUSY_RETRY_MAX_RETRIES = 20;
const DEFAULT_BUSY_RETRY_MAX_WAIT_MS = 5 * 60 * 1000;
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

function busyRetryConfig() {
  return {
    baseDelayMs: parsePositiveInteger(
      process.env.TEACHING_VOICE_BUSY_RETRY_BASE_MS,
      DEFAULT_BUSY_RETRY_BASE_MS,
    ),
    maxRetries: parsePositiveInteger(
      process.env.TEACHING_VOICE_BUSY_MAX_RETRIES,
      DEFAULT_BUSY_RETRY_MAX_RETRIES,
    ),
    maxWaitMs: parsePositiveInteger(
      process.env.TEACHING_VOICE_BUSY_MAX_WAIT_MS,
      DEFAULT_BUSY_RETRY_MAX_WAIT_MS,
    ),
  };
}

function busyRetryDelayMs(attempt: number): number {
  const { baseDelayMs } = busyRetryConfig();
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

async function synthesizeWithBusyRetry<T>(
  metadata: Record<string, unknown>,
  operation: (attempt: number) => Promise<T>,
): Promise<T> {
  const { maxRetries, maxWaitMs } = busyRetryConfig();
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
      const retryDelayMs = busyRetryDelayMs(attempt);
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
  const providerId = resolveVoiceProfileProvider(profile);
  const synthesisLanguage = validateTeachingVoiceLanguage(
    profile,
    providerId === 'chatterbox'
      ? resolveVoiceProfileLanguageId(profile)
      : (requestedLanguage ?? resolveVoiceProfileLanguageId(profile)),
  );
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
  if (profile.status !== 'ready' || !profile.providerReferenceId) {
    throw new TeachingVoiceError('Voice profile is not ready.');
  }
  if (!(await referenceAudioExists(profile.referenceAudioKey))) {
    throw new TeachingVoiceError('Voice profile reference audio not found. Re-enroll this voice.');
  }
  const providerId = resolveVoiceProfileProvider(profile);
  const language = validateTeachingVoiceLanguage(
    profile,
    providerId === 'chatterbox' ? resolveVoiceProfileLanguageId(profile) : input.language,
  );
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
      const enhancementRequested =
        resolveVoiceProfileEnhancementMode(profile) === 'resemble-enhance';
      const enhancementAllowed =
        enhancementRequested && isVoiceEnhancementAllowed(language, 'classroom');
      const variants = await processChatterboxAudioVariants(result, {
        attemptEnhancement: enhancementRequested && enhancementAllowed,
        context: 'classroom',
        profileId: profile.id,
        languageId: language,
      });
      mastered = variants.enhanced ?? variants.original;
      if (enhancementRequested && !enhancementAllowed) {
        traceTeachingVoiceSynthesis('enhancement-bypassed', {
          ...metadata,
          reason: 'disabled-for-classroom-or-language',
        });
      }
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

  if (profile.provider === 'qwen3') {
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

  try {
    return await synthesize(profile.providerReferenceId);
  } catch (error) {
    if (!isVoiceProviderProfileNotFoundError(error)) {
      throw error;
    }
  }

  const { providerReferenceId } = await provider.createProfile({
    profileId: profile.id,
    referenceAudioKey: resolveReferenceAudioPath(profile.referenceAudioKey!),
    ...(profile.referenceText ? { referenceText: profile.referenceText } : {}),
    language: profile.language,
    ...settings,
  });
  if (providerReferenceId !== profile.providerReferenceId) {
    await writeVoiceProfile({
      ...profile,
      providerReferenceId,
      updatedAt: new Date().toISOString(),
    });
  }
  return synthesize(providerReferenceId);
}
