import { afterEach, describe, expect, it, vi } from 'vitest';
import { isCurrentSceneEditable } from '@/lib/edit/stage-mode';

const FLAG_KEY = 'NEXT_PUBLIC_MAIC_EDITOR_ENABLED';
const originalValue = process.env[FLAG_KEY];

async function loadFlags() {
  vi.resetModules();
  return import('@/lib/config/feature-flags');
}

afterEach(() => {
  if (originalValue === undefined) {
    delete process.env[FLAG_KEY];
  } else {
    process.env[FLAG_KEY] = originalValue;
  }
  vi.resetModules();
});

describe('edit toggle gate', () => {
  it('requires the deployment editor flag and an editable current scene', async () => {
    process.env[FLAG_KEY] = 'true';
    const { isMaicEditorEnabled } = await loadFlags();

    expect(isMaicEditorEnabled()).toBe(true);
    expect(
      isCurrentSceneEditable({
        currentSceneId: 'scene-1',
        sceneCount: 1,
        generatingOutlineCount: 0,
        hasCurrentScene: true,
      }),
    ).toBe(true);
  });

  it('does not tie edit availability to whole-lesson generation completion', async () => {
    process.env[FLAG_KEY] = 'true';
    const { isMaicEditorEnabled } = await loadFlags();

    expect(isMaicEditorEnabled()).toBe(true);
    expect(
      isCurrentSceneEditable({
        currentSceneId: 'scene-1',
        sceneCount: 1,
        generatingOutlineCount: 1,
        hasCurrentScene: true,
      }),
    ).toBe(true);
  });

  it('keeps unresolved pending scenes blocked even when the flag is enabled', async () => {
    process.env[FLAG_KEY] = 'true';
    const { isMaicEditorEnabled } = await loadFlags();

    expect(isMaicEditorEnabled()).toBe(true);
    expect(
      isCurrentSceneEditable({
        currentSceneId: '__pending__',
        sceneCount: 1,
        generatingOutlineCount: 1,
        hasCurrentScene: false,
      }),
    ).toBe(false);
  });

  it('hides the edit toggle path when the deployment flag is missing', async () => {
    delete process.env[FLAG_KEY];
    const { isMaicEditorEnabled } = await loadFlags();

    expect(isMaicEditorEnabled()).toBe(false);
  });
});
