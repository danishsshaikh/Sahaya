/** Server-only routing at the AI SDK model boundary; never imported by Settings. */
import { createHash, randomUUID } from 'node:crypto';
import type { LanguageModel } from 'ai';
import { getModel, parseModelString } from '@/lib/ai/providers';
import { wrapJsonResponseWithReasoning } from '@/lib/ai/reasoning-sse';
import { createLogger } from '@/lib/logger';

type Model = Extract<LanguageModel, { specificationVersion: 'v3' }>;
type CallOptions = Parameters<Model['doGenerate']>[0];
type StreamResult = Awaited<ReturnType<Model['doStream']>>;
type Part = StreamResult['stream'] extends ReadableStream<infer T> ? T : never;
type Completion = Pick<Awaited<ReturnType<Model['doGenerate']>>, 'usage' | 'finishReason'>;
type Role = 'primary' | 'secondary' | 'fallback';
type BreakerRole = Exclude<Role, 'fallback'>;
type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface LLMRouteTelemetry {
  requestId: string;
  source: string;
  selectedRole: Role;
  selectedProvider: string;
  selectedModel: string;
  fallbackUsed: boolean;
  fallbackReason?: string;
  circuitState: CircuitState;
  status: string;
  timeoutBudgetMs: number;
  latencyMs: number;
  attempt: number;
  timeToFirstPartMs?: number;
  promptBytes?: number;
  requestedCompletionTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  finishReason?: string;
  timeToFirstTokenMs?: number;
  remainingInferenceMs?: number;
  inferenceDeadlineMs?: number;
  cancellationSource?: string;
}

export interface LLMRoutingPolicy {
  externalAllowed?: boolean;
  requestId?: string;
  onRouteEvent?: (event: LLMRouteTelemetry) => void;
  /** Subsequent turns in the same task can continue on their last successful tier. */
  continueFrom?: Pick<LLMRouteTelemetry, 'selectedRole' | 'fallbackReason'>;
  /** Absolute authoring window and per-provider caps for the visualization agent. */
  manimBudget?: { deadlineMs: number; inferenceMs: number; remoteInferenceMs: number };
  /** Server-owned budget shared by simulation HTML generation and its language repair. */
  simulationBudget?: {
    startedAtMs: number;
    deadlineMs: number;
    totalBudgetMs?: number;
    upstreamAttemptBudgetMs?: number;
  };
}

interface Endpoint {
  providerId: string;
  modelId: string;
  baseUrl: string;
  apiKey: string;
  local: boolean;
  disableReasoning?: boolean;
  enableThinking?: boolean;
}

