import { randomUUID } from 'crypto';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { markVoiceConfigured } from '@/lib/auth/server';
import {
  VOICE_CLONING_CONSENT_VERSION,
  getVoiceEnrollmentPhrases,
  getVoicePreviewText,
} from '@/lib/voice-cloning/phrases';
import {
  newTeachingVoiceProvider,
  resolveTeachingVoiceLanguage,
  validateTeachingVoiceLanguage,
} from '@/lib/voice-cloning/language';
import {
  createVoiceProfileId,
  deleteVoiceProfileAssets,
  findCurrentVoiceProfile,
  findVoiceProfileByEnrollmentAttempt,
  readVoiceProfile,
  referenceAudioExists,
  resolveReferenceAudioPath,
  writeReferenceAudio,
  writeVoiceProfile,
} from '@/lib/voice-cloning/storage';
import {
  isVoiceRecordingQualityError,
  masterGeneratedVoiceAudio,
  normalizeVoiceEnrollmentRecording,
  type IncomingVoiceClip,
} from '@/lib/voice-cloning/audio-validation';
import { getVoiceCloningProvider } from '@/lib/voice-cloning/provider';
import {
  TeachingVoiceError,
  resolveVoiceProfileProvider,
  toPublicVoiceProfile,
  type VoiceConfiguration,
  type VoicePreview,
  type VoiceProfile,
} from '@/lib/voice-cloning/types';
import { createLogger } from '@/lib/logger';

const log = createLogger('VoiceEnrollmentJob');

export type VoiceEnrollmentJobStatus = 'queued' | 'running' | 'completed' | 'failed';
export type VoiceEnrollmentJobPhase =
  | 'queued'
  | 'quality_check'
  | 'preprocessing'
  | 'provider_registration'
  | 'finalizing'
  | 'completed'
  | 'failed';

export interface VoiceEnrollmentJob {
  attemptId: string;
  ownerUserId: string;
  status: VoiceEnrollmentJobStatus;
  phase: VoiceEnrollmentJobPhase;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
  languageId?: string;
  provider?: 'qwen3' | 'indicf5';
  profileId?: string;
  result?: VoiceProfile;
  error?: string;
}

export interface VoiceEnrollmentStartResult {
  attemptId: string;
  status: VoiceEnrollmentJobStatus;
  phase: VoiceEnrollmentJobPhase;
  pollIntervalMs: number;
  profile?: ReturnType<typeof toPublicVoiceProfile>;
  error?: string;
}

interface VoiceEnrollmentInput {
  attemptId: string;
  ownerUserId: string;
  displayName: string;
  languageId: string;
  providerId: 'qwen3' | 'indicf5';
  referenceText: string;
  recording: IncomingVoiceClip;
}

const TERMINAL_JOB_TTL_MS = 30 * 60 * 1000;
const ACTIVE_JOB_STALE_MS = 30 * 60 * 1000;
const MAX_JOBS = 100;
export const VOICE_ENROLLMENT_POLL_INTERVAL_MS = 3000;

const jobs = new Map<string, VoiceEnrollmentJob>();
const runningJobs = new Map<string, Promise<void>>();

function nowMs(): number {
  return Date.now();
}

function isTerminal(job: VoiceEnrollmentJob): boolean {
  return job.status === 'completed' || job.status === 'failed';
}

function pruneJob(attemptId: string): void {
  jobs.delete(attemptId);
  runningJobs.delete(attemptId);
}

export function cleanupVoiceEnrollmentJobs(now = nowMs()): void {
  for (const [attemptId, job] of jobs) {
    if (isTerminal(job) && now - job.updatedAt > TERMINAL_JOB_TTL_MS) {
      pruneJob(attemptId);
      continue;
    }

    if (!isTerminal(job) && now - job.updatedAt > ACTIVE_JOB_STALE_MS) {
      jobs.set(attemptId, {
        ...job,
        status: 'failed',
        phase: 'failed',
        error: 'Teaching Voice enrollment expired before completion. Try again.',
        updatedAt: now,
        completedAt: now,
      });
      runningJobs.delete(attemptId);
    }
  }

  if (jobs.size <= MAX_JOBS) return;
  const terminalJobs = [...jobs.values()]
    .filter(isTerminal)
    .sort((a, b) => a.updatedAt - b.updatedAt);
  for (const job of terminalJobs) {
    if (jobs.size <= MAX_JOBS) break;
    pruneJob(job.attemptId);
  }
}

