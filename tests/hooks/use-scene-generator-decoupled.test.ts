// @vitest-environment jsdom

import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SceneOutline } from '@/lib/types/generation';
import type { Scene } from '@/lib/types/stage';

const mocks = vi.hoisted(() => ({
  stageState: null as unknown as ReturnType<typeof makeStageState>,
  settings: {
    imageProviderId: '',
    imageProvidersConfig: {},
    imageGenerationEnabled: false,
    videoProviderId: '',
    videoProvidersConfig: {},
    videoGenerationEnabled: false,
    ttsEnabled: true,
    ttsProviderId: 'server-tts',
    ttsProvidersConfig: { 'server-tts': { apiKey: 'key', modelId: 'model' } },
    ttsVoice: 'voice',
    ttsSpeed: 1,
    parallelSceneConcurrency: 0,
  },
  mediaGeneration: vi.fn().mockResolvedValue(undefined),
  audioPut: vi.fn().mockResolvedValue(undefined),
  audioDelete: vi.fn().mockResolvedValue(undefined),
  logInfo: vi.fn(),
  stageSubscribers: new Set<(state: ReturnType<typeof makeStageState>) => void>(),
}));

vi.mock('@/lib/store/stage', () => ({
  flushStageSave: () => mocks.stageState.saveToStorage(),
  useStageStore: {
    getState: () => mocks.stageState,
    subscribe: (listener: (state: ReturnType<typeof makeStageState>) => void) => {
      mocks.stageSubscribers.add(listener);
      return () => mocks.stageSubscribers.delete(listener);
    },
  },
}));
vi.mock('@/lib/store/settings', () => ({
  useSettingsStore: { getState: () => mocks.settings },
}));
vi.mock('@/lib/utils/model-config', () => ({ getCurrentModelConfig: () => ({}) }));
vi.mock('@/lib/utils/database', () => ({
  db: { audioFiles: { put: mocks.audioPut, delete: mocks.audioDelete } },
}));
vi.mock('@/lib/media/media-orchestrator', () => ({
  generateMediaForOutlines: mocks.mediaGeneration,
}));
vi.mock('@/lib/media/asset-pool', () => ({ putAsset: vi.fn() }));
vi.mock('@/lib/persistence/media-persistence', () => ({
  isServerBackedMediaPersistence: () => false,
}));
vi.mock('@/lib/classroom/generation-permission', () => ({ mayGenerateForStage: () => true }));
vi.mock('@/lib/audio/provider-enablement', () => ({ isTTSProviderEnabled: () => true }));
vi.mock('@/lib/audio/agent-voice', () => ({
  pickNarratorAgent: () => undefined,
  resolveAgentVoiceOptions: vi.fn().mockResolvedValue({}),
}));
vi.mock('@/lib/audio/voice-resolver', () => ({
  getEnabledProvidersWithVoices: () => [],
  resolveDeterministicFallbackVoice: () => null,
  resolveNarratorVoiceBinding: () => ({ providerId: 'server-tts', voiceId: 'voice' }),
}));
vi.mock('@/lib/audio/constants', () => ({ resolveTTSModelForVoice: () => 'model' }));
vi.mock('@/lib/orchestration/registry/store', () => ({
  useAgentRegistry: { getState: () => ({ listAgents: () => [] }) },
}));
vi.mock('@/lib/audio/unavailable-voice-bindings', () => ({
  isVoiceBindingUnavailable: () => false,
  markVoiceBindingNoticeShown: () => false,
  markVoiceBindingUnavailable: vi.fn(),
  voiceBindingKey: () => 'voice',
}));
vi.mock('@/lib/voice-cloning/language', () => ({ resolveTeachingVoiceLanguage: () => 'en' }));
vi.mock('@/lib/audio/audio-duration', () => ({ measureAudioDuration: () => undefined }));
vi.mock('@/lib/i18n', () => ({ getClientTranslation: (key: string) => key }));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: mocks.logInfo,
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));
vi.mock('sonner', () => ({ toast: { warning: vi.fn() } }));

const outlines: SceneOutline[] = [1, 2, 3].map((order) => ({
  id: `outline-${order}`,
  type: 'slide',
  title: `Slide ${order}`,
  description: `Scene ${order}`,
  keyPoints: [`Point ${order}`],
  order,
}));

