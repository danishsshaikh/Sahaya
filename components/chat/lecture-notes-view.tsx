'use client';

import { useEffect, useRef, useState } from 'react';
import {
  BookOpen,
  MessageSquare,
  Flashlight,
  MousePointer2,
  Play,
  Highlighter,
  SlidersHorizontal,
  StickyNote,
  Eye,
  LoaderCircle,
  WandSparkles,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/hooks/use-i18n';
import type { LectureNoteEntry } from '@/lib/types/chat';
import type { ActiveNarrationHighlight } from '@/lib/playback/narration-cues';
import { useStageStore } from '@/lib/store/stage';
import { useMayGenerateForStage } from '@/lib/classroom/generation-permission';
import {
  isShortPronunciationSelection,
  selectionOffsetsWithin,
} from '@/lib/audio/pronunciation-selection';
import { requestPronunciationRepair } from '@/lib/audio/pronunciation-repair';

const ACTION_ICON_ONLY: Record<string, { Icon: typeof Flashlight; style: string }> = {
  spotlight: {
    Icon: Flashlight,
    style:
      'bg-yellow-50 dark:bg-yellow-500/15 border-yellow-300/40 dark:border-yellow-500/30 text-yellow-700 dark:text-yellow-300',
  },
  laser: {
    Icon: MousePointer2,
    style:
      'bg-red-50 dark:bg-red-500/15 border-red-300/40 dark:border-red-500/30 text-red-600 dark:text-red-300',
  },
  play_video: {
    Icon: Play,
    style:
      'bg-yellow-50 dark:bg-yellow-500/15 border-yellow-300/40 dark:border-yellow-500/30 text-yellow-700 dark:text-yellow-300',
  },
  widget_highlight: {
    Icon: Highlighter,
    style:
      'bg-amber-50 dark:bg-amber-500/15 border-amber-300/40 dark:border-amber-500/30 text-amber-700 dark:text-amber-300',
  },
  widget_setState: {
    Icon: SlidersHorizontal,
    style:
      'bg-primary/10 dark:bg-primary/10 border-primary/25 dark:border-primary/25 text-primary dark:text-primary',
  },
  widget_annotation: {
    Icon: StickyNote,
    style:
      'bg-sky-50 dark:bg-sky-500/15 border-sky-300/40 dark:border-sky-500/30 text-sky-700 dark:text-sky-300',
  },
  widget_reveal: {
    Icon: Eye,
    style:
      'bg-emerald-50 dark:bg-emerald-500/15 border-emerald-300/40 dark:border-emerald-500/30 text-emerald-700 dark:text-emerald-300',
  },
};

interface LectureNotesViewProps {
  notes: LectureNoteEntry[];
  currentSceneId?: string | null;
  currentActionIndex?: number | null;
  narrationHighlight?: ActiveNarrationHighlight | null;
  canJumpToAction?: (sceneId: string, actionIndex: number) => boolean;
  onJumpToAction?: (sceneId: string, actionIndex: number) => void;
}

interface PronunciationSelection {
  sceneId: string;
  actionId: string;
  actionIndex: number;
  displayText: string;
  startOffset: number;
  endOffset: number;
  selectedText: string;
}

export function LectureNotesView({
  notes,
  currentSceneId,
  currentActionIndex,
  narrationHighlight,
  canJumpToAction,
  onJumpToAction,
}: LectureNotesViewProps) {
  const { t } = useI18n();
  const containerRef = useRef<HTMLDivElement>(null);
  const lastManualScrollAtRef = useRef(0);
  const stage = useStageStore((state) => state.stage);
  const mayRepairPronunciation = useMayGenerateForStage(stage?.id);
  const [pronunciationSelection, setPronunciationSelection] =
    useState<PronunciationSelection | null>(null);
  const [pronounceAs, setPronounceAs] = useState('');
  const [repairStatus, setRepairStatus] = useState<'idle' | 'submitting' | 'error'>('idle');

  const closePronunciationRepair = () => {
    setPronunciationSelection(null);
    setPronounceAs('');
    setRepairStatus('idle');
    window.getSelection()?.removeAllRanges();
  };

  const repairPronunciation = async () => {
    if (!pronunciationSelection || !stage) return;
    setRepairStatus('submitting');
    try {
      const result = await requestPronunciationRepair({
        ...pronunciationSelection,
        stageId: stage.id,
        pronounceAs,
        language: stage.languageDirective,
      });
      if (result.status === 'replaced') closePronunciationRepair();
      else setRepairStatus('error');
    } catch {
      setRepairStatus('error');
    }
  };

  // Auto-scroll to the current scene note
  useEffect(() => {
    if (!currentSceneId || !containerRef.current) return;
    const el = containerRef.current.querySelector(`[data-scene-id="${currentSceneId}"]`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [currentSceneId]);

  useEffect(() => {
    if (!narrationHighlight || Date.now() - lastManualScrollAtRef.current < 3000) return;
    const activeCue = containerRef.current?.querySelector('[data-active-narration-cue="true"]');
    activeCue?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [narrationHighlight]);

  // Empty state
  if (notes.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-center p-6">
        <div className="w-12 h-12 bg-primary/10 dark:bg-primary/10 rounded-2xl flex items-center justify-center mb-3 text-primary dark:text-primary ring-1 ring-primary/25 dark:ring-primary/25">
          <BookOpen className="w-6 h-6" />
        </div>
        <p className="text-xs font-medium text-gray-500 dark:text-gray-400">
          {t('chat.lectureNotes.empty')}
        </p>
        <p className="text-[10px] text-gray-400 dark:text-gray-500 mt-1">
          {t('chat.lectureNotes.emptyHint')}
        </p>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      onWheelCapture={() => {
        lastManualScrollAtRef.current = Date.now();
      }}
      onTouchStartCapture={() => {
        lastManualScrollAtRef.current = Date.now();
      }}
      className="flex-1 overflow-y-auto overflow-x-hidden px-3 py-2 scrollbar-hide"
    >
      {notes.map((note, index) => {
        const isCurrent = note.sceneId === currentSceneId;
        const pageNum = index + 1;
        const pageLabel = t('chat.lectureNotes.pageLabel', { n: pageNum });

        return (
          <div
            key={note.sceneId}
            data-scene-id={note.sceneId}
            className={cn(
              'relative mb-3 last:mb-0 rounded-lg px-3 py-2.5 transition-colors duration-200',
              isCurrent
                ? 'bg-primary/10 dark:bg-primary/10 ring-1 ring-primary/25 dark:ring-primary/25'
                : 'bg-gray-50/50 dark:bg-gray-800/30',
            )}
          >
            {/* Page label row */}
            <div className="flex items-center gap-2 mb-1.5">
              {/* Timeline dot */}
              <div
                className={cn(
                  'w-2 h-2 rounded-full shrink-0',
                  isCurrent
                    ? 'bg-primary shadow-sm shadow-[0_0_0_4px_rgb(var(--brand-shadow)/0.10)]'
                    : 'bg-gray-300 dark:bg-gray-600',
                )}
              />
              <span
                className={cn(
                  'text-[10px] font-semibold tracking-wide',
                  isCurrent ? 'text-primary dark:text-primary' : 'text-gray-400 dark:text-gray-500',
                )}
              >
                {pageLabel}
              </span>
              {isCurrent && (
                <span className="text-[9px] font-bold px-1.5 py-px rounded-full bg-primary/10 dark:bg-primary/10 text-primary dark:text-primary">
                  {t('chat.lectureNotes.currentPage')}
                </span>
              )}
            </div>

            {/* Scene title */}
            <h4 className="text-[13px] font-bold text-gray-800 dark:text-gray-100 mb-1.5 leading-snug pl-4">
              {note.sceneTitle}
            </h4>

            {/* Ordered items: spotlight/laser inline at sentence start, discussion as card */}
            <div className="pl-4 space-y-1">
              {(() => {
                // Build render rows: group inline actions (spotlight/laser) with next speech,
                // but render discussion as its own block
                type Row =
                  | {
                      kind: 'speech';
                      inlineActions: string[];
                      text: string;
                      actionIndex: number;
                      actionId: string;
                    }
                  | { kind: 'discussion'; label?: string; actionIndex: number; actionId: string }
                  | { kind: 'trailing'; inlineActions: string[] };
                const rows: Row[] = [];
                let pendingInline: string[] = [];
                for (const item of note.items) {
                  if (item.kind === 'action' && item.type === 'discussion') {
                    // Flush pending inline actions as trailing if any
                    if (pendingInline.length > 0) {
                      rows.push({
                        kind: 'trailing',
                        inlineActions: pendingInline,
                      });
                      pendingInline = [];
                    }
                    rows.push({
                      kind: 'discussion',
                      label: item.label,
                      actionIndex: item.actionIndex,
                      actionId: item.actionId,
                    });
                  } else if (item.kind === 'action') {
                    pendingInline.push(item.type);
                  } else {
                    rows.push({
                      kind: 'speech',
                      inlineActions: pendingInline,
                      text: item.text,
                      actionIndex: item.actionIndex,
                      actionId: item.actionId,
                    });
                    pendingInline = [];
                  }
                }
                if (pendingInline.length > 0) {
                  rows.push({ kind: 'trailing', inlineActions: pendingInline });
                }
                return rows.map((row, i) => {
                  if (row.kind === 'discussion') {
                    return (
                      <div
                        key={i}
                        className="my-1.5 flex items-start gap-1.5 rounded-md border border-amber-200/60 dark:border-amber-700/30 bg-amber-50/60 dark:bg-amber-900/10 px-2 py-1.5"
                      >
                        <MessageSquare className="w-3 h-3 text-amber-500 dark:text-amber-400 shrink-0 mt-0.5" />
                        <span className="text-[11px] leading-snug text-amber-800 dark:text-amber-300">
                          {row.label}
                        </span>
                      </div>
                    );
                  }
                  const actions = row.kind === 'trailing' ? row.inlineActions : row.inlineActions;
                  const isSpeech = row.kind === 'speech';
                  const isActiveSpeech =
                    isCurrent && isSpeech && row.actionIndex === currentActionIndex;
                  const activeHighlight =
                    isCurrent &&
                    isSpeech &&
                    narrationHighlight?.sceneId === note.sceneId &&
                    narrationHighlight.actionIndex === row.actionIndex &&
                    narrationHighlight.actionId === row.actionId &&
                    narrationHighlight.text === row.text
                      ? narrationHighlight
                      : null;
                  const canJump =
                    isCurrent &&
                    isSpeech &&
                    !!onJumpToAction &&
                    (canJumpToAction?.(note.sceneId, row.actionIndex) ?? false);
                  const jumpTitle = canJump
                    ? t('chat.lectureNotes.jumpToLine')
                    : t('chat.lectureNotes.jumpUnavailable');
                  const content = (
                    <>
                      {actions.map((a, j) => {
                        const cfg = ACTION_ICON_ONLY[a];
                        if (!cfg) return null;
                        const { Icon, style } = cfg;
                        return (
                          <span
                            key={j}
                            className={cn(
                              'inline-flex items-center justify-center w-4 h-4 rounded-full border align-middle mr-0.5',
                              style,
                            )}
                          >
                            <Icon className="w-2.5 h-2.5" />
                          </span>
                        );
                      })}
                      {isSpeech ? (
                        <span
                          data-narration-action-id={row.actionId}
                          onMouseUp={(event) => {
                            if (!mayRepairPronunciation) return;
                            const offsets = selectionOffsetsWithin(
                              event.currentTarget,
                              window.getSelection(),
                            );
                            if (!offsets || !isShortPronunciationSelection(offsets)) return;
                            setPronunciationSelection({
                              sceneId: note.sceneId,
                              actionId: row.actionId,
                              actionIndex: row.actionIndex,
                              displayText: row.text,
                              startOffset: offsets.startOffset,
                              endOffset: offsets.endOffset,
                              selectedText: offsets.text,
                            });
                            setPronounceAs('');
                            setRepairStatus('idle');
                          }}
                        >
                          {activeHighlight ? (
                            <>
                              {row.text.slice(0, activeHighlight.cue.startOffset)}
                              <mark
                                data-active-narration-cue="true"
                                className="rounded-sm bg-primary/20 text-foreground"
                              >
                                {row.text.slice(
                                  activeHighlight.cue.startOffset,
                                  activeHighlight.cue.endOffset,
                                )}
                              </mark>
                              {row.text.slice(activeHighlight.cue.endOffset)}
                            </>
                          ) : (
                            row.text
                          )}
                        </span>
                      ) : null}
                    </>
                  );
                  if (isSpeech) {
                    const repairOpen =
                      pronunciationSelection?.sceneId === note.sceneId &&
                      pronunciationSelection.actionId === row.actionId;
                    return (
                      <div key={row.actionId}>
                        <button
                          type="button"
                          aria-disabled={!canJump}
                          title={jumpTitle}
                          onClick={() => {
                            if (window.getSelection()?.toString().trim()) return;
                            if (canJump) onJumpToAction?.(note.sceneId, row.actionIndex);
                          }}
                          className={cn(
                            'block w-full text-left rounded-md px-1 py-0.5 text-[12px] leading-[1.8] transition-colors',
                            isActiveSpeech
                              ? 'bg-primary/10 text-primary dark:bg-primary/10 dark:text-primary'
                              : 'text-gray-700 dark:text-gray-300',
                            canJump
                              ? 'cursor-pointer hover:bg-primary/10 dark:hover:bg-primary/10'
                              : 'cursor-text',
                          )}
                          aria-label={jumpTitle}
                        >
                          {content}
                        </button>
                        {repairOpen ? (
                          <div className="mt-1.5 rounded-md border border-border/70 bg-background px-2 py-2">
                            <div className="flex items-center gap-1.5">
                              <WandSparkles className="size-3.5 shrink-0 text-primary" />
                              <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-foreground">
                                {pronunciationSelection.selectedText.trim()}
                              </span>
                              <button
                                type="button"
                                onClick={closePronunciationRepair}
                                className="grid size-5 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                                aria-label="Close pronunciation repair"
                                title="Close"
                              >
                                <X className="size-3" />
                              </button>
                            </div>
                            <div className="mt-2 flex items-center gap-1.5">
                              <input
                                value={pronounceAs}
                                onChange={(event) => setPronounceAs(event.target.value)}
                                placeholder="Pronounce as (optional)"
                                className="h-7 min-w-0 flex-1 rounded border border-input bg-transparent px-2 text-[11px] outline-none focus:border-primary"
                              />
                              <button
                                type="button"
                                onClick={() => void repairPronunciation()}
                                disabled={repairStatus === 'submitting'}
                                className="inline-flex h-7 shrink-0 items-center gap-1 rounded bg-primary px-2 text-[11px] font-medium text-primary-foreground disabled:opacity-60"
                              >
                                {repairStatus === 'submitting' ? (
                                  <LoaderCircle className="size-3 animate-spin" />
                                ) : (
                                  <WandSparkles className="size-3" />
                                )}
                                Fix pronunciation
                              </button>
                            </div>
                            {repairStatus === 'error' ? (
                              <p className="mt-1.5 text-[10px] text-destructive">
                                Repair failed. Existing audio was kept.
                              </p>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                    );
                  }
                  return (
                    <p
                      key={i}
                      className="text-[12px] leading-[1.8] text-gray-700 dark:text-gray-300"
                    >
                      {content}
                    </p>
                  );
                });
              })()}
            </div>
          </div>
        );
      })}
    </div>
  );
}
