import { describe, expect, it } from 'vitest';
import {
  classroomSceneRows,
  restorePersistedSceneRecovery,
  selectNextRecoverableOutline,
} from '@/lib/generation/scene-recovery';
import type { SceneOutline } from '@/lib/types/generation';
import type { Scene } from '@/lib/types/stage';
import { beginSceneAttempt, type SceneAttemptStatus } from '@/lib/generation/scene-attempt-status';

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

  it('keeps outline row identity and order as scenes complete out of order', () => {
    const outlines = [1, 2, 3, 4, 5].map((order) => outline(`outline-${order}`, order));
    const scene = (order: number): Scene => ({
      id: `scene-${order}`,
      outlineId: `outline-${order}`,
      order,
      stageId: 'stage',
      title: `Slide ${order}`,
      type: 'quiz',
      content: { type: 'quiz', questions: [] },
    });
    const initial = classroomSceneRows(outlines, [scene(4), scene(1)], false);
    const after = classroomSceneRows(outlines, [scene(4), scene(1), scene(2)], false);
    expect(after.map((row) => row.id)).toEqual(initial.map((row) => row.id));
    expect(after.map((row) => row.scene?.id)).toEqual([
      'scene-1',
      'scene-2',
      undefined,
      'scene-4',
      undefined,
    ]);
  });

  it('supersedes persisted failures and ignores progress or failure from an old attempt', () => {
    const state = {
      stage: { id: 'stage' },
      generationEpoch: 1,
      sceneAttempts: {} as Record<string, SceneAttemptStatus>,
    };
    const store = {
      getState: () => state,
      setState: (
        update: (current: { sceneAttempts: typeof state.sceneAttempts }) => Partial<typeof state>,
      ) => Object.assign(state, update(state)),
    };
    const scene = outline('outline-1', 1);
    const old = beginSceneAttempt(store, 'stage', scene.id, 'old', false)!;
    expect(beginSceneAttempt(store, 'stage', scene.id, 'duplicate', true)).toBeUndefined();
    state.generationEpoch++;
    state.sceneAttempts = {};
    const current = beginSceneAttempt(store, 'stage', scene.id, 'current', true)!;
    expect(selectNextRecoverableOutline([scene], [], [scene], state.sceneAttempts)?.failed).toBe(
      false,
    );
    current.progress('rendering');
    old.finish('failed');
    expect(state.sceneAttempts[scene.id]).toMatchObject({ id: 'current', phase: 'rendering' });
    current.finish();
    old.finish('failed');
    expect(state.sceneAttempts).toEqual({});
  });
});
