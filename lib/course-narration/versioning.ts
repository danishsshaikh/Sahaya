import type { SpeechAction } from '@/lib/types/action';
import type { Scene } from '@/lib/types/stage';
import type {
  CourseNarrationSelection,
  CourseNarrationState,
  CourseNarrationVersion,
} from './types';

function speeches(scene: Pick<Scene, 'actions'>): SpeechAction[] {
  return (scene.actions ?? []).filter((action): action is SpeechAction => action.type === 'speech');
}

/** Stable, content-only revision. Audio ids and visual data deliberately do not participate. */
export function courseNarrationContentFingerprint(scenes: readonly Scene[]): string {
  return JSON.stringify(
    [...scenes]
      .sort((left, right) => left.order - right.order)
      .map((scene) => ({
        sceneId: scene.id,
        speech: speeches(scene).map((action) => ({ id: action.id, text: action.text })),
      })),
  );
}

export function transcriptFingerprint(text: string): string {
  // This fingerprint is a deterministic equality marker, not telemetry or a security digest.
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function sceneNarrationText(scene: Pick<Scene, 'actions'>): string {
  return speeches(scene)
    .map((action) => action.text)
    .join('\n');
}

export function captureOriginalNarration(
  scenes: readonly Scene[],
  language: CourseNarrationSelection['language'],
  providerName = 'Original narration',
): CourseNarrationVersion {
  const timestamp = new Date().toISOString();
  return {
    id: 'original',
    providerId: 'original',
    providerName,
    language,
    settings: {},
    createdAt: timestamp,
    updatedAt: timestamp,
    status: 'complete',
    contentFingerprint: courseNarrationContentFingerprint(scenes),
    scenes: Object.fromEntries(
      scenes.map((scene) => [
        scene.id,
        {
          sceneId: scene.id,
          clips: Object.fromEntries(
            speeches(scene).map((action) => [
              action.id,
              {
                transcript: action.text,
                transcriptFingerprint: transcriptFingerprint(action.text),
                ...(action.audioId ? { audioId: action.audioId } : {}),
              },
            ]),
          ),
        },
      ]),
    ),
    failures: [],
  };
}

export function ensureOriginalNarrationState(
  state: CourseNarrationState | undefined,
  scenes: readonly Scene[],
  language: CourseNarrationSelection['language'],
  providerName?: string,
): CourseNarrationState {
  if (state?.schemaVersion === 1 && state.versions.some((version) => version.id === 'original')) {
    return state;
  }
  const original = captureOriginalNarration(scenes, language, providerName);
  return {
    schemaVersion: 1,
    activeVersionId: state?.activeVersionId ?? original.id,
    versions: [original, ...(state?.versions ?? [])],
  };
}

export function versionMatchesSelection(
  version: CourseNarrationVersion,
  selection: CourseNarrationSelection,
  scenes: readonly Scene[],
): boolean {
  return (
    version.status === 'complete' &&
    version.contentFingerprint === courseNarrationContentFingerprint(scenes) &&
    version.providerId === selection.providerId &&
    version.profileId === selection.profileId &&
    version.language === selection.language &&
    version.settings.voice === selection.voice &&
    version.settings.style === selection.style &&
    version.settings.enhancementMode === selection.enhancementMode
  );
}

export function isNarrationVersionStale(
  version: CourseNarrationVersion,
  scenes: readonly Scene[],
): boolean {
  return version.contentFingerprint !== courseNarrationContentFingerprint(scenes);
}

export function applyNarrationVersion(
  scenes: readonly Scene[],
  version: CourseNarrationVersion,
): Scene[] {
  if (version.status !== 'complete') throw new Error('Narration version is not complete.');
  if (isNarrationVersionStale(version, scenes)) {
    throw new Error('Narration version is outdated for the current course transcript.');
  }

  return scenes.map((scene) => {
    const sceneVersion = version.scenes[scene.id];
    if (!sceneVersion) throw new Error(`Narration version is missing scene ${scene.id}.`);
    return {
      ...scene,
      actions: (scene.actions ?? []).map((action) => {
        if (action.type !== 'speech') return action;
        const clip = sceneVersion.clips[action.id];
        if (!clip || clip.transcript !== action.text) {
          throw new Error(`Narration version is missing speech ${action.id}.`);
        }
        const next = { ...action };
        if (clip.audioId) next.audioId = clip.audioId;
        else delete next.audioId;
        return next;
      }),
    } as Scene;
  });
}