function makeStageState() {
  const state = {
    stage: {
      id: 'stage-1',
      name: 'Decoupled lesson',
      createdAt: 1,
      updatedAt: 1,
      teacherVoiceProfileId: 'profile-1',
    },
    outlines: [...outlines],
    scenes: [] as Scene[],
    currentSceneId: null as string | null,
    generatingOutlines: [] as SceneOutline[],
    failedOutlines: [] as SceneOutline[],
    generationEpoch: 1,
    generationStatus: 'idle',
    generationComplete: false,
    setGenerationStatus(status: string) {
      state.generationStatus = status;
    },
    setGeneratingOutlines(next: SceneOutline[]) {
      state.generatingOutlines = next;
    },
    setGenerationComplete(value: boolean) {
      state.generationComplete = value;
    },
    setCurrentGeneratingOrder: vi.fn(),
    addFailedOutline(outline: SceneOutline) {
      state.failedOutlines.push(outline);
    },
    addScene(scene: Scene) {
      state.scenes.push(scene);
      state.generatingOutlines = state.generatingOutlines.filter(
        (outline) => outline.order !== scene.order,
      );
      state.currentSceneId ??= scene.id;
    },
    updateScene(sceneId: string, patch: Partial<Scene>) {
      state.scenes = state.scenes.map((scene) =>
        scene.id === sceneId ? ({ ...scene, ...patch } as Scene) : scene,
      );
      for (const listener of mocks.stageSubscribers) listener(state);
    },
    getSceneById(sceneId: string) {
      return state.scenes.find((scene) => scene.id === sceneId);
    },
    bumpGenerationEpoch() {
      state.generationEpoch += 1;
    },
    retryFailedOutline(outlineId: string) {
      state.failedOutlines = state.failedOutlines.filter((outline) => outline.id !== outlineId);
    },
    markGenerationCompleteIfDone() {
      state.generationComplete =
        state.failedOutlines.length === 0 &&
        state.outlines.every((outline) =>
          state.scenes.some((scene) => scene.order === outline.order),
        );
    },
    saveToStorage: vi.fn().mockResolvedValue(true),
  };
  return state;
}

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, statusText: 'OK', json: async () => body };
}

function actionResponse(
  order: number,
  attemptId = `attempt-${order}`,
  generationVersion = 'version-1',
) {
  return jsonResponse({
    success: true,
    attemptId,
    generationVersion,
    previousSpeeches: [`Narration ${order}`],
    scene: {
      id: `scene-${order}`,
      stageId: 'stage-1',
      title: `Slide ${order}`,
      order,
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
      actions: [{ id: `speech-${order}`, type: 'speech', text: `Narration ${order}` }],
    },
  });
}

async function mountGenerator(root: Root, onComplete = vi.fn()) {
  let generator!: {
    generateRemaining: (params: { stageInfo: { name: string } }) => Promise<void>;
    retrySingleOutline: (outlineId: string) => Promise<void>;
    stop: () => void;
  };
  const { useSceneGenerator } = await import('@/lib/hooks/use-scene-generator');
  function Harness() {
    const current = useSceneGenerator({ onComplete });
    useEffect(() => {
      generator = current;
    }, [current]);
    return null;
  }
  const rerender = async () => act(async () => root.render(createElement(Harness)));
  await rerender();
  return { generator, onComplete, rerender };
}

