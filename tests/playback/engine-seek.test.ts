import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlaybackEngine } from '@/lib/playback/engine';
import {
  canJumpWithinReconstructablePrefix,
  getActionLineProgress,
} from '@/lib/playback/action-navigation';
import type { ActionEngine } from '@/lib/action/engine';
import { AudioPlayer } from '@/lib/utils/audio-player';
import type { Action } from '@/lib/types/action';
import type { Scene } from '@/lib/types/stage';

const audioBytes = vi.hoisted(() => vi.fn());
vi.mock('@/lib/media/resolve-audio-bytes', () => ({ resolveAudioBlob: audioBytes }));

function speech(id: string, text = id, audioId?: string): Action {
  return { id, type: 'speech', text, ...(audioId ? { audioId } : {}) } as Action;
}

function scene(actions: Action[]): Scene {
  return {
    id: 'scene-1',
    stageId: 'stage-1',
    type: 'slide',
    title: 'Scene 1',
    order: 0,
    content: {
      type: 'slide',
      canvas: {
        viewportSize: { width: 1600, height: 900 },
        elements: [],
      },
    },
    actions,
  } as unknown as Scene;
}

function fakeActionEngine(): ActionEngine {
  return {
    clearEffects: vi.fn(),
    resetPlaybackVisualState: vi.fn(),
    execute: vi.fn().mockResolvedValue(undefined),
  } as unknown as ActionEngine;
}

function fakeAudio(play: AudioPlayer['play'] = vi.fn().mockResolvedValue(false)): AudioPlayer {
  return {
    play,
    pause: vi.fn(),
    stop: vi.fn(),
    resume: vi.fn(),
    isPlaying: vi.fn(() => false),
    hasActiveAudio: vi.fn(() => false),
    getCurrentTime: vi.fn(() => 0),
    getDuration: vi.fn(() => 0),
    onEnded: vi.fn(),
    setMuted: vi.fn(),
    setVolume: vi.fn(),
    setPlaybackRate: vi.fn(),
    destroy: vi.fn(),
  } as unknown as AudioPlayer;
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}

describe('PlaybackEngine action-boundary seek compatibility', () => {
  it('classifies speech and deterministic whiteboard prefixes as jumpable', () => {
    const actions = [
      speech('speech-1', 'A line.'),
      { id: 'wb-1', type: 'wb_open' },
      { id: 'wb-2', type: 'wb_draw_text', content: 'Written state', x: 0, y: 0 },
      speech('speech-2', 'Second line.'),
    ] as Action[];

    expect(canJumpWithinReconstructablePrefix(actions, 0, 0)).toBe(true);
    expect(canJumpWithinReconstructablePrefix(actions, 0, 3)).toBe(true);
    expect(getActionLineProgress(actions, 3)).toEqual({ currentLine: 2, totalLines: 2 });
  });

  it.each([
    ['widget action', { id: 'widget-1', type: 'widget_reveal', target: 'part-a' }],
    ['discussion action', { id: 'discussion-1', type: 'discussion', topic: 'Question?' }],
    ['play_video action', { id: 'video-1', type: 'play_video', elementId: 'video-1' }],
  ] as Array<[string, Action]>)(
    'does not jump across %s reconstruction',
    async (_label, unsafe) => {
      const actions = [speech('speech-1', 'A line.'), unsafe, speech('speech-2', 'Second line.')];
      const actionEngine = fakeActionEngine();
      const engine = new PlaybackEngine([scene(actions)], actionEngine, fakeAudio());

      expect(engine.canJumpToAction(2)).toBe(false);
      expect(await engine.jumpToAction(2)).toBe(false);
      expect(engine.getSnapshot().actionIndex).toBe(0);
      expect(actionEngine.resetPlaybackVisualState).not.toHaveBeenCalled();
    },
  );

  it('positions playback at the requested speech action and reports snapshot progress', async () => {
    const onProgress = vi.fn();
    const engine = new PlaybackEngine(
      [scene([speech('speech-1', 'First line.'), speech('speech-2', 'Second line.')])],
      fakeActionEngine(),
      fakeAudio(),
      { onProgress },
    );

    expect(await engine.jumpToAction(1, { autoplay: false })).toBe(true);

    expect(engine.getMode()).toBe('idle');
    expect(engine.getSnapshot()).toMatchObject({ sceneIndex: 0, actionIndex: 1 });
    expect(onProgress).toHaveBeenLastCalledWith(
      expect.objectContaining({ sceneIndex: 0, actionIndex: 1 }),
    );
    expect('getProgress' in engine).toBe(false);
    expect('seekTo' in engine).toBe(false);
  });

  it('silently replays reconstructable whiteboard state before the target speech', async () => {
    const actionEngine = fakeActionEngine();
    const actions = [
      speech('speech-1', 'First line.'),
      { id: 'wb-1', type: 'wb_open' },
      { id: 'wb-2', type: 'wb_draw_text', content: 'Important state', x: 10, y: 20 },
      speech('speech-2', 'Second line.'),
    ] as Action[];
    const engine = new PlaybackEngine([scene(actions)], actionEngine, fakeAudio());

    expect(await engine.jumpToAction(3, { autoplay: false })).toBe(true);

    expect(actionEngine.resetPlaybackVisualState).toHaveBeenCalledTimes(1);
    expect(actionEngine.execute).toHaveBeenCalledTimes(2);
    expect(actionEngine.execute).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ type: 'wb_open' }),
      { silent: true },
    );
    expect(actionEngine.execute).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ type: 'wb_draw_text' }),
      { silent: true },
    );
  });

  it('autoplay continues from the jumped-to speech action with canonical audioId playback', async () => {
    const play = vi.fn().mockResolvedValue(true);
    const engine = new PlaybackEngine(
      [
        scene([
          speech('speech-1', 'First line.', 'audio-1'),
          speech('speech-2', 'Second line.', 'audio-2'),
        ]),
      ],
      fakeActionEngine(),
      fakeAudio(play),
    );

    expect(await engine.jumpToAction(1, { autoplay: true })).toBe(true);
    await flushPromises();

    expect(engine.getMode()).toBe('playing');
    expect(play).toHaveBeenCalledWith('audio-2', undefined);
    expect(engine.getSnapshot().actionIndex).toBe(2);
  });
});

