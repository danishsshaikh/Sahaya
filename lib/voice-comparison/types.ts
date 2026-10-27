import type { VoicePreview } from '@/lib/voice-cloning/types';

export const DEFAULT_VOICE_COMPARISON_TEXT =
  "Newton's first law states that an object remains at rest unless acted upon by an external force.";

export type VoiceComparisonProviderId =
  | 'chatterbox'
  | 'qwen3-tts'
  | 'sarvam'
  | 'bodhan'
  | 'indicf5';

export type VoiceComparisonCategory = 'voice-cloning' | 'preset-voices';
export type VoiceComparisonVoiceType = 'cloned' | 'preset';

export type VoiceComparisonLanguageCode =
  | 'as'
  | 'bn'
  | 'brx'
  | 'doi'
  | 'en'
  | 'gu'
  | 'hi'
  | 'kn'
  | 'kok'
  | 'ks'
  | 'mai'
  | 'ml'
  | 'mni'
  | 'mr'
  | 'ne'
  | 'or'
  | 'pa'
  | 'sa'
  | 'sat'
  | 'sd'
  | 'ta'
  | 'te'
  | 'ur';

export interface VoiceComparisonLanguage {
  code: VoiceComparisonLanguageCode;
  label: string;
}

export interface VoiceComparisonPresetVoice {
  id: string;
  name: string;
  recordedLanguage: VoiceComparisonLanguageCode;
  recordedLanguageLabel: string;
}

export interface VoiceComparisonProviderCapability {
  id: VoiceComparisonProviderId;
  name: string;
  category: VoiceComparisonCategory;
  voiceType: VoiceComparisonVoiceType;
  supportedLanguages: VoiceComparisonLanguageCode[];
  supportsCloning: boolean;
  supportsPresetVoices: boolean;
  supportsEnhancement: boolean;
  supportsClassroom: boolean;
  supportsPreview: boolean;
  experimental: boolean;
}

export interface VoiceComparisonProviderAvailability extends VoiceComparisonProviderCapability {
  configured: boolean;
  available: boolean;
  unavailableReason?: string;
  requiresExternalConsent?: boolean;
  externalVoiceReady?: boolean;
  externalConsentTimestamp?: string;
  sarvamReferenceProvenance?: 'original-upload' | 'processed-reference' | 'unknown';
  sarvamRawReferenceAvailable?: boolean;
  sarvamCanCreateRawClone?: boolean;
}

export interface VoiceComparisonPreviewRequest {
  profileId: string;
  providerId: VoiceComparisonProviderId;
  text: string;
  language: VoiceComparisonLanguageCode;
  voice?: string;
  style?: string;
  sarvamExternalConsent?: boolean;
  sarvamCreateRawVoice?: boolean;
  /** Explicit user action that requests a fresh synthesis instead of a cache lookup. */
  bypassCache?: boolean;
}

export interface VoiceComparisonPreviewResult {
  profileId?: string;
  providerId: VoiceComparisonProviderId;
  providerName: string;
  voiceType: VoiceComparisonVoiceType;
  language: VoiceComparisonLanguageCode;
  voice?: string;
  style?: string;
  audio: VoicePreview;
  durationSeconds: number;
  generationLatencyMs: number;
  generatedAt: string;
  cached: boolean;
  cacheKey: string;
  processingMode?: 'raw-provider-output' | 'standard';
  outputCodec?: string;
  providerRequestId?: string;
  referenceProvenance?: 'original-upload' | 'processed-reference' | 'unknown';
  chunked?: boolean;
  /** Owner-scoped request metadata used to restore the matching saved preview. */
  request?: {
    text: string;
    language: VoiceComparisonLanguageCode;
    voice?: string;
    style?: string;
  };
}

export interface VoiceComparisonBootstrap {
  providers: VoiceComparisonProviderAvailability[];
  languages: VoiceComparisonLanguage[];
  bodhanVoices: VoiceComparisonPresetVoice[];
  bodhanStyles: string[];
  savedPreviews: VoiceComparisonPreviewResult[];
}
