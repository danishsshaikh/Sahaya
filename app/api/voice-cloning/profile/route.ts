import { NextRequest } from 'next/server';
import { randomUUID } from 'crypto';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import {
  getVoiceCloningDefaultLanguage,
  getChatterboxDefaultModelVariant,
  isVoiceCloningServerEnabled,
} from '@/lib/voice-cloning/config';
import { markVoiceConfigured, requireSessionUser } from '@/lib/auth/server';
import {
  VOICE_CLONING_CONSENT_VERSION,
  getVoiceEnrollmentPhrases,
  getVoicePreviewText,
} from '@/lib/voice-cloning/phrases';
import {
  newTeachingVoiceProvider,
  resolveTeachingVoiceLanguage,
  validateTeachingVoiceLanguage,
} from '@/lib/voice-cloning/language';
import {
  createVoiceProfileId,
  deleteVoiceProfileAssets,
  findCurrentVoiceProfile,
  readVoiceProfile,
  referenceAudioExists,
  writeReferenceAudio,
  writeVoiceProfile,
  resolveReferenceAudioPath,
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
  type VoicePreview,
  type VoiceProfile,
} from '@/lib/voice-cloning/types';
import {
  isVoiceRecordingQualityError,
  masterGeneratedVoiceAudio,
  normalizeVoiceEnrollmentRecording,
  type IncomingVoiceClip,
} from '@/lib/voice-cloning/audio-validation';
import { getVoiceCloningProvider } from '@/lib/voice-cloning/provider';
import { createLogger } from '@/lib/logger';
import { resolveTTSLanguageCode, tryResolveTTSLanguageCode } from '@/lib/audio/tts-language';

const log = createLogger('VoiceCloningProfileAPI');

export const maxDuration = 960;

function disabled() {
  return apiError('PROVIDER_DISABLED', 404, 'Voice cloning is disabled');
}

function serverDefaultModelVariant(): ChatterboxModelVariant {
  const configured = getChatterboxDefaultModelVariant();
  return isChatterboxModelVariant(configured) ? configured : 'v3';
}

