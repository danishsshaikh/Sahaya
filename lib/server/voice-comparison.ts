import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  BODHAN_STYLES,
  BODHAN_VOICES,
  getVoiceComparisonProvider,
  isBodhanStyle,
  isBodhanVoice,
  VOICE_COMPARISON_LANGUAGES,
  VOICE_COMPARISON_PROVIDERS,
} from '@/lib/voice-comparison/catalog';
import {
  concatenatePcmWav,
  readWavMetadata,
  splitSpeechText,
  splitSpeechTextPreservingText,
} from '@/lib/voice-comparison/audio';
import { BodhanIndicSpeakPreviewProvider } from '@/lib/voice-comparison/providers/bodhan';
import { Ming3TtsPreviewProvider } from '@/lib/voice-comparison/providers/ming3';
import {
  SARVAM_INLINE_REFERENCE_MAX_BYTES,
  SARVAM_INLINE_REFERENCE_MAX_SECONDS,
  SarvamVoiceCloningPreviewProvider,
  sarvamReferenceUploadType,
} from '@/lib/voice-comparison/providers/sarvam';
import type {
  VoiceComparisonBootstrap,
  VoiceComparisonLanguageCode,
  VoiceComparisonPreviewRequest,
  VoiceComparisonPreviewResult,
  VoiceComparisonProviderAvailability,
  VoiceComparisonProviderId,
} from '@/lib/voice-comparison/types';
import { DEFAULT_VOICE_COMPARISON_TEXT } from '@/lib/voice-comparison/types';
import {
  externalVoiceProviderConfigured,
  externalVoiceProviderUnavailableReason,
  getBodhanTtsConfig,
  getSarvamVoiceCloningConfig,
} from '@/lib/server/voice-comparison-config';
import {
  createVoiceComparisonCacheKey,
  readVoiceComparisonCache,
  readVoiceComparisonCacheEntries,
  writeVoiceComparisonCache,
} from '@/lib/server/voice-comparison-cache';
import { runControlledVoicePreview } from '@/lib/server/voice-comparison-control';
import {
  getMing3TtsPreviewServiceConfig,
  isMing3TtsPreviewEnabled,
  isQwen3TtsPreviewEnabled,
} from '@/lib/voice-cloning/config';
import { resolveVoiceProfileReferenceLanguage } from '@/lib/voice-cloning/language';
import { getVoiceCloningProvider } from '@/lib/voice-cloning/provider';
import { Qwen3TtsVoiceCloningProvider } from '@/lib/voice-cloning/providers/qwen3-preview';
import {
  readVoiceProfile,
  referenceAudioExists,
  resolveAuthorizedProfileReference,
  resolveReferenceAudioPath,
  writeVoiceProfile,
} from '@/lib/voice-cloning/storage';
import {
  resolveVoiceProfileGenerationSettings,
  resolveVoiceProfileModelVariant,
  resolveVoiceProfileProvider,
  TeachingVoiceError,
  type SarvamVoiceRegistration,
  type VoiceProfile,
} from '@/lib/voice-cloning/types';
import { createLogger } from '@/lib/logger';
import { isExperimentalCourseNarrationEnabled } from '@/lib/config/feature-flags';
import { validateVoiceClipDecodability } from '@/lib/voice-cloning/audio-validation';

const SARVAM_CONSENT_VERSION = 'sarvam-external-voice-raw-v2';
const SARVAM_RAW_PROCESSING_MODE = 'raw-provider-output-v1';
const MING3_PROCESSING_MODE = 'official-model-runtime-v1';
const log = createLogger('VoiceComparison');

interface SarvamInlineReference {
  key: string;
  bytes: Uint8Array;
  sha256: string;
  mimeType: string;
  durationSeconds: number;
  provenance: 'original-upload';
}

function mingReference(profile: VoiceProfile): {
  key: string;
  provenance: 'original-upload' | 'processed-reference';
} | null {
  const originalMime = profile.originalRecording?.mimeType.toLowerCase().split(';', 1)[0];
  if (
    profile.originalRecording &&
    profile.originalRecording.key?.trim() &&
    originalMime &&
    ['audio/wav', 'audio/x-wav', 'audio/flac', 'audio/ogg', 'audio/opus'].includes(originalMime)
  ) {
    return { key: profile.originalRecording.key, provenance: 'original-upload' };
  }
  return profile.referenceAudioKey?.trim()
    ? { key: profile.referenceAudioKey, provenance: 'processed-reference' }
    : null;
}