describe('generated narration completion ownership', () => {
  const text =
    'Tools are executable actions the model can invoke, including sending emails, running code, calling external APIs, updating databases, and triggering complete automated workflows.';

  class AudioElement extends EventTarget {
    static instances: AudioElement[] = [];
    paused = true;
    currentTime = 0;
    duration = 18;
    playbackRate = 1;
    defaultPlaybackRate = 1;
    volume = 1;
    src = '';
    constructor() {
      super();
      AudioElement.instances.push(this);
    }
    play = vi.fn(async () => {
      this.paused = false;
    });
    pause = vi.fn(() => {
      this.paused = true;
    });
    end() {
      this.paused = true;
      this.currentTime = this.duration;
      this.dispatchEvent(new Event('ended'));
    }
  }

  const engines: PlaybackEngine[] = [];
  afterEach(() => {
    engines.splice(0).forEach((engine) => engine.stop());
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function setup(speed = 1) {
    vi.useFakeTimers();
    AudioElement.instances = [];
    vi.stubGlobal('Audio', AudioElement);
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:narration-test');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    audioBytes.mockReset().mockResolvedValue(new Blob(['complete mocked WAV']));
    const player = new AudioPlayer();
    player.setPlaybackRate(speed);
    const onSpeechStart = vi.fn();
    const onComplete = vi.fn();
    const engine = new PlaybackEngine(
      [
        scene([
          speech('one', text, 'ast_one'),
          speech('two', 'The next complete sentence.', 'ast_two'),
        ]),
      ],
      fakeActionEngine(),
      player,
      { onSpeechStart, onComplete, getPlaybackSpeed: () => speed },
    );
    engines.push(engine);
    return { engine, player, onSpeechStart, onComplete };
  }

  it.each([1, 1.5, 2])(
    'waits for native ended, not reading estimates, at speed %s',
    async (speed) => {
      const { engine, player, onSpeechStart, onComplete } = setup(speed);
      engine.start();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(onSpeechStart).toHaveBeenCalledExactlyOnceWith(text);
      expect(AudioElement.instances).toHaveLength(1);
      expect(AudioElement.instances[0].playbackRate).toBe(speed);
      expect(AudioElement.instances[0].pause).not.toHaveBeenCalled();
      AudioElement.instances[0].end();
      await vi.advanceTimersByTimeAsync(0);
      expect(onSpeechStart).toHaveBeenCalledTimes(2);
      expect(onComplete).not.toHaveBeenCalled();
      AudioElement.instances[1].end();
      expect(onComplete).toHaveBeenCalledTimes(1);
      expect(player.hasActiveAudio()).toBe(false);
    },
  );

  it('ignores an old clip completion while the next sentence is still playing', async () => {
    const { engine, onComplete } = setup();
    engine.start();
    await vi.advanceTimersByTimeAsync(0);
    const oldAudio = AudioElement.instances[0];
    await engine.jumpToAction(1, { autoplay: true });
    await vi.advanceTimersByTimeAsync(0);
    const currentAudio = AudioElement.instances[1];
    currentAudio.currentTime = 15; // The final words have not played yet.
    oldAudio.end(); // A queued completion from the superseded element.
    expect(onComplete).not.toHaveBeenCalled();
    expect(currentAudio.pause).not.toHaveBeenCalled();
    currentAudio.end();
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('consumes each natural completion once across consecutive speech actions', async () => {
    const { engine, onComplete } = setup();
    engine.start();
    await vi.advanceTimersByTimeAsync(0);
    const first = AudioElement.instances[0];
    first.end();
    await vi.advanceTimersByTimeAsync(0);
    first.dispatchEvent(new Event('ended'));
    expect(onComplete).not.toHaveBeenCalled();
    AudioElement.instances[1].end();
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('retires the previous element while replacement audio bytes are still loading', async () => {
    const { engine, onComplete } = setup();
    engine.start();
    await vi.advanceTimersByTimeAsync(0);
    const oldAudio = AudioElement.instances[0];
    let resolveBytes!: (blob: Blob) => void;
    audioBytes.mockReturnValueOnce(
      new Promise<Blob>((resolve) => {
        resolveBytes = resolve;
      }),
    );
    await engine.jumpToAction(1, { autoplay: true });
    oldAudio.end();
    expect(onComplete).not.toHaveBeenCalled();
    resolveBytes(new Blob(['second complete WAV']));
    await vi.advanceTimersByTimeAsync(0);
    AudioElement.instances[1].end();
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('resumes the same generated clip without a fallback timer', async () => {
    const { engine, onComplete } = setup();
    engine.start();
    await vi.advanceTimersByTimeAsync(0);
    const first = AudioElement.instances[0];
    first.currentTime = 12;
    engine.pause();
    engine.resume();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(first.currentTime).toBe(12);
    expect(AudioElement.instances).toHaveLength(1);
    first.end();
    await vi.advanceTimersByTimeAsync(0);
    AudioElement.instances[1].end();
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('retains estimated reading progression when generated audio is unavailable', async () => {
    const { engine, onSpeechStart, onComplete } = setup();
    audioBytes.mockResolvedValue(null);
    engine.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onSpeechStart).toHaveBeenCalledTimes(2);
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(AudioElement.instances).toHaveLength(0);
  });
});