function voicePreviewFromAudio(audio: Uint8Array, format: string): VoicePreview {
  return {
    format,
    base64: Buffer.from(audio).toString('base64'),
    createdAt: new Date().toISOString(),
  };
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
      typeof input.languageId === 'string' ? input.languageId : resolveVoiceProfileLanguageId(profile),
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

async function generateVariantPreview(
  profile: VoiceProfile,
  config: VoiceConfiguration,
): Promise<{ providerReferenceId: string; preview: VoicePreview }> {
  if (!profile.referenceAudioKey || !(await referenceAudioExists(profile.referenceAudioKey))) {
    throw new Error('Voice profile reference audio not found');
  }
  const providerId = resolveVoiceProfileProvider(profile);
  validateTeachingVoiceLanguage(profile, config.languageId);
  const provider = getVoiceCloningProvider(providerId);
  const { providerReferenceId } = await provider.createProfile({
    profileId: profile.id,
    referenceAudioKey: resolveReferenceAudioPath(profile.referenceAudioKey),
    referenceText: profile.referenceText,
    language: config.languageId,
    modelVariant: config.modelVariant,
    generationSettings: config.generationSettings,
  });
  const preview = await provider.generatePreview({
    providerReferenceId,
    text: getVoicePreviewText(config.languageId, providerId),
    language: config.languageId,
    modelVariant: config.modelVariant,
    generationSettings: config.generationSettings,
  });
  const mastered = await masterGeneratedVoiceAudio(preview.audio, preview.format);
  log.info('voice output mastering completed', {
    profileId: profile.id,
    operation: 'preview',
    format: mastered.format,
  });
  return {
    providerReferenceId,
    preview: voicePreviewFromAudio(mastered.audio, mastered.format),
  };
}

async function readEnrollmentRecording(formData: FormData): Promise<IncomingVoiceClip> {
  const value = formData.get('recording');
  if (!(value instanceof File)) {
    throw new Error('Missing recording');
  }
  return {
    bytes: new Uint8Array(await value.arrayBuffer()),
    mimeType: value.type,
    fileName: value.name,
  };
}

export async function GET(req: NextRequest) {
  if (!isVoiceCloningServerEnabled()) return disabled();
  const user = await requireSessionUser(req);
  if (user instanceof Response) return user;
  try {
    const params = req.nextUrl.searchParams;
    const requested = params.get('language');
    const language = requested === null ? undefined : resolveTeachingVoiceLanguage(requested);
    if (language === null) return apiError('INVALID_REQUEST', 400, 'Unsupported or ambiguous voice language');
    const profileId = params.get('profileId');
    const profile = profileId
      ? await readVoiceProfile(profileId, user.id)
      : await findCurrentVoiceProfile(user.id, language);
    if (profileId && (!profile || profile.ownerId !== user.id || profile.status !== 'ready')) {
      return apiError('INVALID_REQUEST', 404, 'Selected Teaching Voice is not ready or no longer exists');
    }
    if (profileId && profile) {
      getVoiceCloningProvider(resolveVoiceProfileProvider(profile));
      validateTeachingVoiceLanguage(profile, requested ?? undefined);
    }
    return apiSuccess({ profile: toPublicVoiceProfile(profile) });
  } catch (error) {
    return apiError('INVALID_REQUEST', 400, error instanceof TeachingVoiceError ? error.message : 'Could not load Teaching Voice');
  }
}

export async function POST(req: NextRequest) {
  if (!isVoiceCloningServerEnabled()) return disabled();
  const user = await requireSessionUser(req);
  if (user instanceof Response) return user;
  let profile: VoiceProfile | null = null;
  let previousProfile: VoiceProfile | null = null;
  try {
    const formData = await req.formData();
    const consent = formData.get('consent') === 'true';
    if (!consent) {
      return apiError('INVALID_REQUEST', 400, 'Explicit consent is required');
    }

    const displayName =
      typeof formData.get('displayName') === 'string'
        ? String(formData.get('displayName')).trim().slice(0, 80)
        : '';
    let languageId: string;
    let providerId: 'qwen3' | 'indicf5';
    let referenceText: string;
    try {
      const languageValue = formData.get('languageId') ?? formData.get('language');
      languageId = resolveTeachingVoiceLanguage(typeof languageValue === 'string' ? languageValue : null) || '';
      providerId = newTeachingVoiceProvider(languageId);
      const phrase = getVoiceEnrollmentPhrases(languageId).find((item) => item.id === formData.get('phraseId'));
      if (!phrase || formData.get('referenceText') !== phrase.text) {
        throw new TeachingVoiceError('The enrollment paragraph has changed. Reload and record the displayed paragraph again.');
      }
      referenceText = phrase.text;
    } catch (error) {
      return apiError(
        'INVALID_REQUEST',
        400,
        error instanceof Error ? error.message : 'Invalid voice settings',
      );
    }
    const config: VoiceConfiguration = {
      languageId,
    };
    const attemptId = randomUUID();
    let normalizedReference: Awaited<ReturnType<typeof normalizeVoiceEnrollmentRecording>>;
    try {
      const recording = await readEnrollmentRecording(formData);
      log.info('voice enrollment quality check started', {
        attemptId,
        operation: 'enroll',
        recordingBytes: recording.bytes.byteLength,
      });
      normalizedReference = await normalizeVoiceEnrollmentRecording(recording);
      log.info('voice enrollment quality check passed', {
        attemptId,
        operation: 'enroll',
        durationMs: Math.round(normalizedReference.quality.durationSeconds * 1000),
        peakLevel: normalizedReference.quality.maxVolumeDb,
        meanLevel: normalizedReference.quality.meanVolumeDb,
        silenceRatio: normalizedReference.quality.silenceRatio,
        clippedSampleRatio: normalizedReference.quality.clippedSampleRatio,
        maxConsecutiveClippingMs: normalizedReference.quality.maxConsecutiveClippingMs,
        qualityDecision: normalizedReference.qualityDecision.severity,
        qualityWarnings: normalizedReference.qualityDecision.warnings,
      });
    } catch (error) {
      if (isVoiceRecordingQualityError(error)) {
        log.warn('voice enrollment rejected', {
          attemptId,
          operation: 'enroll',
          reason: error.code,
          qualityDecision: error.decision?.severity ?? 'reject',
          ...(error.metrics
            ? {
                durationMs: Math.round(error.metrics.durationSeconds * 1000),
                peakLevel: error.metrics.maxVolumeDb,
                meanLevel: error.metrics.meanVolumeDb,
                silenceRatio: error.metrics.silenceRatio,
                clippedSampleRatio: error.metrics.clippedSampleRatio,
                maxConsecutiveClippingMs: error.metrics.maxConsecutiveClippingMs,
              }
            : {}),
        });
        return apiError('INVALID_REQUEST', 400, error.userMessage);
      }
      return apiError(
        'INVALID_REQUEST',
        400,
        'Invalid voice recording',
      );
    }

    previousProfile = await findCurrentVoiceProfile(user.id, languageId, true);

    const profileId = createVoiceProfileId();
    const now = new Date().toISOString();
    profile = {
      id: profileId,
      ownerId: user.id,
      displayName: displayName || 'My Teaching Voice',
      provider: providerId,
      language: languageId,
      languageId,
      referenceText,
      status: 'processing',
      createdAt: now,
      updatedAt: now,
      consentTimestamp: now,
      consentVersion: VOICE_CLONING_CONSENT_VERSION,
      profileVersion: 1,
      replacesProfileId: previousProfile?.id,
      enrollmentQuality: {
        severity: normalizedReference.qualityDecision.severity === 'warning' ? 'warning' : 'pass',
        warnings: normalizedReference.qualityDecision.warnings,
      },
    };
    await writeVoiceProfile(profile);

    const referenceAudioKey = await writeReferenceAudio(
      profileId,
      user.id,
      normalizedReference.referenceAudio,
    );
    profile = { ...profile, referenceAudioKey, updatedAt: new Date().toISOString() };
    await writeVoiceProfile(profile);
    log.info('voice reference preprocessing completed', {
      profileId,
      operation: 'enroll',
      durationMs: Math.round(normalizedReference.durationSeconds * 1000),
      peakLevel: normalizedReference.quality.maxVolumeDb,
      meanLevel: normalizedReference.quality.meanVolumeDb,
      silenceRatio: normalizedReference.quality.silenceRatio,
      clippedSampleRatio: normalizedReference.quality.clippedSampleRatio,
      maxConsecutiveClippingMs: normalizedReference.quality.maxConsecutiveClippingMs,
      qualityDecision: normalizedReference.qualityDecision.severity,
    });

    const { providerReferenceId, preview } = await generateVariantPreview(profile, config);
    profile = {
      ...profile,
      providerReferenceId,
      status: 'preview-ready',
      updatedAt: new Date().toISOString(),
      draftPreview: { config, preview },
    };
    await writeVoiceProfile(profile);

    log.info('voice profile enrolled', {
      profileId,
      operation: 'enroll',
      status: profile.status,
      durationMs: Math.round(normalizedReference.durationSeconds * 1000),
      qualityDecision: normalizedReference.qualityDecision.severity,
    });

    return apiSuccess({ profile: toPublicVoiceProfile(profile) }, 201);
  } catch (error) {
    if (profile) {
      const failed = {
        ...profile,
        status: 'failed' as const,
        updatedAt: new Date().toISOString(),
        failureReason: error instanceof TeachingVoiceError ? error.message : 'Voice enrollment failed',
      };
      await writeVoiceProfile(failed).catch(() => undefined);
    }
    log.warn('voice profile enrollment failed', {
      operation: 'enroll',
      status: 'failed',
      error: error instanceof TeachingVoiceError ? error.message : 'Voice enrollment failed',
      profileId: profile?.id,
    });
    return apiError(
      'GENERATION_FAILED',
      500,
      error instanceof TeachingVoiceError ? error.message : 'Voice enrollment failed',
    );
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
      return apiError('GENERATION_FAILED', error instanceof TeachingVoiceError ? error.status : 500,
        error instanceof TeachingVoiceError ? error.message : 'Teaching Voice preview failed');
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
  const next = {
    ...profile,
    status: 'ready' as const,
    language: config.languageId,
    languageId: config.languageId,
    modelVariant: config.modelVariant,
    generationSettings: config.generationSettings,
    preview: acceptedDraft.preview,
    draftPreview: undefined,
    updatedAt: new Date().toISOString(),
  };
  await writeVoiceProfile(next);
  await markVoiceConfigured(user.id);
  if (profile.replacesProfileId) {
    const previousProfile = await readVoiceProfile(profile.replacesProfileId, user.id);
    if (
      previousProfile &&
      previousProfile.ownerId === user.id &&
      resolveTeachingVoiceLanguage(resolveVoiceProfileLanguageId(previousProfile)) === config.languageId &&
      previousProfile.status !== 'deleted'
    ) {
      if (previousProfile.providerReferenceId) {
        await getVoiceCloningProvider(resolveVoiceProfileProvider(previousProfile))
          .deleteProfile({ providerReferenceId: previousProfile.providerReferenceId })
          .catch(() => log.warn('Could not remove replaced Teaching Voice service registration'));
      }
      await deleteVoiceProfileAssets(previousProfile);
      await writeVoiceProfile({
        ...previousProfile,
        status: 'deleted',
        referenceAudioKey: undefined,
        referenceText: undefined,
        providerReferenceId: undefined,
        preview: undefined,
        previewVariants: undefined,
        draftPreview: undefined,
        updatedAt: new Date().toISOString(),
      });
    }
  }
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
      await getVoiceCloningProvider(resolveVoiceProfileProvider(profile))
        .deleteProfile({ providerReferenceId: profile.providerReferenceId });
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
