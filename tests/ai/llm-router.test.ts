import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stepCountIs, tool, type LanguageModel, type TextStreamPart, type ToolSet } from 'ai';
import { z } from 'zod';
import { callLLM, streamLLM } from '@/lib/ai/llm';
import { classifyRouterError, createLLMRouter } from '@/lib/server/llm-router';
import { getModel } from '@/lib/ai/providers';

vi.mock('@/lib/ai/providers', async (original) => ({
  ...(await original<typeof import('@/lib/ai/providers')>()),
  getModel: vi.fn(),
}));
const capture = vi.hoisted(() => ({ usage: vi.fn(), log: vi.fn() }));
vi.mock('@/lib/server/usage-storage', () => ({ recordUsage: capture.usage }));
vi.mock('@/lib/logger', () => ({ createLogger: () => ({ info: capture.log, warn: capture.log }) }));

type Model = Extract<LanguageModel, { specificationVersion: 'v3' }>;
type Generation = Awaited<ReturnType<Model['doGenerate']>>;
type Stream = Awaited<ReturnType<Model['doStream']>>;
type Part = Stream['stream'] extends ReadableStream<infer T> ? T : never;
const usage = {
  inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 2, text: 2, reasoning: 0 },
};
const finish: Part = { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage };
const options = {
  prompt: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }],
};
const result = (text: string): Generation => ({
  content: [{ type: 'text', text }],
  usage,
  warnings: [],
  finishReason: { unified: 'stop', raw: 'stop' },
});
function partsStream(parts: Part[], hang = false): Stream {
  const queue = [...parts];
  return {
    stream: new ReadableStream<Part>({
      pull(controller) {
        const part = queue.shift();
        if (part) controller.enqueue(part);
        else if (!hang) controller.close();
      },
    }),
  };
}
function textParts(text: string): Part[] {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't' },
    { type: 'text-delta', id: 't', delta: text },
    { type: 'text-end', id: 't' },
    finish,
  ];
}
function fake(modelId: string) {
  return {
    specificationVersion: 'v3' as const,
    provider: 'fake.chat',
    modelId,
    supportedUrls: {},
    doGenerate: vi.fn<Model['doGenerate']>(async () => result(modelId)),
    doStream: vi.fn<Model['doStream']>(async () => partsStream(textParts(modelId))),
  };
}
let primary = fake('nemotron');
let secondary = fake('super');
let fallback = fake('gemma');
let original = fake('original');
const request = () =>
  callLLM({ model: original, prompt: 'private faculty content' }, 'router-test');
const httpError = (statusCode: number) =>
  Object.assign(new Error('SECRET response body'), { statusCode });
const networkError = () =>
  Object.assign(new Error('SECRET transport detail'), { code: 'ECONNREFUSED' });
const logs = () => capture.log.mock.calls.map(([value]) => value);