describe('scene generator visual and narration pipelines', () => {
  let root: Root;
  let container: HTMLDivElement;
  const additionalRoots: Array<{ root: Root; container: HTMLDivElement }> = [];

  beforeEach(() => {
    mocks.stageState = makeStageState();
    mocks.mediaGeneration.mockClear();
    mocks.audioPut.mockClear();
    mocks.audioDelete.mockClear();
    mocks.logInfo.mockClear();
    mocks.stageSubscribers.clear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    for (const mounted of additionalRoots.splice(0)) {
      await act(async () => mounted.root.unmount());
      mounted.container.remove();
    }
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('renders scenes 1-3 and completes visuals while every narration request is unresolved', async () => {
    const events: string[] = [];
    const narrationSignals: AbortSignal[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        if (url === '/api/generate/scene-content') {
          events.push(`content:${body.outline.order}`);
          return Promise.resolve(
            jsonResponse({
              success: true,
              content: { elements: [] },
              attemptId: `attempt-${body.outline.order}`,
              generationVersion: 'version-1',
            }),
          );
        }
        if (url === '/api/generate/scene-actions') {
          const order = body.outline.order as number;
          events.push(`actions:${order}`);
          return Promise.resolve(actionResponse(order));
        }
        if (url === '/api/generate/tts') {
          events.push(`tts:${body.sceneId}`);
          const signal = init?.signal as AbortSignal;
          narrationSignals.push(signal);
          return new Promise((_resolve, reject) => {
            signal.addEventListener(
              'abort',
              () => reject(new DOMException('Aborted', 'AbortError')),
              { once: true },
            );
          });
        }
        if (url === '/api/generate/scene-attempt/commit') {
          return Promise.resolve(jsonResponse({ success: true, accepted: true }));
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );

    const { generator, onComplete } = await mountGenerator(root);

    await generator.generateRemaining({ stageInfo: { name: 'Decoupled lesson' } });

    expect(mocks.stageState.scenes.map((scene) => scene.id)).toEqual([
      'scene-1',
      'scene-2',
      'scene-3',
    ]);
    expect(mocks.stageState.scenes.every((scene) => scene.narrationStatus === 'pending')).toBe(
      true,
    );
    expect(mocks.stageState.currentSceneId).toBe('scene-1');
    expect(mocks.stageState.generationStatus).toBe('completed');
    expect(mocks.stageState.generationComplete).toBe(true);
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(events).toEqual([
      'content:1',
      'actions:1',
      'tts:scene-1',
      'content:2',
      'actions:2',
      'tts:scene-2',
      'content:3',
      'actions:3',
      'tts:scene-3',
    ]);
    expect(narrationSignals).toHaveLength(3);
    expect(narrationSignals.every((signal) => !signal.aborted)).toBe(true);

    generator.stop();
    expect(narrationSignals.every((signal) => signal.aborted)).toBe(true);
  });

  it('rejoins queued narration after unmount and durably attaches it to the committed scene', async () => {
    const firstOutline = outlines[0];
    const committedScene = ((await actionResponse(1).json()) as { scene: Scene }).scene;
    mocks.stageState.outlines = [firstOutline];
    mocks.stageState.scenes = [{ ...committedScene, narrationStatus: 'pending' }];
    mocks.stageState.currentSceneId = 'scene-1';
    mocks.stageState.generationComplete = true;

    let ttsAdmissions = 0;
    const deleteRequests: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        if (url === '/api/generate/tts') {
          ttsAdmissions += 1;
          if (ttsAdmissions === 1) {
            return Promise.resolve(
              jsonResponse({
                success: true,
                async: true,
                teachingVoiceProvider: 'qwen3',
                jobId: 'rq_shared_teaching_voice_job',
                status: 'queued',
                statusUrl: '/api/generate/tts/jobs/rq_shared_teaching_voice_job',
              }),
            );
          }
          return Promise.resolve(
            jsonResponse({
              success: true,
              async: true,
              teachingVoiceProvider: 'qwen3',
              jobId: 'rq_shared_teaching_voice_job',
              status: 'completed',
              statusUrl: '/api/generate/tts/jobs/rq_shared_teaching_voice_job',
              audioUrl: '/api/generate/tts/jobs/rq_shared_teaching_voice_job/audio',
            }),
          );
        }
        if (
          url === '/api/generate/tts/jobs/rq_shared_teaching_voice_job' &&
          init?.method === 'DELETE'
        ) {
          deleteRequests.push(url);
          return Promise.resolve(jsonResponse({ success: true, status: 'cancelled' }));
        }
        if (url === '/api/generate/tts/jobs/rq_shared_teaching_voice_job/audio') {
          return Promise.resolve({
            ok: true,
            status: 200,
            statusText: 'OK',
            headers: new Headers({ 'content-type': 'audio/wav' }),
            arrayBuffer: async () => new TextEncoder().encode('audible wav').buffer,
          });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );

    await mountGenerator(root);
    await vi.waitFor(() => expect(ttsAdmissions).toBe(1));
    await act(async () => root.unmount());

    const remountContainer = document.createElement('div');
    document.body.appendChild(remountContainer);
    const remountRoot = createRoot(remountContainer);
    additionalRoots.push({ root: remountRoot, container: remountContainer });
    await mountGenerator(remountRoot);

    await vi.waitFor(() => {
      const speech = mocks.stageState.scenes[0]?.actions[0] as { audioId?: string };
      expect(speech.audioId).toBe('tts_s1_speech-1');
      expect(mocks.stageState.scenes[0]?.narrationStatus).toBe('completed');
    });
    expect(ttsAdmissions).toBe(2);
    expect(deleteRequests).toEqual([]);
    await vi.waitFor(() => expect(mocks.stageState.saveToStorage).toHaveBeenCalled());
    expect(mocks.logInfo.mock.calls.map(([, details]) => details?.event)).toEqual(
      expect.arrayContaining([
        'narration-tts-job-completed',
        'narration-audio-downloaded',
        'narration-audio-asset-ready',
        'narration-action-attached',
      ]),
    );
  });

  it('publishes narration from whichever scene finishes first', async () => {
    const first = ((await actionResponse(1).json()) as { scene: Scene }).scene;
    const second = ((await actionResponse(2).json()) as { scene: Scene }).scene;
    first.narrationStatus = 'pending';
    second.narrationStatus = 'pending';
    mocks.stageState.outlines = outlines.slice(0, 2);
    mocks.stageState.scenes = [first, second];
    mocks.stageState.currentSceneId = first.id;
    mocks.stageState.generationComplete = true;
    const downloads = new Map<string, ReturnType<typeof Promise.withResolvers<Response>>>([
      ['speech-1', Promise.withResolvers<Response>()],
      ['speech-2', Promise.withResolvers<Response>()],
    ]);

    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        if (url === '/api/generate/tts') {
          const body = JSON.parse(String(init?.body));
          const actionId = String(body.audioId).split('_').at(-1)!;
          return Promise.resolve(
            jsonResponse({
              success: true,
              async: true,
              teachingVoiceProvider: 'qwen3',
              jobId: `rq_${actionId}`,
              status: 'completed',
              statusUrl: `/api/generate/tts/jobs/rq_${actionId}`,
              audioUrl: `/audio/${actionId}`,
            }),
          );
        }
        if (url.startsWith('/audio/')) {
          return downloads.get(url.slice('/audio/'.length))!.promise;
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );

    await mountGenerator(root);
    await vi.waitFor(() => expect(downloads.size).toBe(2));
    downloads.get('speech-2')!.resolve({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-type': 'audio/wav' }),
      arrayBuffer: async () => new TextEncoder().encode('second scene').buffer,
    } as Response);

    await vi.waitFor(() => {
      expect(
        (mocks.stageState.scenes[0].actions[0] as { audioId?: string }).audioId,
      ).toBeUndefined();
      expect((mocks.stageState.scenes[1].actions[0] as { audioId?: string }).audioId).toBe(
        'tts_s2_speech-2',
      );
    });

    downloads.get('speech-1')!.resolve({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-type': 'audio/wav' }),
      arrayBuffer: async () => new TextEncoder().encode('first scene').buffer,
    } as Response);
    await vi.waitFor(() =>
      expect((mocks.stageState.scenes[0].actions[0] as { audioId?: string }).audioId).toBe(
        'tts_s1_speech-1',
      ),
    );
  });

  it('does not overwrite pronunciation audio with a stale narration completion', async () => {
    const committedScene = ((await actionResponse(1).json()) as { scene: Scene }).scene;
    committedScene.narrationStatus = 'pending';
    mocks.stageState.outlines = [outlines[0]];
    mocks.stageState.scenes = [committedScene];
    mocks.stageState.currentSceneId = committedScene.id;
    mocks.stageState.generationComplete = true;
    const download = Promise.withResolvers<Response>();

    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (url === '/api/generate/tts') {
          return Promise.resolve(
            jsonResponse({
              success: true,
              async: true,
              teachingVoiceProvider: 'qwen3',
              jobId: 'rq_stale_completion',
              status: 'completed',
              statusUrl: '/api/generate/tts/jobs/rq_stale_completion',
              audioUrl: '/audio/stale-completion',
            }),
          );
        }
        if (url === '/audio/stale-completion') return download.promise;
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );

    await mountGenerator(root);
    await vi.waitFor(() =>
      expect(fetch).toHaveBeenCalledWith('/audio/stale-completion', expect.anything()),
    );
    mocks.stageState.updateScene(committedScene.id, {
      actions: [{ ...committedScene.actions[0], audioId: 'ast_pronunciation_repair' }],
    });
    download.resolve({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-type': 'audio/wav' }),
      arrayBuffer: async () => new TextEncoder().encode('stale narration').buffer,
    } as Response);

    await vi.waitFor(() => expect(mocks.audioDelete).toHaveBeenCalledWith('tts_s1_speech-1'));
    expect((mocks.stageState.scenes[0].actions[0] as { audioId?: string }).audioId).toBe(
      'ast_pronunciation_repair',
    );
  });

  it('retries a transient Teaching Voice request failure through server idempotency', async () => {
    let admissions = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (url === '/api/generate/tts') {
          admissions += 1;
          if (admissions === 1) {
            return Promise.resolve({
              ok: false,
              status: 503,
              statusText: 'Request failed',
              json: async () => {
                throw new Error('non-JSON proxy response');
              },
            });
          }
          return Promise.resolve(
            jsonResponse({
              success: true,
              async: true,
              teachingVoiceProvider: 'qwen3',
              jobId: 'rq_delayed_teaching_voice_job',
              status: 'completed',
              statusUrl: '/api/generate/tts/jobs/rq_delayed_teaching_voice_job',
              audioUrl: '/api/generate/tts/jobs/rq_delayed_teaching_voice_job/audio',
            }),
          );
        }
        if (url === '/api/generate/tts/jobs/rq_delayed_teaching_voice_job/audio') {
          return Promise.resolve({
            ok: true,
            status: 200,
            statusText: 'OK',
            headers: new Headers({ 'content-type': 'audio/wav' }),
            arrayBuffer: async () => new TextEncoder().encode('delayed audible wav').buffer,
          });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );

    const { generateAndStoreTTS } = await import('@/lib/hooks/use-scene-generator');
    await expect(
      generateAndStoreTTS(
        'tts_s1_speech-1',
        'Delayed narration',
        'en',
        undefined,
        { baseDelayMs: 0, maxDelayMs: 0 },
        undefined,
        'stage-1',
        undefined,
        0,
        'scene-1',
        undefined,
        'outline-1',
      ),
    ).resolves.toBe('tts_s1_speech-1');
    expect(admissions).toBe(2);
  });

  it('keeps polling a queue-delayed Teaching Voice job until audio is ready', async () => {
    vi.useFakeTimers();
    let statusChecks = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (url === '/api/generate/tts') {
          return Promise.resolve(
            jsonResponse({
              success: true,
              async: true,
              teachingVoiceProvider: 'qwen3',
              jobId: 'rq_fifo_delayed_teaching_voice',
              status: 'queued',
              statusUrl: '/api/generate/tts/jobs/rq_fifo_delayed_teaching_voice',
            }),
          );
        }
        if (url === '/api/generate/tts/jobs/rq_fifo_delayed_teaching_voice') {
          statusChecks += 1;
          const completed = statusChecks === 4;
          return Promise.resolve(
            jsonResponse({
              success: true,
              async: true,
              jobId: 'rq_fifo_delayed_teaching_voice',
              status: completed ? 'completed' : 'queued',
              ...(completed
                ? { audioUrl: '/api/generate/tts/jobs/rq_fifo_delayed_teaching_voice/audio' }
                : { queuePosition: 2, jobsAhead: 1, estimatedWaitMs: 45_000 }),
            }),
          );
        }
        if (url === '/api/generate/tts/jobs/rq_fifo_delayed_teaching_voice/audio') {
          return Promise.resolve({
            ok: true,
            status: 200,
            statusText: 'OK',
            headers: new Headers({ 'content-type': 'audio/wav' }),
            arrayBuffer: async () => new TextEncoder().encode('queued audible wav').buffer,
          });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );

    const { generateAndStoreTTS } = await import('@/lib/hooks/use-scene-generator');
    const result = generateAndStoreTTS(
      'tts_s1_speech-1',
      'Queued narration',
      'en',
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
    await vi.advanceTimersByTimeAsync(6_000);

    await expect(result).resolves.toBe('tts_s1_speech-1');
    expect(statusChecks).toBe(4);
  });

  it('publishes the first completed speech clip before the second clip finishes', async () => {
    const committedScene = ((await actionResponse(1).json()) as { scene: Scene }).scene;
    committedScene.actions = [
      { id: 'speech-1', type: 'speech', text: 'First narration' },
      { id: 'speech-2', type: 'speech', text: 'Second narration' },
    ];
    committedScene.narrationStatus = 'pending';
    mocks.stageState.outlines = [outlines[0]];
    mocks.stageState.scenes = [committedScene];
    mocks.stageState.currentSceneId = committedScene.id;
    mocks.stageState.generationComplete = true;
    const secondAdmission = Promise.withResolvers<Response>();

    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        if (url === '/api/generate/tts') {
          if (body.audioId === 'tts_s1_speech-2') return secondAdmission.promise;
          return Promise.resolve(
            jsonResponse({
              success: true,
              async: true,
              teachingVoiceProvider: 'qwen3',
              jobId: 'rq_first_clip_ready_immediately',
              status: 'completed',
              statusUrl: '/api/generate/tts/jobs/rq_first_clip_ready_immediately',
              audioUrl: '/api/generate/tts/jobs/rq_first_clip_ready_immediately/audio',
            }),
          );
        }
        if (url === '/api/generate/tts/jobs/rq_first_clip_ready_immediately/audio') {
          return Promise.resolve({
            ok: true,
            status: 200,
            statusText: 'OK',
            headers: new Headers({ 'content-type': 'audio/wav' }),
            arrayBuffer: async () => new TextEncoder().encode('first clip').buffer,
          });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );

    await mountGenerator(root);

    await vi.waitFor(() => {
      const actions = mocks.stageState.scenes[0]?.actions as Array<{ audioId?: string }>;
      expect(actions[0]?.audioId).toBe('tts_s1_speech-1');
      expect(actions[1]?.audioId).toBeUndefined();
      expect(mocks.stageState.scenes[0]?.narrationStatus).toBe('running');
    });
    await vi.waitFor(() => expect(mocks.stageState.saveToStorage).toHaveBeenCalled());
  });

  it('reuses completed clips while recovering only missing narration', async () => {
    const committedScene = ((await actionResponse(1).json()) as { scene: Scene }).scene;
    committedScene.actions = [
      { id: 'speech-ready', type: 'speech', text: 'Already ready', audioId: 'ast_existing' },
      { id: 'speech-missing', type: 'speech', text: 'Needs narration' },
    ];
    committedScene.narrationStatus = 'running';
    mocks.stageState.outlines = [outlines[0]];
    mocks.stageState.scenes = [committedScene];
    mocks.stageState.currentSceneId = committedScene.id;
    mocks.stageState.generationComplete = true;
    const admissions: string[] = [];

    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        if (url === '/api/generate/tts') {
          const body = JSON.parse(String(init?.body));
          admissions.push(body.audioId);
          return Promise.resolve(
            jsonResponse({
              success: true,
              async: true,
              teachingVoiceProvider: 'qwen3',
              jobId: 'rq_missing_only',
              status: 'completed',
              statusUrl: '/api/generate/tts/jobs/rq_missing_only',
              audioUrl: '/audio/missing-only',
            }),
          );
        }
        if (url === '/audio/missing-only') {
          return Promise.resolve({
            ok: true,
            status: 200,
            statusText: 'OK',
            headers: new Headers({ 'content-type': 'audio/wav' }),
            arrayBuffer: async () => new TextEncoder().encode('missing clip').buffer,
          });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );

    await mountGenerator(root);

    await vi.waitFor(() =>
      expect((mocks.stageState.scenes[0].actions[1] as { audioId?: string }).audioId).toBe(
        'tts_s1_speech-missing',
      ),
    );
    expect(admissions).toEqual(['tts_s1_speech-missing']);
    expect((mocks.stageState.scenes[0].actions[0] as { audioId?: string }).audioId).toBe(
      'ast_existing',
    );
    expect(mocks.audioDelete).not.toHaveBeenCalledWith('ast_existing');
  });

  it('does not reconsider active narration observers on unrelated rerenders', async () => {
    const committedScene = ((await actionResponse(1).json()) as { scene: Scene }).scene;
    committedScene.narrationStatus = 'pending';
    mocks.stageState.outlines = [outlines[0]];
    mocks.stageState.scenes = [committedScene];
    mocks.stageState.currentSceneId = committedScene.id;
    mocks.stageState.generationComplete = true;
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        if (url !== '/api/generate/tts') throw new Error(`Unexpected fetch: ${url}`);
        const signal = init?.signal as AbortSignal;
        return new Promise((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
        });
      }),
    );

    const mounted = await mountGenerator(root);
    await vi.waitFor(() =>
      expect(mocks.logInfo.mock.calls.some(([, details]) => details?.event === 'scheduled')).toBe(
        true,
      ),
    );
    mocks.logInfo.mockClear();

    await mounted.rerender();
    await mounted.rerender();
    await mounted.rerender();
    mocks.stageState.updateScene(committedScene.id, { narrationStatus: 'queued' });
    mocks.stageState.updateScene(committedScene.id, { narrationStatus: 'running' });

    expect(
      mocks.logInfo.mock.calls.filter(
        ([, details]) => details?.event === 'skipped-already-in-flight',
      ),
    ).toHaveLength(0);
  });

  it('admits one authoritative attempt across two hook instances for the same outline', async () => {
    const firstOutline = outlines[0];
    mocks.stageState.outlines = [firstOutline];
    const contentGate = Promise.withResolvers<void>();
    const actionsGate = Promise.withResolvers<void>();
    let admittedAttemptId: string | undefined;
    let contentProviderCalls = 0;
    let actionsProviderCalls = 0;

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        if (url === '/api/generate/scene-content') {
          if (!body.attemptId) {
            contentProviderCalls += 1;
            await contentGate.promise;
            return jsonResponse({ success: true, content: { elements: [] } });
          }
          if (!admittedAttemptId) {
            admittedAttemptId = body.attemptId;
            contentProviderCalls += 1;
          }
          await contentGate.promise;
          return jsonResponse({
            success: true,
            content: { elements: [] },
            attemptId: admittedAttemptId,
            generationVersion: 'version-1',
          });
        }
        if (url === '/api/generate/scene-actions') {
          if (!body.attemptId || body.attemptId !== admittedAttemptId) {
            actionsProviderCalls += 1;
          } else if (actionsProviderCalls === 0) {
            actionsProviderCalls += 1;
          }
          await actionsGate.promise;
          return actionResponse(1, admittedAttemptId);
        }
        if (url === '/api/generate/scene-attempt/commit') {
          return jsonResponse({ success: true, accepted: true });
        }
        if (url === '/api/generate/tts') {
          return Promise.resolve({
            ok: false,
            status: 503,
            statusText: 'Unavailable',
            json: async () => ({}),
          });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );

    const secondContainer = document.createElement('div');
    document.body.appendChild(secondContainer);
    const secondRoot = createRoot(secondContainer);
    additionalRoots.push({ root: secondRoot, container: secondContainer });
    const first = await mountGenerator(root);
    const second = await mountGenerator(secondRoot);

    const firstRun = first.generator.generateRemaining({ stageInfo: { name: 'Shared lesson' } });
    const secondRun = second.generator.generateRemaining({ stageInfo: { name: 'Shared lesson' } });

    await vi.waitFor(() => expect(contentProviderCalls).toBeGreaterThan(0));
    expect(contentProviderCalls).toBe(1);
    contentGate.resolve();
    await vi.waitFor(() => expect(actionsProviderCalls).toBeGreaterThan(0));
    expect(actionsProviderCalls).toBe(1);
    actionsGate.resolve();
    await Promise.all([firstRun, secondRun]);

    expect(mocks.stageState.scenes.map((scene) => scene.order)).toEqual([1]);
  });

  it('keeps only dispatched outlines active while progressing through four queued scenes', async () => {
    const fourOutlines: SceneOutline[] = [1, 2, 3, 4].map((order) => ({
      id: `progress-outline-${order}`,
      type: 'slide',
      title: `Progress ${order}`,
      description: `Progress scene ${order}`,
      keyPoints: [`Point ${order}`],
      order,
    }));
    mocks.stageState.outlines = fourOutlines;
    const activeAtDispatch: string[][] = [];

    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        if (url === '/api/generate/scene-content') {
          activeAtDispatch.push(mocks.stageState.generatingOutlines.map((outline) => outline.id));
          return Promise.resolve(
            jsonResponse({
              success: true,
              content: { elements: [] },
              attemptId: `attempt-${body.outline.order}`,
              generationVersion: 'version-1',
            }),
          );
        }
        if (url === '/api/generate/scene-actions') {
          return Promise.resolve(
            actionResponse(body.outline.order as number, body.attemptId, body.generationVersion),
          );
        }
        if (url === '/api/generate/scene-attempt/commit') {
          return Promise.resolve(jsonResponse({ success: true, accepted: true }));
        }
        if (url === '/api/generate/tts') {
          return Promise.resolve({
            ok: false,
            status: 503,
            statusText: 'Unavailable',
            json: async () => ({ success: false, error: 'Unavailable' }),
          });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );

    const { generator } = await mountGenerator(root);
    await generator.generateRemaining({ stageInfo: { name: 'Progressive lesson' } });

    expect(activeAtDispatch).toEqual(fourOutlines.map((outline) => [outline.id]));
    expect(mocks.stageState.scenes.map((scene) => scene.order)).toEqual([1, 2, 3, 4]);
    expect(mocks.stageState.generatingOutlines).toEqual([]);
  });

  it('keeps all visual scenes usable when every narration request fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        if (url === '/api/generate/scene-content') {
          return Promise.resolve(
            jsonResponse({
              success: true,
              content: { elements: [] },
              attemptId: `attempt-${body.outline.order}`,
              generationVersion: 'version-1',
            }),
          );
        }
        if (url === '/api/generate/scene-actions') {
          return Promise.resolve(
            actionResponse(body.outline.order as number, body.attemptId, body.generationVersion),
          );
        }
        if (url === '/api/generate/tts') {
          return Promise.resolve({
            ok: false,
            status: 401,
            statusText: 'Unauthorized',
            json: async () => ({ success: false, error: 'Teaching Voice unavailable' }),
          });
        }
        if (url === '/api/generate/scene-attempt/commit') {
          return Promise.resolve(jsonResponse({ success: true, accepted: true }));
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );
    const { generator, onComplete } = await mountGenerator(root);

    await generator.generateRemaining({ stageInfo: { name: 'Decoupled lesson' } });
    await vi.waitFor(() => {
      expect(mocks.stageState.scenes.every((scene) => scene.narrationStatus === 'failed')).toBe(
        true,
      );
    });

    expect(mocks.stageState.scenes).toHaveLength(3);
    expect(mocks.stageState.currentSceneId).toBe('scene-1');
    expect(mocks.stageState.generationStatus).toBe('completed');
    expect(mocks.stageState.failedOutlines).toEqual([]);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('keeps scene 1 usable and retries only a terminally failed async scene 2', async () => {
    const contentAttempts = new Map<number, number>();
    let scene2StatusChecks = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        if (url === '/api/generate/scene-content') {
          const order = body.outline.order as number;
          contentAttempts.set(order, (contentAttempts.get(order) ?? 0) + 1);
          if (order === 2) {
            const attempt = contentAttempts.get(order)!;
            return Promise.resolve(
              jsonResponse({
                success: true,
                async: true,
                jobId: `scene-2-attempt-${attempt}`,
                attemptId: `attempt-2-${attempt}`,
                generationVersion: 'version-1',
                stageId: 'stage-1',
                outlineId: 'outline-2',
                status: 'queued',
                pollIntervalMs: 1,
              }),
            );
          }
          return Promise.resolve(
            jsonResponse({
              success: true,
              content: { elements: [] },
              attemptId: `attempt-${order}`,
              generationVersion: 'version-1',
            }),
          );
        }
        if (url.startsWith('/api/generate/scene-content/status?jobId=scene-2-attempt-')) {
          scene2StatusChecks += 1;
          const retrySucceeded = url.endsWith('scene-2-attempt-2');
          return Promise.resolve(
            jsonResponse({
              success: retrySucceeded,
              async: true,
              jobId: retrySucceeded ? 'scene-2-attempt-2' : 'scene-2-attempt-1',
              stageId: 'stage-1',
              outlineId: 'outline-2',
              status: retrySucceeded ? 'completed' : 'failed',
              attemptId: retrySucceeded ? 'attempt-2-2' : 'attempt-2-1',
              generationVersion: 'version-1',
              ...(retrySucceeded ? { content: { elements: [] } } : { error: 'Timed out' }),
            }),
          );
        }
        if (url === '/api/generate/scene-actions') {
          return Promise.resolve(
            actionResponse(body.outline.order as number, body.attemptId, body.generationVersion),
          );
        }
        if (url === '/api/generate/scene-attempt/commit') {
          return Promise.resolve(jsonResponse({ success: true, accepted: true }));
        }
        if (url === '/api/generate/tts') {
          return new Promise(() => undefined);
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );

    const { generator } = await mountGenerator(root);
    await generator.generateRemaining({ stageInfo: { name: 'Recoverable lesson' } });

    expect(mocks.stageState.scenes.map((scene) => scene.id)).toEqual(['scene-1']);
    expect(mocks.stageState.currentSceneId).toBe('scene-1');
    expect(mocks.stageState.failedOutlines.map((outline) => outline.id)).toEqual(['outline-2']);
    expect(mocks.stageState.generatingOutlines).toEqual([]);
    expect(mocks.stageState.generationStatus).toBe('paused');

    await Promise.all([
      generator.retrySingleOutline('outline-2'),
      generator.retrySingleOutline('outline-2'),
    ]);

    expect(contentAttempts.get(2)).toBe(2);
    expect(scene2StatusChecks).toBe(2);
    await vi.waitFor(() => {
      expect(mocks.stageState.scenes.map((scene) => scene.id)).toEqual([
        'scene-1',
        'scene-2',
        'scene-3',
      ]);
    });
    expect(mocks.stageState.failedOutlines).toEqual([]);
    expect(mocks.stageState.generationComplete).toBe(true);
  });
});