function voiceProviderAvailability(
  profile: VoiceProfile,
  providerId: VoiceComparisonProviderId,
): VoiceComparisonProviderAvailability {
  const capability = getVoiceComparisonProvider(providerId);
  const profileProvider = resolveVoiceProfileProvider(profile);
  const referenceLanguage = resolveVoiceProfileReferenceLanguage(profile);
  const referenceReady = Boolean(profile.referenceAudioKey && profile.status === 'ready');
  let configured = true;
  let available = referenceReady;
  let unavailableReason: string | undefined;

  if (providerId === 'chatterbox') {
    available = referenceReady && profileProvider === 'chatterbox';
    unavailableReason = available
      ? undefined
      : 'Requires a ready English Chatterbox Teaching Voice.';
  } else if (providerId === 'qwen3-tts') {
    configured = isQwen3TtsPreviewEnabled();
    available =
      configured &&
      referenceReady &&
      profileProvider === 'chatterbox' &&
      referenceLanguage === 'en';
    unavailableReason = !configured
      ? 'Not configured'
      : available
        ? undefined
        : 'Requires a ready English Teaching Voice recording.';
  } else if (providerId === 'ming3-tts') {
    configured = isMing3TtsPreviewEnabled();
    available =
      configured &&
      referenceReady &&
      referenceLanguage === 'en' &&
      Boolean(profile.referenceText?.trim());
    unavailableReason = !configured
      ? 'Not configured'
      : available
        ? undefined
        : 'Requires a ready English Teaching Voice recording and transcript.';
  } else if (providerId === 'indicf5') {
    available =
      referenceReady &&
      profileProvider === 'indicf5' &&
      (referenceLanguage === 'hi' || referenceLanguage === 'mr') &&
      Boolean(profile.providerReferenceId);
    unavailableReason = available ? undefined : 'Requires a ready Hindi or Marathi IndicF5 voice.';
  } else if (providerId === 'sarvam') {
    const sarvamConfig = getSarvamVoiceCloningConfig();
    configured = externalVoiceProviderConfigured(sarvamConfig);
    const registration = validSarvamRegistration(profile);
    const rawReferenceAvailable = Boolean(
      profile.originalRecording &&
      profile.originalRecording.byteLength > 0 &&
      profile.originalRecording.byteLength <= SARVAM_INLINE_REFERENCE_MAX_BYTES &&
      sarvamReferenceUploadType(profile.originalRecording.mimeType),
    );
    available =
      configured &&
      Boolean(referenceLanguage) &&
      (Boolean(registration) || (referenceReady && rawReferenceAvailable));
    unavailableReason = !configured
      ? externalVoiceProviderUnavailableReason('Sarvam AI', sarvamConfig)
      : available
        ? undefined
        : !referenceReady
          ? 'A ready Teaching Voice recording is required.'
          : (profile.originalRecording?.byteLength ?? 0) > SARVAM_INLINE_REFERENCE_MAX_BYTES
            ? 'The original recording exceeds Sarvam AI’s 10 MB inline-reference limit. Use an existing saved Sarvam clone or enroll a shorter reference.'
            : profile.originalRecording
              ? 'The exact original recording format is not supported by Sarvam AI. Sahaya will not transcode it.'
              : 'The original recording was not retained. Select a Teaching Voice with a saved Sarvam clone or re-enroll a reference.';
  } else {
    configured = externalVoiceProviderConfigured(getBodhanTtsConfig());
    available = configured;
    unavailableReason = configured ? undefined : 'Not configured';
  }

  return {
    ...capability,
    configured,
    available,
    courseNarrationEnabled:
      capability.supportsCourseNarration &&
      (!capability.experimental || isExperimentalCourseNarrationEnabled()),
    ...(unavailableReason ? { unavailableReason } : {}),
    ...(providerId === 'sarvam'
      ? {
          requiresExternalConsent: !validSarvamRegistration(profile),
          externalVoiceReady: Boolean(validSarvamRegistration(profile)),
          ...(validSarvamRegistration(profile)?.referenceProvenance
            ? {
                sarvamReferenceProvenance: validSarvamRegistration(profile)!.referenceProvenance,
              }
            : {}),
          sarvamRawReferenceAvailable: Boolean(
            profile.originalRecording &&
            sarvamReferenceUploadType(profile.originalRecording.mimeType),
          ),
          sarvamCanCreateRawClone: Boolean(
            validLegacySarvamRegistration(profile) &&
            !validRawSarvamRegistration(profile) &&
            profile.originalRecording &&
            sarvamReferenceUploadType(profile.originalRecording.mimeType),
          ),
          ...(validSarvamRegistration(profile)?.consentTimestamp
            ? { externalConsentTimestamp: validSarvamRegistration(profile)!.consentTimestamp }
            : {}),
        }
      : {}),
  };
}

