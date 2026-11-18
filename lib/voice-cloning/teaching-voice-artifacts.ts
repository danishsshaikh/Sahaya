import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { nanoid } from 'nanoid';
import { measureAudioDuration } from '@/lib/audio/audio-duration';
import { getVoiceCloningStorageDir } from '@/lib/voice-cloning/config';
import type { ResourceJobMetadata, ResourceJobSnapshot } from '@/lib/server/resource-job-queue';

const ARTIFACT_VERSION = 1;
const JOB_ID_PATTERN = /^rq_[a-zA-Z0-9_-]{20,}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[a-f0-9]{64}$/;
const DEFAULT_ARTIFACT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_ARTIFACT_TTL_MS = 60 * 60 * 1000;
const MAX_ARTIFACT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;

type SupportedArtifactFormat = 'wav' | 'mp3';

export interface TeachingVoiceArtifactManifest {
  version: 1;
  jobId: string;
  ownerHash: string;
  idempotencyKey: string;
  format: SupportedArtifactFormat;
  byteLength: number;
  audioSha256: string;
  durationSeconds: number;
  createdAt: number;
  expiresAt: number;
  metadata: ResourceJobMetadata;
}

export interface TeachingVoiceArtifactResult {
  manifest: TeachingVoiceArtifactManifest;
  audio: Uint8Array;
  format: SupportedArtifactFormat;
}

export class TeachingVoiceArtifactInvalidError extends Error {
  constructor(
    message = 'Teaching Voice audio artifact is invalid.',
    readonly kind: 'missing' | 'invalid' = 'invalid',
  ) {
    super(message);
    this.name = 'TeachingVoiceArtifactInvalidError';
  }
}

function artifactTtlMs(): number {
  const parsed = Number(process.env.TEACHING_VOICE_JOB_ARTIFACT_TTL_MS);
  if (!Number.isFinite(parsed)) return DEFAULT_ARTIFACT_TTL_MS;
  return Math.max(MIN_ARTIFACT_TTL_MS, Math.min(MAX_ARTIFACT_TTL_MS, Math.floor(parsed)));
}

function artifactRoot(): string {
  const configured = process.env.TEACHING_VOICE_JOB_ARTIFACT_DIR?.trim();
  return configured || path.join(getVoiceCloningStorageDir(), 'teaching-voice-job-artifacts-v1');
}

function hash(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function ownerHash(ownerId: string): string {
  return hash(`sahaya-teaching-voice-owner:${ownerId}`);
}

function assertJobId(jobId: string): void {
  if (!JOB_ID_PATTERN.test(jobId)) throw new TeachingVoiceArtifactInvalidError('Invalid job ID.');
}

function assertIdempotencyKey(idempotencyKey: string): void {
  if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
    throw new TeachingVoiceArtifactInvalidError('Invalid idempotency key.');
  }
}

function ownerDirectory(ownerId: string): string {
  return path.join(artifactRoot(), 'owners', ownerHash(ownerId));
}

function manifestPath(ownerId: string, jobId: string): string {
  assertJobId(jobId);
  return path.join(ownerDirectory(ownerId), `${jobId}.json`);
}

function audioPath(ownerId: string, jobId: string): string {
  assertJobId(jobId);
  return path.join(ownerDirectory(ownerId), `${jobId}.audio`);
}

function indexPath(ownerId: string, idempotencyKey: string): string {
  assertIdempotencyKey(idempotencyKey);
  return path.join(artifactRoot(), 'idempotency', ownerHash(ownerId), `${idempotencyKey}.json`);
}

