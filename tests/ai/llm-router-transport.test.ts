import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tool } from 'ai';
import { z } from 'zod';
import { callLLM, streamLLM } from '@/lib/ai/llm';
import { createLLMRouter } from '@/lib/server/llm-router';

vi.mock('@/lib/server/usage-storage', () => ({ recordUsage: vi.fn() }));
vi.mock('@/lib/logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn() }) }));

beforeEach(() => {
  vi.stubEnv('LLM_ROUTER_ENABLED', 'true');
  vi.stubEnv('LLM_ROUTER_PRIMARY_MODEL', 'openai:nvidia/nemotron-test');
  vi.stubEnv('LLM_ROUTER_PRIMARY_BASE_URL', 'https://primary.example/v1');
  vi.stubEnv('LLM_ROUTER_PRIMARY_API_KEY', 'test-primary-key');
  vi.stubEnv('LLM_ROUTER_SECONDARY_MODEL', '');
  vi.stubEnv('LLM_ROUTER_SECONDARY_BASE_URL', undefined);
  vi.stubEnv('LLM_ROUTER_SECONDARY_API_KEY', undefined);
  vi.stubEnv('LLM_ROUTER_FALLBACK_MODEL', 'openai:gemma-test');
  vi.stubEnv('LLM_ROUTER_FALLBACK_BASE_URL', 'http://fallback.example/v1');
  vi.stubEnv('LLM_ROUTER_FALLBACK_API_KEY', '');
  delete (globalThis as { __sahayaLlmCircuits?: unknown }).__sahayaLlmCircuits;
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function completion(content: string) {
  return new Response(
    JSON.stringify({
      id: 'chat-test',
      object: 'chat.completion',
      created: 1,
      model: 'gemma-test',
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
    }),
    { headers: { 'content-type': 'application/json' } },
  );
}

describe('routed OpenAI-compatible transport (mock HTTP only)', () => {
  it.each([false, true])(
    'adapts Ultra -> Super -> Gemma without leaking options (Super fails: %s)',
    async (superFails) => {
      vi.stubEnv('LLM_ROUTER_PRIMARY_MODEL', 'openai:nvidia/nemotron-3-ultra-550b-a55b');
      vi.stubEnv('LLM_ROUTER_SECONDARY_MODEL', 'openai:nvidia/nemotron-3-super-120b-a12b');
      const requests: { url: string; init: RequestInit; body: Record<string, unknown> }[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init: RequestInit) => {
          const body = JSON.parse(String(init.body));
          requests.push({ url: String(input), init, body });
          if (
            body.model === 'nvidia/nemotron-3-ultra-550b-a55b' ||
            (superFails && body.model === 'nvidia/nemotron-3-super-120b-a12b')
          ) {
            return new Response(
              JSON.stringify({ error: { message: 'unavailable', type: 'server_error' } }),
              {
                status: 503,
                headers: { 'content-type': 'application/json' },
              },
            );
          }
          return completion('ok');
        }),
      );
      expect(
        (await callLLM({ model: createLLMRouter('fixture')!.model, prompt: 'hi' }, 'test')).text,
      ).toBe('ok');
      expect(requests).toHaveLength(superFails ? 3 : 2);
      for (const request of requests.slice(0, 2)) {
        expect(request.url).toBe('https://primary.example/v1/chat/completions');
        expect(new Headers(request.init.headers).get('authorization')).toBe(
          'Bearer test-primary-key',
        );
        expect(request.body).toMatchObject({ chat_template_kwargs: { enable_thinking: false } });
        expect(request.body).not.toHaveProperty('reasoning_effort');
      }
      if (superFails) {
        expect(requests[2].body).not.toHaveProperty('chat_template_kwargs');
        expect(requests[2].body).not.toHaveProperty('reasoning_effort');
        expect(new Headers(requests[2].init.headers).has('authorization')).toBe(false);
      }
    },
  );

  it('uses Chat Completions, isolated credentials, no redirects, Nemotron structured thinking off, and no key for keyless Gemma', async () => {
    const requests: { url: string; init: RequestInit; body: Record<string, unknown> }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init: RequestInit) => {
        requests.push({ url: String(input), init, body: JSON.parse(String(init.body)) });
        if (String(input).includes('primary.example')) {
          return new Response(
            JSON.stringify({ error: { message: 'unavailable', type: 'server_error' } }),
            {
              status: 503,
              headers: { 'content-type': 'application/json' },
            },
          );
        }
        return completion('<think>private reasoning</think>{"html":"<p>Lesson</p>"}');
      }),
    );
    const model = createLLMRouter('fixture')!.model;
    const output = await callLLM({ model, prompt: 'hi' }, 'transport-test');
    expect(JSON.parse(output.text)).toEqual({ html: '<p>Lesson</p>' });
    expect(output.reasoningText).toContain('private reasoning');
    expect(requests.map((r) => r.url)).toEqual([
      'https://primary.example/v1/chat/completions',
      'http://fallback.example/v1/chat/completions',
    ]);
    expect(new Headers(requests[0].init.headers).get('authorization')).toBe(
      'Bearer test-primary-key',
    );
    expect(new Headers(requests[1].init.headers).has('authorization')).toBe(false);
    expect(requests[0].init.redirect).toBe('error');
    expect(requests[0].body).toMatchObject({
      chat_template_kwargs: { enable_thinking: false },
    });
    expect(requests[0].body).not.toHaveProperty('thinking');
    expect(requests[0].body).not.toHaveProperty('reasoning_effort');
    expect(requests[1].init.redirect).toBe('error');
    expect(requests[1].body).not.toHaveProperty('thinking');
    expect(requests[1].body).not.toHaveProperty('reasoning_effort');
    expect(requests[1].body).not.toHaveProperty('chat_template_kwargs');
  });
  it.each(['openai:gpt-compatible-test', 'openai:nvidia/llama-test'])(
    'does not inject Nemotron chat-template fields for %s',
    async (model) => {
      vi.stubEnv('LLM_ROUTER_PRIMARY_MODEL', model);
      const requests: { body: Record<string, unknown> }[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_input: RequestInfo | URL, init: RequestInit) => {
          requests.push({ body: JSON.parse(String(init.body)) });
          return completion('{"html":"<p>Lesson</p>"}');
        }),
      );
      const output = await callLLM(
        { model: createLLMRouter('fixture')!.model, prompt: 'hi' },
        'transport-test',
      );
      expect(JSON.parse(output.text)).toEqual({ html: '<p>Lesson</p>' });
      expect(requests[0].body).not.toHaveProperty('chat_template_kwargs');
    },
  );
  it('preserves tool-bearing Nemotron request semantics without forcing structured thinking mode', async () => {
    const requests: { body: Record<string, unknown> }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init: RequestInit) => {
        requests.push({ body: JSON.parse(String(init.body)) });
        return completion('tool-safe answer');
      }),
    );
    const output = await callLLM(
      {
        model: createLLMRouter('fixture')!.model,
        prompt: 'hi',
        tools: { inspect: tool({ inputSchema: z.object({ topic: z.string() }) }) },
        toolChoice: 'auto',
      },
      'transport-test',
    );
    expect(output.text).toBe('tool-safe answer');
    expect(requests[0].body.tools).toBeTruthy();
    expect(requests[0].body).not.toHaveProperty('chat_template_kwargs');
  });
  it('preserves separate reasoning and answer streams with actual SDK parsing', async () => {
    const chunks = [{ reasoning_content: 'check evidence' }, { content: '{"answer":42}' }].map(
      (delta) => ({
        id: 's',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'nemotron-test',
        choices: [{ index: 0, delta, finish_reason: null }],
      }),
    );
    const ending = {
      id: 's',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'nemotron-test',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            [...chunks, ending].map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') +
              'data: [DONE]\n\n',
            { headers: { 'content-type': 'text/event-stream' } },
          ),
      ),
    );
    const output = streamLLM(
      { model: createLLMRouter('fixture')!.model, prompt: 'hi' },
      'transport-test',
    );
    expect(JSON.parse(await output.text)).toEqual({ answer: 42 });
    expect(await output.reasoningText).toContain('check evidence');
    expect(await output.finishReason).toBe('stop');
    expect((await output.totalUsage).totalTokens).toBe(5);
  });
});