export async function getVoiceComparisonBootstrap(
  ownerId: string,
  profile: VoiceProfile,
): Promise<VoiceComparisonBootstrap> {
  const savedPreviews = await readVoiceComparisonCacheEntries(ownerId, profile.id);
  const referenceLanguage = resolveVoiceProfileReferenceLanguage(profile);
  const defaultLanguage = VOICE_COMPARISON_LANGUAGES.some(({ code }) => code === referenceLanguage)
    ? (referenceLanguage as VoiceComparisonLanguageCode)
    : 'en';
  const legacyCandidates: Array<{
    request: VoiceComparisonPreviewRequest;
    sarvamRegistration?: SarvamVoiceRegistration;
  }> = [];
  const sarvamRegistration = validSarvamRegistration(profile);
  if (sarvamRegistration) {
    legacyCandidates.push({
      request: {
        profileId: profile.id,
        providerId: 'sarvam',
        text: DEFAULT_VOICE_COMPARISON_TEXT,
        language: defaultLanguage,
      },
      sarvamRegistration,
    });
  }
  const defaultBodhanVoice =
    BODHAN_VOICES.find(({ recordedLanguage }) => recordedLanguage === defaultLanguage) ??
    BODHAN_VOICES[0];
  if (defaultBodhanVoice) {
    legacyCandidates.push({
      request: {
        profileId: profile.id,
        providerId: 'bodhan',
        text: DEFAULT_VOICE_COMPARISON_TEXT,
        language: defaultLanguage,
        voice: defaultBodhanVoice.id,
        style: BODHAN_STYLES[0],
      },
    });
  }
  for (const candidate of legacyCandidates) {
    const cacheKey = voiceComparisonCacheKey({
      profile,
      request: candidate.request,
      synthesisText: candidate.request.text,
      sarvamRegistration: candidate.sarvamRegistration,
    });
    if (savedPreviews.some((preview) => preview.cacheKey === cacheKey)) continue;
    const legacy = await readVoiceComparisonCache(ownerId, cacheKey);
    if (!legacy || legacy.profileId) continue;
    savedPreviews.push({
      ...legacy,
      profileId: profile.id,
      request: {
        text: candidate.request.text,
        language: candidate.request.language,
        ...(candidate.request.voice ? { voice: candidate.request.voice } : {}),
        ...(candidate.request.style ? { style: candidate.request.style } : {}),
      },
    });
  }
  return {
    providers: VOICE_COMPARISON_PROVIDERS.map(({ id }) => voiceProviderAvailability(profile, id)),
    languages: VOICE_COMPARISON_LANGUAGES,
    bodhanVoices: BODHAN_VOICES,
    bodhanStyles: [...BODHAN_STYLES],
    savedPreviews: savedPreviews.sort((a, b) => b.generatedAt.localeCompare(a.generatedAt)),
  };
}

function voiceComparisonCacheKey(input: {
  profile: VoiceProfile;
  request: VoiceComparisonPreviewRequest;
  synthesisText: string;
  sarvamRegistration?: SarvamVoiceRegistration;
  sarvamInlineReference?: SarvamInlineReference;
}): string {
  const mingConditioningMode =
    input.request.providerId === 'ming3-tts'
      ? getMing3TtsPreviewServiceConfig().conditioningMode
      : null;
  return createVoiceComparisonCacheKey({
    ownerId: input.profile.ownerId,
    profileId: input.profile.id,
    profileVersion: input.profile.profileVersion,
    referenceAudioKey: input.profile.referenceAudioKey ?? null,
    ...(input.request.providerId === 'ming3-tts'
      ? { mingReferenceAudioKey: mingReference(input.profile)?.key ?? null }
      : {}),
    providerId: input.request.providerId,
    language: input.request.language,
    text: input.synthesisText,
    voice: input.request.voice ?? null,
    style: input.request.style ?? null,
    sarvamVoiceId: input.sarvamRegistration?.voiceId ?? null,
    ...(input.sarvamInlineReference
      ? {
          sarvamReferenceAudioKey: input.sarvamInlineReference.key,
          sarvamReferenceBytes: input.sarvamInlineReference.bytes.byteLength,
          sarvamReferenceDuration: input.sarvamInlineReference.durationSeconds,
          sarvamReferenceSha256: input.sarvamInlineReference.sha256,
        }
      : {}),
    modelVariant:
      input.request.providerId === 'chatterbox'
        ? resolveVoiceProfileModelVariant(input.profile)
        : null,
    generationSettings:
      input.request.providerId === 'chatterbox'
        ? resolveVoiceProfileGenerationSettings(input.profile)
        : null,
    qwenCloneMode: input.request.providerId === 'qwen3-tts' ? 'speaker-embedding' : null,
    processingMode:
      input.request.providerId === 'sarvam'
        ? SARVAM_RAW_PROCESSING_MODE
        : input.request.providerId === 'ming3-tts'
          ? mingConditioningMode === 'speaker-embedding-only'
            ? `${MING3_PROCESSING_MODE}-speaker-embedding-only`
            : MING3_PROCESSING_MODE
          : 'standard-v1',
    outputCodec:
      input.request.providerId === 'sarvam' || input.request.providerId === 'ming3-tts'
        ? 'wav'
        : null,
    providerGenerationParameters:
      input.request.providerId === 'sarvam'
        ? { enableVad: false, enableTextNormalization: false, enableQc: false }
        : input.request.providerId === 'ming3-tts'
          ? mingConditioningMode === 'speaker-embedding-only'
            ? {
                task: 'TTS',
                languageId: 'English',
                useSpeakerEmbedding: true,
                rawText: true,
                modelDefaults: true,
                conditioningMode: 'speaker-embedding-only',
                acousticPrompt: false,
              }
            : {
                task: 'TTS',
                languageId: 'English',
                useSpeakerEmbedding: true,
                rawText: true,
                modelDefaults: true,
              }
          : null,
  });
}

