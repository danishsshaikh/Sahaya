import type { NextRequest } from 'next/server';
import { requireSessionUser } from '@/lib/auth/server';
import { apiError } from '@/lib/server/api-response';
import {
  isValidTeachingVoiceJobId,
  readTeachingVoiceJobDurably,
  readTeachingVoiceJobResultDurably,
} from '@/lib/voice-cloning/teaching-voice-jobs';
import { TeachingVoiceArtifactInvalidError } from '@/lib/voice-cloning/teaching-voice-artifacts';

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
  if (job.status !== 'completed') {
    return apiError('TTS_AUDIO_NOT_READY', 409, 'Teaching Voice audio is not ready');
  }
  let result;
  try {
    result = await readTeachingVoiceJobResultDurably(jobId, user.id);
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
  if (!result) {
    return apiError(
      'TTS_AUDIO_ARTIFACT_MISSING',
      404,
      'Teaching Voice completed, but its audio artifact is missing',
    );
  }

  return new Response(Buffer.from(result.audio), {
    status: 200,
    headers: {
      'Content-Type': `audio/${result.format}`,
      'Cache-Control': 'private, no-store',
      'Content-Length': String(result.audio.byteLength),
    },
  });
}
