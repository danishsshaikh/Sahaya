import type { SceneOutline } from '@/lib/types/generation';
import type { Scene } from '@/lib/types/stage';
import type { VisualizationFailureCode } from '@/lib/visualization/failure';
import type { SceneAttemptStatus } from './scene-attempt-status';

export type FailedSceneOutline = SceneOutline & { visualizationFailure?: VisualizationFailureCode };

export interface RecoverableSceneOutline {
  outline: SceneOutline;
  failed: boolean;
  visualizationFailure?: VisualizationFailureCode;
}

/** The next unresolved outline in deck order, with terminal failure taking precedence. */
export function selectNextRecoverableOutline(
  outlines: readonly SceneOutline[],
  scenes: readonly Pick<Scene, 'order' | 'outlineId'>[],
  failedOutlines: readonly FailedSceneOutline[],
  attempts: Readonly<Record<string, SceneAttemptStatus>> = {},
): RecoverableSceneOutline | null {
  const completedOutlineIds = new Set(
    scenes.flatMap((scene) => (scene.outlineId ? [scene.outlineId] : [])),
  );
  const completedOrders = new Set(scenes.map((scene) => scene.order));
  const outline = outlines
    .filter(
      (candidate) =>
        !completedOutlineIds.has(candidate.id) && !completedOrders.has(candidate.order),
    )
    .sort((a, b) => a.order - b.order)[0];
  if (!outline) return null;
  const attempt = attempts[outline.id];
  const failed =
    attempt && !attempt.outcome
      ? undefined
      : failedOutlines.find((candidate) => candidate.id === outline.id);
  return {
    outline,
    failed: !!failed,
    ...(failed?.visualizationFailure && { visualizationFailure: failed.visualizationFailure }),
  };
}

export function classroomSceneRows(
  outlines: readonly SceneOutline[],
  scenes: readonly Scene[],
  generationComplete: boolean,
) {
  const remaining = new Set(scenes);
  const rows: { id: string; order: number; scene?: Scene; outline?: SceneOutline }[] = [];
  for (const outline of [...outlines].sort((a, b) => a.order - b.order)) {
    const scene =
      scenes.find((entry) => entry.outlineId === outline.id) ??
      scenes.find((entry) => !entry.outlineId && entry.order === outline.order);
    if (scene) remaining.delete(scene);
    if (scene || !generationComplete) {
      rows.push({
        id: `outline:${outline.id}`,
        order: generationComplete && scene ? scene.order : outline.order,
        scene,
        outline,
      });
    }
  }
  for (const scene of remaining) rows.push({ id: `scene:${scene.id}`, order: scene.order, scene });
  return rows.sort((a, b) => a.order - b.order);
}

export function restorePersistedSceneRecovery(
  outlines: readonly SceneOutline[],
  scenes: readonly Pick<Scene, 'order'>[],
  failedOutlineIds: readonly string[],
): { failedOutlines: SceneOutline[]; pendingOutlines: SceneOutline[] } {
  const completedOrders = new Set(scenes.map((scene) => scene.order));
  const failedIds = new Set(failedOutlineIds);
  return {
    failedOutlines: outlines.filter((outline) => failedIds.has(outline.id)),
    pendingOutlines: outlines.filter(
      (outline) => !failedIds.has(outline.id) && !completedOrders.has(outline.order),
    ),
  };
}