export function isValidVoiceEnrollmentAttemptId(attemptId: string): boolean {
  return /^[a-zA-Z0-9_-]{8,80}$/.test(attemptId);
}

function safeEnrollmentError(error: unknown): string {
  const message =
    error instanceof TeachingVoiceError || error instanceof Error
      ? error.message
      : String(error || 'Voice enrollment failed');
  return message.replace(/\s+/g, ' ').trim().slice(0, 300) || 'Voice enrollment failed';
}

function voicePreviewFromAudio(audio: Uint8Array, format: string): VoicePreview {
  return {
    format,
    base64: Buffer.from(audio).toString('base64'),
    createdAt: new Date().toISOString(),
  };
}

export async function generateVariantPreview(
  profile: VoiceProfile,
  config: VoiceConfiguration,
): Promise<{ providerReferenceId: string; preview: VoicePreview }> {
  if (!profile.referenceAudioKey || !(await referenceAudioExists(profile.referenceAudioKey))) {
    throw new Error('Voice profile reference audio not found');
  }
  const providerId = resolveVoiceProfileProvider(profile);
  validateTeachingVoiceLanguage(profile, config.languageId);
  const provider = getVoiceCloningProvider(providerId);
  const { providerReferenceId } = await provider.createProfile({
    profileId: profile.id,
    referenceAudioKey: resolveReferenceAudioPath(profile.referenceAudioKey),
    referenceText: profile.referenceText,
    language: config.languageId,
    modelVariant: config.modelVariant,
    generationSettings: config.generationSettings,
  });
  const preview = await provider.generatePreview({
    providerReferenceId,
    text: getVoicePreviewText(config.languageId, providerId),
    language: config.languageId,
    modelVariant: config.modelVariant,
    generationSettings: config.generationSettings,
  });
  const mastered = await masterGeneratedVoiceAudio(preview.audio, preview.format);
  log.info('voice output mastering completed', {
    profileId: profile.id,
    operation: 'preview',
    format: mastered.format,
  });
  return {
    providerReferenceId,
    preview: voicePreviewFromAudio(mastered.audio, mastered.format),
  };
}

export function createOrReuseVoiceEnrollmentJob(input: {
  attemptId: string;
  ownerUserId: string;
  languageId: string;
  provider: 'qwen3' | 'indicf5';
}): { job: VoiceEnrollmentJob; reused: boolean } {
  const now = nowMs();
  cleanupVoiceEnrollmentJobs(now);

  const existing = jobs.get(input.attemptId);
  if (existing && existing.ownerUserId === input.ownerUserId && existing.status !== 'failed') {
    return { job: existing, reused: true };
  }

  const job: VoiceEnrollmentJob = {
    attemptId: input.attemptId,
    ownerUserId: input.ownerUserId,
    status: 'queued',
    phase: 'queued',
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    languageId: input.languageId,
    provider: input.provider,
    profileId: existing?.profileId,
  };
  jobs.set(input.attemptId, job);
  return { job, reused: false };
}

function updateJob(attemptId: string, updates: Partial<VoiceEnrollmentJob>): void {
  const existing = jobs.get(attemptId);
  if (!existing) return;
  jobs.set(attemptId, { ...existing, ...updates, updatedAt: nowMs() });
}

function enrollmentResult(
  job: VoiceEnrollmentJob,
  profile?: VoiceProfile | null,
): VoiceEnrollmentStartResult {
  return {
    attemptId: job.attemptId,
    status: job.status,
    phase: job.phase,
    pollIntervalMs: VOICE_ENROLLMENT_POLL_INTERVAL_MS,
    ...(profile !== undefined ? { profile: toPublicVoiceProfile(profile) } : {}),
    ...(job.error ? { error: job.error } : {}),
  };
}

export async function readVoiceEnrollmentStatus(
  attemptId: string,
  ownerUserId: string,
): Promise<VoiceEnrollmentStartResult | null> {
  cleanupVoiceEnrollmentJobs();
  const job = jobs.get(attemptId);
  if (job && job.ownerUserId === ownerUserId) {
    return enrollmentResult(job, job.result);
  }

  const profile = await findVoiceProfileByEnrollmentAttempt(ownerUserId, attemptId);
  if (!profile) return null;
  const status: VoiceEnrollmentJobStatus =
    profile.status === 'failed'
      ? 'failed'
      : profile.status === 'preview-ready' || profile.status === 'ready'
        ? 'completed'
        : 'running';
  return {
    attemptId,
    status,
    phase:
      status === 'completed'
        ? 'completed'
        : status === 'failed'
          ? 'failed'
          : 'provider_registration',
    pollIntervalMs: VOICE_ENROLLMENT_POLL_INTERVAL_MS,
    profile: toPublicVoiceProfile(profile),
    ...(profile.failureReason ? { error: profile.failureReason } : {}),
  };
}

