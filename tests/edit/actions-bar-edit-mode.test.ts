// @vitest-environment jsdom

import React, { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionsBar } from '@/components/edit/ActionsBar/ActionsBar';
import { useSettingsStore } from '@/lib/store/settings';
import { useStageStore } from '@/lib/store/stage';
import type { Action } from '@/lib/types/action';
import { makeScene, type Scene, type Stage } from '@/lib/types/stage';
import {
  buildNarrationSourceFromScene,
  getVisibleElementText,
  getAudioSourceFingerprint,
  getNarrationSyncState,
  resolveNarrationSyncDecision,
  syncedNarrationMetadata,
  staleAudioMetadata,
} from '@/lib/audio/narration-sync';

const OLD_NARRATION =
  'Our core principles revolve around maximizing throughput. By intelligently breaking down complex computations into independent units of work, we can drastically reduce the time required to solve large-scale problems.';
const NEW_NARRATION = 'The revised core principle shown on this slide is minimizing efficiency.';
const TTS_SETTINGS = {
  language: 'English',
  ttsEnabled: true,
  ttsProviderId: 'openai-tts',
  ttsVoice: 'alloy',
  ttsSpeed: 1,
  ttsModelId: 'tts-model-a',
};

const mocks = vi.hoisted(() => ({
  audioExists: vi.fn(async () => true),
  audioObjectUrl: vi.fn(async () => null),
  fetchSceneActions: vi.fn(),
  regenerateSpeechAudio: vi.fn(async (_sceneOrder: number, action: { id: string }) => action.id),
  resolveSpeechAudioId: vi.fn(
    (_sceneOrder: number, action: { id?: string; audioId?: string }) =>
      action.audioId || `tts_${action.id}`,
  ),
  speechAudioId: vi.fn((_sceneOrder: number, actionId: string) => `tts_${actionId}`),
  requestPronunciationRepair: vi.fn(),
}));

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock('@/lib/audio/regenerate-speech-tts', () => ({
  audioExists: mocks.audioExists,
  audioObjectUrl: mocks.audioObjectUrl,
  regenerateSpeechAudio: mocks.regenerateSpeechAudio,
  resolveSpeechAudioId: mocks.resolveSpeechAudioId,
  speechAudioId: mocks.speechAudioId,
}));

vi.mock('@/lib/hooks/use-scene-generator', () => ({
  fetchSceneActions: mocks.fetchSceneActions,
}));

vi.mock('@/lib/audio/pronunciation-repair', () => ({
  requestPronunciationRepair: mocks.requestPronunciationRepair,
}));

const initialStageState = useStageStore.getState();
const initialSettingsState = useSettingsStore.getState();
let mounted: { root: Root; container: HTMLDivElement } | null = null;
let consoleError: ReturnType<typeof vi.spyOn>;
let consoleInfo: ReturnType<typeof vi.spyOn>;

