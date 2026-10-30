import { createHash } from 'node:crypto';
import { getResourceJobQueue, type ResourceJobSnapshot } from '@/lib/server/resource-job-queue';
import {
  cleanupTeachingVoiceArtifacts,
  findTeachingVoiceArtifactByIdempotencyKey,
  persistTeachingVoiceArtifact,
  readTeachingVoiceArtifact,
  teachingVoiceArtifactSnapshot,
  TeachingVoiceArtifactInvalidError,
} from '@/lib/voice-cloning/teaching-voice-artifacts';
import { synthesizeFacultyVoice } from '@/lib/voice-cloning/synthesis';
import { createLogger } from '@/lib/logger';

const log = createLogger('TeachingVoiceJobs');

export const CHATTERBOX_TEACHING_VOICE_RESOURCE_KEY = 'teaching-voice:chatterbox';
export const INDICF5_TEACHING_VOICE_RESOURCE_KEY = 'teaching-voice:indicf5';
export const QWEN3_TTS_TEACHING_VOICE_RESOURCE_KEY = 'teaching-voice:qwen3-tts';

export type QueuedTeachingVoiceProvider = 'chatterbox' | 'indicf5' | 'qwen3-tts';

export interface TeachingVoiceJobResult {
  audio: Uint8Array;
  format: string;
}

export interface TeachingVoiceJobInput {
  ownerId: string;
  profileId: string;
  text: string;
  language?: string;
  audioId: string;
  stageId?: string;
  outlineId?: string;
  sceneId?: string;
}

export interface QueuedTeachingVoiceJobInput extends TeachingVoiceJobInput {
  providerId: QueuedTeachingVoiceProvider;
}

export type TeachingVoiceJobErrorCode =
  | 'TTS_SYNTHESIS_FAILED'
  | 'TTS_ENHANCEMENT_FAILED'
  | 'TTS_AUDIO_STORAGE_FAILED';

class TeachingVoiceJobFailure extends Error {
  constructor(
    readonly jobErrorCode: TeachingVoiceJobErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'TeachingVoiceJobFailure';
  }
}

function safeFailureMessage(error: unknown): string {
  return error instanceof Error
    ? error.message.replace(/\s+/g, ' ').trim().slice(0, 300)
    : 'Teaching Voice generation failed.';
}

function synthesisFailure(error: unknown): TeachingVoiceJobFailure {
  const message = safeFailureMessage(error);
  return new TeachingVoiceJobFailure(
    /enhanc/i.test(message) ? 'TTS_ENHANCEMENT_FAILED' : 'TTS_SYNTHESIS_FAILED',
    message,
  );
}

export function createTeachingVoiceIdempotencyKey(
  input: TeachingVoiceJobInput & { providerId?: QueuedTeachingVoiceProvider },
): string {
  const textHash = createHash('sha256').update(input.text).digest('hex');
  return createHash('sha256')
    .update(
      JSON.stringify({
        ownerId: input.ownerId,
        providerId: input.providerId ?? 'chatterbox',
        profileId: input.profileId,
        audioId: input.audioId,
        stageId: input.stageId ?? null,
        outlineId: input.outlineId ?? null,
        sceneId: input.sceneId ?? null,
        language: input.language ?? null,
        textHash,
      }),
    )
    .digest('hex');
}

function resourceKeyForProvider(providerId: QueuedTeachingVoiceProvider): string {
  if (providerId === 'indicf5') return INDICF5_TEACHING_VOICE_RESOURCE_KEY;
  if (providerId === 'qwen3-tts') return QWEN3_TTS_TEACHING_VOICE_RESOURCE_KEY;
  return CHATTERBOX_TEACHING_VOICE_RESOURCE_KEY;
}

export function enqueueTeachingVoiceJob(input: QueuedTeachingVoiceJobInput): {
  job: ResourceJobSnapshot;
  reused: boolean;
} {
  const idempotencyKey = createTeachingVoiceIdempotencyKey(input);
  const metadata = {
    provider: input.providerId,
    profileId: input.profileId,
    stageId: input.stageId,
    outlineId: input.outlineId,
    sceneId: input.sceneId,
  };
  return getResourceJobQueue().enqueue<TeachingVoiceJobResult>({
    resourceKey: resourceKeyForProvider(input.providerId),
    concurrency: 1,
    ownerId: input.ownerId,
    idempotencyKey,
    metadata,
    run: async (jobId) => {
      let result: TeachingVoiceJobResult;
      try {
        result = await synthesizeFacultyVoice({
          profileId: input.profileId,
          ownerId: input.ownerId,
          text: input.text,
          language: input.language,
          queueJobId: jobId,
        });
      } catch (error) {
        throw synthesisFailure(error);
      }
      try {
        const artifact = await persistTeachingVoiceArtifact({
          jobId,
          ownerId: input.ownerId,
          idempotencyKey,
          audio: result.audio,
          format: result.format,
          metadata,
        });
        log.info('[TeachingVoiceArtifact]', {
          event: 'stored',
          jobId,
          provider: input.providerId,
          byteLength: artifact.byteLength,
          durationSeconds: artifact.durationSeconds,
        });
      } catch (error) {
        const message =
          error instanceof TeachingVoiceArtifactInvalidError
            ? error.message
            : 'Teaching Voice audio could not be stored safely.';
        throw new TeachingVoiceJobFailure('TTS_AUDIO_STORAGE_FAILED', message);
      }
      void cleanupTeachingVoiceArtifacts().catch(() => undefined);
      return result;
    },
  });
}

