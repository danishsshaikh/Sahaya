import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { validateScene, type VisualizationContent } from '@openmaic/dsl';
import { buildCompleteScene, changeOutlineType, generateSceneActions } from '@openmaic/generation';
import type { SceneOutline } from '@/lib/types/generation';
import { applySahayaOutlineFeatureFallbacks } from '@/lib/generation/outline-generator';
import { generateVisualization } from '@/lib/visualization/generate';
import { visualizationCueAt, visualizationCueTiming } from '@/lib/visualization/timing';
import {
  cancelSceneContentJob,
  clearSceneContentJobsForTests,
  createOrReuseSceneContentJob,
  readSceneContentJob,
  runSceneContentJob,
  updateSceneContentJobPhase,
} from '@/lib/server/scene-content-jobs';
import {
  admitSceneGenerationAttempt,
  clearSceneGenerationAttemptsForTests,
  commitSceneGenerationAttempt,
  createSceneGenerationVersion,
  runSceneAttemptContent,
  runSceneAttemptActions,
} from '@/lib/server/scene-generation-attempts';
import { GET as artifactGet } from '@/app/api/visualizations/artifacts/[id]/[file]/route';

vi.mock('@/lib/auth/server', () => ({
  requireSessionUser: (request: NextRequest) => {
    const owner = request.headers.get('x-test-owner');
    return owner ? { id: owner } : new Response(null, { status: 401 });
  },
}));

const artifactId = 'a'.repeat(64);
const outline: SceneOutline = {
  id: 'viz-outline',
  type: 'visualization',
  title: 'Tangent slope',
  description: 'Reveal the tangent',
  keyPoints: ['Local rate of change'],
  order: 1,
};
const content: VisualizationContent = {
  type: 'visualization',
  artifact: {
    artifactId,
    duration: 4,
    width: 1280,
    height: 720,
    fps: 30,
    bytes: 1200,
    sha256: 'b'.repeat(64),
    specVersion: 1,
    rendererVersion: '0.22.1/1',
    quality: 'standard',
    classification: 'verified-components',
    cues: [
      { id: 'viz-0', start: 0, end: 2, narration: 'Draw the tangent.' },
      { id: 'viz-1', start: 2, end: 4, caption: 'Slope at one point' },
    ],
  },
};

function configureRenderer(port: number) {
  vi.stubEnv('OPENMAIC_ENABLE_MANIM', 'true');
  vi.stubEnv('MANIM_RENDERER_URL', `http://127.0.0.1:${port}`);
  vi.stubEnv('MANIM_RENDERER_TOKEN', 'unit-test-visualization-token');
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  clearSceneContentJobsForTests();
  clearSceneGenerationAttemptsForTests();
});

