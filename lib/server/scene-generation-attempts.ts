import { createHash } from 'crypto';
import { nanoid } from 'nanoid';
import type { SceneOutline } from '@/lib/types/generation';
import type { Scene } from '@/lib/types/stage';

// Single-process authority for the current deployment. The API is deliberately
// isolated so a shared lease store can replace these maps when Sahaya runs more
// than one app process; client refs and Zustand state never participate.

const ACTIVE_ATTEMPT_LEASE_MS = 20 * 60 * 1000;
const TERMINAL_ATTEMPT_TTL_MS = 30 * 60 * 1000;
const MAX_ATTEMPTS = 500;

export type SceneGenerationAttemptStatus =
  | 'admitted'
  | 'content-running'
  | 'content-complete'
  | 'actions-running'
  | 'ready-to-commit'
  | 'committed'
  | 'failed';

export interface SceneGenerationAttemptIdentity {
  attemptId: string;
  generationVersion: string;
  stageId: string;
  outlineId: string;
}

interface SceneContentValue {
  content: unknown;
  effectiveOutline: SceneOutline;
}

interface SceneActionsValue {
  scene: Scene;
  previousSpeeches: string[];
}

interface SceneGenerationAttempt extends SceneGenerationAttemptIdentity {
  ownerUserId: string;
  key: string;
  status: SceneGenerationAttemptStatus;
  createdAt: number;
  updatedAt: number;
  contentValue?: SceneContentValue;
  contentHash?: string;
  contentPromise?: Promise<SceneContentValue>;
  actionsValue?: SceneActionsValue;
  actionsPromise?: Promise<SceneActionsValue>;
  error?: string;
}

export class SceneGenerationAttemptError extends Error {
  constructor(
    message: string,
    readonly code: 'GENERATION_ATTEMPT_INVALID' | 'GENERATION_ATTEMPT_STALE',
  ) {
    super(message);
    this.name = 'SceneGenerationAttemptError';
  }
}

const attemptsById = new Map<string, SceneGenerationAttempt>();
const currentAttemptByKey = new Map<string, string>();