describe('ActionsBar edit-mode narration sync regressions', () => {
  beforeEach(() => {
    useStageStore.setState(initialStageState, true);
    useSettingsStore.setState(initialSettingsState, true);
    mocks.audioExists.mockResolvedValue(true);
    mocks.audioObjectUrl.mockResolvedValue(null);
    mocks.fetchSceneActions.mockReset();
    mocks.regenerateSpeechAudio.mockReset();
    mocks.regenerateSpeechAudio.mockImplementation(
      async (_sceneOrder: number, action: { id: string }) => action.id,
    );
    mocks.resolveSpeechAudioId.mockClear();
    mocks.speechAudioId.mockClear();
    mocks.requestPronunciationRepair.mockReset();
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    setupStores(makeSyncedScene());
  });

  afterEach(() => {
    if (mounted) {
      act(() => mounted?.root.unmount());
      mounted.container.remove();
      mounted = null;
    }
    expectNoExternalStoreLoopErrors();
    consoleError.mockRestore();
    consoleInfo.mockRestore();
    useStageStore.setState(initialStageState, true);
    useSettingsStore.setState(initialSettingsState, true);
  });

  it('toggles edit mode on and renders under StrictMode without getSnapshot loops', async () => {
    useStageStore.setState({ mode: 'playback' });

    mount(
      React.createElement(
        StrictMode,
        null,
        React.createElement(EditModeHarness, { sceneId: 'scene-1' }),
      ),
    );

    expect(hasText('edit.timeline.addAction')).toBe(false);
    expect(hasLabel('edit.tts.fixPronunciation')).toBe(false);

    act(() => {
      useStageStore.getState().setMode('edit');
    });

    await findText('edit.timeline.addAction');
    expect(hasText('edit.cue.speech')).toBe(true);
    expect(hasLabel('edit.tts.fixPronunciation')).toBe(true);
  });

  it('does not gate pronunciation repair on narration work in another scene', async () => {
    const current = makeSyncedScene();
    const unrelated = {
      ...makeSyncedScene(),
      id: 'scene-2',
      order: 2,
      outlineId: 'outline-2',
      narrationStatus: 'running' as const,
    };
    setupStores(current, [current, unrelated]);

    mountActionsBar();
    await findText('edit.timeline.addAction');

    expect(requiredButton('edit.tts.fixPronunciation').disabled).toBe(false);
  });

  it('keeps pronunciation repair visible but disabled for its own pending audio', async () => {
    const scene = {
      ...makeSyncedScene(),
      narrationStatus: 'running' as const,
      actions: [speech('speech-1', 'Narration still generating.', '')],
    };
    setupStores(scene);

    mountActionsBar();
    await findText('edit.timeline.addAction');

    const repair = requiredButton('edit.tts.fixPronunciation');
    expect(repair.disabled).toBe(true);
    expect(repair.title).toBe('edit.tts.pronunciationVoicePending');
  });

  it('opens pronunciation repair for the exact narration action card', async () => {
    const scene = {
      ...makeSyncedScene(),
      actions: [
        speech('speech-1', 'First narration.', 'audio-first'),
        speech('speech-2', 'Hinduism, Buddhism, and Jainism.', 'audio-second'),
      ],
    };
    setupStores(scene);

    mountActionsBar();
    await findText('edit.timeline.addAction');
    const controls = mounted?.container.querySelectorAll(
      '[aria-label="edit.tts.fixPronunciation"]',
    );
    expect(controls).toHaveLength(2);

    act(() => (controls?.[1] as HTMLButtonElement).click());

    await waitForCondition(
      () =>
        document.querySelector('[data-testid="pronunciation-original-text"]')?.textContent ===
        'Hinduism, Buddhism, and Jainism.',
    );
  });

  it('exposes pronunciation repair for Teaching Voice without the generic TTS toggle', async () => {
    const scene = makeSyncedScene();
    setupStores(scene);
    useStageStore.setState((state) => ({
      stage: state.stage ? { ...state.stage, teacherVoiceProfileId: 'faculty-voice' } : state.stage,
    }));
    useSettingsStore.setState({ ttsEnabled: false });

    mountActionsBar();
    await findText('edit.timeline.addAction');

    expect(hasLabel('edit.tts.fixPronunciation')).toBe(true);
  });

  it('ignores unrelated settings updates without entering an external-store loop', async () => {
    mountActionsBar();
    await findText('edit.timeline.addAction');

    act(() => {
      useSettingsStore.setState({ chatAreaWidth: 444 });
    });

    await findText('edit.timeline.addAction');
  });

  it('updates audio fingerprint inputs when the stage language changes', async () => {
    mountActionsBar();
    await findText('edit.timeline.addAction');
    expect(hasText('edit.timeline.audioStale')).toBe(false);

    act(() => {
      useStageStore.setState((state) => ({
        stage: state.stage ? { ...state.stage, languageDirective: 'Spanish' } : state.stage,
      }));
    });

    await findText('edit.timeline.audioStale');
    expect(hasLabel('edit.timeline.regenSlideAudio')).toBe(true);
    expect(hasLabel('edit.timeline.syncAllStale')).toBe(true);
  });

  it('updates audio fingerprint inputs when provider model and speed change', async () => {
    mountActionsBar();
    await findText('edit.timeline.addAction');
    expect(hasText('edit.timeline.audioStale')).toBe(false);

    act(() => {
      useSettingsStore.setState((state) => ({
        ttsSpeed: 1.25,
        ttsProvidersConfig: {
          ...state.ttsProvidersConfig,
          'openai-tts': {
            ...state.ttsProvidersConfig['openai-tts'],
            modelId: 'tts-model-b',
          },
        },
      }));
    });

    await findText('edit.timeline.audioStale');
    await findText('edit.tts.statusReady');
    expect(hasLabel('edit.tts.regenerate')).toBe(true);
  });

  it('renders stale narration and audio controls', async () => {
    setupStores(makeAudioStaleScene());

    mountActionsBar();

    await findText('edit.timeline.audioStale');
    expect(hasText('edit.timeline.regenAudio')).toBe(true);
    expect(hasText('edit.timeline.syncAll')).toBe(true);
  });

  it('syncs stale narration from the latest edited slide content and passes returned narration to TTS', async () => {
    const scene = makeManualEditedStaleScene();
    const generated = { ...scene, actions: [speech('speech-1', NEW_NARRATION, '')] };
    const generation = deferredPromise<unknown>();
    mocks.fetchSceneActions.mockReturnValueOnce(generation.promise);
    setupStores(scene);

    mountActionsBar();
    await findText('edit.timeline.narrationStale');

    await act(async () => {
      requiredButton('edit.timeline.syncNarrationAudio').click();
      requiredButton('edit.timeline.syncNarrationAudio').click();
      await Promise.resolve();
    });

    expect(mocks.fetchSceneActions).toHaveBeenCalledTimes(1);
    expect(getScene('scene-1').sync?.status).toBe('syncing');

    const request = mocks.fetchSceneActions.mock.calls[0][0] as {
      content: { narrationSource?: { text?: string } };
      previousSpeeches?: string[];
    };
    const requestSource = JSON.stringify(request.content);
    const narrationSourceText = request.content.narrationSource?.text ?? '';
    expect(narrationSourceText).toContain('Minimizing Efficiency');
    expect(narrationSourceText).not.toContain('Maximizing Efficiency');
    expect(narrationSourceText).not.toContain('Better Resource Utilization');
    expect(narrationSourceText).not.toContain('Faster Execution');
    expect(narrationSourceText).not.toContain(OLD_NARRATION);
    expect(narrationSourceText).not.toContain('text-');
    expect(narrationSourceText).not.toContain('width');
    expect(requestSource).toContain('Minimizing Efficiency');
    expect(requestSource).not.toContain('Maximizing Efficiency');
    expect(requestSource).not.toContain('Better Resource Utilization');
    expect(requestSource).not.toContain('Faster Execution');
    expect(requestSource).not.toContain(OLD_NARRATION);
    expect(request.previousSpeeches).toEqual([]);
    expect(mocks.regenerateSpeechAudio).not.toHaveBeenCalled();

    await act(async () => {
      generation.resolve({ success: true, scene: generated });
      await generation.promise;
    });
    await waitForCondition(() => mocks.regenerateSpeechAudio.mock.calls.length === 1);

    expect(mocks.regenerateSpeechAudio).toHaveBeenCalledTimes(1);
    expect(mocks.regenerateSpeechAudio.mock.calls[0][1]).toMatchObject({
      id: 'speech-1',
      text: NEW_NARRATION,
    });
    expect(mocks.regenerateSpeechAudio.mock.calls[0][1]).not.toMatchObject({
      text: OLD_NARRATION,
    });

    const updated = getScene('scene-1');
    const updatedActions = updated.actions ?? [];
    expect(updatedActions).toEqual([
      expect.objectContaining({
        id: 'speech-1',
        text: NEW_NARRATION,
        audioId: 'tts_speech-1',
      }),
    ]);
    expect(updated.sync?.narrationSourceFingerprint).toBe(
      buildNarrationSourceFromScene(updated).fingerprint,
    );
    expect(updated.sync?.audioSourceFingerprint).toBe(
      getAudioSourceFingerprint(updated, TTS_SETTINGS),
    );
    expect(getNarrationSyncState(updated, TTS_SETTINGS).status).toBe('synced');
  });

  it('regenerates audio from current narration without calling narration generation', async () => {
    setupStores(makeAudioStaleScene());

    mountActionsBar();
    await findText('edit.timeline.audioStale');

    await act(async () => {
      requiredButton('edit.timeline.regenSlideAudio').click();
      await Promise.resolve();
    });
    await waitForCondition(() => mocks.regenerateSpeechAudio.mock.calls.length === 1);

    expect(mocks.fetchSceneActions).not.toHaveBeenCalled();
    expect(mocks.regenerateSpeechAudio.mock.calls[0][1]).toMatchObject({
      id: 'speech-1',
      text: 'Explain shared memory',
    });
    expect(getNarrationSyncState(getScene('scene-1'), TTS_SETTINGS).status).toBe('synced');
  });

  it('keeps narration stale when generation returns the exact old narration for changed slide content', async () => {
    const scene = makeManualEditedStaleScene();
    mocks.fetchSceneActions.mockResolvedValue({
      success: true,
      scene: { ...scene, actions: [speech('speech-1', OLD_NARRATION, '')] },
    });
    setupStores(scene);

    mountActionsBar();
    await findText('edit.timeline.narrationStale');

    await act(async () => {
      requiredButton('edit.timeline.syncNarrationAudio').click();
      await Promise.resolve();
    });
    await waitForCondition(() =>
      Boolean(getScene('scene-1').sync?.error?.includes('unchanged narration')),
    );

    const unchanged = getScene('scene-1');
    expect(mocks.fetchSceneActions).toHaveBeenCalledTimes(1);
    expect(mocks.regenerateSpeechAudio).not.toHaveBeenCalled();
    expect(unchanged.actions).toEqual([
      expect.objectContaining({
        id: 'speech-1',
        text: OLD_NARRATION,
        audioId: 'tts_speech_1',
      }),
    ]);
    expect(unchanged.sync?.error).toContain('unchanged narration');
    expect(getNarrationSyncState(unchanged, TTS_SETTINGS).status).toBe('narration-stale');
  });

  it('uses local editor slide content before a remote save can replace the persisted scene', async () => {
    const persisted = makeManualInitialScene();
    const localEdit = makeManualEditedStaleScene();
    expect(buildNarrationSourceFromScene(persisted).text).toContain('Maximizing Efficiency');
    mocks.fetchSceneActions.mockResolvedValue({
      success: true,
      scene: { ...localEdit, actions: [speech('speech-1', NEW_NARRATION, '')] },
    });
    setupStores(localEdit);

    mountActionsBar();
    await findText('edit.timeline.narrationStale');

    await act(async () => {
      requiredButton('edit.timeline.syncNarrationAudio').click();
      await Promise.resolve();
    });
    await waitForCondition(() => mocks.fetchSceneActions.mock.calls.length === 1);

    const requestContent = mocks.fetchSceneActions.mock.calls[0][0].content as {
      narrationSource?: { text?: string };
    };
    const narrationSourceText = requestContent.narrationSource?.text ?? '';
    expect(narrationSourceText).toContain('Minimizing Efficiency');
    expect(narrationSourceText).not.toContain('Maximizing Efficiency');
  });

  it('syncs swapped visual cards in spotlight target order without reordering elements', async () => {
    const scene = makeSwappedParallelismScene();
    mocks.fetchSceneActions.mockResolvedValue({
      success: true,
      scene: {
        ...scene,
        actions: [
          { id: 'new-spot-task', type: 'spotlight', elementId: 'task-card' },
          speech(
            'new-speech-task',
            'First, let us look at Task Parallelism and how independent tasks are scheduled.',
            '',
          ),
          { id: 'new-spot-data', type: 'spotlight', elementId: 'data-card' },
          speech(
            'new-speech-data',
            'Next, Data Parallelism applies the same operation across multiple data items.',
            '',
          ),
        ],
      },
    });
    setupStores(scene);

    expect(buildNarrationSourceFromScene(scene).visualBlocks.map((block) => block.text)).toEqual([
      'Task Parallelism',
      'Data Parallelism',
    ]);
    expect(getNarrationSyncState(scene, TTS_SETTINGS).status).toBe('narration-stale');

    mountActionsBar();
    await findText('edit.timeline.narrationStale');

    await act(async () => {
      requiredButton('edit.timeline.syncNarrationAudio').click();
      await Promise.resolve();
    });
    await waitForCondition(() => mocks.regenerateSpeechAudio.mock.calls.length === 2);

    const requestContent = mocks.fetchSceneActions.mock.calls[0][0].content as {
      narrationSource?: {
        text?: string;
        blocks?: Array<{ targetElementId: string; text: string }>;
      };
      choreography?: Array<{ targetElementId: string; targetText: string }>;
      elements?: Array<{ id: string }>;
    };
    expect(requestContent.narrationSource?.text).toMatch(/Task Parallelism[\s\S]*Data Parallelism/);
    expect(requestContent.narrationSource?.blocks?.[0]).toMatchObject({
      targetElementId: 'task-card',
      text: 'Task Parallelism',
    });
    expect(requestContent.narrationSource?.blocks?.[1]).toMatchObject({
      targetElementId: 'data-card',
      text: 'Data Parallelism',
    });
    expect(requestContent.choreography?.[0]).toMatchObject({
      targetElementId: 'task-card',
      targetText: 'Task Parallelism',
    });
    expect(requestContent.choreography?.[1]).toMatchObject({
      targetElementId: 'data-card',
      targetText: 'Data Parallelism',
    });

    expect(mocks.regenerateSpeechAudio.mock.calls[0][1]).toMatchObject({
      id: 'speech-task',
      text: 'First, let us look at Task Parallelism and how independent tasks are scheduled.',
    });
    expect(mocks.regenerateSpeechAudio.mock.calls[1][1]).toMatchObject({
      id: 'speech-data',
      text: 'Next, Data Parallelism applies the same operation across multiple data items.',
    });

    const updated = getScene('scene-1');
    const updatedActions = updated.actions ?? [];
    expect(updatedActions).toEqual([
      expect.objectContaining({ id: 'spot-task', type: 'spotlight', elementId: 'task-card' }),
      expect.objectContaining({
        id: 'speech-task',
        text: 'First, let us look at Task Parallelism and how independent tasks are scheduled.',
        audioId: 'tts_speech-task',
      }),
      expect.objectContaining({ id: 'spot-data', type: 'spotlight', elementId: 'data-card' }),
      expect.objectContaining({
        id: 'speech-data',
        text: 'Next, Data Parallelism applies the same operation across multiple data items.',
        audioId: 'tts_speech-data',
      }),
    ]);
    expect(new Set(updatedActions.map((action) => action.id)).size).toBe(updatedActions.length);
    expect(
      ((updated.content as { canvas: { elements: Array<{ id: string }> } }).canvas.elements ?? [])
        .map((element) => element.id)
        .slice(0, 2),
    ).toEqual(['data-card', 'task-card']);

    act(() => {
      mounted?.root.render(
        React.createElement(
          StrictMode,
          null,
          React.createElement(ActionsBar, { sceneId: 'scene-1' }),
        ),
      );
    });
    expect((getScene('scene-1').actions ?? []).map((action) => action.id)).toEqual([
      'spot-task',
      'speech-task',
      'spot-data',
      'speech-data',
    ]);
  });

  it('resolves each bulk stale scene by id when its queued turn starts', async () => {
    const sceneOne = makeManualEditedStaleScene({
      id: 'scene-1',
      order: 1,
      outlineId: 'outline-1',
    });
    const sceneTwo = makeManualEditedStaleScene({
      id: 'scene-2',
      order: 2,
      outlineId: 'outline-2',
      points: ['Queued First Edit'],
      speechId: 'speech-2',
      audioId: 'tts_speech_2',
    });
    const firstGeneration = deferredPromise<unknown>();
    mocks.fetchSceneActions.mockImplementation((request: { content: unknown }) => {
      const source = JSON.stringify(request.content);
      if (source.includes('Minimizing Efficiency')) return firstGeneration.promise;
      if (source.includes('Newest Queue Claim')) {
        return Promise.resolve({
          success: true,
          scene: { ...getScene('scene-2'), actions: [speech('speech-2', 'Newest narration', '')] },
        });
      }
      return Promise.resolve({
        success: true,
        scene: { ...getScene('scene-2'), actions: [speech('speech-2', 'Stale narration', '')] },
      });
    });
    setupStores(sceneOne, [sceneOne, sceneTwo]);

    mountActionsBar();
    await findText('edit.timeline.narrationStale');

    await act(async () => {
      requiredButton('edit.timeline.syncAllStale').click();
      await Promise.resolve();
    });
    await waitForCondition(() => mocks.fetchSceneActions.mock.calls.length === 1);

    act(() => {
      replaceScene(
        makeManualEditedStaleScene({
          id: 'scene-2',
          order: 2,
          outlineId: 'outline-2',
          points: ['Newest Queue Claim'],
          speechId: 'speech-2',
          audioId: 'tts_speech_2',
          sync: getScene('scene-2').sync,
        }),
      );
    });

    await act(async () => {
      firstGeneration.resolve({
        success: true,
        scene: { ...getScene('scene-1'), actions: [speech('speech-1', NEW_NARRATION, '')] },
      });
      await firstGeneration.promise;
    });
    await waitForCondition(() => mocks.fetchSceneActions.mock.calls.length === 2);

    const secondRequestContent = mocks.fetchSceneActions.mock.calls[1][0].content as {
      narrationSource?: { text?: string };
    };
    const secondRequestSource = secondRequestContent.narrationSource?.text ?? '';
    expect(secondRequestSource).toContain('Newest Queue Claim');
    expect(secondRequestSource).not.toContain('Queued First Edit');
  });

  it('uses latest swapped visual order when a bulk queued scene starts', async () => {
    const sceneOne = makeManualEditedStaleScene({
      id: 'scene-1',
      order: 1,
      outlineId: 'outline-1',
    });
    const sceneTwo = makeSwappedParallelismScene({
      id: 'scene-2',
      order: 2,
      outlineId: 'outline-2',
      dataLeft: 80,
      taskLeft: 560,
      sync: {
        status: 'narration-stale',
        narrationSourceFingerprint: 'previous-order',
        audioSourceFingerprint: 'previous-audio',
      },
    });
    const firstGeneration = deferredPromise<unknown>();
    mocks.fetchSceneActions.mockImplementation((request: { content: unknown }) => {
      const source = JSON.stringify(request.content);
      if (source.includes('Minimizing Efficiency')) return firstGeneration.promise;
      return Promise.resolve({
        success: true,
        scene: {
          ...getScene('scene-2'),
          actions: [
            { id: 'new-spot-task', type: 'spotlight', elementId: 'task-card' },
            speech('new-speech-task', 'Bulk Task narration.', ''),
            { id: 'new-spot-data', type: 'spotlight', elementId: 'data-card' },
            speech('new-speech-data', 'Bulk Data narration.', ''),
          ],
        },
      });
    });
    setupStores(sceneOne, [sceneOne, sceneTwo]);

    mountActionsBar();
    await findText('edit.timeline.narrationStale');

    await act(async () => {
      requiredButton('edit.timeline.syncAllStale').click();
      await Promise.resolve();
    });
    await waitForCondition(() => mocks.fetchSceneActions.mock.calls.length === 1);

    act(() => {
      replaceScene(
        makeSwappedParallelismScene({
          id: 'scene-2',
          order: 2,
          outlineId: 'outline-2',
          dataLeft: 560,
          taskLeft: 80,
          sync: getScene('scene-2').sync,
        }),
      );
    });

    await act(async () => {
      firstGeneration.resolve({
        success: true,
        scene: { ...getScene('scene-1'), actions: [speech('speech-1', NEW_NARRATION, '')] },
      });
      await firstGeneration.promise;
    });
    await waitForCondition(() => mocks.fetchSceneActions.mock.calls.length === 2);

    const secondRequestContent = mocks.fetchSceneActions.mock.calls[1][0].content as {
      narrationSource?: { text?: string; blocks?: Array<{ targetElementId: string }> };
    };
    expect(secondRequestContent.narrationSource?.text).toMatch(
      /Task Parallelism[\s\S]*Data Parallelism/,
    );
    expect(
      secondRequestContent.narrationSource?.blocks?.map((block) => block.targetElementId),
    ).toEqual(['task-card', 'data-card']);
  });

  it('emits visible bulk sync order checkpoints through the real Sync all stale click path', async () => {
    const scene = makeMpiConceptsScene();
    mocks.fetchSceneActions.mockResolvedValue({
      success: true,
      scene: {
        ...scene,
        actions: [
          { id: 'new-spot-communicators', type: 'spotlight', elementId: 'communicators-card' },
          speech('new-speech-communicators', 'Communicators narration.', ''),
          { id: 'new-spot-processes', type: 'spotlight', elementId: 'processes-card' },
          speech('new-speech-processes', 'Processes narration.', ''),
          { id: 'new-spot-rank', type: 'spotlight', elementId: 'rank-card' },
          speech('new-speech-rank', 'Rank narration.', ''),
        ],
      },
    });
    setupStores(scene);

    mountActionsBar();
    await findText('edit.timeline.narrationStale');

    await act(async () => {
      requiredButton('edit.timeline.syncAllStale').click();
      await Promise.resolve();
    });
    await waitForCondition(() => mocks.regenerateSpeechAudio.mock.calls.length === 3);

    const logs = narrationOrderLogs();
    expect(logs.map((payload) => payload.checkpoint)).toEqual(
      expect.arrayContaining([
        'bulk-queue',
        'current-scene',
        'elementArrayOrderFlat',
        'editedElementTextFlat',
        'visual-block-order',
        'visualBlockOrderFlat',
        'narrationSourceTextFlat',
        'generation-input-order',
        'generationInputOrderFlat',
        'generated-action-order',
        'generatedActionOrderFlat',
        'final-action-order',
        'finalActionOrderFlat',
        'saved-action-order',
        'savedActionOrderFlat',
        'tts-input-order',
        'ttsInputOrderFlat',
      ]),
    );
    expect(logs.slice(0, 8).map((payload) => payload.checkpoint)).toEqual([
      'bulk-queue',
      'current-scene',
      'elementArrayOrderFlat',
      'editedElementTextFlat',
      'sync-decision',
      'syncDecisionFlat',
      'visual-block-order',
      'visualBlockOrderFlat',
    ]);
    expect(logs.slice(8, 10).map((payload) => payload.checkpoint)).toEqual([
      'narrationSourceTextFlat',
      'generation-input-order',
    ]);
    expect(logs[0].sceneIds).toEqual(['scene-1']);

    const currentScene = checkpoint(logs, 'current-scene');
    expect(currentScene.sceneFound).toBe(true);
    expect(textPreviewOrder(currentScene.elementArrayOrder)).toEqual([
      'Processes',
      'Communicators',
      'Rank',
    ]);

    expect(textPreviewOrder(checkpoint(logs, 'visual-block-order').blocks)).toEqual([
      'Communicators',
      'Processes',
      'Rank',
    ]);
    expect(textPreviewOrder(checkpoint(logs, 'generation-input-order').targets)).toEqual([
      'Communicators',
      'Processes',
      'Rank',
    ]);
    expect(targetActionOrder(checkpoint(logs, 'generated-action-order').actions)).toEqual([
      'communicators-card',
      'processes-card',
      'rank-card',
    ]);
    expect(targetActionOrder(checkpoint(logs, 'final-action-order').actions)).toEqual([
      'communicators-card',
      'processes-card',
      'rank-card',
    ]);
    expect(targetActionOrder(checkpoint(logs, 'saved-action-order').actions)).toEqual([
      'communicators-card',
      'processes-card',
      'rank-card',
    ]);
    expect(checkpoint(logs, 'tts-input-order').speechPreviews).toEqual([
      'Communicators narration.',
      'Processes narration.',
      'Rank narration.',
    ]);
    expect(checkpoint(logs, 'visualBlockOrderFlat').order).toEqual([
      '0:communicators-card:communicators-card:Communicators',
      '1:processes-card:processes-card:Processes',
      '2:rank-card:rank-card:Rank',
    ]);
    expect(checkpoint(logs, 'ttsInputOrderFlat').order).toEqual([
      '0:speech-communicators:Communicators narration.',
      '1:speech-processes:Processes narration.',
      '2:speech-rank:Rank narration.',
    ]);
  });

  it('syncs Collective Communication from current edited text and visual target order', async () => {
    const scene = makeCollectiveCommunicationScene();
    const reduce = slideElements(scene).find((element) => element.id === 'reduce-card');
    expect(reduce ? getVisibleElementText(reduce) : '').toBe('MPI_Reduce One to Many');
    expect(buildNarrationSourceFromScene(scene).text).toContain('One to Many');
    expect(buildNarrationSourceFromScene(scene).text).not.toContain('Many to One');

    mocks.fetchSceneActions.mockResolvedValue({
      success: true,
      scene: {
        ...scene,
        actions: [
          { id: 'new-spot-bcast', type: 'spotlight', elementId: 'bcast-card' },
          speech('new-speech-bcast', 'MPI_Bcast broadcasts data from one process to many.', ''),
          { id: 'new-spot-reduce', type: 'spotlight', elementId: 'reduce-card' },
          speech('new-speech-reduce', 'MPI_Reduce now shows One to Many communication.', ''),
          { id: 'new-spot-allreduce', type: 'spotlight', elementId: 'allreduce-card' },
          speech('new-speech-allreduce', 'MPI_Allreduce combines and shares results.', ''),
        ],
      },
    });
    setupStores(scene);

    mountActionsBar();
    await findText('edit.timeline.narrationStale');

    await act(async () => {
      requiredButton('edit.timeline.syncAllStale').click();
      await Promise.resolve();
    });
    await waitForCondition(() => mocks.regenerateSpeechAudio.mock.calls.length === 3);

    const requestContent = mocks.fetchSceneActions.mock.calls[0][0].content as {
      narrationSource?: {
        text?: string;
        blocks?: Array<{ targetElementId: string; text: string }>;
      };
      choreography?: Array<{ targetElementId: string; targetText: string }>;
    };
    expect(requestContent.narrationSource?.text).toContain('One to Many');
    expect(requestContent.narrationSource?.text).not.toContain('Many to One');
    expect(requestContent.narrationSource?.text).not.toContain('previous Bcast narration');
    expect(requestContent.narrationSource?.blocks?.map((block) => block.targetElementId)).toEqual([
      'allreduce-card',
      'bcast-card',
      'reduce-card',
    ]);
    expect(requestContent.choreography?.map((block) => block.targetElementId)).toEqual([
      'allreduce-card',
      'bcast-card',
      'reduce-card',
    ]);

    const logs = narrationOrderLogs();
    expect(flatText(checkpoint(logs, 'elementArrayOrderFlat'))).toEqual([
      '0:bcast-card:400:150:MPI_Bcast Broadcast',
      '1:reduce-card:700:150:MPI_Reduce One to Many',
      '2:allreduce-card:100:150:MPI_Allreduce Combine and share',
    ]);
    expect(flatTargets(checkpoint(logs, 'generationInputOrderFlat'))).toEqual([
      'allreduce-card',
      'bcast-card',
      'reduce-card',
    ]);
    expect(targetActionOrder(checkpoint(logs, 'generated-action-order').actions)).toEqual([
      'bcast-card',
      'reduce-card',
      'allreduce-card',
    ]);
    expect(targetActionOrder(checkpoint(logs, 'final-action-order').actions)).toEqual([
      'allreduce-card',
      'bcast-card',
      'reduce-card',
    ]);
    expect(targetActionOrder(checkpoint(logs, 'saved-action-order').actions)).toEqual([
      'allreduce-card',
      'bcast-card',
      'reduce-card',
    ]);
    expect(checkpoint(logs, 'tts-input-order').speechPreviews).toEqual([
      'MPI_Allreduce combines and shares results.',
      'MPI_Bcast broadcasts data from one process to many.',
      'MPI_Reduce now shows One to Many communication.',
    ]);

    expect(mocks.regenerateSpeechAudio.mock.calls.map((call) => call[1].id)).toEqual([
      'speech-allreduce',
      'speech-bcast',
      'speech-reduce',
    ]);
    expect(
      mocks.regenerateSpeechAudio.mock.calls.map((call) => (call[1] as { text?: string }).text),
    ).toEqual([
      'MPI_Allreduce combines and shares results.',
      'MPI_Bcast broadcasts data from one process to many.',
      'MPI_Reduce now shows One to Many communication.',
    ]);

    const updated = getScene('scene-1');
    const updatedActions = updated.actions ?? [];
    expect(targetActionOrder(updatedActions)).toEqual([
      'allreduce-card',
      'bcast-card',
      'reduce-card',
    ]);
    expect(updatedActions.map((action) => action.id)).toEqual([
      'spot-allreduce',
      'speech-allreduce',
      'spot-bcast',
      'speech-bcast',
      'spot-reduce',
      'speech-reduce',
    ]);
    expect(new Set(updatedActions.map((action) => action.id)).size).toBe(updatedActions.length);
    expect(speechTextsForTest(updated)).toContain(
      'MPI_Reduce now shows One to Many communication.',
    );
    expect(buildNarrationSourceFromScene(updated).text).toContain('One to Many');
    expect(buildNarrationSourceFromScene(updated).text).not.toContain('Many to One');
  });

  it('sync all stale regenerates narration when source and audio are both stale', async () => {
    const scene = makeRealCollectiveCommunicationScene();
    const source = buildNarrationSourceFromScene(scene);
    const decision = resolveNarrationSyncDecision(scene, TTS_SETTINGS, source);
    expect(decision.narrationSourceChanged).toBe(true);
    expect(decision.audioChanged).toBe(true);
    expect(decision.resolvedStaleState).toBe('narration-stale');
    expect(decision.operation).toBe('narration-and-audio');
    expect(
      source.text.split('\n').filter((line) => line === 'Collective Communication'),
    ).toHaveLength(1);

    const firstTts = deferredPromise<void>();
    mocks.fetchSceneActions.mockResolvedValue({
      success: true,
      scene: {
        ...scene,
        actions: [
          speech('new-intro', 'New intro narration.', ''),
          { id: 'new-spot-bcast', type: 'spotlight', elementId: 'shape__e9Y6KFe' },
          speech('new-speech-bcast', 'New Bcast narration.', ''),
          { id: 'new-spot-reduce', type: 'spotlight', elementId: 'shape_Lm0L-5Qw' },
          speech('new-speech-reduce', 'MPI_Reduce now explains One to Many communication.', ''),
          { id: 'new-spot-allreduce', type: 'spotlight', elementId: 'shape_bcGuzJCR' },
          speech('new-speech-allreduce', 'New Allreduce narration.', ''),
          speech('new-outro', 'New outro narration.', ''),
        ],
      },
    });
    mocks.regenerateSpeechAudio.mockImplementation(
      async (_sceneOrder: number, action: { id: string }) => {
        if (action.id === 'new-intro') await firstTts.promise;
        return action.id;
      },
    );
    setupStores(scene);

    mountActionsBar();
    await findText('edit.timeline.narrationStale');

    await act(async () => {
      requiredButton('edit.timeline.syncAllStale').click();
      requiredButton('edit.timeline.syncAllStale').click();
      await Promise.resolve();
    });
    await waitForCondition(() => mocks.regenerateSpeechAudio.mock.calls.length === 1);

    const midSync = getScene('scene-1');
    expect(midSync.sync?.status).toBe('audio-stale');
    expect(midSync.sync?.narrationSourceFingerprint).toBe(source.fingerprint);
    expect(speechTextsForTest(midSync)).toContain(
      'MPI_Reduce now explains One to Many communication.',
    );

    await act(async () => {
      firstTts.resolve();
      await firstTts.promise;
    });
    await waitForCondition(() => mocks.regenerateSpeechAudio.mock.calls.length === 5);

    expect(mocks.fetchSceneActions).toHaveBeenCalledTimes(1);
    const requestContent = mocks.fetchSceneActions.mock.calls[0][0].content as {
      narrationSource?: {
        text?: string;
        fingerprint?: string;
        blocks?: Array<{ targetElementId: string; text: string }>;
      };
      choreography?: Array<{ targetElementId: string; targetText: string }>;
    };
    expect(requestContent.narrationSource?.fingerprint).toBe(source.fingerprint);
    expect(requestContent.narrationSource?.text).toContain('MPI_Reduce One to Many!!!!!');
    expect(requestContent.narrationSource?.text).toContain('Root at ALL!');
    expect(requestContent.narrationSource?.text).not.toContain('MPI_Reduce Many to One');
    expect(requestContent.narrationSource?.text).not.toContain('previous Reduce Many-to-One');
    expect(requestContent.narrationSource?.blocks?.map((block) => block.targetElementId)).toEqual([
      'text_PbN67VXO',
      'text_yjG429Ep',
      'text_NNGyLVuj',
    ]);
    expect(requestContent.choreography?.map((block) => block.targetElementId)).toEqual([
      'text_PbN67VXO',
      'text_yjG429Ep',
      'text_NNGyLVuj',
    ]);

    const logs = narrationOrderLogs();
    expect(checkpoint(logs, 'sync-decision')).toMatchObject({
      narrationSourceChanged: true,
      audioChanged: true,
      resolvedStaleState: 'narration-stale',
      chosenOperation: 'narration-and-audio',
      hasExistingNarration: true,
      hasExistingAudio: true,
    });
    expect(checkpoint(logs, 'syncDecisionFlat').order).toEqual([
      'narrationSourceChanged:true',
      'audioChanged:true',
      'state:narration-stale',
      'operation:narration-and-audio',
      'hasNarration:true',
      'hasAudio:true',
    ]);
    expect(flatTargets(checkpoint(logs, 'generationInputOrderFlat'))).toEqual([
      'text_PbN67VXO',
      'text_yjG429Ep',
      'text_NNGyLVuj',
    ]);
    expect(targetActionOrder(checkpoint(logs, 'generated-action-order').actions)).toEqual([
      'shape__e9Y6KFe',
      'shape_Lm0L-5Qw',
      'shape_bcGuzJCR',
    ]);
    expect(targetActionOrder(checkpoint(logs, 'final-action-order').actions)).toEqual([
      'text_PbN67VXO',
      'text_yjG429Ep',
      'text_NNGyLVuj',
    ]);
    expect(flatActionTargets(checkpoint(logs, 'savedActionOrderFlat'))).toEqual([
      'text_PbN67VXO',
      'text_yjG429Ep',
      'text_NNGyLVuj',
    ]);
    expect(flatActionTargets(checkpoint(logs, 'timelineActionOrderFlat'))).toEqual([
      'text_PbN67VXO',
      'text_yjG429Ep',
      'text_NNGyLVuj',
    ]);
    expect(checkpoint(logs, 'tts-input-order').speechPreviews).toEqual([
      'New intro narration.',
      'New Allreduce narration.',
      'New Bcast narration.',
      'MPI_Reduce now explains One to Many communication.',
      'New outro narration.',
    ]);
    expect(checkpoint(logs, 'sync-completed').sceneId).toBe('scene-1');

    expect(
      mocks.regenerateSpeechAudio.mock.calls.map((call) => (call[1] as { text?: string }).text),
    ).toEqual([
      'New intro narration.',
      'New Allreduce narration.',
      'New Bcast narration.',
      'MPI_Reduce now explains One to Many communication.',
      'New outro narration.',
    ]);
    expect(
      mocks.regenerateSpeechAudio.mock.calls.map((call) => (call[1] as { text?: string }).text),
    ).not.toContain('previous Reduce Many-to-One narration');

    const updated = getScene('scene-1');
    expect(targetActionOrder(updated.actions ?? [])).toEqual([
      'text_PbN67VXO',
      'text_yjG429Ep',
      'text_NNGyLVuj',
    ]);
    expect((updated.actions ?? []).map((action) => action.id).slice(1, -1)).toEqual([
      'spot-allreduce',
      'speech-allreduce',
      'spot-bcast',
      'speech-bcast',
      'spot-reduce',
      'speech-reduce',
    ]);
    expect((updated.actions?.[0] as { text?: string }).text).toBe('New intro narration.');
    expect((updated.actions?.at(-1) as { text?: string }).text).toBe('New outro narration.');
    expect(new Set((updated.actions ?? []).map((action) => action.id)).size).toBe(
      updated.actions?.length,
    );
    expect(speechTextsForTest(updated).split('\n')).toEqual([
      'New intro narration.',
      'New Allreduce narration.',
      'New Bcast narration.',
      'MPI_Reduce now explains One to Many communication.',
      'New outro narration.',
    ]);
    expect(updated.sync?.narrationSourceFingerprint).toBe(source.fingerprint);
    expect(updated.sync?.audioSourceFingerprint).toBe(
      getAudioSourceFingerprint(updated, TTS_SETTINGS),
    );
    expect(getNarrationSyncState(updated, TTS_SETTINGS).status).toBe('synced');
  });

  it('keeps Memory Hierarchy generated text targets separate from broad card ordering blocks', async () => {
    const scene = makeMemoryHierarchyScene();
    mocks.fetchSceneActions.mockResolvedValue({
      success: true,
      scene: {
        ...scene,
        actions: [
          { id: 'new-spot-private', type: 'spotlight', elementId: 'private-list' },
          speech('new-speech-private', 'Private scope includes thread stack and registers.', ''),
          { id: 'new-spot-shared', type: 'spotlight', elementId: 'shared-list' },
          speech('new-speech-shared', 'Shared scope includes heap memory and global vars.', ''),
        ],
      },
    });
    setupStores(scene);

    mountActionsBar();
    await findText('edit.timeline.narrationStale');

    await act(async () => {
      requiredButton('edit.timeline.syncAllStale').click();
      requiredButton('edit.timeline.syncAllStale').click();
      await Promise.resolve();
    });
    await waitForCondition(() => mocks.regenerateSpeechAudio.mock.calls.length === 2);

    expect(mocks.fetchSceneActions).toHaveBeenCalledTimes(1);
    const logs = spotlightTargetLogs();
    expect(flatTargets(checkpoint(logs, 'generatedSpotlightTargetsFlat'))).toEqual([
      'private-list',
      'shared-list',
    ]);
    expect(flatTargets(checkpoint(logs, 'finalSavedSpotlightTargetsFlat'))).toEqual([
      'shared-list',
      'private-list',
    ]);
    expect(flatTargets(checkpoint(logs, 'canonicalSpotlightBlocksFlat'))).toEqual([
      'shared-card',
      'private-card',
    ]);

    const updated = getScene('scene-1');
    expect(targetActionOrder(updated.actions ?? [])).toEqual(['shared-list', 'private-list']);
    expect(targetActionOrder(updated.actions ?? [])).not.toEqual(['shared-card', 'private-card']);
    expect(targetAreaRatioForTest(updated, 'shared-list')).toBeLessThan(0.18);
    expect(targetAreaRatioForTest(updated, 'private-list')).toBeLessThan(0.18);
    expect(getNarrationSyncState(updated, TTS_SETTINGS).status).toBe('synced');
  });

  it('keeps Runtime environment variable targets precise after visual reordering', async () => {
    const scene = makeRuntimeEnvironmentScene();
    mocks.fetchSceneActions.mockResolvedValue({
      success: true,
      scene: {
        ...scene,
        actions: [
          { id: 'new-spot-env', type: 'spotlight', elementId: 'environment-list' },
          speech('new-speech-env', 'Environment variables include OMP_NUM_THREADS.', ''),
          { id: 'new-spot-tuning', type: 'spotlight', elementId: 'advanced-tuning-list' },
          speech('new-speech-tuning', 'Advanced tuning adjusts dynamic behavior and affinity.', ''),
          { id: 'new-spot-lib', type: 'spotlight', elementId: 'library-list' },
          speech('new-speech-lib', 'Library functions report and set OpenMP thread counts.', ''),
        ],
      },
    });
    setupStores(scene);

    mountActionsBar();
    await findText('edit.timeline.narrationStale');

    await act(async () => {
      requiredButton('edit.timeline.syncAllStale').click();
      await Promise.resolve();
    });
    await waitForCondition(() => mocks.regenerateSpeechAudio.mock.calls.length === 3);

    const logs = spotlightTargetLogs();
    expect(flatTargets(checkpoint(logs, 'generatedSpotlightTargetsFlat'))).toEqual([
      'environment-list',
      'advanced-tuning-list',
      'library-list',
    ]);
    expect(flatTargets(checkpoint(logs, 'finalSavedSpotlightTargetsFlat'))).toEqual([
      'library-list',
      'environment-list',
      'advanced-tuning-list',
    ]);
    expect(flatTargets(checkpoint(logs, 'canonicalSpotlightBlocksFlat'))).toEqual([
      'library-card',
      'environment-card',
      'advanced-tuning-block',
    ]);

    const updated = getScene('scene-1');
    expect(targetActionOrder(updated.actions ?? [])).toEqual([
      'library-list',
      'environment-list',
      'advanced-tuning-list',
    ]);
    expect(targetActionOrder(updated.actions ?? [])).not.toContain('slide-root');
    expect(targetActionOrder(updated.actions ?? [])).not.toContain('library-card');
    expect(targetActionOrder(updated.actions ?? [])).not.toContain('environment-card');
    expect(targetAreaRatioForTest(updated, 'library-list')).toBeLessThan(0.18);
    expect(targetAreaRatioForTest(updated, 'environment-list')).toBeLessThan(0.18);
    expect(targetAreaRatioForTest(updated, 'advanced-tuning-list')).toBeLessThan(0.18);
  });

  it('keeps a newer source stale when a scene changes during narration generation', async () => {
    const scene = makeManualEditedStaleScene();
    const generation = deferredPromise<unknown>();
    mocks.fetchSceneActions.mockReturnValue(generation.promise);
    setupStores(scene);

    mountActionsBar();
    await findText('edit.timeline.narrationStale');

    await act(async () => {
      requiredButton('edit.timeline.syncNarrationAudio').click();
      await Promise.resolve();
    });
    await waitForCondition(() => mocks.fetchSceneActions.mock.calls.length === 1);

    act(() => {
      replaceScene(
        makeManualEditedStaleScene({
          points: ['Newest semantic edit'],
          sync: getScene('scene-1').sync,
        }),
      );
    });

    await act(async () => {
      generation.resolve({
        success: true,
        scene: { ...scene, actions: [speech('speech-1', NEW_NARRATION, '')] },
      });
      await generation.promise.catch(() => undefined);
    });
    await waitForCondition(() =>
      Boolean(getScene('scene-1').sync?.error?.includes('Scene changed')),
    );

    const updated = getScene('scene-1');
    expect(mocks.regenerateSpeechAudio).not.toHaveBeenCalled();
    expect(buildNarrationSourceFromScene(updated).text).toContain('Newest semantic edit');
    expect(updated.sync?.status).toBe('narration-stale');
    expect(getNarrationSyncState(updated, TTS_SETTINGS).status).toBe('narration-stale');
    expect(updated.sync?.narrationSourceFingerprint).not.toBe(
      buildNarrationSourceFromScene(updated).fingerprint,
    );
    expect(checkpoint(narrationOrderLogs(), 'sync-failed')).toMatchObject({
      sceneId: 'scene-1',
      stage: 'pre-save-source-check',
      errorName: 'Error',
    });
  });

  it('emits a sync failure checkpoint when generation stops after input logging', async () => {
    const scene = makeManualEditedStaleScene();
    mocks.fetchSceneActions.mockRejectedValue(new Error('generator unavailable'));
    setupStores(scene);

    mountActionsBar();
    await findText('edit.timeline.narrationStale');

    await act(async () => {
      requiredButton('edit.timeline.syncNarrationAudio').click();
      await Promise.resolve();
    });
    await waitForCondition(() => Boolean(getScene('scene-1').sync?.error));

    const logs = narrationOrderLogs();
    expect(checkpoint(logs, 'generationInputOrderFlat')).toBeTruthy();
    expect(checkpoint(logs, 'sync-failed')).toMatchObject({
      sceneId: 'scene-1',
      stage: 'generation',
      errorName: 'Error',
    });
    expect(logs.some((payload) => payload.checkpoint === 'sync-completed')).toBe(false);
    expect(getNarrationSyncState(getScene('scene-1'), TTS_SETTINGS).status).toBe('error');
  });
});

