import { after, type NextRequest } from 'next/server';
import { requireSessionUser } from '@/lib/auth/server';
import { apiError } from '@/lib/server/api-response';
import { isVoiceCloningServerEnabled } from '@/lib/voice-cloning/config';
import {
  parseVoiceEnrollmentForm,
  runVoiceEnrollmentJob,
  startVoiceEnrollment,
  voiceEnrollmentErrorResponse,
  voiceEnrollmentResponse,
} from '@/lib/server/voice-enrollment-jobs';

function disabled() {
  return apiError('PROVIDER_DISABLED', 404, 'Voice cloning is disabled');
}

export const maxDuration = 960;

export async function POST(req: NextRequest) {
  if (!isVoiceCloningServerEnabled()) return disabled();
  const user = await requireSessionUser(req);
  if (user instanceof Response) return user;
  try {
    const input = await parseVoiceEnrollmentForm(await req.formData(), user.id);
    const { job, reused, completedProfile } = await startVoiceEnrollment(input);
    if (!reused) after(() => runVoiceEnrollmentJob(input));
    return voiceEnrollmentResponse(job, completedProfile ?? job.result);
  } catch (error) {
    return voiceEnrollmentErrorResponse(error);
  }
}