async function processVoiceEnrollment(input: VoiceEnrollmentInput): Promise<VoiceProfile> {
  const startedAt = nowMs();
  let profile: VoiceProfile | null = null;
  try {
    updateJob(input.attemptId, { phase: 'quality_check' });
    log.info('voice enrollment quality check started', {
      attemptId: input.attemptId,
      operation: 'enroll',
      language: input.languageId,
      provider: input.providerId,
      recordingBytes: input.recording.bytes.byteLength,
    });
    const normalizedReference = await normalizeVoiceEnrollmentRecording(input.recording);
    log.info('voice enrollment quality check passed', {
      attemptId: input.attemptId,
      operation: 'enroll',
      language: input.languageId,
      provider: input.providerId,
      durationMs: Math.round(normalizedReference.quality.durationSeconds * 1000),
      peakLevel: normalizedReference.quality.maxVolumeDb,
      meanLevel: normalizedReference.quality.meanVolumeDb,
      silenceRatio: normalizedReference.quality.silenceRatio,
      clippedSampleRatio: normalizedReference.quality.clippedSampleRatio,
      maxConsecutiveClippingMs: normalizedReference.quality.maxConsecutiveClippingMs,
      qualityDecision: normalizedReference.qualityDecision.severity,
      qualityWarnings: normalizedReference.qualityDecision.warnings,
    });

    updateJob(input.attemptId, { phase: 'preprocessing' });
    const existingAttemptProfile = await findVoiceProfileByEnrollmentAttempt(
      input.ownerUserId,
      input.attemptId,
    );
    const previousProfile =
      existingAttemptProfile?.replacesProfileId !== undefined
        ? await readVoiceProfile(existingAttemptProfile.replacesProfileId, input.ownerUserId)
        : await findCurrentVoiceProfile(input.ownerUserId, input.languageId, true);
    const profileId = existingAttemptProfile?.id ?? createVoiceProfileId();
    const now = new Date().toISOString();
    profile = {
      ...(existingAttemptProfile ?? {}),
      id: profileId,
      ownerId: input.ownerUserId,
      displayName: input.displayName || 'My Teaching Voice',
      provider: input.providerId,
      language: input.languageId,
      languageId: input.languageId,
      referenceText: input.referenceText,
      status: 'processing',
      createdAt: existingAttemptProfile?.createdAt ?? now,
      updatedAt: now,
      consentTimestamp: existingAttemptProfile?.consentTimestamp ?? now,
      consentVersion: VOICE_CLONING_CONSENT_VERSION,
      profileVersion: 1,
      replacesProfileId: existingAttemptProfile?.replacesProfileId ?? previousProfile?.id,
      enrollmentAttemptId: input.attemptId,
      providerReferenceId: undefined,
      preview: undefined,
      previewVariants: undefined,
      draftPreview: undefined,
      failureReason: undefined,
      enrollmentQuality: {
        severity: normalizedReference.qualityDecision.severity === 'warning' ? 'warning' : 'pass',
        warnings: normalizedReference.qualityDecision.warnings,
      },
    };
    await writeVoiceProfile(profile);
    updateJob(input.attemptId, { profileId });

    const referenceAudioKey = await writeReferenceAudio(
      profileId,
      input.ownerUserId,
      normalizedReference.referenceAudio,
    );
    profile = { ...profile, referenceAudioKey, updatedAt: new Date().toISOString() };
    await writeVoiceProfile(profile);
    log.info('voice reference preprocessing completed', {
      attemptId: input.attemptId,
      profileId,
      operation: 'enroll',
      language: input.languageId,
      provider: input.providerId,
      durationMs: Math.round(normalizedReference.durationSeconds * 1000),
      peakLevel: normalizedReference.quality.maxVolumeDb,
      meanLevel: normalizedReference.quality.meanVolumeDb,
      silenceRatio: normalizedReference.quality.silenceRatio,
      clippedSampleRatio: normalizedReference.quality.clippedSampleRatio,
      maxConsecutiveClippingMs: normalizedReference.quality.maxConsecutiveClippingMs,
      qualityDecision: normalizedReference.qualityDecision.severity,
    });

    updateJob(input.attemptId, { phase: 'provider_registration' });
    const config: VoiceConfiguration = { languageId: input.languageId };
    const { providerReferenceId, preview } = await generateVariantPreview(profile, config);
    updateJob(input.attemptId, { phase: 'finalizing' });
    profile = {
      ...profile,
      providerReferenceId,
      status: 'preview-ready',
      updatedAt: new Date().toISOString(),
      draftPreview: { config, preview },
    };
    await writeVoiceProfile(profile);

    log.info('voice profile enrolled', {
      attemptId: input.attemptId,
      profileId,
      operation: 'enroll',
      status: profile.status,
      language: input.languageId,
      provider: input.providerId,
      durationMs: nowMs() - startedAt,
      qualityDecision: normalizedReference.qualityDecision.severity,
    });
    return profile;
  } catch (error) {
    const message = safeEnrollmentError(error);
    if (profile) {
      await writeVoiceProfile({
        ...profile,
        status: 'failed',
        updatedAt: new Date().toISOString(),
        failureReason: message,
      }).catch(() => undefined);
    }
    if (isVoiceRecordingQualityError(error)) {
      log.warn('voice enrollment rejected', {
        attemptId: input.attemptId,
        operation: 'enroll',
        reason: error.code,
        language: input.languageId,
        provider: input.providerId,
        qualityDecision: error.decision?.severity ?? 'reject',
        ...(error.metrics
          ? {
              durationMs: Math.round(error.metrics.durationSeconds * 1000),
              peakLevel: error.metrics.maxVolumeDb,
              meanLevel: error.metrics.meanVolumeDb,
              silenceRatio: error.metrics.silenceRatio,
              clippedSampleRatio: error.metrics.clippedSampleRatio,
              maxConsecutiveClippingMs: error.metrics.maxConsecutiveClippingMs,
            }
          : {}),
      });
    } else {
      log.warn('voice profile enrollment failed', {
        attemptId: input.attemptId,
        operation: 'enroll',
        status: 'failed',
        language: input.languageId,
        provider: input.providerId,
        error: message,
        profileId: profile?.id,
      });
    }
    throw error;
  }
}

