import { createHash } from 'node:crypto';
import { getResourceJobQueue, type ResourceJobSnapshot } from '@/lib/server/resource-job-queue';
import { synthesizeFacultyVoice } from '@/lib/voice-cloning/synthesis';

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
  return getResourceJobQueue().enqueue<TeachingVoiceJobResult>({
    resourceKey: resourceKeyForProvider(input.providerId),
    concurrency: 1,
    ownerId: input.ownerId,
    idempotencyKey: createTeachingVoiceIdempotencyKey(input),
    metadata: {
      provider: input.providerId,
      profileId: input.profileId,
      stageId: input.stageId,
      outlineId: input.outlineId,
      sceneId: input.sceneId,
    },
    run: (jobId) =>
      synthesizeFacultyVoice({
        profileId: input.profileId,
        ownerId: input.ownerId,
        text: input.text,
        language: input.language,
        queueJobId: jobId,
      }),
  });
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

export function cancelTeachingVoiceJob(jobId: string, ownerId: string): ResourceJobSnapshot | null {
  return getResourceJobQueue().cancel(jobId, ownerId);
}

export function isValidTeachingVoiceJobId(jobId: string): boolean {
  return /^rq_[a-zA-Z0-9_-]{20,}$/.test(jobId);
}