export async function enqueueTeachingVoiceJobDurably(input: QueuedTeachingVoiceJobInput): Promise<{
  job: ResourceJobSnapshot;
  reused: boolean;
}> {
  const idempotencyKey = createTeachingVoiceIdempotencyKey(input);
  let retained: Awaited<ReturnType<typeof findTeachingVoiceArtifactByIdempotencyKey>> = null;
  try {
    retained = await findTeachingVoiceArtifactByIdempotencyKey(input.ownerId, idempotencyKey);
  } catch (error) {
    if (!(error instanceof TeachingVoiceArtifactInvalidError)) throw error;
    // A corrupt/missing retained artifact is never reused. Enqueue a fresh job
    // under a new id and leave the damaged files untouched for diagnosis.
    log.warn('[TeachingVoiceArtifact]', {
      event: 'retained-artifact-unusable',
      provider: input.providerId,
      stageId: input.stageId,
      sceneId: input.sceneId,
      reason: error.kind,
    });
  }
  if (retained) {
    log.info('[TeachingVoiceArtifact]', {
      event: 'retained-job-reused',
      jobId: retained.manifest.jobId,
      provider: input.providerId,
    });
    return { job: teachingVoiceArtifactSnapshot(retained.manifest), reused: true };
  }
  return enqueueTeachingVoiceJob(input);
}

export function enqueueChatterboxTeachingVoiceJob(input: TeachingVoiceJobInput): {
  job: ResourceJobSnapshot;
  reused: boolean;
} {
  return enqueueTeachingVoiceJob({ ...input, providerId: 'chatterbox' });
}

export function readTeachingVoiceJob(jobId: string, ownerId: string): ResourceJobSnapshot | null {
  return getResourceJobQueue().read(jobId, ownerId);
}

export function readTeachingVoiceJobResult(
  jobId: string,
  ownerId: string,
): TeachingVoiceJobResult | null {
  return getResourceJobQueue().result<TeachingVoiceJobResult>(jobId, ownerId);
}

export async function readTeachingVoiceJobDurably(
  jobId: string,
  ownerId: string,
): Promise<ResourceJobSnapshot | null> {
  const memory = readTeachingVoiceJob(jobId, ownerId);
  if (memory) return memory;
  const retained = await readTeachingVoiceArtifact(jobId, ownerId);
  return retained ? teachingVoiceArtifactSnapshot(retained.manifest) : null;
}

export async function readTeachingVoiceJobResultDurably(
  jobId: string,
  ownerId: string,
): Promise<TeachingVoiceJobResult | null> {
  const memory = readTeachingVoiceJobResult(jobId, ownerId);
  if (memory) {
    let existing: Awaited<ReturnType<typeof readTeachingVoiceArtifact>> = null;
    try {
      existing = await readTeachingVoiceArtifact(jobId, ownerId);
    } catch (error) {
      if (!(error instanceof TeachingVoiceArtifactInvalidError)) throw error;
    }
    if (!existing) {
      const snapshot = readTeachingVoiceJob(jobId, ownerId);
      try {
        await persistTeachingVoiceArtifact({
          jobId,
          ownerId,
          idempotencyKey: createHash('sha256').update(`legacy-job:${jobId}`).digest('hex'),
          audio: memory.audio,
          format: memory.format,
          metadata: snapshot?.metadata ?? {},
        });
        log.info('[TeachingVoiceArtifact]', { event: 'legacy-job-recovered', jobId });
      } catch {
        // The pre-fix bytes are still valuable: serve them once so the browser
        // can persist the narration even if durable salvage is unavailable.
        log.warn('[TeachingVoiceArtifact]', { event: 'legacy-job-recovery-failed', jobId });
      }
    }
    return memory;
  }
  const retained = await readTeachingVoiceArtifact(jobId, ownerId);
  return retained ? { audio: retained.audio, format: retained.format } : null;
}

export function cancelTeachingVoiceJob(jobId: string, ownerId: string): ResourceJobSnapshot | null {
  return getResourceJobQueue().cancel(jobId, ownerId);
}

export function isValidTeachingVoiceJobId(jobId: string): boolean {
  return /^rq_[a-zA-Z0-9_-]{20,}$/.test(jobId);
}