function normalizeFormat(format: string): SupportedArtifactFormat {
  const normalized = format
    .trim()
    .toLowerCase()
    .replace(/^audio\//, '');
  if (normalized === 'wav' || normalized === 'wave' || normalized === 'x-wav') return 'wav';
  if (normalized === 'mp3' || normalized === 'mpeg') return 'mp3';
  throw new TeachingVoiceArtifactInvalidError('Teaching Voice returned unsupported audio.');
}

function validateAudio(
  audio: Uint8Array,
  format: string,
): {
  format: SupportedArtifactFormat;
  durationSeconds: number;
} {
  if (audio.byteLength === 0 || audio.byteLength > MAX_ARTIFACT_BYTES) {
    throw new TeachingVoiceArtifactInvalidError('Teaching Voice returned invalid audio size.');
  }
  const normalized = normalizeFormat(format);
  const durationSeconds = measureAudioDuration(audio, normalized);
  if (!durationSeconds || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new TeachingVoiceArtifactInvalidError('Teaching Voice returned undecodable audio.');
  }
  return { format: normalized, durationSeconds };
}

async function writeAtomic(file: string, data: Uint8Array | string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${process.pid}-${nanoid(8)}`;
  try {
    await fs.writeFile(temporary, data, { mode: 0o600 });
    await fs.rename(temporary, file);
  } finally {
    await fs.unlink(temporary).catch(() => undefined);
  }
}

function isManifest(value: unknown): value is TeachingVoiceArtifactManifest {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<TeachingVoiceArtifactManifest>;
  return (
    item.version === ARTIFACT_VERSION &&
    typeof item.jobId === 'string' &&
    typeof item.ownerHash === 'string' &&
    typeof item.idempotencyKey === 'string' &&
    (item.format === 'wav' || item.format === 'mp3') &&
    typeof item.byteLength === 'number' &&
    typeof item.audioSha256 === 'string' &&
    typeof item.durationSeconds === 'number' &&
    typeof item.createdAt === 'number' &&
    typeof item.expiresAt === 'number' &&
    !!item.metadata &&
    typeof item.metadata === 'object'
  );
}

async function readManifest(
  jobId: string,
  ownerId: string,
  now = Date.now(),
): Promise<TeachingVoiceArtifactManifest | null> {
  let raw: string;
  try {
    raw = await fs.readFile(manifestPath(ownerId, jobId), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new TeachingVoiceArtifactInvalidError();
  }
  if (
    !isManifest(parsed) ||
    parsed.jobId !== jobId ||
    parsed.ownerHash !== ownerHash(ownerId) ||
    parsed.expiresAt <= now
  ) {
    return null;
  }
  return parsed;
}

export async function persistTeachingVoiceArtifact(input: {
  jobId: string;
  ownerId: string;
  idempotencyKey: string;
  audio: Uint8Array;
  format: string;
  metadata: ResourceJobMetadata;
  now?: number;
}): Promise<TeachingVoiceArtifactManifest> {
  assertJobId(input.jobId);
  assertIdempotencyKey(input.idempotencyKey);
  const now = input.now ?? Date.now();
  const validated = validateAudio(input.audio, input.format);
  const bytes = new Uint8Array(input.audio);
  const manifest: TeachingVoiceArtifactManifest = {
    version: ARTIFACT_VERSION,
    jobId: input.jobId,
    ownerHash: ownerHash(input.ownerId),
    idempotencyKey: input.idempotencyKey,
    format: validated.format,
    byteLength: bytes.byteLength,
    audioSha256: hash(Buffer.from(bytes)),
    durationSeconds: validated.durationSeconds,
    createdAt: now,
    expiresAt: now + artifactTtlMs(),
    metadata: { ...input.metadata },
  };

  await writeAtomic(audioPath(input.ownerId, input.jobId), bytes);
  const stored = new Uint8Array(await fs.readFile(audioPath(input.ownerId, input.jobId)));
  if (
    stored.byteLength !== manifest.byteLength ||
    hash(Buffer.from(stored)) !== manifest.audioSha256
  ) {
    throw new TeachingVoiceArtifactInvalidError(
      'Teaching Voice audio storage verification failed.',
    );
  }
  validateAudio(stored, manifest.format);
  await writeAtomic(manifestPath(input.ownerId, input.jobId), JSON.stringify(manifest));
  await writeAtomic(
    indexPath(input.ownerId, input.idempotencyKey),
    JSON.stringify({
      version: ARTIFACT_VERSION,
      jobId: input.jobId,
      expiresAt: manifest.expiresAt,
    }),
  );
  return manifest;
}

export async function readTeachingVoiceArtifact(
  jobId: string,
  ownerId: string,
  now = Date.now(),
): Promise<TeachingVoiceArtifactResult | null> {
  const manifest = await readManifest(jobId, ownerId, now);
  if (!manifest) return null;
  let audio: Uint8Array;
  try {
    audio = new Uint8Array(await fs.readFile(audioPath(ownerId, jobId)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new TeachingVoiceArtifactInvalidError(
        'Teaching Voice audio artifact is missing.',
        'missing',
      );
    }
    throw error;
  }
  if (
    audio.byteLength !== manifest.byteLength ||
    hash(Buffer.from(audio)) !== manifest.audioSha256
  ) {
    throw new TeachingVoiceArtifactInvalidError();
  }
  const validated = validateAudio(audio, manifest.format);
  if (Math.abs(validated.durationSeconds - manifest.durationSeconds) > 0.001) {
    throw new TeachingVoiceArtifactInvalidError();
  }
  return { manifest, audio, format: manifest.format };
}

export async function findTeachingVoiceArtifactByIdempotencyKey(
  ownerId: string,
  idempotencyKey: string,
  now = Date.now(),
): Promise<TeachingVoiceArtifactResult | null> {
  assertIdempotencyKey(idempotencyKey);
  let raw: string;
  try {
    raw = await fs.readFile(indexPath(ownerId, idempotencyKey), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  let index: { version?: unknown; jobId?: unknown; expiresAt?: unknown };
  try {
    index = JSON.parse(raw) as typeof index;
  } catch {
    throw new TeachingVoiceArtifactInvalidError();
  }
  if (
    index.version !== ARTIFACT_VERSION ||
    typeof index.jobId !== 'string' ||
    typeof index.expiresAt !== 'number' ||
    index.expiresAt <= now
  ) {
    return null;
  }
  return readTeachingVoiceArtifact(index.jobId, ownerId, now);
}

export function teachingVoiceArtifactSnapshot(
  manifest: TeachingVoiceArtifactManifest,
): ResourceJobSnapshot {
  return {
    id: manifest.jobId,
    resourceKey: `teaching-voice:${manifest.metadata.provider || 'unknown'}`,
    status: 'completed',
    enqueuedAt: manifest.createdAt,
    startedAt: manifest.createdAt,
    completedAt: manifest.createdAt,
    queuePosition: null,
    jobsAhead: null,
    queueDepth: 0,
    estimatedWaitMs: null,
    attemptCount: 1,
    metadata: { ...manifest.metadata },
  };
}

export async function cleanupTeachingVoiceArtifacts(now = Date.now()): Promise<void> {
  const ownersRoot = path.join(artifactRoot(), 'owners');
  let ownerDirectories: string[];
  try {
    ownerDirectories = await fs.readdir(ownersRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  await Promise.all(
    ownerDirectories.map(async (ownerDirectoryName) => {
      const directory = path.join(ownersRoot, ownerDirectoryName);
      const entries = await fs.readdir(directory).catch(() => []);
      await Promise.all(
        entries
          .filter((entry) => entry.endsWith('.json'))
          .map(async (entry) => {
            const file = path.join(directory, entry);
            let manifest: TeachingVoiceArtifactManifest | null = null;
            try {
              const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as unknown;
              if (isManifest(parsed)) manifest = parsed;
            } catch {
              return;
            }
            if (!manifest || manifest.expiresAt > now) return;
            await Promise.all([
              fs.unlink(file).catch(() => undefined),
              fs.unlink(path.join(directory, `${manifest.jobId}.audio`)).catch(() => undefined),
              fs
                .unlink(
                  path.join(
                    artifactRoot(),
                    'idempotency',
                    ownerDirectoryName,
                    `${manifest.idempotencyKey}.json`,
                  ),
                )
                .catch(() => undefined),
            ]);
          }),
      );
    }),
  );
}
