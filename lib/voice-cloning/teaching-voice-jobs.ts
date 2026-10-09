import { createHash } from 'node:crypto';
import { getResourceJobQueue, type ResourceJobSnapshot } from '@/lib/server/resource-job-queue';
import { synthesizeFacultyVoice } from '@/lib/voice-cloning/synthesis';

export const CHATTERBOX_TEACHING_VOICE_RESOURCE_KEY = 'teaching-voice:chatterbox';

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

export function createTeachingVoiceIdempotencyKey(input: TeachingVoiceJobInput): string {
  const textHash = createHash('sha256').update(input.text).digest('hex');
  return createHash('sha256')
    .update(
      JSON.stringify({
        ownerId: input.ownerId,
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

export function enqueueChatterboxTeachingVoiceJob(input: TeachingVoiceJobInput): {
  job: ResourceJobSnapshot;
  reused: boolean;
} {
  return getResourceJobQueue().enqueue<TeachingVoiceJobResult>({
    resourceKey: CHATTERBOX_TEACHING_VOICE_RESOURCE_KEY,
    concurrency: 1,
    ownerId: input.ownerId,
    idempotencyKey: createTeachingVoiceIdempotencyKey(input),
    metadata: {
      provider: 'chatterbox',
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
