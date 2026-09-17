import { nanoid } from 'nanoid';
import { callLLM } from '@/lib/ai/llm';
import { createStageAPI } from '@/lib/api/stage-api';
import type { StageStore } from '@/lib/api/stage-api-types';
import {
  generateSceneOutlinesFromRequirements,
  generateSceneActions,
  generateSceneContent,
  PBLGenerationError,
  withGenerationRetry,
  type AICallFn,
  type AgentInfo,
} from '@openmaic/generation';
import { applySahayaOutlineFeatureFallbacks } from '@/lib/generation/outline-generator';
import { createSceneWithActions } from '@/lib/server/scene-generation';
import { generatePBLV2Project } from '@/lib/pbl/v2/agents/planner';
import { getDefaultAgents } from '@/lib/orchestration/registry/store';
import { createLogger } from '@/lib/logger';
import { isProviderKeyRequired } from '@/lib/ai/providers';
import { resolveClassroomWebSearchConfig } from '@/lib/server/web-search-config';
import { resolveModel } from '@/lib/server/resolve-model';
import { getStageModel, type LlmStage } from '@/lib/server/model-routes';
import type { LanguageModel } from 'ai';
import type { ThinkingConfig } from '@/lib/types/provider';
import { resolveVocationalActive } from '@/lib/config/feature-flags';
import { buildSearchQuery } from '@/lib/server/search-query-builder';
import { formatSearchResultsAsContext, searchWeb } from '@/lib/web-search';
import type { BaiduSubSources, WebSearchProviderId } from '@/lib/web-search/types';
import { persistClassroom } from '@/lib/server/classroom-storage';
import {
  generateMediaForClassroom,
  replaceMediaPlaceholders,
  generateTTSForClassroom,
} from '@/lib/server/classroom-media-generation';
import { buildVideoManifestFromOutlines } from '@/lib/media/video-manifest';
import type { UserRequirements } from '@/lib/types/generation';
import type { Scene, Stage } from '@/lib/types/stage';
import { AGENT_COLOR_PALETTE, AGENT_DEFAULT_AVATARS } from '@/lib/constants/agent-defaults';
import { incrementClassroomsCreated } from '@/lib/auth/server';
import {
  createGenerationTimingCollector,
  logCourseGenerationTiming,
  logSceneGenerationTiming,
  shouldCollectLLMRouteTiming,
  withRouteTiming,
} from '@/lib/server/generation-timing';

const log = createLogger('Classroom');

export function containPBLGenerationError(error: unknown, sceneTitle: string): null {
  if (!(error instanceof PBLGenerationError)) throw error;
  log.warn(`PBL generation failed for scene "${sceneTitle}": ${error.message}`);
  return null;
}

export interface GenerateClassroomInput {
  requirement: string;
  ownerUserId?: string;
  pdfContent?: { text: string; images: string[] };
  enableWebSearch?: boolean;
  webSearchProviderId?: WebSearchProviderId;
  webSearchApiKey?: string;
  webSearchModelId?: string;
  baiduSubSources?: BaiduSubSources;
  enableImageGeneration?: boolean;
  enableVideoGeneration?: boolean;
  enableTTS?: boolean;
  agentMode?: 'default' | 'generate';
}

export type ClassroomGenerationStep =
  | 'initializing'
  | 'researching'
  | 'generating_outlines'
  | 'generating_scenes'
  | 'generating_media'
  | 'generating_tts'
  | 'persisting'
  | 'completed';

export interface ClassroomGenerationProgress {
  step: ClassroomGenerationStep;
  progress: number;
  message: string;
  scenesGenerated: number;
  totalScenes?: number;
}

export interface GenerateClassroomResult {
  id: string;
  url: string;
  stage: Stage;
  scenes: Scene[];
  scenesCount: number;
  createdAt: string;
}

