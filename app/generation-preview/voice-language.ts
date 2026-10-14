import {
  normalizeTeachingVoiceLanguageId,
  resolveLessonTeachingVoiceLanguage,
} from '@/lib/voice-cloning/language';
import { validateGenerationTeachingVoiceProfile } from '@/lib/voice-cloning/selection-client';
import type { GenerationSessionState } from './types';

export function normalizeGenerationPreviewLanguageState(
  session: GenerationSessionState,
  languageDirective = session.languageDirective,
): GenerationSessionState {
  const lessonLanguage =
    normalizeTeachingVoiceLanguageId(session.lessonLanguage) ||
    resolveLessonTeachingVoiceLanguage(languageDirective);
  if (!lessonLanguage || session.lessonLanguage === lessonLanguage) return session;
  return { ...session, lessonLanguage };
}

export async function validateGenerationPreviewVoiceSelection(
  session: GenerationSessionState,
  fetchProfile: typeof fetch = fetch,
): Promise<void> {
  if (!session.teacherVoiceProfileId) return;
  await validateGenerationTeachingVoiceProfile(
    session.teacherVoiceProfileId,
    normalizeTeachingVoiceLanguageId(session.lessonLanguage),
    fetchProfile,
  );
}
