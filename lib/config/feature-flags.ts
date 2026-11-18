/**
 * Feature flags. Public flags come from `NEXT_PUBLIC_*` env vars, which
 * Next.js inlines at build time so they are safe to read from client
 * components. Server-only flags must not use the `NEXT_PUBLIC_` prefix.
 *
 * Truthy values: `'true'`, `'1'`, `'yes'`, or `'on'` (case-insensitive).
 * Anything else (including unset) is treated as disabled.
 */

import type { Scene, SceneType } from '@/lib/types/stage';
import { isAllowedDeterministicInteractiveScene } from '@/lib/interactive/capabilities';

export type FeatureFlag =
  | 'generatedClassroomAgents'
  | 'companionSelector'
  | 'classroomChat'
  | 'voiceCloning'
  | 'staticVoice'
  | 'promptPersonalization'
  | 'webSearch'
  | 'classroomImport'
  | 'whiteboard'
  | 'interactiveScenes'
  | 'deterministicInteractives'
  | 'discussionScenes'
  | 'workspaceScenes'
  | 'flowScenes';

const TRUE_VALUES = new Set(['true', '1', 'yes', 'on']);

export function readFeatureFlagBoolean(envValue: string | undefined): boolean {
  return TRUE_VALUES.has((envValue ?? '').trim().toLowerCase());
}

const readBoolean = readFeatureFlagBoolean;

/**
 * Server-only gate for durable background agent execution. This is evaluated
 * at process runtime and is never exposed to the browser bundle.
 */
export function isAgentRuntimeEnabled(): boolean {
  return readBoolean(process.env.OPENMAIC_AGENT_RUNTIME_ENABLED);
}

/** The Node runtime can start the runner only with a non-empty database URL. */
export function isAgentRuntimeConfigured(): boolean {
  return isAgentRuntimeEnabled() && Boolean(process.env.DATABASE_URL?.trim());
}

/**
 * Server-side persistence is available: documents, runtime rows and assets are
 * durable and owner-scoped. This is the same condition the persistence route
 * itself keys on, and it is strictly weaker than
 * {@link isAgentRuntimeConfigured} — every deployment that runs the agent
 * runtime also has persistence, but persistence runs perfectly well without it.
 *
 * Anything that describes a persisted course (who owns it, whether it is
 * published) must gate on THIS, not on the agent runtime: the persistence
 * route resolves an owner for every request and the owner-bound document store
 * records one for every course, so those facts exist whether or not the runtime
 * is enabled.
 */
export function isServerPersistenceConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL?.trim());
}

/**
 * Build-time workbench affordance. This public flag is separate from the
 * server runtime gate because Next.js inlines NEXT_PUBLIC values into client
 * bundles; both gates must be on before a workbench page is reachable.
 */
export function isProWorkbenchEnabled(): boolean {
  return readBoolean(process.env.NEXT_PUBLIC_PRO_WORKBENCH_ENABLED);
}

/**
 * MAIC Editor (Pro mode) gate. Default OFF — gates only the Pro toggle
 * affordance in `Header`. The `StageMode` type union is unaffected so
 * existing code paths typecheck identically with the flag in either
 * state.
 *
 * Implied by the Pro workbench flag: the workbench IS Pro mode, and a
 * workbench build without the editor toggle has no way to edit a course.
 * The standalone flag remains for deployments that want the classroom
 * editor without the workbench.
 */
export function isMaicEditorEnabled(): boolean {
  return isProWorkbenchEnabled() || readBoolean(process.env.NEXT_PUBLIC_MAIC_EDITOR_ENABLED);
}

/** Course-level narration versioning UI. Kept independent from the editor gate for rollback. */
export function isCourseNarrationSwitchingEnabled(): boolean {
  return readBoolean(process.env.NEXT_PUBLIC_FEATURE_COURSE_NARRATION_SWITCHING);
}

/** Server-only permission for preview-only engines to synthesize course narration. */
export function isExperimentalCourseNarrationEnabled(): boolean {
  return readBoolean(process.env.OPENMAIC_ENABLE_EXPERIMENTAL_COURSE_NARRATION);
}

/** Server route gate paired with the public editor affordance gate. */
export function isCourseNarrationServerEnabled(): boolean {
  return readBoolean(process.env.OPENMAIC_ENABLE_COURSE_NARRATION_SWITCHING);
}

/**
 * Experimental playback canvas renderer. Default OFF so classroom playback uses
 * the legacy in-app renderer unless explicitly enabled in `.env.local`.
 */
export function isPlaybackRendererEnabled(): boolean {
  return readBoolean(process.env.NEXT_PUBLIC_MAIC_PLAYBACK_RENDERER_ENABLED);
}

/**
 * Experimental Pro-mode slide editor renderer. Default OFF so professional
 * editing keeps using the legacy in-app editor canvas unless explicitly enabled
 * in `.env.local`.
 */
