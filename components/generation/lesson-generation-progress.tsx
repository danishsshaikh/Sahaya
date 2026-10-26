'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { CheckCircle2, ChevronDown, Clock3, LoaderCircle, Volume2 } from 'lucide-react';
import {
  lessonGenerationPhaseLabel,
  teachingVoiceQueueEtaLabel,
  teachingVoiceQueuePositionLabel,
} from '@/lib/generation/progress';
import type { LessonGenerationPhase, TeachingVoiceQueueProgress } from '@/lib/generation/progress';
import type { SceneOutline } from '@/lib/types/generation';
import { cn } from '@/lib/utils';

interface LessonGenerationProgressProps {
  readonly sceneIndex: number;
  readonly totalScenes: number;
  readonly phase: LessonGenerationPhase;
  readonly sceneType?: SceneOutline['type'];
  readonly etaLabel?: string;
  readonly teachingVoiceQueue?: TeachingVoiceQueueProgress | null;
  readonly defaultExpanded?: boolean;
}

export function LessonGenerationProgress({
  sceneIndex,
  totalScenes,
  phase,
  sceneType,
  etaLabel,
  teachingVoiceQueue,
  defaultExpanded = false,
}: LessonGenerationProgressProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const rootRef = useRef<HTMLDivElement>(null);
  const detailsId = useId();
  const total = Math.max(totalScenes, sceneIndex);
  const queuePositionLabel = teachingVoiceQueue
    ? teachingVoiceQueuePositionLabel(teachingVoiceQueue)
    : null;
  const queueEtaLabel =
    teachingVoiceQueue?.estimatedWaitMs != null
      ? teachingVoiceQueueEtaLabel(teachingVoiceQueue.estimatedWaitMs)
      : null;
  const measuredSlideEta = etaLabel && !etaLabel.startsWith('Estimating') ? etaLabel : null;
  const shortStatus =
    teachingVoiceQueue?.status === 'queued'
      ? 'Voice queued'
      : phase === 'finalizing'
        ? 'Finalizing'
        : 'Generating';

  useEffect(() => {
    if (!expanded) return;

    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setExpanded(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setExpanded(false);
    };

    document.addEventListener('pointerdown', closeOnOutsidePointer);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [expanded]);

  return (
    <div ref={rootRef} className="relative shrink-0" aria-live="polite">
      <button
        type="button"
        aria-label={`${shortStatus}. Slide ${sceneIndex} of ${total}. Show generation details`}
        aria-expanded={expanded}
        aria-controls={detailsId}
        onClick={() => setExpanded((current) => !current)}
        className="flex h-9 max-w-[11.5rem] items-center gap-2 rounded-md border border-border/70 bg-background/75 px-2.5 text-xs text-foreground shadow-sm backdrop-blur-md transition-colors hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 sm:max-w-none"
      >
        <LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
        <span className="hidden font-medium sm:inline">{shortStatus}</span>
        <span className="whitespace-nowrap text-muted-foreground">
          Slide {sceneIndex}/{total}
        </span>
        <ChevronDown
          className={cn('h-3.5 w-3.5 shrink-0 transition-transform', expanded && 'rotate-180')}
        />
      </button>

      {expanded ? (
        <div
          id={detailsId}
          role="dialog"
          aria-label="Lesson generation details"
          className="absolute right-0 top-[calc(100%+0.5rem)] z-50 w-[min(20rem,calc(100vw-2rem))] rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-lg"
        >
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold">Lesson generation</p>
              <p className="text-xs text-muted-foreground">
                Work continues when this panel closes.
              </p>
            </div>
            <LoaderCircle className="h-4 w-4 shrink-0 animate-spin text-primary" />
          </div>

          <div className="space-y-2">
            <StatusRow
              icon={phase === 'narration' || phase === 'finalizing' ? CheckCircle2 : LoaderCircle}
              active={phase !== 'narration' && phase !== 'finalizing'}
              label="Slides"
              value={`Slide ${sceneIndex} of ${total}`}
              detail={
                phase === 'narration' || phase === 'finalizing'
                  ? 'Current slide content ready'
                  : lessonGenerationPhaseLabel(phase, sceneType)
              }
              meta={measuredSlideEta}
            />
            <StatusRow
              icon={teachingVoiceQueue?.status === 'queued' ? Clock3 : Volume2}
              active={teachingVoiceQueue?.status === 'running' || phase === 'narration'}
              label="Narration"
              value={narrationStatus(phase, teachingVoiceQueue)}
              detail={queuePositionLabel}
              meta={queueEtaLabel}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}

function narrationStatus(
  phase: LessonGenerationPhase,
  queue?: TeachingVoiceQueueProgress | null,
): string {
  if (queue?.status === 'queued') return 'Teaching Voice queued';
  if (queue?.status === 'running' || phase === 'narration') return 'Creating voice narration';
  if (phase === 'finalizing') return 'Narration ready';
  return 'Waiting for slide content';
}

function StatusRow({
  icon: Icon,
  active,
  label,
  value,
  detail,
  meta,
}: {
  readonly icon: typeof LoaderCircle;
  readonly active?: boolean;
  readonly label: string;
  readonly value: string;
  readonly detail?: string | null;
  readonly meta?: string | null;
}) {
  return (
    <div className="grid grid-cols-[1.75rem_1fr] gap-2 rounded-md bg-muted/45 p-2.5">
      <div className="flex h-7 w-7 items-center justify-center rounded-md bg-background text-primary">
        <Icon className={cn('h-3.5 w-3.5', active && Icon === LoaderCircle && 'animate-spin')} />
      </div>
      <div className="min-w-0">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-[11px] font-medium uppercase text-muted-foreground">{label}</span>
          <span className="text-xs font-medium">{value}</span>
        </div>
        {detail ? <p className="mt-1 text-xs text-muted-foreground">{detail}</p> : null}
        {meta ? <p className="mt-0.5 text-[11px] text-muted-foreground/80">{meta}</p> : null}
      </div>
    </div>
  );
}
