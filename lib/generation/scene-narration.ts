import type { Action, SpeechAction } from '@/lib/types/action';
import type { Scene, ScenePatch } from '@/lib/types/stage';

const NARRATION_RETRY_MESSAGE = 'Narration is unavailable. Open Edit to retry the affected lines.';
const NARRATION_CHANGED_MESSAGE =
  'Narration changed while audio was being created. Open Edit to retry the affected lines.';

function isSpeech(action: Action): action is SpeechAction {
  return action.type === 'speech';
}

export function sceneWithPendingNarration(scene: Scene): Scene {
  return {
    ...scene,
    narrationStatus: 'pending',
    narrationError: undefined,
  };
}

/** A detached copy for TTS, which mutates speech actions with generated audio IDs. */
export function sceneForNarrationSynthesis(scene: Scene): Scene {
  return {
    ...scene,
    actions: scene.actions.map((action: Action) => ({ ...action })),
  };
}

export function narrationProgressPatch(status: 'queued' | 'running'): ScenePatch {
  return { narrationStatus: status, narrationError: undefined };
}

export function narrationFailurePatch(): ScenePatch {
  return {
    narrationStatus: 'failed',
    narrationError: NARRATION_RETRY_MESSAGE,
  };
}

/**
 * Merge only audio produced for narration text that is still current. Editing
 * a scene while later generation continues must never be overwritten by the
 * stale scene object that originally entered synthesis.
 */
export function mergeCompletedNarration(current: Scene, generated: Scene): ScenePatch {
  const generatedSpeech = new Map<string, SpeechAction>(
    generated.actions
      .filter((action: Action): action is SpeechAction => isSpeech(action))
      .map((action: SpeechAction) => [action.id, action] as const),
  );
  let needsRetry = false;
  const actions = current.actions.map((action: Action) => {
    if (!isSpeech(action)) return action;
    const generatedAction = generatedSpeech.get(action.id);
    if (!generatedAction?.audioId) {
      needsRetry = true;
      return action;
    }
    if (generatedAction.text !== action.text) {
      needsRetry = true;
      return action;
    }
    // Another observer may have completed the same idempotent job, or faculty
    // may have committed a pronunciation repair while this observer was still
    // downloading. A completed current allocation is newer authority and must
    // not be replaced by this late result.
    if (current.narrationStatus === 'completed' && action.audioId) return action;
    return { ...action, audioId: generatedAction.audioId };
  });

  return {
    actions,
    narrationStatus: needsRetry ? 'needs-retry' : 'completed',
    narrationError: needsRetry ? NARRATION_CHANGED_MESSAGE : undefined,
  };
}
