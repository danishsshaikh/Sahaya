import type { NextRequest } from 'next/server';
import { requireSessionUser } from '@/lib/auth/server';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import {
  cancelTeachingVoiceJob,
  isValidTeachingVoiceJobId,
  readTeachingVoiceJob,
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
  const job = readTeachingVoiceJob(jobId, user.id);
  if (!job) return apiError('INVALID_REQUEST', 404, 'Teaching Voice job not found or expired');

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
    ...(job.status === 'failed' ? { error: job.error || 'Teaching Voice generation failed' } : {}),
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