function mingServiceProfileId(profile: VoiceProfile): string {
  return `ming_${createHash('sha256')
    .update(`${profile.ownerId}\0${profile.id}\0${profile.profileVersion}`)
    .digest('hex')
    .slice(0, 32)}`;
}

function validLegacySarvamRegistration(profile: VoiceProfile): SarvamVoiceRegistration | null {
  const registration = profile.sarvamVoice;
  if (
    !registration ||
    !profile.referenceAudioKey ||
    registration.referenceAudioKey !== profile.referenceAudioKey ||
    registration.profileVersion !== profile.profileVersion
  ) {
    return null;
  }
  return {
    ...registration,
    referenceProvenance: registration.referenceProvenance ?? 'processed-reference',
  };
}

function validRawSarvamRegistration(profile: VoiceProfile): SarvamVoiceRegistration | null {
  const registration = profile.sarvamRawVoice;
  if (
    !registration ||
    !profile.originalRecording ||
    registration.referenceAudioKey !== profile.originalRecording.key ||
    registration.profileVersion !== profile.profileVersion ||
    registration.referenceProvenance !== 'original-upload'
  ) {
    return null;
  }
  return registration;
}

function validSarvamRegistration(profile: VoiceProfile): SarvamVoiceRegistration | null {
  return validRawSarvamRegistration(profile) ?? validLegacySarvamRegistration(profile);
}

async function resolveSarvamInlineReference(profile: VoiceProfile): Promise<SarvamInlineReference> {
  const recording = profile.originalRecording;
  if (!recording) {
    throw new TeachingVoiceError(
      'This Teaching Voice has no retained original recording for Sarvam AI. Select a profile with an existing Sarvam clone or re-enroll a reference.',
      409,
    );
  }
  if (!sarvamReferenceUploadType(recording.mimeType)) {
    throw new TeachingVoiceError(
      'The original Teaching Voice recording format is not supported by Sarvam AI. Select a profile with an existing Sarvam clone or upload a supported reference.',
      409,
    );
  }
  if (recording.byteLength <= 0 || recording.byteLength > SARVAM_INLINE_REFERENCE_MAX_BYTES) {
    throw new TeachingVoiceError(
      'The original Teaching Voice recording exceeds Sarvam AI’s 10 MB inline-reference limit. Select a saved Sarvam clone or enroll a smaller reference.',
      409,
    );
  }
  let reference: Awaited<ReturnType<typeof resolveAuthorizedProfileReference>>;
  try {
    reference = await resolveAuthorizedProfileReference({
      ownerId: profile.ownerId,
      profileId: profile.id,
      preferOriginalMimeTypes: [
        'audio/wav',
        'audio/x-wav',
        'audio/mpeg',
        'audio/flac',
        'audio/ogg',
        'audio/aac',
        'audio/mulaw',
        'audio/alaw',
        'audio/l16',
        'audio/linear16',
      ],
    });
  } catch {
    throw new TeachingVoiceError(
      'The original Teaching Voice recording is missing, empty, or outside authorized profile storage.',
      409,
    );
  }
  const recordingRealPath = await fs.realpath(recording.key).catch(() => null);
  if (
    reference.provenance !== 'original-upload' ||
    !recordingRealPath ||
    reference.path !== recordingRealPath
  ) {
    throw new TeachingVoiceError(
      'The exact original Teaching Voice recording is unavailable. Sahaya will not substitute a processed reference for Sarvam AI.',
      409,
    );
  }
  const bytes = new Uint8Array(await fs.readFile(reference.path));
  if (bytes.byteLength !== recording.byteLength) {
    throw new TeachingVoiceError(
      'The retained Teaching Voice recording changed unexpectedly. Reopen Narration Voice before trying again.',
      409,
    );
  }
  let durationSeconds: number;
  try {
    const normalizedMime = recording.mimeType.trim().toLowerCase();
    durationSeconds =
      normalizedMime === 'audio/wav' || normalizedMime === 'audio/x-wav'
        ? readWavMetadata(bytes).durationSeconds
        : await validateVoiceClipDecodability(reference.path);
  } catch {
    throw new TeachingVoiceError(
      'The original Teaching Voice recording could not be decoded for Sarvam AI.',
      409,
    );
  }
  if (durationSeconds > SARVAM_INLINE_REFERENCE_MAX_SECONDS) {
    throw new TeachingVoiceError(
      'The original Teaching Voice recording exceeds Sarvam AI’s 15-second inline-reference limit. Reuse an existing saved Sarvam clone or enroll a shorter reference.',
      409,
    );
  }
  return {
    key: recording.key,
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    mimeType: recording.mimeType,
    durationSeconds,
    provenance: 'original-upload',
  };
}

export async function resolveSarvamCourseNarrationAvailability(
  profile: VoiceProfile,
): Promise<
  Pick<
    VoiceComparisonProviderAvailability,
    'configured' | 'available' | 'unavailableReason' | 'externalVoiceReady' | 'sarvamNarrationMode'
  >
