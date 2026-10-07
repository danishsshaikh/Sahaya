import type { SceneOutline } from '@/lib/types/generation';
import type { Scene } from '@/lib/types/stage';

export interface RecoverableSceneOutline {
  outline: SceneOutline;
  failed: boolean;
}

/** The next unresolved outline in deck order, with terminal failure taking precedence. */
export function selectNextRecoverableOutline(
  generatingOutlines: readonly SceneOutline[],
  failedOutlines: readonly SceneOutline[],
): RecoverableSceneOutline | null {
  const failedIds = new Set(failedOutlines.map((outline) => outline.id));
  const byId = new Map<string, SceneOutline>();
  for (const outline of [...generatingOutlines, ...failedOutlines]) {
    byId.set(outline.id, outline);
  }

  const outline = [...byId.values()].sort((a, b) => a.order - b.order)[0];
  return outline ? { outline, failed: failedIds.has(outline.id) } : null;
}

export function restorePersistedSceneRecovery(
  outlines: readonly SceneOutline[],
  scenes: readonly Pick<Scene, 'order'>[],
  failedOutlineIds: readonly string[],
): { failedOutlines: SceneOutline[]; generatingOutlines: SceneOutline[] } {
  const completedOrders = new Set(scenes.map((scene) => scene.order));
  const failedIds = new Set(failedOutlineIds);
  return {
    failedOutlines: outlines.filter((outline) => failedIds.has(outline.id)),
    generatingOutlines: outlines.filter(
      (outline) => !failedIds.has(outline.id) && !completedOrders.has(outline.order),
    ),
  };
}
