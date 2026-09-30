'use client';

import { lessonGenerationPhaseLabel, lessonGenerationPercent } from '@/lib/generation/progress';
import type { LessonGenerationPhase } from '@/lib/generation/progress';
import type { SceneOutline } from '@/lib/types/generation';

export function LessonGenerationProgress({
  sceneIndex,
  totalScenes,
  phase,
  sceneType,
  etaLabel,
}: {
  readonly sceneIndex: number;
  readonly totalScenes: number;
  readonly phase: LessonGenerationPhase;
  readonly sceneType?: SceneOutline['type'];
  readonly etaLabel?: string;
}) {
  const percent = lessonGenerationPercent({ sceneIndex, totalScenes, phase });

  return (
    <div
      className="mx-auto mt-5 w-full max-w-xs space-y-2 rounded-lg border border-border/70 bg-background/80 p-3 text-left shadow-sm"
      role="status"
      aria-live="polite"
    >
      <div className="flex items-center justify-between gap-3 text-xs font-medium text-muted-foreground">
        <span>
          Generating lesson · Slide {sceneIndex} of {Math.max(totalScenes, sceneIndex)}
        </span>
        <span>{percent}%</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-500"
          style={{ width: `${percent}%` }}
        />
      </div>
      <p className="text-sm font-medium text-foreground">
        {lessonGenerationPhaseLabel(phase, sceneType)}
      </p>
      {etaLabel ? <p className="text-xs text-muted-foreground">{etaLabel}</p> : null}
    </div>
  );
}
