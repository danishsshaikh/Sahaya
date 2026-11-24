import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateVisualization, type VisualizationAiCall } from '@/lib/visualization/generate';
import {
  discoverManimSkill,
  readManimReference,
  relevantReferences,
} from '@/lib/visualization/skill';
import { findManimDocumentation } from '@/lib/visualization/documentation';
import { supportsNativeManimTools } from '@/lib/visualization/agent-tools';
import type { SceneOutline } from '@/lib/types/generation';

const outline: SceneOutline = {
  id: 'viz',
  order: 2,
  type: 'visualization',
  title: 'Private diffraction lecture',
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
  const fetch = vi.fn(reply);
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

function generate(aiCall: VisualizationAiCall, extra = {}) {
  return generateVisualization({
    outline,
    allOutlines: [outline],
    ownerId: 'owner',
    aiCall,
    ...extra,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('native Manim agent', () => {
  it('discovers the builtin skill and reads only relevant references', async () => {
    const skill = await discoverManimSkill();
    expect(skill).toMatchObject({ name: 'sahaya-manim', version: '1.0.0' });
    expect(skill.activate()).toContain('CueScene');
    expect(relevantReferences('plot on spatial axes')).toEqual(['layout', 'plotting', 'camera']);
    await expect(readManimReference('timing')).resolves.toContain('Cairo');
  });

  it('corrects native Python after preview feedback and publishes only the checked replacement', async () => {
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
      .mockResolvedValueOnce(submission(source.replace('Circle()', 'missing()')))
      .mockResolvedValueOnce(submission(source));
    await expect(
      generate(ai, { onProgress: (phase: string) => phases.push(phase) }),
    ).resolves.toMatchObject({ type: 'visualization', artifact: output.artifact });
    expect(submitted.map(({ quality, publication }) => [quality, publication])).toEqual([
      ['preview', 'none'],
      ['preview', 'none'],
      ['standard', 'saved'],
    ]);
    expect(ai.mock.calls[1][1]).toContain('Check the named Manim method');
    expect(ai.mock.calls[1][1]).toContain('builtinReferences');
    expect(phases).toContain('code-repair');
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
    await expect(generate(ai)).rejects.toMatchObject({ code: 'VISUALIZATION_REPAIR' });
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
    await expect(generate(ai)).rejects.toMatchObject({ code: 'VISUALIZATION_REPAIR' });
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

  it('enforces the configured agent deadline during a provider call', async () => {
    configure(18885, () => Response.json(verified));
    vi.stubEnv('MANIM_AGENT_DEADLINE_SECONDS', '1');
    const ai = vi.fn<VisualizationAiCall>(
      (_system, _user, signal) =>
        new Promise((_, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    );
    await expect(generate(ai)).rejects.toMatchObject({ code: 'VISUALIZATION_RENDER_TIMEOUT' });
    expect(ai).toHaveBeenCalledTimes(1);
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
