/**
 * Scene Actions Generation API
 *
 * Generates actions for a scene given its outline and content,
 * then assembles the complete Scene object.
 * This is the second half of the two-step scene generation pipeline.
 */

import { NextRequest } from 'next/server';
import { callLLM } from '@/lib/ai/llm';
import {
  generateSceneActions,
  buildCompleteScene,
  buildVisionUserContent,
  type SceneGenerationContext,
  type AgentInfo,
} from '@openmaic/generation';
import type { SceneOutline } from '@/lib/types/generation';
import type {
  GeneratedSlideContent,
  GeneratedQuizContent,
  GeneratedInteractiveContent,
  GeneratedPBLContent,
} from '@/lib/types/generation';
import type { SpeechAction } from '@/lib/types/action';
import type { PBLContent } from '@/lib/types/stage';
import { createLogger } from '@/lib/logger';
import { normalizeLegacyPBLContent } from '@/lib/pbl/legacy/read';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { llmApiError } from '@/lib/server/llm-error-response';
import { resolveModelFromRequest } from '@/lib/server/resolve-model';
import {
  createGenerationTimingCollector,
  logSceneGenerationTiming,
  shouldCollectLLMRouteTiming,
  withRouteTiming,
} from '@/lib/server/generation-timing';
import { requireSessionUser } from '@/lib/auth/server';
import {
  runSceneAttemptActions,
  SceneGenerationAttemptError,
  type SceneGenerationAttemptIdentity,
} from '@/lib/server/scene-generation-attempts';

const log = createLogger('Scene Actions API');

export const maxDuration = 60;

async function resolveDiscussionActionsEnabled(): Promise<boolean> {
  try {
    const flags = await import('@/lib/config/feature-flags');
    return typeof flags.isDiscussionScenesEnabled === 'function'
      ? flags.isDiscussionScenesEnabled()
      : false;
  } catch {
    return false;
  }
}

