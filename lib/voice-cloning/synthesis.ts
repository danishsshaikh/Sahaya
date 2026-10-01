import { isVoiceCloningServerEnabled } from '@/lib/voice-cloning/config';
import { getVoiceCloningProvider } from '@/lib/voice-cloning/provider';
import {
  readVoiceProfile,
  referenceAudioExists,
  writeVoiceProfile,
  resolveReferenceAudioPath,
} from '@/lib/voice-cloning/storage';
import { validateTeachingVoiceLanguage } from '@/lib/voice-cloning/language';
import { masterGeneratedVoiceAudio } from '@/lib/voice-cloning/audio-validation';
import { createLogger } from '@/lib/logger';
import {
  isVoiceProviderProfileNotFoundError,
  resolveVoiceProfileGenerationSettings,
  resolveVoiceProfileProvider,
  resolveVoiceProfileModelVariant,
  TeachingVoiceError,
  TeachingVoiceProviderOperationError,
} from '@/lib/voice-cloning/types';

const log = createLogger('VoiceCloningSynthesis');

const DEFAULT_BUSY_RETRY_BASE_MS = 3000;
const DEFAULT_BUSY_RETRY_MAX_RETRIES = 4;
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
  const { maxRetries } = busyRetryConfig();
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
      if (isProviderBusyError(error) && attempt <= maxRetries) {
        const retryDelayMs = busyRetryDelayMs(attempt);
        traceTeachingVoiceSynthesis('provider-busy', {
          attempt,
          durationMs,
          retryDelayMs,
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
        ...metadata,
      });
      throw error;
    }
  }
}

export async function resolveFacultyVoiceProviderId(
  profileId: string,
  ownerId: string,
): Promise<string> {
  if (!isVoiceCloningServerEnabled()) {
    throw new TeachingVoiceError('Voice cloning is disabled.', 403);
  }
  const profile = await readVoiceProfile(profileId, ownerId);
  if (!profile || profile.ownerId !== ownerId || profile.status === 'deleted') {
    throw new TeachingVoiceError('Voice profile not found.', 404);
  }
  return resolveVoiceProfileProvider(profile);
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
  const language = validateTeachingVoiceLanguage(profile, input.language);
  const providerId = resolveVoiceProfileProvider(profile);
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
    const mastered = await masterGeneratedVoiceAudio(result.audio, result.format);
    traceTeachingVoiceSynthesis('mastering-complete', {
      profileId: profile.id,
      provider: providerId,
      operation: 'synthesize',
      format: mastered.format,
      durationMs: Date.now() - masteringStartedAt,
    });
    return mastered;
  };

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
    language,
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
