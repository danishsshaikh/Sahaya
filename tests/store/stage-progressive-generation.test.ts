import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStageStore } from '@/lib/store/stage';
import type { Scene, Stage } from '@/lib/types/stage';

vi.mock('@/lib/utils/stage-storage', () => ({
  saveStageData: vi.fn().mockResolvedValue(undefined),
  saveStageDataIncremental: vi.fn().mockResolvedValue(undefined),
  loadStageData: vi.fn().mockResolvedValue(null),
}));

const stage: Stage = {
  id: 'stage-1',
  name: 'Progressive lesson',
  createdAt: 1,
  updatedAt: 1,
};

function scene(id: string, order: number): Scene {
  return {
    id,
    stageId: stage.id,
    type: 'slide',
    title: id,
    order,
    content: {
      type: 'slide',
      schemaVersion: 1,
      canvas: {
        id: `canvas-${id}`,
        viewportSize: 1000,
        viewportRatio: 0.5625,
        theme: {
          backgroundColor: '#fff',
          themeColors: ['#000'],
          fontColor: '#000',
          fontName: 'Inter',
        },
        elements: [],
      },
    },
    actions: [],
  };
}

describe('progressive scene generation store behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useStageStore.getState().clearStore();
    useStageStore.setState({ stage, scenes: [], currentSceneId: null });
  });

  afterEach(() => {
    useStageStore.getState().clearStore();
    vi.useRealTimers();
  });

  it('selects the first generated scene without stealing focus on later scenes', () => {
    const first = scene('scene-first', 1);
    const second = scene('scene-second', 2);
    useStageStore.setState({
      generatingOutlines: [
        {
          id: 'outline-first',
          title: 'First',
          description: 'First generated scene',
          keyPoints: [],
          type: 'slide',
          order: 1,
        },
        {
          id: 'outline-second',
          title: 'Second',
          description: 'Second generated scene',
          keyPoints: [],
          type: 'slide',
          order: 2,
        },
      ],
    });

    useStageStore.getState().addScene(first);
    expect(useStageStore.getState().currentSceneId).toBe(first.id);
    expect(useStageStore.getState().getCurrentScene()?.id).toBe(first.id);

    useStageStore.getState().addScene(second);
    expect(useStageStore.getState().currentSceneId).toBe(first.id);
    expect(useStageStore.getState().getCurrentScene()?.id).toBe(first.id);
  });

  it('preserves edits to an earlier scene when a later generated scene arrives', () => {
    const first = scene('scene-first', 1);
    const second = scene('scene-second', 2);

    useStageStore.getState().addScene(first);
    useStageStore.getState().updateScene(first.id, { title: 'Faculty edited title' });
    useStageStore.getState().addScene(second);

    expect(useStageStore.getState().getSceneById(first.id)?.title).toBe('Faculty edited title');
    expect(useStageStore.getState().getSceneById(second.id)?.title).toBe(second.title);
  });

  it('commits one logical scene when overlapping attempts return the same outline order', () => {
    const authoritative = { ...scene('scene-authoritative', 1), outlineId: 'outline-1' };
    const staleDuplicate = { ...scene('scene-stale', 1), outlineId: 'outline-1' };

    useStageStore.getState().addScene(authoritative);
    useStageStore.getState().addScene(staleDuplicate);

    expect(useStageStore.getState().scenes).toEqual([authoritative]);
    expect(useStageStore.getState().currentSceneId).toBe(authoritative.id);
  });
});