export function runVoiceEnrollmentJob(input: VoiceEnrollmentInput): Promise<void> {
  const existingRun = runningJobs.get(input.attemptId);
  if (existingRun) return existingRun;

  const run = (async () => {
    const startedAt = nowMs();
    const queued = jobs.get(input.attemptId);
    if (!queued || queued.status === 'completed') return;
    jobs.set(input.attemptId, {
      ...queued,
      status: 'running',
      phase: 'quality_check',
      startedAt,
      updatedAt: startedAt,
    });
    try {
      const profile = await processVoiceEnrollment(input);
      const completedAt = nowMs();
      const latest = jobs.get(input.attemptId);
      if (!latest) return;
      jobs.set(input.attemptId, {
        ...latest,
        status: 'completed',
        phase: 'completed',
        result: profile,
        profileId: profile.id,
        updatedAt: completedAt,
        completedAt,
      });
    } catch (error) {
      const completedAt = nowMs();
      const latest = jobs.get(input.attemptId);
      if (!latest) return;
      jobs.set(input.attemptId, {
        ...latest,
        status: 'failed',
        phase: 'failed',
        error: safeEnrollmentError(error),
        updatedAt: completedAt,
        completedAt,
      });
    } finally {
      runningJobs.delete(input.attemptId);
    }
  })();

  runningJobs.set(input.attemptId, run);
  return run;
}

async function readEnrollmentRecording(formData: FormData): Promise<IncomingVoiceClip> {
  const value = formData.get('recording');
  if (!(value instanceof File)) {
    throw new Error('Missing recording');
  }
  return {
    bytes: new Uint8Array(await value.arrayBuffer()),
    mimeType: value.type,
    fileName: value.name,
  };
}

