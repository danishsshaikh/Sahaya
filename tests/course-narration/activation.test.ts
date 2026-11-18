import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  markDirty: vi.fn(),
}));

vi.mock('@/lib/store/stage', () => {
  const store = Object.assign(vi.fn(), {
    getState: () => mocks.state,
    setState: (update: Record<string, unknown>) => {
      mocks.state = { ...mocks.state, ...update };
    },
  });
  return { useStageStore: store, markStagePersistenceDirty: mocks.markDirty };
});

import { activateCourseNarrationVersion } from '@/lib/course-narration/activation';
import { captureOriginalNarration } from '@/lib/course-narration/versioning';
import type { Scene } from '@/lib/types/stage';

const scenes = [
  {
    id: 'scene-1',
    stageId: 'course-1',
    title: 'Scene',
    order: 1,
    type: 'quiz',
    content: { type: 'quiz', questions: [] },
    actions: [
      { id: 'speech-1', type: 'speech', text: 'Exact transcript', audioId: 'original-audio' },
    ],
  } as Scene,
];

function state(saveResult: boolean) {
  const original = captureOriginalNarration(scenes, 'en', 'Qwen3-TTS 1.7B');
  const qwen = structuredClone(original);
  qwen.id = 'qwen-new';
  qwen.providerId = 'qwen3-tts';
  qwen.providerName = 'Qwen3-TTS 1.7B';
  qwen.scenes['scene-1'].clips['speech-1'].audioId = 'qwen-audio';
  return {
    stage: {
      id: 'course-1',
      name: 'Course',
      createdAt: 1,
      updatedAt: 1,
      narration: {
        schemaVersion: 1 as const,
        activeVersionId: 'original',
        versions: [original, qwen],
      },
    },
    scenes: structuredClone(scenes),
    saveToStorage: vi.fn().mockResolvedValue(saveResult),
  };
}

describe('course narration atomic activation', () => {
  beforeEach(() => {
    mocks.markDirty.mockReset();
  });

  it('switches every speech reference in one durable save while preserving visuals and original', async () => {
    mocks.state = state(true);

    await expect(activateCourseNarrationVersion('qwen-new')).resolves.toBe(true);

    const current = mocks.state as ReturnType<typeof state>;
    expect(current.stage.narration.activeVersionId).toBe('qwen-new');
    expect(current.stage.narration.versions.map((version) => version.id)).toEqual([
      'original',
      'qwen-new',
    ]);
    expect(current.scenes[0].actions?.find((action) => action.type === 'speech')?.audioId).toBe(
      'qwen-audio',
    );
    expect(current.scenes[0].content).toEqual(scenes[0].content);
    expect(current.saveToStorage).toHaveBeenCalledTimes(1);
  });

  it('rolls back every in-memory reference when durable persistence fails', async () => {
    mocks.state = state(false);

    await expect(activateCourseNarrationVersion('qwen-new')).resolves.toBe(false);

    const current = mocks.state as ReturnType<typeof state>;
    expect(current.stage.narration.activeVersionId).toBe('original');
    expect(current.scenes[0].actions?.find((action) => action.type === 'speech')?.audioId).toBe(
      'original-audio',
    );
  });
});