describe('Visualization scene integration', () => {
  it('retains outline identity and persists the typed artifact and timed speech actions', async () => {
    const selected = changeOutlineType({ ...outline, type: 'slide' }, 'visualization');
    expect(selected).toMatchObject({ id: outline.id, visualization: { style: 'automatic' } });
    expect(
      applySahayaOutlineFeatureFallbacks(selected, {
        hasLanguageModel: true,
        taskEngineMode: false,
        visualizationAvailable: false,
      }).type,
    ).toBe('slide');
    expect(
      applySahayaOutlineFeatureFallbacks(selected, {
        hasLanguageModel: true,
        taskEngineMode: false,
        visualizationAvailable: true,
      }).type,
    ).toBe('visualization');
    const ai = vi.fn();
    const actions = await generateSceneActions(selected, content, ai);
    expect(ai).not.toHaveBeenCalled();
    expect(actions).toEqual([{ type: 'speech', id: 'viz-0', text: 'Draw the tangent.' }]);
    const scene = buildCompleteScene(selected, content, actions, 'test-stage');
    expect(scene).toMatchObject({ type: 'visualization', outlineId: outline.id, content });
    expect(validateScene(JSON.parse(JSON.stringify(scene)))).toMatchObject({ valid: true });
  });

  it('uses emitted frame boundaries and preserves longer recorded narration when seeking', () => {
    const { cues } = content.artifact;
    expect(visualizationCueAt(cues, 2)?.id).toBe('viz-1');
    expect(visualizationCueAt(cues, 4)).toBeUndefined();
    expect(visualizationCueTiming(cues[0], 1, 4, 1.5)).toEqual({ offset: 2, rate: 0.75 });
    expect(visualizationCueTiming(cues[0], 1.8, 1, 1)).toEqual({ offset: 1.8, rate: 1 });
  });

  it('uses a bounded repair for an invalid plan and submits the next plan to the existing renderer', async () => {
    configureRenderer(18781);
    const transport = vi.fn(async (url: string, request?: RequestInit) => {
      if (url.endsWith('/ready')) return Response.json({ version: '0.22.1/1', maxDuration: 90 });
      const { plan } = JSON.parse(String(request?.body));
      return plan.title === 'first'
        ? Response.json({ error: 'Duplicate object' }, { status: 422 })
        : Response.json({ status: 'completed', artifact: content.artifact });
    });
    vi.stubGlobal('fetch', transport);
    const ai = vi
      .fn()
      .mockResolvedValueOnce(JSON.stringify({ title: 'first', timeline: [{ narration: 'A cue' }] }))
      .mockResolvedValueOnce(
        JSON.stringify({ title: 'second', timeline: [{ narration: 'A cue' }] }),
      );
    const result = await generateVisualization({
      outline,
      allOutlines: [outline],
      aiCall: ai,
      ownerId: 'faculty',
    });
    expect(ai).toHaveBeenCalledTimes(2);
    expect(ai.mock.calls[1][1]).toContain('Duplicate object');
    expect(result.artifact).toEqual(content.artifact);
  });

  it('round-trips rendered content through the authoritative scene attempt and commits its scene', async () => {
    configureRenderer(18784);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.endsWith('/ready')
          ? Response.json({ version: '0.22.1/1', maxDuration: 90 })
          : Response.json({ status: 'completed', artifact: content.artifact }),
      ),
    );
    const stageId = 'stage';
    const ownerUserId = 'faculty';
    const allOutlines = [outline];
    const { identity } = admitSceneGenerationAttempt({
      ownerUserId,
      stageId,
      outlineId: outline.id,
      generationVersion: createSceneGenerationVersion({ outline, allOutlines }),
    });
    const result = await runSceneAttemptContent(ownerUserId, identity, async () => ({
      effectiveOutline: outline,
      content: await generateVisualization({
        outline,
        allOutlines,
        ownerId: ownerUserId,
        aiCall: async () =>
          JSON.stringify({ title: outline.title, timeline: [{ narration: 'Draw the tangent.' }] }),
      }),
    }));
    const fromBrowser = JSON.parse(JSON.stringify(result.content)) as VisualizationContent;
    const { scene } = await runSceneAttemptActions(ownerUserId, identity, fromBrowser, async () => {
      const actions = await generateSceneActions(outline, fromBrowser, vi.fn());
      return {
        scene: {
          type: 'visualization',
          id: 'scene',
          outlineId: outline.id,
          stageId,
          title: outline.title,
          order: outline.order,
          content: fromBrowser,
          actions,
        },
        previousSpeeches: ['Draw the tangent.'],
      };
    });
    expect(commitSceneGenerationAttempt(ownerUserId, identity, scene.id).accepted).toBe(true);
  });

  it('reuses the stored plan for measured voice timing without invoking a model', async () => {
    configureRenderer(18782);
    const plan = { timeline: [{ seconds: 2, narration: 'Draw the tangent.' }, { seconds: 2 }] };
    const transport = vi.fn(async (url: string, request?: RequestInit) => {
      if (url.endsWith('/ready')) return Response.json({ version: '0.22.1/1', maxDuration: 90 });
      if (url.endsWith('/plan.json')) return Response.json(plan);
      const payload = JSON.parse(String(request?.body));
      expect(payload.plan.timeline).toEqual([
        { seconds: 3.02, narration: 'Draw the tangent.' },
        { seconds: 2 },
      ]);
      return Response.json({ status: 'completed', artifact: content.artifact });
    });
    vi.stubGlobal('fetch', transport);
    const ai = vi.fn();
    await generateVisualization({
      outline,
      allOutlines: [outline],
      aiCall: ai,
      ownerId: 'faculty',
      revision: { sourceArtifactId: artifactId, cueDurations: { 'viz-0': 3.012 } },
    });
    expect(ai).not.toHaveBeenCalled();
    expect(transport).toHaveBeenCalledTimes(3);
  });
});

