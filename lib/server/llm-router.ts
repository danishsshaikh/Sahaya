/** Server-only routing at the AI SDK model boundary; never imported by Settings. */
import { createHash, randomUUID } from 'node:crypto';
import type { LanguageModel } from 'ai';
import { getModel, parseModelString } from '@/lib/ai/providers';
import { createLogger } from '@/lib/logger';

type Model = Extract<LanguageModel, { specificationVersion: 'v3' }>;
type CallOptions = Parameters<Model['doGenerate']>[0];
type StreamResult = Awaited<ReturnType<Model['doStream']>>;
type Part = StreamResult['stream'] extends ReadableStream<infer T> ? T : never;
type Role = 'primary' | 'fallback';
type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface LLMRoutingPolicy {
  externalAllowed?: boolean;
  requestId?: string;
}

interface Endpoint {
  providerId: string;
  modelId: string;
  baseUrl: string;
  apiKey: string;
  local: boolean;
}

interface Config {
  primary: Endpoint;
  fallback: Endpoint;
  initialMs: number;
  streamInitialMs: number;
  totalMs: number;
  threshold: number;
  cooldownMs: number;
}

interface Failure {
  reason: string;
  retryable: boolean;
  statusCode?: number;
}

class RouterTimeout extends Error {
  constructor() {
    super('LLM router deadline exceeded.');
    this.name = 'RouterTimeout';
  }
}

/** Deliberately retain only classified causes, never SDK request/response bodies. */
class RouterError extends Error {
  readonly statusCode?: number;
  constructor(selected: Failure, primary?: Failure) {
    super(`LLM provider failed (${selected.reason}).`, {
      cause: { ...(primary ? { primary } : {}), selected },
    });
    this.name = 'LLMRouterError';
    this.statusCode = selected.statusCode ?? (selected.retryable ? 503 : undefined);
  }
}

export function classifyRouterError(error: unknown, signal?: AbortSignal): Failure {
  if (signal?.aborted) return { reason: 'caller_abort', retryable: false };
  const seen = new Set<unknown>();
  const visit = (value: unknown): Failure => {
    if (!value || typeof value !== 'object' || seen.has(value)) {
      return { reason: 'unknown', retryable: false };
    }
    seen.add(value);
    if (value instanceof RouterTimeout) return { reason: 'timeout', retryable: true };
    const e = value as Record<string, unknown>;
    if (e.name === 'AbortError') return { reason: 'abort', retryable: false };
    const status = Number(e.statusCode ?? e.status);
    if (Number.isInteger(status) && status >= 400 && status <= 599) {
      return {
        reason: `http_${status}`,
        retryable: status === 408 || status === 429 || status >= 500,
        statusCode: status,
      };
    }
    const nested = visit(e.cause ?? e.lastError);
    if (nested.reason !== 'unknown') return nested;
    if (
      typeof e.code === 'string' &&
      /^(ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|EPIPE|ETIMEDOUT|UND_ERR_(CONNECT_TIMEOUT|HEADERS_TIMEOUT|BODY_TIMEOUT|SOCKET))$/.test(
        e.code,
      )
    )
      return { reason: 'network', retryable: true };
    if (e.name === 'TimeoutError') return { reason: 'timeout', retryable: true };
    if (e.message === 'fetch failed' || e.message === 'Failed to fetch') {
      return { reason: 'network', retryable: true };
    }
    return { reason: 'unknown', retryable: false };
  };
  return visit(error);
}

function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) {
    throw new Error(`${name} must be a positive timer-safe integer.`);
  }
  return value;
}

function endpoint(role: 'PRIMARY' | 'FALLBACK'): Endpoint {
  const prefix = `LLM_ROUTER_${role}`;
  const model = process.env[`${prefix}_MODEL`]?.trim();
  const baseUrl = process.env[`${prefix}_BASE_URL`]?.trim();
  if (!model || !baseUrl) throw new Error(`${prefix}_MODEL and ${prefix}_BASE_URL are required.`);
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error(`${prefix}_BASE_URL must be an HTTP(S) URL.`);
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(`${prefix}_BASE_URL must be HTTP(S), without credentials, query or fragment.`);
  }
  const { providerId, modelId } = parseModelString(model);
  if (!/^[a-zA-Z0-9._-]+$/.test(providerId) || !/^[a-zA-Z0-9._/:+-]+$/.test(modelId)) {
    throw new Error(`${prefix}_MODEL must be a provider:model identifier.`);
  }
  return {
    providerId,
    modelId,
    baseUrl,
    apiKey: process.env[`${prefix}_API_KEY`] || '',
    local: process.env[`${prefix}_LOCAL`] === 'true',
  };
}

