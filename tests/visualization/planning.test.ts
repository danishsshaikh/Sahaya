import { afterEach, describe, expect, it, vi } from 'vitest';
import { callLLM } from '@/lib/ai/llm';
import { createManimAiCall } from '@/lib/visualization/model';
import { manimAgentBudget, manimRenderWindows } from '@/lib/visualization/budget';
import { generateVisualization, type VisualizationAiCall } from '@/lib/visualization/generate';
import {
  discoverManimSkill,
  readManimReference,
  relevantReferences,
} from '@/lib/visualization/skill';
import { findManimDocumentation } from '@/lib/visualization/documentation';
import { supportsNativeManimTools } from '@/lib/visualization/agent-tools';
import type { SceneOutline } from '@/lib/types/generation';

const logs = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('@/lib/logger', () => ({ createLogger: () => logs }));

const outline: SceneOutline = {
  id: 'scene_3',
  order: 2,
  type: 'visualization',
  title: 'Animated Diffraction Visualization',
  description: 'Show maxima and minima of a single-slit plot',
  keyPoints: ['Central maximum'],
};
const source = `from manim import *
from sahaya_timing import CueScene

class GeneratedScene(CueScene):
    def construct(self):
        with self.cue("intro"):
            self.play(Create(Circle()))
`;
const segments = [{ id: 'intro', narration: 'Here is the central maximum.' }];
const submission = (code: string) =>
  JSON.stringify({ tool: 'submit_scene', source: code, segments });
const annotated = (code: string) => `# sahaya-cues: ${JSON.stringify(segments)}\n${code}`;
const verified = {
  version: '0.22.1/native-1',
  protocol: 4,
  maxDuration: 90,
  manimVersion: '0.22.1',
  isolation: 'verified',
  backend: 'gvisor',
  secureExecution: true,
  rendererReady: true,
  sandboxImage: 'sha256:' + 'b'.repeat(64),
};
const output = {
  status: 'completed',
  artifact: { artifactId: 'a'.repeat(64), sourceFormat: 'python' },
};
const optionError = {
  issue: { code: 'api', message: 'Check the named Manim method.', line: 6, symbol: 'missing' },
};

function completion(
  content: string | null,
  finishReason = 'stop',
  reasoning?: string,
  reasoningTokens: number | null = 0,
  outputTokens = reasoningTokens || 120,
) {
  return Response.json({
    id: 'chat-gemma',
    object: 'chat.completion',
    created: 1,
    model: 'gemma-local',
    choices: [
      {
        index: 0,
        finish_reason: finishReason,
        message: { role: 'assistant', content, reasoning_content: reasoning },
      },
    ],
    usage: {
      prompt_tokens: 440,
      completion_tokens: outputTokens,
      ...(reasoningTokens !== null && {
        completion_tokens_details: { reasoning_tokens: reasoningTokens },
      }),
    },
  });
}

function streamCompletion(content: string, reasoning?: string, reasoningTokens?: number) {
  const base = {
    id: 'gemma-stream',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'gemma-local',
  };
  const events = [
    ...(reasoning
      ? [
          {
            ...base,
            choices: [
              {
                index: 0,
                delta: { reasoning_content: reasoning },
                finish_reason: null,
              },
            ],
          },
        ]
      : []),
    ...(content.match(/[\s\S]{1,37}/g) ?? []).map((part) => ({
      ...base,
      choices: [{ index: 0, delta: { content: part }, finish_reason: null }],
    })),
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    {
      ...base,
      choices: [],
      usage: {
        prompt_tokens: 440,
        completion_tokens: 130,
        ...(reasoningTokens !== undefined && {
          completion_tokens_details: { reasoning_tokens: reasoningTokens },
        }),
      },
    },
  ];
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } },
  );
}

function localManim() {
  vi.stubEnv('MANIM_MODEL_PRIMARY_MODEL', 'openai:gemma-local');
  vi.stubEnv('MANIM_MODEL_PRIMARY_BASE_URL', 'http://gemma.example/v1');
  vi.stubEnv('MANIM_MODEL_PRIMARY_LOCAL', 'true');
}

