import { type NextRequest } from 'next/server';
import { requireSessionUser } from '@/lib/auth/server';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { isValidSceneContentJobId, readSceneContentJob } from '@/lib/server/scene-content-jobs';
import { createLogger } from '@/lib/logger';

const log = createLogger('Scene Content Job API');

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const user = await requireSessionUser(req);
  if (user instanceof Response) return user;

  const jobId = req.nextUrl.searchParams.get('jobId') || '';
  try {
    if (!jobId || !isValidSceneContentJobId(jobId)) {
      return apiError('INVALID_REQUEST', 400, 'Invalid scene content job id');
    }

    const job = readSceneContentJob(jobId, user.id);
    if (!job) {
      return apiError('INVALID_REQUEST', 404, 'Scene content job not found or expired');
    }

    return apiSuccess({
      async: true,
      jobId: job.id,
      status: job.status,
      stageId: job.stageId,
      outlineId: job.outlineId,
      outlineTitle: job.outlineTitle,
      attemptId: job.attemptId,
      generationVersion: job.generationVersion,
      widgetType: job.widgetType,
      done: job.status === 'completed' || job.status === 'failed',
      ...(job.status === 'completed' && job.result
        ? {
            content: job.result.content,
            effectiveOutline: job.result.effectiveOutline,
          }
        : {}),
      ...(job.status === 'failed' && job.error ? { error: job.error } : {}),
    });
  } catch (error) {
    log.error(`Scene content job retrieval failed [jobId=${jobId || 'unknown'}]:`, error);
    return apiError(
      'INTERNAL_ERROR',
      500,
      'Failed to retrieve scene content job',
      error instanceof Error ? error.message : String(error),
    );
  }
}
