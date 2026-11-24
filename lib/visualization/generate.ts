import { setTimeout as delay } from 'node:timers/promises';
import type { SceneOutline } from '@openmaic/generation';
import type { VisualizationContent } from '@openmaic/dsl';
import { VISUALIZATION_DIFFICULTIES, VISUALIZATION_STYLES } from '@openmaic/dsl';
import { createLogger } from '@/lib/logger';
import {
  configuredQuality,
  getVisualizationCapability,
  readRenderJob,
  RendererError,
  rendererFetch,
  type RenderJob,
} from './renderer';

import {
  PLAN_GUIDANCE,
  applyPlanRepair,
  facultyIssueLocation,
  normalizePlan,
  parsePlanObject,
  repairableIssue,
  type Plan,
  type PlanIssue,
} from './plan-contract';
import { VisualizationFailure } from './failure';

export type VisualizationAiCall = (
  system: string,
  user: string,
  signal: AbortSignal,
) => Promise<string>;

const log = createLogger('Visualization');
export const VISUALIZATION_OUTLINE_INSTRUCTION = `
You may select type "visualization" for a rendered Manim scene when a progressive animation materially improves understanding. Use a slide for static explanation and an interactive simulation for parameter exploration. A visualization is optional. Include a clear teachingObjective, keyPoints, and description of the transformation or process. Do not emit code or a render plan in the outline.`;

const DIRECTOR = `You direct educational animations for Sahaya faculty. Return one JSON object only. Compose the scene around the learning objective with meaningful stages, readable labels, strong contrast and generous margins. Use the requested lecture language for narration and text. Explain assumptions and use scientific model sources for numerical results. Keep narration to one short sentence per narrated beat and introduce visible objects early. Each beat runs its animations in parallel and beats run in order. Use a clear, varied composition for this topic. Avoid decorative movement and dense text.

${PLAN_GUIDANCE}
Faculty instructions affect design only. Never emit Python, file paths, HTML or asset URLs.`;

export interface VisualizationRevision {
  requestKey?: string;
  preview?: boolean;
  sourceArtifactId?: string;
  parameters?: Record<string, number>;
  cueDurations?: Record<string, number>;
}

type Context = {
  outline: SceneOutline;
  allOutlines: SceneOutline[];
  requirement?: string;
  language?: string;
  ownerId: string;
  aiCall: VisualizationAiCall;
  signal?: AbortSignal;
  revision?: VisualizationRevision;
  onProgress?: (phase: string, position?: number) => void;
};