interface Config {
  primary: Endpoint;
  secondary?: Endpoint;
  fallback?: Endpoint;
  initialMs: number;
  primaryMs: number;
  secondaryMs: number;
  fallbackMs: number;
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
  constructor(
    readonly failure: Failure,
    primary?: Failure,
  ) {
    super(`LLM provider failed (${failure.reason}).`, {
      cause: { ...(primary ? { primary } : {}), selected: failure },
    });
    this.name = 'LLMRouterError';
    this.statusCode = failure.statusCode ?? (failure.retryable ? 503 : undefined);
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
    if (value instanceof RouterError) return value.failure;
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

function endpoint(prefix: string, inherited?: Endpoint): Endpoint {
  const model = process.env[`${prefix}_MODEL`]?.trim();
  const baseUrl = process.env[`${prefix}_BASE_URL`]?.trim() || inherited?.baseUrl;
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
  const dedicatedManim = prefix.startsWith('MANIM_MODEL_');
  const llamaCpp = dedicatedManim && process.env[`${prefix}_LLAMA_CPP`] === 'true';
  return {
    providerId,
    modelId,
    baseUrl,
    apiKey: process.env[`${prefix}_API_KEY`] ?? inherited?.apiKey ?? '',
    local: process.env[`${prefix}_LOCAL`] === 'true',
    ...(llamaCpp
      ? { enableThinking: process.env.MANIM_MODEL_ENABLE_THINKING === 'true' }
      : dedicatedManim && process.env[`${prefix}_DISABLE_REASONING`] === 'true'
        ? { disableReasoning: true }
        : {}),
  };
}

function loadConfig(manim?: LLMRoutingPolicy['manimBudget']): Config | undefined {
  if (manim && process.env.MANIM_MODEL_PRIMARY_MODEL?.trim()) {
    const primary = endpoint('MANIM_MODEL_PRIMARY');
    const secondary = process.env.MANIM_MODEL_SECONDARY_MODEL?.trim()
      ? endpoint('MANIM_MODEL_SECONDARY')
      : undefined;
    const fallback = process.env.MANIM_MODEL_FALLBACK_MODEL?.trim()
      ? endpoint('MANIM_MODEL_FALLBACK')
      : undefined;
    const configured = [primary, secondary, fallback].filter((value): value is Endpoint => !!value);
    if (
      new Set(
        configured.map((value) =>
          JSON.stringify([value.modelId, value.baseUrl.replace(/\/$/, '')]),
        ),
      ).size !== configured.length
    )
      throw new Error('Manim tiers must use distinct model endpoints.');
    const timeout = (role: string, target?: Endpoint) =>
      target
        ? 1000 *
          positiveInt(
            `MANIM_MODEL_${role}_TIMEOUT_SECONDS`,
            (target.local ? manim.inferenceMs : manim.remoteInferenceMs) / 1000,
          )
        : 0;
    return {
      primary,
      secondary,
      fallback,
      initialMs: manim.remoteInferenceMs,
      primaryMs: timeout('PRIMARY', primary),
      secondaryMs: timeout('SECONDARY', secondary),
      fallbackMs: timeout('FALLBACK', fallback),
      streamInitialMs: 45_000,
      totalMs: manim.inferenceMs,
      threshold: 3,
      cooldownMs: 30_000,
    };
  }
  if (process.env.LLM_ROUTER_ENABLED !== 'true') return undefined;
  const initialMs = positiveInt('LLM_ROUTER_INITIAL_TIMEOUT_MS', 60_000);
  const primary = endpoint('LLM_ROUTER_PRIMARY');
  const secondary = process.env.LLM_ROUTER_SECONDARY_MODEL?.trim()
    ? endpoint('LLM_ROUTER_SECONDARY', primary)
    : undefined;
  return {
    primary,
    secondary,
    fallback: endpoint('LLM_ROUTER_FALLBACK'),
    initialMs,
    primaryMs: positiveInt('LLM_ROUTER_PRIMARY_TIMEOUT_MS', initialMs),
    secondaryMs: secondary ? positiveInt('LLM_ROUTER_SECONDARY_TIMEOUT_MS', initialMs) : initialMs,
    fallbackMs: positiveInt('LLM_ROUTER_FALLBACK_TIMEOUT_MS', initialMs),
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
  __sahayaLlmCircuits?: Partial<Record<BreakerRole, { key: string; breaker: Breaker }>>;
  __sahayaManimLlmCircuits?: Partial<Record<BreakerRole, { key: string; breaker: Breaker }>>;
};

function circuit(config: Config, role: BreakerRole, manim: boolean): Breaker {
  const key = createHash('sha256')
    .update(JSON.stringify([config[role], config.threshold, config.cooldownMs]))
    .digest('hex');
  const circuits = manim
    ? (processState.__sahayaManimLlmCircuits ??= {})
    : (processState.__sahayaLlmCircuits ??= {});
  if (circuits[role]?.key !== key) {
    circuits[role] = { key, breaker: { failures: 0, probe: false, epoch: 0 } };
  }
  return circuits[role]!.breaker;
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

function roleTimeoutMs(config: Config, role: Role): number {
  return role === 'primary'
    ? config.primaryMs
    : role === 'secondary'
      ? config.secondaryMs
      : config.fallbackMs;
}

function attemptBudgetMs(deadline: number, start: number, ...limits: number[]): number {
  return Math.max(0, Math.min(deadline - start, ...limits));
}

function hasToolRequest(body: Record<string, unknown>): boolean {
  return (
    (Array.isArray(body.tools) && body.tools.length > 0) ||
    (Array.isArray(body.functions) && body.functions.length > 0) ||
    body.tool_choice !== undefined ||
    body.function_call !== undefined
  );
}

function isNemotronEndpoint(endpoint: Endpoint): boolean {
  const provider = endpoint.providerId.toLowerCase();
  const model = endpoint.modelId.toLowerCase();
  return model.includes('nemotron') && (provider === 'nvidia' || model.startsWith('nvidia/'));
}

function adaptCompatibleRequestBody(
  endpoint: Endpoint,
  init?: RequestInit,
): RequestInit | undefined {
  const nemotron = isNemotronEndpoint(endpoint);
  if (
    !init?.body ||
    typeof init.body !== 'string' ||
    (!nemotron && !endpoint.disableReasoning && endpoint.enableThinking === undefined)
  )
    return init;
  try {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    if (hasToolRequest(body)) return init;
    if (endpoint.disableReasoning) body.reasoning_effort = 'none';
    if (!nemotron && endpoint.enableThinking === undefined)
      return { ...init, body: JSON.stringify(body) };
    const current =
      body.chat_template_kwargs &&
      typeof body.chat_template_kwargs === 'object' &&
      !Array.isArray(body.chat_template_kwargs)
        ? (body.chat_template_kwargs as Record<string, unknown>)
        : {};
    const isSuper = endpoint.modelId.toLowerCase() === 'nvidia/nemotron-3-super-120b-a12b';
    return {
      ...init,
      body: JSON.stringify({
        ...body,
        // Preserve existing Nemotron/Ultra behavior; Super may retain an explicit toggle.
        chat_template_kwargs: {
          ...current,
          enable_thinking:
            endpoint.enableThinking ??
            (isSuper && typeof current.enable_thinking === 'boolean'
              ? current.enable_thinking
              : false),
        },
      }),
    };
  } catch {
    return init;
  }
}

export function reportedReasoningTokens(usage: unknown, sawReasoning: boolean) {
  // The OpenAI Chat adapter fills in zero when this wire field is missing.
  // Keep an explicit zero only when it agrees with the response content.
  if (!usage || typeof usage !== 'object') return undefined;
  const raw = usage as Record<string, unknown>;
  const detail = raw.completion_tokens_details ?? raw.output_tokens_details;
  if (!detail || typeof detail !== 'object' || !('reasoning_tokens' in detail)) return undefined;
  const count = detail.reasoning_tokens;
  return typeof count === 'number' &&
    Number.isSafeInteger(count) &&
    (count > 0 || (count === 0 && !sawReasoning))
    ? count
    : undefined;
}

function buildModel(e: Endpoint, manim: boolean): Model {
  // A private compatible-provider ID forces Chat Completions and avoids inheriting
  // native OpenAI/other catalog thinking defaults. Existing reasoning extraction stays active.
  const { model } = getModel({
    providerId: `custom-llm-router-${e.providerId}`,
    providerType: 'openai',
    modelId: e.modelId,
    baseUrl: e.baseUrl,
    apiKey: e.apiKey || 'unused',
    fetchImpl: async (input, init) => {
      const headers = new Headers(init?.headers);
      if (!e.apiKey) headers.delete('authorization');
      const adapted = adaptCompatibleRequestBody(e, init);
      const response = await globalThis.fetch(input, { ...adapted, headers, redirect: 'error' });
      return manim &&
        response.ok &&
        !response.headers.get('content-type')?.includes('text/event-stream')
        ? wrapJsonResponseWithReasoning(response)
        : response;
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
  const manim = policy.manimBudget;
  const config = loadConfig(manim);
  if (!config) {
    if (policy.externalAllowed === false)
      throw new Error('Local-only routing requires LLM_ROUTER_ENABLED.');
    return undefined;
  }
  const simulationDeadline = policy.simulationBudget
    ? Math.min(
        policy.simulationBudget.startedAtMs +
          (policy.simulationBudget.totalBudgetMs ?? config.totalMs),
        policy.simulationBudget.deadlineMs,
      )
    : undefined;
  const initialDeadline = manim?.deadlineMs ?? simulationDeadline;
  const totalTimeoutMs =
    initialDeadline === undefined ? config.totalMs : Math.floor(initialDeadline - Date.now());
  if (!Number.isSafeInteger(totalTimeoutMs) || totalTimeoutMs <= 0) {
    throw new RouterError({ reason: 'timeout', retryable: true });
  }
  // Full HTML/CSS/JS needs sustained generation time. Simulation callers may
  // provide explicit upstream probe budgets; otherwise upstream attempts share
  // at most one third. The final tier can use all remaining time, not the
  // lightweight role cap. No request or repair can extend the scene deadline.
  const fallbackReserveMs = Math.ceil((totalTimeoutMs * 2) / 3);
  const roles: Role[] = ['primary'];
  if (config.secondary) roles.push('secondary');
  if (config.fallback) roles.push('fallback');
  const breakers = {
    primary: circuit(config, 'primary', !!manim),
    secondary: config.secondary ? circuit(config, 'secondary', !!manim) : undefined,
  };
  const endpointFor = (role: Role): Endpoint => {
    const target = config[role];
    if (!target) throw new Error('LLM router selected an unconfigured endpoint.');
    return target;
  };
  let b = breakers.primary;
  const requestId = policy.requestId ?? randomUUID();
  let selected: Role | undefined;
  let committed = false;
  let deadline: number | undefined = initialDeadline;
  let firstFailure: Failure | undefined;
  let fallbackReason = policy.continueFrom?.fallbackReason;
  let epoch = b.epoch;
  let probing = false;
  let attempt = 0;
  const models: Partial<Record<Role, Model>> = {};
  const meta = () => {
    const e = endpointFor(selected ?? 'primary');
    return {
      source,
      providerId: e.providerId,
      modelId: e.modelId,
      modelString: `${e.providerId}:${e.modelId}`,
    };
  };
  const report = (
    status: string,
    start: number,
    timeoutBudgetMs: number,
    firstPartMs?: number,
    metrics?: Partial<LLMRouteTelemetry>,
  ) => {
    const e = endpointFor(selected ?? 'primary');
    const event: LLMRouteTelemetry = {
      requestId,
      source,
      selectedProvider: e.providerId,
      selectedModel: e.modelId,
      selectedRole: selected ?? 'primary',
      fallbackUsed: selected !== undefined && selected !== 'primary',
      circuitState: state(b),
      status,
      timeoutBudgetMs,
      latencyMs: Date.now() - start,
      attempt,
      ...metrics,
      ...(fallbackReason === undefined ? {} : { fallbackReason }),
      ...(firstPartMs === undefined ? {} : { timeToFirstPartMs: firstPartMs }),
    };
    policy.onRouteEvent?.(event);
    log.info({
      ...event,
      primaryProvider: config.primary.providerId,
      primaryModel: config.primary.modelId,
      secondaryConfigured: !!config.secondary,
      ...(config.secondary
        ? {
            secondaryProvider: config.secondary.providerId,
            secondaryModel: config.secondary.modelId,
          }
        : {}),
      fallbackProvider: config.fallback?.providerId,
      fallbackModel: config.fallback?.modelId,
    });
  };
  const choose = (after?: Role): Role | undefined => {
    const start = after
      ? roles.indexOf(after) + 1
      : Math.max(0, roles.indexOf(policy.continueFrom?.selectedRole ?? 'primary'));
    for (const role of roles.slice(start)) {
      if (policy.externalAllowed === false && !endpointFor(role).local) {
        fallbackReason = 'local_only';
        continue;
      }
      selected = role;
      // Final fallback has no breaker; retain the preceding breaker in legacy telemetry.
      if (role === 'fallback') return role;
      b = breakers[role]!;
      if (b.openedAt !== undefined) {
        if (b.probe || Date.now() - b.openedAt < config.cooldownMs) {
          fallbackReason = 'circuit_open';
          report('circuit_open', Date.now(), 0);
          continue;
        }
        b.probe = true;
        probing = true;
      }
      epoch = b.epoch;
      return role;
    }
    return undefined;
  };
  const healthy = () => {
    if (selected !== 'fallback' && epoch === b.epoch) {
      b.failures = 0;
      b.openedAt = undefined;
      b.probe = false;
    }
    probing = false;
  };
  const failed = (failure: Failure) => {
    if (selected === 'fallback' || epoch !== b.epoch) return;
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
  const manimAttemptMs = (role: Role, start: number) => {
    const cap = roleTimeoutMs(config, role);
    if (!manim) return cap;
    const local = endpointFor(role).local;
    const hasBackup = roles
      .slice(roles.indexOf(role) + 1)
      .some((next) => policy.externalAllowed !== false || endpointFor(next).local);
    const remaining = manim.deadlineMs - start;
    // Keep part of the inference phase available for the next tier. A local
    // primary with no backup can use its entire configured inference cap.
    const reserve = hasBackup ? Math.min(120_000, Math.floor(remaining / 2)) : 0;
    return Math.min(cap, local ? manim.inferenceMs : manim.remoteInferenceMs, remaining - reserve);
  };
  const inferenceMetrics = (
    options: CallOptions,
    completion?: Completion,
    firstTokenMs?: number,
    sawReasoning = false,
  ) =>
    manim
      ? {
          promptBytes: Buffer.byteLength(JSON.stringify(options.prompt)),
          requestedCompletionTokens: options.maxOutputTokens,
          inputTokens: completion?.usage.inputTokens.total,
          outputTokens: completion?.usage.outputTokens.total,
          reasoningTokens: reportedReasoningTokens(completion?.usage.raw, sawReasoning),
          finishReason: completion?.finishReason.unified,
          timeToFirstTokenMs: firstTokenMs,
          remainingInferenceMs: Math.max(0, manim.deadlineMs - Date.now()),
          inferenceDeadlineMs: manim.deadlineMs,
        }
      : undefined;
  const handleFailure = (
    error: unknown,
    options: CallOptions,
    start: number,
    timeoutBudgetMs: number,
    firstTokenMs?: number,
  ): boolean => {
    // The SDK composes its own total deadline with the caller signal. Only an
    // actual caller cancellation is exempt from provider health accounting.
    const sdkReason: unknown = options.abortSignal?.reason;
    const sdkTimeout = sdkReason instanceof Error && sdkReason.name === 'TimeoutError';
    const cancelled = callerSignal?.aborted || (options.abortSignal?.aborted && !sdkTimeout);
    const classified = classifyRouterError(
      options.abortSignal?.aborted ? sdkReason : error,
      cancelled ? (callerSignal?.aborted ? callerSignal : options.abortSignal) : undefined,
    );
    // Missing or retired routes can be bypassed by another LLM tier.
    // Keep generic HTTP classification and final-tier responses terminal.
    const failure =
      (selected === 'primary' || selected === 'secondary') &&
      (classified.statusCode === 404 || classified.statusCode === 410)
        ? { ...classified, retryable: true }
        : classified;
    failed(failure);
    const metrics = inferenceMetrics(options, undefined, firstTokenMs);
    if (metrics) {
      report(failure.reason, start, timeoutBudgetMs, undefined, {
        ...metrics,
        cancellationSource: cancelled
          ? 'caller_signal'
          : sdkTimeout
            ? 'sdk_inference_deadline'
            : failure.reason === 'timeout'
              ? 'provider_attempt_deadline'
              : undefined,
      });
    } else report(failure.reason, start, timeoutBudgetMs);
    if (cancelled) throw callerSignal?.aborted ? callerSignal.reason : options.abortSignal?.reason;
    if (failure.reason === 'abort') throw error;
    if (
      !committed &&
      !options.abortSignal?.aborted &&
      selected !== 'fallback' &&
      failure.retryable &&
      Date.now() < deadline!
    ) {
      firstFailure ??= failure;
      fallbackReason = failure.reason;
      const next = choose(selected);
      if (next) {
        selected = next;
        return true;
      }
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
      selected ??= choose();
      if (!selected) throw new Error('Local-only routing requires an explicitly local endpoint.');
      for (;;) {
        attempt += 1;
        const start = Date.now();
        const remainingMs = deadline - start;
        const pendingUpstream = roles
          .slice(roles.indexOf(selected))
          .filter(
            (role) =>
              role !== 'fallback' && (policy.externalAllowed !== false || endpointFor(role).local),
          ).length;
        const roleBudgetMs =
          policy.simulationBudget && !committed
            ? selected === 'fallback'
              ? remainingMs
              : policy.simulationBudget.upstreamAttemptBudgetMs
                ? Math.min(
                    roleTimeoutMs(config, selected),
                    policy.simulationBudget.upstreamAttemptBudgetMs,
                  )
                : Math.min(
                    roleTimeoutMs(config, selected),
                    Math.floor(Math.max(0, remainingMs - fallbackReserveMs) / pendingUpstream),
                  )
            : manimAttemptMs(selected, start);
        const timeoutMs = attemptBudgetMs(deadline, start, roleBudgetMs);
        const scope = budget(options.abortSignal, start + timeoutMs);
        try {
          const target = (models[selected] ??= buildModel(endpointFor(selected), !!manim));
          const result = await scope.wait(() =>
            target.doGenerate({ ...options, abortSignal: scope.signal }),
          );
          committed = true;
          healthy();
          report(
            'success',
            start,
            timeoutMs,
            undefined,
            inferenceMetrics(
              options,
              result,
              undefined,
              !!manim && result.content.some((part) => part.type === 'reasoning' && !!part.text),
            ),
          );
          return result;
        } catch (error) {
          if (!handleFailure(error, options, start, timeoutMs)) throw error;
        } finally {
          scope.dispose(true);
        }
      }
    },
    async doStream(options) {
      options.abortSignal?.throwIfAborted();
      deadline ??= Date.now() + config.totalMs;
      selected ??= choose();
      if (!selected) throw new Error('Local-only routing requires an explicitly local endpoint.');
      for (;;) {
        attempt += 1;
        const start = Date.now();
        const attemptMs = attemptBudgetMs(deadline, start, manimAttemptMs(selected, start));
        const timeoutMs = attemptBudgetMs(deadline, start, attemptMs, config.streamInitialMs);
        const scope = budget(options.abortSignal, start + timeoutMs);
        let reader: ReadableStreamDefaultReader<Part> | undefined;
        const cancel = () => {
          scope.dispose(true);
          void reader?.cancel().catch(() => {});
        };
        try {
          const target = (models[selected] ??= buildModel(endpointFor(selected), !!manim));
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
          scope.arm(manim ? start + attemptMs : deadline);
          report('stream_committed', start, timeoutMs, Date.now() - start);
          const initial = header ? [header, first] : [first];
          let completion: Completion | undefined = first.type === 'finish' ? first : undefined;
          let firstTokenMs: number | undefined;
          let sawReasoning = false;
          const observe = (part: Part) => {
            if (part.type === 'reasoning-delta' && part.delta) sawReasoning = true;
            if (
              firstTokenMs === undefined &&
              (part.type === 'text-delta' || part.type === 'reasoning-delta') &&
              part.delta
            )
              firstTokenMs = Date.now() - start;
            if (part.type === 'finish') completion = part;
          };
          observe(first);
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
                    if (completion) {
                      healthy();
                      report(
                        'success',
                        start,
                        manim ? attemptMs : timeoutMs,
                        undefined,
                        inferenceMetrics(options, completion, firstTokenMs, sawReasoning),
                      );
                      cancel();
                      controller.close();
                      return;
                    }
                    const next = await scope.wait(() => reader!.read());
                    if (next.done) throw new Error('Provider stream ended without finish.');
                    if (next.value.type === 'error') throw next.value.error;
                    observe(next.value);
                    controller.enqueue(next.value);
                  } catch (error) {
                    cancel();
                    try {
                      handleFailure(
                        error,
                        options,
                        start,
                        manim ? attemptMs : timeoutMs,
                        firstTokenMs,
                      );
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
          if (!handleFailure(error, options, start, timeoutMs)) throw error;
        }
      }
    },
  };
  return { model, usageMeta: meta, totalTimeoutMs };
}