function loadConfig(): Config | undefined {
  if (process.env.LLM_ROUTER_ENABLED !== 'true') return undefined;
  return {
    primary: endpoint('PRIMARY'),
    fallback: endpoint('FALLBACK'),
    initialMs: positiveInt('LLM_ROUTER_INITIAL_TIMEOUT_MS', 60_000),
    streamInitialMs: positiveInt('LLM_ROUTER_STREAM_INITIAL_CHUNK_TIMEOUT_MS', 45_000),
    totalMs: positiveInt('LLM_ROUTER_TOTAL_TIMEOUT_MS', 180_000),
    threshold: positiveInt('LLM_ROUTER_CIRCUIT_FAILURE_THRESHOLD', 3),
    cooldownMs: positiveInt('LLM_ROUTER_CIRCUIT_COOLDOWN_MS', 30_000),
  };
}

interface Breaker {
  failures: number;
  openedAt?: number;
  probe: boolean;
  epoch: number;
}
const processState = globalThis as typeof globalThis & {
  __sahayaLlmCircuit?: { key: string; breaker: Breaker };
};

function circuit(config: Config): Breaker {
  const key = createHash('sha256').update(JSON.stringify(config)).digest('hex');
  if (processState.__sahayaLlmCircuit?.key !== key) {
    processState.__sahayaLlmCircuit = { key, breaker: { failures: 0, probe: false, epoch: 0 } };
  }
  return processState.__sahayaLlmCircuit.breaker;
}

function state(b: Breaker): CircuitState {
  return b.probe ? 'HALF_OPEN' : b.openedAt !== undefined ? 'OPEN' : 'CLOSED';
}

/** Races even misbehaving transports that ignore abort, with bounded listener lifetime. */
function budget(parent: AbortSignal | undefined, deadline: number) {
  const controller = new AbortController();
  const abort = () => controller.abort(parent?.reason);
  parent?.addEventListener('abort', abort, { once: true });
  if (parent?.aborted) abort();
  let timer: ReturnType<typeof setTimeout>;
  controller.signal.addEventListener(
    'abort',
    () => {
      clearTimeout(timer);
      parent?.removeEventListener('abort', abort);
    },
    { once: true },
  );
  const arm = (until: number) => {
    clearTimeout(timer);
    const remaining = until - Date.now();
    if (remaining <= 0) controller.abort(new RouterTimeout());
    else timer = setTimeout(() => controller.abort(new RouterTimeout()), remaining);
  };
  arm(deadline);
  return {
    signal: controller.signal,
    arm,
    async wait<T>(operation: () => PromiseLike<T>): Promise<T> {
      controller.signal.throwIfAborted();
      let listener: () => void = () => {};
      const cancelled = new Promise<never>((_, reject) => {
        listener = () => reject(controller.signal.reason);
        controller.signal.addEventListener('abort', listener, { once: true });
      });
      try {
        const result = await Promise.race([operation(), cancelled]);
        controller.signal.throwIfAborted();
        return result;
      } finally {
        controller.signal.removeEventListener('abort', listener);
      }
    },
    dispose(cancel = false) {
      clearTimeout(timer);
      parent?.removeEventListener('abort', abort);
      if (cancel && !controller.signal.aborted) controller.abort();
    },
  };
}

function buildModel(e: Endpoint): Model {
  // A private compatible-provider ID forces Chat Completions and avoids inheriting
  // native OpenAI/other catalog thinking defaults. Existing reasoning extraction stays active.
  const { model } = getModel({
    providerId: `custom-llm-router-${e.providerId}`,
    providerType: 'openai',
    modelId: e.modelId,
    baseUrl: e.baseUrl,
    apiKey: e.apiKey || 'unused',
    fetchImpl: (input, init) => {
      const headers = new Headers(init?.headers);
      if (!e.apiKey) headers.delete('authorization');
      return globalThis.fetch(input, { ...init, headers, redirect: 'error' });
    },
  });
  if (typeof model !== 'object' || model.specificationVersion !== 'v3') {
    throw new Error('LLM router requires an AI SDK v3 compatible model.');
  }
  return model;
}

