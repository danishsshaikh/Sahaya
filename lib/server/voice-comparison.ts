import { promises as fs } from 'node:fs';
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
import { SarvamVoiceCloningPreviewProvider } from '@/lib/voice-comparison/providers/sarvam';
import type {
  VoiceComparisonBootstrap,
  VoiceComparisonLanguageCode,
  VoiceComparisonPreviewRequest,
  VoiceComparisonPreviewResult,
  VoiceComparisonProviderAvailability,
  VoiceComparisonProviderId,
} from '@/lib/voice-comparison/types';
import {
  externalVoiceProviderConfigured,
  getBodhanTtsConfig,
  getSarvamVoiceCloningConfig,
} from '@/lib/server/voice-comparison-config';
import {
  createVoiceComparisonCacheKey,
  readVoiceComparisonCache,
  writeVoiceComparisonCache,
} from '@/lib/server/voice-comparison-cache';
import { runControlledVoicePreview } from '@/lib/server/voice-comparison-control';
import { isQwen3TtsPreviewEnabled } from '@/lib/voice-cloning/config';
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

const SARVAM_CONSENT_VERSION = 'sarvam-external-voice-v1';

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
  } else if (providerId === 'indicf5') {
    available =
      referenceReady &&
      profileProvider === 'indicf5' &&
      (referenceLanguage === 'hi' || referenceLanguage === 'mr') &&
      Boolean(profile.providerReferenceId);
    unavailableReason = available ? undefined : 'Requires a ready Hindi or Marathi IndicF5 voice.';
  } else if (providerId === 'sarvam') {
    configured = externalVoiceProviderConfigured(getSarvamVoiceCloningConfig());
    available = configured && referenceReady && Boolean(referenceLanguage);
    unavailableReason = !configured
      ? 'Not configured'
      : available
        ? undefined
        : 'A ready Teaching Voice recording is required.';
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
          ...(profile.sarvamVoice?.consentTimestamp
            ? { externalConsentTimestamp: profile.sarvamVoice.consentTimestamp }
            : {}),
        }
      : {}),
  };
}

export function getVoiceComparisonBootstrap(profile: VoiceProfile): VoiceComparisonBootstrap {
  return {
    providers: VOICE_COMPARISON_PROVIDERS.map(({ id }) => voiceProviderAvailability(profile, id)),
    languages: VOICE_COMPARISON_LANGUAGES,
    bodhanVoices: BODHAN_VOICES,
    bodhanStyles: [...BODHAN_STYLES],
  };
}

function validSarvamRegistration(profile: VoiceProfile): SarvamVoiceRegistration | null {
  const registration = profile.sarvamVoice;
  if (
    !registration ||
    !profile.referenceAudioKey ||
    registration.referenceAudioKey !== profile.referenceAudioKey ||
    registration.profileVersion !== profile.profileVersion
  ) {
    return null;
  }
  return registration;
}

