'use client';

import { markStagePersistenceDirty, useStageStore } from '@/lib/store/stage';
import { applyNarrationVersion } from './versioning';

/** Atomically replace every speech reference only after a complete version has been validated. */
export async function activateCourseNarrationVersion(versionId: string): Promise<boolean> {
  const before = useStageStore.getState();
  if (!before.stage) return false;
  const version = before.stage.narration?.versions.find((candidate) => candidate.id === versionId);
  if (!version) return false;

  const scenes = applyNarrationVersion(before.scenes, version);
  const stage = {
    ...before.stage,
    narration: { ...before.stage.narration!, activeVersionId: version.id },
    updatedAt: Date.now(),
  };
  useStageStore.setState({ stage, scenes });
  markStagePersistenceDirty([
    { kind: 'stage' },
    ...scenes.map((scene) => ({ kind: 'scene' as const, sceneId: scene.id })),
  ]);
  const saved = await useStageStore.getState().saveToStorage();
  if (saved) return true;

  // A failed durable activation must not leave this tab playing a partial/new state.
  useStageStore.setState({ stage: before.stage, scenes: before.scenes });
  return false;
}