const log = createLogger('LLMRouter');

/** One instance per callLLM/streamLLM invocation; selection stays pinned across tool steps. */
export function createLLMRouter(
  source: string,
  policy: LLMRoutingPolicy = {},
  callerSignal?: AbortSignal,
) {
  const config = loadConfig();
  if (!config) {
    if (policy.externalAllowed === false)
      throw new Error('Local-only routing requires LLM_ROUTER_ENABLED.');
    return undefined;
  }
  const b = circuit(config);
  const requestId = policy.requestId ?? randomUUID();
  let selected: Role | undefined;
  let committed = false;
  let deadline: number | undefined;
  let firstFailure: Failure | undefined;
  let fallbackReason: string | undefined;
  let epoch = b.epoch;
  let probing = false;
  const models: Partial<Record<Role, Model>> = {};
  const meta = () => {
    const e = config[selected ?? 'primary'];
    return {
      source,
      providerId: e.providerId,
      modelId: e.modelId,
      modelString: `${e.providerId}:${e.modelId}`,
    };
  };
  const report = (status: string, start: number, firstPartMs?: number) => {
    const e = config[selected ?? 'primary'];
    log.info({
      requestId,
      source,
      primaryProvider: config.primary.providerId,
      primaryModel: config.primary.modelId,
      fallbackProvider: config.fallback.providerId,
      fallbackModel: config.fallback.modelId,
      selectedProvider: e.providerId,
      selectedModel: e.modelId,
      fallbackUsed: selected === 'fallback',
      fallbackReason,
      circuitState: state(b),
      status,
      latencyMs: Date.now() - start,
      ...(firstPartMs === undefined ? {} : { timeToFirstPartMs: firstPartMs }),
    });
  };
  const choose = (): Role => {
    if (selected) return selected;
    if (policy.externalAllowed === false) {
      if (config.primary.local) return 'primary';
      if (config.fallback.local) {
        fallbackReason = 'local_only';
        return 'fallback';
      }
      throw new Error('Local-only routing requires an explicitly local endpoint.');
    }
    if (b.openedAt !== undefined) {
      if (b.probe || Date.now() - b.openedAt < config.cooldownMs) {
        fallbackReason = 'circuit_open';
        return 'fallback';
      }
      b.probe = true;
      probing = true;
    }
    epoch = b.epoch;
    return 'primary';
  };
  const healthy = () => {
    if (selected === 'primary' && epoch === b.epoch) {
      b.failures = 0;
      b.openedAt = undefined;
      b.probe = false;
    }
    probing = false;
  };
  const failed = (failure: Failure) => {
    if (selected !== 'primary' || epoch !== b.epoch) return;
    if (failure.retryable) {
      b.failures++;
      if (probing || b.failures >= config.threshold) {
        b.openedAt = Date.now();
        b.epoch++;
      }
    } else if (probing) {
      // A rejected/cancelled probe must release its lease without claiming recovery.
      b.openedAt = Date.now();
    } else {
      b.failures = 0;
    }
    b.probe = false;
    probing = false;
  };
  const handleFailure = (error: unknown, options: CallOptions, start: number): boolean => {
    // The SDK composes its own total deadline with the caller signal. Only an
    // actual caller cancellation is exempt from provider health accounting.
    const sdkReason: unknown = options.abortSignal?.reason;
    const sdkTimeout = sdkReason instanceof Error && sdkReason.name === 'TimeoutError';
    const cancelled = callerSignal?.aborted || (options.abortSignal?.aborted && !sdkTimeout);
    const failure = classifyRouterError(
      options.abortSignal?.aborted ? sdkReason : error,
      cancelled ? (callerSignal?.aborted ? callerSignal : options.abortSignal) : undefined,
    );
    failed(failure);
    report(failure.reason, start);
    if (cancelled) throw callerSignal?.aborted ? callerSignal.reason : options.abortSignal?.reason;
    if (failure.reason === 'abort') throw error;
    if (
      !committed &&
      !options.abortSignal?.aborted &&
      selected === 'primary' &&
      failure.retryable &&
      (policy.externalAllowed !== false || config.fallback.local) &&
      Date.now() < deadline!
    ) {
      firstFailure = failure;
      fallbackReason = failure.reason;
      selected = 'fallback';
      return true;
    }
    throw new RouterError(failure, firstFailure);
  };

  const model: Model = {
    specificationVersion: 'v3',
    get provider() {
      return `${meta().providerId}.chat`;
    },
    get modelId() {
      return meta().modelId;
    },
    supportedUrls: {},
    async doGenerate(options) {
      options.abortSignal?.throwIfAborted();
      deadline ??= Date.now() + config.totalMs;
      selected = choose();
      for (;;) {
        const start = Date.now();
        const scope = budget(options.abortSignal, Math.min(deadline, start + config.initialMs));
        try {
          const target = (models[selected] ??= buildModel(config[selected]));
          const result = await scope.wait(() =>
            target.doGenerate({ ...options, abortSignal: scope.signal }),
          );
          committed = true;
          healthy();
          report('success', start);
          return result;
        } catch (error) {
          if (!handleFailure(error, options, start)) throw error;
        } finally {
          scope.dispose(true);
        }
      }
    },
    async doStream(options) {
      options.abortSignal?.throwIfAborted();
      deadline ??= Date.now() + config.totalMs;
      selected = choose();
      for (;;) {
        const start = Date.now();
        const scope = budget(
          options.abortSignal,
          Math.min(deadline, start + config.initialMs, start + config.streamInitialMs),
        );
        let reader: ReadableStreamDefaultReader<Part> | undefined;
        const cancel = () => {
          scope.dispose(true);
          void reader?.cancel().catch(() => {});
        };
        try {
          const target = (models[selected] ??= buildModel(config[selected]));
          const result = await scope.wait(async () => {
            const value = await target.doStream({ ...options, abortSignal: scope.signal });
            if (scope.signal.aborted) void value.stream.cancel().catch(() => {});
            return value;
          });
          reader = result.stream.getReader();
          // Only stream-start is inert. Even response metadata, reasoning-start,
          // tool-input-start and raw events commit selection. At most one header is held.
          let header: Part | undefined;
          let first: Part;
          for (;;) {
            const next = await scope.wait(() => reader!.read());
            if (next.done) throw new Error('Provider stream ended before a meaningful part.');
            if (next.value.type === 'error') throw next.value.error;
            if (next.value.type === 'stream-start' && !header) {
              header = next.value;
              continue;
            }
            first = next.value;
            break;
          }
          committed = true;
          scope.arm(deadline);
          report('stream_committed', start, Date.now() - start);
          const initial = header ? [header, first] : [first];
          let finished = first.type === 'finish';
          return {
            ...result,
            stream: new ReadableStream<Part>(
              {
                async pull(controller) {
                  try {
                    scope.signal.throwIfAborted();
                    const buffered = initial.shift();
                    if (buffered) {
                      controller.enqueue(buffered);
                      return;
                    }
                    if (finished) {
                      healthy();
                      report('success', start);
                      cancel();
                      controller.close();
                      return;
                    }
                    const next = await scope.wait(() => reader!.read());
                    if (next.done) throw new Error('Provider stream ended without finish.');
                    if (next.value.type === 'error') throw next.value.error;
                    finished = next.value.type === 'finish';
                    controller.enqueue(next.value);
                  } catch (error) {
                    cancel();
                    try {
                      handleFailure(error, options, start);
                    } catch (normalized) {
                      if (options.abortSignal?.aborted) controller.error(normalized);
                      else {
                        // Provider error parts preserve SDK onError/fullStream semantics.
                        controller.enqueue({ type: 'error', error: normalized });
                        controller.close();
                      }
                    }
                  }
                },
                cancel() {
                  failed({ reason: 'abort', retryable: false });
                  cancel();
                },
              },
              { highWaterMark: 0 },
            ),
          };
        } catch (error) {
          cancel();
          if (!handleFailure(error, options, start)) throw error;
        }
      }
    },
  };
  return { model, usageMeta: meta, totalTimeoutMs: config.totalMs };
}
