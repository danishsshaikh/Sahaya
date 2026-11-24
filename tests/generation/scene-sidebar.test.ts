// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { SceneSidebar } from '@/components/stage/scene-sidebar';
import { beginSceneAttempt, type SceneAttemptStatus } from '@/lib/generation/scene-attempt-status';
import type { SceneOutline } from '@/lib/types/generation';
import type { Scene } from '@/lib/types/stage';

const state = vi.hoisted(() => ({
  stage: { id: 'stage' },
  generationEpoch: 1,
  currentSceneId: null,
  outlines: [] as SceneOutline[],
  scenes: [] as Scene[],
  failedOutlines: [] as SceneOutline[],
  sceneAttempts: {} as Record<string, SceneAttemptStatus>,
  generationComplete: false,
  setCurrentSceneId: vi.fn(),
}));

vi.mock('@/lib/store', () => ({
  useStageStore: Object.assign(() => state, {
    use: { failedOutlines: () => state.failedOutlines },
  }),
  useCanvasStore: { use: { viewportSize: () => 1000, viewportRatio: () => 0.5625 } },
}));
vi.mock('@/lib/store/stage', () => ({ PENDING_SCENE_ID: 'pending' }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/lib/hooks/use-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/config/feature-flags', () => ({ filterEnabledScenes: (scenes: Scene[]) => scenes }));
vi.mock('@/components/slide-renderer/SlideThumbnail', () => ({ SlideThumbnail: () => null }));
vi.mock('@/components/slide-renderer/components/ThumbnailInteractive', () => ({
  ThumbnailInteractive: () => null,
}));
vi.mock('@/components/branding/brand-wordmark', () => ({ BrandWordmark: () => null }));
vi.mock('@/components/stage/scene-thumbnail-content', () => ({
  SceneThumbnailContent: ({ scene }: { scene: Scene }) =>
    createElement('span', null, `Poster for ${scene.id}`),
}));

it('keeps ordered DOM rows and the completed poster through retry, failure, and out-of-order completion', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  state.outlines = [1, 2, 3, 4, 5].map(
    (order): SceneOutline => ({
      id: `outline-${order}`,
      order,
      type: 'visualization',
      title: `Scene ${order}`,
      description: '',
      keyPoints: [],
    }),
  );
  const scene = (order: number): Scene => ({
    ...state.outlines[order - 1],
    id: `scene-${order}`,
    outlineId: `outline-${order}`,
    stageId: 'stage',
    type: 'visualization',
    content: {
      type: 'visualization',
      artifact: {
        artifactId: 'a'.repeat(64),
        duration: 3,
        width: 854,
        height: 480,
        fps: 15,
        bytes: 1024,
        sha256: 'b'.repeat(64),
        rendererVersion: '0.22.1/3',
        specVersion: 1,
        quality: 'preview',
        classification: 'illustrative',
        cues: [],
      },
    },
  });

  const store = {
    getState: () => state,
    setState: (
      update: (current: { sceneAttempts: typeof state.sceneAttempts }) => {
        sceneAttempts: typeof state.sceneAttempts;
      },
    ) => Object.assign(state, update(state)),
  };
  let retry: ReturnType<typeof beginSceneAttempt>;
  const onRetry = vi.fn(async (id: string) => {
    retry = beginSceneAttempt(store, 'stage', id, 'retry', true);
  });
  const render = () =>
    act(async () =>
      root.render(
        createElement(SceneSidebar, {
          collapsed: false,
          onCollapseChange: vi.fn(),
          onRetryOutline: onRetry,
        }),
      ),
    );
  const row = (order: number) => container.querySelector(`[data-outline-id="outline-${order}"]`)!;
  try {
    state.scenes = [scene(1)];
    state.failedOutlines = [state.outlines[2], state.outlines[3]];
    await render();
    expect(row(3).textContent).toContain('stage.generationFailed');
    expect(row(2).textContent).toContain('Waiting in queue');
    await act(async () => row(3).querySelector('button')!.click());
    await render();
    expect(row(3).textContent).toContain('Regenerating visualization');
    expect(row(3).textContent).not.toContain('stage.generationFailed');
    expect(row(3).querySelector('button')).toBeNull();
    retry?.progress('rendering');
    expect(beginSceneAttempt(store, 'stage', 'outline-3', 'duplicate', true)).toBeUndefined();
    state.scenes = [scene(4), scene(1), scene(2)];
    const regeneration = beginSceneAttempt(store, 'stage', 'outline-4', 'regenerate', true)!;
    await render();
    expect(row(3).textContent).toContain('Rendering animation');
    expect(row(4).textContent).toContain('Poster for scene-4');
    regeneration.finish('failed');
    await render();
    expect(row(4).textContent).toContain('Regeneration failed');
    expect(row(4).textContent).toContain('Poster for scene-4');
    state.scenes = [...state.scenes, scene(3)];
    retry?.finish();
    await render();
    expect(
      [...container.querySelectorAll('[data-testid="scene-title"]')].map(
        (node) => node.textContent,
      ),
    ).toEqual(['Scene 1', 'Scene 2', 'Scene 3', 'Scene 4', 'Scene 5']);
    expect(row(3).textContent).toContain('Poster for scene-3');
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
