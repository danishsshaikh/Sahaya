import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callLLM, streamLLM } from '@/lib/ai/llm';
import { createLLMRouter } from '@/lib/server/llm-router';

vi.mock('@/lib/server/usage-storage', () => ({ recordUsage: vi.fn() }));
vi.mock('@/lib/logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn() }) }));

beforeEach(() => {
  vi.stubEnv('LLM_ROUTER_ENABLED', 'true');
  vi.stubEnv('LLM_ROUTER_PRIMARY_MODEL', 'openai:nvidia/nemotron-test');
  vi.stubEnv('LLM_ROUTER_PRIMARY_BASE_URL', 'https://primary.example/v1');
  vi.stubEnv('LLM_ROUTER_PRIMARY_API_KEY', 'test-primary-key');
  vi.stubEnv('LLM_ROUTER_FALLBACK_MODEL', 'openai:gemma-test');
  vi.stubEnv('LLM_ROUTER_FALLBACK_BASE_URL', 'http://fallback.example/v1');
  vi.stubEnv('LLM_ROUTER_FALLBACK_API_KEY', '');
  delete (globalThis as { __sahayaLlmCircuit?: unknown }).__sahayaLlmCircuit;
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
  it('uses Chat Completions, isolated credentials, no redirects or automatic thinking, and no key for keyless Gemma', async () => {
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
    for (const request of requests) {
      expect(request.init.redirect).toBe('error');
      expect(request.body).not.toHaveProperty('thinking');
      expect(request.body).not.toHaveProperty('reasoning_effort');
      expect(request.body).not.toHaveProperty('chat_template_kwargs');
    }
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