function createInMemoryStore(stage: Stage): StageStore {
  let state = {
    stage: stage as Stage | null,
    scenes: [] as Scene[],
    currentSceneId: null as string | null,
    mode: 'playback' as const,
  };

  const listeners: Array<(s: typeof state, prev: typeof state) => void> = [];

  return {
    getState: () => state,
    setState: (partial: Partial<typeof state>) => {
      const prev = state;
      state = { ...state, ...partial };
      listeners.forEach((fn) => fn(state, prev));
    },
    subscribe: (listener: (s: typeof state, prev: typeof state) => void) => {
      listeners.push(listener);
      return () => {
        const idx = listeners.indexOf(listener);
        if (idx >= 0) listeners.splice(idx, 1);
      };
    },
  };
}

function stripCodeFences(text: string): string {
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }
  return cleaned.trim();
}

async function generateAgentProfiles(
  requirement: string,
  languageDirective: string,
  aiCall: AICallFn,
): Promise<AgentInfo[]> {
  const systemPrompt =
    'You are an expert instructional designer. Generate agent profiles for a multi-agent classroom simulation. Return ONLY valid JSON, no markdown or explanation.';

  const userPrompt = `Generate agent profiles for a course with this requirement:
${requirement}

Requirements:
- Decide the appropriate number of agents based on the course content (typically 3-5)
- Exactly 1 agent must have role "teacher", the rest can be "assistant" or "student"
- Each agent needs: name, role, persona (2-3 sentences describing personality and teaching/learning style)
- Language directive for this course: ${languageDirective}
  Agent names and personas must follow this language directive.

Return a JSON object with this exact structure:
{
  "agents": [
    {
      "name": "string",
      "role": "teacher" | "assistant" | "student",
      "persona": "string (2-3 sentences)"
    }
  ]
}`;

  const response = await aiCall(systemPrompt, userPrompt);
  const rawText = stripCodeFences(response);
  const parsed = JSON.parse(rawText) as {
    agents: Array<{ name: string; role: string; persona: string }>;
  };

  if (!parsed.agents || !Array.isArray(parsed.agents) || parsed.agents.length < 2) {
    throw new Error(`Expected at least 2 agents, got ${parsed.agents?.length ?? 0}`);
  }

  const teacherCount = parsed.agents.filter((a) => a.role === 'teacher').length;
  if (teacherCount !== 1) {
    throw new Error(`Expected exactly 1 teacher, got ${teacherCount}`);
  }

  return parsed.agents.map((a, i) => ({
    id: `gen-server-${i}`,
    name: a.name,
    role: a.role,
    persona: a.persona,
  }));
}

