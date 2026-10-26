interface FirstSceneVisualLifecycle {
  commitVisual: () => void;
  persistVisual: () => Promise<unknown>;
  navigateToClassroom: () => void;
  scheduleNarration?: () => void;
}

/** Keep first-scene visual readiness independent from background narration. */
export async function finalizeFirstSceneVisual({
  commitVisual,
  persistVisual,
  navigateToClassroom,
  scheduleNarration,
}: FirstSceneVisualLifecycle): Promise<void> {
  commitVisual();
  await persistVisual();
  navigateToClassroom();
  scheduleNarration?.();
}
