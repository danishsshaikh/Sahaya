// @vitest-environment jsdom

import { act, createElement, createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import {
  VisualizationRenderer,
  type VisualizationPlayback,
} from '@/components/scene-renderers/visualization-renderer';
import type { Scene } from '@/lib/types/stage';

vi.mock('@/lib/store/settings', () => {
  const settings = {
    ttsEnabled: false,
    ttsMuted: true,
    ttsVolume: 1,
    playbackSpeed: 1,
    setPlaybackSpeed: vi.fn(),
  };
  return {
    PLAYBACK_SPEEDS: [1, 1.25, 1.5, 2],
    useSettingsStore: (selector: (state: typeof settings) => unknown) => selector(settings),
  };
});
vi.mock('@/lib/media/resolve-audio-bytes', () => ({ resolveAudioBlob: vi.fn() }));

const artifactId = 'a'.repeat(64);
const scene: Extract<Scene, { type: 'visualization' }> = {
  type: 'visualization',
  id: 'scene',
  stageId: 'course',
  title: 'Tangent slope',
  order: 1,
  actions: [{ type: 'speech', id: 'viz-0', text: 'This is the edited narration.' }],
  content: {
    type: 'visualization',
    artifact: {
      artifactId,
      duration: 4,
      width: 854,
      height: 480,
      fps: 15,
      bytes: 2000,
      sha256: 'b'.repeat(64),
      rendererVersion: '0.22.1/1',
      specVersion: 1,
      quality: 'preview',
      classification: 'illustrative',
      cues: [
        { id: 'viz-0', start: 0, end: 2, narration: 'Original narration' },
        { id: 'viz-1', start: 2, end: 4, caption: 'Tangent at one point' },
      ],
    },
  },
};

it('seeks through the visual cues, delegates classroom controls, and preserves position on navigation', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  const controller = createRef<VisualizationPlayback>();
  const onCue = vi.fn();
  const onComplete = vi.fn();
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(createElement(VisualizationRenderer, { scene, controller, onCue, onComplete })),
    );
    const video = container.querySelector('video')!;
    Object.defineProperty(video, 'duration', { value: 4 });
    act(() => {
      video.dispatchEvent(new Event('loadedmetadata'));
    });
    expect(container.textContent).toContain('This is the edited narration.');
    expect(onCue).toHaveBeenCalledWith(0, 'This is the edited narration.');
    await act(async () => controller.current?.play());
    expect(play).toHaveBeenCalledTimes(1);

    act(() => {
      video.currentTime = 2.5;
      video.dispatchEvent(new Event('seeked'));
    });
    expect(
      container.querySelector<HTMLInputElement>('[aria-label="Visualization position"]')?.value,
    ).toBe('2.5');
    expect(container.textContent).toContain('Tangent at one point');
    act(() => {
      video.dispatchEvent(new Event('ended'));
    });
    expect(onComplete).toHaveBeenCalledTimes(1);
  } finally {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
  expect(pause).toHaveBeenCalled();
  expect(controller.current).toBeNull();
  expect(sessionStorage.getItem(`sahaya:visualization:course:scene:${artifactId}`)).toBe('2.5');
  sessionStorage.clear();
  vi.restoreAllMocks();
});
