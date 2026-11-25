import { afterEach, describe, expect, it, vi } from 'vitest';
import { callLLM } from '@/lib/ai/llm';
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
      return Response.json({
        id: 'chat-gemma',
        object: 'chat.completion',
        created: 1,
        model: 'gemma-local',
        choices: [
          {
            index: 0,
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: submission(
                gemmaCalls === 1 ? source.replace('Circle()', 'missing()') : source,
              ),
            },
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 120, total_tokens: 220 },
      });
    });
    const env = {
      LLM_ROUTER_ENABLED: 'true',
      LLM_ROUTER_PRIMARY_MODEL: 'openai:nvidia/nemotron-3-ultra-550b-a55b',
      LLM_ROUTER_PRIMARY_BASE_URL: 'https://ultra.example/v1',
      LLM_ROUTER_PRIMARY_API_KEY: 'private-ultra-test-key',
      LLM_ROUTER_PRIMARY_TIMEOUT_MS: '90000',
      LLM_ROUTER_SECONDARY_MODEL: 'openai:nvidia/nemotron-3-super-120b-a12b',
      LLM_ROUTER_SECONDARY_BASE_URL: 'https://super.example/v1',
      LLM_ROUTER_SECONDARY_API_KEY: 'private-super-test-key',
      LLM_ROUTER_SECONDARY_TIMEOUT_MS: '60000',
      LLM_ROUTER_FALLBACK_MODEL: 'openai:gemma-local',
      LLM_ROUTER_FALLBACK_BASE_URL: 'http://gemma.example/v1',
      LLM_ROUTER_FALLBACK_API_KEY: '',
      LLM_ROUTER_FALLBACK_LOCAL: 'true',
      LLM_ROUTER_TOTAL_TIMEOUT_MS: '180000',
      MANIM_AGENT_DEADLINE_SECONDS: '260',
    };
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);

    const ai: VisualizationAiCall = (system, prompt, abortSignal, tools, routing) =>
      callLLM(
        { model: 'gpt-4o', system, prompt, abortSignal, tools, maxRetries: 0 },
        'manim-production-test',
        undefined,
        undefined,
        routing,
      );
    const checked = expect(generate(ai)).resolves.toHaveProperty('artifact');
    await primaryStarted.promise;
    await vi.advanceTimersByTimeAsync(89_999);
    expect(models).toEqual(['nvidia/nemotron-3-ultra-550b-a55b']);
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
        remainingExecutionMs: 170000,
        call: 1,
      }),
    );
    expect(JSON.stringify(logs.info.mock.calls)).not.toMatch(
      /provider-private-body|private-(ultra|super)-test-key/,
    );
  });

  it.each([
    ['VISUALIZATION_PYTHON_MISSING', () => Promise.resolve('No source.')],
    [
      'VISUALIZATION_PYTHON_VALIDATION',
      () => Promise.resolve('{"tool":"submit_scene","source":""}'),
    ],
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
