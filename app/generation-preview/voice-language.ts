import {
  normalizeTeachingVoiceLanguageId,
  resolveGenerationLessonTeachingVoiceLanguage,
  type LessonTeachingVoiceLanguageResolution,
} from '@/lib/voice-cloning/language';
import { validateGenerationTeachingVoiceProfile } from '@/lib/voice-cloning/selection-client';
import type { PublicVoiceProfile } from '@/lib/voice-cloning/types';
import type { GenerationSessionState } from './types';

export function resolveGenerationPreviewLanguage(
  session: GenerationSessionState,
  input: { sseLanguage?: string | null; languageDirective?: string | null } = {},
): LessonTeachingVoiceLanguageResolution {
  return resolveGenerationLessonTeachingVoiceLanguage({
    savedLanguage: session.lessonLanguage,
    sseLanguage: input.sseLanguage,
    languageDirective: input.languageDirective ?? session.languageDirective,
    requirement: session.requirements.requirement,
  });
}

export function normalizeGenerationPreviewLanguageState(
  session: GenerationSessionState,
  languageDirective = session.languageDirective,
): GenerationSessionState {
  const lessonLanguage = resolveGenerationPreviewLanguage(session, {
    languageDirective,
  }).language;
  if (!lessonLanguage || session.lessonLanguage === lessonLanguage) return session;
  return { ...session, lessonLanguage };
}

export async function validateGenerationPreviewVoiceSelection(
  session: GenerationSessionState,
  fetchProfile: typeof fetch = fetch,
): Promise<PublicVoiceProfile | undefined> {
  if (!session.teacherVoiceProfileId) return undefined;
  return validateGenerationTeachingVoiceProfile(
    session.teacherVoiceProfileId,
    normalizeTeachingVoiceLanguageId(session.lessonLanguage),
    fetchProfile,
  );
}
