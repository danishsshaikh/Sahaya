import { afterEach, describe, expect, it, vi } from 'vitest';
import draft from '@/services/manim-renderer/fixtures/llm-diffraction.json';
import { generateVisualization, type VisualizationAiCall } from '@/lib/visualization/generate';
import {
  applyPlanRepair,
  compilePlan,
  operatorIssueLocation,
  normalizePlan,
  parsePlanObject,
  PLAN_GUIDANCE,
} from '@/lib/visualization/plan-contract';
import { visualizationJsonOutput } from '@/lib/visualization/llm-output';
import type { SceneOutline } from '@/lib/types/generation';

const outline: SceneOutline = {
  type: 'visualization',
  id: 'scene-3',
  order: 3,
  title: 'Intensity Distribution and Minima Conditions',
  description: 'Explain the normalized single-slit diffraction curve.',
  keyPoints: ['Central maximum', 'Minima'],
};
const sizePath = ['objects', 1, 'size'];
const maxIssue = {
  path: sizePath,
  code: 'maximum',
  message: 'Value must satisfy maximum 10',
  value: 18,
  limit: 10,
};
const minIssue = {
  path: sizePath,
  code: 'minimum',
  message: 'Value must satisfy minimum 0.1',
  value: 0,
  limit: 0.1,
};
const completed = { status: 'completed', artifact: { artifactId: 'a'.repeat(64) } };

function patch(value: number) {
  return JSON.stringify({ edits: [{ op: 'replace', path: sizePath, value }] });
}

function setup(port: number) {
  vi.stubEnv('OPENMAIC_ENABLE_MANIM', 'true');
  vi.stubEnv('MANIM_RENDERER_URL', `http://127.0.0.1:${port}`);
  vi.stubEnv('MANIM_RENDERER_TOKEN', 'test-renderer-token-123456789');
}

function mockRenderer(port: number, admit: (plan: typeof draft) => Response) {
  setup(port);
  const submissions: unknown[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/ready'))
        return Response.json({ version: '0.22.1/3', maxDuration: 90, validationProtocol: 3 });
      if (!url.endsWith('/jobs')) throw new Error('Unexpected request');
      const plan = JSON.parse(String(init?.body)).plan;
      submissions.push(plan);
      return admit(plan);
    }),
  );
  return submissions;
}

