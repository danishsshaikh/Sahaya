import { tryResolveTTSLanguageCode } from '@/lib/audio/tts-language';
import {
  resolveVoiceProfileLanguageId,
  resolveVoiceProfileProvider,
  TeachingVoiceError,
  type VoiceProfile,
} from './types';

export type TeachingVoiceLanguage = 'en' | 'hi' | 'mr';
export const CHATTERBOX_FACULTY_SYNTHESIS_LANGUAGE_IDS = ['en', 'hi'] as const;
export type ChatterboxFacultySynthesisLanguage =
  (typeof CHATTERBOX_FACULTY_SYNTHESIS_LANGUAGE_IDS)[number];

export function isChatterboxFacultySynthesisLanguage(
  value: unknown,
): value is ChatterboxFacultySynthesisLanguage {
  return value === 'en' || value === 'hi';
}

/** Normalize an API language identifier without interpreting prose instructions. */
export function normalizeTeachingVoiceLanguageId(
  value?: string | null,
): TeachingVoiceLanguage | null {
  const input = value?.trim().toLowerCase();
  if (!input) return null;
  const direct = /^(en|hi|mr)(?:[-_][a-z0-9]+)*$/.exec(input);
  return (direct?.[1] as TeachingVoiceLanguage | undefined) ?? null;
}

export function resolveTeachingVoiceLanguage(value?: string | null): string | null {
  const input = value?.trim().toLowerCase();
  if (!input) return null;
  const direct = normalizeTeachingVoiceLanguageId(input);
  if (direct) return direct;
  const matches = [
    ['en', new RegExp('(?<![\\p{L}\\p{M}\\p{N}_])english(?![\\p{L}\\p{M}\\p{N}_])', 'u')],
    [
      'hi',
      new RegExp('(?<![\\p{L}\\p{M}\\p{N}_])(?:hindi|हिंदी|हिन्दी)(?![\\p{L}\\p{M}\\p{N}_])', 'u'),
    ],
    ['mr', new RegExp('(?<![\\p{L}\\p{M}\\p{N}_])(?:marathi|मराठी)(?![\\p{L}\\p{M}\\p{N}_])', 'u')],
  ] as const;
  const languages = matches.filter(([, pattern]) => pattern.test(input));
  if (languages.length > 1) return null;
  return languages[0]?.[0] ?? tryResolveTTSLanguageCode(input);
}

export function newTeachingVoiceProvider(language: string): 'chatterbox' | 'indicf5' {
  if (language === 'en') return 'chatterbox';
  if (language === 'hi' || language === 'mr') return 'indicf5';
  throw new TeachingVoiceError(
    'New Teaching Voice enrollment supports English, Hindi and Marathi.',
  );
}

export function resolveVoiceProfileReferenceLanguage(profile: VoiceProfile): string | null {
  return resolveTeachingVoiceLanguage(profile.language || profile.languageId);
}

export function validateTeachingVoiceLanguage(profile: VoiceProfile, requested?: string): string {
  const provider = resolveVoiceProfileProvider(profile);
  const referenceLanguage = resolveVoiceProfileReferenceLanguage(profile);
  const requestedLanguage = resolveTeachingVoiceLanguage(requested);
  const savedSynthesisLanguage = resolveTeachingVoiceLanguage(
    resolveVoiceProfileLanguageId(profile),
  );
  if (!referenceLanguage) {
    throw new TeachingVoiceError('The voice profile reference language is unsupported.');
  }

  if (provider === 'chatterbox') {
    if (referenceLanguage !== 'en') {
      throw new TeachingVoiceError('Chatterbox Teaching Voice requires an English reference.');
    }
    const synthesisLanguage = requested ? requestedLanguage : savedSynthesisLanguage;
    if (!synthesisLanguage) {
      throw new TeachingVoiceError('A supported Chatterbox synthesis language is required.');
    }
    if (!isChatterboxFacultySynthesisLanguage(synthesisLanguage)) {
      throw new TeachingVoiceError(
        'Sahaya Chatterbox Teaching Voice supports English or Hindi synthesis.',
      );
    }
    return synthesisLanguage;
  }

  if (!requested || !requestedLanguage) {
    throw new TeachingVoiceError(
      'An unambiguous narration language is required for Teaching Voice.',
    );
  }
  if (requestedLanguage !== referenceLanguage) {
    throw new TeachingVoiceError(
      'Teaching Voice language does not match narration. Select a matching voice.',
    );
  }
  if (provider === 'indicf5' && referenceLanguage !== 'hi' && referenceLanguage !== 'mr') {
    throw new TeachingVoiceError('IndicF5 Teaching Voice requires a Hindi or Marathi reference.');
  }
  if (provider === 'indicf5' && !profile.referenceText?.trim()) {
    throw new TeachingVoiceError(
      'The reference transcript is missing. Re-enroll this Teaching Voice.',
    );
  }
  return referenceLanguage;
}
