import { tryResolveTTSLanguageCode } from '@/lib/audio/tts-language';
import {
  resolveVoiceProfileLanguageId,
  resolveVoiceProfileProvider,
  TeachingVoiceError,
  type VoiceProfile,
} from './types';

export type TeachingVoiceLanguage = 'en' | 'hi' | 'mr';
export type LessonTeachingVoiceLanguageSource = 'saved' | 'sse' | 'directive' | 'requirement';

export type LessonTeachingVoiceLanguageResolution = {
  language: TeachingVoiceLanguage | null;
  source: LessonTeachingVoiceLanguageSource | null;
  reason?: 'invalid-structured-language' | 'conflicting-language-signals' | 'unresolved';
};
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

/** Resolve a lesson directive to the normalized language IDs supported by Teaching Voice. */
export function resolveLessonTeachingVoiceLanguage(
  value?: string | null,
): TeachingVoiceLanguage | null {
  return (
    resolveRequestedLessonTeachingVoiceLanguage(value) ||
    normalizeTeachingVoiceLanguageId(resolveTeachingVoiceLanguage(value))
  );
}

const EXPLICIT_LESSON_LANGUAGE_PATTERNS = {
  en: [
    /\b(?:in|using|use)\s+(?:simple\s+)?english\b/iu,
    /\benglish\s+(?:language|throughout|narration|instruction|medium)\b/iu,
    /\b(?:teach|write|generate|explain|present|deliver)\s+(?:the\s+)?(?:entire\s+)?(?:lesson|course|content|narration|response)\s+(?:entirely\s+)?(?:in\s+)?(?:simple\s+)?english\b/iu,
  ],
  hi: [
    /\b(?:in|using|use)\s+(?:simple\s+)?hindi\b/iu,
    /\bhindi\s+(?:language|throughout|narration|instruction|medium)\b/iu,
    /\b(?:teach|write|generate|explain|present|deliver)\s+(?:the\s+)?(?:entire\s+)?(?:lesson|course|content|narration|response)\s+(?:entirely\s+)?(?:in\s+)?(?:simple\s+)?hindi\b/iu,
    /(?:हिंदी|हिन्दी)\s+में/u,
  ],
  mr: [
    /\b(?:in|using|use)\s+(?:simple\s+)?marathi\b/iu,
    /\bmarathi\s+(?:language|throughout|narration|instruction|medium)\b/iu,
    /\b(?:teach|write|generate|explain|present|deliver)\s+(?:the\s+)?(?:entire\s+)?(?:lesson|course|content|narration|response)\s+(?:entirely\s+)?(?:in\s+)?(?:simple\s+)?marathi\b/iu,
    /मराठी(?:त|\s+मध्ये)/u,
  ],
} satisfies Record<TeachingVoiceLanguage, RegExp[]>;

/** Resolve explicit lesson-language intent without treating subject words as language choices. */
export function resolveRequestedLessonTeachingVoiceLanguage(
  value?: string | null,
): TeachingVoiceLanguage | null {
  const input = value?.trim();
  if (!input) return null;
  const direct = normalizeTeachingVoiceLanguageId(input);
  if (direct) return direct;
  if (/\b(?:english|hindi|marathi)\s*(?:and|or|\/|&)\s*(?:english|hindi|marathi)\b/iu.test(input)) {
    return null;
  }
  const matches = (
    Object.entries(EXPLICIT_LESSON_LANGUAGE_PATTERNS) as Array<[TeachingVoiceLanguage, RegExp[]]>
  )
    .filter(([, patterns]) => patterns.some((pattern) => pattern.test(input)))
    .map(([language]) => language);
  return matches.length === 1 ? matches[0] : null;
}

/** Reconcile the supported structured and textual signals used during lesson generation. */
export function resolveGenerationLessonTeachingVoiceLanguage(input: {
  savedLanguage?: string | null;
  sseLanguage?: string | null;
  languageDirective?: string | null;
  requirement?: string | null;
}): LessonTeachingVoiceLanguageResolution {
  const candidates: Array<{
    language: TeachingVoiceLanguage;
    source: LessonTeachingVoiceLanguageSource;
  }> = [];

  for (const [value, source] of [
    [input.savedLanguage, 'saved'],
    [input.sseLanguage, 'sse'],
  ] as const) {
    if (value === undefined || value === null || value.trim() === '') continue;
    const language = normalizeTeachingVoiceLanguageId(value);
    if (!language) {
      return { language: null, source: null, reason: 'invalid-structured-language' };
    }
    candidates.push({ language, source });
  }

  const directiveLanguage = resolveLessonTeachingVoiceLanguage(input.languageDirective);
  if (directiveLanguage) {
    candidates.push({ language: directiveLanguage, source: 'directive' });
  }
  const requirementLanguage = resolveRequestedLessonTeachingVoiceLanguage(input.requirement);
  if (requirementLanguage) {
    candidates.push({ language: requirementLanguage, source: 'requirement' });
  }

  if (new Set(candidates.map(({ language }) => language)).size > 1) {
    return { language: null, source: null, reason: 'conflicting-language-signals' };
  }
  const resolved = candidates[0];
  return resolved
    ? { language: resolved.language, source: resolved.source }
    : { language: null, source: null, reason: 'unresolved' };
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
