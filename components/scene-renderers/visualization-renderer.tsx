'use client';

import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { Captions, Download, Maximize, Pause, Play, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { SpeechAction } from '@/lib/types/action';
import type { Scene } from '@/lib/types/stage';
import { PLAYBACK_SPEEDS, useSettingsStore } from '@/lib/store/settings';
import { resolveAudioBlob } from '@/lib/media/resolve-audio-bytes';
import { visualizationMediaUrl } from '@/lib/visualization/client';
import { visualizationCueAt, visualizationCueTiming } from '@/lib/visualization/timing';

export interface VisualizationPlayback {
  toggle: () => void;
  play: () => void;
  pause: () => void;
}

export interface VisualizationPlaybackProps {
  controller?: Ref<VisualizationPlayback>;
  onState?: (state: 'playing' | 'paused' | 'idle') => void;
  onCue?: (index: number, text: string | null) => void;
  onComplete?: () => void;
}

const playbackRates = PLAYBACK_SPEEDS;
const formatTime = (time: number) =>
  `${Math.floor(time / 60)}:${String(Math.floor(time % 60)).padStart(2, '0')}`;

export function VisualizationRenderer({
  scene,
  controller,
  onState,
  onCue,
  onComplete,
}: VisualizationPlaybackProps & { scene: Extract<Scene, { type: 'visualization' }> }) {
  const { artifact } = scene.content;
  const videoRef = useRef<HTMLVideoElement>(null);
  const playerRef = useRef<HTMLDivElement>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const sourceAnchorRef = useRef<{
    clip: string;
    offset: number;
    clock: number;
    speed: number;
  } | null>(null);
  const buffers = useRef(new Map<string, AudioBuffer>());
  const currentCue = useRef<string | undefined>(undefined);
  const [position, setPosition] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [captions, setCaptions] = useState(true);
  const [caption, setCaption] = useState('');
  const [error, setError] = useState('');
  const speed = useSettingsStore((state) => state.playbackSpeed);
  const setSpeed = useSettingsStore((state) => state.setPlaybackSpeed);
  const audioEnabled = useSettingsStore((state) => state.ttsEnabled && !state.ttsMuted);
  const volume = useSettingsStore((state) => state.ttsVolume);
  const pausedClip = useRef(false);
  const pendingPlay = useRef(0);
  const pendingDecodes = useRef(new Map<string, Promise<void>>());
  const [preparingAudio, setPreparingAudio] = useState(false);
  const narrationPending =
    audioEnabled && ['pending', 'queued', 'running'].includes(scene.narrationStatus ?? '');
  const resumeKey = controller
    ? `sahaya:visualization:${scene.stageId}:${scene.id}:${artifact.artifactId}`
    : undefined;

  const actionsForCue = useCallback(
    (cueId: string | undefined) =>
      cueId
        ? (scene.actions ?? []).filter(
            (action): action is SpeechAction =>
              action.type === 'speech' &&
              (action.id === cueId || action.id.startsWith(`${cueId}_tts_`)),
          )
        : [],
    [scene.actions],
  );

  const prepareClip = useCallback(
    (action: SpeechAction, context: AudioContext) => {
      const key = action.audioId;
      if (!key || action.audioInvalidated || buffers.current.has(key)) return Promise.resolve();
      const pending = pendingDecodes.current.get(key);
      if (pending) return pending;
      const operation = (async () => {
        const blob = await resolveAudioBlob(key);
        let bytes = await blob?.arrayBuffer();
        // A server-generated classroom can still have the legacy audio URL
        // until the classroom importer has copied it to the regular audio pool.
        const transport = (action as SpeechAction & { audioUrl?: string }).audioUrl;
        if (!bytes && transport) {
          const url = new URL(transport, window.location.origin);
          if (
            url.pathname.startsWith(
              `/api/classroom-media/${encodeURIComponent(scene.stageId)}/audio/`,
            )
          ) {
            const response = await fetch(url.pathname, { signal: AbortSignal.timeout(8000) });
            if (response.ok) bytes = await response.arrayBuffer();
          }
        }
        if (!bytes || contextRef.current !== context) return;
        const decoded = await context.decodeAudioData(bytes);
        if (contextRef.current === context) buffers.current.set(key, decoded);
      })()
        .catch(() => {})
        .finally(() => pendingDecodes.current.delete(key));
      pendingDecodes.current.set(key, operation);
      return operation;
    },
    [scene.stageId],
  );

  const silence = useCallback(() => {
    sourceRef.current?.stop();
    sourceRef.current?.disconnect();
    sourceRef.current = null;
    sourceAnchorRef.current = null;
  }, []);

  const play = useCallback(() => {
    const video = videoRef.current;
    if (!video || narrationPending) return;
    const token = ++pendingPlay.current;
    if (audioEnabled && !contextRef.current && typeof AudioContext !== 'undefined') {
      contextRef.current = new AudioContext();
    }
    const context = contextRef.current;
    void context?.resume().catch(() => {});
    if (video.ended) video.currentTime = 0;
    void (async () => {
      const clips = actionsForCue(visualizationCueAt(artifact.cues, video.currentTime)?.id);
      if (
        context &&
        audioEnabled &&
        clips.some((clip) => clip.audioId && !buffers.current.has(clip.audioId))
      ) {
        setPreparingAudio(true);
        await Promise.all(clips.map((clip) => prepareClip(clip, context)));
      }
      if (token !== pendingPlay.current) return;
      setPreparingAudio(false);
      await video.play();
    })().catch(() => {
      if (video.error)
        setError('The visualization could not play. Check that its artifact is available.');
    });
  }, [actionsForCue, artifact.cues, audioEnabled, narrationPending, prepareClip]);
  const pause = useCallback(() => {
    pendingPlay.current++;
    setPreparingAudio(false);
    videoRef.current?.pause();
    silence();
  }, [silence]);
  const toggle = useCallback(() => {
    if (!preparingAudio && videoRef.current?.paused) play();
    else pause();
  }, [pause, play, preparingAudio]);
  useImperativeHandle(controller, () => ({ toggle, play, pause }), [toggle, play, pause]);
  const cancelPendingPlay = useCallback(() => {
    pendingPlay.current++;
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    const decodedAudio = buffers.current;
    return () => {
      cancelPendingPlay();
      video?.pause();
      if (resumeKey && video) {
        try {
          if (video.ended) sessionStorage.removeItem(resumeKey);
          else if (video.currentTime > 0)
            sessionStorage.setItem(resumeKey, String(video.currentTime));
        } catch {
          // Playback remains available if browser storage is full or disabled.
        }
      }
      silence();
      void contextRef.current?.close().catch(() => {});
      contextRef.current = null;
      decodedAudio.clear();
    };
  }, [cancelPendingPlay, resumeKey, silence]);

  useEffect(() => {
    if (!playing || !audioEnabled || !contextRef.current) return;
    const context = contextRef.current;
    let abandoned = false;
    const audioActions = (scene.actions ?? []).filter(
      (action): action is SpeechAction =>
        action.type === 'speech' && !!action.audioId && !action.audioInvalidated,
    );
    // Decode at most four clips in parallel while the video continues.
    void (async () => {
      for (let index = 0; !abandoned && index < audioActions.length; index += 4) {
        await Promise.all(
          audioActions.slice(index, index + 4).map((action) => prepareClip(action, context)),
        );
      }
    })();
    return () => {
      abandoned = true;
    };
  }, [audioEnabled, playing, prepareClip, scene.actions]);

  const synchronize = useCallback(
    (force = false) => {
      const video = videoRef.current;
      if (!video) return;
      const time = video.currentTime;
      const cue = visualizationCueAt(artifact.cues, time);
      const matching = actionsForCue(cue?.id);
      const text = matching.length
        ? matching.map((action) => action.text).join(' ')
        : (cue?.caption ?? '');
      setPosition((previous) => (force || Math.abs(time - previous) > 0.08 ? time : previous));
      if (cue?.id !== currentCue.current || force) {
        currentCue.current = cue?.id;
        setCaption(text);
        const index = matching.length ? (scene.actions ?? []).indexOf(matching[0]) : -1;
        onCue?.(index, text || null);
      }
      const clips = matching.flatMap((action) => {
        const key = action.audioId;
        const buffer = key && buffers.current.get(key);
        return key && buffer && !action.audioInvalidated ? [{ key, buffer }] : [];
      });
      const duration = clips.reduce((sum, clip) => sum + clip.buffer.duration, 0);
      const timing = cue
        ? visualizationCueTiming(cue, time, audioEnabled ? duration : 0, speed)
        : { rate: speed, offset: 0 };
      const rate = Math.max(0.0625, timing.rate);
      if (Math.abs(video.playbackRate - rate) > 0.001) video.playbackRate = rate;
      const context = contextRef.current;
      if (!audioEnabled || !context || video.paused || video.seeking || pausedClip.current) {
        silence();
        return;
      }
      let offset = timing.offset;
      const clip = clips.find((item) => {
        if (offset < item.buffer.duration) return true;
        offset -= item.buffer.duration;
        return false;
      });
      if (!clip) {
        silence();
        return;
      }
      const audioRate = (speed * rate) / timing.rate;
      const anchor = sourceAnchorRef.current;
      const drift = anchor
        ? Math.abs(anchor.offset + (context.currentTime - anchor.clock) * anchor.speed - offset)
        : Infinity;
      if (
        anchor &&
        anchor.clip === clip.key &&
        !force &&
        drift < 0.14 &&
        anchor.speed === audioRate
      )
        return;
      silence();
      if (context.state !== 'running') return;
      const source = context.createBufferSource();
      source.buffer = clip.buffer;
      source.playbackRate.value = audioRate;
      const gain = context.createGain();
      gain.gain.value = volume;
      source.connect(gain).connect(context.destination);
      source.onended = () => gain.disconnect();
      sourceRef.current = source;
      sourceAnchorRef.current = {
        clip: clip.key,
        offset,
        clock: context.currentTime,
        speed: audioRate,
      };
      source.start(0, offset);
    },
    [actionsForCue, artifact.cues, audioEnabled, onCue, scene.actions, silence, speed, volume],
  );

  useEffect(() => {
    if (!playing) {
      synchronize(true);
      return;
    }
    let frame: number;
    const tick = () => {
      synchronize();
      frame = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(frame);
  }, [playing, synchronize]);

  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden) pause();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [pause]);

  return (
    <div ref={playerRef} className="flex h-full w-full flex-col bg-slate-950 text-slate-50">
      <div className="relative flex min-h-0 flex-1 items-center justify-center">
        <video
          ref={videoRef}
          aria-label={scene.title}
          className="h-full w-full object-contain"
          src={visualizationMediaUrl(artifact.artifactId, 'video.mp4')}
          poster={visualizationMediaUrl(artifact.artifactId, 'poster.jpg')}
          playsInline
          muted
          preload="metadata"
          onLoadedMetadata={() => {
            const video = videoRef.current;
            if (video && resumeKey) {
              try {
                const previous = Number(sessionStorage.getItem(resumeKey));
                if (previous > 0 && previous < video.duration) video.currentTime = previous;
              } catch {
                // Browsers may restrict session storage in embedded contexts.
              }
            }
            setLoaded(true);
          }}
          onPlay={() => {
            setPlaying(true);
            pausedClip.current = false;
            onState?.('playing');
          }}
          onPlaying={() => {
            pausedClip.current = false;
            synchronize(true);
          }}
          onWaiting={() => {
            pausedClip.current = true;
            silence();
          }}
          onPause={() => {
            setPlaying(false);
            silence();
            onState?.('paused');
          }}
          onSeeking={() => silence()}
          onSeeked={() => synchronize(true)}
          onEnded={() => {
            setPlaying(false);
            silence();
            onState?.('idle');
            onComplete?.();
          }}
          onError={() =>
            setError(
              'The visualization artifact is unavailable. Check the renderer service and sign in as its owner.',
            )
          }
        />
        {(narrationPending || preparingAudio) && !error && (
          <span className="absolute rounded bg-slate-950/85 p-2 text-sm" role="status">
            Preparing Teaching Voice narration…
          </span>
        )}
        {!loaded && !error && !narrationPending && !preparingAudio && (
          <span className="absolute rounded bg-slate-950/85 p-2 text-sm" role="status">
            Loading visualization…
          </span>
        )}
        {error && (
          <span className="absolute mx-4 rounded bg-slate-950 p-3 text-sm" role="alert">
            {error}
          </span>
        )}
        {captions && caption && !error && (
          <p className="pointer-events-none absolute inset-x-3 bottom-3 mx-auto w-fit max-w-[90%] rounded bg-slate-950/85 px-3 py-1.5 text-center text-sm">
            {caption}
          </p>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-slate-700 px-2 py-1">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={playing || preparingAudio ? 'Pause' : 'Play'}
          onClick={toggle}
          disabled={!!error || narrationPending}
        >
          {playing || preparingAudio ? <Pause /> : <Play />}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Replay visualization"
          disabled={!loaded || narrationPending}
          onClick={() => {
            if (videoRef.current) videoRef.current.currentTime = 0;
            play();
          }}
        >
          <RotateCcw />
        </Button>
        <input
          type="range"
          aria-label="Visualization position"
          aria-valuetext={formatTime(position)}
          min={0}
          max={artifact.duration}
          step={0.01}
          value={position}
          disabled={!loaded}
          onChange={(event) => {
            if (videoRef.current) videoRef.current.currentTime = Number(event.target.value);
          }}
          className="min-w-16 flex-1 accent-cyan-300"
        />
        <span className="whitespace-nowrap text-xs tabular-nums">
          {formatTime(position)} / {formatTime(artifact.duration)}
        </span>
        <select
          aria-label="Playback speed"
          className="rounded border border-slate-700 bg-slate-950 p-1 text-xs"
          value={speed}
          onChange={(event) => {
            const selected = playbackRates.find((rate) => rate === Number(event.target.value));
            if (selected) setSpeed(selected);
          }}
        >
          {playbackRates.map((rate) => (
            <option key={rate} value={rate}>
              {rate}×
            </option>
          ))}
        </select>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Captions"
          aria-pressed={captions}
          onClick={() => setCaptions(!captions)}
        >
          <Captions />
        </Button>
        <Button asChild variant="ghost" size="icon">
          <a
            href={visualizationMediaUrl(artifact.artifactId, 'video.mp4')}
            download="visualization.mp4"
            aria-label="Download animation without narration"
          >
            <Download />
          </a>
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Fullscreen"
          onClick={() => {
            const action = document.fullscreenElement
              ? document.exitFullscreen()
              : playerRef.current?.requestFullscreen?.();
            void action?.catch(() => {});
          }}
        >
          <Maximize />
        </Button>
      </div>
    </div>
  );
}