function stableStringify(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`;
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

export function createSceneGenerationVersion(input: {
  outline: unknown;
  allOutlines: unknown;
}): string {
  return fingerprint(input);
}

function attemptKey(input: {
  ownerUserId: string;
  stageId: string;
  outlineId: string;
  generationVersion: string;
}): string {
  return fingerprint({
    ownerUserId: input.ownerUserId,
    stageId: input.stageId,
    outlineId: input.outlineId,
    generationVersion: input.generationVersion,
  });
}

function isTerminal(status: SceneGenerationAttemptStatus): boolean {
  return status === 'committed' || status === 'failed';
}

function publicIdentity(attempt: SceneGenerationAttempt): SceneGenerationAttemptIdentity {
  return {
    attemptId: attempt.attemptId,
    generationVersion: attempt.generationVersion,
    stageId: attempt.stageId,
    outlineId: attempt.outlineId,
  };
}

function safeAttemptId(proposedAttemptId: string | undefined): string {
  const candidate =
    proposedAttemptId && /^[a-zA-Z0-9_-]{8,128}$/.test(proposedAttemptId)
      ? proposedAttemptId
      : nanoid(18);
  return attemptsById.has(candidate) ? nanoid(18) : candidate;
}

function pruneAttempt(attempt: SceneGenerationAttempt): void {
  attemptsById.delete(attempt.attemptId);
  if (currentAttemptByKey.get(attempt.key) === attempt.attemptId) {
    currentAttemptByKey.delete(attempt.key);
  }
}

export function cleanupSceneGenerationAttempts(now = Date.now()): void {
  for (const attempt of attemptsById.values()) {
    if (!isTerminal(attempt.status) && now - attempt.updatedAt > ACTIVE_ATTEMPT_LEASE_MS) {
      attempt.status = 'failed';
      attempt.updatedAt = now;
      attempt.error = 'Scene generation ownership expired before completion.';
      attempt.contentPromise = undefined;
      attempt.actionsPromise = undefined;
      if (currentAttemptByKey.get(attempt.key) === attempt.attemptId) {
        currentAttemptByKey.delete(attempt.key);
      }
      continue;
    }
    if (isTerminal(attempt.status) && now - attempt.updatedAt > TERMINAL_ATTEMPT_TTL_MS) {
      pruneAttempt(attempt);
    }
  }

  if (attemptsById.size <= MAX_ATTEMPTS) return;
  const terminal = [...attemptsById.values()]
    .filter((attempt) => isTerminal(attempt.status))
    .sort((a, b) => a.updatedAt - b.updatedAt);
  for (const attempt of terminal) {
    if (attemptsById.size <= MAX_ATTEMPTS) break;
    pruneAttempt(attempt);
  }
}

export function admitSceneGenerationAttempt(input: {
  ownerUserId: string;
  stageId: string;
  outlineId: string;
  generationVersion: string;
  proposedAttemptId?: string;
}): { identity: SceneGenerationAttemptIdentity; reused: boolean } {
  const now = Date.now();
  cleanupSceneGenerationAttempts(now);
  const key = attemptKey(input);
  const currentId = currentAttemptByKey.get(key);
  const current = currentId ? attemptsById.get(currentId) : undefined;
  if (current && current.status !== 'failed') {
    return { identity: publicIdentity(current), reused: true };
  }

  const attempt: SceneGenerationAttempt = {
    attemptId: safeAttemptId(input.proposedAttemptId),
    generationVersion: input.generationVersion,
    ownerUserId: input.ownerUserId,
    stageId: input.stageId,
    outlineId: input.outlineId,
    key,
    status: 'admitted',
    createdAt: now,
    updatedAt: now,
  };
  attemptsById.set(attempt.attemptId, attempt);
  currentAttemptByKey.set(key, attempt.attemptId);
  return { identity: publicIdentity(attempt), reused: false };
}

function requireCurrentAttempt(
  ownerUserId: string,
  identity: SceneGenerationAttemptIdentity,
): SceneGenerationAttempt {
  const attempt = attemptsById.get(identity.attemptId);
  if (
    !attempt ||
    attempt.ownerUserId !== ownerUserId ||
    attempt.stageId !== identity.stageId ||
    attempt.outlineId !== identity.outlineId ||
    attempt.generationVersion !== identity.generationVersion
  ) {
    throw new SceneGenerationAttemptError(
      'Scene generation attempt identity is invalid.',
      'GENERATION_ATTEMPT_INVALID',
    );
  }
  if (currentAttemptByKey.get(attempt.key) !== attempt.attemptId || attempt.status === 'failed') {
    throw new SceneGenerationAttemptError(
      'Scene generation attempt is no longer authoritative.',
      'GENERATION_ATTEMPT_STALE',
    );
  }
  return attempt;
}

function failIfCurrent(attempt: SceneGenerationAttempt, error: unknown): void {
  if (currentAttemptByKey.get(attempt.key) !== attempt.attemptId) return;
  attempt.status = 'failed';
  attempt.updatedAt = Date.now();
  attempt.error = error instanceof Error ? error.message : String(error);
  currentAttemptByKey.delete(attempt.key);
}

export async function runSceneAttemptContent(
  ownerUserId: string,
  identity: SceneGenerationAttemptIdentity,
  generate: () => Promise<SceneContentValue>,
): Promise<SceneContentValue> {
  const attempt = requireCurrentAttempt(ownerUserId, identity);
  if (attempt.contentValue) return attempt.contentValue;
  if (attempt.contentPromise) return attempt.contentPromise;

  attempt.status = 'content-running';
  attempt.updatedAt = Date.now();
  const promise = (async () => {
    try {
      const value = await generate();
      requireCurrentAttempt(ownerUserId, identity);
      attempt.contentValue = value;
      attempt.contentHash = fingerprint(value.content);
      attempt.status = 'content-complete';
      attempt.updatedAt = Date.now();
      return value;
    } catch (error) {
      failIfCurrent(attempt, error);
      throw error;
    } finally {
      attempt.contentPromise = undefined;
    }
  })();
  attempt.contentPromise = promise;
  return promise;
}

export async function runSceneAttemptActions(
  ownerUserId: string,
  identity: SceneGenerationAttemptIdentity,
  content: unknown,
  generate: () => Promise<SceneActionsValue>,
): Promise<SceneActionsValue> {
  const attempt = requireCurrentAttempt(ownerUserId, identity);
  if (!attempt.contentValue || attempt.contentHash !== fingerprint(content)) {
    throw new SceneGenerationAttemptError(
      'Scene actions do not match the authoritative content result.',
      'GENERATION_ATTEMPT_INVALID',
    );
  }
  if (attempt.actionsValue) return attempt.actionsValue;
  if (attempt.actionsPromise) return attempt.actionsPromise;

  attempt.status = 'actions-running';
  attempt.updatedAt = Date.now();
  const promise = (async () => {
    try {
      const value = await generate();
      requireCurrentAttempt(ownerUserId, identity);
      attempt.actionsValue = value;
      attempt.status = 'ready-to-commit';
      attempt.updatedAt = Date.now();
      return value;
    } catch (error) {
      failIfCurrent(attempt, error);
      throw error;
    } finally {
      attempt.actionsPromise = undefined;
    }
  })();
  attempt.actionsPromise = promise;
  return promise;
}

export function commitSceneGenerationAttempt(
  ownerUserId: string,
  identity: SceneGenerationAttemptIdentity,
  sceneId: string,
): { accepted: true; alreadyCommitted: boolean } {
  const attempt = requireCurrentAttempt(ownerUserId, identity);
  if (!attempt.actionsValue || attempt.actionsValue.scene.id !== sceneId) {
    throw new SceneGenerationAttemptError(
      'Scene commit does not match the authoritative actions result.',
      'GENERATION_ATTEMPT_INVALID',
    );
  }
  if (attempt.status === 'committed') return { accepted: true, alreadyCommitted: true };
  if (attempt.status !== 'ready-to-commit') {
    throw new SceneGenerationAttemptError(
      'Scene generation attempt is not ready to commit.',
      'GENERATION_ATTEMPT_INVALID',
    );
  }
  attempt.status = 'committed';
  attempt.updatedAt = Date.now();
  return { accepted: true, alreadyCommitted: false };
}

export function sceneGenerationAttemptSnapshotForTests(attemptId: string) {
  const attempt = attemptsById.get(attemptId);
  return attempt
    ? {
        ...publicIdentity(attempt),
        ownerUserId: attempt.ownerUserId,
        status: attempt.status,
      }
    : null;
}

export function clearSceneGenerationAttemptsForTests(): void {
  attemptsById.clear();
  currentAttemptByKey.clear();
}