export async function parseVoiceEnrollmentForm(
  formData: FormData,
  ownerUserId: string,
): Promise<VoiceEnrollmentInput> {
  const consent = formData.get('consent') === 'true';
  if (!consent) throw new TeachingVoiceError('Explicit consent is required');
  const rawAttemptId =
    typeof formData.get('attemptId') === 'string'
      ? String(formData.get('attemptId'))
      : randomUUID();
  const attemptId = rawAttemptId.trim();
  if (!isValidVoiceEnrollmentAttemptId(attemptId)) {
    throw new TeachingVoiceError('Invalid Teaching Voice enrollment attempt.');
  }
  const displayName =
    typeof formData.get('displayName') === 'string'
      ? String(formData.get('displayName')).trim().slice(0, 80)
      : '';
  const languageValue = formData.get('languageId') ?? formData.get('language');
  const languageId =
    resolveTeachingVoiceLanguage(typeof languageValue === 'string' ? languageValue : null) || '';
  const providerId = newTeachingVoiceProvider(languageId);
  const phrase = getVoiceEnrollmentPhrases(languageId).find(
    (item) => item.id === formData.get('phraseId'),
  );
  if (!phrase || formData.get('referenceText') !== phrase.text) {
    throw new TeachingVoiceError(
      'The enrollment paragraph has changed. Reload and record the displayed paragraph again.',
    );
  }
  return {
    attemptId,
    ownerUserId,
    displayName,
    languageId,
    providerId,
    referenceText: phrase.text,
    recording: await readEnrollmentRecording(formData),
  };
}

export async function startVoiceEnrollment(input: VoiceEnrollmentInput): Promise<{
  job: VoiceEnrollmentJob;
  reused: boolean;
  completedProfile?: VoiceProfile;
}> {
  const completedProfile = await findVoiceProfileByEnrollmentAttempt(
    input.ownerUserId,
    input.attemptId,
  );
  if (completedProfile?.status === 'preview-ready' || completedProfile?.status === 'ready') {
    const now = nowMs();
    const job: VoiceEnrollmentJob = {
      attemptId: input.attemptId,
      ownerUserId: input.ownerUserId,
      status: 'completed',
      phase: 'completed',
      createdAt: now,
      updatedAt: now,
      completedAt: now,
      languageId: input.languageId,
      provider: input.providerId,
      profileId: completedProfile.id,
      result: completedProfile,
    };
    jobs.set(input.attemptId, job);
    return { job, reused: true, completedProfile };
  }

  const { job, reused } = createOrReuseVoiceEnrollmentJob({
    attemptId: input.attemptId,
    ownerUserId: input.ownerUserId,
    languageId: input.languageId,
    provider: input.providerId,
  });
  return { job, reused };
}

export function voiceEnrollmentResponse(job: VoiceEnrollmentJob, profile?: VoiceProfile | null) {
  return apiSuccess({ ...enrollmentResult(job, profile) }, job.status === 'completed' ? 200 : 202);
}

export function voiceEnrollmentErrorResponse(error: unknown) {
  return apiError(
    'INVALID_REQUEST',
    error instanceof TeachingVoiceError ? error.status : 400,
    error instanceof Error ? error.message : 'Invalid voice enrollment request',
  );
}

export async function acceptVoiceProfilePreview(
  profile: VoiceProfile,
  config: VoiceConfiguration,
  ownerId: string,
): Promise<VoiceProfile> {
  const next = {
    ...profile,
    status: 'ready' as const,
    language: config.languageId,
    languageId: config.languageId,
    modelVariant: config.modelVariant,
    generationSettings: config.generationSettings,
    preview: profile.draftPreview?.preview,
    draftPreview: undefined,
    updatedAt: new Date().toISOString(),
  };
  await writeVoiceProfile(next);
  await markVoiceConfigured(ownerId);
  if (profile.replacesProfileId) {
    const previousProfile = await readVoiceProfile(profile.replacesProfileId, ownerId);
    if (
      previousProfile &&
      previousProfile.ownerId === ownerId &&
      resolveTeachingVoiceLanguage(previousProfile.languageId ?? previousProfile.language) ===
        config.languageId &&
      previousProfile.status !== 'deleted'
    ) {
      if (previousProfile.providerReferenceId) {
        await getVoiceCloningProvider(resolveVoiceProfileProvider(previousProfile))
          .deleteProfile({ providerReferenceId: previousProfile.providerReferenceId })
          .catch(() => log.warn('Could not remove replaced Teaching Voice service registration'));
      }
      await deleteVoiceProfileAssets(previousProfile);
      await writeVoiceProfile({
        ...previousProfile,
        status: 'deleted',
        referenceAudioKey: undefined,
        referenceText: undefined,
        providerReferenceId: undefined,
        preview: undefined,
        previewVariants: undefined,
        draftPreview: undefined,
        updatedAt: new Date().toISOString(),
      });
    }
  }
  return next;
}

export async function waitForVoiceEnrollmentJobForTests(attemptId: string): Promise<void> {
  await runningJobs.get(attemptId);
}

export function clearVoiceEnrollmentJobsForTests(): void {
  jobs.clear();
  runningJobs.clear();
}