export function isEditorRendererEnabled(): boolean {
  return readBoolean(process.env.NEXT_PUBLIC_MAIC_EDITOR_RENDERER_ENABLED);
}

/**
 * Experimental Pi-based classroom chat runtime. Default OFF. The same public
 * flag selects the client runtime and gates the corresponding server route.
 */
export function isPiChatEnabled(): boolean {
  return readBoolean(process.env.NEXT_PUBLIC_PI_CHAT_ENABLED);
}

/**
 * Unified playback courseware-reference gate for PPT and Interactive scenes.
 * Default OFF and independently disableable while Pi chat remains available.
 */
export function isCoursewareReferenceEnabled(): boolean {
  return readBoolean(process.env.NEXT_PUBLIC_COURSEWARE_REFERENCE_ENABLED);
}

/**
 * Server-only selector for the Pi Child execution harness. Default OFF keeps
 * the existing Legacy JSON-action Child runtime.
 */
export function isPiNativeChildRuntimeEnabled(): boolean {
  return readBoolean(process.env.OPENMAIC_ENABLE_PI_NATIVE_CHILD_RUNTIME);
}

/**
 * Server-only capability gate for Native Child Spotlight. This flag never
 * selects the Child runtime and has no effect while the Legacy harness is used.
 */
export function isPiNativeChildSpotlightEnabled(): boolean {
  return readBoolean(process.env.OPENMAIC_ENABLE_PI_NATIVE_CHILD_SPOTLIGHT);
}

/**
 * Server-authoritative gate for the vocational task-engine generation path.
 * Default OFF. When disabled, requests that include taskEngineMode must
 * silently fall back to the ordinary standard / interactive generation paths.
 */
export function isVocationalTaskEngineEnabled(): boolean {
  return readFeatureFlagBoolean(process.env.OPENMAIC_ENABLE_VOCATIONAL);
}

export function resolveVocationalActive(
  requirements?: { taskEngineMode?: boolean } | null,
): boolean {
  return Boolean(requirements?.taskEngineMode) && isVocationalTaskEngineEnabled();
}

/**
 * Optional client-only affordance for exposing the experimental vocational
 * test toggle. This is not a security or routing gate.
 */
export function shouldShowVocationalTestUi(): boolean {
  return readFeatureFlagBoolean(process.env.NEXT_PUBLIC_SHOW_VOCATIONAL_TEST_UI);
}

/**
 * Experimental classroom video export (Hyperframes composition ZIP, #865).
 * Default OFF — gates only the "Export Video" affordance in the export menu.
 * The emitter/compiler code paths are unaffected; this hides the UI entry
 * point until the render pipeline (#866) lands.
 */
export function isVideoExportEnabled(): boolean {
  return readFeatureFlagBoolean(process.env.NEXT_PUBLIC_ENABLE_VIDEO_EXPORT);
}

/**
 * Optional burned-in captions for MP4/Hyperframes export. Default OFF so the
 * exported video does not cover slide content unless explicitly requested.
 * Sidecar subtitles (`subtitles.srt` / `subtitles.vtt`) are still emitted.
 */
export function isVideoExportBurnedInCaptionsEnabled(): boolean {
  return readFeatureFlagBoolean(process.env.NEXT_PUBLIC_VIDEO_EXPORT_BURN_IN_CAPTIONS);
}

const featureFlags = {
  generatedClassroomAgents: readFeatureFlagBoolean(
    process.env.NEXT_PUBLIC_FEATURE_GENERATED_CLASSROOM_AGENTS,
  ),
  companionSelector: readFeatureFlagBoolean(process.env.NEXT_PUBLIC_FEATURE_COMPANION_SELECTOR),
  classroomChat: readFeatureFlagBoolean(process.env.NEXT_PUBLIC_FEATURE_CLASSROOM_CHAT),
  voiceCloning: readFeatureFlagBoolean(process.env.NEXT_PUBLIC_FEATURE_VOICE_CLONING),
  staticVoice: readFeatureFlagBoolean(process.env.NEXT_PUBLIC_FEATURE_STATIC_VOICE),
  promptPersonalization: readFeatureFlagBoolean(
    process.env.NEXT_PUBLIC_FEATURE_PROMPT_PERSONALIZATION,
  ),
  webSearch: readFeatureFlagBoolean(process.env.NEXT_PUBLIC_FEATURE_WEB_SEARCH),
  classroomImport: readFeatureFlagBoolean(process.env.NEXT_PUBLIC_FEATURE_CLASSROOM_IMPORT),
  whiteboard: readFeatureFlagBoolean(process.env.NEXT_PUBLIC_FEATURE_WHITEBOARD),
  interactiveScenes: readFeatureFlagBoolean(process.env.NEXT_PUBLIC_FEATURE_INTERACTIVE_SCENES),
  deterministicInteractives:
    process.env.NEXT_PUBLIC_FEATURE_DETERMINISTIC_INTERACTIVES == null
      ? true
      : readFeatureFlagBoolean(process.env.NEXT_PUBLIC_FEATURE_DETERMINISTIC_INTERACTIVES),
  discussionScenes:
    readFeatureFlagBoolean(process.env.NEXT_PUBLIC_FEATURE_INTERACTIVE_SCENES) &&
    readFeatureFlagBoolean(process.env.NEXT_PUBLIC_FEATURE_DISCUSSION_SCENES),
  workspaceScenes:
    readFeatureFlagBoolean(process.env.NEXT_PUBLIC_FEATURE_INTERACTIVE_SCENES) &&
    readFeatureFlagBoolean(process.env.NEXT_PUBLIC_FEATURE_WORKSPACE_SCENES),
  flowScenes:
    readFeatureFlagBoolean(process.env.NEXT_PUBLIC_FEATURE_INTERACTIVE_SCENES) &&
    readFeatureFlagBoolean(process.env.NEXT_PUBLIC_FEATURE_FLOW_SCENES),
} as const satisfies Record<FeatureFlag, boolean>;