function mountActionsBar() {
  mount(
    React.createElement(StrictMode, null, React.createElement(ActionsBar, { sceneId: 'scene-1' })),
  );
}

function mount(node: React.ReactNode) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  mounted = { root, container };
}

function EditModeHarness({ sceneId }: { sceneId: string }) {
  const mode = useStageStore((state) => state.mode);
  return mode === 'edit' ? React.createElement(ActionsBar, { sceneId }) : null;
}

function setupStores(scene: Scene, scenes: Scene[] = [scene]) {
  useStageStore.setState({
    stage: {
      id: 'stage-1',
      name: 'Stage',
      description: 'Stage',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      languageDirective: 'English',
    } satisfies Stage,
    scenes,
    currentSceneId: scene.id,
    mode: 'edit',
    outlines: scenes.map((item) => ({
      id: item.outlineId ?? `outline-${item.order}`,
      title: item.title,
      description: item.title,
      keyPoints: [item.title],
      order: item.order,
      type: 'slide',
    })),
  });
  useSettingsStore.setState((state) => ({
    ttsEnabled: true,
    ttsProviderId: 'openai-tts',
    ttsVoice: 'alloy',
    ttsSpeed: 1,
    selectedAgentIds: [],
    ttsProvidersConfig: {
      ...state.ttsProvidersConfig,
      'openai-tts': {
        ...state.ttsProvidersConfig['openai-tts'],
        modelId: 'tts-model-a',
      },
    },
  }));
}

