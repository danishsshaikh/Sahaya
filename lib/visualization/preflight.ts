import { rendererFetch, RendererError, type RenderIssue } from './renderer';
import { MANIM_VERSION } from './skill';
import type { Candidate } from './submission';

export type ApiFinding = {
  kind: string;
  line: number;
  symbol: string;
  severity: 'error' | 'warning';
  alternatives: string[];
};

export type PreflightResult = {
  version: string;
  source?: string;
  normalization?: { line: number };
  findings: ApiFinding[];
  issue?: RenderIssue;
};

export function readPreflight(value: PreflightResult) {
  if (value?.version !== MANIM_VERSION) throw new RendererError(503);
  if (!Array.isArray(value.findings) || (!value.issue && typeof value.source !== 'string'))
    throw new RendererError(502);
  return value;
}

export async function preflightCandidate(owner: string, candidate: Candidate, signal: AbortSignal) {
  const timeout = AbortSignal.timeout(4000);
  try {
    const response = await rendererFetch(owner, '/preflight', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...candidate, minimums: {}, quality: 'preview', publication: 'none' }),
      signal: AbortSignal.any([signal, timeout]),
    });
    if (!response.ok) throw new RendererError(response.status);
    return readPreflight(await response.json());
  } catch (error) {
    signal.throwIfAborted();
    if (timeout.aborted) throw new RendererError(503);
    throw error;
  }
}