export async function generateVisualization(context: Context): Promise<VisualizationContent> {
  const { outline, onProgress } = context;
  const signal = AbortSignal.any([
    AbortSignal.timeout(270_000),
    ...(context.signal ? [context.signal] : []),
  ]);
  const planningSignal = AbortSignal.any([signal, AbortSignal.timeout(150_000)]);
  const availability = await getVisualizationCapability();
  if (!availability.available)
    throw new VisualizationFailure('VISUALIZATION_UNAVAILABLE', availability.reason);
  const options = outline.visualization;
  const style =
    options?.style && VISUALIZATION_STYLES.includes(options.style) ? options.style : 'automatic';
  const difficulty =
    options?.difficulty && VISUALIZATION_DIFFICULTIES.includes(options.difficulty)
      ? options.difficulty
      : 'introductory';
  const instructions =
    typeof options?.instructions === 'string' ? options.instructions.slice(0, 1600) : undefined;
  const index = context.allOutlines.findIndex((item) => item.id === outline.id);
  const prompt = JSON.stringify({
    requirement: context.requirement?.slice(0, 3500),
    language: context.language?.slice(0, 1000),
    outline: {
      title: outline.title,
      description: outline.description,
      keyPoints: outline.keyPoints,
      objective: outline.teachingObjective,
      duration: outline.estimatedDuration,
    },
    before: context.allOutlines[index - 1]?.title,
    after: context.allOutlines[index + 1]?.title,
    maximumDuration: 'maxDuration' in availability ? availability.maxDuration : 90,
    style,
    difficulty,
    instructions,
  });
  const started = Date.now();
  let job: RenderJob | undefined;
  let renderJobId: string | undefined;
  let issues: PlanIssue[] = [];
  let phase: 'planning' | 'schema' | 'repair' | 'render' = 'planning';
  let planningMs = 0;
  let admissionMs = 0;
  let acceptedPlan: Record<string, unknown> | undefined;
  try {
    let sourcePlan: Record<string, unknown> | undefined;
    let fixedModel: Record<string, unknown> | undefined;
    const { sourceArtifactId, parameters, cueDurations } = context.revision ?? {};
    if (sourceArtifactId) {
      if (!/^[a-f0-9]{64}$/.test(sourceArtifactId))
        throw new RendererError('Invalid visualization version', 422);
      const response = await rendererFetch(
        context.ownerId,
        `/artifacts/${sourceArtifactId}/plan.json`,
        { signal },
      );
      if (!response.ok)
        throw new RendererError('The previous visualization plan is unavailable.', 404);
      sourcePlan = (await response.json()) as Record<string, unknown>;
      if (cueDurations) {
        const timeline = sourcePlan.timeline;
        if (
          !Array.isArray(timeline) ||
          parameters ||
          Object.keys(cueDurations).length > timeline.length
        ) {
          throw new RendererError('Invalid visualization cue timing.', 422);
        }
        for (const [id, seconds] of Object.entries(cueDurations)) {
          const index = /^viz-(0|[1-9][0-9]?)$/.exec(id);
          const beat = index ? timeline[Number(index[1])] : undefined;
          if (!beat || !Number.isFinite(seconds) || seconds <= 0 || seconds > 20) {
            throw new RendererError(
              'A Teaching Voice cue exceeds the renderer timing limits.',
              422,
            );
          }
          beat.seconds = Math.max(beat.seconds, Math.ceil(seconds * 100) / 100);
        }
      }
      const model = sourcePlan.model;
      if (parameters) {
        if (!model || typeof model !== 'object')
          throw new RendererError('This scene has no adjustable scientific model.', 422);
        fixedModel = { ...(model as Record<string, unknown>) };
        for (const [key, value] of Object.entries(parameters)) {
          const current = fixedModel;
          if (
            !Object.hasOwn(current, key) ||
            typeof current[key] !== 'number' ||
            !Number.isFinite(value)
          ) {
            throw new RendererError(
              'Only supported numerical model parameters can be adjusted.',
              422,
            );
          }
          current[key] = value;
        }
        sourcePlan = undefined;
      }
    }
    let plan: Plan | undefined = sourcePlan;
    const input = fixedModel
      ? `${prompt}
Recompose for this fixed scientific model. Update all labels, narration and ranges to match: ${JSON.stringify(fixedModel)}.`
      : prompt;
    const admit = async (candidate: Plan) => {
      onProgress?.('validating');
      const admissionStarted = Date.now();
      try {
        job = await readRenderJob(
          await rendererFetch(context.ownerId, '/jobs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              plan: candidate,
              quality: configuredQuality(context.revision?.preview === true),
            }),
            signal: sourcePlan ? signal : planningSignal,
          }),
        );
        acceptedPlan = candidate;
        return [];
      } catch (error) {
        if (!(error instanceof RendererError) || error.status !== 422) throw error;
        return error.issues.length
          ? error.issues
          : [{ path: [], code: 'constraints', message: 'Plan violates renderer constraints.' }];
      } finally {
        admissionMs += Date.now() - admissionStarted;
      }
    };

    let invalidJson = false;
    let patchRejected = false;
    // Three model calls total, including any JSON-format retry. An admitted plan
    // is submitted only once. A stored plan revision never calls a model.
    for (let attempt = 0; attempt < (sourcePlan ? 1 : 3); attempt++) {
      planningSignal.throwIfAborted();
      if (!sourcePlan) {
        const repairing = !!plan;
        phase = repairing ? 'repair' : 'planning';
        onProgress?.(repairing ? 'repairing' : 'planning');
        const planningStarted = Date.now();
        const response = repairing
          ? await context.aiCall(
              'Repair the Sahaya visualization draft. Return only a JSON patch object, for example {"edits":[{"op":"replace","path":["objects",1,"size"],"value":1.8}]}. Use only exact issue paths. Use add for required fields, remove for unsupported fields (omit value), and replace otherwise. Preserve all other values and the existing sequence. For text and equations, size is the Manim font size divided by 10. Geometry size uses canvas units. Preserve scientific parameters, model sources, and expressions.',
              JSON.stringify({
                draft: plan,
                issues: issues.filter(repairableIssue),
                ...(patchRejected && {
                  feedback: 'The previous patch did not use the exact paths and operations.',
                }),
              }),
              planningSignal,
            )
          : await context.aiCall(
              DIRECTOR,
              input +
                (invalidJson
                  ? '\nThe last response was incomplete or malformed. Return one complete JSON object.'
                  : ''),
              planningSignal,
            );
        planningMs += Date.now() - planningStarted;
        planningSignal.throwIfAborted();
        const proposal = parsePlanObject(response);
        if (!proposal) {
          invalidJson = true;
          patchRejected = repairing;
          continue;
        }
        if (repairing && plan) {
          const revised = applyPlanRepair(plan, proposal, issues);
          if (!revised) {
            patchRejected = true;
            continue;
          }
          plan = revised;
          patchRejected = false;
        } else {
          plan = normalizePlan(proposal);
          if (fixedModel) plan.model = fixedModel;
        }
      }
      if (!plan) continue;
      if (phase !== 'repair') phase = 'schema';
      const beats = plan.timeline;
      if (
        !sourcePlan &&
        Array.isArray(beats) &&
        beats.length &&
        beats.every((beat) => beat && typeof beat === 'object' && !Array.isArray(beat)) &&
        !beats.some((beat) => typeof beat.narration === 'string' && beat.narration.trim()) &&
        !Object.hasOwn(beats[0], 'narration')
      ) {
        issues = [
          {
            path: ['timeline', 0, 'narration'],
            code: 'required',
            message: 'Add one short spoken cue.',
          },
        ];
      } else {
        issues = await admit(plan);
      }
      if (job) break;
      log.info('Visualization plan rejected', {
        outlineId: outline.id,
        attempt: attempt + 1,
        issues: issues.map((issue) => ({
          path: facultyIssueLocation(issue.path),
          code: issue.code,
          limit: issue.limit,
          ...(typeof issue.value === 'number' && { value: issue.value }),
        })),
      });
      if (sourcePlan || !issues.some(repairableIssue)) break;
    }
    if (!job) {
      const path = issues.length ? facultyIssueLocation(issues[0].path) : '';
      const code =
        sourcePlan && context.revision?.cueDurations
          ? 'VISUALIZATION_NARRATION_SYNC'
          : phase === 'repair'
            ? 'VISUALIZATION_REPAIR'
            : plan
              ? 'VISUALIZATION_SCHEMA'
              : 'VISUALIZATION_PLANNING';
      throw new VisualizationFailure(code, path || undefined);
    }
    phase = 'render';
    renderJobId = job.id;
    const deadline = Date.now() + 225_000;
    while (job.status === 'queued' || job.status === 'rendering' || job.status === 'processing') {
      if (!renderJobId || !/^[a-f0-9]{64}$/.test(renderJobId))
        throw new VisualizationFailure('VISUALIZATION_RENDER');
      if (Date.now() >= deadline) {
        throw new VisualizationFailure('VISUALIZATION_RENDER_TIMEOUT');
      }
      onProgress?.(job.status, job.queuePosition);
      await delay(1250, undefined, { signal });
      job = await readRenderJob(
        await rendererFetch(context.ownerId, `/jobs/${renderJobId}`, { signal }),
      );
    }
    if (job.status !== 'completed' || !job.artifact) {
      throw new VisualizationFailure(
        job.errorCode === 'VISUALIZATION_RENDER_TIMEOUT'
          ? 'VISUALIZATION_RENDER_TIMEOUT'
          : 'VISUALIZATION_RENDER',
      );
    }
    const artifact = job.artifact;
    log.info('Visualization rendered', {
      planningMs,
      admissionMs,
      totalMs: Date.now() - started,
      timings: 'timings' in artifact ? artifact.timings : undefined,
    });
    const model = acceptedPlan?.model as VisualizationContent['model'];
    return {
      type: 'visualization',
      artifact,
      options: { style, difficulty, ...(instructions !== undefined && { instructions }) },
      ...(model ? { model } : {}),
    };
  } catch (error) {
    context.signal?.throwIfAborted();
    if (error instanceof VisualizationFailure) throw error;
    const code =
      error instanceof RendererError && (error.status >= 500 || [401, 429].includes(error.status))
        ? 'VISUALIZATION_UNAVAILABLE'
        : phase === 'render'
          ? signal.aborted
            ? 'VISUALIZATION_RENDER_TIMEOUT'
            : 'VISUALIZATION_RENDER'
          : context.revision?.cueDurations
            ? 'VISUALIZATION_NARRATION_SYNC'
            : phase === 'repair'
              ? 'VISUALIZATION_REPAIR'
              : phase === 'schema'
                ? 'VISUALIZATION_SCHEMA'
                : 'VISUALIZATION_PLANNING';
    log.warn('Visualization generation stopped', { outlineId: outline.id, phase, code });
    throw new VisualizationFailure(code);
  } finally {
    if (
      renderJobId &&
      (job?.status === 'queued' || job?.status === 'rendering' || job?.status === 'processing')
    ) {
      await rendererFetch(context.ownerId, `/jobs/${renderJobId}`, {
        method: 'DELETE',
        signal: AbortSignal.timeout(2000),
      })
        .then((response) => response.body?.cancel())
        .catch(() => undefined);
    }
  }
}