function makeSyncedScene(): Scene {
  const scene = sceneFixture();
  return {
    ...scene,
    sync: syncedNarrationMetadata(scene, TTS_SETTINGS),
  };
}

function makeAudioStaleScene(): Scene {
  const scene = sceneFixture();
  return {
    ...scene,
    sync: staleAudioMetadata(scene, TTS_SETTINGS),
  };
}

function makeSwappedParallelismScene(
  options: {
    id?: string;
    order?: number;
    outlineId?: string;
    dataLeft?: number;
    taskLeft?: number;
    sync?: Scene['sync'];
  } = {},
): Scene {
  const initial = parallelismScene({
    id: options.id,
    order: options.order,
    outlineId: options.outlineId,
    dataLeft: 80,
    taskLeft: 560,
  });
  const swapped = parallelismScene({
    id: options.id,
    order: options.order,
    outlineId: options.outlineId,
    dataLeft: options.dataLeft ?? 560,
    taskLeft: options.taskLeft ?? 80,
  });
  return {
    ...swapped,
    sync: options.sync ?? syncedNarrationMetadata(initial, TTS_SETTINGS),
  };
}

function parallelismScene(options: {
  id?: string;
  order?: number;
  outlineId?: string;
  dataLeft: number;
  taskLeft: number;
}): Scene {
  const id = options.id ?? 'scene-1';
  const order = options.order ?? 1;
  return makeScene(
    {
      id,
      stageId: 'stage-1',
      title: 'Data vs. Task Parallelism',
      order,
      outlineId: options.outlineId ?? `outline-${order}`,
      actions: [
        { id: 'spot-data', type: 'spotlight', elementId: 'data-card' } as Action,
        speech('speech-data', 'First, let us look at Data Parallelism.', 'tts_speech_data'),
        { id: 'spot-task', type: 'spotlight', elementId: 'task-card' } as Action,
        speech(
          'speech-task',
          'Next, Task Parallelism schedules independent tasks.',
          'tts_speech_task',
        ),
      ],
    },
    {
      type: 'slide',
      canvas: {
        id: `${id}-canvas`,
        viewportSize: 1000,
        viewportRatio: 0.5625,
        theme: {
          backgroundColor: '#ffffff',
          themeColors: ['#5b9bd5'],
          fontColor: '#111111',
          fontName: 'Arial',
        },
        elements: [
          {
            id: 'data-card',
            type: 'text',
            left: options.dataLeft,
            top: 140,
            width: 340,
            height: 120,
            rotate: 0,
            content: '<h2>Data Parallelism</h2>',
            defaultFontName: 'Arial',
            defaultColor: '#111111',
          },
          {
            id: 'task-card',
            type: 'text',
            left: options.taskLeft,
            top: 140,
            width: 340,
            height: 120,
            rotate: 0,
            content: '<h2>Task Parallelism</h2>',
            defaultFontName: 'Arial',
            defaultColor: '#111111',
          },
        ],
      },
    },
  );
}

