import { tryResolveTTSLanguageCode } from '@/lib/audio/tts-language';
import {
  resolveVoiceProfileLanguageId,
  resolveVoiceProfileProvider,
  TeachingVoiceError,
  type VoiceProfile,
} from './types';

export type TeachingVoiceLanguage = 'en' | 'hi' | 'mr';

export function resolveTeachingVoiceLanguage(value?: string | null): string | null {
  const input = value?.trim().toLowerCase();
  if (!input) return null;
  const direct = /^(en|hi|mr)(?:[-_][a-z0-9]+)*$/.exec(input);
  if (direct) return direct[1];
  const matches = [
    ['en', new RegExp('(?<![\\p{L}\\p{M}\\p{N}_])english(?![\\p{L}\\p{M}\\p{N}_])', 'u')],
    ['hi', new RegExp('(?<![\\p{L}\\p{M}\\p{N}_])(?:hindi|हिंदी|हिन्दी)(?![\\p{L}\\p{M}\\p{N}_])', 'u')],
    ['mr', new RegExp('(?<![\\p{L}\\p{M}\\p{N}_])(?:marathi|मराठी)(?![\\p{L}\\p{M}\\p{N}_])', 'u')],
  ] as const;
  const languages = matches.filter(([, pattern]) => pattern.test(input));
  if (languages.length > 1) return null;
  return languages[0]?.[0] ?? tryResolveTTSLanguageCode(input);
}

export function newTeachingVoiceProvider(language: string): 'qwen3' | 'indicf5' {
  if (language === 'en') return 'qwen3';
  if (language === 'hi' || language === 'mr') return 'indicf5';
  throw new TeachingVoiceError('New Teaching Voice enrollment supports English, Hindi and Marathi.');
}

export function validateTeachingVoiceLanguage(profile: VoiceProfile, requested?: string): string {
  const language = resolveTeachingVoiceLanguage(resolveVoiceProfileLanguageId(profile));
  const target = resolveTeachingVoiceLanguage(requested);
  const provider = resolveVoiceProfileProvider(profile);
  if (!language) throw new TeachingVoiceError('The voice profile language is unsupported.');
  // Old Chatterbox clients may omit a language; new transcript-based voices may not.
  if ((!requested && provider !== 'chatterbox') || (requested && !target)) {
    throw new TeachingVoiceError('An unambiguous narration language is required for Teaching Voice.');
  }
  if (target && target !== language) {
    throw new TeachingVoiceError('Teaching Voice language does not match narration. Select a matching voice.');
  }
  if (provider === 'qwen3' && language !== 'en') {
    throw new TeachingVoiceError('Qwen3 Teaching Voice requires an English reference.');
  }
  if (provider === 'indicf5' && language !== 'hi' && language !== 'mr') {
    throw new TeachingVoiceError('IndicF5 Teaching Voice requires a Hindi or Marathi reference.');
  }
  if ((provider === 'qwen3' || provider === 'indicf5') && !profile.referenceText?.trim()) {
    throw new TeachingVoiceError('The reference transcript is missing. Re-enroll this Teaching Voice.');
  }
  return language;
}
