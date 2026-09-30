import { after, NextRequest } from 'next/server';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import {
  getVoiceCloningDefaultLanguage,
  getChatterboxDefaultModelVariant,
  isVoiceCloningServerEnabled,
} from '@/lib/voice-cloning/config';
import { requireSessionUser } from '@/lib/auth/server';
import {
  resolveTeachingVoiceLanguage,
  validateTeachingVoiceLanguage,
} from '@/lib/voice-cloning/language';
import {
  deleteVoiceProfileAssets,
  findCurrentVoiceProfile,
  readVoiceProfile,
  writeVoiceProfile,
} from '@/lib/voice-cloning/storage';
import {
  isChatterboxModelVariant,
  resolveVoiceProfileProvider,
  TeachingVoiceError,
  resolveVoiceProfileGenerationSettings,
  resolveVoiceProfileLanguageId,
  resolveVoiceProfileModelVariant,
  toPublicVoiceProfile,
  validateVoiceGenerationSettings,
  type ChatterboxModelVariant,
  type VoiceConfiguration,
  type VoiceGenerationSettings,
  type VoiceProfile,
} from '@/lib/voice-cloning/types';
import { getVoiceCloningProvider } from '@/lib/voice-cloning/provider';
import { createLogger } from '@/lib/logger';
import { resolveTTSLanguageCode, tryResolveTTSLanguageCode } from '@/lib/audio/tts-language';
import {
  acceptVoiceProfilePreview,
  generateVariantPreview,
  parseVoiceEnrollmentForm,
  runVoiceEnrollmentJob,
  startVoiceEnrollment,
  voiceEnrollmentErrorResponse,
  voiceEnrollmentResponse,
} from '@/lib/server/voice-enrollment-jobs';

const log = createLogger('VoiceCloningProfileAPI');

export const maxDuration = 960;

function disabled() {
  return apiError('PROVIDER_DISABLED', 404, 'Voice cloning is disabled');
}

function serverDefaultModelVariant(): ChatterboxModelVariant {
  const configured = getChatterboxDefaultModelVariant();
  return isChatterboxModelVariant(configured) ? configured : 'v3';
}

function parseGenerationSettings(value: unknown): VoiceGenerationSettings {
  if (typeof value === 'string') {
    try {
      return validateVoiceGenerationSettings(JSON.parse(value));
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error('Invalid voice generation settings');
      throw error;
    }
  }
  return validateVoiceGenerationSettings(value);
}

function parseProfileLanguageId(value: unknown, fallbackLanguage?: string | null): string {
  if (value === undefined || value === null || value === '') {
    return resolveTTSLanguageCode(fallbackLanguage, {
      defaultLanguage: getVoiceCloningDefaultLanguage(),
    });
  }
  if (typeof value !== 'string') throw new Error('Unsupported voice language');
  const languageId = tryResolveTTSLanguageCode(value.trim());
  if (!languageId) throw new Error('Unsupported voice language');
  return languageId;
}

function resolveVoiceConfiguration(input: {
  modelVariant?: unknown;
  languageId?: unknown;
  generationSettings?: unknown;
  fallbackProfile?: VoiceProfile;
}): VoiceConfiguration {
  const profile = input.fallbackProfile;
  if (profile) {
    const languageId = validateTeachingVoiceLanguage(
      profile,
      typeof input.languageId === 'string'
        ? input.languageId
        : resolveVoiceProfileLanguageId(profile),
    );
    if (resolveVoiceProfileProvider(profile) !== 'chatterbox') {
      getVoiceCloningProvider(resolveVoiceProfileProvider(profile));
      if (input.modelVariant !== undefined || input.generationSettings !== undefined) {
        throw new TeachingVoiceError('Chatterbox settings do not apply to this Teaching Voice.');
      }
      return { languageId };
    }
  }
  const modelVariant =
    input.modelVariant === undefined
      ? profile
        ? resolveVoiceProfileModelVariant(profile)
        : serverDefaultModelVariant()
      : isChatterboxModelVariant(input.modelVariant)
        ? input.modelVariant
        : null;
  if (!modelVariant) throw new Error('Unsupported voice model');

  const languageId = parseProfileLanguageId(
    input.languageId,
    profile ? resolveVoiceProfileLanguageId(profile) : undefined,
  );

  const generationSettings =
    input.generationSettings === undefined && profile
      ? resolveVoiceProfileGenerationSettings(profile)
      : parseGenerationSettings(input.generationSettings);

  return { modelVariant, languageId, generationSettings };
}

function voiceConfigurationsEqual(left: VoiceConfiguration, right: VoiceConfiguration): boolean {
  return (
    left.modelVariant === right.modelVariant &&
    left.languageId === right.languageId &&
    JSON.stringify(left.generationSettings) === JSON.stringify(right.generationSettings)
  );
}

