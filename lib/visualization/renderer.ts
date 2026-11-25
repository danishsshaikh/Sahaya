import { createHash } from 'node:crypto';
import type { VisualizationContent } from '@openmaic/dsl';
import { readFeatureFlagBoolean } from '@/lib/config/feature-flags';

export type RenderQuality = VisualizationContent['artifact']['quality'];
export type RenderIssue = {
  code: string;
  message?: string;
  line?: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
  category?: string;
  symbol?: string;
  exception?: string;
  apiSymbols?: string[];
};
export interface RenderJob {
  id?: string;
  status: 'queued' | 'rendering' | 'processing' | 'completed' | 'failed' | 'cancelled';
  queuePosition?: number;
  artifact?: VisualizationContent['artifact'] & {
    sandboxImage?: string;
    verification?: { media?: string };
  };
  errorCode?: string;
  issue?: RenderIssue;
  diagnosticId?: string;
  cacheHit?: boolean;
}

export class RendererError extends Error {
  constructor(
    readonly status: number,
    readonly issue?: RenderIssue,
    readonly diagnosticId?: string,
  ) {
    super(issue?.message || 'Visualization renderer request failed.');
  }
}

export function rendererSettings() {
  const token = process.env.MANIM_RENDERER_TOKEN?.trim();
  const endpoint = process.env.MANIM_RENDERER_URL?.trim();
  if (!token || !/^[A-Za-z0-9_-]{24,128}$/.test(token) || !endpoint) return null;
  try {
    const url = new URL(endpoint);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return null;
    return { url: url.href.replace(/\/$/, ''), token };
  } catch {
    return null;
  }
}

type Capability = {
  available: boolean;
  reason?: string;
  maxDuration?: number;
  reachable?: boolean;
  rendererReady?: boolean;
  secureExecution?: boolean;
  isolation?: string;
  apiPreflight?: string;
};

let check: { key: string; until: number; result: Promise<Capability> } | undefined;

export function getVisualizationCapability(): Promise<Capability> {
  const enabled = readFeatureFlagBoolean(process.env.OPENMAIC_ENABLE_MANIM);
  const settings = rendererSettings();
  if (!enabled)
    return Promise.resolve({ available: false, reason: 'Visualization generation is disabled.' });
  if (!settings)
    return Promise.resolve({
      available: false,
      reason: 'Configure the private Manim publisher endpoint and token.',
    });
  const key = createHash('sha256').update(settings.url).update(settings.token).digest('hex');
  if (check?.key === key && check.until > Date.now()) return check.result;
  const result = (async (): Promise<Capability> => {
    try {
      const response = await rendererFetch('sahaya-readiness', '/ready', {
        signal: AbortSignal.timeout(2800),
      });
      const ready = response.ok ? await response.json() : null;
      if (
        ready?.protocol !== 4 ||
        ready?.manimVersion !== '0.22.1' ||
        ready.rendererReady !== true ||
        !Number.isFinite(ready.maxDuration)
      ) {
        return {
          available: false,
          reachable: response.ok,
          rendererReady: false,
          reason: 'Update the Manim publisher to protocol 4.',
        };
      }
      const secureExecution =
        ready.secureExecution === true &&
        ready.isolation === 'verified' &&
        (ready.backend === 'gvisor' || ready.backend === 'bubblewrap') &&
        /^sha256:[a-f0-9]{64}$/.test(ready.sandboxImage);
      return {
        available: secureExecution,
        reachable: true,
        rendererReady: true,
        secureExecution,
        maxDuration: ready.maxDuration,
        isolation: typeof ready.isolation === 'string' ? ready.isolation : 'unavailable',
        apiPreflight: typeof ready.apiPreflight === 'string' ? ready.apiPreflight : undefined,
        ...(!secureExecution && {
          reason:
            'Visualization generation requires a verified university-approved sandbox executor.',
        }),
      };
    } catch {
      return { available: false, reachable: false, reason: 'The Manim publisher is unavailable.' };
    }
  })();
  check = { key, until: Date.now() + 5000, result };
  return result;
}

export function configuredQuality(preview: boolean): RenderQuality {
  const quality = process.env.MANIM_FINAL_QUALITY;
  return preview ? 'preview' : quality === 'high' ? 'high' : 'standard';
}

export async function rendererFetch(
  ownerId: string,
  pathname: string,
  options: RequestInit = {},
  streaming = false,
): Promise<Response> {
  const settings = rendererSettings();
  if (!settings) throw new RendererError(503);
  const headers = new Headers(options.headers);
  headers.set('Authorization', `Bearer ${settings.token}`);
  headers.set('X-Manim-Owner', createHash('sha256').update(ownerId).digest('hex'));
  const headerDeadline = streaming ? new AbortController() : undefined;
  const headerTimer = headerDeadline ? setTimeout(() => headerDeadline.abort(), 15_000) : undefined;
  const timeout = headerDeadline?.signal ?? AbortSignal.timeout(15_000);
  try {
    return await fetch(`${settings.url}${pathname}`, {
      ...options,
      headers,
      cache: 'no-store',
      redirect: 'error',
      signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
    });
  } catch {
    options.signal?.throwIfAborted();
    throw new RendererError(503);
  } finally {
    if (headerTimer) clearTimeout(headerTimer);
  }
}

export async function readRenderJob(response: Response): Promise<RenderJob> {
  const payload = (await response.json().catch(() => null)) as RenderJob | null;
  if (!response.ok) throw new RendererError(response.status, payload?.issue, payload?.diagnosticId);
  if (
    !payload ||
    !['queued', 'rendering', 'processing', 'completed', 'failed', 'cancelled'].includes(
      payload.status,
    )
  )
    throw new RendererError(502);
  return payload;
}
