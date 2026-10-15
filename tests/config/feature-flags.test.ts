import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeScene, type Scene, type SceneContent } from '@/lib/types/stage';
import type { WidgetConfig } from '@/lib/types/widgets';
import type { PBLProjectConfig } from '@/lib/pbl/legacy/read';

const FLAG_KEYS = [
  'DATABASE_URL',
  'OPENMAIC_AGENT_RUNTIME_ENABLED',
  'NEXT_PUBLIC_PRO_WORKBENCH_ENABLED',
  'NEXT_PUBLIC_MAIC_EDITOR_ENABLED',
  'NEXT_PUBLIC_MAIC_EDITOR_RENDERER_ENABLED',
  'NEXT_PUBLIC_MAIC_PLAYBACK_RENDERER_ENABLED',
  'NEXT_PUBLIC_PI_CHAT_ENABLED',
  'NEXT_PUBLIC_COURSEWARE_REFERENCE_ENABLED',
  'OPENMAIC_ENABLE_PI_NATIVE_CHILD_RUNTIME',
  'OPENMAIC_ENABLE_PI_NATIVE_CHILD_SPOTLIGHT',
  'OPENMAIC_ENABLE_VOCATIONAL',
  'NEXT_PUBLIC_SHOW_VOCATIONAL_TEST_UI',
  'NEXT_PUBLIC_ENABLE_VIDEO_EXPORT',
  'NEXT_PUBLIC_VIDEO_EXPORT_BURN_IN_CAPTIONS',
  'NEXT_PUBLIC_ENABLE_PPTX_IMPORT',
  'NEXT_PUBLIC_FEATURE_GENERATED_CLASSROOM_AGENTS',
  'NEXT_PUBLIC_FEATURE_COMPANION_SELECTOR',
  'NEXT_PUBLIC_FEATURE_CLASSROOM_CHAT',
  'NEXT_PUBLIC_FEATURE_VOICE_CLONING',
  'NEXT_PUBLIC_FEATURE_STATIC_VOICE',
  'NEXT_PUBLIC_FEATURE_PROMPT_PERSONALIZATION',
  'NEXT_PUBLIC_FEATURE_WEB_SEARCH',
  'NEXT_PUBLIC_FEATURE_CLASSROOM_IMPORT',
  'NEXT_PUBLIC_FEATURE_WHITEBOARD',
  'NEXT_PUBLIC_FEATURE_INTERACTIVE_SCENES',
  'NEXT_PUBLIC_FEATURE_DETERMINISTIC_INTERACTIVES',
  'NEXT_PUBLIC_FEATURE_DISCUSSION_SCENES',
  'NEXT_PUBLIC_FEATURE_WORKSPACE_SCENES',
  'NEXT_PUBLIC_FEATURE_FLOW_SCENES',
] as const;

const originalEnv = new Map<string, string | undefined>(
  FLAG_KEYS.map((key) => [key, process.env[key]]),
);

async function loadFlags() {
  vi.resetModules();
  return import('@/lib/config/feature-flags');
}

function resetFlagEnv() {
  for (const key of FLAG_KEYS) {
    const original = originalEnv.get(key);
    if (original === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = original;
    }
  }
}

const emptySlideContent = {
  type: 'slide',
  canvas: {
    id: 'slide-canvas',
    viewportSize: 1000,
    viewportRatio: 0.5625,
    theme: {
      backgroundColor: '#ffffff',
      themeColors: ['#5b9bd5'],
      fontColor: '#111111',
      fontName: 'Arial',
    },
    elements: [],
  },
} satisfies Extract<Scene['content'], { type: 'slide' }>;

const flowWidgetConfig = {
  type: 'diagram',
  diagramType: 'flowchart',
  description: 'Simple flowchart',
  nodes: [],
  edges: [],
} satisfies WidgetConfig;

const projectConfig = {
  projectInfo: { title: 'Project', description: 'Project workspace' },
  agents: [],
  issueboard: { agent_ids: [], issues: [], current_issue_id: null },
  chat: { messages: [] },
} satisfies PBLProjectConfig;

function scene(
  content: SceneContent,
  overrides: Partial<Omit<Scene, 'type' | 'content'>> = {},
): Scene {
  return makeScene(
    {
      id: 'scene',
      stageId: 'stage',
      title: 'Scene',
      order: 0,
      actions: [],
      ...overrides,
    },
    content,
  );
}

