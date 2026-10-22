import { after, NextRequest } from 'next/server';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import {
  getVoiceCloningDefaultLanguage,
  getChatterboxDefaultModelVariant,
  isQwen3TtsPreviewEnabled,
  isVoiceCloningServerEnabled,
} from '@/lib/voice-cloning/config';
import { requireSessionUser } from '@/lib/auth/server';
import {
  isChatterboxFacultySynthesisLanguage,
  normalizeTeachingVoiceLanguageId,
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
  isQwen3TtsCloneMode,
  isVoiceEnhancementMode,
  isVoicePreviewModel,
  resolveVoiceProfileProvider,
  TeachingVoiceError,
  resolveVoiceProfileGenerationSettings,
  resolveVoiceProfileEnhancementMode,
  resolveVoiceProfileLanguageId,
  resolveVoiceProfileModelVariant,
  toPublicVoiceProfile,
  validateVoiceGenerationSettings,
  type ChatterboxModelVariant,
  type VoiceConfiguration,
  type VoiceGenerationSettings,
  type VoicePreviewTextLanguage,
  type VoicePreviewModel,
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
import { generateQwen3TtsModelPreview } from '@/lib/server/qwen3-tts-preview';

const log = createLogger('VoiceCloningProfileAPI');

export const maxDuration = 960;

function disabled() {
  return apiError('PROVIDER_DISABLED', 404, 'Voice cloning is disabled');
}

function availablePreviewModels(): VoicePreviewModel[] {
  return [
    'chatterbox-v3',
    ...(isQwen3TtsPreviewEnabled() ? (['qwen3-tts-1.7b-base'] as const) : []),
  ];
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
  enhancementMode?: unknown;
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
      if (
        input.modelVariant !== undefined ||
        input.generationSettings !== undefined ||
        input.enhancementMode !== undefined
      ) {
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

  const enhancementMode =
    input.enhancementMode === undefined
      ? profile
        ? resolveVoiceProfileEnhancementMode(profile)
        : 'standard'
      : isVoiceEnhancementMode(input.enhancementMode)
        ? input.enhancementMode
        : null;
  if (!enhancementMode) throw new Error('Unsupported voice enhancement mode');

  return { modelVariant, languageId, generationSettings, enhancementMode };
}

function voiceConfigurationsEqual(left: VoiceConfiguration, right: VoiceConfiguration): boolean {
  return (
    left.modelVariant === right.modelVariant &&
    left.languageId === right.languageId &&
    (left.enhancementMode ?? 'standard') === (right.enhancementMode ?? 'standard') &&
    JSON.stringify(left.generationSettings) === JSON.stringify(right.generationSettings)
  );
}

function voiceSynthesisConfigurationsEqual(
  left: VoiceConfiguration,
  right: VoiceConfiguration,
): boolean {
  return voiceConfigurationsEqual(
    { ...left, enhancementMode: 'standard' },
    { ...right, enhancementMode: 'standard' },
  );
}

function parsePreviewTextLanguageId(
  value: unknown,
  synthesisLanguageId: string,
): VoicePreviewTextLanguage {
  const languageId = value === undefined ? 'en' : resolveTeachingVoiceLanguage(String(value));
  if (!isChatterboxFacultySynthesisLanguage(languageId)) {
    throw new TeachingVoiceError('Preview text must be English or Hindi.');
  }
  if (languageId === 'hi' && synthesisLanguageId !== 'hi') {
    throw new TeachingVoiceError('Hindi preview text requires Hindi Chatterbox synthesis.');
  }
  return languageId;
}

export async function GET(req: NextRequest) {
  if (!isVoiceCloningServerEnabled()) return disabled();
  const user = await requireSessionUser(req);
  if (user instanceof Response) return user;
  try {
    const params = req.nextUrl.searchParams;
    const requested = params.get('language');
    const language = requested === null ? undefined : normalizeTeachingVoiceLanguageId(requested);
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
    return apiSuccess({
      profile: toPublicVoiceProfile(profile),
      previewModels: availablePreviewModels(),
    });
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
    enhancementMode?: string;
    previewTextLanguageId?: string;
    previewModel?: string;
    qwenCloneMode?: string;
  };
  if (!body.profileId || !body.action) {
    return apiError('INVALID_REQUEST', 400, 'Invalid profile update');
  }
  const profile = await readVoiceProfile(body.profileId, user.id);
  if (!profile || profile.ownerId !== user.id || profile.status === 'deleted') {
    return apiError('INVALID_REQUEST', 404, 'Voice profile not found');
  }

  const previewModel = body.previewModel ?? 'chatterbox-v3';
  if (!isVoicePreviewModel(previewModel)) {
    return apiError('INVALID_REQUEST', 400, 'Unsupported preview model');
  }
  if (previewModel === 'qwen3-tts-1.7b-base') {
    if (body.action !== 'preview-model') {
      return apiError('INVALID_REQUEST', 400, 'Qwen3-TTS is available for comparison only');
    }
    if (!isQwen3TtsPreviewEnabled()) {
      return apiError('PROVIDER_DISABLED', 404, 'Qwen3-TTS preview is disabled');
    }
    if (profile.status !== 'preview-ready' && profile.status !== 'ready') {
      return apiError('INVALID_REQUEST', 400, 'Voice profile is not ready for preview');
    }
    if (resolveVoiceProfileProvider(profile) !== 'chatterbox') {
      return apiError(
        'INVALID_REQUEST',
        400,
        'Qwen3-TTS preview requires an English Chatterbox Teaching Voice',
      );
    }
    const enhancementMode =
      body.enhancementMode === undefined
        ? 'standard'
        : isVoiceEnhancementMode(body.enhancementMode)
          ? body.enhancementMode
          : null;
    if (!enhancementMode) {
      return apiError('INVALID_REQUEST', 400, 'Unsupported voice enhancement mode');
    }
    const qwenCloneMode = body.qwenCloneMode ?? 'speaker-embedding';
    if (!isQwen3TtsCloneMode(qwenCloneMode)) {
      return apiError('INVALID_REQUEST', 400, 'Unsupported Qwen3-TTS clone mode');
    }
    try {
      const modelPreview = await generateQwen3TtsModelPreview(
        profile,
        enhancementMode,
        qwenCloneMode,
      );
      return apiSuccess({
        profile: toPublicVoiceProfile(profile),
        modelPreview,
        previewModels: availablePreviewModels(),
      });
    } catch (error) {
      return apiError(
        'GENERATION_FAILED',
        error instanceof TeachingVoiceError ? error.status : 500,
        error instanceof TeachingVoiceError ? error.message : 'Qwen3-TTS preview failed',
      );
    }
  }

  let config: VoiceConfiguration;
  try {
    config = resolveVoiceConfiguration({
      modelVariant: body.modelVariant,
      languageId: body.languageId,
      generationSettings: body.generationSettings,
      enhancementMode: body.enhancementMode,
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
    let previewTextLanguageId: VoicePreviewTextLanguage | undefined;
    try {
      previewTextLanguageId =
        resolveVoiceProfileProvider(profile) === 'chatterbox'
          ? parsePreviewTextLanguageId(body.previewTextLanguageId, config.languageId)
          : undefined;
      generated = await generateVariantPreview(profile, config, { previewTextLanguageId });
    } catch (error) {
      return apiError(
        'GENERATION_FAILED',
        error instanceof TeachingVoiceError ? error.status : 500,
        error instanceof TeachingVoiceError ? error.message : 'Teaching Voice preview failed',
      );
    }
    const { providerReferenceId, preview, comparison } = generated;
    const next = {
      ...profile,
      provider: resolveVoiceProfileProvider(profile),
      providerReferenceId,
      preview: profile.provider === 'qwen3' ? undefined : profile.preview,
      previewVariants: profile.provider === 'qwen3' ? undefined : profile.previewVariants,
      draftPreview: {
        config: { ...config, ...(previewTextLanguageId ? { previewTextLanguageId } : {}) },
        preview,
        ...(comparison ? { comparison } : {}),
      },
      updatedAt: new Date().toISOString(),
    };
    await writeVoiceProfile(next);
    return apiSuccess({ profile: toPublicVoiceProfile(next) });
  }

  if (body.action !== 'accept-preview') {
    return apiError('INVALID_REQUEST', 400, 'Invalid profile update');
  }

  let profileForAcceptance = profile;
  const draft = profile.draftPreview;
  if (draft && voiceSynthesisConfigurationsEqual(draft.config, config) && draft.comparison) {
    const selected =
      config.enhancementMode === 'resemble-enhance'
        ? draft.comparison.enhanced
        : draft.comparison.original;
    if (!selected) {
      return apiError('INVALID_REQUEST', 400, 'Enhanced preview is unavailable');
    }
    profileForAcceptance = {
      ...profile,
      draftPreview: { ...draft, config: { ...draft.config, ...config }, preview: selected },
    };
  } else if (!draft && profile.previewComparison) {
    const current = resolveVoiceConfiguration({ fallbackProfile: profile });
    if (voiceSynthesisConfigurationsEqual(current, config)) {
      const selected =
        config.enhancementMode === 'resemble-enhance'
          ? profile.previewComparison.enhanced
          : profile.previewComparison.original;
      if (!selected) {
        return apiError('INVALID_REQUEST', 400, 'Enhanced preview is unavailable');
      }
      profileForAcceptance = {
        ...profile,
        draftPreview: {
          config: { ...config, previewTextLanguageId: profile.previewTextLanguageId },
          preview: selected,
          comparison: profile.previewComparison,
        },
      };
    }
  }
  if (
    !profileForAcceptance.draftPreview ||
    !voiceConfigurationsEqual(profileForAcceptance.draftPreview.config, config)
  ) {
    return apiError('INVALID_REQUEST', 400, 'Preview must be generated before accepting');
  }
  const next = await acceptVoiceProfilePreview(profileForAcceptance, config, user.id);
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
      previewComparison: undefined,
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