> {
  const config = getSarvamVoiceCloningConfig();
  const configReason = externalVoiceProviderUnavailableReason('Sarvam AI', config);
  if (configReason) {
    return {
      configured: false,
      available: false,
      unavailableReason: configReason,
      externalVoiceReady: false,
    };
  }
  if (validSarvamRegistration(profile)) {
    return {
      configured: true,
      available: true,
      unavailableReason: undefined,
      externalVoiceReady: true,
      sarvamNarrationMode: 'saved-voice-id',
    };
  }
  try {
    await resolveSarvamInlineReference(profile);
    return {
      configured: true,
      available: true,
      unavailableReason: undefined,
      externalVoiceReady: false,
      sarvamNarrationMode: 'inline-reference',
    };
  } catch (error) {
    return {
      configured: true,
      available: false,
      unavailableReason:
        error instanceof TeachingVoiceError
          ? error.message
          : 'The selected Teaching Voice has no usable Sarvam reference.',
      externalVoiceReady: false,
    };
  }
}

async function ensureSarvamRegistration(input: {
  ownerId: string;
  profile: VoiceProfile;
  consent: boolean;
  createRawVoice: boolean;
  signal?: AbortSignal;
}): Promise<SarvamVoiceRegistration> {
  const current = validSarvamRegistration(input.profile);
  if (current && !input.createRawVoice) return current;
  const currentRaw = validRawSarvamRegistration(input.profile);
  if (currentRaw) return currentRaw;
  if (!input.consent) {
    throw new TeachingVoiceError('Consent is required before sending your recording to Sarvam AI.');
  }
  const config = getSarvamVoiceCloningConfig();
  return runControlledVoicePreview({
    providerId: 'sarvam',
    requestKey: `sarvam-raw-registration:${input.ownerId}:${input.profile.id}:${input.profile.profileVersion}`,
    concurrency: config.maxConcurrency,
    task: async () => {
      const latest = await requireOwnedReadyProfile(input.ownerId, input.profile.id);
      const existingRaw = validRawSarvamRegistration(latest);
      if (existingRaw) return existingRaw;
      const originalRecording = latest.originalRecording;
      const referenceLanguage = resolveVoiceProfileReferenceLanguage(latest);
      if (!originalRecording || !(await referenceAudioExists(originalRecording.key))) {
        throw new TeachingVoiceError(
          'The original recording was not retained. Re-enroll the Teaching Voice before creating a raw Sarvam clone.',
          409,
        );
      }
      if (!sarvamReferenceUploadType(originalRecording.mimeType)) {
        throw new TeachingVoiceError(
          'The original recording format is not supported by Sarvam AI. Sahaya will not transcode it.',
        );
      }
      if (!referenceLanguage) {
        throw new TeachingVoiceError('The Teaching Voice reference language is unsupported.');
      }
      const provider = new SarvamVoiceCloningPreviewProvider(config);
      const created = await provider.createVoice({
        profileId: latest.id,
        referenceAudio: new Uint8Array(await fs.readFile(originalRecording.key)),
        referenceMimeType: originalRecording.mimeType,
        referenceLanguage: referenceLanguage as VoiceComparisonLanguageCode,
        signal: input.signal,
      });
      const afterCreation = await requireOwnedReadyProfile(input.ownerId, input.profile.id);
      if (
        afterCreation.profileVersion !== latest.profileVersion ||
        afterCreation.originalRecording?.key !== originalRecording.key
      ) {
        throw new TeachingVoiceError(
          'The Teaching Voice changed while Sarvam AI was being prepared. Try again.',
          409,
        );
      }
      const now = new Date().toISOString();
      const registration: SarvamVoiceRegistration = {
        voiceId: created.voiceId,
        consentTimestamp: now,
        consentVersion: SARVAM_CONSENT_VERSION,
        createdAt: now,
        referenceAudioKey: originalRecording.key,
        profileVersion: afterCreation.profileVersion,
        referenceLanguage,
        referenceProvenance: 'original-upload',
        referenceMimeType: originalRecording.mimeType,
        ...(created.referenceText ? { providerReferenceText: created.referenceText } : {}),
      };
      await writeVoiceProfile({ ...afterCreation, sarvamRawVoice: registration, updatedAt: now });
      log.info('Sarvam raw-reference voice registered', {
        profileId: afterCreation.id,
        referenceProvenance: 'original-upload',
        referenceMimeType: originalRecording.mimeType,
        referenceBytes: originalRecording.byteLength,
        providerRequestId: created.requestId,
        sahayaAudioProcessingApplied: false,
      });
      return registration;
    },
  });
}

export async function requireOwnedReadyProfile(
  ownerId: string,
  profileId: string,
): Promise<VoiceProfile> {
  const profile = await readVoiceProfile(profileId, ownerId);
  if (!profile || profile.ownerId !== ownerId || profile.status !== 'ready') {
    throw new TeachingVoiceError('Teaching Voice profile was not found.', 404);
  }
  return profile;
}

