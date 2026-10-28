import type { SpeechAction } from '@/lib/types/action';
import type { Scene, Stage } from '@/lib/types/stage';

/**
 * Select only the server-validated narration projection from a real
 * StageStorage document. The source stage/scenes are never mutated or
 * serialized wholesale, so visuals and other course content remain local.
 */
export function buildBrowserCourseNarrationRegistration(stage: Stage, scenes: readonly Scene[]) {
  return {
    stageId: stage.id,
    stage: {
      id: stage.id,
      name: stage.name,
      createdAt: stage.createdAt,
      updatedAt: stage.updatedAt,
      teacherVoiceProfileId: stage.teacherVoiceProfileId,
      lessonLanguage: stage.lessonLanguage,
    },
    teacherVoiceProfileId: stage.teacherVoiceProfileId,
    lessonLanguage: stage.lessonLanguage,
    scenes: scenes.map((scene) => ({
      id: scene.id,
      speech: (scene.actions ?? [])
        .filter((action): action is SpeechAction => action.type === 'speech')
        .map((action) => ({
          id: action.id,
          text: action.text,
          ...(action.audioId ? { audioId: action.audioId } : {}),
        })),
    })),
  };
}
