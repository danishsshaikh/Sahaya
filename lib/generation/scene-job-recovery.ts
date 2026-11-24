type SceneDispatch = {
  attemptId: string;
  regeneration: boolean;
  job?: { jobId: string; attemptId: string; generationVersion: string };
};

function key(stageId: string, outlineId: string) {
  return `sahaya.scene-dispatch.${encodeURIComponent(stageId)}.${encodeURIComponent(outlineId)}`;
}

export function readSceneDispatch(stageId: string, outlineId: string): SceneDispatch | undefined {
  try {
    const saved = JSON.parse(sessionStorage.getItem(key(stageId, outlineId)) ?? 'null');
    if (typeof saved?.attemptId !== 'string' || typeof saved.regeneration !== 'boolean') return;
    if (
      saved.job &&
      ![saved.job.jobId, saved.job.attemptId, saved.job.generationVersion].every(
        (value) => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value),
      )
    )
      return;
    return saved;
  } catch {
    // Generation still works when the browser disables session storage.
    return undefined;
  }
}

export function writeSceneDispatch(stageId: string, outlineId: string, dispatch: SceneDispatch) {
  try {
    sessionStorage.setItem(key(stageId, outlineId), JSON.stringify(dispatch));
  } catch {
    // Recovery is best effort. The job and its ownership live on the server.
  }
}

export function clearSceneDispatch(stageId: string, outlineId: string, attemptId: string) {
  if (readSceneDispatch(stageId, outlineId)?.attemptId !== attemptId) return;
  try {
    sessionStorage.removeItem(key(stageId, outlineId));
  } catch {
    // See writeSceneDispatch.
  }
}
