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

    // ── Generate actions ──
    log.info(`Generating actions: "${outline.title}" (${outline.type}) [model=${modelString}]`);
    phaseStartedAt = Date.now();
    routeEventStart = collector.events.length;

    const generationContent = (
      'type' in content && content.type === 'pbl' ? normalizeLegacyPBLContent(content) : content
    ) as
      | GeneratedSlideContent
      | GeneratedQuizContent
      | GeneratedInteractiveContent
      | GeneratedPBLContent;

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

    // ── Build complete scene ──
    const scene = buildCompleteScene(outline, generationContent, actions, stageId);

    if (!scene) {
      log.error(`Failed to build scene: "${outline.title}"`);

      return apiError('GENERATION_FAILED', 500, `Failed to build scene: ${outline.title}`);
    }

    // ── Extract speeches for cross-scene coherence ──
    const outputPreviousSpeeches = (scene.actions || [])
      .filter((a): a is SpeechAction => a.type === 'speech')
      .map((a) => a.text);

    log.info(
      `Scene assembled successfully: "${outline.title}" — ${scene.actions?.length ?? 0} actions`,
    );

    return apiSuccess({ scene, previousSpeeches: outputPreviousSpeeches });
  } catch (error) {
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
    return llmApiError(error);
  }
}