export async function POST(req: NextRequest) {
  let outlineTitle: string | undefined;
  let resolvedModelString: string | undefined;
  let timingCollector: ReturnType<typeof createGenerationTimingCollector> | undefined;
  let phaseStartedAt = Date.now();
  let routeEventStart = 0;
  let stageIdForTiming: string | undefined;
  let outlineIdForTiming: string | undefined;
  let sceneTypeForTiming: string | undefined;
  try {
    const body = await req.json();
    const {
      outline,
      allOutlines,
      content,
      stageId,
      agents,
      previousSpeeches: incomingPreviousSpeeches,
      userProfile,
      languageDirective,
      attemptId,
      generationVersion,
    } = body as {
      outline: SceneOutline;
      allOutlines: SceneOutline[];
      content:
        | GeneratedSlideContent
        | GeneratedQuizContent
        | GeneratedInteractiveContent
        | GeneratedPBLContent
        | PBLContent;
      stageId: string;
      agents?: AgentInfo[];
      previousSpeeches?: string[];
      userProfile?: string;
      languageDirective?: string;
      attemptId?: string;
      generationVersion?: string;
    };

    // Validate required fields
    if (!outline) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'outline is required');
    }
    if (!allOutlines || allOutlines.length === 0) {
      return apiError(
        'MISSING_REQUIRED_FIELD',
        400,
        'allOutlines is required and must not be empty',
      );
    }
    if (!content) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'content is required');
    }
    if (!stageId) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'stageId is required');
    }
    if ((attemptId && !generationVersion) || (!attemptId && generationVersion)) {
      return apiError(
        'MISSING_REQUIRED_FIELD',
        400,
        'attemptId and generationVersion must be provided together',
      );
    }
    let ownerUserId: string | undefined;
    let attemptIdentity: SceneGenerationAttemptIdentity | undefined;
    if (attemptId && generationVersion) {
      const user = await requireSessionUser(req);
      if (user instanceof Response) return user;
      ownerUserId = user.id;
      attemptIdentity = { attemptId, generationVersion, stageId, outlineId: outline.id };
    }

    // ── Model resolution from request headers/body ──
    const {
      model: languageModel,
      modelInfo,
      modelString,
      thinkingConfig,
    } = await resolveModelFromRequest(req, body, 'scene-actions');
    const collector = createGenerationTimingCollector();
    const invokeSceneActionsLLM = (params: Parameters<typeof callLLM>[0]) =>
      shouldCollectLLMRouteTiming()
        ? callLLM(params, 'scene-actions', undefined, thinkingConfig, collector.routingPolicy)
        : callLLM(params, 'scene-actions', undefined, thinkingConfig);
    timingCollector = collector;
    outlineTitle = outline?.title;
    resolvedModelString = modelString;
    stageIdForTiming = stageId;
    outlineIdForTiming = outline.id;
    sceneTypeForTiming = outline.type;

    // Detect vision capability
    const hasVision = !!modelInfo?.capabilities?.vision;

    // AI call function (actions typically don't use vision, but kept for consistency)
    const aiCall = async (
      systemPrompt: string,
      userPrompt: string,
      images?: Array<{ id: string; src: string }>,
    ): Promise<string> => {
      if (images?.length && hasVision) {
        const result = await invokeSceneActionsLLM({
          model: languageModel,
          system: systemPrompt,
          messages: [
            {
              role: 'user' as const,
              content: buildVisionUserContent(userPrompt, images),
            },
          ],
          maxOutputTokens: modelInfo?.outputWindow,
          maxRetries: 0,
        });
        return result.text;
      }
      const result = await invokeSceneActionsLLM({
        model: languageModel,
        system: systemPrompt,
        prompt: userPrompt,
        maxOutputTokens: modelInfo?.outputWindow,
        maxRetries: 0,
      });
      return result.text;
    };

    // ── Build cross-scene context ──
    const allTitles = allOutlines.map((o) => o.title);
    const pageIndex = allOutlines.findIndex((o) => o.id === outline.id);
    const ctx: SceneGenerationContext = {
      pageIndex: (pageIndex >= 0 ? pageIndex : 0) + 1,
      totalPages: allOutlines.length,
      allTitles,
      previousSpeeches: incomingPreviousSpeeches ?? [],
    };

    const generationContent = (
      'type' in content && content.type === 'pbl' ? normalizeLegacyPBLContent(content) : content
    ) as
      | GeneratedSlideContent
      | GeneratedQuizContent
      | GeneratedInteractiveContent
      | GeneratedPBLContent;
    const generateResolvedActions = async () => {
      log.info(`Generating actions: "${outline.title}" (${outline.type}) [model=${modelString}]`);
      phaseStartedAt = Date.now();
      routeEventStart = collector.events.length;
      log.info('[SceneGenerationTrace]', {
        event: 'scene-actions-start',
        stageId,
        attemptId,
        generationVersion,
        requestId: collector.requestId,
        outlineId: outline.id,
        sceneIndex: outline.order,
        totalScenes: allOutlines.length,
        sceneType: outline.type,
        title: outline.title,
        model: modelString,
        phase: 'actions',
        status: 'started',
      });

      const actions = await generateSceneActions(outline, generationContent, aiCall, {
        ctx,
        agents,
        userProfile,
        languageDirective,
        allowDiscussionActions: await resolveDiscussionActionsEnabled(),
      });

      logSceneGenerationTiming(
        withRouteTiming(
          {
            requestId: collector.requestId,
            phase: 'actions',
            stageId,
            outlineId: outline.id,
            sceneType: outline.type,
            status: 'success',
            durationMs: Date.now() - phaseStartedAt,
            actionCount: actions.length,
          },
          collector.events.slice(routeEventStart),
        ),
      );

      log.info(`Generated ${actions.length} actions for: "${outline.title}"`);
      log.info('[SceneGenerationTrace]', {
        event: 'scene-actions-complete',
        stageId,
        attemptId,
        generationVersion,
        requestId: collector.requestId,
        outlineId: outline.id,
        sceneIndex: outline.order,
        totalScenes: allOutlines.length,
        sceneType: outline.type,
        title: outline.title,
        model: modelString,
        phase: 'actions',
        durationMs: Date.now() - phaseStartedAt,
        status: 'completed',
        actionCount: actions.length,
      });

      const builtScene = buildCompleteScene(outline, generationContent, actions, stageId);
      if (!builtScene) throw new Error(`Failed to build scene: ${outline.title}`);
      const scene = { ...builtScene, outlineId: outline.id };
      const previousSpeeches = (scene.actions || [])
        .filter((action: SpeechAction): action is SpeechAction => action.type === 'speech')
        .map((action: SpeechAction) => action.text);
      log.info(
        `Scene assembled successfully: "${outline.title}" — ${scene.actions?.length ?? 0} actions`,
      );
      return { scene, previousSpeeches };
    };

    const result =
      attemptIdentity && ownerUserId
        ? await runSceneAttemptActions(
            ownerUserId,
            attemptIdentity,
            content,
            generateResolvedActions,
          )
        : await generateResolvedActions();
    return apiSuccess({ ...result, ...(attemptIdentity ?? {}) });
  } catch (error) {
    if (error instanceof SceneGenerationAttemptError) {
      log.info('[SceneGenerationTrace]', {
        event: 'scene-attempt-stale-rejected',
        stageId: stageIdForTiming,
        outlineId: outlineIdForTiming,
        errorCode: error.code,
      });
      return apiError(error.code, 409, error.message);
    }
    if (error instanceof Error && error.message.startsWith('Failed to build scene:')) {
      return apiError('GENERATION_FAILED', 500, error.message);
    }
    if (timingCollector) {
      logSceneGenerationTiming(
        withRouteTiming(
          {
            requestId: timingCollector.requestId,
            phase: 'actions',
            stageId: stageIdForTiming,
            outlineId: outlineIdForTiming,
            sceneType: sceneTypeForTiming,
            status: 'failed',
            durationMs: Date.now() - phaseStartedAt,
          },
          timingCollector.events.slice(routeEventStart),
        ),
      );
    }
    log.error(
      `Scene actions generation failed [scene="${outlineTitle ?? 'unknown'}", model=${resolvedModelString ?? 'unknown'}]:`,
      error,
    );
    log.info('[SceneGenerationTrace]', {
      event: 'scene-actions-failed',
      stageId: stageIdForTiming,
      requestId: timingCollector?.requestId,
      outlineId: outlineIdForTiming,
      sceneType: sceneTypeForTiming,
      model: resolvedModelString,
      phase: 'actions',
      durationMs: Date.now() - phaseStartedAt,
      status: 'failed',
    });
    return llmApiError(error);
  }
}