function sceneCore(overrides: Partial<Omit<Scene, 'type' | 'content'>>) {
  return {
    id: 'scene',
    stageId: 'stage',
    title: 'Scene',
    order: 0,
    actions: [],
    ...overrides,
  };
}

afterEach(() => {
  resetFlagEnv();
  vi.resetModules();
});

describe('readFeatureFlagBoolean', () => {
  it('accepts Sahaya truthy values only', async () => {
    const { readFeatureFlagBoolean } = await loadFlags();

    expect(readFeatureFlagBoolean('true')).toBe(true);
    expect(readFeatureFlagBoolean('TRUE')).toBe(true);
    expect(readFeatureFlagBoolean(' 1 ')).toBe(true);
    expect(readFeatureFlagBoolean('yes')).toBe(true);
    expect(readFeatureFlagBoolean('on')).toBe(true);
    expect(readFeatureFlagBoolean(undefined)).toBe(false);
    expect(readFeatureFlagBoolean('')).toBe(false);
    expect(readFeatureFlagBoolean('false')).toBe(false);
    expect(readFeatureFlagBoolean('enabled')).toBe(false);
  });
});

describe('agent runtime and persistence flags', () => {
  it.each([
    ['off with no DATABASE_URL', undefined, undefined, false, false, false],
    ['off with DATABASE_URL set', undefined, 'postgres://runtime', false, false, true],
    ['on with no DATABASE_URL', 'true', undefined, true, false, false],
    ['on with a blank DATABASE_URL', 'true', '   ', true, false, false],
    ['on with DATABASE_URL set', 'true', 'postgres://runtime', true, true, true],
  ])('%s', async (_case, runtimeFlag, databaseUrl, enabled, configured, persisted) => {
    if (runtimeFlag !== undefined) process.env.OPENMAIC_AGENT_RUNTIME_ENABLED = runtimeFlag;
    if (databaseUrl !== undefined) process.env.DATABASE_URL = databaseUrl;

    const flags = await loadFlags();
    expect(flags.isAgentRuntimeEnabled()).toBe(enabled);
    expect(flags.isAgentRuntimeConfigured()).toBe(configured);
    expect(flags.isServerPersistenceConfigured()).toBe(persisted);
  });
});

