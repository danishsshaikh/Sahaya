import type { NextRequest } from 'next/server';
import { requireSessionUser } from '@/lib/auth/server';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { ExternalVoiceProviderError } from '@/lib/server/voice-comparison-http';
import {
  generateVoiceComparisonPreview,
  getVoiceComparisonBootstrap,
  requireOwnedReadyProfile,
} from '@/lib/server/voice-comparison';
import { isVoiceCloningServerEnabled } from '@/lib/voice-cloning/config';
import { TeachingVoiceError } from '@/lib/voice-cloning/types';
import {
  isVoiceComparisonLanguageCode,
  isVoiceComparisonProviderId,
} from '@/lib/voice-comparison/catalog';
import type { VoiceComparisonPreviewRequest } from '@/lib/voice-comparison/types';

export const maxDuration = 300;

function disabled() {
  return apiError('PROVIDER_DISABLED', 404, 'Voice cloning is disabled');
}

function comparisonError(error: unknown) {
  if (error instanceof ExternalVoiceProviderError) {
    return apiError(
      error.code,
      error.status,
      error.message,
      [
        error.metadata.safeDetail,
        error.metadata.requestId ? `Provider request ID: ${error.metadata.requestId}` : undefined,
      ]
        .filter(Boolean)
        .join(' · ') || undefined,
    );
  }
  if (error instanceof TeachingVoiceError) {
    return apiError('INVALID_REQUEST', error.status, error.message);
  }
  return apiError('INTERNAL_ERROR', 500, 'Voice comparison could not be completed.');
}

export async function GET(req: NextRequest) {
  if (!isVoiceCloningServerEnabled()) return disabled();
  const user = await requireSessionUser(req);
  if (user instanceof Response) return user;
  const profileId = req.nextUrl.searchParams.get('profileId')?.trim();
  if (!profileId) return apiError('MISSING_REQUIRED_FIELD', 400, 'profileId is required');
  try {
    const profile = await requireOwnedReadyProfile(user.id, profileId);
    return apiSuccess({ comparison: await getVoiceComparisonBootstrap(user.id, profile) });
  } catch (error) {
    return comparisonError(error);
  }
}

export async function POST(req: NextRequest) {
  if (!isVoiceCloningServerEnabled()) return disabled();
  const user = await requireSessionUser(req);
  if (user instanceof Response) return user;
  try {
    const body = (await req.json()) as Partial<VoiceComparisonPreviewRequest>;
    if (
      typeof body.profileId !== 'string' ||
      typeof body.text !== 'string' ||
      !isVoiceComparisonProviderId(body.providerId) ||
      !isVoiceComparisonLanguageCode(body.language)
    ) {
      return apiError('INVALID_REQUEST', 400, 'Invalid voice comparison request');
    }
    const result = await generateVoiceComparisonPreview({
      ownerId: user.id,
      request: {
        profileId: body.profileId,
        providerId: body.providerId,
        text: body.text,
        language: body.language,
        ...(typeof body.voice === 'string' ? { voice: body.voice } : {}),
        ...(typeof body.style === 'string' ? { style: body.style } : {}),
        ...(body.sarvamExternalConsent === true ? { sarvamExternalConsent: true } : {}),
        ...(body.sarvamCreateRawVoice === true ? { sarvamCreateRawVoice: true } : {}),
        ...(body.bypassCache === true ? { bypassCache: true } : {}),
      },
      signal: req.signal,
    });
    return apiSuccess({ preview: result });
  } catch (error) {
    return comparisonError(error);
  }
}
