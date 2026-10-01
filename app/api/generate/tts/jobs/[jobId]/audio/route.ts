import type { NextRequest } from 'next/server';
import { requireSessionUser } from '@/lib/auth/server';
import { apiError } from '@/lib/server/api-response';
import {
  isValidTeachingVoiceJobId,
  readTeachingVoiceJob,
  readTeachingVoiceJobResult,
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
  if (job.status !== 'completed') {
    return apiError('INVALID_REQUEST', 409, 'Teaching Voice audio is not ready');
  }
  const result = readTeachingVoiceJobResult(jobId, user.id);
  if (!result) return apiError('ASSET_NOT_FOUND', 404, 'Teaching Voice audio is unavailable');

  return new Response(Buffer.from(result.audio), {
    status: 200,
    headers: {
      'Content-Type': `audio/${result.format}`,
      'Cache-Control': 'private, no-store',
      'Content-Length': String(result.audio.byteLength),
    },
  });
}