function makeMpiConceptsScene(): Scene {
  const initial = mpiConceptsScene({ processesLeft: 100, communicatorsLeft: 400, rankLeft: 700 });
  const edited = mpiConceptsScene({ processesLeft: 400, communicatorsLeft: 100, rankLeft: 700 });
  return {
    ...edited,
    sync: syncedNarrationMetadata(initial, TTS_SETTINGS),
  };
}

function mpiConceptsScene(layout: {
  processesLeft: number;
  communicatorsLeft: number;
  rankLeft: number;
}): Scene {
  return makeScene(
    {
      id: 'scene-1',
      stageId: 'stage-1',
      title: 'Core MPI Concepts',
      order: 1,
      outlineId: 'outline-1',
      actions: [
        { id: 'spot-processes', type: 'spotlight', elementId: 'processes-card' } as Action,
        speech('speech-processes', 'Processes old narration.', 'tts_processes'),
        { id: 'spot-communicators', type: 'spotlight', elementId: 'communicators-card' } as Action,
        speech('speech-communicators', 'Communicators old narration.', 'tts_communicators'),
        { id: 'spot-rank', type: 'spotlight', elementId: 'rank-card' } as Action,
        speech('speech-rank', 'Rank old narration.', 'tts_rank'),
      ],
    },
    {
      type: 'slide',
      canvas: {
        id: 'mpi-canvas',
        viewportSize: 1000,
        viewportRatio: 0.5625,
        theme: {
          backgroundColor: '#ffffff',
          themeColors: ['#5b9bd5'],
          fontColor: '#111111',
          fontName: 'Arial',
        },
        elements: [
          mpiTextElement('processes-card', 'Processes', layout.processesLeft),
          mpiTextElement('communicators-card', 'Communicators', layout.communicatorsLeft),
          mpiTextElement('rank-card', 'Rank', layout.rankLeft),
        ],
      },
    },
  );
}

