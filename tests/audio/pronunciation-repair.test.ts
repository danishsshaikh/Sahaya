import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Scene } from '@/lib/types/stage';

const mocks = vi.hoisted(() => ({
  generate: vi.fn(),
  remove: vi.fn(),
  state: null as unknown as ReturnType<typeof makeState>,
}));

vi.mock('@/lib/hooks/use-scene-generator', () => ({
  generateAndStoreTTS: mocks.generate,
  removeFreshTtsAllocations: mocks.remove,
}));
vi.mock('@/lib/store/stage', () => ({
  useStageStore: { getState: () => mocks.state },
}));
vi.mock('@/lib/classroom/generation-permission', () => ({ mayGenerateForStage: () => true }));

function makeScene(id: string, order: number, text: string, audioId: string): Scene {
  return {
    id,
    stageId: 'stage-1',
    order,
    title: `Slide ${order}`,
    type: 'slide',
    content: {
      type: 'slide',
      schemaVersion: 1,
      canvas: {
        id: `canvas-${order}`,
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
    actions: [{ id: `speech-${order}`, type: 'speech', text, audioId }],
  };
}

function makeState() {
  const state = {
    stage: { id: 'stage-1', languageDirective: 'English' },
    generationEpoch: 4,
    outlines: [
      { id: 'outline-1', order: 1 },
      { id: 'outline-2', order: 2 },
    ],
    scenes: [
      makeScene('scene-1', 1, 'Polymerase synthesizes the new DNA strand.', 'audio-old'),
      makeScene('scene-2', 2, 'A second narration.', 'audio-other'),
    ],
    getSceneById(id: string) {
      return state.scenes.find((scene) => scene.id === id) ?? null;
    },
    updateScene(id: string, patch: Partial<Scene>) {
      state.scenes = state.scenes.map((scene) =>
        scene.id === id ? ({ ...scene, ...patch } as Scene) : scene,
      );
    },
  };
  return state;
}

function request(pronounceAs = 'pol-IM-er-ace') {
  return {
    stageId: 'stage-1',
    sceneId: 'scene-1',
    actionId: 'speech-1',
    actionIndex: 0,
    displayText: 'Polymerase synthesizes the new DNA strand.',
    startOffset: 0,
    endOffset: 10,
    pronounceAs,
    language: 'English',
  };
}

describe('pronunciation repair', () => {
  beforeEach(async () => {
    mocks.state = makeState();
    mocks.generate.mockReset();
    mocks.remove.mockReset().mockResolvedValue(undefined);
    const { resetPronunciationRepairStateForTests } =
      await import('@/lib/audio/pronunciation-repair');
    resetPronunciationRepairStateForTests();
  });

  it('separates visible narration from provider synthesis text and repair identity', async () => {
    const { buildPronunciationSynthesisText, createPronunciationRepairIdentity } =
      await import('@/lib/audio/pronunciation-repair');
    const input = request();
    expect(
      buildPronunciationSynthesisText(
        input.displayText,
        input.startOffset,
        input.endOffset,
        input.pronounceAs,
      ),
    ).toBe('pol-IM-er-ace synthesizes the new DNA strand.');
    expect(createPronunciationRepairIdentity(input)).not.toBe(
      createPronunciationRepairIdentity(request('pol-y-mer-ace')),
    );
    expect(mocks.state.scenes[0].actions?.[0]).toMatchObject({
      text: input.displayText,
      audioId: 'audio-old',
    });
  });

  it('keeps old audio until success, deduplicates identical work, and replaces only its action', async () => {
    let resolve!: (value: string) => void;
    mocks.generate.mockReturnValue(
      new Promise<string>((done) => {
        resolve = done;
      }),
    );
    const { requestPronunciationRepair } = await import('@/lib/audio/pronunciation-repair');

    const first = requestPronunciationRepair(request());
    const duplicate = requestPronunciationRepair(request());
    expect(mocks.generate).toHaveBeenCalledTimes(1);
    expect(mocks.generate).toHaveBeenCalledWith(
      expect.stringMatching(/^tts_pronunciation_s1_speech-1_/),
      'pol-IM-er-ace synthesizes the new DNA strand.',
      'English',
      undefined,
      undefined,
      undefined,
      'stage-1',
      undefined,
      0,
      'scene-1',
      undefined,
      'outline-1',
    );
    expect(mocks.state.scenes[0].actions?.[0]).toMatchObject({ audioId: 'audio-old' });

    resolve('audio-repaired');
    await expect(first).resolves.toMatchObject({ status: 'replaced', audioId: 'audio-repaired' });
    await expect(duplicate).resolves.toMatchObject({ status: 'replaced' });
    expect(mocks.state.scenes[0].actions?.[0]).toMatchObject({
      text: request().displayText,
      audioId: 'audio-repaired',
    });
    expect(mocks.state.scenes[1].actions?.[0]).toMatchObject({ audioId: 'audio-other' });
  });

  it('discards a completion after narration edits instead of overwriting the edited action', async () => {
    let resolve!: (value: string) => void;
    mocks.generate.mockReturnValue(new Promise<string>((done) => (resolve = done)));
    const { requestPronunciationRepair } = await import('@/lib/audio/pronunciation-repair');
    const pending = requestPronunciationRepair(request());
    const action = mocks.state.scenes[0].actions![0];
    mocks.state.scenes[0].actions![0] = { ...action, text: 'Faculty edited this narration.' };

    resolve('audio-stale');
    await expect(pending).resolves.toMatchObject({ status: 'stale' });
    expect(mocks.remove).toHaveBeenCalledWith(['audio-stale']);
    expect(mocks.state.scenes[0].actions?.[0]).toMatchObject({
      text: 'Faculty edited this narration.',
      audioId: 'audio-old',
    });
  });

  it('preserves existing audio when synthesis fails', async () => {
    mocks.generate.mockRejectedValue(new Error('provider unavailable'));
    const { requestPronunciationRepair } = await import('@/lib/audio/pronunciation-repair');

    await expect(requestPronunciationRepair(request())).rejects.toThrow('provider unavailable');
    expect(mocks.state.scenes[0].actions?.[0]).toMatchObject({ audioId: 'audio-old' });
  });

  it('allows only the latest pronunciation revision to replace audio', async () => {
    let resolveFirst!: (value: string) => void;
    let resolveSecond!: (value: string) => void;
    mocks.generate
      .mockReturnValueOnce(new Promise<string>((done) => (resolveFirst = done)))
      .mockReturnValueOnce(new Promise<string>((done) => (resolveSecond = done)));
    const { requestPronunciationRepair } = await import('@/lib/audio/pronunciation-repair');

    const first = requestPronunciationRepair(request('pol-IM-er-ace'));
    const second = requestPronunciationRepair(request('pol-y-mer-ace'));

    resolveFirst('audio-first');
    await expect(first).resolves.toMatchObject({ status: 'stale' });
    expect(mocks.state.scenes[0].actions?.[0]).toMatchObject({ audioId: 'audio-old' });
    expect(mocks.remove).toHaveBeenCalledWith(['audio-first']);

    resolveSecond('audio-second');
    await expect(second).resolves.toMatchObject({ status: 'replaced', audioId: 'audio-second' });
    expect(mocks.state.scenes[0].actions?.[0]).toMatchObject({ audioId: 'audio-second' });
  });

  it('repairs the identified speech action instead of the first action in its scene', async () => {
    mocks.state.scenes[0].actions = [
      { id: 'speech-first', type: 'speech', text: 'First narration.', audioId: 'audio-first' },
      {
        id: 'speech-target',
        type: 'speech',
        text: 'Hinduism, Buddhism, and Jainism.',
        audioId: 'audio-target-old',
      },
    ];
    mocks.generate.mockResolvedValue('audio-target-new');
    const { requestPronunciationRepair } = await import('@/lib/audio/pronunciation-repair');

    await expect(
      requestPronunciationRepair({
        stageId: 'stage-1',
        sceneId: 'scene-1',
        actionId: 'speech-target',
        actionIndex: 1,
        displayText: 'Hinduism, Buddhism, and Jainism.',
        startOffset: 24,
        endOffset: 31,
        pronounceAs: 'JAY-nism',
        language: 'English',
      }),
    ).resolves.toMatchObject({ status: 'replaced', audioId: 'audio-target-new' });

    expect(mocks.state.scenes[0].actions?.[0]).toMatchObject({ audioId: 'audio-first' });
    expect(mocks.state.scenes[0].actions?.[1]).toMatchObject({
      text: 'Hinduism, Buddhism, and Jainism.',
      audioId: 'audio-target-new',
    });
    expect(mocks.generate.mock.calls[0][1]).toBe('Hinduism, Buddhism, and JAY-nism.');
  });
});
