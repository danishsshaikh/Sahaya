import type { NextRequest } from 'next/server';
import { requireSessionUser } from '@/lib/auth/server';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { TeachingVoiceArtifactInvalidError } from '@/lib/voice-cloning/teaching-voice-artifacts';
import {
  cancelTeachingVoiceJob,
  isValidTeachingVoiceJobId,
  readTeachingVoiceJobDurably,
} from '@/lib/voice-cloning/teaching-voice-jobs';

type Context = { params: Promise<{ jobId: string }> };

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: Context) {
  const user = await requireSessionUser(req);
  if (user instanceof Response) return user;
  const { jobId } = await params;
  if (!isValidTeachingVoiceJobId(jobId)) {
    return apiError('INVALID_REQUEST', 400, 'Invalid Teaching Voice job id');
  }
  let job;
  try {
    job = await readTeachingVoiceJobDurably(jobId, user.id);
  } catch (error) {
    if (error instanceof TeachingVoiceArtifactInvalidError) {
      if (error.kind === 'missing') {
        return apiError(
          'TTS_AUDIO_ARTIFACT_MISSING',
          404,
          'The completed narration audio artifact is missing. Retry only this narration action.',
        );
      }
      return apiError('TTS_AUDIO_ARTIFACT_INVALID', 500, error.message);
    }
    throw error;
  }
  if (!job) return apiError('TTS_JOB_NOT_FOUND', 404, 'Teaching Voice job not found or expired');

  return apiSuccess({
    async: true,
    jobId: job.id,
    status: job.status,
    queuePosition: job.queuePosition,
    jobsAhead: job.jobsAhead,
    queueDepth: job.queueDepth,
    estimatedWaitMs: job.estimatedWaitMs,
    attemptCount: job.attemptCount,
    ...(job.status === 'completed'
      ? { audioUrl: `/api/generate/tts/jobs/${encodeURIComponent(job.id)}/audio` }
      : {}),
    ...(job.status === 'failed'
      ? {
          errorCode: job.errorCode || 'TTS_SYNTHESIS_FAILED',
          error: job.error || 'Teaching Voice synthesis failed',
        }
      : {}),
  });
}

export async function DELETE(req: NextRequest, { params }: Context) {
  const user = await requireSessionUser(req);
  if (user instanceof Response) return user;
  const { jobId } = await params;
  if (!isValidTeachingVoiceJobId(jobId)) {
    return apiError('INVALID_REQUEST', 400, 'Invalid Teaching Voice job id');
  }
  const job = cancelTeachingVoiceJob(jobId, user.id);
  if (!job) return apiError('INVALID_REQUEST', 404, 'Teaching Voice job not found or expired');
  return apiSuccess({ async: true, jobId: job.id, status: job.status });
}