function mpiTextElement(id: string, text: string, left: number) {
  return {
    id,
    type: 'text' as const,
    left,
    top: 150,
    width: 220,
    height: 96,
    rotate: 0,
    content: `<h2>${text}</h2>`,
    defaultFontName: 'Arial',
    defaultColor: '#111111',
  };
}

function makeCollectiveCommunicationScene(): Scene {
  const initial = collectiveCommunicationScene({
    bcastLeft: 100,
    reduceLeft: 400,
    allreduceLeft: 700,
    reduceText: 'Many to One',
  });
  const edited = collectiveCommunicationScene({
    bcastLeft: 400,
    reduceLeft: 700,
    allreduceLeft: 100,
    reduceText: 'One to Many',
  });
  return {
    ...edited,
    sync: syncedNarrationMetadata(initial, TTS_SETTINGS),
  };
}

function makeRealCollectiveCommunicationScene(): Scene {
  const previousSettings = { ...TTS_SETTINGS, ttsVoice: 'echo' };
  const initial = realCollectiveCommunicationScene({
    bcastLeft: 100,
    reduceLeft: 400,
    allreduceLeft: 700,
    reduceLines: ['Many to One', 'Root collects', 'Sum/Max/Min'],
    allreduceLines: ['Many-to-All', 'Reduction to all'],
  });
  const edited = realCollectiveCommunicationScene({
    bcastLeft: 400,
    reduceLeft: 700,
    allreduceLeft: 100,
    reduceLines: ['One to Many!!!!!', 'Root at ALL!', 'Sum/Max/Min'],
    allreduceLines: ['Many-to-All', 'Red. All to All'],
  });
  return {
    ...edited,
    sync: syncedNarrationMetadata(initial, previousSettings),
  };
}