describe('owner-scoped job and media access', () => {
  it('deduplicates submissions, discloses phase to the owner, and aborts a running render', async () => {
    const input = {
      ownerUserId: 'faculty',
      stageId: 'stage',
      outlineTitle: 'Tangent',
      dedupeKey: 'plan-hash',
      cancellable: true,
    };
    const { job } = createOrReuseSceneContentJob(input);
    expect(createOrReuseSceneContentJob(input).job.id).toBe(job.id);
    const run = runSceneContentJob(job.id, async (signal) => {
      updateSceneContentJobPhase(job.id, 'rendering');
      await new Promise<void>((resolve) =>
        signal?.addEventListener('abort', () => resolve(), { once: true }),
      );
      return { content, effectiveOutline: outline };
    });
    expect(readSceneContentJob(job.id, 'faculty')?.phase).toBe('rendering');
    expect(readSceneContentJob(job.id, 'another')).toBeNull();
    expect(cancelSceneContentJob(job.id, 'another')).toBe(false);
    expect(cancelSceneContentJob(job.id, 'faculty')).toBe(true);
    await run;
    expect(readSceneContentJob(job.id, 'faculty')?.status).toBe('cancelled');
    expect(createOrReuseSceneContentJob(input).job.id).not.toBe(job.id);
  });

  it('rejects anonymous and malformed requests before any renderer access', async () => {
    const transport = vi.fn();
    vi.stubGlobal('fetch', transport);
    const request = new NextRequest(
      'http://localhost/api/visualizations/artifacts/sample/video.mp4',
    );
    expect(
      (
        await artifactGet(request, {
          params: Promise.resolve({ id: artifactId, file: 'video.mp4' }),
        })
      ).status,
    ).toBe(401);
    const authenticated = new NextRequest(request, { headers: { 'x-test-owner': 'faculty' } });
    expect(
      (
        await artifactGet(authenticated, {
          params: Promise.resolve({ id: '..', file: 'video.mp4' }),
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await artifactGet(authenticated, {
          params: Promise.resolve({ id: artifactId, file: 'plan.json' }),
        })
      ).status,
    ).toBe(404);
    expect(transport).not.toHaveBeenCalled();
  });

  it('forwards ranges with a server-derived owner namespace and private cache policy', async () => {
    configureRenderer(18783);
    const transport = vi.fn().mockResolvedValue(
      new Response('part', {
        status: 206,
        headers: { 'content-range': 'bytes 0-3/100', 'content-type': 'video/mp4' },
      }),
    );
    vi.stubGlobal('fetch', transport);
    const request = new NextRequest(
      'http://localhost/api/visualizations/artifacts/sample/video.mp4',
      {
        headers: { 'x-test-owner': 'faculty', 'X-Manim-Owner': 'forged', range: 'bytes=0-3' },
      },
    );
    const response = await artifactGet(request, {
      params: Promise.resolve({ id: artifactId, file: 'video.mp4' }),
    });
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 0-3/100');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const sentHeaders = transport.mock.calls[0][1].headers as Headers;
    expect(sentHeaders.get('x-manim-owner')).toMatch(/^[a-f0-9]{64}$/);
    expect(sentHeaders.get('range')).toBe('bytes=0-3');
  });
});