async function ensureSarvamRegistration(input: {
  ownerId: string;
  profile: VoiceProfile;
  consent: boolean;
  signal?: AbortSignal;
}): Promise<SarvamVoiceRegistration> {
  const current = validSarvamRegistration(input.profile);
  if (current) return current;
  if (!input.consent) {
    throw new TeachingVoiceError('Consent is required before sending your recording to Sarvam AI.');
  }
  const config = getSarvamVoiceCloningConfig();
  return runControlledVoicePreview({
    providerId: 'sarvam',
    requestKey: `sarvam-registration:${input.ownerId}:${input.profile.id}:${input.profile.profileVersion}`,
    concurrency: config.maxConcurrency,
    task: async () => {
      const latest = await requireOwnedReadyProfile(input.ownerId, input.profile.id);
      const existing = validSarvamRegistration(latest);
      if (existing) return existing;
      const referenceAudioKey = latest.referenceAudioKey;
      const referenceLanguage = resolveVoiceProfileReferenceLanguage(latest);
      if (!referenceAudioKey || !(await referenceAudioExists(referenceAudioKey))) {
        throw new TeachingVoiceError('Teaching Voice reference audio was not found.', 404);
      }
      if (!referenceLanguage) {
        throw new TeachingVoiceError('The Teaching Voice reference language is unsupported.');
      }
      const provider = new SarvamVoiceCloningPreviewProvider(config);
      const created = await provider.createVoice({
        profileId: latest.id,
        referenceAudio: new Uint8Array(
          await fs.readFile(resolveReferenceAudioPath(referenceAudioKey)),
        ),
        referenceLanguage: referenceLanguage as VoiceComparisonLanguageCode,
        signal: input.signal,
      });
      const afterCreation = await requireOwnedReadyProfile(input.ownerId, input.profile.id);
      if (
        afterCreation.profileVersion !== latest.profileVersion ||
        afterCreation.referenceAudioKey !== referenceAudioKey
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
        referenceAudioKey,
        profileVersion: afterCreation.profileVersion,
        referenceLanguage,
        ...(created.referenceText ? { providerReferenceText: created.referenceText } : {}),
      };
      await writeVoiceProfile({ ...afterCreation, sarvamVoice: registration, updatedAt: now });
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
}): Promise<Uint8Array> {
  const { profile, request } = input;
  const chunks = splitSpeechText(request.text, request.providerId === 'bodhan' ? 700 : 1000);
  const audioParts: Uint8Array[] = [];
  if (request.providerId === 'sarvam') {
    if (!input.sarvamRegistration) throw new TeachingVoiceError('Sarvam AI voice is not ready.');
    const provider = new SarvamVoiceCloningPreviewProvider();
    for (const text of chunks) {
      audioParts.push(
        (
          await provider.synthesize({
            voiceId: input.sarvamRegistration.voiceId,
            text,
            language: request.language,
            signal: input.signal,
          })
        ).audio,
      );
    }
  } else if (request.providerId === 'bodhan') {
    const provider = new BodhanIndicSpeakPreviewProvider();
    for (const text of chunks) {
      audioParts.push(
        (
          await provider.synthesize({
            text,
            language: request.language,
            voice: request.voice!,
            style: request.style,
            signal: input.signal,
          })
        ).audio,
      );
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
  return concatenatePcmWav(audioParts);
}

export async function generateVoiceComparisonPreview(input: {
  ownerId: string;
  request: VoiceComparisonPreviewRequest;
  signal?: AbortSignal;
}): Promise<VoiceComparisonPreviewResult> {
  const profile = await requireOwnedReadyProfile(input.ownerId, input.request.profileId);
  validateRequest(profile, input.request);
  const sarvamRegistration =
    input.request.providerId === 'sarvam'
      ? await ensureSarvamRegistration({
          ownerId: input.ownerId,
          profile,
          consent: input.request.sarvamExternalConsent === true,
          signal: input.signal,
        })
      : undefined;
  const capability = getVoiceComparisonProvider(input.request.providerId);
  const normalizedText = input.request.text.trim();
  splitSpeechText(normalizedText, input.request.providerId === 'bodhan' ? 700 : 1000);
  const cacheKey = createVoiceComparisonCacheKey({
    ownerId: input.ownerId,
    profileId: profile.id,
    profileVersion: profile.profileVersion,
    referenceAudioKey: profile.referenceAudioKey ?? null,
    providerId: input.request.providerId,
    language: input.request.language,
    text: normalizedText,
    voice: input.request.voice ?? null,
    style: input.request.style ?? null,
    sarvamVoiceId: sarvamRegistration?.voiceId ?? null,
    modelVariant:
      input.request.providerId === 'chatterbox' ? resolveVoiceProfileModelVariant(profile) : null,
    generationSettings:
      input.request.providerId === 'chatterbox'
        ? resolveVoiceProfileGenerationSettings(profile)
        : null,
    qwenCloneMode: input.request.providerId === 'qwen3-tts' ? 'speaker-embedding' : null,
  });
  const cached = await readVoiceComparisonCache(input.ownerId, cacheKey);
  if (cached) return cached;

  const externalConfig =
    input.request.providerId === 'sarvam'
      ? getSarvamVoiceCloningConfig()
      : input.request.providerId === 'bodhan'
        ? getBodhanTtsConfig()
        : null;
  return runControlledVoicePreview({
    providerId: input.request.providerId,
    requestKey: `voice-preview:${input.ownerId}:${cacheKey}`,
    concurrency: externalConfig?.maxConcurrency ?? 1,
    task: async () => {
      const secondCached = await readVoiceComparisonCache(input.ownerId, cacheKey);
      if (secondCached) return secondCached;
      const startedAt = Date.now();
      const audio = await generateProviderAudio({
        profile,
        request: { ...input.request, text: normalizedText },
        sarvamRegistration,
        signal: input.signal,
      });
      const metadata = readWavMetadata(audio);
      const generatedAt = new Date().toISOString();
      const result: VoiceComparisonPreviewResult = {
        providerId: input.request.providerId,
        providerName: capability.name,
        voiceType: capability.voiceType,
        language: input.request.language,
        ...(input.request.voice ? { voice: input.request.voice } : {}),
        ...(input.request.style ? { style: input.request.style } : {}),
        audio: {
          format: 'wav',
          base64: Buffer.from(audio).toString('base64'),
          createdAt: generatedAt,
        },
        durationSeconds: metadata.durationSeconds,
        generationLatencyMs: Date.now() - startedAt,
        generatedAt,
        cached: false,
        cacheKey,
      };
      await writeVoiceComparisonCache(input.ownerId, result);
      return result;
    },
  });
}
