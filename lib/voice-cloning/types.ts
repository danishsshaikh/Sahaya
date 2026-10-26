export type VoiceProfileStatus = 'processing' | 'preview-ready' | 'ready' | 'failed' | 'deleted';
export type ChatterboxModelVariant = 'v2' | 'v3';
export type VoiceSettingsPreset = 'natural' | 'accent-test' | 'expressive' | 'custom';
export type VoiceEnhancementMode = 'standard' | 'resemble-enhance';
export type VoicePreviewModel = 'chatterbox-v3' | 'qwen3-tts-1.7b-base';
export type Qwen3TtsCloneMode = 'speaker-embedding' | 'icl';
export type TeachingVoiceEngine = 'chatterbox' | 'qwen3-tts' | 'indicf5';

export const VOICE_PREVIEW_MODELS = ['chatterbox-v3', 'qwen3-tts-1.7b-base'] as const;
export const QWEN3_TTS_CLONE_MODES = ['speaker-embedding', 'icl'] as const;

export const CHATTERBOX_MODEL_VARIANTS = ['v2', 'v3'] as const;
export const DEFAULT_CHATTERBOX_MODEL_VARIANT: ChatterboxModelVariant = 'v3';
export const LEGACY_CHATTERBOX_MODEL_VARIANT: ChatterboxModelVariant = 'v2';

export interface VoiceGenerationSettings {
  exaggeration: number;
  cfgWeight: number;
  temperature: number;
  topP: number;
  minP: number;
  repetitionPenalty: number;
}

export const RECOMMENDED_VOICE_GENERATION_SETTINGS: VoiceGenerationSettings = {
  exaggeration: 0.5,
  cfgWeight: 0.3,
  temperature: 0.85,
  topP: 0.95,
  minP: 0.05,
  repetitionPenalty: 2,
};

export const VOICE_GENERATION_SETTING_RANGES: Record<
  keyof VoiceGenerationSettings,
  { min: number; max: number; step: number; recommended: number }
> = {
  exaggeration: { min: 0.25, max: 2, step: 0.05, recommended: 0.5 },
  cfgWeight: { min: 0, max: 1, step: 0.05, recommended: 0.3 },
  temperature: { min: 0.2, max: 1.5, step: 0.05, recommended: 0.85 },
  topP: { min: 0.1, max: 1, step: 0.05, recommended: 0.95 },
  minP: { min: 0, max: 0.2, step: 0.01, recommended: 0.05 },
  repetitionPenalty: { min: 1, max: 3, step: 0.05, recommended: 2 },
};

export const VOICE_SETTINGS_PRESETS: Record<
  Exclude<VoiceSettingsPreset, 'custom'>,
  VoiceGenerationSettings
> = {
  natural: RECOMMENDED_VOICE_GENERATION_SETTINGS,
  'accent-test': { ...RECOMMENDED_VOICE_GENERATION_SETTINGS, cfgWeight: 0 },
  expressive: { ...RECOMMENDED_VOICE_GENERATION_SETTINGS, exaggeration: 0.75 },
};

export interface VoiceConfiguration {
  modelVariant?: ChatterboxModelVariant;
  /** Chatterbox generation language. This is independent of the recorded reference language. */
  languageId: string;
  generationSettings?: VoiceGenerationSettings;
  /** Optional post-processing preference. Legacy profiles resolve to standard. */
  enhancementMode?: VoiceEnhancementMode;
}

export type VoicePreviewTextLanguage = 'en' | 'hi';

export interface VoicePreviewConfiguration extends VoiceConfiguration {
  previewTextLanguageId?: VoicePreviewTextLanguage;
}

export interface VoicePreview {
  format: string;
  base64: string;
  createdAt: string;
}

export interface VoicePreviewComparison {
  original: VoicePreview;
  enhanced?: VoicePreview;
  enhancementError?: string;
}

export interface VoiceModelPreviewResult {
  previewModel: VoicePreviewModel;
  qwenCloneMode?: Qwen3TtsCloneMode;
  enhancementMode: VoiceEnhancementMode;
  preview: VoicePreview;
  comparison: VoicePreviewComparison;
}

export interface Qwen3TtsPreviewCache {
  cacheKey: string;
  result: VoiceModelPreviewResult;
}

