import { nanoid } from 'nanoid';
import { createLogger } from '@/lib/logger';

const log = createLogger('GenerationQueue');

export type ResourceJobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface ResourceJobMetadata {
  provider?: string;
  stageId?: string;
  outlineId?: string;
  sceneId?: string;
  profileId?: string;
}

export interface ResourceJobSnapshot {
  id: string;
  resourceKey: string;
  status: ResourceJobStatus;
  enqueuedAt: number;
  startedAt?: number;
  completedAt?: number;
  queuePosition: number | null;
  jobsAhead: number | null;
  queueDepth: number;
  estimatedWaitMs: number | null;
  attemptCount: number;
  error?: string;
  metadata: ResourceJobMetadata;
}

interface ResourceJob extends Omit<
  ResourceJobSnapshot,
  'queuePosition' | 'jobsAhead' | 'queueDepth' | 'estimatedWaitMs'
> {
  ownerId: string;
  idempotencyKey: string;
  run: (jobId: string) => Promise<unknown>;
  result?: unknown;
  updatedAt: number;
}

interface ResourceState {
  concurrency: number;
  pending: string[];
  running: Set<string>;
  successfulDurationsMs: number[];
  drainScheduled: boolean;
}

export interface EnqueueResourceJobInput<TResult> {
  resourceKey: string;
  concurrency: number;
  ownerId: string;
  idempotencyKey: string;
  metadata?: ResourceJobMetadata;
  run: (jobId: string) => Promise<TResult>;
}

const DEFAULT_TERMINAL_TTL_MS = 15 * 60 * 1000;
const MAX_SUCCESSFUL_DURATION_SAMPLES = 8;
const MAX_RETAINED_JOBS = 250;

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || 'Unknown error');
  return message.replace(/\s+/g, ' ').trim().slice(0, 300) || 'Generation job failed';
}