export const FEATURE_FLAGS: Readonly<Record<FeatureFlag, boolean>> = featureFlags;

export function isFeatureEnabled(flag: FeatureFlag): boolean {
  return featureFlags[flag];
}

export function isCompanionSelectorEnabled(): boolean {
  return isFeatureEnabled('companionSelector');
}

export function isGeneratedClassroomAgentsEnabled(): boolean {
  return isFeatureEnabled('generatedClassroomAgents');
}

export function isClassroomChatEnabled(): boolean {
  return isFeatureEnabled('classroomChat');
}

export function isVoiceCloningEnabled(): boolean {
  return isFeatureEnabled('voiceCloning');
}

export function isStaticVoiceEnabled(): boolean {
  return isFeatureEnabled('staticVoice');
}

export function isPromptPersonalizationEnabled(): boolean {
  return isFeatureEnabled('promptPersonalization');
}

export function isWebSearchEnabled(): boolean {
  return isFeatureEnabled('webSearch');
}

export function isClassroomImportEnabled(): boolean {
  return isFeatureEnabled('classroomImport');
}

export function isWhiteboardEnabled(): boolean {
  return isFeatureEnabled('whiteboard');
}

export function isInteractiveScenesEnabled(): boolean {
  return isFeatureEnabled('interactiveScenes');
}

export function isDeterministicInteractivesEnabled(): boolean {
  return isFeatureEnabled('deterministicInteractives');
}

export function shouldMountInteractiveIframeHost(): boolean {
  return isInteractiveScenesEnabled() || isDeterministicInteractivesEnabled();
}

export function isDiscussionScenesEnabled(): boolean {
  return isFeatureEnabled('discussionScenes');
}

export function isWorkspaceScenesEnabled(): boolean {
  return isFeatureEnabled('workspaceScenes');
}

export function isFlowScenesEnabled(): boolean {
  return isFeatureEnabled('flowScenes');
}

export function isSceneTypeEnabled(sceneType: SceneType): boolean {
  switch (sceneType) {
    case 'interactive':
      return isInteractiveScenesEnabled() || isDeterministicInteractivesEnabled();
    case 'pbl':
      return isWorkspaceScenesEnabled();
    case 'slide':
    case 'quiz':
    default:
      return true;
  }
}

function isFlowScene(scene: Pick<Scene, 'type' | 'content'>): boolean {
  if (scene.type !== 'interactive' || scene.content.type !== 'interactive') return false;
  if (scene.content.widgetType === 'diagram') {
    const outline = scene.content.widgetConfig;
    return outline?.type === 'diagram' && outline.diagramType === 'flowchart';
  }
  return false;
}

export function isDeterministicInteractiveScene(scene: Pick<Scene, 'type' | 'content'>): boolean {
  return isAllowedDeterministicInteractiveScene({
    id: '',
    title: '',
    ...scene,
  } as Pick<Scene, 'id' | 'title' | 'type' | 'content'>);
}

export function isSceneEnabled(scene: Pick<Scene, 'type' | 'content'>): boolean {
  if (scene.type === 'interactive') {
    if (
      isAllowedDeterministicInteractiveScene({
        id: '',
        title: '',
        ...scene,
      } as Pick<Scene, 'id' | 'title' | 'type' | 'content'>)
    ) {
      return isDeterministicInteractivesEnabled();
    }
    if (isFlowScene(scene)) return isFlowScenesEnabled();
    return isFeatureEnabled('interactiveScenes');
  }
  if (!isSceneTypeEnabled(scene.type)) return false;
  if (isFlowScene(scene) && !isFlowScenesEnabled()) return false;
  return true;
}

export function filterEnabledScenes<T extends Pick<Scene, 'type' | 'content'>>(scenes: T[]): T[] {
  return scenes.filter(isSceneEnabled);
}

/** Experimental PPTX import entry point. Default OFF. */
export function isPptxImportEnabled(): boolean {
  return readBoolean(process.env.NEXT_PUBLIC_ENABLE_PPTX_IMPORT);
}