export interface SarvamVoiceRegistration {
  voiceId: string;
  consentTimestamp: string;
  consentVersion: string;
  createdAt: string;
  referenceAudioKey: string;
  profileVersion: number;
  referenceLanguage: string;
  providerReferenceText?: string;
}

export interface VoiceDraftPreview {
  config: VoicePreviewConfiguration;
  preview: VoicePreview;
  comparison?: VoicePreviewComparison;
}

export interface VoiceEnrollmentQualitySummary {
  severity: 'pass' | 'warning';
  warnings: string[];
}

export interface VoiceProfile {
  id: string;
  ownerId: string;
  displayName: string;
  provider: string;
  /** Language spoken in the retained reference recording. */
  language: string;
  status: VoiceProfileStatus;
  createdAt: string;
  updatedAt: string;
  consentTimestamp: string;
  consentVersion: string;
  referenceAudioKey?: string;
  referenceText?: string;
  providerReferenceId?: string;
  modelVariant?: ChatterboxModelVariant;
  languageId?: string;
  generationSettings?: VoiceGenerationSettings;
  enhancementMode?: VoiceEnhancementMode;
  activeEngine?: TeachingVoiceEngine;
  qwenEnhancementMode?: VoiceEnhancementMode;
  qwenPreviewCache?: Qwen3TtsPreviewCache;
  sarvamVoice?: SarvamVoiceRegistration;
  replacesProfileId?: string;
  enrollmentAttemptId?: string;
  profileVersion: number;
  preview?: VoicePreview;
  previewComparison?: VoicePreviewComparison;
  previewTextLanguageId?: VoicePreviewTextLanguage;
  previewVariants?: Partial<Record<ChatterboxModelVariant, VoicePreview>>;
  draftPreview?: VoiceDraftPreview;
  enrollmentQuality?: VoiceEnrollmentQualitySummary;
  failureReason?: string;
  failurePhase?: string;
}

export interface PublicVoiceProfile {
  id: string;
  displayName: string;
  provider: string;
  /** Language spoken in the retained reference recording. */
  language: string;
  status: VoiceProfileStatus;
  createdAt: string;
  updatedAt: string;
  consentTimestamp: string;
  consentVersion: string;
  modelVariant?: ChatterboxModelVariant;
  languageId: string;
  generationSettings?: VoiceGenerationSettings;
  enhancementMode?: VoiceEnhancementMode;
  activeEngine: TeachingVoiceEngine;
  qwenEnhancementMode?: VoiceEnhancementMode;
  qwenPreview?: VoiceModelPreviewResult;
  sarvamVoice?: {
    ready: true;
    consentTimestamp: string;
    createdAt: string;
  };
  profileVersion: number;
  preview?: VoicePreview;
  previewComparison?: VoicePreviewComparison;
  previewTextLanguageId?: VoicePreviewTextLanguage;
  previewVariants?: Partial<Record<ChatterboxModelVariant, VoicePreview>>;
  draftPreview?: VoiceDraftPreview;
  enrollmentQuality?: VoiceEnrollmentQualitySummary;
}

export interface VoiceCloningProvider {
  healthCheck(): Promise<{ ok: boolean; provider: string; modelLoaded?: boolean }>;
  createProfile(input: {
    profileId: string;
    referenceAudioKey: string;
    referenceText?: string;
    language: string;
    modelVariant?: ChatterboxModelVariant;
    generationSettings?: VoiceGenerationSettings;
  }): Promise<{
    providerReferenceId: string;
  }>;
  generatePreview(input: {
    providerReferenceId: string;
    text: string;
    language: string;
    modelVariant?: ChatterboxModelVariant;
    generationSettings?: VoiceGenerationSettings;
  }): Promise<{ audio: Uint8Array; format: string }>;
  synthesize(input: {
    providerReferenceId: string;
    text: string;
    language: string;
    modelVariant?: ChatterboxModelVariant;
    generationSettings?: VoiceGenerationSettings;
  }): Promise<{ audio: Uint8Array; format: string }>;
  deleteProfile(input: { providerReferenceId: string }): Promise<void>;
}

export function isChatterboxModelVariant(value: unknown): value is ChatterboxModelVariant {
  return value === 'v2' || value === 'v3';
}

export function isVoicePreviewModel(value: unknown): value is VoicePreviewModel {
  return VOICE_PREVIEW_MODELS.includes(value as VoicePreviewModel);
}

