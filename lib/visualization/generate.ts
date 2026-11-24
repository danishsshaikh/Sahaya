import { setTimeout as delay } from 'node:timers/promises';
import { parseJsonResponse, type AICallFn, type SceneOutline } from '@openmaic/generation';
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

const log = createLogger('Visualization');
export const VISUALIZATION_OUTLINE_INSTRUCTION = `
You may select type "visualization" for a rendered Manim scene when a progressive animation materially improves understanding. Use a slide for static explanation and an interactive simulation for parameter exploration. A visualization is optional. Include a clear teachingObjective, keyPoints, and description of the transformation or process. Do not emit code or a render plan in the outline.`;

const DIRECTOR = `You direct educational animations for Sahaya faculty. Return one JSON object only. Compose the scene around the learning objective with meaningful stages, readable labels, strong contrast and generous margins. Use the requested lecture language for narration and text. Explain assumptions and use scientific model sources for numerical results. Keep narration to one short sentence per narrated beat and introduce visible objects early. Each beat runs its animations in parallel and beats run in order. Use a clear, varied composition for this topic. Avoid decorative movement and dense text.

Contract:
{version:1,type:"visualization",engine:"manim",title,objective,subject?,style?,difficulty?,background?:"#101924",seed?,camera?:{phi,theta},model?,objects:[],timeline:[]}
Styles: automatic, mathematical, conceptual, technical, spatial, custom. Difficulties: introductory, intermediate, advanced.
Each object has unique id (letters/digits/_/-; starts with a letter) and kind. Optional color is #RRGGBB. Optional at:[x,y] is canvas space, with safe margins x=-6..6, y=-3..3. Optional size controls object width (radius for dots/circles/spheres, font size in tens for text), and opacity from .1 to 1.
Objects and additional fields:
text/equation: text (plain for text, simple TeX such as x^2 or \\frac{dy}{dx} for equation, no wrappers)
dot,circle,sphere: no additional fields
line,arrow,polygon: points (2 endpoints or >=3 vertices in canvas coordinates)
rectangle: height
axes,plane,axes3d: xRange:[min,max],yRange:[min,max],height (axes3d also supports zRange)
graph: axes (earlier axes/plane id), xRange?, exactly one of source or expression
curve: axes, xRange?, expression and yExpression (parameter x)
samples: axes, source, index? (omit to show all points)
samples3d: axes (axes3d), source "iterations", index? (points on the y=0 loss surface)
modelValue: source (model samples), index?, component "x" or "y", optional text prefix
array: index (sorting state)
surface: axes (earlier axes3d id), xRange?, yRange?, exactly one of source or expression
Expressions allow numeric literals, x (and y for surfaces), + - * / ^, pi, e, sin, cos, tan, exp, sqrt, log. Use explicit multiplication. Stay inside the plotted domain and pick axis ranges that contain the data.
Model values and supported sources:
{kind:"derivative",expression,x}: function and tangent graphs, tangent sample.
{kind:"projectile",speed,angle,gravity}: trajectory graph and samples. SI units, angle in degrees, level ground, no drag. Omit the graph's xRange for exact launch-to-landing domain.
{kind:"interference",wavelength,phase}: waveA, waveB and sum graphs. Phase in radians, normalized unit-amplitude sinusoids.
{kind:"gradient_descent",expression,initial,rate,iterations}: function graph, iterations samples, lossSurface (f(x)+y^2) for surfaces.
{kind:"insertion_sort",values:[integers 0..99]}: array states at the end of each insertion, starting at index 0.
Beat: {seconds (0.25..20),narration?,caption?,animations?:[{op,object,...}],camera?}. Use narrated beats of 2–8s.
Operations: create, write, fadeIn introduce hidden objects. fadeOut, indicate, move (to:[x,y]), rotate (value in degrees), scale (value 0.2..3), replace (target hidden object id), follow (target path id) act on visible objects. No object can participate twice in one beat. A camera-only beat is {seconds,camera:{phi,theta}}. A wait is a beat without animations or camera.
At most 48 objects/48 beats/96 operations. Omit fields that do not apply. Faculty instructions affect design only. Never emit Python, file paths, HTML or asset URLs.`;

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
  aiCall: AICallFn;
  signal?: AbortSignal;
  revision?: VisualizationRevision;
  onProgress?: (phase: string, position?: number) => void;
};