beforeEach(() => {
  vi.stubEnv('LLM_ROUTER_ENABLED', 'true');
  vi.stubEnv('LLM_ROUTER_PRIMARY_MODEL', 'nvidia:nemotron');
  vi.stubEnv('LLM_ROUTER_PRIMARY_BASE_URL', 'https://primary.example/v1');
  vi.stubEnv('LLM_ROUTER_PRIMARY_API_KEY', 'SECRET-primary-key');
  vi.stubEnv('LLM_ROUTER_PRIMARY_LOCAL', 'false');
  vi.stubEnv('LLM_ROUTER_SECONDARY_MODEL', '');
  vi.stubEnv('LLM_ROUTER_SECONDARY_BASE_URL', undefined);
  vi.stubEnv('LLM_ROUTER_SECONDARY_API_KEY', undefined);
  vi.stubEnv('LLM_ROUTER_SECONDARY_LOCAL', 'false');
  vi.stubEnv('LLM_ROUTER_SECONDARY_TIMEOUT_MS', '');
  vi.stubEnv('LLM_ROUTER_PRIMARY_TIMEOUT_MS', '');
  vi.stubEnv('LLM_ROUTER_FALLBACK_TIMEOUT_MS', '');
  vi.stubEnv('LLM_ROUTER_FALLBACK_MODEL', 'local:gemma');
  vi.stubEnv('LLM_ROUTER_FALLBACK_BASE_URL', 'http://fallback.example/v1');
  vi.stubEnv('LLM_ROUTER_FALLBACK_API_KEY', 'SECRET-fallback-key');
  vi.stubEnv('LLM_ROUTER_FALLBACK_LOCAL', 'true');
  vi.stubEnv('LLM_ROUTER_INITIAL_TIMEOUT_MS', '1000');
  vi.stubEnv('LLM_ROUTER_STREAM_INITIAL_CHUNK_TIMEOUT_MS', '500');
  vi.stubEnv('LLM_ROUTER_TOTAL_TIMEOUT_MS', '5000');
  vi.stubEnv('LLM_ROUTER_CIRCUIT_FAILURE_THRESHOLD', '2');
  vi.stubEnv('LLM_ROUTER_CIRCUIT_COOLDOWN_MS', '100');
  delete (globalThis as { __sahayaLlmCircuits?: unknown }).__sahayaLlmCircuits;
  primary = fake('nemotron');
  secondary = fake('super');
  fallback = fake('gemma');
  original = fake('original');
  capture.log.mockClear();
  capture.usage.mockClear();
  vi.mocked(getModel)
    .mockReset()
    .mockImplementation(({ modelId }) => ({
      model: modelId === 'nemotron' ? primary : modelId === 'super' ? secondary : fallback,
      modelInfo: null,
    }));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('central routed generation', () => {
  it('uses primary once and attributes its real model and aggregate usage', async () => {
    expect((await request()).text).toBe('nemotron');
    expect(primary.doGenerate).toHaveBeenCalledTimes(1);
    expect(fallback.doGenerate).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(capture.usage).toHaveBeenCalledWith(
        expect.objectContaining({
          providerId: 'nvidia',
          modelId: 'nemotron',
          usage: expect.objectContaining({ inputTokens: 3, outputTokens: 2 }),
        }),
      ),
    );
  });
  it.each([408, 429, 500, 502, 503, 504])(
    'falls back once for HTTP %i and records health',
    async (status) => {
      primary.doGenerate.mockRejectedValue(httpError(status));
      expect((await request()).text).toBe('gemma');
      expect(primary.doGenerate).toHaveBeenCalledTimes(1);
      expect(fallback.doGenerate).toHaveBeenCalledTimes(1);
      await request();
      await request();
      expect(primary.doGenerate).toHaveBeenCalledTimes(2);
      expect(logs()).toContainEqual(
        expect.objectContaining({ fallbackReason: 'circuit_open', circuitState: 'OPEN' }),
      );
    },
  );
  it('uses fallback after network failure and attributes fallback usage', async () => {
    primary.doGenerate.mockRejectedValue(networkError());
    expect((await request()).text).toBe('gemma');
    await vi.waitFor(() =>
      expect(capture.usage).toHaveBeenCalledWith(
        expect.objectContaining({
          providerId: 'local',
          modelId: 'gemma',
          modelString: 'local:gemma',
        }),
      ),
    );
  });
  it.each([400, 401, 403, 404, 422])(
    'does not fall back or open the circuit on HTTP %i',
    async (status) => {
      primary.doGenerate.mockRejectedValue(httpError(status));
      for (let i = 0; i < 3; i++)
        await expect(request()).rejects.toMatchObject({ statusCode: status });
      expect(primary.doGenerate).toHaveBeenCalledTimes(3);
      expect(fallback.doGenerate).not.toHaveBeenCalled();
      expect(logs().every((entry) => entry.circuitState === 'CLOSED')).toBe(true);
    },
  );
  it('does not fall back for unclassified defects or retry transport failures through validation retries', async () => {
    primary.doGenerate.mockRejectedValue(new Error('invalid application request'));
    await expect(
      callLLM({ model: original, prompt: 'hi' }, 'test', { retries: 3 }),
    ).rejects.toThrow('unknown');
    expect(primary.doGenerate).toHaveBeenCalledTimes(1);
    expect(fallback.doGenerate).not.toHaveBeenCalled();
  });
  it('preserves JSON containing HTML and tool request options', async () => {
    primary.doGenerate.mockRejectedValue(networkError());
    fallback.doGenerate.mockResolvedValue(result('{"html":"<p>Lesson</p>","actions":[]}'));
    const tools = { inspect: tool({ inputSchema: z.object({ topic: z.string() }) }) };
    const output = await callLLM(
      { model: original, prompt: 'hi', tools, toolChoice: 'auto' },
      'test',
    );
    expect(JSON.parse(output.text)).toEqual({ html: '<p>Lesson</p>', actions: [] });
    expect(fallback.doGenerate.mock.calls[0][0]).toMatchObject({
      tools: [expect.objectContaining({ name: 'inspect', type: 'function' })],
      toolChoice: { type: 'auto' },
    });
  });
  it('executes tools once, stays on fallback for later steps, and aggregates usage', async () => {
    primary.doGenerate.mockRejectedValue(networkError());
    fallback.doGenerate.mockResolvedValueOnce({
      ...result(''),
      content: [{ type: 'tool-call', toolCallId: 'call1', toolName: 'inspect', input: '{}' }],
      finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
    });
    const execute = vi.fn(async () => 'data');
    const output = await callLLM(
      {
        model: original,
        prompt: 'hi',
        tools: { inspect: tool({ inputSchema: z.object({}), execute }) },
        stopWhen: stepCountIs(2),
      },
      'test',
    );
    expect(output.text).toBe('gemma');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(primary.doGenerate).toHaveBeenCalledTimes(1);
    expect(fallback.doGenerate).toHaveBeenCalledTimes(2);
    await vi.waitFor(() =>
      expect(capture.usage).toHaveBeenCalledWith(
        expect.objectContaining({
          modelId: 'gemma',
          usage: expect.objectContaining({ inputTokens: 6, outputTokens: 4 }),
        }),
      ),
    );
  });
  it('never replays primary tool execution on a later failed step', async () => {
    primary.doGenerate
      .mockResolvedValueOnce({
        ...result(''),
        content: [{ type: 'tool-call', toolCallId: 'call1', toolName: 'inspect', input: '{}' }],
        finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
      })
      .mockRejectedValue(networkError());
    const execute = vi.fn(async () => 'data');
    await expect(
      callLLM(
        {
          model: original,
          prompt: 'hi',
          tools: { inspect: tool({ inputSchema: z.object({}), execute }) },
          stopWhen: stepCountIs(2),
        },
        'test',
      ),
    ).rejects.toThrow();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(fallback.doGenerate).not.toHaveBeenCalled();
  });
  it('preserves classified causes without secrets when both providers fail', async () => {
    primary.doGenerate.mockRejectedValue(httpError(429));
    fallback.doGenerate.mockRejectedValue(networkError());
    const error = await request().catch((e: unknown) => e);
    expect(error).toMatchObject({
      cause: { primary: { reason: 'http_429' }, selected: { reason: 'network' } },
    });
    const serialized = JSON.stringify({ error, logs: logs(), router: createLLMRouter('test') });
    expect(serialized).not.toMatch(
      /SECRET|private faculty content|primary\.example|fallback\.example/,
    );
  });
  it.each(['false', ''])('keeps disabled routing unchanged (%s)', async (flag) => {
    vi.stubEnv('LLM_ROUTER_ENABLED', flag);
    vi.stubEnv('LLM_ROUTER_PRIMARY_BASE_URL', '');
    expect((await request()).text).toBe('original');
    const stream = streamLLM({ model: original, prompt: 'hi' }, 'test');
    expect(await stream.text).toBe('original');
    expect(getModel).not.toHaveBeenCalled();
    expect(primary.doGenerate).not.toHaveBeenCalled();
    expect(logs()).toEqual([]);
  });
  it('routes local-only without building or calling the external provider', async () => {
    const output = await callLLM({ model: original, prompt: 'hi' }, 'test', undefined, undefined, {
      externalAllowed: false,
    });
    expect(output.text).toBe('gemma');
    expect(getModel).toHaveBeenCalledTimes(1);
    expect(primary.doGenerate).not.toHaveBeenCalled();
  });
  it('fails closed without attested local endpoints or with routing disabled', async () => {
    vi.stubEnv('LLM_ROUTER_FALLBACK_LOCAL', 'false');
    await expect(
      callLLM({ model: original, prompt: 'hi' }, 'test', undefined, undefined, {
        externalAllowed: false,
      }),
    ).rejects.toThrow('local endpoint');
    vi.stubEnv('LLM_ROUTER_ENABLED', 'false');
    await expect(
      callLLM({ model: original, prompt: 'hi' }, 'test', undefined, undefined, {
        externalAllowed: false,
      }),
    ).rejects.toThrow('requires');
    expect(getModel).not.toHaveBeenCalled();
  });
  it('allows endpoint order to be reversed with config alone', async () => {
    vi.stubEnv('LLM_ROUTER_PRIMARY_MODEL', 'local:gemma');
    vi.stubEnv('LLM_ROUTER_FALLBACK_MODEL', 'nvidia:nemotron');
    expect((await request()).text).toBe('gemma');
    expect(primary.doGenerate).not.toHaveBeenCalled();
  });
});

describe('deadlines and cancellation', () => {
  beforeEach(() => vi.useFakeTimers());
  it('does not confuse a caller timeout signal with a router timeout', async () => {
    primary.doGenerate.mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const reason = new DOMException('Caller deadline', 'TimeoutError');
    const pending = callLLM(
      { model: original, prompt: 'hi', abortSignal: controller.signal },
      'test',
    ).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort(reason);
    expect(await pending).toBe(reason);
    expect(fallback.doGenerate).not.toHaveBeenCalled();
    expect(logs().at(-1)).toMatchObject({ status: 'caller_abort', circuitState: 'CLOSED' });
  });
  it('counts an SDK total deadline as provider timeout and does not start fallback after exhaustion', async () => {
    vi.stubEnv('LLM_ROUTER_TOTAL_TIMEOUT_MS', '100');
    vi.stubEnv('LLM_ROUTER_CIRCUIT_FAILURE_THRESHOLD', '1');
    primary.doGenerate.mockImplementation(() => new Promise(() => {}));
    const pending = request().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(101);
    expect(await pending).toMatchObject({ cause: { selected: { reason: 'timeout' } } });
    expect(fallback.doGenerate).not.toHaveBeenCalled();
    expect(logs().at(-1)).toMatchObject({ status: 'timeout', circuitState: 'OPEN' });
  });
  it('preserves cancellation during fallback', async () => {
    primary.doGenerate.mockRejectedValue(networkError());
    fallback.doGenerate.mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const reason = new DOMException('Cancelled', 'AbortError');
    const pending = callLLM(
      { model: original, prompt: 'hi', abortSignal: controller.signal },
      'test',
    ).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort(reason);
    expect(await pending).toBe(reason);
    expect(primary.doGenerate).toHaveBeenCalledTimes(1);
    expect(fallback.doGenerate).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('falls back on primary timeout, aborts the transport, and clears timers/listeners', async () => {
    primary.doGenerate.mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const remove = vi.spyOn(AbortSignal.prototype, 'removeEventListener');
    const pending = callLLM(
      { model: original, prompt: 'hi', abortSignal: controller.signal },
      'test',
    );
    await vi.advanceTimersByTimeAsync(1001);
    expect((await pending).text).toBe('gemma');
    expect(primary.doGenerate.mock.calls[0][0].abortSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(remove).toHaveBeenCalled();
  });
  it('lets primary and fallback use independently configured attempt budgets', async () => {
    vi.stubEnv('LLM_ROUTER_PRIMARY_TIMEOUT_MS', '100');
    vi.stubEnv('LLM_ROUTER_FALLBACK_TIMEOUT_MS', '800');
    vi.stubEnv('LLM_ROUTER_TOTAL_TIMEOUT_MS', '1000');
    primary.doGenerate.mockImplementation(() => new Promise(() => {}));
    fallback.doGenerate.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(result('slow-gemma')), 300)),
    );
    const pending = request();
    await vi.advanceTimersByTimeAsync(101);
    expect(primary.doGenerate.mock.calls[0][0].abortSignal?.aborted).toBe(true);
    expect(fallback.doGenerate).toHaveBeenCalledTimes(1);
    expect(fallback.doGenerate.mock.calls[0][0].abortSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(300);
    expect((await pending).text).toBe('slow-gemma');
    expect(logs()).toContainEqual(
      expect.objectContaining({
        selectedRole: 'primary',
        status: 'timeout',
        timeoutBudgetMs: 100,
      }),
    );
    expect(logs()).toContainEqual(
      expect.objectContaining({
        selectedRole: 'fallback',
        status: 'success',
        timeoutBudgetMs: 800,
      }),
    );
  });
  it('keeps legacy INITIAL_TIMEOUT_MS behavior when role-specific budgets are unset', async () => {
    primary.doGenerate.mockImplementation(() => new Promise(() => {}));
    fallback.doGenerate.mockImplementation(() => new Promise(() => {}));
    const pending = request().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1001);
    expect(primary.doGenerate.mock.calls[0][0].abortSignal?.aborted).toBe(true);
    expect(fallback.doGenerate).toHaveBeenCalledTimes(1);
    expect(fallback.doGenerate.mock.calls[0][0].abortSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toMatchObject({ cause: { selected: { reason: 'timeout' } } });
    expect(logs()).toContainEqual(
      expect.objectContaining({
        selectedRole: 'fallback',
        status: 'timeout',
        timeoutBudgetMs: 1000,
      }),
    );
  });
  it('caps a longer fallback attempt by the remaining shared total budget', async () => {
    vi.stubEnv('LLM_ROUTER_PRIMARY_TIMEOUT_MS', '500');
    vi.stubEnv('LLM_ROUTER_FALLBACK_TIMEOUT_MS', '5000');
    vi.stubEnv('LLM_ROUTER_TOTAL_TIMEOUT_MS', '1200');
    primary.doGenerate.mockImplementation(() => new Promise(() => {}));
    fallback.doGenerate.mockImplementation(() => new Promise(() => {}));
    const pending = request().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(501);
    expect(fallback.doGenerate).toHaveBeenCalledTimes(1);
    expect(fallback.doGenerate.mock.calls[0][0].abortSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(700);
    expect(await pending).toMatchObject({ cause: { selected: { reason: 'timeout' } } });
    expect(fallback.doGenerate.mock.calls[0][0].abortSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('bounds both providers by one total budget', async () => {
    vi.stubEnv('LLM_ROUTER_TOTAL_TIMEOUT_MS', '1500');
    primary.doGenerate.mockImplementation(() => new Promise(() => {}));
    fallback.doGenerate.mockImplementation(() => new Promise(() => {}));
    const pending = request().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1501);
    expect(await pending).toBeInstanceOf(Error);
    expect(fallback.doGenerate).toHaveBeenCalledTimes(1);
    expect(fallback.doGenerate.mock.calls[0][0].abortSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('preserves caller abort identity without fallback', async () => {
    primary.doGenerate.mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const reason = new DOMException('Cancelled', 'AbortError');
    const pending = callLLM(
      { model: original, prompt: 'hi', abortSignal: controller.signal },
      'test',
    ).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort(reason);
    expect(await pending).toBe(reason);
    expect(fallback.doGenerate).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('does not start any provider if already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      callLLM({ model: original, prompt: 'hi', abortSignal: controller.signal }, 'test'),
    ).rejects.toThrow();
    expect(getModel).not.toHaveBeenCalled();
  });
  it('falls back on a stalled initial stream', async () => {
    primary.doStream.mockResolvedValue(partsStream([{ type: 'stream-start', warnings: [] }], true));
    const output = streamLLM({ model: original, prompt: 'hi' }, 'test');
    const text = output.text;
    await vi.advanceTimersByTimeAsync(501);
    expect(await text).toBe('gemma');
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('stream commitment', () => {
  it('enforces total deadline after commitment without starting fallback', async () => {
    vi.useFakeTimers();
    vi.stubEnv('LLM_ROUTER_TOTAL_TIMEOUT_MS', '100');
    primary.doStream.mockResolvedValue(partsStream([{ type: 'text-start', id: 'a' }], true));
    const response = await createLLMRouter('test')!.model.doStream(options);
    const reader = response.stream.getReader();
    await reader.read();
    const pending = reader.read();
    await vi.advanceTimersByTimeAsync(101);
    expect((await pending).value).toMatchObject({
      type: 'error',
      error: { cause: { selected: { reason: 'timeout' } } },
    });
    expect(fallback.doStream).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('keeps streaming local-only and never constructs primary', async () => {
    const response = streamLLM({ model: original, prompt: 'hi' }, 'test', undefined, {
      externalAllowed: false,
    });
    expect(await response.text).toBe('gemma');
    expect(primary.doStream).not.toHaveBeenCalled();
    expect(getModel).toHaveBeenCalledTimes(1);
  });
  it('discards a failed primary header and preserves only fallback stream, finish and usage', async () => {
    primary.doStream.mockResolvedValue(
      partsStream([
        { type: 'stream-start', warnings: [] },
        { type: 'error', error: httpError(503) },
      ]),
    );
    const onFinish = vi.fn();
    const output = streamLLM({ model: original, prompt: 'hi', onFinish }, 'test');
    const parts: TextStreamPart<ToolSet>[] = [];
    for await (const part of output.fullStream) parts.push(part);
    expect(
      parts
        .filter((part) => part.type === 'text-delta')
        .map((part) => part.text)
        .join(''),
    ).toBe('gemma');
    expect(parts.some((part) => part.type === 'error')).toBe(false);
    expect(await output.finishReason).toBe('stop');
    expect((await output.totalUsage).inputTokens).toBe(3);
    expect(onFinish).toHaveBeenCalledTimes(1);
    await vi.waitFor(() =>
      expect(capture.usage).toHaveBeenCalledWith(expect.objectContaining({ modelId: 'gemma' })),
    );
  });
  it('preserves textStream without replacing the SDK result API', async () => {
    primary.doStream.mockRejectedValue(networkError());
    const output = streamLLM({ model: original, prompt: 'hi' }, 'test');
    let text = '';
    for await (const delta of output.textStream) text += delta;
    expect(text).toBe('gemma');
    expect(await output.text).toBe('gemma');
  });
  it.each<Part>([
    { type: 'text-start', id: 'a' },
    { type: 'reasoning-start', id: 'a' },
    { type: 'tool-input-start', id: 'a', toolName: 'inspect' },
    { type: 'response-metadata', id: 'a' },
    { type: 'raw', rawValue: {} },
    { type: 'tool-call', toolCallId: 'a', toolName: 'inspect', input: '{}' },
    { type: 'tool-result', toolCallId: 'a', toolName: 'inspect', result: {} },
  ])('never falls back after $type escaped', async (first) => {
    primary.doStream.mockResolvedValue(
      partsStream([first, { type: 'error', error: httpError(503) }]),
    );
    const routed = createLLMRouter('test')!;
    const stream = await routed.model.doStream(options);
    const reader = stream.stream.getReader();
    expect((await reader.read()).value).toEqual(first);
    expect((await reader.read()).value).toMatchObject({
      type: 'error',
      error: { message: expect.stringContaining('http_503') },
    });
    expect(fallback.doStream).not.toHaveBeenCalled();
  });
  it('surfaces post-text failure as an SDK error without splicing fallback', async () => {
    primary.doStream.mockResolvedValue(
      partsStream([
        ...textParts('partial primary').slice(0, 3),
        { type: 'error', error: networkError() },
      ]),
    );
    const parts: TextStreamPart<ToolSet>[] = [];
    const onError = vi.fn();
    for await (const part of streamLLM({ model: original, prompt: 'hi', onError }, 'test')
      .fullStream)
      parts.push(part);
    expect(parts.some((part) => part.type === 'error')).toBe(true);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(
      parts
        .filter((part) => part.type === 'text-delta')
        .map((part) => part.text)
        .join(''),
    ).toBe('partial primary');
    expect(fallback.doStream).not.toHaveBeenCalled();
  });
  it('cancels a committed reader and releases timers without fallback', async () => {
    vi.useFakeTimers();
    primary.doStream.mockResolvedValue(partsStream([{ type: 'reasoning-start', id: 'a' }], true));
    const stream = await createLLMRouter('test')!.model.doStream(options);
    const reader = stream.stream.getReader();
    await reader.read();
    await reader.cancel();
    expect(vi.getTimerCount()).toBe(0);
    expect(fallback.doStream).not.toHaveBeenCalled();
  });
  it('does not fall back on stream caller cancellation before commitment', async () => {
    primary.doStream.mockResolvedValue(partsStream([], true));
    const controller = new AbortController();
    const pending = createLLMRouter('test')!.model.doStream({
      ...options,
      abortSignal: controller.signal,
    });
    const reason = new DOMException('Cancelled', 'AbortError');
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(fallback.doStream).not.toHaveBeenCalled();
  });
});

describe('circuit recovery', () => {
  beforeEach(() => vi.useFakeTimers());
  it('resets consecutive failures on primary success', async () => {
    primary.doGenerate.mockRejectedValueOnce(networkError());
    await request();
    await request();
    primary.doGenerate.mockRejectedValueOnce(networkError());
    await request();
    await request();
    expect(primary.doGenerate).toHaveBeenCalledTimes(4);
    expect(logs().at(-1)).toMatchObject({ circuitState: 'CLOSED' });
  });
  it('releases a cancelled half-open probe and permits a later probe', async () => {
    primary.doGenerate.mockRejectedValueOnce(networkError()).mockRejectedValueOnce(networkError());
    await request();
    await request();
    await vi.advanceTimersByTimeAsync(101);
    primary.doGenerate.mockImplementationOnce(() => new Promise(() => {}));
    const controller = new AbortController();
    const pending = callLLM(
      { model: original, prompt: 'hi', abortSignal: controller.signal },
      'test',
    ).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await pending;
    expect((await request()).text).toBe('gemma');
    await vi.advanceTimersByTimeAsync(101);
    expect((await request()).text).toBe('nemotron');
  });
  it('opens, bypasses, admits only one half-open probe, then recovers', async () => {
    primary.doGenerate.mockRejectedValueOnce(httpError(429)).mockRejectedValueOnce(networkError());
    await request();
    await request();
    await request();
    expect(primary.doGenerate).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(101);
    let release!: (value: Generation) => void;
    primary.doGenerate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const probe = request();
    await vi.advanceTimersByTimeAsync(0);
    expect((await request()).text).toBe('gemma');
    expect(primary.doGenerate).toHaveBeenCalledTimes(3);
    expect(logs()).toContainEqual(expect.objectContaining({ circuitState: 'HALF_OPEN' }));
    release(result('recovered'));
    await probe;
    expect((await request()).text).toBe('nemotron');
    expect(logs().at(-1)).toMatchObject({ circuitState: 'CLOSED' });
  });
  it('reopens after a failed recovery probe', async () => {
    primary.doGenerate.mockRejectedValue(networkError());
    await request();
    await request();
    await vi.advanceTimersByTimeAsync(101);
    await request();
    await request();
    expect(primary.doGenerate).toHaveBeenCalledTimes(3);
    expect(logs().at(-1)).toMatchObject({ circuitState: 'OPEN', fallbackReason: 'circuit_open' });
  });
});

describe('optional secondary tier', () => {
  beforeEach(() => {
    vi.stubEnv('LLM_ROUTER_SECONDARY_MODEL', 'openai:super');
  });

  it.each(['generate', 'stream'] as const)(
    'routes all success/failure combinations for %s',
    async (mode) => {
      const invoke = async () =>
        mode === 'generate'
          ? (await request()).text
          : await streamLLM({ model: original, prompt: 'hi' }, 'router-test').text;
      const p = mode === 'generate' ? primary.doGenerate : primary.doStream;
      const s = mode === 'generate' ? secondary.doGenerate : secondary.doStream;
      const f = mode === 'generate' ? fallback.doGenerate : fallback.doStream;
      expect(await invoke()).toBe('nemotron');
      expect(s).not.toHaveBeenCalled();
      expect(f).not.toHaveBeenCalled();
      p.mockRejectedValue(networkError());
      expect(await invoke()).toBe('super');
      expect(f).not.toHaveBeenCalled();
      s.mockRejectedValue(httpError(503));
      capture.log.mockClear();
      expect(await invoke()).toBe('gemma');
      const events = logs().filter((entry) => entry.status !== 'stream_committed');
      expect(events.map((entry) => entry.selectedRole)).toEqual([
        'primary',
        'secondary',
        'fallback',
      ]);
      expect(events.map((entry) => entry.attempt)).toEqual([1, 2, 3]);
      expect(events.map((entry) => entry.selectedModel)).toEqual(['nemotron', 'super', 'gemma']);
      expect(events.map((entry) => entry.fallbackUsed)).toEqual([false, true, true]);
      for (const event of events)
        expect(event).toMatchObject({
          requestId: expect.any(String),
          latencyMs: expect.any(Number),
          circuitState: expect.any(String),
          status: expect.any(String),
        });
    },
  );

  it.each(['', undefined])('keeps two tiers with secondary model %s', async (model) => {
    vi.stubEnv('LLM_ROUTER_SECONDARY_MODEL', model);
    primary.doGenerate.mockRejectedValue(networkError());
    expect((await request()).text).toBe('gemma');
    expect(secondary.doGenerate).not.toHaveBeenCalled();
  });

  it('inherits only secondary URL/key, while respecting explicit overrides and keyless access', async () => {
    primary.doGenerate.mockRejectedValue(networkError());
    await request();
    expect(getModel).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: 'super',
        baseUrl: 'https://primary.example/v1',
        apiKey: 'SECRET-primary-key',
      }),
    );
    vi.stubEnv('LLM_ROUTER_SECONDARY_BASE_URL', 'https://secondary.example/v1');
    vi.stubEnv('LLM_ROUTER_SECONDARY_API_KEY', 'secondary-test-key');
    await request();
    expect(getModel).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: 'super',
        baseUrl: 'https://secondary.example/v1',
        apiKey: 'secondary-test-key',
      }),
    );
    vi.stubEnv('LLM_ROUTER_SECONDARY_API_KEY', '');
    await request();
    expect(getModel).toHaveBeenLastCalledWith(
      expect.objectContaining({ modelId: 'super', apiKey: 'unused' }),
    );
    expect(process.env.LLM_ROUTER_PRIMARY_API_KEY).toBe('SECRET-primary-key');
  });

  it.each([
    ['openai:nvidia/nemotron-3-super-120b-a12b', true],
    ['openai:nvidia/nemotron-3-ultra-550b-a55b', false],
  ] as const)(
    'preserves custom template fields at the %s transport boundary',
    async (model, expectedThinking) => {
      vi.stubEnv('LLM_ROUTER_PRIMARY_MODEL', model);
      await request();
      const fetchImpl = vi.mocked(getModel).mock.calls[0][0].fetchImpl!;
      const fetch = vi.fn(async () => new Response('{}'));
      vi.stubGlobal('fetch', fetch);
      const body = {
        messages: [],
        chat_template_kwargs: { enable_thinking: true, custom: 'kept' },
      };
      await fetchImpl('https://primary.example/v1/chat/completions', {
        body: JSON.stringify(body),
      });
      const sent = fetch.mock.calls[0] as unknown as [unknown, RequestInit];
      expect(JSON.parse(String(sent[1].body))).toMatchObject({
        chat_template_kwargs: {
          enable_thinking: expectedThinking,
          custom: 'kept',
        },
      });
    },
  );

  it('enforces local-only policy across all three tiers', async () => {
    const localRequest = () =>
      callLLM({ model: original, prompt: 'hi' }, 'test', undefined, undefined, {
        externalAllowed: false,
      });
    expect((await localRequest()).text).toBe('gemma');
    expect(secondary.doGenerate).not.toHaveBeenCalled();
    vi.stubEnv('LLM_ROUTER_SECONDARY_LOCAL', 'true');
    expect((await localRequest()).text).toBe('super');
    expect(primary.doGenerate).not.toHaveBeenCalled();
  });

  it.each([400, 401, 403, 404, 422])('does not cascade secondary HTTP %i', async (code) => {
    primary.doGenerate.mockRejectedValue(networkError());
    secondary.doGenerate.mockRejectedValue(httpError(code));
    await expect(request()).rejects.toMatchObject({ statusCode: code });
    expect(fallback.doGenerate).not.toHaveBeenCalled();
  });

  it('surfaces final failure with classified causes only', async () => {
    primary.doGenerate.mockRejectedValue(httpError(429));
    secondary.doGenerate.mockRejectedValue(httpError(503));
    fallback.doGenerate.mockRejectedValue(networkError());
    const error = await request().catch((e: unknown) => e);
    expect(error).toMatchObject({
      cause: { primary: { reason: 'http_429' }, selected: { reason: 'network' } },
    });
    expect(JSON.stringify({ error, logs: logs() })).not.toMatch(
      /SECRET|private faculty content|primary\.example/,
    );
  });

  it('keeps breakers independent, skips open tiers, and closes independent recovery probes', async () => {
    vi.useFakeTimers();
    vi.stubEnv('LLM_ROUTER_CIRCUIT_FAILURE_THRESHOLD', '1');
    primary.doGenerate.mockRejectedValue(networkError());
    expect((await request()).text).toBe('super');
    expect((await request()).text).toBe('super');
    expect(primary.doGenerate).toHaveBeenCalledTimes(1);
    expect(fallback.doGenerate).not.toHaveBeenCalled();
    expect(logs().at(-1)).toMatchObject({
      selectedRole: 'secondary',
      circuitState: 'CLOSED',
      fallbackReason: 'circuit_open',
    });
    secondary.doGenerate.mockRejectedValueOnce(networkError());
    expect((await request()).text).toBe('gemma');
    expect((await request()).text).toBe('gemma');
    expect(secondary.doGenerate).toHaveBeenCalledTimes(3);
    expect(logs()).toContainEqual(
      expect.objectContaining({
        selectedRole: 'secondary',
        status: 'circuit_open',
        circuitState: 'OPEN',
      }),
    );
    await vi.advanceTimersByTimeAsync(101);
    // Ultra's failed probe must not prevent Super's successful probe.
    expect((await request()).text).toBe('super');
    expect((await request()).text).toBe('super');
    expect(primary.doGenerate).toHaveBeenCalledTimes(2);
    expect(logs().at(-1)).toMatchObject({ selectedRole: 'secondary', circuitState: 'CLOSED' });
    primary.doGenerate.mockResolvedValue(result('nemotron'));
    await vi.advanceTimersByTimeAsync(101);
    expect((await request()).text).toBe('nemotron');
    expect((await request()).text).toBe('nemotron');
    expect(logs().at(-1)).toMatchObject({ selectedRole: 'primary', circuitState: 'CLOSED' });
  });

  it('admits only one secondary half-open probe and reopens on probe failure', async () => {
    vi.useFakeTimers();
    vi.stubEnv('LLM_ROUTER_CIRCUIT_FAILURE_THRESHOLD', '1');
    primary.doGenerate.mockRejectedValue(networkError());
    secondary.doGenerate.mockRejectedValue(networkError());
    await request();
    await vi.advanceTimersByTimeAsync(101);
    let rejectProbe!: (reason: unknown) => void;
    secondary.doGenerate.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectProbe = reject;
        }),
    );
    const probe = request();
    await vi.advanceTimersByTimeAsync(0);
    expect((await request()).text).toBe('gemma');
    expect(secondary.doGenerate).toHaveBeenCalledTimes(2);
    expect(logs()).toContainEqual(
      expect.objectContaining({
        selectedRole: 'secondary',
        status: 'circuit_open',
        circuitState: 'HALF_OPEN',
      }),
    );
    rejectProbe(networkError());
    expect((await probe).text).toBe('gemma');
    expect((await request()).text).toBe('gemma');
    expect(secondary.doGenerate).toHaveBeenCalledTimes(2);
  });

  it('resets only the changed endpoint breaker', async () => {
    vi.stubEnv('LLM_ROUTER_CIRCUIT_FAILURE_THRESHOLD', '1');
    primary.doGenerate.mockRejectedValue(networkError());
    secondary.doGenerate.mockRejectedValue(networkError());
    await request();
    vi.stubEnv('LLM_ROUTER_SECONDARY_MODEL', 'openai:replacement');
    await request();
    expect(primary.doGenerate).toHaveBeenCalledTimes(1);
    expect(getModel).toHaveBeenLastCalledWith(expect.objectContaining({ modelId: 'replacement' }));
    vi.stubEnv('LLM_ROUTER_PRIMARY_MODEL', 'openai:new-primary');
    await request();
    expect(getModel).toHaveBeenLastCalledWith(expect.objectContaining({ modelId: 'new-primary' }));
  });

  it.each(['primary', 'secondary'] as const)(
    'caller abort during %s is terminal in both paths',
    async (role) => {
      vi.useFakeTimers();
      for (const mode of ['generate', 'stream'] as const) {
        const p = mode === 'generate' ? primary.doGenerate : primary.doStream;
        const s = mode === 'generate' ? secondary.doGenerate : secondary.doStream;
        if (role === 'secondary') p.mockRejectedValue(networkError());
        const active = role === 'primary' ? p : s;
        active.mockImplementation(() => new Promise(() => {}));
        const controller = new AbortController();
        const router = createLLMRouter('abort-test', {}, controller.signal)!;
        const call = { ...options, abortSignal: controller.signal };
        const pending = (
          mode === 'generate' ? router.model.doGenerate(call) : router.model.doStream(call)
        ).catch((e: unknown) => e);
        await vi.advanceTimersByTimeAsync(0);
        const reason = new DOMException('Cancelled', 'AbortError');
        controller.abort(reason);
        expect(await pending).toBe(reason);
        if (role === 'primary') expect(s).not.toHaveBeenCalled();
        expect(fallback.doGenerate).not.toHaveBeenCalled();
        expect(fallback.doStream).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
      }
    },
  );

  it('uses secondary timeout and caps final fallback by the shared remaining budget', async () => {
    vi.useFakeTimers();
    vi.stubEnv('LLM_ROUTER_PRIMARY_TIMEOUT_MS', '100');
    vi.stubEnv('LLM_ROUTER_SECONDARY_TIMEOUT_MS', '200');
    vi.stubEnv('LLM_ROUTER_TOTAL_TIMEOUT_MS', '450');
    for (const m of [primary, secondary, fallback])
      m.doGenerate.mockImplementation(() => new Promise(() => {}));
    const pending = request().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(451);
    expect(await pending).toMatchObject({ cause: { selected: { reason: 'timeout' } } });
    expect(logs().map((entry) => [entry.selectedRole, entry.timeoutBudgetMs])).toEqual([
      ['primary', 100],
      ['secondary', 200],
      ['fallback', 150],
    ]);
    for (const m of [primary, secondary, fallback])
      expect(m.doGenerate.mock.calls[0][0].abortSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels stalled streams on both upstream tiers before serving fallback', async () => {
    vi.useFakeTimers();
    const cancellations = [vi.fn(), vi.fn()];
    for (const [index, m] of [primary, secondary].entries())
      m.doStream.mockResolvedValue({
        stream: new ReadableStream<Part>({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
          },
          cancel: cancellations[index],
        }),
      });
    const pending = streamLLM({ model: original, prompt: 'hi' }, 'test').text;
    await vi.advanceTimersByTimeAsync(1001);
    expect(await pending).toBe('gemma');
    for (const cancel of cancellations) expect(cancel).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never switches away from secondary after stream commitment', async () => {
    primary.doStream.mockRejectedValue(networkError());
    secondary.doStream.mockResolvedValue(
      partsStream([
        { type: 'text-start', id: 's' },
        { type: 'error', error: networkError() },
      ]),
    );
    const response = await createLLMRouter('test')!.model.doStream(options);
    const reader = response.stream.getReader();
    expect((await reader.read()).value).toMatchObject({ type: 'text-start' });
    expect((await reader.read()).value).toMatchObject({ type: 'error' });
    expect(fallback.doStream).not.toHaveBeenCalled();
  });
});

describe('classification and configuration', () => {
  it.each(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT'])(
    'classifies nested %s',
    (code) => {
      expect(classifyRouterError(new Error('fetch failed', { cause: { code } })).retryable).toBe(
        true,
      );
    },
  );
  it('keeps HTTP rejection authoritative over nested network-like text', () => {
    expect(classifyRouterError({ statusCode: 400, cause: { code: 'ETIMEDOUT' } }).retryable).toBe(
      false,
    );
    expect(classifyRouterError(new Error('application validation failed')).retryable).toBe(false);
    expect(classifyRouterError(new DOMException('cancel', 'AbortError')).retryable).toBe(false);
  });
  it('rejects unsafe or invalid config without echoing it', () => {
    vi.stubEnv('LLM_ROUTER_PRIMARY_BASE_URL', 'https://user:SECRET@example.test');
    expect(() => createLLMRouter('test')).toThrow('without credentials');
    vi.stubEnv('LLM_ROUTER_PRIMARY_BASE_URL', 'https://example.test');
    vi.stubEnv('LLM_ROUTER_TOTAL_TIMEOUT_MS', '-1');
    expect(() => createLLMRouter('test')).toThrow('positive');
  });
});
