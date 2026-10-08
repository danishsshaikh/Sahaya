import type { SceneOutline } from '@/lib/types/generation';
import type { Scene } from '@/lib/types/stage';

export interface RecoverableSceneOutline {
  outline: SceneOutline;
  failed: boolean;
}

/** The next unresolved outline in deck order, with terminal failure taking precedence. */
export function selectNextRecoverableOutline(
  outlines: readonly SceneOutline[],
  scenes: readonly Pick<Scene, 'order' | 'outlineId'>[],
  failedOutlines: readonly SceneOutline[],
): RecoverableSceneOutline | null {
  const failedIds = new Set(failedOutlines.map((outline) => outline.id));
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
  return outline ? { outline, failed: failedIds.has(outline.id) } : null;
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