function configure(
  port: number,
  reply: (url: string, opts?: RequestInit) => Response | Promise<Response>,
) {
  vi.stubEnv('OPENMAIC_ENABLE_MANIM', 'true');
  vi.stubEnv('MANIM_RENDERER_URL', `http://127.0.0.1:${port}`);
  vi.stubEnv('MANIM_RENDERER_TOKEN', 'private-renderer-token-test-32');
  vi.stubEnv('CONTEXT7_API_KEY', '');
  vi.stubEnv('MANIM_AGENT_MODEL_CALLS', '3');
  vi.stubEnv('MANIM_AGENT_DOC_REQUESTS', '2');
  const fetch = vi.fn(reply);
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

function generate(aiCall: VisualizationAiCall, extra = {}) {
  return generateVisualization({
    outline,
    allOutlines: [outline],
    ownerId: 'owner',
    trace: { stageId: 'VQJ5o7B3QT', requestId: 'manim-test', model: 'gemma-local' },
    aiCall,
    ...extra,
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  delete (globalThis as { __sahayaManimLlmCircuits?: unknown }).__sahayaManimLlmCircuits;
});

describe('native Manim agent', () => {
  it('discovers the builtin skill and reads only relevant references', async () => {
    const skill = await discoverManimSkill();
    expect(skill).toMatchObject({ name: 'sahaya-manim', version: '1.0.0' });
    expect(skill.activate()).toContain('CueScene');
    expect(relevantReferences('plot on spatial axes')).toEqual([
      'layout',
      'timing',
      'plotting',
      'camera',
    ]);
    await expect(readManimReference('timing')).resolves.toContain('Cairo');
  });

  it('loads a reference batch, corrects native Python after preview and publishes the checked replacement', async () => {
    const submitted: { source: string; publication: string; quality: string }[] = [];
    configure(18880, (url, init) => {
      if (url.endsWith('/ready')) return Response.json(verified);
      const candidate = JSON.parse(String(init?.body));
      submitted.push(candidate);
      return candidate.source.includes('missing')
        ? Response.json(optionError, { status: 422 })
        : Response.json(output);
    });
    const phases: string[] = [];
    const ai = vi
      .fn<VisualizationAiCall>()
      .mockResolvedValueOnce({
        text: '',
        toolCalls: [
          { toolName: 'read_reference', input: { topics: ['plotting', 'camera', 'rendering'] } },
        ],
      })
      .mockResolvedValueOnce(submission(source.replace('Circle()', 'missing()')))
      .mockResolvedValueOnce(submission(source));
    await expect(
      generate(ai, { nativeTools: true, onProgress: (phase: string) => phases.push(phase) }),
    ).resolves.toMatchObject({ type: 'visualization', artifact: output.artifact });
    expect(submitted.map(({ quality, publication }) => [quality, publication])).toEqual([
      ['preview', 'none'],
      ['preview', 'none'],
      ['standard', 'saved'],
    ]);
    const codePrompt = JSON.parse(ai.mock.calls[1][1]);
    expect(codePrompt.builtinReferences.map(([topic]: [string]) => topic)).toEqual([
      'layout',
      'timing',
      'plotting',
      'camera',
      'rendering',
    ]);
    expect(ai.mock.calls[0][3]).toHaveProperty('read_reference');
    expect(ai.mock.calls[1][3]).not.toHaveProperty('read_reference');
    expect(ai.mock.calls[2][3]).not.toHaveProperty('read_reference');
    expect(ai.mock.calls[2][1]).toContain('Check the named Manim method');
    expect(ai).toHaveBeenCalledTimes(3);
    expect(phases).toContain('code-repair');
  });

  it('normalizes and repairs a candidate across preflight and isolated preview within the correction budget', async () => {
    const wrong = source
      .replace('GeneratedScene', 'PointOnNumberLine')
      .replace(
        'self.play(Create(Circle()))',
        'axis = NumberLine(include_numbers=True)\n            self.play(FadeIn(Dot(axis.nudge(1))))',
      );
    const normalized = wrong.replace('PointOnNumberLine', 'GeneratedScene');
    const unsafeAtRuntime = normalized
      .replace('axis.nudge(1)', 'axis.n2p(1)')
      .replace('FadeIn', 'FadeOut');
    const corrected = unsafeAtRuntime.replace('FadeOut', 'FadeIn');
    const timeline: [string, string][] = [];
    configure(18906, (url, init) => {
      if (url.endsWith('/ready')) return Response.json({ ...verified, apiPreflight: '0.22.1' });
      const candidate = JSON.parse(String(init?.body));
      if (url.endsWith('/preflight')) {
        timeline.push(['preflight', candidate.source]);
        return Response.json({
          version: '0.22.1',
          source: candidate.source === wrong ? normalized : candidate.source,
          findings:
            candidate.source === wrong
              ? [
                  {
                    kind: 'unknownMethod',
                    line: 8,
                    symbol: 'NumberLine.nudge',
                    severity: 'error',
                    alternatives: ['NumberLine.n2p', 'NumberLine.number_to_point'],
                  },
                ]
              : [],
          ...(candidate.source === wrong && {
            issue: { code: 'api', line: 8 },
            normalization: { line: 4 },
          }),
        });
      }
      timeline.push([candidate.quality, candidate.source]);
      if (candidate.source === unsafeAtRuntime)
        return Response.json({ status: 'failed', issue: { code: 'runtime', line: 8 } });
      return Response.json(output);
    });
    const ai = vi
      .fn<VisualizationAiCall>()
      .mockResolvedValueOnce(
        JSON.stringify({ tool: 'look_up_manim', kind: 'constructor', query: 'NumberLine' }),
      )
      .mockResolvedValueOnce(submission(wrong))
      .mockResolvedValueOnce(submission(unsafeAtRuntime))
      .mockResolvedValueOnce(submission(corrected));
    const requirements = 'Make this visualization clear. '.repeat(400);
    await expect(generate(ai, { requirement: requirements })).resolves.toMatchObject({
      artifact: output.artifact,
    });
    expect(ai).toHaveBeenCalledTimes(4);
    expect(timeline).toEqual([
      ['preflight', wrong],
      ['preflight', unsafeAtRuntime],
      ['preview', unsafeAtRuntime],
      ['preflight', corrected],
      ['preview', corrected],
      ['standard', corrected],
    ]);
    const apiRepair = JSON.parse(ai.mock.calls[2][1]);
    expect(apiRepair.priorSourceAndCues.source).toBe(normalized);
    expect(apiRepair.apiFindings[0].symbol).toBe('NumberLine.nudge');
    expect(apiRepair.knowledge.entries[0].signature).toContain('NumberLine.n2p(');
    expect(apiRepair.sourceExcerpt.lines.join('\n')).toContain('axis.nudge(1)');
    expect(JSON.parse(ai.mock.calls[3][1])).toMatchObject({
      priorSourceAndCues: { source: unsafeAtRuntime },
      executionFeedback: { code: 'runtime', line: 8 },
    });
    for (const [system, prompt] of ai.mock.calls)
      expect(Buffer.byteLength(system) + Buffer.byteLength(prompt)).toBeLessThanOrEqual(9216);
    expect(logs.info).toHaveBeenCalledWith(
      'Manim source preflight',
      expect.objectContaining({
        normalization: { operation: 'rename_entry_point', line: 4 },
        issueCode: 'api',
      }),
    );
    expect(JSON.stringify(logs.info.mock.calls)).not.toContain('axis.nudge(1)');
  });

  it('reports API preflight rejection as Python validation and stops an unchanged repair', async () => {
    const fetch = configure(18907, (url) => {
      if (url.endsWith('/ready')) return Response.json({ ...verified, apiPreflight: '0.22.1' });
      if (!url.endsWith('/preflight'))
        throw new Error('Preflight rejection cannot reserve a render job');
      return Response.json({
        version: '0.22.1',
        source,
        findings: [],
        issue: { code: 'api', line: 7 },
      });
    });
    const ai = vi.fn<VisualizationAiCall>().mockResolvedValue(submission(source));
    await expect(generate(ai)).rejects.toMatchObject({
      code: 'VISUALIZATION_PYTHON_VALIDATION',
      detail: 'api',
    });
    expect(ai).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('reserves repair turns after malformed envelopes and keeps the publisher syntax feedback', async () => {
    const jobs: { source: string; segments: typeof segments; quality: string }[] = [];
    const broken = source.replace('Create(Circle())', 'Create(Circle()');
    configure(18898, (url, init) => {
      if (url.endsWith('/ready')) return Response.json(verified);
      const candidate = JSON.parse(String(init?.body));
      jobs.push(candidate);
      return candidate.source === broken
        ? Response.json(
            { issue: { code: 'syntax', line: 7, message: 'private-raw-error' } },
            { status: 422 },
          )
        : Response.json(output);
    });
    const ai = vi
      .fn<VisualizationAiCall>()
      .mockResolvedValueOnce('{"tool":"submit_scene",')
      .mockResolvedValueOnce(submission(broken))
      .mockResolvedValueOnce('\x60\x60\x60python\n' + source)
      .mockResolvedValueOnce(annotated(source));
    await expect(generate(ai)).resolves.toHaveProperty('artifact');
    expect(ai).toHaveBeenCalledTimes(4);
    expect(JSON.parse(ai.mock.calls[1][1]).formatFeedback.code).toBe('malformed_json');
    const repair = JSON.parse(ai.mock.calls[3][1]);
    expect(repair.priorSourceAndCues).toEqual({ source: broken, segments });
    expect(repair.executionFeedback).toMatchObject({
      code: 'syntax',
      line: 7,
      message: expect.stringContaining('indentation'),
    });
    expect(repair.formatFeedback.code).toBe('invalid_envelope');
    expect(ai.mock.calls[3][0]).toContain('# sahaya-cues:');
    expect(ai.mock.calls[3][1]).not.toContain('private-raw-error');
    expect(jobs.map((job) => [job.source, job.segments, job.quality])).toEqual([
      [broken, segments, 'preview'],
      [annotated(source), segments, 'preview'],
      [annotated(source), segments, 'standard'],
    ]);
    expect(logs.info).toHaveBeenCalledWith(
      'Manim render evaluated',
      expect.objectContaining({
        failureCode: 'VISUALIZATION_PYTHON_VALIDATION',
        issueCode: 'syntax',
        issueLine: 7,
      }),
    );
    expect(logs.info).toHaveBeenCalledWith(
      'Manim tool request',
      expect.objectContaining({
        responseFormat: 'python',
        extractionOutcome: 'submitted',
        sourceBytes: Buffer.byteLength(annotated(source)),
      }),
    );
    expect(JSON.stringify(logs.info.mock.calls)).not.toContain(broken);
  });

  it.each([false, true])(
    'assembles source and cue metadata identically in buffered and streamed responses (stream=%s)',
    async (stream) => {
      const code = annotated(
        source.replace('Circle()', String.raw`MathTex(r"\frac{a}{b}", r"\"label\"")`),
      );
      const response = 'Here is the module.\n\x60\x60\x60python\n' + code + '\x60\x60\x60\n';
      const jobs: unknown[] = [];
      configure(18899, (input, init) => {
        const url = String(input);
        if (url.endsWith('/ready')) return Response.json(verified);
        if (url.endsWith('/jobs')) {
          jobs.push(JSON.parse(String(init?.body)));
          return Response.json(output);
        }
        return stream ? streamCompletion(response) : completion(response);
      });
      localManim();
      vi.stubEnv('MANIM_AGENT_STREAM', String(stream));
      await expect(generate(createManimAiCall({ model: 'unrelated' }))).resolves.toHaveProperty(
        'artifact',
      );
      expect(jobs).toHaveLength(2);
      for (const job of jobs) expect(job).toMatchObject({ source: code, segments });
    },
  );

  it('stops the production three-reference sequence at the first reply after documentation closes', async () => {
    const fetch = configure(18887, (url) =>
      String(url).includes('context7.com')
        ? new Response(null, { status: 404 })
        : Response.json({ ...verified, backend: 'bubblewrap' }),
    );
    vi.stubEnv('CONTEXT7_API_KEY', 'private-context-test-key');
    const ai = vi.fn<VisualizationAiCall>();
    for (const [topic, outputTokens] of [
      ['rendering', 13],
      ['rendering', 13],
      ['plotting', 12],
    ] as const) {
      ai.mockResolvedValueOnce({
        text: JSON.stringify({ tool: 'read_reference', topic }),
        usage: { outputTokens },
      });
    }
    await expect(generate(ai)).rejects.toMatchObject({
      code: 'VISUALIZATION_DOCUMENTATION_BUDGET',
      detail: 'reference_only_response',
    });
    // The deployed loop consumed all three fixtures and 38 tokens.
    expect(ai).toHaveBeenCalledTimes(2);
    expect(ai.mock.calls[0][0]).toContain('"tool":"read_reference"');
    for (const [system, prompt] of ai.mock.calls.slice(1)) {
      expect(system).not.toContain('"tool":"read_reference"');
      expect(system).toContain('Reference retrieval is closed');
      expect(
        JSON.parse(prompt).builtinReferences.filter(([topic]: [string]) => topic === 'rendering'),
      ).toHaveLength(1);
    }
    expect(fetch.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
      '/ready',
      '/api/v2/context',
      '/api/v2/context',
    ]);
    expect(logs.info).toHaveBeenCalledWith(
      'Manim agent completed',
      expect.objectContaining({
        stageId: 'VQJ5o7B3QT',
        outlineId: 'scene_3',
        modelCalls: 2,
        documentationRequests: 2,
        outputTokens: 26,
        duplicateReferences: 1,
        pythonSubmissions: 0,
        previews: 0,
        finals: 0,
        acceptedJobs: 0,
        failureCode: 'VISUALIZATION_DOCUMENTATION_BUDGET',
      }),
    );
    expect(JSON.stringify(logs.info.mock.calls)).not.toContain('private-context-test-key');
  });

  it('refuses unknown tools, invalid topic arguments, and duplicate source', async () => {
    const fetch = configure(18881, (url) =>
      url.endsWith('/ready')
        ? Response.json(verified)
        : Response.json(optionError, { status: 422 }),
    );
    const ai = vi
      .fn<VisualizationAiCall>()
      .mockResolvedValueOnce('{"tool":"read_reference","topic":"../../.env"}')
      .mockResolvedValue(submission(source));
    await expect(generate(ai)).rejects.toMatchObject({
      code: 'VISUALIZATION_RENDER',
      detail: 'api',
    });
    expect(ai).toHaveBeenCalledTimes(3);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('stops repeated execution errors and handles failure after a valid preview', async () => {
    configure(18882, (url, init) => {
      if (url.endsWith('/ready')) return Response.json(verified);
      return JSON.parse(String(init?.body)).quality === 'preview'
        ? Response.json(output)
        : Response.json(optionError, { status: 422 });
    });
    const ai = vi
      .fn<VisualizationAiCall>()
      .mockResolvedValueOnce(submission(source))
      .mockResolvedValue(submission(source + '# second candidate'));
    await expect(generate(ai)).rejects.toMatchObject({
      code: 'VISUALIZATION_RENDER',
      detail: 'api',
    });
    expect(ai).toHaveBeenCalledTimes(2);
  });

  it.each([
    { ...verified, secureExecution: false, isolation: 'administrator-configuration-required' },
    { ...verified, backend: 'docker', isolation: 'verified' },
    { ...verified, protocol: 3 },
  ])(
    'fails closed before provider calls for an unavailable or incompatible sandbox',
    async (health) => {
      configure(18900 + (health.protocol === 3 ? 0 : health.secureExecution ? 1 : 2), () =>
        Response.json(health),
      );
      const ai = vi.fn<VisualizationAiCall>();
      await expect(generate(ai)).rejects.toMatchObject({ code: 'VISUALIZATION_UNAVAILABLE' });
      expect(ai).not.toHaveBeenCalled();
    },
  );

  it('cancels the active renderer job when the user aborts', async () => {
    const jobId = 'c'.repeat(64);
    const controller = new AbortController();
    const fetch = configure(18883, (url, init) => {
      if (url.endsWith('/ready')) return Response.json(verified);
      if (init?.method === 'DELETE') return Response.json({ status: 'cancelled' });
      return Response.json({ status: 'rendering', id: jobId });
    });
    const ai = vi.fn<VisualizationAiCall>().mockResolvedValue(submission(source));
    await expect(
      generate(ai, {
        signal: controller.signal,
        onProgress: (phase: string) => {
          if (phase === 'preview-render') controller.abort();
        },
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetch.mock.calls.at(-1)).toEqual([
      expect.stringContaining(jobId),
      expect.objectContaining({ method: 'DELETE' }),
    ]);
  });

  it('cleans up a running preview at its own deadline and never submits a final', async () => {
    const id = 'e'.repeat(64);
    const fetch = configure(18895, (url, init) =>
      url.endsWith('/ready')
        ? Response.json(verified)
        : init?.method === 'DELETE'
          ? Response.json({ status: 'cancelled' })
          : Response.json({ status: 'rendering', id }),
    );
    vi.stubEnv('MANIM_AGENT_PREVIEW_SECONDS', '1');
    await expect(generate(() => Promise.resolve(submission(source)))).rejects.toMatchObject({
      code: 'VISUALIZATION_RENDER_TIMEOUT',
      detail: 'preview-render_deadline',
    });
    expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    expect(fetch.mock.calls.at(-1)).toEqual([
      expect.stringContaining(id),
      expect.objectContaining({ method: 'DELETE' }),
    ]);
  });

  it('accepts verified Bubblewrap readiness and keeps the native agent workflow', async () => {
    configure(18886, (url) =>
      Response.json(url.endsWith('/ready') ? { ...verified, backend: 'bubblewrap' } : output),
    );
    const ai = vi.fn<VisualizationAiCall>().mockResolvedValue(submission(source));
    await expect(generate(ai)).resolves.toHaveProperty('artifact');
    expect(ai).toHaveBeenCalledTimes(1);
  });

  it('enforces the configured agent deadline during a provider call', async () => {
    configure(18885, () => Response.json(verified));
    vi.stubEnv('MANIM_AGENT_DEADLINE_SECONDS', '1');
    const ai = vi.fn<VisualizationAiCall>(
      (_system, _user, signal) =>
        new Promise((_, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    );
    await expect(generate(ai)).rejects.toMatchObject({ code: 'VISUALIZATION_MODEL_TIMEOUT' });
    expect(ai).toHaveBeenCalledTimes(1);
  });

  it('routes the production 90-second Ultra timeout and Super HTTP 410 to text-only Gemma', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const models: string[] = [];
    const primaryStarted = Promise.withResolvers<void>();
    let gemmaCalls = 0;
    const fetch = configure(18888, (input, init) => {
      const url = String(input);
      if (url.endsWith('/ready')) return Response.json({ ...verified, backend: 'bubblewrap' });
      const body = JSON.parse(String(init?.body));
      if (url.endsWith('/jobs'))
        return body.source.includes('missing')
          ? Response.json(optionError, { status: 422 })
          : Response.json(output);

      models.push(body.model);
      if (body.model === 'nvidia/nemotron-3-ultra-550b-a55b') {
        primaryStarted.resolve();
        return new Promise((_, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
            once: true,
          });
        });
      }
      if (body.model === 'nvidia/nemotron-3-super-120b-a12b')
        return Response.json({ error: { message: 'provider-private-body' } }, { status: 410 });

      expect(url).toBe('http://gemma.example/v1/chat/completions');
      expect(body).not.toHaveProperty('tools');
      expect(body).not.toHaveProperty('tool_choice');
      expect(body).not.toHaveProperty('response_format');
      expect(new Headers(init?.headers).has('authorization')).toBe(false);
      gemmaCalls++;
      const response = () =>
        completion(submission(gemmaCalls === 1 ? source.replace('Circle()', 'missing()') : source));
      // The real deployment cancelled Gemma at this point. Exercise a usable
      // completion after the same elapsed time, without a real provider.
      return gemmaCalls === 1
        ? new Promise((resolve) => setTimeout(() => resolve(response()), 168_000))
        : response();
    });
    const env = {
      LLM_ROUTER_ENABLED: 'false',
      MANIM_MODEL_PRIMARY_MODEL: 'openai:nvidia/nemotron-3-ultra-550b-a55b',
      MANIM_MODEL_PRIMARY_BASE_URL: 'https://ultra.example/v1',
      MANIM_MODEL_PRIMARY_API_KEY: 'private-ultra-test-key',
      MANIM_MODEL_PRIMARY_TIMEOUT_SECONDS: '90',
      MANIM_MODEL_SECONDARY_MODEL: 'openai:nvidia/nemotron-3-super-120b-a12b',
      MANIM_MODEL_SECONDARY_BASE_URL: 'https://super.example/v1',
      MANIM_MODEL_SECONDARY_API_KEY: 'private-super-test-key',
      MANIM_MODEL_FALLBACK_MODEL: 'openai:gemma-local',
      MANIM_MODEL_FALLBACK_BASE_URL: 'http://gemma.example/v1',
      MANIM_MODEL_FALLBACK_LOCAL: 'true',
      MANIM_AGENT_REMOTE_INFERENCE_SECONDS: '90',
      MANIM_AGENT_DEADLINE_SECONDS: '900',
    };
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);

    const ai = createManimAiCall({ model: 'unrelated-classroom-model' });
    const checked = expect(generate(ai)).resolves.toHaveProperty('artifact');
    await primaryStarted.promise;
    await vi.advanceTimersByTimeAsync(89_999);
    expect(models).toEqual(['nvidia/nemotron-3-ultra-550b-a55b']);
    expect(fetch.mock.calls.some(([url]) => String(url).endsWith('/jobs'))).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(167_999);
    expect(fetch.mock.calls.some(([url]) => String(url).endsWith('/jobs'))).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await checked;
    // The correction continues on the working tier and avoids another 90-second probe.
    expect(models).toEqual([
      'nvidia/nemotron-3-ultra-550b-a55b',
      'nvidia/nemotron-3-super-120b-a12b',
      'gemma-local',
      'gemma-local',
    ]);
    expect(logs.info).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'timeout',
        selectedRole: 'primary',
        timeoutBudgetMs: 90000,
      }),
    );
    expect(logs.info).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'http_410',
        selectedRole: 'secondary',
        fallbackReason: 'timeout',
      }),
    );
    expect(logs.info).toHaveBeenCalledWith(
      'Manim model turn',
      expect.objectContaining({
        selectedModel: 'gemma-local',
        providerRole: 'fallback',
        fallbackReason: 'http_410',
        remainingModelCalls: 2,
        remainingExecutionMs: 642000,
        renderReserveMs: 250000,
        requestedCompletionTokens: 3072,
        call: 1,
      }),
    );
    expect(JSON.stringify(logs.info.mock.calls)).not.toMatch(
      /provider-private-body|private-(ultra|super)-test-key/,
    );
  });

  it('uses a local primary exclusively for Manim while ordinary calls keep their route', async () => {
    configure(18891, (input, init) => {
      const url = String(input);
      if (url.endsWith('/ready')) return Response.json(verified);
      if (url.endsWith('/jobs')) return Response.json(output);
      const body = JSON.parse(String(init?.body));
      if (url.startsWith('http://gemma.example/')) {
        expect(body).toMatchObject({ model: 'gemma-local', reasoning_effort: 'none' });
        expect(body).not.toHaveProperty('chat_template_kwargs');
        expect(body.max_completion_tokens ?? body.max_tokens).toBe(3072);
        return completion(submission(source));
      }
      expect(body).toMatchObject({ model: 'normal-primary' });
      expect(body).not.toHaveProperty('reasoning_effort');
      expect(body).not.toHaveProperty('chat_template_kwargs');
      return completion('ordinary');
    });
    localManim();
    vi.stubEnv('MANIM_MODEL_ENABLE_THINKING', 'false');
    vi.stubEnv('MANIM_MODEL_PRIMARY_DISABLE_REASONING', 'true');
    vi.stubEnv('LLM_ROUTER_ENABLED', 'true');
    vi.stubEnv('LLM_ROUTER_PRIMARY_MODEL', 'openai:normal-primary');
    vi.stubEnv('LLM_ROUTER_PRIMARY_BASE_URL', 'https://ordinary.example/v1');
    vi.stubEnv('LLM_ROUTER_FALLBACK_MODEL', 'openai:normal-fallback');
    vi.stubEnv('LLM_ROUTER_FALLBACK_BASE_URL', 'https://ordinary-fallback.example/v1');
    await expect(generate(createManimAiCall({ model: 'normal-primary' }))).resolves.toHaveProperty(
      'artifact',
    );
    expect((await callLLM({ model: 'normal-primary', prompt: 'test' }, 'ordinary')).text).toBe(
      'ordinary',
    );
  });

  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ])(
    'passes the verified llama.cpp flag with streaming=%s and thinking=%s',
    async (stream, enableThinking) => {
      const requests = configure(18896, (input, init) => {
        const url = String(input);
        if (url.endsWith('/ready')) return Response.json(verified);
        if (url.endsWith('/jobs')) return Response.json(output);
        const body = JSON.parse(String(init?.body));
        expect(body.model).toBe('gemma-local');
        expect(Boolean(body.stream)).toBe(stream);
        expect(body.chat_template_kwargs).toEqual({ enable_thinking: enableThinking });
        expect(body).not.toHaveProperty('reasoning_effort');
        return stream
          ? streamCompletion(submission(source), undefined, 0)
          : completion(submission(source));
      });
      localManim();
      vi.stubEnv('MANIM_MODEL_PRIMARY_LLAMA_CPP', 'true');
      vi.stubEnv('MANIM_MODEL_ENABLE_THINKING', String(enableThinking));
      vi.stubEnv('MANIM_MODEL_PRIMARY_DISABLE_REASONING', 'true');
      vi.stubEnv('MANIM_AGENT_STREAM', String(stream));
      await expect(generate(createManimAiCall({ model: 'unrelated' }))).resolves.toHaveProperty(
        'artifact',
      );
      expect(
        requests.mock.calls.filter(([url]) => String(url).endsWith('/chat/completions')),
      ).toHaveLength(1);
      expect(logs.info).toHaveBeenCalledWith(
        'Manim model turn',
        expect.objectContaining({
          reasoningTokens: 0,
          reasoningTokensAvailable: true,
          finishReason: 'stop',
        }),
      );
    },
  );

  it.each([64, null])(
    'classifies buffered reasoning exhaustion and reports only supplied token counts (%s)',
    async (reported) => {
      const requests = configure(18892, (input) =>
        String(input).endsWith('/ready')
          ? Response.json(verified)
          : completion(null, 'length', 'private reasoning fragment', reported, 64),
      );
      localManim();
      vi.stubEnv('MANIM_AGENT_COMPLETION_TOKENS', '64');
      vi.stubEnv('MANIM_AGENT_MODEL_CALLS', '1');
      await expect(generate(createManimAiCall({ model: 'unrelated' }))).rejects.toMatchObject({
        code: 'VISUALIZATION_MODEL_OUTPUT_LIMIT',
      });
      expect(requests.mock.calls.filter(([input]) => String(input).endsWith('/jobs'))).toHaveLength(
        0,
      );
      expect(logs.info).toHaveBeenCalledWith(
        'Manim model turn',
        expect.objectContaining({
          requestedCompletionTokens: 64,
          inputTokens: 440,
          outputTokens: 64,
          reasoningTokens: reported ?? undefined,
          reasoningTokensAvailable: reported !== null,
          finishReason: 'length',
        }),
      );
      expect(JSON.stringify(logs.info.mock.calls)).not.toContain('private reasoning fragment');
    },
  );

  it.each([12, undefined, 0])(
    'reports first-token latency and honest streaming reasoning counts (%s)',
    async (reported) => {
      configure(18893, (input) => {
        const url = String(input);
        if (url.endsWith('/ready')) return Response.json(verified);
        if (url.endsWith('/jobs')) return Response.json(output);
        return streamCompletion(submission(source), 'private streaming reasoning', reported);
      });
      localManim();
      vi.stubEnv('MANIM_AGENT_STREAM', 'true');
      await expect(generate(createManimAiCall({ model: 'unrelated' }))).resolves.toHaveProperty(
        'artifact',
      );
      expect(logs.info).toHaveBeenCalledWith(
        'Manim first token',
        expect.objectContaining({ ms: expect.any(Number) }),
      );
      expect(logs.info).toHaveBeenCalledWith(
        'Manim model turn',
        expect.objectContaining({
          firstTokenMs: expect.any(Number),
          reasoningTokens: reported || undefined,
          reasoningTokensAvailable: Boolean(reported),
          reasoningBytes: Buffer.byteLength('private streaming reasoning'),
          finishReason: 'stop',
        }),
      );
      expect(JSON.stringify(logs.info.mock.calls)).not.toContain('private streaming reasoning');
    },
  );

  it.each([true, false])(
    'tries one smaller completion recovery without reducing the output limit (recovers: %s)',
    async (recover) => {
      const requests = configure(18897, (input) =>
        String(input).endsWith('/ready') ? Response.json(verified) : Response.json(output),
      );
      const exhausted = {
        text: '',
        finishReason: 'length',
        reasoningText: 'private buffered reasoning',
        usage: { outputTokens: 3072, outputTokenDetails: { reasoningTokens: 0 } },
      };
      const ai = vi
        .fn<VisualizationAiCall>()
        .mockResolvedValueOnce(exhausted)
        .mockResolvedValueOnce(recover ? submission(source) : exhausted);
      const result = generate(ai, { requirement: 'Keep the central maximum and its units.' });
      if (recover) await expect(result).resolves.toHaveProperty('artifact');
      else await expect(result).rejects.toMatchObject({ code: 'VISUALIZATION_MODEL_OUTPUT_LIMIT' });
      expect(ai).toHaveBeenCalledTimes(2);
      const [initial, retry] = ai.mock.calls;
      expect(retry[0]).toContain('The previous completion ended before it produced a usable scene');
      expect(Buffer.byteLength(retry[0] + retry[1])).toBeLessThan(
        Buffer.byteLength(initial[0] + initial[1]),
      );
      expect(JSON.parse(retry[1]).task.requirements).toBe(
        'Keep the central maximum and its units.',
      );
      expect(retry[4]?.completionTokens).toBe(initial[4]?.completionTokens);
      expect(logs.info).toHaveBeenCalledWith(
        'Manim model turn',
        expect.objectContaining({
          call: 1,
          reasoningTokens: undefined,
          reasoningTokensAvailable: false,
          reasoningBytes: expect.any(Number),
        }),
      );
      expect(requests.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(
        recover ? 2 : 0,
      );
    },
  );

  it('allocates separate authoring and correction time and keeps preview and final time reserved', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.stubEnv('MANIM_AGENT_DEADLINE_SECONDS', '900');
    vi.stubEnv('MANIM_AGENT_AUTHORING_SECONDS', '480');
    vi.stubEnv('MANIM_AGENT_CORRECTION_SECONDS', '220');
    const started = Date.now();
    let firstPreview = true;
    configure(18894, (url) => {
      if (url.endsWith('/ready')) return Response.json(verified);
      if (firstPreview) {
        firstPreview = false;
        vi.setSystemTime(started + 530_000);
        return Response.json(optionError, { status: 422 });
      }
      return Response.json(output);
    });
    const ai = vi
      .fn<VisualizationAiCall>()
      .mockImplementationOnce(async (_system, _prompt, _signal, _tools, routing) => {
        expect(routing?.manimBudget?.deadlineMs).toBe(started + 480_000);
        vi.setSystemTime(started + 470_000);
        return submission(source);
      })
      .mockImplementationOnce(async (_system, _prompt, _signal, _tools, routing) => {
        expect(routing?.manimBudget?.deadlineMs).toBe(started + 650_000);
        vi.setSystemTime(started + 648_000);
        return submission(source + '# corrected');
      });
    await expect(generate(ai)).resolves.toHaveProperty('artifact');
    expect(manimRenderWindows(manimAgentBudget(), false)).toEqual({
      previewMs: 90_000,
      finalMs: 160_000,
    });
    expect(logs.info).toHaveBeenCalledWith(
      'Manim render submitted',
      expect.objectContaining({
        phase: 'final-render',
        renderBudgetMs: 160_000,
      }),
    );
  });

  it.each([
    ['VISUALIZATION_PYTHON_MISSING', () => Promise.resolve('No source.')],
    ['VISUALIZATION_RESPONSE_FORMAT', () => Promise.resolve('{"tool":"submit_scene","source":""}')],
    [
      'VISUALIZATION_MODEL_UNAVAILABLE',
      () => Promise.reject({ statusCode: 410, message: 'private provider error' }),
    ],
    ['VISUALIZATION_MODEL_TIMEOUT', () => Promise.reject({ statusCode: 504 })],
  ] as const)('reports %s before any render dispatch', async (code, reply) => {
    const fetch = configure(18889, () => Response.json(verified));
    await expect(generate(reply)).rejects.toMatchObject({ code });
    expect(fetch.mock.calls.every(([url]) => new URL(url).pathname === '/ready')).toBe(true);
    expect(JSON.stringify(logs.info.mock.calls)).not.toContain('private provider error');
  });

  it.each([
    [{ code: 'syntax' }, 'VISUALIZATION_PYTHON_VALIDATION', 'syntax'],
    [{ code: 'timeout' }, 'VISUALIZATION_RENDER_TIMEOUT', 'timeout'],
    [{ code: 'visual' }, 'VISUALIZATION_ARTIFACT_VALIDATION', 'visual'],
    [{ code: 'sandbox' }, 'VISUALIZATION_UNAVAILABLE', 'publisher_or_sandbox_unavailable'],
  ] as const)('classifies a publisher rejection with issue %j', async (issue, code, detail) => {
    configure(18890, (url) =>
      url.endsWith('/ready')
        ? Response.json(verified)
        : Response.json({
            status: 'failed',
            id: 'b'.repeat(64),
            issue: { ...issue, message: 'private worker message' },
          }),
    );
    await expect(generate(() => Promise.resolve(submission(source)))).rejects.toMatchObject({
      code,
      detail,
    });
    expect(logs.info).toHaveBeenCalledWith(
      'Manim render evaluated',
      expect.objectContaining({
        result: 'failed',
        phase: 'preview-render',
        failureCode: code,
        reason: detail,
      }),
    );
    expect(JSON.stringify(logs.info.mock.calls)).not.toContain('private worker message');
  });

  it('accepts native SDK tool dispatch for proven transports and the JSON equivalent elsewhere', async () => {
    vi.stubEnv('LLM_ROUTER_ENABLED', 'false');
    expect(supportsNativeManimTools('openai', 'openai:gpt-4o')).toBe(true);
    expect(supportsNativeManimTools('openai', 'openai:gpt-4o', 'http://localhost/v1')).toBe(false);
    vi.stubEnv('LLM_ROUTER_ENABLED', 'true');
    expect(supportsNativeManimTools('openai', 'openai:gpt-4o')).toBe(false);
    configure(18884, (url) => Response.json(url.endsWith('/ready') ? verified : output));
    const ai = vi.fn<VisualizationAiCall>().mockResolvedValue({
      text: '',
      toolCalls: [{ toolName: 'submit_scene', input: { source, segments } }],
    });
    await expect(generate(ai, { nativeTools: true })).resolves.toHaveProperty('artifact');
    expect(ai.mock.calls[0][3]).toHaveProperty('submit_scene');
  });
});

