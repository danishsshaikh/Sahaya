import { TeachingVoiceError } from '@/lib/voice-cloning/types';
import type { VoiceComparisonProviderId } from '@/lib/voice-comparison/types';

export type ExternalVoiceProviderErrorCode =
  | 'BODHAN_AUTH_ERROR'
  | 'BODHAN_PERMISSION_ERROR'
  | 'BODHAN_RATE_LIMITED'
  | 'BODHAN_UPSTREAM_ERROR'
  | 'BODHAN_INVALID_AUDIO'
  | 'BODHAN_TIMEOUT'
  | 'SARVAM_UPSTREAM_ERROR';

export class ExternalVoiceProviderError extends TeachingVoiceError {
  constructor(
    message: string,
    status: number,
    readonly code: ExternalVoiceProviderErrorCode,
    readonly metadata: {
      provider: Extract<VoiceComparisonProviderId, 'sarvam' | 'bodhan'>;
      operation: 'voice_creation' | 'preview_generation';
      providerStatus?: number;
      providerCode?: string;
      requestId?: string;
      providerContentType?: string;
      responseBytes?: number;
      responseSignature?: string;
      safeDetail?: string;
    },
  ) {
    super(message, status);
    this.name = 'ExternalVoiceProviderError';
  }
}

export function requestIdFromResponse(response: Response): string | undefined {
  return (
    response.headers.get('x-request-id') ||
    response.headers.get('request-id') ||
    response.headers.get('x-correlation-id') ||
    undefined
  );
}

export function providerStatusMessage(
  providerName: string,
  providerStatus: number,
): { message: string; status: number } {
  if (providerStatus === 401) {
    return { message: `${providerName} authentication failed.`, status: 502 };
  }
  if (providerStatus === 402 || providerStatus === 403) {
    return {
      message: `${providerName} is unavailable for this account or subscription.`,
      status: 502,
    };
  }
  if (providerStatus === 429) {
    return { message: `${providerName} is rate limited or out of quota.`, status: 429 };
  }
  if (providerStatus >= 500) {
    return { message: `${providerName} is temporarily unavailable.`, status: 502 };
  }
  return { message: `${providerName} rejected this preview request.`, status: 400 };
}

export function boundedProviderDetail(value: unknown, privateText?: string): string | undefined {
  if (typeof value !== 'string') return undefined;
  let detail = value
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (privateText?.trim()) detail = detail.split(privateText).join('[input omitted]');
  detail = detail
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/(?:api[_ -]?key|authorization)\s*[:=]\s*[^\s,;]+/gi, 'credential=[redacted]');
  if (!detail) return undefined;
  return detail.slice(0, 240);
}

function retryAfterMilliseconds(response: Response): number | null {
  const value = response.headers.get('retry-after')?.trim();
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, Math.floor(seconds * 1000));
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

async function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener('abort', abort);
      resolve();
    };
    const timeout = setTimeout(finish, milliseconds);
    const abort = () => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      reject(signal?.reason ?? new DOMException('Request aborted', 'AbortError'));
    };
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export async function fetchExternalVoiceProvider(input: {
  url: string;
  init: () => RequestInit;
  timeoutMs: number;
  signal?: AbortSignal;
  retryRateLimit?: boolean;
}): Promise<Response> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const timeoutSignal = AbortSignal.timeout(input.timeoutMs);
    const signal = input.signal ? AbortSignal.any([input.signal, timeoutSignal]) : timeoutSignal;
    const response = await fetch(input.url, { ...input.init(), signal });
    if (response.status !== 429 || !input.retryRateLimit || attempt > 0) return response;
    const delay = retryAfterMilliseconds(response);
    if (delay === null || delay > 2000) return response;
    await wait(delay, input.signal);
  }
  throw new Error('Unreachable external voice retry state');
}