function isTerminal(status: ResourceJobStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

/**
 * Process-local resource queue for the current single-server Sahaya deployment.
 * A multi-replica deployment must replace this with a shared external broker.
 */
export class ResourceJobQueue {
  private readonly jobs = new Map<string, ResourceJob>();
  private readonly idempotency = new Map<string, string>();
  private readonly resources = new Map<string, ResourceState>();

  constructor(
    private readonly terminalTtlMs = DEFAULT_TERMINAL_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  enqueue<TResult>(input: EnqueueResourceJobInput<TResult>): {
    job: ResourceJobSnapshot;
    reused: boolean;
  } {
    this.cleanup();
    const dedupeKey = `${input.resourceKey}:${input.ownerId}:${input.idempotencyKey}`;
    const existingId = this.idempotency.get(dedupeKey);
    const existing = existingId ? this.jobs.get(existingId) : undefined;
    if (existing && !['failed', 'cancelled'].includes(existing.status)) {
      const snapshot = this.snapshot(existing);
      this.trace('job-reused-idempotently', existing, snapshot);
      return { job: snapshot, reused: true };
    }

    const now = this.now();
    const job: ResourceJob = {
      id: `rq_${nanoid(24)}`,
      resourceKey: input.resourceKey,
      ownerId: input.ownerId,
      idempotencyKey: input.idempotencyKey,
      status: 'queued',
      enqueuedAt: now,
      updatedAt: now,
      attemptCount: 0,
      metadata: input.metadata ?? {},
      run: input.run,
    };
    this.jobs.set(job.id, job);
    this.idempotency.set(dedupeKey, job.id);
    const resource = this.resource(input.resourceKey, input.concurrency);
    resource.pending.push(job.id);
    const snapshot = this.snapshot(job);
    this.trace('job-enqueued', job, snapshot);
    this.scheduleDrain(job.resourceKey);
    return { job: snapshot, reused: false };
  }

  read(jobId: string, ownerId: string): ResourceJobSnapshot | null {
    this.cleanup();
    const job = this.jobs.get(jobId);
    return job && job.ownerId === ownerId ? this.snapshot(job) : null;
  }

  result<TResult>(jobId: string, ownerId: string): TResult | null {
    this.cleanup();
    const job = this.jobs.get(jobId);
    if (!job || job.ownerId !== ownerId || job.status !== 'completed' || job.result === undefined) {
      return null;
    }
    return job.result as TResult;
  }

  cancel(jobId: string, ownerId: string): ResourceJobSnapshot | null {
    const job = this.jobs.get(jobId);
    if (!job || job.ownerId !== ownerId) return null;
    if (job.status !== 'queued') return this.snapshot(job);

    const now = this.now();
    job.status = 'cancelled';
    job.updatedAt = now;
    job.completedAt = now;
    const resource = this.resources.get(job.resourceKey);
    if (resource) resource.pending = resource.pending.filter((id) => id !== job.id);
    const snapshot = this.snapshot(job);
    this.trace('job-cancelled', job, snapshot);
    this.scheduleTerminalCleanup();
    return snapshot;
  }

  cleanup(now = this.now()): void {
    for (const [jobId, job] of this.jobs) {
      if (isTerminal(job.status) && now - job.updatedAt > this.terminalTtlMs) {
        this.remove(jobId, 'job-cleaned-up');
      }
    }

    if (this.jobs.size <= MAX_RETAINED_JOBS) return;
    const terminal = [...this.jobs.values()]
      .filter((job) => isTerminal(job.status))
      .sort((a, b) => a.updatedAt - b.updatedAt);
    for (const job of terminal) {
      if (this.jobs.size <= MAX_RETAINED_JOBS) break;
      this.remove(job.id, 'job-cleaned-up');
    }
  }

  clear(): void {
    this.jobs.clear();
    this.idempotency.clear();
    this.resources.clear();
  }

  private resource(resourceKey: string, concurrency: number): ResourceState {
    const existing = this.resources.get(resourceKey);
    if (existing) return existing;
    const resource: ResourceState = {
      concurrency: Math.max(1, Math.floor(concurrency)),
      pending: [],
      running: new Set(),
      successfulDurationsMs: [],
      drainScheduled: false,
    };
    this.resources.set(resourceKey, resource);
    return resource;
  }

  private scheduleDrain(resourceKey: string): void {
    const resource = this.resources.get(resourceKey);
    if (!resource || resource.drainScheduled) return;
    resource.drainScheduled = true;
    queueMicrotask(() => {
      resource.drainScheduled = false;
      this.drain(resourceKey);
    });
  }

  private drain(resourceKey: string): void {
    const resource = this.resources.get(resourceKey);
    if (!resource) return;
    while (resource.running.size < resource.concurrency && resource.pending.length > 0) {
      const jobId = resource.pending.shift();
      const job = jobId ? this.jobs.get(jobId) : undefined;
      if (!job || job.status !== 'queued') continue;

      const startedAt = this.now();
      job.status = 'running';
      job.startedAt = startedAt;
      job.updatedAt = startedAt;
      job.attemptCount += 1;
      resource.running.add(job.id);
      this.trace('worker-slot-acquired', job, this.snapshot(job));
      this.trace('job-started', job, this.snapshot(job));

      void Promise.resolve()
        .then(() => job.run(job.id))
        .then((result) => {
          const completedAt = this.now();
          job.status = 'completed';
          job.result = result;
          job.completedAt = completedAt;
          job.updatedAt = completedAt;
          job.run = async () => undefined;
          const runMs = completedAt - startedAt;
          resource.successfulDurationsMs.push(runMs);
          resource.successfulDurationsMs = resource.successfulDurationsMs.slice(
            -MAX_SUCCESSFUL_DURATION_SAMPLES,
          );
          this.trace('job-completed', job, this.snapshot(job), { runMs });
          this.scheduleTerminalCleanup();
        })
        .catch((error: unknown) => {
          const completedAt = this.now();
          job.status = 'failed';
          job.error = safeError(error);
          job.completedAt = completedAt;
          job.updatedAt = completedAt;
          job.run = async () => undefined;
          this.trace('job-failed', job, this.snapshot(job), {
            runMs: completedAt - startedAt,
            error: job.error,
          });
          this.scheduleTerminalCleanup();
        })
        .finally(() => {
          resource.running.delete(job.id);
          this.scheduleDrain(resourceKey);
        });
    }
  }

  private snapshot(job: ResourceJob): ResourceJobSnapshot {
    const resource = this.resources.get(job.resourceKey);
    const pendingIndex = resource?.pending.indexOf(job.id) ?? -1;
    const runningCount = resource?.running.size ?? 0;
    const jobsAhead =
      job.status === 'queued' && pendingIndex >= 0 ? runningCount + pendingIndex : null;
    const queuePosition = jobsAhead === null ? null : jobsAhead + 1;
    const queueDepth = (resource?.pending.length ?? 0) + runningCount;
    return {
      id: job.id,
      resourceKey: job.resourceKey,
      status: job.status,
      enqueuedAt: job.enqueuedAt,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      queuePosition,
      jobsAhead,
      queueDepth,
      estimatedWaitMs: this.estimatedWaitMs(job, pendingIndex, resource),
      attemptCount: job.attemptCount,
      error: job.error,
      metadata: job.metadata,
    };
  }

  private estimatedWaitMs(
    job: ResourceJob,
    pendingIndex: number,
    resource: ResourceState | undefined,
  ): number | null {
    if (job.status !== 'queued' || pendingIndex < 0 || !resource?.successfulDurationsMs.length) {
      return null;
    }
    const average =
      resource.successfulDurationsMs.reduce((sum, duration) => sum + duration, 0) /
      resource.successfulDurationsMs.length;
    let estimate = pendingIndex * average;
    for (const runningId of resource.running) {
      const running = this.jobs.get(runningId);
      estimate += Math.max(0, average - (this.now() - (running?.startedAt ?? this.now())));
    }
    return Math.max(0, Math.round(estimate));
  }

  private remove(jobId: string, event: string): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    const dedupeKey = `${job.resourceKey}:${job.ownerId}:${job.idempotencyKey}`;
    if (this.idempotency.get(dedupeKey) === jobId) this.idempotency.delete(dedupeKey);
    this.resources.get(job.resourceKey)?.running.delete(jobId);
    const resource = this.resources.get(job.resourceKey);
    if (resource) resource.pending = resource.pending.filter((id) => id !== jobId);
    this.jobs.delete(jobId);
    this.trace(event, job, null);
  }

  private scheduleTerminalCleanup(): void {
    const timer = setTimeout(() => this.cleanup(), this.terminalTtlMs + 1);
    if (typeof timer === 'object' && 'unref' in timer) timer.unref();
  }

  private trace(
    event: string,
    job: ResourceJob,
    snapshot: ResourceJobSnapshot | null,
    extra: Record<string, unknown> = {},
  ): void {
    log.info('[GenerationQueue]', {
      event,
      jobId: job.id,
      resourceKey: job.resourceKey,
      status: job.status,
      provider: job.metadata.provider,
      stageId: job.metadata.stageId,
      outlineId: job.metadata.outlineId,
      sceneId: job.metadata.sceneId,
      queuePosition: snapshot?.queuePosition,
      queueDepth: snapshot?.queueDepth,
      jobsAhead: snapshot?.jobsAhead,
      estimatedWaitMs: snapshot?.estimatedWaitMs,
      attempt: job.attemptCount,
      waitMs: job.startedAt ? job.startedAt - job.enqueuedAt : undefined,
      totalMs: job.completedAt ? job.completedAt - job.enqueuedAt : undefined,
      ...extra,
    });
  }
}

type QueueGlobal = typeof globalThis & {
  __openmaicResourceJobQueue?: ResourceJobQueue;
};

export function getResourceJobQueue(): ResourceJobQueue {
  const global = globalThis as QueueGlobal;
  global.__openmaicResourceJobQueue ??= new ResourceJobQueue();
  return global.__openmaicResourceJobQueue;
}

export function clearResourceJobQueueForTests(): void {
  getResourceJobQueue().clear();
}