export function isQwen3TtsCloneMode(value: unknown): value is Qwen3TtsCloneMode {
  return QWEN3_TTS_CLONE_MODES.includes(value as Qwen3TtsCloneMode);
}

export function resolveVoiceProfileProvider(profile: { provider?: string }): string {
  // Profiles enrolled during the retired Qwen3 period retain their reference WAV.
  // Resolve them to Chatterbox for new synthesis while preserving the stored
  // metadata until a successful Chatterbox registration migrates the profile.
  if (profile.provider === undefined || profile.provider === 'qwen3') return 'chatterbox';
  return profile.provider;
}

export function resolveVoiceProfileActiveEngine(profile: {
  provider?: string;
  activeEngine?: string | null;
}): TeachingVoiceEngine {
  const provider = resolveVoiceProfileProvider(profile);
  if (provider === 'indicf5') return 'indicf5';
  return profile.activeEngine === 'qwen3-tts' ? 'qwen3-tts' : 'chatterbox';
}

export function resolveVoiceProfileQwenEnhancementMode(profile: {
  qwenEnhancementMode?: string | null;
}): VoiceEnhancementMode {
  return isVoiceEnhancementMode(profile.qwenEnhancementMode)
    ? profile.qwenEnhancementMode
    : 'standard';
}

export class TeachingVoiceError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'TeachingVoiceError';
  }
}

export type TeachingVoiceProviderOperation =
  | 'provider_registration'
  | 'preview_generation'
  | 'synthesis'
  | 'profile_deletion'
  | 'health_check';

export class TeachingVoiceProviderOperationError extends TeachingVoiceError {
  constructor(
    message: string,
    status: number,
    readonly metadata: {
      provider: 'chatterbox' | 'indicf5' | 'qwen3-tts';
      endpoint: string;
      operation: TeachingVoiceProviderOperation;
      providerStatus?: number;
      providerContentType?: string;
      providerDetail?: string;
    },
  ) {
    super(message, status);
    this.name = 'TeachingVoiceProviderOperationError';
  }
}

export function resolveVoiceProfileModelVariant(profile: {
  provider?: string | null;
  modelVariant?: string | null;
}): ChatterboxModelVariant {
  if (profile.provider === 'qwen3' && !isChatterboxModelVariant(profile.modelVariant)) {
    return DEFAULT_CHATTERBOX_MODEL_VARIANT;
  }
  return isChatterboxModelVariant(profile.modelVariant)
    ? profile.modelVariant
    : LEGACY_CHATTERBOX_MODEL_VARIANT;
}

export function resolveVoiceProfileLanguageId(profile: {
  languageId?: string | null;
  language?: string | null;
}): string {
  return profile.languageId || profile.language || 'en';
}

export function resolveVoiceProfileGenerationSettings(profile: {
  generationSettings?: Partial<VoiceGenerationSettings> | null;
}): VoiceGenerationSettings {
  return validateVoiceGenerationSettings(profile.generationSettings ?? undefined);
}

export function isVoiceEnhancementMode(value: unknown): value is VoiceEnhancementMode {
  return value === 'standard' || value === 'resemble-enhance';
}

export function resolveVoiceProfileEnhancementMode(profile: {
  enhancementMode?: string | null;
}): VoiceEnhancementMode {
  return isVoiceEnhancementMode(profile.enhancementMode) ? profile.enhancementMode : 'standard';
}

export function resolveNewVoiceProfileModelVariant(value: unknown): ChatterboxModelVariant | null {
  if (value === undefined || value === null || value === '')
    return DEFAULT_CHATTERBOX_MODEL_VARIANT;
  return isChatterboxModelVariant(value) ? value : null;
}

function validateNumberSetting(key: keyof VoiceGenerationSettings, value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const range = VOICE_GENERATION_SETTING_RANGES[key];
  if (value < range.min || value > range.max) return null;
  return value;
}