function generate(aiCall: VisualizationAiCall) {
  return generateVisualization({ outline, allOutlines: [outline], ownerId: 'faculty', aiCall });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('Live Manim planning regressions', () => {
  it('compiles supported native encodings without altering physics or dropping unknown fields', () => {
    const draft = {
      objects: [
        {
          id: 'axis',
          kind: 'Axes',
          x_range: [-3, 3, 1],
          y_range: [0, 1.2, 0.2],
          position: [0, -1, 0],
        },
        { id: 'equation', kind: 'MathTex', text: '$a\\sin(θ)=mλ$', unsupportedSize: 31 },
        { id: 'graph', kind: 'graph', axes: 'axis', expression: 'sinc(pi*x)^2' },
        { kind: 'Line', points: [{ x: 0, y: 1 }, [1, 0, 0]] },
      ],
      timeline: [{ animations: [{ op: 'move', object: 'equation', position: { x: 0, y: 2 } }] }],
    };
    const { plan, actions } = compilePlan(draft);
    expect(plan.objects).toEqual([
      { id: 'axis', kind: 'axes', xRange: [-3, 3, 1], yRange: [0, 1.2, 0.2], at: [0, -1] },
      { id: 'equation', kind: 'equation', text: 'a\\sin(\\theta )=m\\lambda', unsupportedSize: 31 },
      draft.objects[2],
      {
        id: 'object-4',
        kind: 'line',
        points: [
          [0, 1],
          [1, 0],
        ],
      },
    ]);
    expect(plan.timeline).toEqual([
      { animations: [{ op: 'move', object: 'equation', to: [0, 2] }] },
    ]);
    expect(actions).toContain('normalizeEquation');
    expect(compilePlan(plan)).toEqual({ plan, actions: [] });
    expect(operatorIssueLocation(['objects', 1, 'unsupportedSize'])).toBe(
      'objects.1.unsupportedSize',
    );
    expect(operatorIssueLocation(['objects', 1, 'private text\n'])).toContain(
      '[invalid field name]',
    );
  });

  it('atomically replaces an invalid object kind and rejects incompatible fields and unsafe keys', () => {
    const plan = {
      objects: [
        {
          id: 'marker',
          kind: 'unsupportedMarker',
          at: [0, 0],
          points: [
            [0, 0],
            [1, 1],
          ],
        },
      ],
    };
    const issue = { path: ['objects', 0, 'kind'], code: 'enum', message: 'Unsupported kind' };
    const fix = (value: unknown) => ({ edits: [{ op: 'replace', path: ['objects', 0], value }] });
    expect(
      applyPlanRepair(plan, { edits: [{ op: 'replace', path: issue.path, value: 'dot' }] }, [
        issue,
      ]),
    ).toBeUndefined();
    expect(
      applyPlanRepair(plan, fix({ ...plan.objects[0], kind: 'dot' }), [issue]),
    ).toBeUndefined();
    expect(applyPlanRepair(plan, fix({ id: 'marker', kind: 'dot', at: [0, 0] }), [issue])).toEqual({
      objects: [{ id: 'marker', kind: 'dot', at: [0, 0] }],
    });
    expect(
      applyPlanRepair(
        plan,
        fix(JSON.parse('{"id":"marker","kind":"dot","__proto__":{"polluted":true}}')),
        [issue],
      ),
    ).toBeUndefined();
  });

  it('detects a repeated equation rejection and skips an identical compiled repair', async () => {
    const issue = {
      path: ['objects', 1, 'text'],
      code: 'equation',
      message: 'Unsupported display command',
    };
    const submissions = mockRenderer(18807, () =>
      Response.json({ issues: [issue] }, { status: 422 }),
    );
    const plan = structuredClone(draft);
    plan.objects[1].kind = 'equation';
    plan.objects[1].text = String.raw`(x\text{original})`;
    const proposal = (value: string) =>
      JSON.stringify({ edits: [{ op: 'replace', path: issue.path, value }] });
    const ai = vi
      .fn<VisualizationAiCall>()
      .mockResolvedValueOnce(JSON.stringify(plan))
      .mockResolvedValueOnce(proposal(String.raw`\left(x\text{original}\right)`))
      .mockResolvedValueOnce(proposal(String.raw`$(x\text{original})$`));
    await expect(generate(ai)).rejects.toMatchObject({ code: 'VISUALIZATION_REPAIR' });
    expect(ai).toHaveBeenCalledTimes(3);
    expect(ai.mock.calls[2][1]).toContain('left the same validation issues');
    expect(submissions).toHaveLength(2);
  });

  it('rolls back a repair that introduces an unrelated error', async () => {
    const newIssue = { path: ['objects', 2, 'axes'], code: 'reference', message: 'Invalid axes' };
    const submissions = mockRenderer(18811, (candidate) =>
      candidate.objects[1].size === 1.8
        ? Response.json(completed)
        : Response.json(
            { issues: [candidate.objects[1].size === 18 ? maxIssue : newIssue] },
            { status: 422 },
          ),
    );
    const ai = vi
      .fn<VisualizationAiCall>()
      .mockResolvedValueOnce(JSON.stringify(draft))
      .mockResolvedValueOnce(patch(4.5))
      .mockResolvedValueOnce(patch(1.8));
    await generate(ai);
    expect(ai.mock.calls[2][1]).toContain('introduced errors on other fields');
    expect(submissions).toHaveLength(3);
  });

  it('stamps missing fixed metadata and targets the actual size limit without rewriting the plan', async () => {
    const submissions = mockRenderer(18801, (plan) =>
      plan.objects[1].size === 18
        ? Response.json({ issues: [maxIssue] }, { status: 422 })
        : Response.json(completed),
    );
    const ai = vi
      .fn<VisualizationAiCall>()
      .mockResolvedValueOnce(
        '`'.repeat(3) + 'json\n' + JSON.stringify(draft) + '\n' + '`'.repeat(3),
      )
      .mockResolvedValueOnce(patch(1.8));
    await expect(generate(ai)).resolves.toMatchObject({
      type: 'visualization',
      artifact: completed.artifact,
    });
    expect(ai.mock.calls[0][0]).toContain('font size divided by 10');
    expect(ai.mock.calls[1][1]).toContain('"limit":10');
    expect(ai.mock.calls[1][1]).toContain('"value":18');
    const before = normalizePlan(draft);
    const expected = structuredClone(before);
    (expected.objects as typeof draft.objects)[1].size = 1.8;
    expect(submissions).toEqual([before, expected]);
  });

  it('revalidates an unsuccessful patch and reports the new bound on the next repair', async () => {
    const submissions = mockRenderer(18802, (plan) => {
      const size = plan.objects[1].size;
      return size === 1.8
        ? Response.json(completed)
        : Response.json({ issues: [size === 18 ? maxIssue : minIssue] }, { status: 422 });
    });
    const ai = vi
      .fn<VisualizationAiCall>()
      .mockResolvedValueOnce(JSON.stringify(draft))
      .mockResolvedValueOnce(patch(0))
      .mockResolvedValueOnce(patch(1.8));
    await generate(ai);
    expect(submissions).toHaveLength(3);
    expect(ai.mock.calls[2][1]).toContain('"limit":0.1');
  });

  it('rejects patches that rewrite valid beats and exhausts without submitting them', async () => {
    const submissions = mockRenderer(18803, () =>
      Response.json({ issues: [maxIssue] }, { status: 422 }),
    );
    const invalidPatch = JSON.stringify({
      edits: [
        { op: 'replace', path: sizePath, value: 1.8 },
        { op: 'replace', path: ['timeline', 0, 'seconds'], value: 4 },
      ],
    });
    const ai = vi
      .fn<VisualizationAiCall>()
      .mockResolvedValueOnce(JSON.stringify(draft))
      .mockResolvedValue(invalidPatch);
    await expect(generate(ai)).rejects.toMatchObject({
      code: 'VISUALIZATION_REPAIR',
      message: expect.stringMatching(/Retry this scene.*objects\.1\.size/),
    });
    expect(submissions).toHaveLength(1);
    expect(ai).toHaveBeenCalledTimes(3);
  });

  it('sends multiple exact issues and accepts one patch for the affected fields', async () => {
    const issue = {
      path: ['timeline', 0, 'animations', 0, 'object'],
      code: 'reference',
      message: 'Reference an existing object ID',
    };
    const altered = structuredClone(draft);
    altered.timeline[0].animations![0].object = 'unknown';
    const submissions = mockRenderer(18804, (plan) =>
      plan.objects[1].size === 18
        ? Response.json({ issues: [maxIssue, issue] }, { status: 422 })
        : Response.json(completed),
    );
    const ai = vi
      .fn<VisualizationAiCall>()
      .mockResolvedValueOnce(JSON.stringify(altered))
      .mockResolvedValueOnce(
        JSON.stringify({
          edits: [
            { op: 'replace', path: sizePath, value: 1.8 },
            { op: 'replace', path: issue.path, value: 'heading' },
          ],
        }),
      );
    await generate(ai);
    expect(ai.mock.calls[1][1]).toContain(JSON.stringify(issue.path));
    expect(submissions).toHaveLength(2);
  });

  it('preserves valid plan values and refuses truncated JSON and repairs to science data', () => {
    const valid = structuredClone(draft);
    valid.objects[1].size = 1.8;
    const canonical = normalizePlan(valid);
    expect(normalizePlan(canonical)).toEqual(canonical);
    expect(parsePlanObject('{"objects":[{"kind":"graph","expression":"sinc')).toBeUndefined();
    const path = ['objects', 2, 'expression'];
    expect(
      applyPlanRepair(canonical, { edits: [{ op: 'replace', path, value: 'x^2' }] }, [
        { path, code: 'scientific', message: 'Bad function' },
      ]),
    ).toBeUndefined();
    expect(PLAN_GUIDANCE).toContain('sinc(t) means sin(t)/t');
  });

  it('limits JSON-format retries and reports a planning failure without submitting a half plan', async () => {
    const submissions = mockRenderer(18805, () => Response.json(completed));
    const ai = vi.fn<VisualizationAiCall>().mockResolvedValue('{"objects":[{"title":"unfinished');
    await expect(generate(ai)).rejects.toMatchObject({ code: 'VISUALIZATION_PLANNING' });
    expect(ai).toHaveBeenCalledTimes(3);
    expect(submissions).toHaveLength(0);
  });

  it('rejects an outdated renderer before calling a provider', async () => {
    setup(18806);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(Response.json({ version: '0.22.1/1', maxDuration: 90 })),
    );
    const ai = vi.fn<VisualizationAiCall>();
    await expect(generate(ai)).rejects.toMatchObject({
      code: 'VISUALIZATION_UNAVAILABLE',
      message: expect.stringContaining('Rebuild the Manim renderer'),
    });
    expect(ai).not.toHaveBeenCalled();
  });

  it.each([
    {
      code: 'VISUALIZATION_RENDER_TIMEOUT',
      response: Response.json({
        status: 'failed',
        errorCode: 'VISUALIZATION_RENDER_TIMEOUT',
        error: 'internal worker path',
      }),
    },
    {
      code: 'VISUALIZATION_RENDER',
      response: Response.json({ status: 'failed', error: 'internal worker path' }),
    },
    {
      code: 'VISUALIZATION_UNAVAILABLE',
      response: new Response('<html>private gateway trace</html>', { status: 502 }),
    },
  ])('reports $code without exposing upstream details', async ({ code, response }) => {
    mockRenderer(
      18808 +
        [
          'VISUALIZATION_RENDER_TIMEOUT',
          'VISUALIZATION_RENDER',
          'VISUALIZATION_UNAVAILABLE',
        ].indexOf(code),
      () => response,
    );
    const valid = structuredClone(draft);
    valid.objects[1].size = 1.8;
    const ai = vi.fn<VisualizationAiCall>().mockResolvedValue(JSON.stringify(valid));
    await expect(generate(ai)).rejects.toMatchObject({
      code,
      message: expect.not.stringMatching(/internal worker path|private gateway trace/),
    });
  });

  it('uses native JSON mode only on a verified direct transport', () => {
    vi.stubEnv('LLM_ROUTER_ENABLED', 'false');
    expect(visualizationJsonOutput('openai', 'openai:gpt-4o')).toHaveProperty('output');
    expect(visualizationJsonOutput('openai', 'openai:gpt-4o', 'http://localhost:8080/v1')).toEqual(
      {},
    );
    expect(visualizationJsonOutput('openai', 'openai:nvidia/nemotron-3-ultra-550b-a55b')).toEqual(
      {},
    );
    vi.stubEnv('LLM_ROUTER_ENABLED', 'true');
    expect(visualizationJsonOutput('openai', 'openai:gpt-4o')).toEqual({});
  });
});
