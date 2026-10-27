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
import { concatenatePcmWav, readWavMetadata, splitSpeechText } from '@/lib/voice-comparison/audio';
import { BodhanIndicSpeakPreviewProvider } from '@/lib/voice-comparison/providers/bodhan';
import { Ming3TtsPreviewProvider } from '@/lib/voice-comparison/providers/ming3';
import {
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

const SARVAM_CONSENT_VERSION = 'sarvam-external-voice-raw-v2';
const SARVAM_RAW_PROCESSING_MODE = 'raw-provider-output-v1';
const MING3_PROCESSING_MODE = 'official-model-runtime-v1';
const log = createLogger('VoiceComparison');

function mingReference(profile: VoiceProfile): {
  key: string;
  provenance: 'original-upload' | 'processed-reference';
} | null {
  const originalMime = profile.originalRecording?.mimeType.toLowerCase().split(';', 1)[0];
  if (
    profile.originalRecording &&
    originalMime &&
    ['audio/wav', 'audio/x-wav', 'audio/flac', 'audio/ogg', 'audio/opus'].includes(originalMime)
  ) {
    return { key: profile.originalRecording.key, provenance: 'original-upload' };
  }
  return profile.referenceAudioKey
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
    available =
      referenceReady && profileProvider === 'chatterbox' && Boolean(profile.providerReferenceId);
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
    configured = externalVoiceProviderConfigured(getSarvamVoiceCloningConfig());
    const registration = validSarvamRegistration(profile);
    const rawReferenceAvailable = Boolean(
      profile.originalRecording && sarvamReferenceUploadType(profile.originalRecording.mimeType),
    );
    available =
      configured &&
      Boolean(referenceLanguage) &&
      (Boolean(registration) || (referenceReady && rawReferenceAvailable));
    unavailableReason = !configured
      ? 'Not configured'
      : available
        ? undefined
        : !referenceReady
          ? 'A ready Teaching Voice recording is required.'
          : profile.originalRecording
            ? 'The exact original recording format is not supported by Sarvam AI. Sahaya will not transcode it.'
            : 'The original recording was not retained. Re-enroll the Teaching Voice before creating a raw Sarvam clone.';
  } else {
    configured = externalVoiceProviderConfigured(getBodhanTtsConfig());
    available = configured;
    unavailableReason = configured ? undefined : 'Not configured';
  }

  return {
    ...capability,
    configured,
    available,
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
}): string {
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
          ? MING3_PROCESSING_MODE
          : 'standard-v1',
    outputCodec:
      input.request.providerId === 'sarvam' || input.request.providerId === 'ming3-tts'
        ? 'wav'
        : null,
    providerGenerationParameters:
      input.request.providerId === 'sarvam'
        ? { enableVad: false, enableTextNormalization: false, enableQc: false }
        : input.request.providerId === 'ming3-tts'
          ? {
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
  signal?: AbortSignal;
}): Promise<{
  audio: Uint8Array;
  durationSeconds?: number;
  requestId?: string;
  referenceTransformation?: string;
  chunked: boolean;
}> {
  const { profile, request } = input;
  if (request.providerId === 'sarvam') {
    if (!input.sarvamRegistration) throw new TeachingVoiceError('Sarvam AI voice is not ready.');
    if (!request.text.trim()) throw new TeachingVoiceError('Enter text to compare.');
    if (request.text.length > 1000) {
      throw new TeachingVoiceError(
        'Raw Sarvam comparison is limited to 1000 characters so the result remains one untouched provider response.',
      );
    }
    const provider = new SarvamVoiceCloningPreviewProvider();
    const result = await provider.synthesize({
      voiceId: input.sarvamRegistration.voiceId,
      text: request.text,
      language: request.language,
      signal: input.signal,
    });
    return {
      audio: result.audio,
      durationSeconds: result.durationSeconds,
      ...(result.requestId ? { requestId: result.requestId } : {}),
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
    const reference = mingReference(profile);
    if (!reference || !profile.referenceText?.trim()) {
      throw new TeachingVoiceError(
        'Ming 3.0 TTS requires the saved English reference audio and transcript.',
      );
    }
    const provider = new Ming3TtsPreviewProvider();
    const serviceProfileId = mingServiceProfileId(profile);
    await provider.registerProfile(
      {
        profileId: serviceProfileId,
        referenceAudioPath: resolveReferenceAudioPath(reference.key),
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
    return {
      audio: result.audio,
      durationSeconds: result.durationSeconds,
      ...(result.requestId ? { requestId: result.requestId } : {}),
      ...(result.referenceTransformation
        ? { referenceTransformation: result.referenceTransformation }
        : {}),
      chunked: false,
    };
  }
  const chunks = splitSpeechText(request.text, request.providerId === 'bodhan' ? 700 : 1000);
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
    const providerReferenceId = profile.providerReferenceId;
    if (!providerReferenceId)
      throw new TeachingVoiceError('Teaching Voice registration was not found.');
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
}): Promise<VoiceComparisonPreviewResult> {
  const profile = await requireOwnedReadyProfile(input.ownerId, input.request.profileId);
  validateRequest(profile, input.request);
  const capability = getVoiceComparisonProvider(input.request.providerId);
  const synthesisText =
    input.request.providerId === 'sarvam' || input.request.providerId === 'ming3-tts'
      ? input.request.text
      : input.request.text.trim();
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
    splitSpeechText(synthesisText, input.request.providerId === 'bodhan' ? 700 : 1000);
  }
  const sarvamRegistration =
    input.request.providerId === 'sarvam'
      ? await ensureSarvamRegistration({
          ownerId: input.ownerId,
          profile,
          consent: input.request.sarvamExternalConsent === true,
          createRawVoice: input.request.sarvamCreateRawVoice === true,
          signal: input.signal,
        })
      : undefined;
  const cacheKey = voiceComparisonCacheKey({
    profile,
    request: input.request,
    synthesisText,
    sarvamRegistration,
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
        signal: input.signal,
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
        ...(input.request.providerId === 'sarvam' && sarvamRegistration
          ? {
              referenceProvenance: sarvamRegistration.referenceProvenance ?? 'processed-reference',
            }
          : input.request.providerId === 'ming3-tts'
            ? {
                referenceProvenance: mingReference(profile)?.provenance ?? ('unknown' as const),
              }
            : {}),
        ...(generated.referenceTransformation
          ? { referenceTransformation: generated.referenceTransformation }
          : {}),
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