export function validateVoiceGenerationSettings(value: unknown): VoiceGenerationSettings {
  if (value === undefined || value === null) return { ...RECOMMENDED_VOICE_GENERATION_SETTINGS };
  if (
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    throw new Error('Invalid voice generation settings');
  }
  const input = value as Partial<Record<keyof VoiceGenerationSettings, unknown>>;
  const allowedKeys = new Set(Object.keys(RECOMMENDED_VOICE_GENERATION_SETTINGS));
  for (const key of Object.keys(input)) {
    if (!allowedKeys.has(key)) throw new Error(`Unknown voice generation setting: ${key}`);
  }
  const next = { ...RECOMMENDED_VOICE_GENERATION_SETTINGS };
  for (const key of Object.keys(RECOMMENDED_VOICE_GENERATION_SETTINGS) as Array<
    keyof VoiceGenerationSettings
  >) {
    if (input[key] === undefined) continue;
    const validated = validateNumberSetting(key, input[key]);
    if (validated === null) throw new Error(`Invalid voice generation setting: ${key}`);
    next[key] = validated;
  }
  return next;
}

export function voiceGenerationPresetForSettings(
  settings: VoiceGenerationSettings,
): VoiceSettingsPreset {
  for (const [preset, presetSettings] of Object.entries(VOICE_SETTINGS_PRESETS)) {
    const matches = Object.keys(RECOMMENDED_VOICE_GENERATION_SETTINGS).every((key) => {
      const typedKey = key as keyof VoiceGenerationSettings;
      return Math.abs(settings[typedKey] - presetSettings[typedKey]) < 0.000001;
    });
    if (matches) return preset as VoiceSettingsPreset;
  }
  return 'custom';
}

export class VoiceProviderProfileNotFoundError extends Error {
  readonly providerReferenceId?: string;

  constructor(message: string, options: { providerReferenceId?: string; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = 'VoiceProviderProfileNotFoundError';
    this.providerReferenceId = options.providerReferenceId;
  }
}

export function isVoiceProviderProfileNotFoundError(
  error: unknown,
): error is VoiceProviderProfileNotFoundError {
  return (
    error instanceof VoiceProviderProfileNotFoundError ||
    (typeof error === 'object' &&
      error !== null &&
      (error as { name?: string }).name === 'VoiceProviderProfileNotFoundError')
  );
}

export function toPublicVoiceProfile(profile: VoiceProfile | null): PublicVoiceProfile | null {
  if (!profile || profile.status === 'deleted') return null;
  const legacyQwenProfile = profile.provider === 'qwen3';
  return {
    id: profile.id,
    displayName: profile.displayName,
    provider: resolveVoiceProfileProvider(profile),
    language: profile.language,
    status: profile.status,
    activeEngine: resolveVoiceProfileActiveEngine(profile),
    ...(resolveVoiceProfileProvider(profile) === 'chatterbox'
      ? { qwenEnhancementMode: resolveVoiceProfileQwenEnhancementMode(profile) }
      : {}),
    languageId: resolveVoiceProfileLanguageId(profile),
    ...(resolveVoiceProfileProvider(profile) === 'chatterbox'
      ? {
          modelVariant: resolveVoiceProfileModelVariant(profile),
          generationSettings: resolveVoiceProfileGenerationSettings(profile),
          enhancementMode: resolveVoiceProfileEnhancementMode(profile),
        }
      : {}),
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
    consentTimestamp: profile.consentTimestamp,
    consentVersion: profile.consentVersion,
    profileVersion: profile.profileVersion,
    ...(!legacyQwenProfile && profile.preview ? { preview: profile.preview } : {}),
    ...(!legacyQwenProfile && profile.previewComparison
      ? { previewComparison: profile.previewComparison }
      : {}),
    ...(!legacyQwenProfile && profile.previewTextLanguageId
      ? { previewTextLanguageId: profile.previewTextLanguageId }
      : {}),
    ...(!legacyQwenProfile && profile.previewVariants
      ? { previewVariants: profile.previewVariants }
      : {}),
    ...(!legacyQwenProfile && profile.draftPreview ? { draftPreview: profile.draftPreview } : {}),
    ...(!legacyQwenProfile && profile.qwenPreviewCache
      ? { qwenPreview: profile.qwenPreviewCache.result }
      : {}),
    ...(!legacyQwenProfile && profile.sarvamVoice
      ? {
          sarvamVoice: {
            ready: true as const,
            consentTimestamp: profile.sarvamVoice.consentTimestamp,
            createdAt: profile.sarvamVoice.createdAt,
          },
        }
      : {}),
    ...(profile.enrollmentQuality ? { enrollmentQuality: profile.enrollmentQuality } : {}),
  };
}
