import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the IndexedDB layer so importing AudioPlayer doesn't pull in Dexie.
const getMock = vi.fn();
vi.mock('@/lib/utils/database', () => ({
  db: { audioFiles: { get: getMock } },
}));

/** Stub URL.createObjectURL/revokeObjectURL while keeping `new URL(...)` working. */
function stubObjectUrl() {
  let next = 0;
  const createObjectURL = vi.fn(() => `blob:fake-url-${++next}`);
  const revokeObjectURL = vi.fn();
  class URLStub extends URL {}
  Object.assign(URLStub, { createObjectURL, revokeObjectURL });
  vi.stubGlobal('URL', URLStub);
  return { createObjectURL, revokeObjectURL };
}

function stubAudio(play: () => Promise<void>) {
  class AudioStub {
    play = play;
    addEventListener = vi.fn();
    pause = vi.fn();
    volume = 1;
    defaultPlaybackRate = 1;
    playbackRate = 1;
    src = '';
    currentTime = 0;
  }
  vi.stubGlobal('Audio', AudioStub);
}

function stubObservableAudio() {
  const instances: Array<{
    currentTime: number;
    duration: number;
    playbackRate: number;
    emit: (type: string) => void;
  }> = [];
  class AudioStub {
    private listeners = new Map<string, Array<() => void>>();
    play = vi.fn().mockResolvedValue(undefined);
    pause = vi.fn();
    volume = 1;
    defaultPlaybackRate = 1;
    playbackRate = 1;
    src = '';
    currentTime = 0;
    duration = 10;

    constructor() {
      instances.push(this);
    }

    addEventListener(type: string, listener: () => void) {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    }

    emit(type: string) {
      for (const listener of this.listeners.get(type) ?? []) listener();
    }
  }
  vi.stubGlobal('Audio', AudioStub);
  return instances;
}

describe('AudioPlayer blob URL lifecycle', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    getMock.mockReset();
    getMock.mockResolvedValue({ blob: new Blob(['audio']) });
  });

  it('revokes the blob URL when play() rejects (no leak)', async () => {
    const { createObjectURL, revokeObjectURL } = stubObjectUrl();
    stubAudio(() => Promise.reject(new Error('NotAllowedError')));

    const { AudioPlayer } = await import('@/lib/utils/audio-player');

    await expect(new AudioPlayer().play('audio-1')).rejects.toThrow();
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:fake-url-1');
  });

  it('does not revoke during a successful play() (revocation is deferred to "ended")', async () => {
    const { revokeObjectURL } = stubObjectUrl();
    stubAudio(() => Promise.resolve());

    const { AudioPlayer } = await import('@/lib/utils/audio-player');

    await expect(new AudioPlayer().play('audio-1')).resolves.toBe(true);
    expect(revokeObjectURL).not.toHaveBeenCalled();
  });

  it('revokes the blob URL when playback is stopped before it ends', async () => {
    const { createObjectURL, revokeObjectURL } = stubObjectUrl();
    stubAudio(() => Promise.resolve());

    const { AudioPlayer } = await import('@/lib/utils/audio-player');

    const player = new AudioPlayer();
    await expect(player.play('audio-1')).resolves.toBe(true);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).not.toHaveBeenCalled();

    player.stop();

    // The fetched narration is released with the dropped element instead of
    // leaking for the page lifetime.
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:fake-url-1');
  });

  it('revokes the previous blob URL when playback is replaced', async () => {
    const { createObjectURL, revokeObjectURL } = stubObjectUrl();
    stubAudio(() => Promise.resolve());

    const { AudioPlayer } = await import('@/lib/utils/audio-player');

    const player = new AudioPlayer();
    await player.play('audio-1');
    await player.play('audio-2');

    expect(createObjectURL).toHaveBeenCalledTimes(2);
    // The first narration's URL was released when the second replaced it.
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:fake-url-1');
  });

  it('does not revoke on pause (playback can resume from the same element)', async () => {
    const { revokeObjectURL } = stubObjectUrl();
    stubAudio(() => Promise.resolve());

    const { AudioPlayer } = await import('@/lib/utils/audio-player');

    const player = new AudioPlayer();
    await player.play('audio-1');
    player.pause();

    expect(revokeObjectURL).not.toHaveBeenCalled();
  });

  it('revokes through destroy(), which stops playback', async () => {
    const { revokeObjectURL } = stubObjectUrl();
    stubAudio(() => Promise.resolve());

    const { AudioPlayer } = await import('@/lib/utils/audio-player');

    const player = new AudioPlayer();
    await player.play('audio-1');
    player.destroy();

    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:fake-url-1');
  });

  it('publishes actual media currentTime for play, seek, rate changes, and end', async () => {
    stubObjectUrl();
    const instances = stubObservableAudio();
    const { AudioPlayer } = await import('@/lib/utils/audio-player');
    const player = new AudioPlayer();
    const updates = vi.fn();
    player.subscribePlayback(updates);

    await player.play('audio-1');
    const audio = instances[0];
    expect(updates).toHaveBeenLastCalledWith({ currentTimeMs: 0, durationMs: 10000, ended: false });

    audio.currentTime = 4.25;
    audio.emit('seeked');
    expect(updates).toHaveBeenLastCalledWith({
      currentTimeMs: 4250,
      durationMs: 10000,
      ended: false,
    });

    updates.mockClear();
    player.pause();
    audio.currentTime = 5;
    expect(updates).not.toHaveBeenCalled();
    player.resume();
    audio.emit('timeupdate');
    expect(updates).toHaveBeenLastCalledWith({
      currentTimeMs: 5000,
      durationMs: 10000,
      ended: false,
    });

    player.setPlaybackRate(1.5);
    expect(audio.playbackRate).toBe(1.5);
    audio.currentTime = 7;
    audio.emit('timeupdate');
    expect(updates).toHaveBeenLastCalledWith({
      currentTimeMs: 7000,
      durationMs: 10000,
      ended: false,
    });

    audio.currentTime = 10;
    audio.emit('ended');
    expect(updates).toHaveBeenLastCalledWith({
      currentTimeMs: 10000,
      durationMs: 10000,
      ended: true,
    });
  });
});