describe('standalone feature flags', () => {
  it('keeps MAIC editor default off, accepts true-like values, and follows Pro workbench', async () => {
    let flags = await loadFlags();
    expect(flags.isMaicEditorEnabled()).toBe(false);

    process.env.NEXT_PUBLIC_MAIC_EDITOR_ENABLED = 'on';
    flags = await loadFlags();
    expect(flags.isMaicEditorEnabled()).toBe(true);

    process.env.NEXT_PUBLIC_MAIC_EDITOR_ENABLED = 'false';
    process.env.NEXT_PUBLIC_PRO_WORKBENCH_ENABLED = 'true';
    flags = await loadFlags();
    expect(flags.isMaicEditorEnabled()).toBe(true);
  });

  it('keeps upstream renderer, chat, reference, native child, and import flags default off', async () => {
    let flags = await loadFlags();

    expect(flags.isPlaybackRendererEnabled()).toBe(false);
    expect(flags.isEditorRendererEnabled()).toBe(false);
    expect(flags.isPiChatEnabled()).toBe(false);
    expect(flags.isCoursewareReferenceEnabled()).toBe(false);
    expect(flags.isPiNativeChildRuntimeEnabled()).toBe(false);
    expect(flags.isPiNativeChildSpotlightEnabled()).toBe(false);
    expect(flags.isPptxImportEnabled()).toBe(false);

    process.env.NEXT_PUBLIC_MAIC_PLAYBACK_RENDERER_ENABLED = 'true';
    process.env.NEXT_PUBLIC_MAIC_EDITOR_RENDERER_ENABLED = '1';
    process.env.NEXT_PUBLIC_PI_CHAT_ENABLED = 'yes';
    process.env.NEXT_PUBLIC_COURSEWARE_REFERENCE_ENABLED = 'on';
    process.env.OPENMAIC_ENABLE_PI_NATIVE_CHILD_RUNTIME = 'true';
    process.env.OPENMAIC_ENABLE_PI_NATIVE_CHILD_SPOTLIGHT = '1';
    process.env.NEXT_PUBLIC_ENABLE_PPTX_IMPORT = 'on';
    flags = await loadFlags();

    expect(flags.isPlaybackRendererEnabled()).toBe(true);
    expect(flags.isEditorRendererEnabled()).toBe(true);
    expect(flags.isPiChatEnabled()).toBe(true);
    expect(flags.isCoursewareReferenceEnabled()).toBe(true);
    expect(flags.isPiNativeChildRuntimeEnabled()).toBe(true);
    expect(flags.isPiNativeChildSpotlightEnabled()).toBe(true);
    expect(flags.isPptxImportEnabled()).toBe(true);
  });

  it('requires request intent and the server vocational flag', async () => {
    process.env.OPENMAIC_ENABLE_VOCATIONAL = 'true';
    let flags = await loadFlags();
    expect(flags.isVocationalTaskEngineEnabled()).toBe(true);
    expect(flags.resolveVocationalActive({ taskEngineMode: true })).toBe(true);
    expect(flags.resolveVocationalActive({ taskEngineMode: false })).toBe(false);
    expect(flags.resolveVocationalActive(undefined)).toBe(false);

    process.env.OPENMAIC_ENABLE_VOCATIONAL = 'false';
    flags = await loadFlags();
    expect(flags.resolveVocationalActive({ taskEngineMode: true })).toBe(false);
  });

  it('keeps vocational test UI, video export, and burned-in captions default off', async () => {
    let flags = await loadFlags();
    expect(flags.shouldShowVocationalTestUi()).toBe(false);
    expect(flags.isVideoExportEnabled()).toBe(false);
    expect(flags.isVideoExportBurnedInCaptionsEnabled()).toBe(false);

    process.env.NEXT_PUBLIC_SHOW_VOCATIONAL_TEST_UI = 'yes';
    process.env.NEXT_PUBLIC_ENABLE_VIDEO_EXPORT = '1';
    process.env.NEXT_PUBLIC_VIDEO_EXPORT_BURN_IN_CAPTIONS = 'true';
    flags = await loadFlags();
    expect(flags.shouldShowVocationalTestUi()).toBe(true);
    expect(flags.isVideoExportEnabled()).toBe(true);
    expect(flags.isVideoExportBurnedInCaptionsEnabled()).toBe(true);
  });
});