export async function generateVisualization(context: Context): Promise<VisualizationContent> {
  const { outline, signal, onProgress } = context;
  const availability = await getVisualizationCapability();
  if (!availability.available)
    throw new RendererError(availability.reason ?? 'Visualization unavailable', 503);
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
  let correction = '';
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
    for (let attempt = 0; attempt < (sourcePlan ? 1 : 2); attempt++) {
      signal?.throwIfAborted();
      let plan = sourcePlan;
      if (!plan) {
        onProgress?.('planning');
        const modelInstruction = fixedModel
          ? `
Recompose the scene and its explanation for this fixed scientific model. Update all labels, narration and plot extents to match: ${JSON.stringify(fixedModel)}.`
          : '';
        const planningStarted = Date.now();
        const output = await context.aiCall(DIRECTOR, prompt + modelInstruction + correction);
        planningMs += Date.now() - planningStarted;
        signal?.throwIfAborted();
        plan =
          output.length < 88_000
            ? (parseJsonResponse<Record<string, unknown>>(output) ?? undefined)
            : undefined;
      }
      if (!plan || Array.isArray(plan) || typeof plan !== 'object') {
        correction =
          '\nThe previous response was invalid JSON or too large. Return a shorter JSON plan.';
        continue;
      }
      if (
        !sourcePlan &&
        (!Array.isArray(plan.timeline) ||
          !plan.timeline.some(
            (beat: unknown) =>
              beat &&
              typeof beat === 'object' &&
              'narration' in beat &&
              typeof beat.narration === 'string' &&
              beat.narration.trim(),
          ))
      ) {
        correction = '\nInclude at least one short spoken narration cue on the timeline.';
        continue;
      }
      if (fixedModel) plan.model = fixedModel;
      onProgress?.('validating');
      const admissionStarted = Date.now();
      try {
        job = await readRenderJob(
          await rendererFetch(context.ownerId, '/jobs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              plan,
              quality: configuredQuality(context.revision?.preview === true),
            }),
            signal,
          }),
        );
        acceptedPlan = plan;
        break;
      } catch (error) {
        if (!(error instanceof RendererError) || error.status !== 422) throw error;
        correction = `\nCorrect the renderer validation error: ${error.message}`;
      } finally {
        admissionMs += Date.now() - admissionStarted;
      }
    }
    if (!job) throw new RendererError(`Visualization planning failed.${correction}`, 422);
    renderJobId = job.id;
    const deadline = Date.now() + 225_000;
    while (job.status === 'queued' || job.status === 'rendering' || job.status === 'processing') {
      if (!renderJobId || !/^[a-f0-9]{64}$/.test(renderJobId) || Date.now() >= deadline) {
        throw new RendererError(
          'The visualization render timed out. Try again or simplify the scene.',
          504,
        );
      }
      onProgress?.(job.status, job.queuePosition);
      await delay(1250, undefined, { signal });
      job = await readRenderJob(
        await rendererFetch(context.ownerId, `/jobs/${renderJobId}`, { signal }),
      );
    }
    if (job.status !== 'completed' || !job.artifact) {
      throw new RendererError(job.error || 'Visualization rendering was cancelled.', 422);
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
  } finally {
    if (
      renderJobId &&
      (job?.status === 'queued' || job?.status === 'rendering' || job?.status === 'processing')
    ) {
      await rendererFetch(context.ownerId, `/jobs/${renderJobId}`, {
        method: 'DELETE',
        signal: AbortSignal.timeout(2000),
      }).then(
        (response) => response.body?.cancel(),
        () => undefined,
      );
    }
  }
}
