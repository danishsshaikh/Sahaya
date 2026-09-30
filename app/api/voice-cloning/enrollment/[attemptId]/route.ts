import { type NextRequest } from 'next/server';
import { requireSessionUser } from '@/lib/auth/server';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { isVoiceCloningServerEnabled } from '@/lib/voice-cloning/config';
import {
  isValidVoiceEnrollmentAttemptId,
  readVoiceEnrollmentStatus,
} from '@/lib/server/voice-enrollment-jobs';

function disabled() {
  return apiError('PROVIDER_DISABLED', 404, 'Voice cloning is disabled');
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ attemptId: string }> },
) {
  if (!isVoiceCloningServerEnabled()) return disabled();
  const user = await requireSessionUser(_req);
  if (user instanceof Response) return user;
  const { attemptId } = await params;
  if (!isValidVoiceEnrollmentAttemptId(attemptId)) {
    return apiError('INVALID_REQUEST', 400, 'Invalid Teaching Voice enrollment attempt.');
  }
  const status = await readVoiceEnrollmentStatus(attemptId, user.id);
  if (!status) {
    return apiError('INVALID_REQUEST', 404, 'Teaching Voice enrollment was not found or expired.');
  }
  return apiSuccess({ ...status });
}