function validateRequest(profile: VoiceProfile, request: VoiceComparisonPreviewRequest): void {
  const capability = getVoiceComparisonProvider(request.providerId);
  if (!capability.supportedLanguages.includes(request.language)) {
    throw new TeachingVoiceError(`${capability.name} does not support the selected language.`);
  }
  const availability = voiceProviderAvailability(profile, request.providerId);
  if (!availability.available) {
    throw new TeachingVoiceError(
      availability.unavailableReason || 'Voice provider is unavailable.',
      503,
    );
  }
  if (request.providerId === 'bodhan') {
    if (!isBodhanVoice(request.voice))
      throw new TeachingVoiceError('Select a supported Bodhan voice.');
    if (request.style && !isBodhanStyle(request.style)) {
      throw new TeachingVoiceError('Select a supported Bodhan speaking style.');
    }
  }
}

async function generateProviderAudio(input: {
  profile: VoiceProfile;
  request: VoiceComparisonPreviewRequest;
  sarvamRegistration?: SarvamVoiceRegistration;
  sarvamInlineReference?: SarvamInlineReference;
  signal?: AbortSignal;
  preserveTextChunks?: boolean;
}): Promise<{
  audio: Uint8Array;
  durationSeconds?: number;
  requestId?: string;
  referenceTransformation?: string;
  conditioningMode?: 'acoustic-reference' | 'speaker-embedding-only';
  generationConfig?: string;
  referenceProvenance?: 'original-upload' | 'processed-reference';
  chunked: boolean;
}> {
  const { profile, request } = input;
  if (request.providerId === 'sarvam') {
    if (!input.sarvamRegistration && !input.sarvamInlineReference) {
      throw new TeachingVoiceError(
        'Sarvam AI requires an existing saved clone or a compatible original Teaching Voice recording.',
      );
    }
    if (!request.text.trim()) throw new TeachingVoiceError('Enter text to compare.');
    if (request.text.length > 1000) {
      throw new TeachingVoiceError(
        'Raw Sarvam comparison is limited to 1000 characters so the result remains one untouched provider response.',
      );
    }
    const provider = new SarvamVoiceCloningPreviewProvider();
    const result = await provider.synthesize({
      ...(input.sarvamRegistration
        ? { voiceId: input.sarvamRegistration.voiceId }
        : input.sarvamInlineReference
          ? {
              referenceAudio: {
                bytes: input.sarvamInlineReference.bytes,
                mimeType: input.sarvamInlineReference.mimeType,
                durationSeconds: input.sarvamInlineReference.durationSeconds,
              },
            }
          : {}),
      text: request.text,
      language: request.language,
      signal: input.signal,
    });
    return {
      audio: result.audio,
      durationSeconds: result.durationSeconds,
      ...(result.requestId ? { requestId: result.requestId } : {}),
      referenceProvenance: input.sarvamInlineReference?.provenance,
      chunked: false,
    };
  }
  if (request.providerId === 'ming3-tts') {
    if (!request.text.trim()) throw new TeachingVoiceError('Enter text to compare.');
    if (request.text.length > 1000) {
      throw new TeachingVoiceError(
        'Ming 3.0 TTS preview is limited to 1000 characters for one direct model request.',
      );
    }
    if (!profile.referenceText?.trim()) {
      throw new TeachingVoiceError(
        'Ming 3.0 TTS requires the saved English reference audio and transcript.',
      );
    }
    let reference: Awaited<ReturnType<typeof resolveAuthorizedProfileReference>>;
    try {
      reference = await resolveAuthorizedProfileReference({
        ownerId: profile.ownerId,
        profileId: profile.id,
        preferOriginalMimeTypes: [
          'audio/wav',
          'audio/x-wav',
          'audio/flac',
          'audio/ogg',
          'audio/opus',
        ],
      });
    } catch {
      throw new TeachingVoiceError(
        'Ming 3.0 TTS requires a readable voice reference in your authorized profile storage.',
      );
    }
    const provider = new Ming3TtsPreviewProvider();
    const serviceProfileId = mingServiceProfileId(profile);
    await provider.registerProfile(
      {
        profileId: serviceProfileId,
        referenceAudioPath: reference.path,
        referenceText: profile.referenceText,
      },
      input.signal,
    );
    const result = await provider.synthesize({
      profileId: serviceProfileId,
      text: request.text,
      language: 'en',
      signal: input.signal,
    });
    const conditioningMode =
      result.conditioningMode === 'acoustic-reference' ||
      result.conditioningMode === 'speaker-embedding-only'
        ? result.conditioningMode
        : undefined;
    return {
      audio: result.audio,
      durationSeconds: result.durationSeconds,
      ...(result.requestId ? { requestId: result.requestId } : {}),
      ...(result.referenceTransformation
        ? { referenceTransformation: result.referenceTransformation }
        : {}),
      ...(conditioningMode ? { conditioningMode } : {}),
      ...(result.generationConfig ? { generationConfig: result.generationConfig } : {}),
      referenceProvenance: reference.provenance,
      chunked: false,
    };
  }
  const limit = request.providerId === 'bodhan' ? 700 : 1000;
  // Preserve short comparison/course transcripts byte-for-byte. Splitting is only a
  // provider-limit compatibility path and remains explicit in the result metadata.
  const chunks =
    request.text.length <= limit
      ? [request.text]
      : input.preserveTextChunks
        ? splitSpeechTextPreservingText(request.text, limit)
        : splitSpeechText(request.text, limit);
  const audioParts: Uint8Array[] = [];
  let requestId: string | undefined;
  if (request.providerId === 'bodhan') {
    const provider = new BodhanIndicSpeakPreviewProvider();
    for (const text of chunks) {
      const result = await provider.synthesize({
        text,
        language: request.language,
        voice: request.voice!,
        style: request.style,
        signal: input.signal,
      });
      audioParts.push(result.audio);
      requestId ??= result.requestId;
    }
  } else if (request.providerId === 'qwen3-tts') {
    if (!profile.referenceAudioKey || !profile.referenceText?.trim()) {
      throw new TeachingVoiceError('Qwen3-TTS requires the saved reference audio and transcript.');
    }
    const provider = new Qwen3TtsVoiceCloningProvider();
    const { providerReferenceId } = await provider.createProfile({
      profileId: profile.id,
      referenceAudioKey: resolveReferenceAudioPath(profile.referenceAudioKey),
      referenceText: profile.referenceText,
      language: 'en',
    });
    for (const text of chunks) {
      audioParts.push(
        (await provider.generatePreview({ providerReferenceId, text, language: 'en' })).audio,
      );
    }
  } else {
    const provider = getVoiceCloningProvider(request.providerId);
    let providerReferenceId = profile.providerReferenceId;
    if (!providerReferenceId && request.providerId === 'chatterbox') {
      if (!profile.referenceAudioKey) {
        throw new TeachingVoiceError('Teaching Voice reference audio was not found.');
      }
      const registered = await provider.createProfile({
        profileId: profile.id,
        referenceAudioKey: resolveReferenceAudioPath(profile.referenceAudioKey),
        ...(profile.referenceText ? { referenceText: profile.referenceText } : {}),
        language: profile.language,
        modelVariant: resolveVoiceProfileModelVariant(profile),
        generationSettings: resolveVoiceProfileGenerationSettings(profile),
      });
      providerReferenceId = registered.providerReferenceId;
      await writeVoiceProfile({
        ...profile,
        providerReferenceId,
        updatedAt: new Date().toISOString(),
      });
    }
    if (!providerReferenceId) {
      throw new TeachingVoiceError('Teaching Voice registration was not found.');
    }
    for (const text of chunks) {
      audioParts.push(
        (
          await provider.generatePreview({
            providerReferenceId,
            text,
            language: request.language,
            ...(request.providerId === 'chatterbox'
              ? {
                  modelVariant: resolveVoiceProfileModelVariant(profile),
                  generationSettings: resolveVoiceProfileGenerationSettings(profile),
                }
              : {}),
          })
        ).audio,
      );
    }
  }
  return {
    audio: concatenatePcmWav(audioParts),
    ...(requestId ? { requestId } : {}),
    chunked: chunks.length > 1,
  };
}