function realCollectiveCommunicationScene(layout: {
  bcastLeft: number;
  reduceLeft: number;
  allreduceLeft: number;
  reduceLines: string[];
  allreduceLines: string[];
}): Scene {
  return makeScene(
    {
      id: 'scene-1',
      stageId: 'stage-1',
      title: 'Collective Communication',
      order: 1,
      outlineId: 'outline-1',
      actions: [
        speech('intro', 'Intro', 'tts_intro'),
        { id: 'spot-bcast', type: 'spotlight', elementId: 'text_yjG429Ep' } as Action,
        speech('speech-bcast', 'previous Bcast narration', 'tts_bcast'),
        { id: 'spot-reduce', type: 'spotlight', elementId: 'text_NNGyLVuj' } as Action,
        speech('speech-reduce', 'previous Reduce Many-to-One narration', 'tts_reduce'),
        { id: 'spot-allreduce', type: 'spotlight', elementId: 'text_PbN67VXO' } as Action,
        speech('speech-allreduce', 'previous Allreduce narration', 'tts_allreduce'),
        speech('outro', 'Outro', 'tts_outro'),
      ],
    },
    {
      type: 'slide',
      canvas: {
        id: 'collective-real-canvas',
        viewportSize: 1000,
        viewportRatio: 0.5625,
        theme: {
          backgroundColor: '#ffffff',
          themeColors: ['#5b9bd5'],
          fontColor: '#111111',
          fontName: 'Arial',
        },
        elements: [
          {
            id: 'collective-title',
            type: 'text',
            left: 80,
            top: 40,
            width: 760,
            height: 80,
            rotate: 0,
            content: '<h1>Collective Communication</h1>',
            defaultFontName: 'Arial',
            defaultColor: '#111111',
          },
          collectiveShapeElement('shape__e9Y6KFe', layout.bcastLeft),
          collectiveTextElement(
            'text_yjG429Ep',
            'MPI_Bcast',
            'One-to-All Source to All',
            layout.bcastLeft,
            'shape__e9Y6KFe',
          ),
          collectiveShapeElement('shape_Lm0L-5Qw', layout.reduceLeft),
          collectiveTextElement(
            'text_NNGyLVuj',
            'MPI_Reduce',
            layout.reduceLines.join(' '),
            layout.reduceLeft,
            'shape_Lm0L-5Qw',
          ),
          collectiveShapeElement('shape_bcGuzJCR', layout.allreduceLeft),
          collectiveTextElement(
            'text_PbN67VXO',
            'MPI_Allreduce',
            layout.allreduceLines.join(' '),
            layout.allreduceLeft,
            'shape_bcGuzJCR',
          ),
        ],
      },
    },
  );
}

function collectiveShapeElement(id: string, left: number) {
  return {
    id,
    type: 'shape' as const,
    left,
    top: 145,
    width: 250,
    height: 140,
    rotate: 0,
    shapeType: 'rect',
    viewBox: [250, 140] as [number, number],
    path: 'M 0 0 H 250 V 140 H 0 Z',
    fixedRatio: false,
    fill: '#ffffff',
    line: { color: '#d0d7de', width: 1 },
  };
}

function collectiveCommunicationScene(layout: {
  bcastLeft: number;
  reduceLeft: number;
  allreduceLeft: number;
  reduceText: string;
}): Scene {
  return makeScene(
    {
      id: 'scene-1',
      stageId: 'stage-1',
      title: 'Collective Communication',
      order: 1,
      outlineId: 'outline-1',
      actions: [
        { id: 'spot-bcast', type: 'spotlight', elementId: 'bcast-card' } as Action,
        speech('speech-bcast', 'previous Bcast narration', 'tts_bcast'),
        { id: 'spot-reduce', type: 'spotlight', elementId: 'reduce-card' } as Action,
        speech('speech-reduce', 'previous Reduce Many to One narration', 'tts_reduce'),
        { id: 'spot-allreduce', type: 'spotlight', elementId: 'allreduce-card' } as Action,
        speech('speech-allreduce', 'previous Allreduce narration', 'tts_allreduce'),
      ],
    },
    {
      type: 'slide',
      canvas: {
        id: 'collective-canvas',
        viewportSize: 1000,
        viewportRatio: 0.5625,
        theme: {
          backgroundColor: '#ffffff',
          themeColors: ['#5b9bd5'],
          fontColor: '#111111',
          fontName: 'Arial',
        },
        elements: [
          collectiveTextElement('bcast-card', 'MPI_Bcast', 'Broadcast', layout.bcastLeft),
          collectiveTextElement('reduce-card', 'MPI_Reduce', layout.reduceText, layout.reduceLeft),
          collectiveTextElement(
            'allreduce-card',
            'MPI_Allreduce',
            'Combine and share',
            layout.allreduceLeft,
          ),
        ],
      },
    },
  );
}

function collectiveTextElement(
  id: string,
  heading: string,
  body: string,
  left: number,
  groupId?: string,
) {
  return {
    id,
    type: 'text' as const,
    left,
    top: 150,
    width: 230,
    height: 120,
    rotate: 0,
    content: `<h2>${heading}</h2><p>${body}</p>`,
    defaultFontName: 'Arial',
    defaultColor: '#111111',
    ...(groupId ? { groupId } : {}),
  };
}

function makeMemoryHierarchyScene(): Scene {
  const initial = memoryHierarchyScene({
    sharedLines: ['Heap Memory', 'Static Variables', 'Global Vars'],
    privateLines: ['Thread Stack', 'CPU Registers', 'Thread-Local'],
    speechSuffix: 'old',
  });
  const edited = memoryHierarchyScene({
    sharedLines: ['Heap Memory', 'Static Variables', 'Global Vars'],
    privateLines: ['Thread Stack', 'CPU Registers', 'Thread-Local'],
    speechSuffix: 'edited',
  });
  return {
    ...edited,
    sync: syncedNarrationMetadata(
      {
        ...initial,
        title: 'Memory Hierarchy: Global vs Private',
      },
      TTS_SETTINGS,
    ),
  };
}

function memoryHierarchyScene(options: {
  sharedLines: string[];
  privateLines: string[];
  speechSuffix: string;
}): Scene {
  return makeScene(
    {
      id: 'scene-1',
      stageId: 'stage-1',
      title: 'Memory Hierarchy: Global vs. Private',
      order: 1,
      outlineId: 'outline-1',
      actions: [
        { id: 'spot-shared', type: 'spotlight', elementId: 'shared-card' } as Action,
        speech('speech-shared', `Shared old narration ${options.speechSuffix}.`, 'tts_shared'),
        { id: 'spot-private', type: 'spotlight', elementId: 'private-card' } as Action,
        speech('speech-private', `Private old narration ${options.speechSuffix}.`, 'tts_private'),
      ],
    },
    {
      type: 'slide',
      canvas: {
        id: 'memory-canvas',
        viewportSize: 1000,
        viewportRatio: 0.5625,
        theme: {
          backgroundColor: '#ffffff',
          themeColors: ['#2b58a8'],
          fontColor: '#111111',
          fontName: 'Arial',
        },
        elements: [
          textElement('memory-title', 'Memory Hierarchy: Global vs. Private', 56, 52, 820, 72),
          textElement(
            'memory-subtitle',
            'Understanding Memory Scope in Multi-threaded Environments',
            56,
            138,
            760,
            48,
          ),
          shapeElement('shared-card', 90, 245, 410, 270, '#dbeafe'),
          textElement('shared-heading', 'Shared Scope', 230, 332, 180, 48),
          textElement('shared-list', bulletHtml(options.sharedLines), 116, 350, 240, 112),
          shapeElement('private-card', 570, 245, 410, 270, '#fef3c7'),
          textElement('private-heading', 'Private Scope', 730, 332, 180, 48),
          textElement('private-list', bulletHtml(options.privateLines), 600, 350, 250, 112),
        ],
      },
    },
  );
}

function makeRuntimeEnvironmentScene(): Scene {
  const initial = runtimeEnvironmentScene({
    libraryLines: ['omp_get_num_threads()', 'omp_get_thread_num()'],
    environmentLines: ['OMP_NUM_THREADS', 'OMP_SCHEDULE'],
    tuningLines: ['OMP_DYNAMIC: old dynamic behavior'],
  });
  const edited = runtimeEnvironmentScene({
    libraryLines: ['omp_get_num_threads()', 'omp_get_thread_num()', 'omp_set_num_threads(n)'],
    environmentLines: ['OMP_NUM_THREADS', 'OMP_SCHEDULE', 'Affinity & Dynamic'],
    tuningLines: [
      'OMP_DYNAMIC: Enable dynamic thread allocation',
      'OMP_PROC_BIND: Set thread affinity to cores',
    ],
  });
  return {
    ...edited,
    sync: syncedNarrationMetadata(initial, TTS_SETTINGS),
  };
}

function runtimeEnvironmentScene(options: {
  libraryLines: string[];
  environmentLines: string[];
  tuningLines: string[];
}): Scene {
  return makeScene(
    {
      id: 'scene-1',
      stageId: 'stage-1',
      title: 'Runtime & Environment Variables',
      order: 1,
      outlineId: 'outline-1',
      actions: [
        { id: 'spot-library', type: 'spotlight', elementId: 'library-card' } as Action,
        speech('speech-library', 'Library old narration.', 'tts_library'),
        { id: 'spot-environment', type: 'spotlight', elementId: 'environment-card' } as Action,
        speech('speech-environment', 'Environment old narration.', 'tts_environment'),
        { id: 'spot-tuning', type: 'spotlight', elementId: 'advanced-tuning-block' } as Action,
        speech('speech-tuning', 'Tuning old narration.', 'tts_tuning'),
      ],
    },
    {
      type: 'slide',
      canvas: {
        id: 'runtime-canvas',
        viewportSize: 1000,
        viewportRatio: 0.5625,
        theme: {
          backgroundColor: '#ffffff',
          themeColors: ['#2b58a8'],
          fontColor: '#111111',
          fontName: 'Arial',
        },
        elements: [
          textElement('runtime-title', 'Runtime & Environment Variables', 64, 56, 760, 72),
          shapeElement('library-card', 64, 172, 410, 260, '#eff6ff'),
          textElement('library-heading', 'Library Functions', 92, 204, 250, 48),
          textElement('library-list', bulletHtml(options.libraryLines), 110, 294, 300, 120),
          shapeElement('environment-card', 530, 172, 410, 260, '#ecfdf5'),
          textElement('environment-heading', 'Environment Variables', 558, 204, 310, 48),
          textElement('environment-list', bulletHtml(options.environmentLines), 584, 294, 300, 120),
          textElement('advanced-tuning-block', 'Advanced Tuning', 64, 455, 310, 48),
          textElement('advanced-tuning-list', bulletHtml(options.tuningLines), 96, 510, 660, 88),
        ],
      },
    },
  );
}

