import type { SceneOutline } from '@/lib/types/generation';

export type LessonGenerationPhase = 'outline' | 'content' | 'actions' | 'narration' | 'finalizing';

const PHASE_PROGRESS: Record<LessonGenerationPhase, number> = {
  outline: 0.05,
  content: 0.3,
  actions: 0.6,
  narration: 0.85,
  finalizing: 0.95,
};

export function lessonGenerationPhaseLabel(
  phase: LessonGenerationPhase,
  sceneType?: SceneOutline['type'],
): string {
  if (phase === 'outline') return 'Planning your lesson...';
  if (phase === 'finalizing') return 'Finalizing lesson...';
  if (phase === 'narration') return 'Creating voice narration...';
  if (phase === 'actions') return 'Generating teaching actions...';
  if (sceneType === 'quiz') return 'Building quiz...';
  if (sceneType === 'interactive' || sceneType === 'pbl') {
    return 'Building interactive simulation...';
  }
  return 'Creating slide content...';
}

export function lessonGenerationPercent(input: {
  sceneIndex: number;
  totalScenes: number;
  phase: LessonGenerationPhase;
}): number {
  if (input.totalScenes <= 0) return 0;
  const completedBeforeCurrent = Math.max(0, input.sceneIndex - 1);
  const raw = ((completedBeforeCurrent + PHASE_PROGRESS[input.phase]) / input.totalScenes) * 100;
  return Math.max(1, Math.min(99, Math.round(raw)));
}

export function lessonGenerationEtaLabel(input: {
  completedSceneDurationsMs: readonly number[];
  currentSceneElapsedMs: number;
  sceneIndex: number;
  totalScenes: number;
}): string {
  const usableDurations = input.completedSceneDurationsMs.filter(
    (duration) => Number.isFinite(duration) && duration > 0,
  );
  if (usableDurations.length === 0 || input.totalScenes <= 0) return 'Estimating time...';

  const averageSceneMs =
    usableDurations.reduce((sum, duration) => sum + duration, 0) / usableDurations.length;
  const remainingSceneCount = Math.max(0, input.totalScenes - input.sceneIndex);
  const remainingCurrentMs = Math.max(0, averageSceneMs - input.currentSceneElapsedMs);
  const estimateMs = remainingCurrentMs + remainingSceneCount * averageSceneMs;
  if (estimateMs <= 0) return 'Almost done...';

  const minutes = Math.max(1, Math.round(estimateMs / 60000));
  if (minutes <= 1) return 'About 1 min remaining';
  if (minutes <= 3) return `About ${minutes} min remaining`;
  return `About ${Math.max(2, minutes - 1)}-${minutes + 1} min remaining`;
}