export async function generateVoiceComparisonPreview(input: {
  ownerId: string;
  request: VoiceComparisonPreviewRequest;
  signal?: AbortSignal;
  /** Course narration requires lossless character-preserving chunk boundaries. */
  preserveTextChunks?: boolean;
  /** One-shot clone fallback using the exact authorized original recording. */
  allowSarvamInlineReference?: boolean;
}): Promise<VoiceComparisonPreviewResult> {
  const profile = await requireOwnedReadyProfile(input.ownerId, input.request.profileId);
  validateRequest(profile, input.request);
  const capability = getVoiceComparisonProvider(input.request.providerId);
  const synthesisText = input.request.text;
  if (input.request.providerId === 'sarvam' || input.request.providerId === 'ming3-tts') {
    if (!synthesisText.trim()) throw new TeachingVoiceError('Enter text to compare.');
    if (synthesisText.length > 1000) {
      throw new TeachingVoiceError(
        input.request.providerId === 'sarvam'
          ? 'Raw Sarvam comparison is limited to 1000 characters so the result remains one untouched provider response.'
          : 'Ming 3.0 TTS preview is limited to 1000 characters for one direct model request.',
      );
    }
  } else {
    if (!synthesisText.trim()) throw new TeachingVoiceError('Enter text to compare.');
    if (synthesisText.length > (input.request.providerId === 'bodhan' ? 700 : 1000)) {
      const limit = input.request.providerId === 'bodhan' ? 700 : 1000;
      if (input.preserveTextChunks) splitSpeechTextPreservingText(synthesisText, limit);
      else splitSpeechText(synthesisText, limit);
    }
  }
  let sarvamRegistration: SarvamVoiceRegistration | undefined;
  let sarvamInlineReference: SarvamInlineReference | undefined;
  if (input.request.providerId === 'sarvam') {
    const existing = validSarvamRegistration(profile);
    if (
      existing &&
      (input.request.sarvamCreateRawVoice !== true || input.allowSarvamInlineReference)
    ) {
      sarvamRegistration = existing;
    } else if (input.allowSarvamInlineReference) {
      sarvamInlineReference = await resolveSarvamInlineReference(profile);
    } else {
      sarvamRegistration = await ensureSarvamRegistration({
        ownerId: input.ownerId,
        profile,
        consent: input.request.sarvamExternalConsent === true,
        createRawVoice: input.request.sarvamCreateRawVoice === true,
        signal: input.signal,
      });
    }
  }
  const cacheKey = voiceComparisonCacheKey({
    profile,
    request: input.request,
    synthesisText,
    sarvamRegistration,
    sarvamInlineReference,
  });
  const cached = input.request.bypassCache
    ? null
    : await readVoiceComparisonCache(input.ownerId, cacheKey);
  if (cached) {
    log.info('voice comparison preview cache hit', {
      provider: input.request.providerId,
      language: input.request.language,
      outputCodec: cached.outputCodec,
      processingMode: cached.processingMode,
      referenceProvenance: cached.referenceProvenance,
      providerRequestId: cached.providerRequestId,
      conditioningMode: cached.conditioningMode,
      generationConfig: cached.generationConfig,
      cache: 'hit',
      sahayaAudioProcessingApplied:
        input.request.providerId !== 'sarvam' && input.request.providerId !== 'ming3-tts',
    });
    return cached;
  }

  const externalConfig =
    input.request.providerId === 'sarvam'
      ? getSarvamVoiceCloningConfig()
      : input.request.providerId === 'bodhan'
        ? getBodhanTtsConfig()
        : input.request.providerId === 'ming3-tts'
          ? getMing3TtsPreviewServiceConfig()
          : null;
  return runControlledVoicePreview({
    providerId: input.request.providerId,
    requestKey: `voice-preview:${input.ownerId}:${cacheKey}`,
    concurrency: externalConfig?.maxConcurrency ?? 1,
    task: async () => {
      const secondCached = input.request.bypassCache
        ? null
        : await readVoiceComparisonCache(input.ownerId, cacheKey);
      if (secondCached) return secondCached;
      const startedAt = Date.now();
      const generated = await generateProviderAudio({
        profile,
        request: { ...input.request, text: synthesisText },
        sarvamRegistration,
        sarvamInlineReference,
        signal: input.signal,
        preserveTextChunks: input.preserveTextChunks,
      });
      const metadata = readWavMetadata(generated.audio);
      const generatedAt = new Date().toISOString();
      const result: VoiceComparisonPreviewResult = {
        profileId: profile.id,
        providerId: input.request.providerId,
        providerName: capability.name,
        voiceType: capability.voiceType,
        language: input.request.language,
        ...(input.request.voice ? { voice: input.request.voice } : {}),
        ...(input.request.style ? { style: input.request.style } : {}),
        audio: {
          format: 'wav',
          base64: Buffer.from(generated.audio).toString('base64'),
          createdAt: generatedAt,
        },
        durationSeconds: generated.durationSeconds ?? metadata.durationSeconds,
        generationLatencyMs: Date.now() - startedAt,
        generatedAt,
        cached: false,
        cacheKey,
        processingMode:
          input.request.providerId === 'sarvam'
            ? 'raw-provider-output'
            : input.request.providerId === 'ming3-tts'
              ? 'model-native-output'
              : 'standard',
        outputCodec: 'wav',
        ...(generated.requestId ? { providerRequestId: generated.requestId } : {}),
        ...(input.request.providerId === 'sarvam' && (sarvamRegistration || sarvamInlineReference)
          ? {
              referenceProvenance:
                sarvamInlineReference?.provenance ??
                sarvamRegistration?.referenceProvenance ??
                'processed-reference',
            }
          : input.request.providerId === 'ming3-tts'
            ? {
                referenceProvenance: generated.referenceProvenance ?? ('unknown' as const),
              }
            : {}),
        ...(generated.referenceTransformation
          ? { referenceTransformation: generated.referenceTransformation }
          : {}),
        ...(generated.conditioningMode ? { conditioningMode: generated.conditioningMode } : {}),
        ...(generated.generationConfig ? { generationConfig: generated.generationConfig } : {}),
        chunked: generated.chunked,
        request: {
          text: synthesisText,
          language: input.request.language,
          ...(input.request.voice ? { voice: input.request.voice } : {}),
          ...(input.request.style ? { style: input.request.style } : {}),
        },
      };
      log.info('voice comparison preview generated', {
        provider: input.request.providerId,
        language: input.request.language,
        outputCodec: result.outputCodec,
        processingMode: result.processingMode,
        referenceProvenance: result.referenceProvenance,
        durationMs: Math.round(result.durationSeconds * 1000),
        generationLatencyMs: result.generationLatencyMs,
        providerRequestId: result.providerRequestId,
        conditioningMode: result.conditioningMode,
        generationConfig: result.generationConfig,
        cache: 'miss',
        chunked: result.chunked,
        sahayaAudioProcessingApplied:
          input.request.providerId !== 'sarvam' && input.request.providerId !== 'ming3-tts',
      });
      await writeVoiceComparisonCache(input.ownerId, result);
      return result;
    },
  });
}