describe('classroom feature flags', () => {
  it('defaults AI/runtime classroom features off while deterministic interactives stay enabled', async () => {
    const flags = await loadFlags();

    expect(flags.FEATURE_FLAGS).toEqual({
      companionSelector: false,
      generatedClassroomAgents: false,
      classroomChat: false,
      voiceCloning: false,
      staticVoice: false,
      promptPersonalization: false,
      webSearch: false,
      classroomImport: false,
      whiteboard: false,
      interactiveScenes: false,
      deterministicInteractives: true,
      discussionScenes: false,
      workspaceScenes: false,
      flowScenes: false,
    });
  });

  it.each([
    ['NEXT_PUBLIC_FEATURE_STATIC_VOICE', 'isStaticVoiceEnabled'],
    ['NEXT_PUBLIC_FEATURE_PROMPT_PERSONALIZATION', 'isPromptPersonalizationEnabled'],
    ['NEXT_PUBLIC_FEATURE_WEB_SEARCH', 'isWebSearchEnabled'],
    ['NEXT_PUBLIC_FEATURE_CLASSROOM_IMPORT', 'isClassroomImportEnabled'],
    ['NEXT_PUBLIC_FEATURE_WHITEBOARD', 'isWhiteboardEnabled'],
  ] as const)('%s defaults off and can be enabled independently', async (envKey, getter) => {
    let flags = await loadFlags();
    expect(flags[getter]()).toBe(false);

    process.env[envKey] = 'true';
    flags = await loadFlags();
    expect(flags[getter]()).toBe(true);
  });

  it('keeps generated classroom agents opt-in for the standard teacher-only flow', async () => {
    let flags = await loadFlags();
    expect(flags.isGeneratedClassroomAgentsEnabled()).toBe(false);

    process.env.NEXT_PUBLIC_FEATURE_GENERATED_CLASSROOM_AGENTS = 'true';
    flags = await loadFlags();
    expect(flags.isGeneratedClassroomAgentsEnabled()).toBe(true);
  });

  it('keeps faculty voice cloning opt-in', async () => {
    let flags = await loadFlags();
    expect(flags.isVoiceCloningEnabled()).toBe(false);

    process.env.NEXT_PUBLIC_FEATURE_VOICE_CLONING = 'true';
    flags = await loadFlags();
    expect(flags.isVoiceCloningEnabled()).toBe(true);
  });

  it('enables runtime AI and flow scene flags only behind their precise gates', async () => {
    process.env.NEXT_PUBLIC_FEATURE_DISCUSSION_SCENES = 'true';
    process.env.NEXT_PUBLIC_FEATURE_WORKSPACE_SCENES = 'true';
    process.env.NEXT_PUBLIC_FEATURE_FLOW_SCENES = 'true';
    let flags = await loadFlags();

    expect(flags.isInteractiveScenesEnabled()).toBe(false);
    expect(flags.isDiscussionScenesEnabled()).toBe(false);
    expect(flags.isWorkspaceScenesEnabled()).toBe(false);
    expect(flags.isFlowScenesEnabled()).toBe(false);

    process.env.NEXT_PUBLIC_FEATURE_INTERACTIVE_SCENES = 'true';
    flags = await loadFlags();

    expect(flags.isInteractiveScenesEnabled()).toBe(true);
    expect(flags.isDiscussionScenesEnabled()).toBe(true);
    expect(flags.isWorkspaceScenesEnabled()).toBe(true);
    expect(flags.isFlowScenesEnabled()).toBe(true);
  });

  it('keeps deterministic simulations separate from broad flow enablement', async () => {
    const simulation = scene(
      {
        type: 'interactive',
        url: 'about:blank',
        html: '<button />',
        widgetType: 'simulation',
      },
      sceneCore({ id: 'simulation-1' }),
    );
    const flow = scene(
      {
        type: 'interactive',
        url: 'about:blank',
        html: '<div />',
        widgetType: 'diagram',
        widgetConfig: flowWidgetConfig,
      },
      sceneCore({ id: 'flow-1' }),
    );

    let flags = await loadFlags();
    expect(flags.isSceneEnabled(simulation)).toBe(true);
    expect(flags.isSceneEnabled(flow)).toBe(false);

    process.env.NEXT_PUBLIC_FEATURE_INTERACTIVE_SCENES = 'true';
    flags = await loadFlags();
    expect(flags.isSceneEnabled(simulation)).toBe(true);
    expect(flags.isSceneEnabled(flow)).toBe(false);

    process.env.NEXT_PUBLIC_FEATURE_DETERMINISTIC_INTERACTIVES = 'false';
    flags = await loadFlags();
    expect(flags.isSceneEnabled(simulation)).toBe(false);
    expect(flags.isSceneEnabled(flow)).toBe(false);
  });

  it('filters disabled interactive, workspace, and flow scenes from playback navigation', async () => {
    const slide = scene(emptySlideContent, sceneCore({ id: 'slide-1' }));
    const quiz = scene({ type: 'quiz', questions: [] }, sceneCore({ id: 'quiz-1' }));
    const interactive = scene(
      {
        type: 'interactive',
        url: 'about:blank',
        html: '<button />',
        widgetType: 'simulation',
      },
      sceneCore({ id: 'interactive-1' }),
    );
    const workspace = scene({ type: 'pbl', projectConfig }, sceneCore({ id: 'pbl-1' }));
    const flow = scene(
      {
        type: 'interactive',
        url: 'about:blank',
        html: '<div />',
        widgetType: 'diagram',
        widgetConfig: flowWidgetConfig,
      },
      sceneCore({ id: 'flow-1' }),
    );

    let flags = await loadFlags();
    expect(flags.filterEnabledScenes([slide, quiz, interactive, workspace, flow])).toEqual([
      slide,
      quiz,
      interactive,
    ]);

    process.env.NEXT_PUBLIC_FEATURE_INTERACTIVE_SCENES = 'true';
    flags = await loadFlags();
    expect(flags.filterEnabledScenes([slide, quiz, interactive, workspace, flow])).toEqual([
      slide,
      quiz,
      interactive,
    ]);

    process.env.NEXT_PUBLIC_FEATURE_WORKSPACE_SCENES = 'true';
    process.env.NEXT_PUBLIC_FEATURE_FLOW_SCENES = 'true';
    flags = await loadFlags();
    expect(flags.filterEnabledScenes([slide, quiz, interactive, workspace, flow])).toEqual([
      slide,
      quiz,
      interactive,
      workspace,
      flow,
    ]);
  });
});