describe('versioned documentation', () => {
  it('caches exact version snippets and gives Context7 no private context', async () => {
    vi.stubEnv('CONTEXT7_API_KEY', 'test-context-key');
    const fetch = vi.fn(async () =>
      Response.json({
        infoSnippets: [
          {
            pageId: 'https://github.com/manimcommunity/manim/blob/v0.22.1/docs/axes.rst',
            content: 'Pinned reference',
          },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetch);
    const signal = new AbortController().signal;
    await expect(findManimDocumentation('plotting', signal)).resolves.toMatchObject({
      cached: false,
    });
    await expect(findManimDocumentation('plotting', signal)).resolves.toMatchObject({
      cached: true,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    const url = new URL((fetch.mock.calls as unknown as [URL][])[0][0]);
    expect(url.searchParams.get('libraryId')).toBe('/manimcommunity/manim/v0.22.1');
    expect(url.searchParams.get('query')).not.toContain(outline.title);
  });

  it('falls back for unversioned, mismatched, oversized, or unavailable documentation', async () => {
    vi.stubEnv('CONTEXT7_API_KEY', 'test-context-key');
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('From https://github.com/manimcommunity/manim/blob/main/a'),
      )
      .mockResolvedValueOnce(
        new Response('From https://github.com/manimcommunity/manim/blob/v0.19.0/a'),
      )
      .mockResolvedValueOnce(new Response('a'.repeat(70_000)))
      .mockRejectedValueOnce(new TypeError('offline'));
    vi.stubGlobal('fetch', fetch);
    for (const topic of ['layout', 'camera', 'timing', 'rendering'] as const) {
      await expect(
        findManimDocumentation(topic, new AbortController().signal),
      ).resolves.toBeUndefined();
      await expect(readManimReference(topic)).resolves.toContain('#');
    }
  });
});