function shapeElement(
  id: string,
  left: number,
  top: number,
  width: number,
  height: number,
  fill: string,
) {
  return {
    id,
    type: 'shape' as const,
    left,
    top,
    width,
    height,
    rotate: 0,
    shapeType: 'rect',
    viewBox: [width, height] as [number, number],
    path: `M 0 0 H ${width} V ${height} H 0 Z`,
    fixedRatio: false,
    fill,
    line: { color: '#d0d7de', width: 1 },
  };
}

function textElement(
  id: string,
  content: string,
  left: number,
  top: number,
  width: number,
  height: number,
) {
  return {
    id,
    type: 'text' as const,
    left,
    top,
    width,
    height,
    rotate: 0,
    content,
    defaultFontName: 'Arial',
    defaultColor: '#111111',
  };
}

function bulletHtml(lines: string[]): string {
  return `<ul>${lines.map((line) => `<li>${line}</li>`).join('')}</ul>`;
}

function makeManualInitialScene(
  options: {
    id?: string;
    order?: number;
    outlineId?: string;
    points?: string[];
    speechId?: string;
    audioId?: string;
  } = {},
): Scene {
  return parallelModelsScene({
    ...options,
    points: options.points ?? [
      'Maximizing Efficiency',
      'Better Resource Utilization',
      'Faster Execution',
    ],
  });
}

function makeManualEditedStaleScene(
  options: {
    id?: string;
    order?: number;
    outlineId?: string;
    points?: string[];
    speechId?: string;
    audioId?: string;
    sync?: Scene['sync'];
  } = {},
): Scene {
  const initial = makeManualInitialScene({
    id: options.id,
    order: options.order,
    outlineId: options.outlineId,
    speechId: options.speechId,
    audioId: options.audioId,
  });
  const edited = parallelModelsScene({
    ...options,
    points: options.points ?? ['Minimizing Efficiency'],
  });
  return {
    ...edited,
    sync: options.sync ?? syncedNarrationMetadata(initial, TTS_SETTINGS),
  };
}

function parallelModelsScene(options: {
  id?: string;
  order?: number;
  outlineId?: string;
  points: string[];
  speechId?: string;
  audioId?: string;
}): Scene {
  const id = options.id ?? 'scene-1';
  const order = options.order ?? 1;
  const speechId = options.speechId ?? 'speech-1';
  return makeScene(
    {
      id,
      stageId: 'stage-1',
      title: 'Introduction to Parallel Models',
      order,
      outlineId: options.outlineId ?? `outline-${order}`,
      actions: [speech(speechId, OLD_NARRATION, options.audioId ?? 'tts_speech_1')],
    },
    {
      type: 'slide',
      canvas: {
        id: `${id}-canvas`,
        viewportSize: 1000,
        viewportRatio: 0.5625,
        theme: {
          backgroundColor: '#ffffff',
          themeColors: ['#5b9bd5'],
          fontColor: '#111111',
          fontName: 'Arial',
        },
        elements: [
          {
            id: `${id}-title`,
            type: 'text',
            left: 80,
            top: 48,
            width: 700,
            height: 80,
            rotate: 0,
            content: '<h1>Introduction to Parallel Models</h1>',
            defaultFontName: 'Arial',
            defaultColor: '#111111',
          },
          {
            id: `${id}-principles`,
            type: 'text',
            left: 96,
            top: 160,
            width: 640,
            height: 220,
            rotate: 0,
            content: `<h2>Core Principles</h2><ul>${options.points
              .map((point) => `<li>${point}</li>`)
              .join('')}</ul>`,
            defaultFontName: 'Arial',
            defaultColor: '#111111',
          },
        ],
      },
    },
  );
}

function sceneFixture(): Scene {
  return makeScene(
    {
      id: 'scene-1',
      stageId: 'stage-1',
      title: 'Scene',
      order: 1,
      outlineId: 'outline-1',
      actions: [speech('speech-1', 'Explain shared memory', 'tts_speech_1')],
    },
    {
      type: 'slide',
      canvas: {
        id: 'slide-canvas',
        viewportSize: 1000,
        viewportRatio: 0.5625,
        theme: {
          backgroundColor: '#ffffff',
          themeColors: ['#5b9bd5'],
          fontColor: '#111111',
          fontName: 'Arial',
        },
        elements: [
          {
            id: 'text-1',
            type: 'text',
            left: 80,
            top: 80,
            width: 300,
            height: 80,
            rotate: 0,
            content: '<p>Shared memory</p>',
            defaultFontName: 'Arial',
            defaultColor: '#111111',
          },
        ],
      },
    },
  );
}

function speech(id: string, text: string, audioId: string): Action {
  return { id, type: 'speech', text, audioId } as Action;
}

function expectNoExternalStoreLoopErrors() {
  const messages = consoleError.mock.calls.map((call: unknown[]) => call.map(String).join(' '));
  expect(messages.some((message: string) => message.includes('getSnapshot should be cached'))).toBe(
    false,
  );
  expect(
    messages.some((message: string) => message.includes('Maximum update depth exceeded')),
  ).toBe(false);
  expect(messages.some((message: string) => message.includes('infinite loop'))).toBe(false);
}

function narrationOrderLogs(): Array<Record<string, unknown>> {
  return consoleInfo.mock.calls
    .filter((call: unknown[]) => call[0] === '[NarrationSyncOrder]')
    .map((call: unknown[]) => call[1] as Record<string, unknown>);
}

function spotlightTargetLogs(): Array<Record<string, unknown>> {
  return consoleInfo.mock.calls
    .filter((call: unknown[]) => call[0] === '[SpotlightTargetTrace]')
    .map((call: unknown[]) => call[1] as Record<string, unknown>);
}

function checkpoint(logs: Array<Record<string, unknown>>, name: string) {
  const found = logs.find((payload) => payload.checkpoint === name);
  expect(found).toBeTruthy();
  return found as Record<string, unknown>;
}

function textPreviewOrder(value: unknown) {
  return (value as Array<{ textPreview?: string }>).map((item) => item.textPreview);
}

function targetActionOrder(value: unknown) {
  return (value as Array<{ targetElementId?: string; elementId?: string }>)
    .map((action) => action.targetElementId ?? action.elementId)
    .filter(Boolean);
}

function flatText(payload: Record<string, unknown>) {
  return payload.order as string[];
}

function flatTargets(payload: Record<string, unknown>) {
  return (payload.order as string[]).map((item) => item.split(':')[2]);
}

function flatActionTargets(payload: Record<string, unknown>) {
  return (payload.order as string[]).map((item) => item.split(':')[3]).filter(Boolean);
}

function slideElements(scene: Scene) {
  return scene.content.type === 'slide' ? scene.content.canvas.elements : [];
}

function targetAreaRatioForTest(scene: Scene, targetId: string): number {
  if (scene.content.type !== 'slide') return 1;
  const element = scene.content.canvas.elements.find((item) => item.id === targetId);
  if (!element) return 1;
  const record = element as unknown as Record<string, unknown>;
  const width = typeof record.width === 'number' ? record.width : 0;
  const height = typeof record.height === 'number' ? record.height : 0;
  const slideWidth = scene.content.canvas.viewportSize;
  const slideHeight = scene.content.canvas.viewportSize * scene.content.canvas.viewportRatio;
  return (width * height) / (slideWidth * slideHeight);
}

function speechTextsForTest(scene: Scene) {
  return (scene.actions ?? [])
    .filter((action) => action.type === 'speech')
    .map((action) => ((action as { text?: string }).text ?? '').trim())
    .join('\n');
}

function hasText(text: string): boolean {
  return mounted?.container.textContent?.includes(text) ?? false;
}

function hasLabel(label: string): boolean {
  return !!mounted?.container.querySelector(`[aria-label="${cssEscape(label)}"]`);
}

async function findText(text: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (hasText(text)) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  throw new Error(`Unable to find text: ${text}`);
}

function cssEscape(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}

function requiredButton(label: string): HTMLButtonElement {
  const button = mounted?.container.querySelector(
    `[aria-label="${cssEscape(label)}"]`,
  ) as HTMLButtonElement | null;
  if (!button) throw new Error(`Unable to find button: ${label}`);
  return button;
}

async function waitForCondition(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (predicate()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  throw new Error('Timed out waiting for condition');
}

function getScene(sceneId: string): Scene {
  const scene = useStageStore.getState().scenes.find((item) => item.id === sceneId);
  if (!scene) throw new Error(`Missing scene: ${sceneId}`);
  return scene;
}

function replaceScene(scene: Scene): void {
  useStageStore.setState((state) => ({
    scenes: state.scenes.map((item) => (item.id === scene.id ? scene : item)),
  }));
}

function deferredPromise<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
