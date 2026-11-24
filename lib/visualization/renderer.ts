import type { PlanIssue } from './plan-contract';
import { createHash } from 'node:crypto';
import type { VisualizationContent } from '@openmaic/dsl';
import { readFeatureFlagBoolean } from '@/lib/config/feature-flags';

export type RenderQuality = VisualizationContent['artifact']['quality'];
type RenderArtifact = VisualizationContent['artifact'];
export interface RenderJob {
  id?: string;
  status: 'queued' | 'rendering' | 'processing' | 'completed' | 'failed' | 'cancelled';
  queuePosition?: number;
  artifact?: RenderArtifact;
  error?: string;
  errorCode?: string;
  issues?: PlanIssue[];
  blocked?: string[];
  truncated?: boolean;
  diagnosticId?: string;
}

export class RendererError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly issues: PlanIssue[] = [],
    readonly validation?: Pick<RenderJob, 'blocked' | 'truncated' | 'diagnosticId'>,
  ) {
    super(message);
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

function enabled() {
  return readFeatureFlagBoolean(process.env.OPENMAIC_ENABLE_MANIM);
}

export function customPythonRequested() {
  return readFeatureFlagBoolean(process.env.MANIM_EXPERIMENTAL_CUSTOM_PYTHON);
}

let check:
  | {
      key: string;
      until: number;
      result: Promise<{ available: boolean; reason?: string; maxDuration?: number }>;
    }
  | undefined;

export function getVisualizationCapability() {
  const settings = rendererSettings();
  if (!enabled())
    return Promise.resolve({ available: false, reason: 'Visualization generation is disabled.' });
  if (!settings)
    return Promise.resolve({
      available: false,
      reason: 'Configure the private Manim renderer endpoint and token.',
    });
  const key = createHash('sha256').update(settings.url).update(settings.token).digest('hex');
  if (check?.key === key && check.until > Date.now()) return check.result;
  const result = (async () => {
    try {
      const response = await rendererFetch('sahaya-readiness', '/ready', {
        signal: AbortSignal.timeout(2000),
      });
      const health = response.ok ? await response.json() : null;
      if (typeof health?.version === 'string' && Number.isFinite(health.maxDuration)) {
        if (health.validationProtocol !== 3) {
          return {
            available: false,
            reason: 'Rebuild the Manim renderer image to enable visualization planning.',
          };
        }
        return { available: true, maxDuration: health.maxDuration as number };
      }
    } catch {
      // A missing optional service must not prevent ordinary lesson generation.
    }
    return {
      available: false,
      reason: 'The Manim renderer is unavailable. Start the visualization service and try again.',
    };
  })();
  check = { key, until: Date.now() + 10_000, result };
  return result;
}

export function configuredQuality(preview: boolean): RenderQuality {
  const quality = preview ? process.env.MANIM_PREVIEW_QUALITY : process.env.MANIM_FINAL_QUALITY;
  return quality === 'preview' || quality === 'high' || quality === 'standard'
    ? quality
    : preview
      ? 'preview'
      : 'standard';
}

export async function rendererFetch(
  ownerId: string,
  pathname: string,
  options: RequestInit = {},
  streaming = false,
): Promise<Response> {
  const settings = rendererSettings();
  if (!settings) throw new RendererError('The Manim renderer is unavailable.', 503);
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
    throw new RendererError('The Manim renderer could not be reached. Try again shortly.', 503);
  } finally {
    if (headerTimer) clearTimeout(headerTimer);
  }
}

export async function readRenderJob(response: Response): Promise<RenderJob> {
  const payload = (await response.json().catch(() => null)) as RenderJob | null;
  if (!response.ok) {
    throw new RendererError(
      payload?.error || 'The renderer rejected the visualization.',
      response.status,
      Array.isArray(payload?.issues) ? payload.issues.slice(0, 24) : [],
      payload
        ? {
            blocked: payload.blocked,
            truncated: payload.truncated,
            diagnosticId: payload.diagnosticId,
          }
        : undefined,
    );
  }
  if (
    !payload ||
    !['queued', 'rendering', 'processing', 'completed', 'failed', 'cancelled'].includes(
      payload.status,
    )
  ) {
    throw new RendererError('The rendering service returned an invalid status.', 502);
  }
  return payload;
}
