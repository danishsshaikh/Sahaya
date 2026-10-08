import { describe, expect, it } from 'vitest';
import {
  restorePersistedSceneRecovery,
  selectNextRecoverableOutline,
} from '@/lib/generation/scene-recovery';
import type { SceneOutline } from '@/lib/types/generation';

function outline(id: string, order: number): SceneOutline {
  return {
    id,
    order,
    title: `Slide ${order}`,
    description: `Slide ${order}`,
    keyPoints: [],
    type: 'slide',
  };
}

describe('scene recovery presentation', () => {
  it('attributes failure to the exact earlier outline instead of the selected or first scene', () => {
    const scene2 = outline('scene_2', 2);
    const scene3 = outline('scene_3', 3);

    expect(selectNextRecoverableOutline([scene2, scene3], [], [scene2])).toEqual({
      outline: scene2,
      failed: true,
    });
  });

  it('returns the next queued outline when no terminal failure exists', () => {
    const scene2 = outline('scene_2', 2);
    expect(selectNextRecoverableOutline([scene2], [], [])).toEqual({
      outline: scene2,
      failed: false,
    });
  });

  it('hydrates terminal failures separately from queued outlines', () => {
    const scene1 = outline('scene_1', 1);
    const scene2 = outline('scene_2', 2);
    const scene3 = outline('scene_3', 3);

    expect(
      restorePersistedSceneRecovery([scene1, scene2, scene3], [{ order: 1 }], ['scene_2']),
    ).toEqual({
      failedOutlines: [scene2],
      pendingOutlines: [scene3],
    });
  });
});
