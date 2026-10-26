'use client';

import { useMemo, useRef, useState } from 'react';
import { Check, Loader2, WandSparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useI18n } from '@/lib/hooks/use-i18n';
import { requestPronunciationRepair } from '@/lib/audio/pronunciation-repair';
import { findPronunciationPhraseOccurrences } from '@/lib/audio/pronunciation-selection';
import { cn } from '@/lib/utils/cn';

interface PronunciationRepairDialogProps {
  readonly stageId: string;
  readonly sceneId: string;
  readonly actionId: string;
  readonly actionIndex: number;
  readonly displayText: string;
  readonly language?: string;
  readonly actionVoicePending: boolean;
  readonly onRepaired: (audioId: string) => void;
  readonly onPendingChange: (pending: boolean) => void;
}

type RepairPhase = 'idle' | 'generating' | 'success' | 'error';

export function PronunciationRepairDialog({
  stageId,
  sceneId,
  actionId,
  actionIndex,
  displayText,
  language,
  actionVoicePending,
  onRepaired,
  onPendingChange,
}: PronunciationRepairDialogProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [phrase, setPhrase] = useState('');
  const [pronounceAs, setPronounceAs] = useState('');
  const [occurrenceIndex, setOccurrenceIndex] = useState(0);
  const [phase, setPhase] = useState<RepairPhase>('idle');
  const [message, setMessage] = useState('');
  const [successText, setSuccessText] = useState<string | null>(null);
  const operationRef = useRef(0);

  const occurrences = useMemo(
    () => findPronunciationPhraseOccurrences(displayText, phrase),
    [displayText, phrase],
  );
  const selectedOccurrence = occurrences[Math.min(occurrenceIndex, occurrences.length - 1)];
  const repairSucceeded = successText === displayText;

  const begin = () => {
    operationRef.current += 1;
    setPhrase('');
    setPronounceAs('');
    setOccurrenceIndex(0);
    setPhase('idle');
    setMessage('');
    setOpen(true);
  };

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
  };

  const submit = async () => {
    if (!phrase) {
      setPhase('error');
      setMessage(t('edit.tts.pronunciationPhraseRequired'));
      return;
    }
    if (!selectedOccurrence) {
      setPhase('error');
      setMessage(t('edit.tts.pronunciationPhraseNotFound'));
      return;
    }
    if (!pronounceAs.trim()) {
      setPhase('error');
      setMessage(t('edit.tts.pronounceAsRequired'));
      return;
    }
    if (actionVoicePending) {
      setPhase('error');
      setMessage(t('edit.tts.pronunciationVoicePending'));
      return;
    }

    const operation = ++operationRef.current;
    setPhase('generating');
    setMessage('');
    onPendingChange(true);
    try {
      const result = await requestPronunciationRepair({
        stageId,
        sceneId,
        actionId,
        actionIndex,
        displayText,
        startOffset: selectedOccurrence.startOffset,
        endOffset: selectedOccurrence.endOffset,
        pronounceAs,
        language,
      });
      if (operation !== operationRef.current) return;
      if (result.status === 'stale') {
        setPhase('error');
        setMessage(t('edit.tts.pronunciationStale'));
        return;
      }
      onRepaired(result.audioId);
      setSuccessText(displayText);
      setPhase('success');
      setMessage(t('edit.tts.pronunciationSuccess'));
    } catch {
      if (operation !== operationRef.current) return;
      setPhase('error');
      setMessage(t('edit.tts.pronunciationFailed'));
    } finally {
      if (operation === operationRef.current) onPendingChange(false);
    }
  };

  return (
    <>
      <button
        type="button"
        data-action-id={actionId}
        onClick={begin}
        disabled={actionVoicePending || phase === 'generating' || !displayText.trim()}
        className={cn(
          'inline-flex h-5 shrink-0 items-center gap-1 rounded-md px-1.5 text-[10px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40',
          repairSucceeded
            ? 'text-emerald-600 hover:bg-emerald-500/10 dark:text-emerald-400'
            : 'text-primary hover:bg-primary/10',
        )}
        aria-label={t('edit.tts.fixPronunciation')}
        title={
          actionVoicePending
            ? t('edit.tts.pronunciationVoicePending')
            : t('edit.tts.fixPronunciation')
        }
      >
        {repairSucceeded ? <Check className="size-3" /> : <WandSparkles className="size-3" />}
        {t('edit.tts.fixPronunciation')}
      </button>

      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent
          data-testid="pronunciation-repair-dialog"
          className="max-w-[calc(100vw-2rem)] gap-5 sm:max-w-[480px]"
        >
          <DialogHeader>
            <DialogTitle>{t('edit.tts.pronunciationTitle')}</DialogTitle>
            <DialogDescription>{t('edit.tts.pronunciationDescription')}</DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-1.5">
              <p className="text-[11px] font-medium uppercase text-muted-foreground">
                {t('edit.tts.originalNarration')}
              </p>
              <p
                data-testid="pronunciation-original-text"
                className="max-h-28 overflow-y-auto rounded-md border border-border/70 bg-muted/30 px-3 py-2 text-sm leading-relaxed text-foreground"
              >
                {selectedOccurrence ? (
                  <>
                    {displayText.slice(0, selectedOccurrence.startOffset)}
                    <mark className="rounded-sm bg-primary/15 text-foreground">
                      {displayText.slice(
                        selectedOccurrence.startOffset,
                        selectedOccurrence.endOffset,
                      )}
                    </mark>
                    {displayText.slice(selectedOccurrence.endOffset)}
                  </>
                ) : (
                  displayText
                )}
              </p>
            </div>

            <label className="block space-y-1.5 text-xs font-medium text-foreground">
              {t('edit.tts.pronunciationPhrase')}
              <input
                value={phrase}
                onChange={(event) => {
                  setPhrase(event.target.value);
                  setOccurrenceIndex(0);
                  setPhase('idle');
                  setMessage('');
                }}
                disabled={phase === 'generating'}
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary/20 disabled:opacity-60"
                placeholder={t('edit.tts.pronunciationPhrasePlaceholder')}
              />
            </label>

            {occurrences.length > 1 ? (
              <label className="block space-y-1.5 text-xs font-medium text-foreground">
                {t('edit.tts.pronunciationOccurrence')}
                <select
                  value={Math.min(occurrenceIndex, occurrences.length - 1)}
                  onChange={(event) => setOccurrenceIndex(Number(event.target.value))}
                  disabled={phase === 'generating'}
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary/20 disabled:opacity-60"
                >
                  {occurrences.map((occurrence, index) => (
                    <option key={occurrence.startOffset} value={index}>
                      {t('edit.tts.pronunciationOccurrenceOption', {
                        current: index + 1,
                        total: occurrences.length,
                      })}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}

            <label className="block space-y-1.5 text-xs font-medium text-foreground">
              {t('edit.tts.pronounceAs')}
              <input
                value={pronounceAs}
                onChange={(event) => {
                  setPronounceAs(event.target.value);
                  setPhase('idle');
                  setMessage('');
                }}
                disabled={phase === 'generating'}
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary/20 disabled:opacity-60"
                placeholder={t('edit.tts.pronounceAsPlaceholder')}
              />
            </label>

            <p className="text-xs leading-relaxed text-muted-foreground">
              {t('edit.tts.pronunciationTextUnchanged')}
            </p>

            {message ? (
              <p
                role={phase === 'error' ? 'alert' : 'status'}
                className={cn(
                  'text-xs font-medium',
                  phase === 'error' ? 'text-destructive' : 'text-emerald-600 dark:text-emerald-400',
                )}
              >
                {message}
              </p>
            ) : null}
          </div>

          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={phase === 'generating'}>
                {t('common.cancel')}
              </Button>
            </DialogClose>
            <Button
              type="button"
              onClick={() => void submit()}
              disabled={phase === 'generating' || actionVoicePending}
            >
              {phase === 'generating' ? <Loader2 className="size-4 animate-spin" /> : null}
              {phase === 'generating'
                ? t('edit.tts.pronunciationGenerating')
                : t('edit.tts.regenerateVoice')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