export async function GET(req: NextRequest) {
  if (!isVoiceCloningServerEnabled()) return disabled();
  const user = await requireSessionUser(req);
  if (user instanceof Response) return user;
  try {
    const params = req.nextUrl.searchParams;
    const requested = params.get('language');
    const language = requested === null ? undefined : resolveTeachingVoiceLanguage(requested);
    if (language === null)
      return apiError('INVALID_REQUEST', 400, 'Unsupported or ambiguous voice language');
    const profileId = params.get('profileId');
    const profile = profileId
      ? await readVoiceProfile(profileId, user.id)
      : await findCurrentVoiceProfile(user.id, language);
    if (profileId && (!profile || profile.ownerId !== user.id || profile.status !== 'ready')) {
      return apiError(
        'INVALID_REQUEST',
        404,
        'Selected Teaching Voice is not ready or no longer exists',
      );
    }
    if (profileId && profile) {
      getVoiceCloningProvider(resolveVoiceProfileProvider(profile));
      validateTeachingVoiceLanguage(profile, requested ?? undefined);
    }
    return apiSuccess({ profile: toPublicVoiceProfile(profile) });
  } catch (error) {
    return apiError(
      'INVALID_REQUEST',
      400,
      error instanceof TeachingVoiceError ? error.message : 'Could not load Teaching Voice',
    );
  }
}

export async function POST(req: NextRequest) {
  if (!isVoiceCloningServerEnabled()) return disabled();
  const user = await requireSessionUser(req);
  if (user instanceof Response) return user;
  try {
    const formData = await req.formData();
    const input = await parseVoiceEnrollmentForm(formData, user.id);
    const { job, reused, completedProfile } = await startVoiceEnrollment(input);
    if (!reused) {
      after(() => runVoiceEnrollmentJob(input));
    }
    return voiceEnrollmentResponse(job, completedProfile ?? job.result);
  } catch (error) {
    return voiceEnrollmentErrorResponse(error);
  }
}

export async function PATCH(req: NextRequest) {
  if (!isVoiceCloningServerEnabled()) return disabled();
  const user = await requireSessionUser(req);
  if (user instanceof Response) return user;
  const body = (await req.json().catch(() => ({}))) as {
    profileId?: string;
    action?: string;
    modelVariant?: string;
    languageId?: string;
    generationSettings?: unknown;
  };
  if (!body.profileId || !body.action) {
    return apiError('INVALID_REQUEST', 400, 'Invalid profile update');
  }
  const profile = await readVoiceProfile(body.profileId, user.id);
  if (!profile || profile.ownerId !== user.id || profile.status === 'deleted') {
    return apiError('INVALID_REQUEST', 404, 'Voice profile not found');
  }
  let config: VoiceConfiguration;
  try {
    config = resolveVoiceConfiguration({
      modelVariant: body.modelVariant,
      languageId: body.languageId,
      generationSettings: body.generationSettings,
      fallbackProfile: profile,
    });
  } catch (error) {
    return apiError(
      'INVALID_REQUEST',
      400,
      error instanceof Error ? error.message : 'Invalid voice settings',
    );
  }

  if (body.action === 'preview-model') {
    if (profile.status !== 'preview-ready' && profile.status !== 'ready') {
      return apiError('INVALID_REQUEST', 400, 'Voice profile is not ready for preview');
    }
    let generated: Awaited<ReturnType<typeof generateVariantPreview>>;
    try {
      generated = await generateVariantPreview(profile, config);
    } catch (error) {
      return apiError(
        'GENERATION_FAILED',
        error instanceof TeachingVoiceError ? error.status : 500,
        error instanceof TeachingVoiceError ? error.message : 'Teaching Voice preview failed',
      );
    }
    const { providerReferenceId, preview } = generated;
    const next = {
      ...profile,
      providerReferenceId,
      draftPreview: { config, preview },
      updatedAt: new Date().toISOString(),
    };
    await writeVoiceProfile(next);
    return apiSuccess({ profile: toPublicVoiceProfile(next) });
  }

  if (body.action !== 'accept-preview') {
    return apiError('INVALID_REQUEST', 400, 'Invalid profile update');
  }

  const acceptedDraft = profile.draftPreview;
  if (!acceptedDraft || !voiceConfigurationsEqual(acceptedDraft.config, config)) {
    return apiError('INVALID_REQUEST', 400, 'Preview must be generated before accepting');
  }
  const next = await acceptVoiceProfilePreview(profile, config, user.id);
  return apiSuccess({ profile: toPublicVoiceProfile(next) });
}

export async function DELETE(req: NextRequest) {
  if (!isVoiceCloningServerEnabled()) return disabled();
  const user = await requireSessionUser(req);
  if (user instanceof Response) return user;
  const profileId = req.nextUrl.searchParams.get('profileId');
  const profile = profileId
    ? await readVoiceProfile(profileId, user.id)
    : await findCurrentVoiceProfile(user.id);
  if (!profile || profile.ownerId !== user.id || profile.status === 'deleted') {
    return apiSuccess({ deleted: true });
  }
  try {
    if (profile.providerReferenceId) {
      await getVoiceCloningProvider(resolveVoiceProfileProvider(profile)).deleteProfile({
        providerReferenceId: profile.providerReferenceId,
      });
    }
    await deleteVoiceProfileAssets(profile);
    await writeVoiceProfile({
      ...profile,
      status: 'deleted',
      referenceAudioKey: undefined,
      referenceText: undefined,
      providerReferenceId: undefined,
      preview: undefined,
      previewVariants: undefined,
      draftPreview: undefined,
      updatedAt: new Date().toISOString(),
    });
    log.info('voice profile deleted', {
      profileId: profile.id,
      operation: 'delete',
      status: 'deleted',
    });
    return apiSuccess({ deleted: true });
  } catch (error) {
    return apiError(
      'INTERNAL_ERROR',
      500,
      error instanceof TeachingVoiceError ? error.message : 'Voice profile deletion failed',
    );
  }
}
