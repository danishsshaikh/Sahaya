import { generateAndStoreTTS, removeFreshTtsAllocations } from '@/lib/hooks/use-scene-generator';
import { useStageStore } from '@/lib/store/stage';
import type { SpeechAction } from '@/lib/types/action';
import { mayGenerateForStage } from '@/lib/classroom/generation-permission';

export interface PronunciationRepairRequest {
  stageId: string;
  sceneId: string;
  actionId: string;
  actionIndex: number;
  displayText: string;
  startOffset: number;
  endOffset: number;
  pronounceAs?: string;
  language?: string;
}

export type PronunciationRepairResult =
  | { status: 'replaced'; audioId: string; repairIdentity: string }
  | { status: 'stale'; repairIdentity: string };

const inFlightRepairs = new Map<string, Promise<PronunciationRepairResult>>();
const latestRepairByAction = new Map<string, string>();

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function buildPronunciationSynthesisText(
  displayText: string,
  startOffset: number,
  endOffset: number,
  pronounceAs?: string,
): string {
  const replacement = pronounceAs?.trim();
  if (!replacement) return displayText;
  return `${displayText.slice(0, startOffset)}${replacement}${displayText.slice(endOffset)}`;
}

export function createPronunciationRepairIdentity(input: PronunciationRepairRequest): string {
  const synthesisText = buildPronunciationSynthesisText(
    input.displayText,
    input.startOffset,
    input.endOffset,
    input.pronounceAs,
  );
  return stableHash(
    JSON.stringify({
      stageId: input.stageId,
      sceneId: input.sceneId,
      actionId: input.actionId,
      displayText: input.displayText,
      startOffset: input.startOffset,
      endOffset: input.endOffset,
      synthesisText,
    }),
  );
}

function actionKey(input: PronunciationRepairRequest): string {
  return `${input.stageId}:${input.sceneId}:${input.actionId}`;
}

function currentSpeechAction(input: PronunciationRepairRequest): SpeechAction | null {
  const scene = useStageStore.getState().getSceneById(input.sceneId);
  const action = scene?.actions?.[input.actionIndex];
  return action?.type === 'speech' && action.id === input.actionId ? action : null;
}

export function requestPronunciationRepair(
  input: PronunciationRepairRequest,
): Promise<PronunciationRepairResult> {
  const state = useStageStore.getState();
  const scene = state.getSceneById(input.sceneId);
  const action = currentSpeechAction(input);
  if (!mayGenerateForStage(input.stageId)) {
    return Promise.reject(new Error('Pronunciation repair is unavailable for this classroom.'));
  }
  if (
    state.stage?.id !== input.stageId ||
    scene?.stageId !== input.stageId ||
    !action ||
    action.text !== input.displayText
  ) {
    return Promise.reject(new Error('The narration changed before pronunciation repair started.'));
  }

  const generationEpoch = state.generationEpoch;
  const repairIdentity = createPronunciationRepairIdentity(input);
  const logicalActionKey = actionKey(input);
  const taskKey = `${logicalActionKey}:${repairIdentity}`;
  const existing = inFlightRepairs.get(taskKey);
  if (existing) return existing;

  latestRepairByAction.set(logicalActionKey, repairIdentity);
  const synthesisText = buildPronunciationSynthesisText(
    input.displayText,
    input.startOffset,
    input.endOffset,
    input.pronounceAs,
  );
  const outlineId = state.outlines.find((outline) => outline.order === scene.order)?.id;
  const requestId = `tts_pronunciation_s${scene.order}_${input.actionId}_${repairIdentity}`;

  const promise = (async (): Promise<PronunciationRepairResult> => {
    const audioId = await generateAndStoreTTS(
      requestId,
      synthesisText,
      input.language,
      undefined,
      undefined,
      undefined,
      input.stageId,
      undefined,
      0,
      input.sceneId,
      undefined,
      outlineId,
    );
    if (!audioId) throw new Error('Pronunciation repair did not produce audio.');

    const latest = useStageStore.getState();
    const latestScene = latest.getSceneById(input.sceneId);
    const latestAction = latestScene?.actions?.[input.actionIndex];
    const isCurrent =
      latest.stage?.id === input.stageId &&
      latest.generationEpoch === generationEpoch &&
      latestRepairByAction.get(logicalActionKey) === repairIdentity &&
      latestAction?.type === 'speech' &&
      latestAction.id === input.actionId &&
      latestAction.text === input.displayText;
    if (!isCurrent || !latestScene) {
      await removeFreshTtsAllocations([audioId]);
      return { status: 'stale', repairIdentity };
    }

    const actions = [...(latestScene.actions ?? [])];
    actions[input.actionIndex] = {
      ...latestAction,
      audioId,
      audioInvalidated: false,
    };
    latest.updateScene(input.sceneId, { actions, narrationStatus: 'completed' });
    return { status: 'replaced', audioId, repairIdentity };
  })().finally(() => {
    if (inFlightRepairs.get(taskKey) === promise) inFlightRepairs.delete(taskKey);
  });

  inFlightRepairs.set(taskKey, promise);
  return promise;
}

export function resetPronunciationRepairStateForTests(): void {
  inFlightRepairs.clear();
  latestRepairByAction.clear();
}
