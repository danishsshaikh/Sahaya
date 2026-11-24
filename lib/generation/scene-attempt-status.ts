import type { SceneOutline } from '@/lib/types/generation';

export type SceneAttemptStatus = {
  id: string;
  regeneration: boolean;
  phase: string;
  outcome?: 'failed' | 'interrupted';
};

const names: Record<SceneOutline['type'], string> = {
  slide: 'slide',
  visualization: 'visualization',
  quiz: 'quiz',
  interactive: 'simulation',
  pbl: 'project',
};

const phases: Record<string, string> = {
  queued: 'Waiting in queue',
  skill: 'Preparing Manim skill',
  documentation: 'Retrieving Manim documentation',
  code: 'Generating animation code',
  'code-check': 'Validating animation code',
  'preview-render': 'Rendering preview',
  'code-repair': 'Correcting animation code',
  'final-render': 'Rendering final animation',
  planning: 'Preparing visualization plan',
  validating: 'Validating visualization',
  repairing: 'Refining visualization plan',
  rendering: 'Rendering animation',
  narration: 'Preparing narration',
  processing: 'Finalizing scene',
  completed: 'Finalizing scene',
  finalizing: 'Finalizing scene',
};

export function sceneAttemptLabel(type: SceneOutline['type'], attempt: SceneAttemptStatus) {
  if (attempt.outcome === 'interrupted')
    return attempt.regeneration ? 'Regeneration interrupted' : 'Generation interrupted';
  if (attempt.outcome === 'failed')
    return attempt.regeneration ? 'Regeneration failed' : 'Generation failed';
  return Object.hasOwn(phases, attempt.phase)
    ? phases[attempt.phase]
    : `${attempt.regeneration ? 'Regenerating' : 'Generating'} ${names[type]}…`;
}

type Attempts = Record<string, SceneAttemptStatus>;

/** Track UI progress against the stage epoch and the dispatch that owns the row. */
export function beginSceneAttempt(
  store: {
    getState(): { stage: { id: string } | null; generationEpoch: number; sceneAttempts: Attempts };
    setState(update: (state: { sceneAttempts: Attempts }) => { sceneAttempts: Attempts }): void;
  },
  stageId: string,
  outlineId: string,
  id: string,
  regeneration: boolean,
) {
  const state = store.getState();
  const existing = state.sceneAttempts[outlineId];
  if (state.stage?.id !== stageId || (existing && !existing.outcome)) return;
  const epoch = state.generationEpoch;
  const current = () => {
    const latest = store.getState();
    return (
      latest.stage?.id === stageId &&
      latest.generationEpoch === epoch &&
      latest.sceneAttempts[outlineId]?.id === id &&
      !latest.sceneAttempts[outlineId].outcome
    );
  };
  store.setState(() => ({
    sceneAttempts: {
      ...state.sceneAttempts,
      [outlineId]: { id, regeneration, phase: regeneration ? 'generating' : 'queued' },
    },
  }));
  return {
    current,
    progress(phase: string) {
      if (!current()) return;
      store.setState(({ sceneAttempts }) => ({
        sceneAttempts: { ...sceneAttempts, [outlineId]: { id, regeneration, phase } },
      }));
    },
    finish(outcome?: SceneAttemptStatus['outcome']) {
      if (!current()) return;
      store.setState(({ sceneAttempts }) => {
        const next = { ...sceneAttempts };
        if (outcome) next[outlineId] = { ...next[outlineId], outcome };
        else delete next[outlineId];
        return { sceneAttempts: next };
      });
    },
  };
}
