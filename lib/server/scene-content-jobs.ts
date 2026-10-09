import { createHash } from 'crypto';
import { nanoid } from 'nanoid';
import type { SceneOutline } from '@/lib/types/generation';
import { createLogger } from '@/lib/logger';

const log = createLogger('SceneContentJob');

export type SceneContentJobStatus = 'queued' | 'generating' | 'completed' | 'failed';

export interface SceneContentJobResult {
  content: unknown;
  effectiveOutline: SceneOutline;
}

export interface SceneContentJob {
  id: string;
  ownerUserId: string;
  dedupeKey: string;
  status: SceneContentJobStatus;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
  stageId: string;
  outlineId?: string;
  outlineTitle: string;
  attemptId?: string;
  generationVersion?: string;
  widgetType?: string;
  modelString?: string;
  result?: SceneContentJobResult;
  error?: string;
}

export interface SceneContentJobStartInput {
  ownerUserId: string;
  dedupeKey: string;
  stageId: string;
  outlineId?: string;
  outlineTitle: string;
  attemptId?: string;
  generationVersion?: string;
  widgetType?: string;
  modelString?: string;
}

const TERMINAL_JOB_TTL_MS = 30 * 60 * 1000;
const ACTIVE_JOB_STALE_MS = 30 * 60 * 1000;
const MAX_JOBS = 100;
const jobs = new Map<string, SceneContentJob>();
const dedupeToJobId = new Map<string, string>();
const runningJobs = new Map<string, Promise<void>>();

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`;
}

export function createSceneContentDedupeKey(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function nowMs(): number {
  return Date.now();
}

function isTerminal(job: SceneContentJob): boolean {
  return job.status === 'completed' || job.status === 'failed';
}

function pruneJob(jobId: string): void {
  const job = jobs.get(jobId);
  if (job) dedupeToJobId.delete(job.dedupeKey);
  jobs.delete(jobId);
  runningJobs.delete(jobId);
}

export function cleanupSceneContentJobs(now = nowMs()): void {
  for (const [jobId, job] of jobs) {
    if (isTerminal(job) && now - job.updatedAt > TERMINAL_JOB_TTL_MS) {
      pruneJob(jobId);
      continue;
    }

    if (!isTerminal(job) && now - job.updatedAt > ACTIVE_JOB_STALE_MS) {
      jobs.set(jobId, {
        ...job,
        status: 'failed',
        updatedAt: now,
        completedAt: now,
        error: 'Scene content job expired before completion. Retry generation.',
      });
      runningJobs.delete(jobId);
    }
  }

  if (jobs.size <= MAX_JOBS) return;

  const terminalJobs = [...jobs.values()]
    .filter(isTerminal)
    .sort((a, b) => a.updatedAt - b.updatedAt);
  for (const job of terminalJobs) {
    if (jobs.size <= MAX_JOBS) break;
    pruneJob(job.id);
  }
}

export function createOrReuseSceneContentJob(input: SceneContentJobStartInput): {
  job: SceneContentJob;
  reused: boolean;
} {
  const now = nowMs();
  cleanupSceneContentJobs(now);

  const existingJobId = dedupeToJobId.get(input.dedupeKey);
  const existing = existingJobId ? jobs.get(existingJobId) : undefined;
  if (existing && existing.ownerUserId === input.ownerUserId && existing.status !== 'failed') {
    return { job: existing, reused: true };
  }

  const job: SceneContentJob = {
    id: nanoid(12),
    ownerUserId: input.ownerUserId,
    dedupeKey: input.dedupeKey,
    status: 'queued',
    createdAt: now,
    updatedAt: now,
    stageId: input.stageId,
    outlineId: input.outlineId,
    outlineTitle: input.outlineTitle,
    attemptId: input.attemptId,
    generationVersion: input.generationVersion,
    widgetType: input.widgetType,
    modelString: input.modelString,
  };

  jobs.set(job.id, job);
  dedupeToJobId.set(input.dedupeKey, job.id);
  return { job, reused: false };
}

export function readSceneContentJob(jobId: string, ownerUserId: string): SceneContentJob | null {
  cleanupSceneContentJobs();
  const job = jobs.get(jobId);
  if (!job || job.ownerUserId !== ownerUserId) return null;
  return job;
}

export function isValidSceneContentJobId(jobId: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(jobId);
}

function safeJobError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || 'Unknown error');
  return message.replace(/\s+/g, ' ').trim().slice(0, 300) || 'Scene content generation failed';
}

export function runSceneContentJob(
  jobId: string,
  generate: () => Promise<SceneContentJobResult>,
): Promise<void> {
  const existingRun = runningJobs.get(jobId);
  if (existingRun) return existingRun;

  const run = (async () => {
    const startedAt = nowMs();
    const queued = jobs.get(jobId);
    if (!queued || isTerminal(queued)) return;

    jobs.set(jobId, {
      ...queued,
      status: 'generating',
      startedAt,
      updatedAt: startedAt,
    });

    try {
      const result = await generate();
      const completedAt = nowMs();
      const latest = jobs.get(jobId);
      if (!latest) return;

      jobs.set(jobId, {
        ...latest,
        status: 'completed',
        result,
        updatedAt: completedAt,
        completedAt,
      });
      log.info(`Scene content job completed: ${jobId}`, {
        stageId: latest.stageId,
        outlineId: latest.outlineId,
        widgetType: latest.widgetType,
        durationMs: completedAt - startedAt,
      });
    } catch (error) {
      const completedAt = nowMs();
      const latest = jobs.get(jobId);
      if (!latest) return;

      const safeError = safeJobError(error);
      jobs.set(jobId, {
        ...latest,
        status: 'failed',
        error: safeError,
        updatedAt: completedAt,
        completedAt,
      });
      log.error(`Scene content job failed: ${jobId}`, {
        stageId: latest.stageId,
        outlineId: latest.outlineId,
        widgetType: latest.widgetType,
        durationMs: completedAt - startedAt,
        error: safeError,
      });
    } finally {
      runningJobs.delete(jobId);
    }
  })();

  runningJobs.set(jobId, run);
  return run;
}

export function clearSceneContentJobsForTests(): void {
  jobs.clear();
  dedupeToJobId.clear();
  runningJobs.clear();
}
