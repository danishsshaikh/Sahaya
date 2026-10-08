import { type NextRequest } from 'next/server';
import { requireSessionUser } from '@/lib/auth/server';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import {
  commitSceneGenerationAttempt,
  SceneGenerationAttemptError,
} from '@/lib/server/scene-generation-attempts';
import { createLogger } from '@/lib/logger';

const log = createLogger('Scene Attempt Commit API');

export async function POST(req: NextRequest) {
  const user = await requireSessionUser(req);
  if (user instanceof Response) return user;

  try {
    const { attemptId, generationVersion, stageId, outlineId, sceneId } = (await req.json()) as {
      attemptId?: string;
      generationVersion?: string;
      stageId?: string;
      outlineId?: string;
      sceneId?: string;
    };
    if (!attemptId || !generationVersion || !stageId || !outlineId || !sceneId) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'Complete scene attempt identity is required');
    }

    const result = commitSceneGenerationAttempt(
      user.id,
      { attemptId, generationVersion, stageId, outlineId },
      sceneId,
    );
    log.info('[SceneGenerationTrace]', {
      event: 'scene-attempt-commit',
      stageId,
      outlineId,
      attemptId,
      generationVersion,
      sceneId,
      alreadyCommitted: result.alreadyCommitted,
    });
    return apiSuccess(result);
  } catch (error) {
    if (error instanceof SceneGenerationAttemptError) {
      log.info('[SceneGenerationTrace]', {
        event: 'scene-attempt-stale-rejected',
        errorCode: error.code,
      });
      return apiError(error.code, 409, error.message);
    }
    log.error('Scene attempt commit failed:', error);
    return apiError('INTERNAL_ERROR', 500, 'Failed to commit scene generation attempt');
  }
}