export async function generateClassroom(
  input: GenerateClassroomInput,
  options: {
    baseUrl: string;
    onProgress?: (progress: ClassroomGenerationProgress) => Promise<void> | void;
  },
): Promise<GenerateClassroomResult> {
  const { requirement, pdfContent } = input;
  const courseStartedAt = Date.now();
  let contentDurationMs = 0;
  let actionsDurationMs = 0;
  let mediaDurationMs: number | undefined;
  let ttsDurationMs: number | undefined;
  let failedSceneCount = 0;
  const courseTiming = createGenerationTimingCollector();
  const callGenerationLLM = (
    params: Parameters<typeof callLLM>[0],
    source: string,
    thinking: ThinkingConfig | undefined,
    timingCollector?: ReturnType<typeof createGenerationTimingCollector>,
  ) =>
    shouldCollectLLMRouteTiming() && timingCollector
      ? callLLM(params, source, undefined, thinking, timingCollector.routingPolicy)
      : callLLM(params, source, undefined, thinking);

  await options.onProgress?.({
    step: 'initializing',
    progress: 5,
    message: 'Initializing classroom generation',
    scenesGenerated: 0,
  });

  const {
    model: languageModel,
    modelInfo,
    modelString,
    providerId,
    apiKey,
    thinkingConfig: classroomThinking,
  } = await resolveModel({ stage: 'generate-classroom' });
  log.info(`Using server-configured model: ${modelString}`);

  // Fail fast if the resolved provider has no API key configured
  if (isProviderKeyRequired(providerId) && !apiKey) {
    throw new Error(
      `No API key configured for provider "${providerId}". ` +
        `Set the appropriate key in .env.local or server-providers.yml (e.g. ${providerId.toUpperCase()}_API_KEY).`,
    );
  }

  // The web-search query rewrite is a light, separable stage operators may route
  // to a cheaper model. It defaults to the classroom model and is only
  // re-resolved lazily (inside the web-search branch, and only when a route is
  // configured). This keeps a misconfigured optional route from aborting all
  // classroom generation, and skips the extra resolution when web search is off.
  let searchQueryModel = languageModel;
  let searchQueryThinking = classroomThinking;

  const aiCall: AICallFn = async (systemPrompt, userPrompt, _images) => {
    const result = await callGenerationLLM(
      {
        model: languageModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        maxOutputTokens: modelInfo?.outputWindow,
      },
      'generate-classroom',
      classroomThinking,
      courseTiming,
    );
    return result.text;
  };

  // Per-stage model resolution for the scene pipeline. The classroom used to
  // bind a single `languageModel` (from the `generate-classroom` stage) into one
  // `sceneAiCall` closure shared by scene-content and scene-actions. That made
  // every `MODEL_ROUTES` entry for `scene-content` / `scene-content:<type>` /
  // `scene-actions` a no-op on this path — the browser UI already routes each
  // stage independently via /api/generate/*, but the one-shot skill API did not.
  //
  // Each stage is resolved lazily and only when a route is actually configured
  // (getStageModel returns undefined), so unrouted deployments pay zero extra
  // cost and reuse the classroom model. Resolution failure (e.g. an unknown
  // provider in the route) degrades to the classroom model with a warn, mirroring
  // the existing web-search-query-rewrite handling below — a misconfigured
  // optional route never aborts classroom generation.
  const stageModelCache = new Map<
    LlmStage,
    {
      model: LanguageModel;
      outputWindow?: number;
      thinking: ThinkingConfig | undefined;
    }
  >();

  const resolveStageModel = async (
    stage: LlmStage,
  ): Promise<{
    model: LanguageModel;
    outputWindow?: number;
    thinking: ThinkingConfig | undefined;
  }> => {
    const cached = stageModelCache.get(stage);
    if (cached) return cached;

    // No route configured → reuse the classroom model, no extra resolution.
    if (!getStageModel(stage)) {
      const fallback = {
        model: languageModel,
        outputWindow: modelInfo?.outputWindow,
        thinking: classroomThinking,
      };
      stageModelCache.set(stage, fallback);
      return fallback;
    }

    try {
      const resolved = await resolveModel({ stage });
      const entry = {
        model: resolved.model,
        outputWindow: resolved.modelInfo?.outputWindow,
        thinking: resolved.thinkingConfig,
      };
      log.info(`Stage "${stage}" routed to model: ${resolved.modelString}`);
      stageModelCache.set(stage, entry);
      return entry;
    } catch (err) {
      log.warn(
        `Stage "${stage}" route "${getStageModel(stage)}" could not be resolved; ` +
          `falling back to the generate-classroom model.`,
        err,
      );
      const fallback = {
        model: languageModel,
        outputWindow: modelInfo?.outputWindow,
        thinking: classroomThinking,
      };
      stageModelCache.set(stage, fallback);
      return fallback;
    }
  };

  // scene-content routes per outline type via the composite key
  // `scene-content:<type>` (slide/quiz/interactive/pbl), falling back to the
  // base `scene-content` route — same resolution the browser UI uses at
  // /api/generate/scene-content. Returns the aiCall plus the resolved model
  // and thinking config, because PBL scene generation drives its own LLM
  // calls through the model object (generatePBLSceneContent) rather than the
  // aiCall closure, and consumes the route's thinking config separately.
  const resolveSceneContentCall = async (
    outlineType?: string,
    timingCollector?: ReturnType<typeof createGenerationTimingCollector>,
  ) => {
    const stage = (outlineType ? `scene-content:${outlineType}` : 'scene-content') as LlmStage;
    const { model, outputWindow, thinking } = await resolveStageModel(stage);
    const aiCall: AICallFn = async (systemPrompt, userPrompt, _images) => {
      const result = await callGenerationLLM(
        {
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          maxOutputTokens: outputWindow,
          maxRetries: 0,
        },
        'generate-classroom-scene',
        thinking,
        timingCollector,
      );
      return result.text;
    };
    return { aiCall, model, thinking };
  };

  // agent-profiles routes via the `agent-profiles` stage (matches the browser
  // UI's /api/generate/agent-profiles). Lazy + cached like the scene stages.
  let agentProfilesAiCall: AICallFn | undefined;
  const getAgentProfilesAiCall = async (): Promise<AICallFn> => {
    if (agentProfilesAiCall) return agentProfilesAiCall;
    const { model, outputWindow, thinking } = await resolveStageModel('agent-profiles');
    agentProfilesAiCall = async (systemPrompt, userPrompt, _images) => {
      const result = await callGenerationLLM(
        {
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          maxOutputTokens: outputWindow,
        },
        'generate-classroom',
        thinking,
        courseTiming,
      );
      return result.text;
    };
    return agentProfilesAiCall;
  };

  // scene-actions routes via the `scene-actions` stage.
  const getSceneActionsAiCall = async (
    timingCollector?: ReturnType<typeof createGenerationTimingCollector>,
  ): Promise<AICallFn> => {
    const { model, outputWindow, thinking } = await resolveStageModel('scene-actions');
    return async (systemPrompt, userPrompt, _images) => {
      const result = await callGenerationLLM(
        {
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          maxOutputTokens: outputWindow,
          maxRetries: 0,
        },
        'generate-classroom-scene',
        thinking,
        timingCollector,
      );
      return result.text;
    };
  };

  const searchQueryAiCall: AICallFn = async (systemPrompt, userPrompt, _images) => {
    const result = await callGenerationLLM(
      {
        model: searchQueryModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        maxOutputTokens: 256,
      },
      'web-search-query-rewrite',
      searchQueryThinking,
      courseTiming,
    );
    return result.text;
  };

  const requirements: UserRequirements = {
    requirement,
  };
  const vocationalActive = resolveVocationalActive(requirements);
  const pdfText = pdfContent?.text || undefined;

  await options.onProgress?.({
    step: 'researching',
    progress: 10,
    message: 'Researching topic',
    scenesGenerated: 0,
  });

  // Web search (optional, graceful degradation)
  let researchContext: string | undefined;
  if (input.enableWebSearch) {
    const webSearchConfig = resolveClassroomWebSearchConfig(input);
    if (webSearchConfig) {
      // Re-resolve the query-rewrite model only when explicitly routed. If
      // resolution itself fails (e.g. unknown provider in the route), fall back
      // to the classroom model here; a route with a missing key resolves fine
      // and surfaces only later in callLLM, which the outer try/catch below
      // degrades gracefully — either way the pipeline still works.
      const rewriteRoute = getStageModel('web-search-query-rewrite');
      if (rewriteRoute) {
        try {
          const rewriteResolved = await resolveModel({ stage: 'web-search-query-rewrite' });
          searchQueryModel = rewriteResolved.model;
          searchQueryThinking = rewriteResolved.thinkingConfig;
        } catch (err) {
          log.warn(
            `web-search-query-rewrite route "${rewriteRoute}" unavailable; using classroom model for query rewrite`,
            err,
          );
        }
      }
      try {
        const searchQuery = await buildSearchQuery(requirement, pdfText, searchQueryAiCall);

        log.info('Running web search for classroom generation', {
          hasPdfContext: searchQuery.hasPdfContext,
          rawRequirementLength: searchQuery.rawRequirementLength,
          rewriteAttempted: searchQuery.rewriteAttempted,
          finalQueryLength: searchQuery.finalQueryLength,
        });

        const searchResult = await searchWeb({
          providerId: webSearchConfig.providerId,
          query: searchQuery.query,
          apiKey: webSearchConfig.apiKey,
          baseUrl: webSearchConfig.baseUrl,
          baiduSubSources: webSearchConfig.baiduSubSources,
          claudeModelId: webSearchConfig.claudeModelId,
        });
        researchContext = formatSearchResultsAsContext(searchResult);
        if (researchContext) {
          log.info(`Web search returned ${searchResult.sources.length} sources`);
        }
      } catch (e) {
        log.warn('Web search failed, continuing without search context:', e);
      }
    } else {
      log.warn('enableWebSearch is true but no web search API key configured, skipping web search');
    }
  }

  await options.onProgress?.({
    step: 'generating_outlines',
    progress: 15,
    message: 'Generating scene outlines',
    scenesGenerated: 0,
  });

  const outlinesResult = await generateSceneOutlinesFromRequirements(
    requirements,
    pdfText,
    undefined,
    aiCall,
    {
      imageGenerationEnabled: input.enableImageGeneration,
      videoGenerationEnabled: input.enableVideoGeneration,
      researchContext,
      // NO teacherContext — agents haven't been generated yet
    },
  );

  if (!outlinesResult.success || !outlinesResult.data) {
    log.error('Failed to generate outlines:', outlinesResult.error);
    throw new Error(outlinesResult.error || 'Failed to generate scene outlines');
  }

  const { languageDirective, courseTitle, outlines } = outlinesResult.data;
  log.info(
    `Generated ${outlines.length} scene outlines (languageDirective: ${languageDirective}, courseTitle: ${courseTitle ?? 'n/a'})`,
  );

  await options.onProgress?.({
    step: 'generating_outlines',
    progress: 30,
    message: `Generated ${outlines.length} scene outlines`,
    scenesGenerated: 0,
    totalScenes: outlines.length,
  });

  // Resolve agents based on agentMode — now AFTER outlines so we can use languageDirective
  let agents: AgentInfo[];
  let agentMode = input.agentMode || 'default';
  if (agentMode === 'generate') {
    log.info('Generating custom agent profiles via LLM...');
    try {
      const agentProfilesCall = await getAgentProfilesAiCall();
      agents = await generateAgentProfiles(requirement, languageDirective, agentProfilesCall);
      log.info(`Generated ${agents.length} agent profiles`);
    } catch (e) {
      log.warn('Agent profile generation failed, falling back to the standard teacher:', e);
      agents = getDefaultAgents().filter((agent) => agent.id === 'default-1');
      agentMode = 'default';
    }
  } else {
    agents = getDefaultAgents().filter((agent) => agent.id === 'default-1');
  }

  const stageId = nanoid(10);
  const stage: Stage = {
    id: stageId,
    name: courseTitle || outlines[0]?.title || requirement.slice(0, 50),
    description: undefined,
    languageDirective,
    videoManifest: buildVideoManifestFromOutlines(outlines),
    style: 'interactive',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    // For LLM-generated agents, embed full configs so the client can
    // hydrate the agent registry without prior IndexedDB data.
    // For default agents, just record IDs — the client already has them.
    ...(agentMode === 'generate'
      ? {
          generatedAgentConfigs: agents.map((a, i) => ({
            id: a.id,
            name: a.name,
            role: a.role,
            persona: a.persona || '',
            avatar: AGENT_DEFAULT_AVATARS[i % AGENT_DEFAULT_AVATARS.length],
            color: AGENT_COLOR_PALETTE[i % AGENT_COLOR_PALETTE.length],
            priority: a.role === 'teacher' ? 10 : a.role === 'assistant' ? 7 : 5,
          })),
        }
      : {
          agentIds: agents.map((a) => a.id),
        }),
  };

  const store = createInMemoryStore(stage);
  const api = createStageAPI(store);

  log.info('Stage 2: Generating scene content and actions...');
  let generatedScenes = 0;

  for (const [index, outline] of outlines.entries()) {
    const safeOutline = applySahayaOutlineFeatureFallbacks(outline, {
      taskEngineMode: vocationalActive,
      hasLanguageModel: true,
      logger: log,
    });
    const progressStart = 30 + Math.floor((index / Math.max(outlines.length, 1)) * 60);

    await options.onProgress?.({
      step: 'generating_scenes',
      progress: Math.max(progressStart, 31),
      message: `Generating scene ${index + 1}/${outlines.length}: ${safeOutline.title}`,
      scenesGenerated: generatedScenes,
      totalScenes: outlines.length,
    });

    const reportSceneRetry = async (
      phase: 'content' | 'actions',
      event: { attempt: number; maxAttempts: number; reason: string },
    ) => {
      const nextAttempt = Math.min(event.attempt + 1, event.maxAttempts);
      const message = `Retrying scene ${index + 1}/${outlines.length} ${phase} (${nextAttempt}/${event.maxAttempts}): ${safeOutline.title}`;
      log.warn(`${message} — ${event.reason}`);
      await options.onProgress?.({
        step: 'generating_scenes',
        progress: Math.max(progressStart, 31),
        message,
        scenesGenerated: generatedScenes,
        totalScenes: outlines.length,
      });
    };

    // Resolve this scene's content model lazily, per outline type. The package
    // gets the provider-bound AICallFn and the app injects its agentic PBL loop
    // as the classified fallback, preserving single-call → loop routing.
    let contentRetryAttempts = 0;
    const contentTiming = createGenerationTimingCollector();
    const contentStartedAt = Date.now();
    const contentCall = await resolveSceneContentCall(safeOutline.type, contentTiming);
    const content = await (async () => {
      try {
        return await withGenerationRetry(
          () =>
            generateSceneContent(safeOutline, contentCall.aiCall, {
              agents,
              languageDirective,
              allowProceduralSkill: vocationalActive,
              ...(safeOutline.type === 'pbl'
                ? {
                    pblLoopFallback: (input) =>
                      generatePBLV2Project(
                        input,
                        contentCall.model,
                        callLLM,
                        { logger: log },
                        contentCall.thinking,
                      ),
                  }
                : {}),
            }),
          {
            label: `scene ${index + 1}/${outlines.length} content`,
            shouldRetryResult: (result) => result === null,
            onRetry: (event) => {
              contentRetryAttempts = event.attempt;
              return reportSceneRetry('content', event);
            },
          },
        );
      } catch (error) {
        return containPBLGenerationError(error, safeOutline.title);
      }
    })();
    const contentElapsedMs = Date.now() - contentStartedAt;
    contentDurationMs += contentElapsedMs;
    logSceneGenerationTiming(
      withRouteTiming(
        {
          requestId: contentTiming.requestId,
          phase: 'content',
          stageId,
          outlineId: safeOutline.id,
          sceneType: safeOutline.type,
          status: content ? 'success' : 'skipped',
          durationMs: contentElapsedMs,
          retryAttempts: contentRetryAttempts,
          elementCount: content && 'elements' in content ? content.elements.length : undefined,
        },
        contentTiming.events,
      ),
    );
    if (!content) {
      failedSceneCount += 1;
      log.warn(`Skipping scene "${safeOutline.title}" — content generation failed`);
      continue;
    }

    let actionRetryAttempts = 0;
    const actionsTiming = createGenerationTimingCollector();
    const actionsStartedAt = Date.now();
    const actionsAiCall = await getSceneActionsAiCall(actionsTiming);
    let actions: Awaited<ReturnType<typeof generateSceneActions>>;
    try {
      actions = await withGenerationRetry(
        () =>
          generateSceneActions(safeOutline, content, actionsAiCall, {
            agents,
            languageDirective,
          }),
        {
          label: `scene ${index + 1}/${outlines.length} actions`,
          onRetry: (event) => {
            actionRetryAttempts = event.attempt;
            return reportSceneRetry('actions', event);
          },
        },
      );
    } catch (error) {
      const actionsElapsedMs = Date.now() - actionsStartedAt;
      actionsDurationMs += actionsElapsedMs;
      failedSceneCount += 1;
      logSceneGenerationTiming(
        withRouteTiming(
          {
            requestId: actionsTiming.requestId,
            phase: 'actions',
            stageId,
            outlineId: safeOutline.id,
            sceneType: safeOutline.type,
            status: 'failed',
            durationMs: actionsElapsedMs,
            retryAttempts: actionRetryAttempts,
          },
          actionsTiming.events,
        ),
      );
      throw error;
    }
    const actionsElapsedMs = Date.now() - actionsStartedAt;
    actionsDurationMs += actionsElapsedMs;
    logSceneGenerationTiming(
      withRouteTiming(
        {
          requestId: actionsTiming.requestId,
          phase: 'actions',
          stageId,
          outlineId: safeOutline.id,
          sceneType: safeOutline.type,
          status: 'success',
          durationMs: actionsElapsedMs,
          retryAttempts: actionRetryAttempts,
          actionCount: actions.length,
        },
        actionsTiming.events,
      ),
    );
    log.info(`Scene "${safeOutline.title}": ${actions.length} actions`);

    const sceneId = createSceneWithActions(safeOutline, content, actions, api);
    if (!sceneId) {
      failedSceneCount += 1;
      log.warn(`Skipping scene "${safeOutline.title}" — scene creation failed`);
      continue;
    }

    generatedScenes += 1;
    const progressEnd = 30 + Math.floor(((index + 1) / Math.max(outlines.length, 1)) * 60);
    await options.onProgress?.({
      step: 'generating_scenes',
      progress: Math.min(progressEnd, 90),
      message: `Generated ${generatedScenes}/${outlines.length} scenes`,
      scenesGenerated: generatedScenes,
      totalScenes: outlines.length,
    });
  }

  const scenes = store.getState().scenes;
  log.info(`Pipeline complete: ${scenes.length} scenes generated`);

  if (scenes.length === 0) {
    throw new Error('No scenes were generated');
  }

  // Phase: Media generation (after all scenes generated)
  if (input.enableImageGeneration || input.enableVideoGeneration) {
    await options.onProgress?.({
      step: 'generating_media',
      progress: 90,
      message: 'Generating media files',
      scenesGenerated: scenes.length,
      totalScenes: outlines.length,
    });

    try {
      const mediaStartedAt = Date.now();
      const mediaMap = await generateMediaForClassroom(outlines, stageId, options.baseUrl);
      mediaDurationMs = Date.now() - mediaStartedAt;
      replaceMediaPlaceholders(scenes, mediaMap);
      log.info(`Media generation complete: ${Object.keys(mediaMap).length} files`);
    } catch (err) {
      log.warn('Media generation phase failed, continuing:', err);
    }
  }

  // Phase: TTS generation
  if (input.enableTTS) {
    await options.onProgress?.({
      step: 'generating_tts',
      progress: 94,
      message: 'Generating TTS audio',
      scenesGenerated: scenes.length,
      totalScenes: outlines.length,
    });

    try {
      const ttsStartedAt = Date.now();
      await generateTTSForClassroom(scenes, stageId, options.baseUrl);
      ttsDurationMs = Date.now() - ttsStartedAt;
      log.info('TTS generation complete');
    } catch (err) {
      log.warn('TTS generation phase failed, continuing:', err);
    }
  }

  await options.onProgress?.({
    step: 'persisting',
    progress: 98,
    message: 'Persisting classroom data',
    scenesGenerated: scenes.length,
    totalScenes: outlines.length,
  });

  const persisted = await persistClassroom(
    {
      id: stageId,
      ownerUserId: input.ownerUserId || 'legacy-unassigned',
      stage,
      scenes,
    },
    options.baseUrl,
  );

  log.info(`Classroom persisted: ${persisted.id}, URL: ${persisted.url}`);
  if (input.ownerUserId) {
    await incrementClassroomsCreated(input.ownerUserId);
  }

  logCourseGenerationTiming({
    requestId: courseTiming.requestId,
    status: 'success',
    durationMs: Date.now() - courseStartedAt,
    sceneCount: outlines.length,
    generatedSceneCount: scenes.length,
    failedSceneCount,
    contentDurationMs,
    actionsDurationMs,
    ...(mediaDurationMs === undefined ? {} : { mediaDurationMs }),
    ...(ttsDurationMs === undefined ? {} : { ttsDurationMs }),
  });

  await options.onProgress?.({
    step: 'completed',
    progress: 100,
    message: 'Classroom generation completed',
    scenesGenerated: scenes.length,
    totalScenes: outlines.length,
  });

  return {
    id: persisted.id,
    url: persisted.url,
    stage,
    scenes,
    scenesCount: scenes.length,
    createdAt: persisted.createdAt,
  };
}
