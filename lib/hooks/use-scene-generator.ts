'use client';

import { useCallback, useEffect, useRef } from 'react';
import { useStageStore } from '@/lib/store/stage';
import { isSceneEditLocked } from '@/lib/edit/regen-lock';
import { getCurrentModelConfig } from '@/lib/utils/model-config';
import { useSettingsStore } from '@/lib/store/settings';
import { db } from '@/lib/utils/database';
import type {
  SceneOutline,
  PdfImage,
  ImageMapping,
  UserRequirements,
} from '@/lib/types/generation';
import type { AgentInfo } from '@openmaic/generation';
import type { Scene } from '@/lib/types/stage';
import type { SpeechAction } from '@/lib/types/action';
import { splitLongSpeechActions } from '@/lib/audio/tts-utils';
import { resolveTeachingVoiceLanguage } from '@/lib/voice-cloning/language';
import { measureAudioDuration } from '@/lib/audio/audio-duration';
import { isTTSProviderEnabled } from '@/lib/audio/provider-enablement';
import { resolveAgentVoiceOptions, pickNarratorAgent } from '@/lib/audio/agent-voice';
import {
  getEnabledProvidersWithVoices,
  resolveDeterministicFallbackVoice,
  resolveNarratorVoiceBinding,
  type ResolvedVoice,
} from '@/lib/audio/voice-resolver';
import { resolveTTSModelForVoice } from '@/lib/audio/constants';
import { useAgentRegistry } from '@/lib/orchestration/registry/store';
import { generateMediaForOutlines } from '@/lib/media/media-orchestrator';
import { putAsset } from '@/lib/media/asset-pool';
import { mayGenerateForStage } from '@/lib/classroom/generation-permission';
import { isServerBackedMediaPersistence } from '@/lib/persistence/media-persistence';
import { lazyBoundedMap } from '@/lib/utils/concurrency';
import { createLogger } from '@/lib/logger';
import { toast } from 'sonner';
import { getClientTranslation } from '@/lib/i18n';
import {
  isVoiceBindingUnavailable,
  markVoiceBindingNoticeShown,
  markVoiceBindingUnavailable,
  voiceBindingKey,
} from '@/lib/audio/unavailable-voice-bindings';
import {
  isAbortError,
  withGenerationRetry,
  type GenerationRetryOptions,
} from '@openmaic/generation';
import type { TeachingVoiceQueueProgress } from '@/lib/generation/progress';
import {
  mergeCompletedNarration,
  narrationFailurePatch,
  narrationProgressPatch,
  sceneForNarrationSynthesis,
  sceneWithPendingNarration,
} from '@/lib/generation/scene-narration';

const log = createLogger('SceneGenerator');
const SCENE_CONTENT_JOB_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_SCENE_CONTENT_JOB_POLL_INTERVAL_MS = 3000;

type SceneGenerationPhase = 'content' | 'actions' | 'narration';

interface ManagedNarrationTask {
  controller: AbortController;
  promise: Promise<void>;
}

function traceSceneGeneration(event: string, details: Record<string, unknown>) {
  log.info('[SceneGenerationTrace]', { event, ...details });
}

type SceneContentJobStatus = 'queued' | 'generating' | 'completed' | 'failed';

interface SceneContentResult {
  success: boolean;
  content?: unknown;
  effectiveOutline?: SceneOutline;
  error?: string;
  errorCode?: string;
  statusCode?: number;
  async?: boolean;
  jobId?: string;
  status?: SceneContentJobStatus;
  pollIntervalMs?: number;
  jobTerminal?: boolean;
  stageId?: string;
  outlineId?: string;
  attemptId?: string;
  generationVersion?: string;
}

interface SceneActionsResult {
  success: boolean;
  scene?: Scene;
  previousSpeeches?: string[];
  error?: string;
  errorCode?: string;
  statusCode?: number;
  attemptId?: string;
  generationVersion?: string;
}

interface SceneAttemptCommitResult {
  success: boolean;
  accepted?: boolean;
  alreadyCommitted?: boolean;
  error?: string;
  errorCode?: string;
  statusCode?: number;
}

type ClientRetryOptions<T> = Partial<
  Omit<GenerationRetryOptions<T>, 'label' | 'shouldRetryResult' | 'signal'>
>;

function getApiHeaders(): HeadersInit {
  const config = getCurrentModelConfig();
  const settings = useSettingsStore.getState();
  const imageProviderConfig = settings.imageProvidersConfig?.[settings.imageProviderId];
  const videoProviderConfig = settings.videoProvidersConfig?.[settings.videoProviderId];
  let storedLocale = '';
  try {
    storedLocale =
      typeof window !== 'undefined' ? window.localStorage.getItem('locale')?.trim() || '' : '';
  } catch {
    storedLocale = '';
  }

  return {
    'Content-Type': 'application/json',
    'x-model': config.modelString || '',
    'x-api-key': config.apiKey || '',
    'x-base-url': config.baseUrl || '',
    'x-provider-type': config.providerType || '',
    // Image generation provider
    'x-image-provider': settings.imageProviderId || '',
    'x-image-model': settings.imageModelId || '',
    'x-image-api-key': imageProviderConfig?.apiKey || '',
    'x-image-base-url': imageProviderConfig?.baseUrl || '',
    // Video generation provider
    'x-video-provider': settings.videoProviderId || '',
    'x-video-model': settings.videoModelId || '',
    'x-video-api-key': videoProviderConfig?.apiKey || '',
    'x-video-base-url': videoProviderConfig?.baseUrl || '',
    // Media generation toggles
    'x-image-generation-enabled': String(settings.imageGenerationEnabled ?? false),
    'x-video-generation-enabled': String(settings.videoGenerationEnabled ?? false),
    ...(storedLocale ? { 'x-user-locale': storedLocale } : {}),
  };
}

function withThinkingConfig<T extends Record<string, unknown>>(body: T): T {
  const { thinkingConfig } = getCurrentModelConfig();
  return thinkingConfig ? ({ ...body, thinkingConfig } as T) : body;
}

async function readJsonResponse(response: Response): Promise<Record<string, unknown>> {
  return response.json().catch(() => ({
    error: response.statusText || 'Request failed',
  }));
}

function createHttpError(
  response: Response,
  data: { details?: unknown; error?: unknown; errorCode?: unknown },
  fallback: string,
): Error & { errorCode?: string; statusCode?: number } {
  const message =
    typeof data.details === 'string'
      ? data.details
      : typeof data.error === 'string'
        ? data.error
        : `${fallback}: HTTP ${response.status}`;
  const error = new Error(message) as Error & { errorCode?: string; statusCode?: number };
  if (typeof data.errorCode === 'string') {
    error.errorCode = data.errorCode;
  }
  error.statusCode = response.status;
  return error;
}

function messageFromError(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function errorMeta(error: unknown): Pick<SceneContentResult, 'errorCode' | 'statusCode'> {
  if (!error || typeof error !== 'object') return {};
  const record = error as { errorCode?: unknown; statusCode?: unknown };
  return {
    ...(typeof record.errorCode === 'string' ? { errorCode: record.errorCode } : {}),
    ...(typeof record.statusCode === 'number' ? { statusCode: record.statusCode } : {}),
  };
}

function createSceneAttemptId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `scene_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
}

function attemptIdentity(result: SceneContentResult) {
  return {
    attemptId: result.attemptId,
    generationVersion: result.generationVersion,
  };
}

function isAsyncSceneContentStart(result: SceneContentResult): result is SceneContentResult & {
  async: true;
  jobId: string;
} {
  return result.async === true && typeof result.jobId === 'string' && result.jobId.length > 0;
}

function shouldRetrySceneContentResult(result: SceneContentResult): boolean {
  if (result.jobTerminal) return false;
  return !result.success || !result.content;
}

const defaultPollSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }

    const timeoutId = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timeoutId);
      signal?.removeEventListener('abort', onAbort);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

async function pollSceneContentJob(
  initial: SceneContentResult & { async: true; jobId: string },
  expected: { stageId: string; outlineId: string },
  signal?: AbortSignal,
  retryOptions?: ClientRetryOptions<SceneContentResult>,
): Promise<SceneContentResult> {
  if (initial.status === 'completed' && initial.content) {
    return {
      success: true,
      content: initial.content,
      effectiveOutline: initial.effectiveOutline,
      jobId: initial.jobId,
      status: initial.status,
      jobTerminal: true,
      ...attemptIdentity(initial),
    };
  }
  if (initial.status === 'failed') {
    return {
      success: false,
      error: initial.error || 'Scene content generation failed',
      errorCode: 'GENERATION_FAILED',
      jobId: initial.jobId,
      status: initial.status,
      jobTerminal: true,
      ...attemptIdentity(initial),
    };
  }

  const sleep = retryOptions?.sleep ?? defaultPollSleep;
  const startedAt = Date.now();
  const pollIntervalMs = Math.max(
    1000,
    Math.min(initial.pollIntervalMs ?? DEFAULT_SCENE_CONTENT_JOB_POLL_INTERVAL_MS, 10000),
  );

  while (Date.now() - startedAt < SCENE_CONTENT_JOB_TIMEOUT_MS) {
    await sleep(pollIntervalMs, signal);
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    const response = await fetch(
      `/api/generate/scene-content/status?jobId=${encodeURIComponent(initial.jobId)}`,
      {
        method: 'GET',
        headers: getApiHeaders(),
        signal,
      },
    );
    const data = (await readJsonResponse(response)) as unknown as SceneContentResult;
    if (!response.ok) {
      throw createHttpError(response, data, 'Scene content job status request failed');
    }
    if (data.stageId !== expected.stageId || data.outlineId !== expected.outlineId) {
      return {
        success: false,
        error: 'Scene content job identity did not match the requested slide',
        errorCode: 'GENERATION_FAILED',
        jobId: initial.jobId,
        status: 'failed',
        jobTerminal: true,
      };
    }

    if (data.status === 'completed') {
      if (data.content) {
        return {
          success: true,
          content: data.content,
          effectiveOutline: data.effectiveOutline,
          jobId: initial.jobId,
          status: data.status,
          jobTerminal: true,
          ...attemptIdentity(initial),
        };
      }
      return {
        success: false,
        error: 'Scene content job completed without content',
        errorCode: 'GENERATION_FAILED',
        jobId: initial.jobId,
        status: data.status,
        jobTerminal: true,
        ...attemptIdentity(initial),
      };
    }

    if (data.status === 'failed') {
      return {
        success: false,
        error: data.error || 'Scene content generation failed',
        errorCode: data.errorCode || 'GENERATION_FAILED',
        jobId: initial.jobId,
        status: data.status,
        jobTerminal: true,
        ...attemptIdentity(initial),
      };
    }
  }

  return {
    success: false,
    error: 'Scene content generation timed out. Please try again.',
    errorCode: 'GENERATION_FAILED',
    jobId: initial.jobId,
    status: initial.status,
    jobTerminal: true,
    ...attemptIdentity(initial),
  };
}

/** Call POST /api/generate/scene-content (step 1) */
export async function fetchSceneContent(
  params: {
    outline: SceneOutline;
    allOutlines: SceneOutline[];
    stageId: string;
    pdfImages?: PdfImage[];
    imageMapping?: ImageMapping;
    stageInfo: {
      name: string;
      description?: string;
      language?: string;
      style?: string;
    };
    agents?: AgentInfo[];
    languageDirective?: string;
    requirements?: UserRequirements;
    attemptId?: string;
  },
  signal?: AbortSignal,
  retryOptions?: ClientRetryOptions<SceneContentResult>,
): Promise<SceneContentResult> {
  const proposedAttemptId = params.attemptId ?? createSceneAttemptId();
  try {
    return await withGenerationRetry(
      async () => {
        const response = await fetch('/api/generate/scene-content', {
          method: 'POST',
          headers: getApiHeaders(),
          body: JSON.stringify(withThinkingConfig({ ...params, attemptId: proposedAttemptId })),
          signal,
        });

        const data = await readJsonResponse(response);
        if (!response.ok) {
          throw createHttpError(response, data, 'Scene content request failed');
        }

        const result = data as unknown as SceneContentResult;
        if (!result.attemptId || !result.generationVersion) {
          return {
            success: false,
            error: 'Scene content response is missing authoritative attempt identity',
            errorCode: 'GENERATION_ATTEMPT_INVALID',
            statusCode: 409,
          };
        }
        if (isAsyncSceneContentStart(result)) {
          if (result.stageId !== params.stageId || result.outlineId !== params.outline.id) {
            return {
              success: false,
              error: 'Scene content job identity did not match the requested slide',
              errorCode: 'GENERATION_FAILED',
              jobId: result.jobId,
              status: 'failed',
              jobTerminal: true,
            };
          }
          return pollSceneContentJob(
            result,
            { stageId: params.stageId, outlineId: params.outline.id },
            signal,
            retryOptions,
          );
        }

        return result;
      },
      {
        label: `scene content "${params.outline.title}"`,
        shouldRetryResult: shouldRetrySceneContentResult,
        ...retryOptions,
        signal,
      },
    );
  } catch (error) {
    if (isAbortError(error)) throw error;
    return {
      success: false,
      error: messageFromError(error, 'Content generation failed'),
      ...errorMeta(error),
    };
  }
}

/** Call POST /api/generate/scene-actions (step 2) */
export async function fetchSceneActions(
  params: {
    outline: SceneOutline;
    allOutlines: SceneOutline[];
    content: unknown;
    stageId: string;
    agents?: AgentInfo[];
    previousSpeeches?: string[];
    userProfile?: string;
    languageDirective?: string;
    attemptId?: string;
    generationVersion?: string;
  },
  signal?: AbortSignal,
  retryOptions?: ClientRetryOptions<SceneActionsResult>,
): Promise<SceneActionsResult> {
  try {
    return await withGenerationRetry(
      async () => {
        const response = await fetch('/api/generate/scene-actions', {
          method: 'POST',
          headers: getApiHeaders(),
          body: JSON.stringify(withThinkingConfig(params)),
          signal,
        });

        const data = await readJsonResponse(response);
        if (!response.ok) {
          throw createHttpError(response, data, 'Scene actions request failed');
        }

        return data as unknown as SceneActionsResult;
      },
      {
        label: `scene actions "${params.outline.title}"`,
        shouldRetryResult: (result) => !result.success || !result.scene,
        ...retryOptions,
        signal,
      },
    );
  } catch (error) {
    if (isAbortError(error)) throw error;
    return {
      success: false,
      error: messageFromError(error, 'Actions generation failed'),
      ...errorMeta(error),
    };
  }
}

export async function commitSceneAttempt(params: {
  attemptId: string;
  generationVersion: string;
  stageId: string;
  outlineId: string;
  sceneId: string;
}): Promise<SceneAttemptCommitResult> {
  try {
    const response = await fetch('/api/generate/scene-attempt/commit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    const data = await readJsonResponse(response);
    if (!response.ok) {
      throw createHttpError(response, data, 'Scene attempt commit failed');
    }
    return data as unknown as SceneAttemptCommitResult;
  } catch (error) {
    return {
      success: false,
      error: messageFromError(error, 'Scene attempt commit failed'),
      ...errorMeta(error),
    };
  }
}

interface TTSApiResponse {
  success?: boolean;
  base64?: string;
  format?: string;
  audioBytes?: Uint8Array;
  error?: string;
  details?: string;
  async?: boolean;
  jobId?: string;
  status?: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  queuePosition?: number | null;
  jobsAhead?: number | null;
  estimatedWaitMs?: number | null;
  statusUrl?: string;
  audioUrl?: string;
  teachingVoiceProvider?: string;
}

const TEACHING_VOICE_JOB_POLL_INTERVAL_MS = 1500;

function waitForTeachingVoicePoll(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, TEACHING_VOICE_JOB_POLL_INTERVAL_MS);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function resolveTeachingVoiceJob(
  initial: TTSApiResponse,
  signal: AbortSignal | undefined,
  onQueueStatus?: (progress: TeachingVoiceQueueProgress | null) => void,
  teachingVoiceExpected = false,
): Promise<TTSApiResponse> {
  if (teachingVoiceExpected && !initial.teachingVoiceProvider) {
    throw new Error('Teaching Voice response is missing provider metadata.');
  }
  if (!initial.async || !initial.jobId || !initial.statusUrl) {
    if (initial.teachingVoiceProvider === 'qwen3') {
      throw new Error('Qwen Teaching Voice must use the asynchronous synthesis job API.');
    }
    return initial;
  }
  const statusUrl = initial.statusUrl;
  let current = initial;
  let lastLoggedStatus: TTSApiResponse['status'];
  traceSceneGeneration('teaching-voice-async-job-received', {
    jobId: initial.jobId,
    status: initial.status,
    queuePosition: initial.queuePosition,
    jobsAhead: initial.jobsAhead,
  });
  try {
    while (current.status === 'queued' || current.status === 'running') {
      if (current.status !== lastLoggedStatus) {
        traceSceneGeneration('teaching-voice-async-job-state', {
          jobId: initial.jobId,
          status: current.status,
          queuePosition: current.queuePosition,
          jobsAhead: current.jobsAhead,
          estimatedWaitMs: current.estimatedWaitMs,
        });
        lastLoggedStatus = current.status;
      }
      onQueueStatus?.({
        status: current.status,
        queuePosition: current.queuePosition ?? null,
        jobsAhead: current.jobsAhead ?? null,
        estimatedWaitMs: current.estimatedWaitMs ?? null,
      });
      await waitForTeachingVoicePoll(signal);
      const response = await fetch(statusUrl, { signal });
      const next = (await readJsonResponse(response)) as TTSApiResponse;
      if (!response.ok) throw createHttpError(response, next, 'Teaching Voice job status failed');
      current = { ...next, statusUrl };
    }

    if (current.status === 'failed' || current.status === 'cancelled') {
      throw new Error(
        current.error || 'Teaching Voice generation failed. No alternate voice was used.',
      );
    }
    if (current.status !== 'completed' || !current.audioUrl) {
      throw new Error('Teaching Voice job returned an invalid completion state.');
    }

    const audioResponse = await fetch(current.audioUrl, { signal });
    if (!audioResponse.ok) {
      const error = (await readJsonResponse(audioResponse)) as TTSApiResponse;
      throw createHttpError(audioResponse, error, 'Teaching Voice audio retrieval failed');
    }
    const contentType = audioResponse.headers.get('content-type') || 'audio/wav';
    return {
      success: true,
      format: contentType.split('/')[1]?.split(';')[0] || 'wav',
      audioBytes: new Uint8Array(await audioResponse.arrayBuffer()),
    };
  } catch (error) {
    if (isAbortError(error) && current.status === 'queued') {
      void fetch(statusUrl, { method: 'DELETE', keepalive: true }).catch(() => undefined);
    }
    throw error;
  } finally {
    onQueueStatus?.(null);
  }
}

// A dead narrator voice is retried at most once against a DIFFERENT voice (the
// global voice when the binding differs from it, or the deterministic
// enabled-provider pick when bound == global). This bounds the total
// /api/generate/tts attempts to 2 per call and guarantees the
// QWEN_VC_VOICE_NOT_FOUND retry cannot loop a chain of dead voices
// (bound-dead → global-dead → deterministic-dead → …) forever.
const MAX_NARRATOR_VOICE_FALLBACK_HOPS = 1;

/** Generate TTS for one speech action and return its allocated asset reference. */
export async function generateAndStoreTTS(
  requestId: string,
  text: string,
  language?: string,
  signal?: AbortSignal,
  retryOptions?: ClientRetryOptions<TTSApiResponse>,
  existingAudioId?: string,
  stageId?: string,
  // Internal: an explicit voice that bypasses narrator binding resolution — used
  // to retry narration against the deterministic enabled-provider pick when the
  // pinned narrator voice (bound == global) turns out to be unusable.
  overrideVoice?: ResolvedVoice,
  // Internal: number of narrator voice-fallback hops already taken. Guards the
  // QWEN_VC_VOICE_NOT_FOUND retry so a chain of dead voices can never loop
  // /api/generate/tts beyond a single fallback hop.
  fallbackHops = 0,
  sceneId?: string,
  onQueueStatus?: (progress: TeachingVoiceQueueProgress | null) => void,
  outlineId?: string,
): Promise<string | null> {
  const settings = useSettingsStore.getState();
  const teacherVoiceProfileId = useStageStore.getState().stage?.teacherVoiceProfileId;
  const narrationLanguage = language || useStageStore.getState().stage?.languageDirective;
  const ttsLanguageCode = teacherVoiceProfileId
    ? (resolveTeachingVoiceLanguage(narrationLanguage) ?? narrationLanguage)
    : undefined;
  // A generated roster's explicit voice binding is the course voice source of truth.
  // Global settings remain the fallback for classrooms without a binding.
  const teacher = pickNarratorAgent(useAgentRegistry.getState().listAgents());
  const globalProviderConfig = settings.ttsProvidersConfig?.[settings.ttsProviderId];
  const boundVoice = teacher?.voiceConfig;
  const boundKey = boundVoice ? voiceBindingKey(boundVoice) : undefined;
  // The narrator pin makes boundVoice == the global voice. That equality must
  // not defeat the unavailable-binding fallbacks: when the pinned voice is
  // unusable (provider disabled, or the clone deleted server-side), fall back
  // to the deterministic enabled-provider pick with a single non-fatal notice
  // instead of throwing (QWEN_VC_VOICE_NOT_FOUND) or silently skipping.
  const globalDiffers =
    !!boundVoice &&
    (boundVoice.providerId !== settings.ttsProviderId || boundVoice.voiceId !== settings.ttsVoice);
  const fallbackForUnusablePin = (): ResolvedVoice | null => {
    if (!boundVoice) return null;
    const key = voiceBindingKey(boundVoice);
    markVoiceBindingUnavailable(boundVoice);
    if (markVoiceBindingNoticeShown(key)) {
      toast.warning(getClientTranslation('settings.qwenCloneNarrationUnavailable'));
    }
    return resolveDeterministicFallbackVoice(
      getEnabledProvidersWithVoices(settings.ttsProvidersConfig),
      0,
    );
  };

  let resolvedVoice =
    overrideVoice ??
    resolveNarratorVoiceBinding(
      boundVoice && isVoiceBindingUnavailable(boundVoice) ? undefined : boundVoice,
      {
        providerId: settings.ttsProviderId,
        modelId: globalProviderConfig?.modelId,
        voiceId: settings.ttsVoice,
      },
      settings.ttsProvidersConfig,
    );

  // Pinned narrator (bound == global) whose provider became disabled:
  // resolveNarratorVoiceBinding falls back to the global voice, which is the
  // same broken provider — swap in the deterministic enabled-provider pick
  // instead of silently skipping narration below.
  if (
    !teacherVoiceProfileId &&
    boundVoice &&
    !globalDiffers &&
    !isTTSProviderEnabled(
      resolvedVoice.providerId,
      settings.ttsProvidersConfig?.[resolvedVoice.providerId],
    )
  ) {
    resolvedVoice = fallbackForUnusablePin() ?? resolvedVoice;
  }

  const ttsProviderId = resolvedVoice.providerId;
  const ttsVoice = resolvedVoice.voiceId;
  const ttsProviderConfig = settings.ttsProvidersConfig?.[ttsProviderId];
  const ttsModelId = resolveTTSModelForVoice(
    ttsProviderId,
    ttsVoice,
    resolvedVoice.modelId ?? ttsProviderConfig?.modelId,
  );

  if (!teacherVoiceProfileId && ttsProviderId === 'browser-native-tts') return null;
  // Don't server-generate against a disabled/unconfigured provider (#665).
  if (!teacherVoiceProfileId && !isTTSProviderEnabled(ttsProviderId, ttsProviderConfig)) {
    return null;
  }

  // Narration is the teacher's voice — resolve it from the teacher agent profile
  // through the single resolver (registers + references by id for stable timbre).
  const providerOptions = teacherVoiceProfileId
    ? {}
    : await resolveAgentVoiceOptions(teacher, {
        providerId: ttsProviderId,
        providerConfig: { ...ttsProviderConfig, modelId: ttsModelId },
        voiceId: ttsVoice,
        language,
      });
  let data: TTSApiResponse;
  try {
    data = await withGenerationRetry(
      async () => {
        const response = await fetch('/api/generate/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text,
            audioId: requestId,
            ttsProviderId,
            ttsModelId,
            ttsVoice,
            ttsSpeed: settings.ttsSpeed,
            ttsApiKey: ttsProviderConfig?.apiKey || undefined,
            // Managed providers resolve their base URL server-side; only send the
            // client's own base URL (custom providers).
            ttsBaseUrl:
              ttsProviderConfig?.baseUrl || ttsProviderConfig?.customDefaultBaseUrl || undefined,
            ttsProviderOptions: providerOptions,
            teacherVoiceProfileId,
            ttsLanguageCode,
            stageId,
            sceneId,
            outlineId,
          }),
          signal,
        });

        const data = (await readJsonResponse(response)) as TTSApiResponse;
        if (!response.ok) {
          throw createHttpError(response, data, 'TTS request failed');
        }
        return resolveTeachingVoiceJob(data, signal, onQueueStatus, Boolean(teacherVoiceProfileId));
      },
      {
        label: `tts "${requestId}"`,
        shouldRetryResult: (result: TTSApiResponse) =>
          !result.success ||
          (((!result.base64 && !result.audioBytes) || !result.format) &&
            !(result.async && result.jobId)),
        ...retryOptions,
        ...(teacherVoiceProfileId ? { maxRetries: 0 } : {}),
        signal,
      },
    );
  } catch (error) {
    const errorCode =
      error && typeof error === 'object' && 'errorCode' in error
        ? (error as { errorCode?: unknown }).errorCode
        : undefined;
    // Recover from a missing clone only when the attempt that just failed used
    // the bound binding itself: marking it unavailable makes the resolver fall
    // back to the global voice, a DIFFERENT voice. When the failure is already
    // on the global voice (or on the deterministic pick), retrying would hit
    // the same dead voice — fall through and surface the error instead of
    // hot-looping /api/generate/tts (bound-dead → global-dead → …). The
    // fallbackHops bound keeps even pathological chains at a single hop.
    if (
      !teacherVoiceProfileId &&
      errorCode === 'QWEN_VC_VOICE_NOT_FOUND' &&
      boundKey &&
      boundVoice &&
      fallbackHops < MAX_NARRATOR_VOICE_FALLBACK_HOPS
    ) {
      if (voiceBindingKey(resolvedVoice) === boundKey) {
        markVoiceBindingUnavailable(boundVoice);
        if (markVoiceBindingNoticeShown(boundKey)) {
          toast.warning(getClientTranslation('settings.qwenCloneNarrationUnavailable'));
        }
        if (globalDiffers) {
          // The binding is a voice distinct from the global one: retry with the
          // binding marked unavailable, which makes the resolver fall back to the
          // global voice.
          return generateAndStoreTTS(
            requestId,
            text,
            language,
            signal,
            retryOptions,
            existingAudioId,
            stageId,
            undefined,
            fallbackHops + 1,
            sceneId,
            onQueueStatus,
            outlineId,
          );
        }
        // Bound == global (pinned narrator): a retry would hit the same missing
        // clone, so fall back to the deterministic enabled-provider pick once.
        // (mark/notice were applied above; the helper's repeat is idempotent.)
        if (!overrideVoice) {
          const fallbackVoice = fallbackForUnusablePin();
          if (fallbackVoice) {
            return generateAndStoreTTS(
              requestId,
              text,
              language,
              signal,
              retryOptions,
              existingAudioId,
              stageId,
              fallbackVoice,
              fallbackHops + 1,
              sceneId,
              onQueueStatus,
              outlineId,
            );
          }
        }
      }
    }
    throw error;
  }
  if (!data.success || (!data.base64 && !data.audioBytes) || !data.format) {
    const err = new Error(
      data.details || data.error || 'TTS request failed: invalid response payload',
    );
    log.warn('TTS failed for', requestId, ':', err);
    throw err;
  }

  const bytes =
    data.audioBytes ??
    (() => {
      const binary = atob(data.base64!);
      const decoded = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) decoded[i] = binary.charCodeAt(i);
      return decoded;
    })();
  const blobBytes = new Uint8Array(bytes.byteLength);
  blobBytes.set(bytes);
  const blob = new Blob([blobBytes], { type: `audio/${data.format}` });
  // Measure duration once at store time so video export (#854) can map this
  // clip onto a timeline without re-decoding. null → leave undefined; the audio
  // still persists and plays.
  const duration = measureAudioDuration(bytes, data.format) ?? undefined;
  const serverBacked = isServerBackedMediaPersistence();
  // Server-backed: the bytes go to the pool and the pool allocates the
  // identity, so the id the speech action ends up holding names durable audio
  // rather than this browser's local table. Bytes land BEFORE the caller
  // stamps the action, so a document can never name narration that was not
  // stored. Browser-only keeps the historical derived key: document and audio
  // share one lifetime there, and nothing outside this browser reads either.
  let audioId: string;
  if (serverBacked) {
    const allocated = await allocatePooledAudio(blob, duration, stageId).catch((error: unknown) => {
      // Storing narration failed, not synthesizing it. A scene whose audio
      // cannot be stored keeps its text and leaves the line unvoiced and
      // retryable, exactly as an image that cannot be stored leaves its slide;
      // reporting it as a TTS failure would pause the whole deck at its first
      // slide over one clip's storage.
      log.warn('Narration storage failed; leaving the line unvoiced:', error);
      return null;
    });
    if (allocated === null) return null;
    audioId = allocated;
  } else {
    audioId = existingAudioId ?? requestId;
  }
  const cacheWrite = db.audioFiles.put({
    id: audioId,
    stageId,
    blob,
    duration,
    format: data.format,
    text,
    voice: ttsVoice,
    createdAt: Date.now(),
  });
  if (serverBacked) {
    // A cache the pool already backs: a failed write costs a re-download.
    await cacheWrite.catch((error: unknown) => {
      log.warn('Local narration cache write failed for', audioId, error);
    });
  } else {
    await cacheWrite;
  }
  return audioId;
}

/**
 * Store narration bytes in the asset pool and return the reference the
 * document should hold.
 *
 * Regeneration always forks to a fresh id; the caller's `existingAudioId` is
 * deliberately ignored here. Replacing bytes behind a live id requires proof
 * that no other document holds it, and that proof is unavailable by
 * construction once references can leave this browser — asking the pool who
 * else holds an id would be exactly the existence oracle the asset contract
 * forbids, so `proveExclusiveAssetOwnership` fails closed under server-backed
 * persistence and every caller forks. Keeping a branch that can never be taken
 * would only describe a capability this deployment shape does not have.
 *
 * The superseded id is NOT removed here. Nothing at this point has observed
 * the new id reaching a durable document, so deleting the old bytes could
 * leave a still-referenced action pointing at nothing if the save that follows
 * fails; and the exclusivity that would make deletion safe is the same proof
 * that is unavailable. Nothing reclaims it either: the stage-scoped registry
 * sweep is written but deliberately not wired up, so a superseded clip's entry
 * and bytes persist. Every regeneration therefore leaves one behind.
 */
async function allocatePooledAudio(
  blob: Blob,
  duration: number | undefined,
  stageId: string | undefined,
): Promise<string> {
  return putAsset(
    blob,
    {
      contentType: blob.type,
      ...(duration === undefined ? {} : { durationSeconds: duration }),
    },
    // A write that goes through retires this course's "no room" note. This path
    // allocates directly rather than through the media commit, so without it a
    // course whose narration is generated rather than adopted has nothing that
    // can establish that.
    { ...(stageId ? { stageId } : {}) },
  );
}

/**
 * Drop the local copies of narration a scene has rolled back.
 *
 * The pool entry is deliberately left alone. Asset deletion is refused to every
 * browser — the principal it would scope to is shared, so allowing it would let
 * any caller destroy another author's narration — and a rolled-back clip is
 * simply an entry nothing references, waiting for server-side reclamation like
 * any other.
 */
export async function removeFreshTtsAllocations(assetIds: readonly string[]): Promise<void> {
  for (const assetId of new Set(assetIds)) {
    await db.audioFiles.delete(assetId).catch(() => undefined);
  }
}

function speechAllocationIds(scene: Scene): string[] {
  return (scene.actions ?? []).flatMap((action) =>
    action.type === 'speech' && action.audioId ? [action.audioId] : [],
  );
}

/** Generate TTS for all speech actions in a scene. Returns result. */
export async function generateTTSForScene(
  scene: Scene,
  language?: string,
  signal?: AbortSignal,
  retryOptions?: ClientRetryOptions<TTSApiResponse>,
  onQueueStatus?: (progress: TeachingVoiceQueueProgress | null) => void,
  outlineId?: string,
): Promise<{ success: boolean; failedCount: number; error?: string }> {
  const providerId = useSettingsStore.getState().ttsProviderId;
  const teacherVoiceProfileId = useStageStore.getState().stage?.teacherVoiceProfileId;
  scene.actions = splitLongSpeechActions(scene.actions || [], providerId);
  const speechActions = scene.actions.filter(
    (a): a is SpeechAction => a.type === 'speech' && !!a.text,
  );
  if (speechActions.length === 0) return { success: true, failedCount: 0 };

  let failedCount = 0;
  let lastError: string | undefined;
  const freshAllocations: string[] = [];

  // Scene order keeps the provider request correlation label unique. Storage
  // identity is allocated by the pool and is never derived from this value.
  const sceneOrder = scene.order;

  // Generate + store one action's audio. Failures are counted, not thrown, so
  // one bad clip never aborts the rest of the scene.
  const generateOne = async (action: SpeechAction) => {
    const requestId = `tts_s${sceneOrder}_${action.id}`;
    try {
      const assetId = await generateAndStoreTTS(
        requestId,
        action.text,
        language,
        signal,
        retryOptions,
        undefined,
        scene.stageId,
        undefined,
        0,
        scene.id,
        onQueueStatus,
        outlineId,
      );
      if (assetId) {
        action.audioId = assetId;
        freshAllocations.push(assetId);
      }
    } catch (error) {
      if (isAbortError(error)) throw error;

      failedCount++;
      lastError = error instanceof Error ? error.message : `TTS failed for action ${action.id}`;
      log.warn('TTS generation failed:', {
        providerId: teacherVoiceProfileId ? 'faculty-voice-cloning' : providerId,
        actionId: action.id,
        sceneOrder,
        requestId,
        textLength: action.text.length,
        error: lastError,
      });
    }
  };

  // #660 follow-up: speech actions within a scene are independent — each renders
  // its own audio under its own audioId, with no cross-action ordering — so when
  // the server opts into parallel generation, render them with bounded
  // concurrency (reusing the PARALLEL_SCENE_CONCURRENCY knob) instead of one at a
  // time. Default (0 / unset) keeps the original strictly-serial behaviour.
  const ttsConcurrency = teacherVoiceProfileId
    ? 1
    : Math.max(0, Math.floor(useSettingsStore.getState().parallelSceneConcurrency ?? 0));
  try {
    if (ttsConcurrency > 1 && speechActions.length > 1) {
      const settled = await Promise.allSettled(
        lazyBoundedMap(speechActions, ttsConcurrency, generateOne),
      );
      const rejected = settled.find(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      );
      if (rejected) throw rejected.reason;
    } else {
      for (const action of speechActions) {
        await generateOne(action);
      }
    }
  } catch (error) {
    await removeFreshTtsAllocations(freshAllocations);
    for (const action of speechActions) delete action.audioId;
    throw error;
  }

  if (failedCount > 0) {
    await removeFreshTtsAllocations(freshAllocations);
    for (const action of speechActions) delete action.audioId;
  }

  return {
    success: failedCount === 0,
    failedCount,
    error: lastError,
  };
}

export interface UseSceneGeneratorOptions {
  onSceneGenerated?: (scene: Scene, index: number) => void;
  onSceneFailed?: (outline: SceneOutline, error: string) => void;
  onPhaseChange?: (phase: SceneGenerationPhase, outline: SceneOutline) => void;
  onNarrationQueueChange?: (
    progress: TeachingVoiceQueueProgress | null,
    outline: SceneOutline,
  ) => void;
  onComplete?: () => void;
}

export interface GenerationParams {
  pdfImages?: PdfImage[];
  imageMapping?: ImageMapping;
  stageInfo: {
    name: string;
    description?: string;
    language?: string;
    style?: string;
  };
  agents?: AgentInfo[];
  userProfile?: string;
  languageDirective?: string;
}

export function useSceneGenerator(options: UseSceneGeneratorOptions = {}) {
  const abortRef = useRef(false);
  const generatingRef = useRef(false);
  const mediaAbortRef = useRef<AbortController | null>(null);
  const fetchAbortRef = useRef<AbortController | null>(null);
  const narrationTasksRef = useRef(new Map<string, ManagedNarrationTask>());
  const retryTasksRef = useRef(new Map<string, AbortController>());
  const lastParamsRef = useRef<GenerationParams | null>(null);
  const generateRemainingRef = useRef<((params: GenerationParams) => Promise<void>) | null>(null);

  const store = useStageStore;

  const abortNarrationTasks = useCallback(() => {
    for (const task of narrationTasksRef.current.values()) {
      task.controller.abort();
    }
  }, []);

  const abortRetryTasks = useCallback(() => {
    for (const controller of retryTasksRef.current.values()) controller.abort();
    retryTasksRef.current.clear();
  }, []);

  useEffect(() => {
    let observedEpoch = store.getState().generationEpoch;
    const unsubscribe = store.subscribe((state) => {
      if (state.generationEpoch === observedEpoch) return;
      observedEpoch = state.generationEpoch;
      abortNarrationTasks();
      abortRetryTasks();
    });
    return () => {
      unsubscribe();
      abortNarrationTasks();
      abortRetryTasks();
    };
  }, [abortNarrationTasks, abortRetryTasks, store]);

  const scheduleNarration = useCallback(
    ({
      scene,
      outline,
      stageId,
      generationRunId,
      generationEpoch,
      language,
      provider,
    }: {
      scene: Scene;
      outline: SceneOutline;
      stageId: string;
      generationRunId: string;
      generationEpoch: number;
      language?: string;
      provider: string;
    }) => {
      const taskKey = `${generationEpoch}:${scene.id}`;
      if (narrationTasksRef.current.has(taskKey)) {
        log.info('[SceneNarration]', {
          event: 'skipped-already-in-flight',
          stageId,
          generationRunId,
          outlineId: outline.id,
          sceneId: scene.id,
        });
        return;
      }

      const controller = new AbortController();
      const narrationScene = sceneForNarrationSynthesis(scene);
      const narrationStartedAt = Date.now();
      log.info('[SceneNarration]', {
        event: 'scheduled',
        stageId,
        generationRunId,
        outlineId: outline.id,
        sceneId: scene.id,
        sceneIndex: outline.order,
        provider,
      });

      const promise = (async () => {
        try {
          options.onPhaseChange?.('narration', outline);
          const ttsResult = await generateTTSForScene(
            narrationScene,
            language,
            controller.signal,
            undefined,
            (progress) => {
              if (
                progress &&
                store.getState().generationEpoch === generationEpoch &&
                store.getState().getSceneById(scene.id)
              ) {
                store.getState().updateScene(scene.id, narrationProgressPatch(progress.status));
              }
              options.onNarrationQueueChange?.(progress, outline);
            },
            outline.id,
          );

          if (controller.signal.aborted || store.getState().generationEpoch !== generationEpoch) {
            await removeFreshTtsAllocations(speechAllocationIds(narrationScene));
            log.info('[SceneNarration]', {
              event: 'cancelled-stale',
              stageId,
              generationRunId,
              outlineId: outline.id,
              sceneId: scene.id,
            });
            return;
          }

          if (!ttsResult.success) {
            store.getState().updateScene(scene.id, narrationFailurePatch());
            log.warn('[SceneNarration]', {
              event: 'failed',
              stageId,
              generationRunId,
              outlineId: outline.id,
              sceneId: scene.id,
              durationMs: Date.now() - narrationStartedAt,
            });
            return;
          }

          const currentScene = store.getState().getSceneById(scene.id);
          if (!currentScene) {
            await removeFreshTtsAllocations(speechAllocationIds(narrationScene));
            return;
          }
          const patch = mergeCompletedNarration(currentScene, narrationScene);
          const retainedAudioIds = new Set(
            (patch.actions ?? []).flatMap((action) =>
              action.type === 'speech' && action.audioId ? [action.audioId] : [],
            ),
          );
          await removeFreshTtsAllocations(
            speechAllocationIds(narrationScene).filter((audioId) => !retainedAudioIds.has(audioId)),
          );
          store.getState().updateScene(scene.id, patch);
          log.info('[SceneNarration]', {
            event: patch.narrationStatus === 'completed' ? 'completed' : 'completed-stale',
            stageId,
            generationRunId,
            outlineId: outline.id,
            sceneId: scene.id,
            durationMs: Date.now() - narrationStartedAt,
          });
        } catch (error) {
          await removeFreshTtsAllocations(speechAllocationIds(narrationScene));
          if (isAbortError(error) || controller.signal.aborted) {
            log.info('[SceneNarration]', {
              event: 'aborted',
              stageId,
              generationRunId,
              outlineId: outline.id,
              sceneId: scene.id,
            });
            return;
          }
          if (
            store.getState().generationEpoch === generationEpoch &&
            store.getState().getSceneById(scene.id)
          ) {
            store.getState().updateScene(scene.id, narrationFailurePatch());
          }
          log.warn('[SceneNarration]', {
            event: 'failed',
            stageId,
            generationRunId,
            outlineId: outline.id,
            sceneId: scene.id,
            durationMs: Date.now() - narrationStartedAt,
            error: messageFromError(error, 'Narration generation failed'),
          });
        } finally {
          const activeTask = narrationTasksRef.current.get(taskKey);
          if (activeTask?.controller === controller) narrationTasksRef.current.delete(taskKey);
        }
      })();

      narrationTasksRef.current.set(taskKey, { controller, promise });
    },
    [options, store],
  );

  const generateRemaining = useCallback(
    async (params: GenerationParams) => {
      lastParamsRef.current = params;
      if (generatingRef.current) return;
      generatingRef.current = true;
      abortRef.current = false;
      const removeGeneratingOutline = (outlineId: string) => {
        const current = store.getState().generatingOutlines;
        if (!current.some((o) => o.id === outlineId)) return;
        store.getState().setGeneratingOutlines(current.filter((o) => o.id !== outlineId));
      };
      const addGeneratingOutline = (outline: SceneOutline) => {
        const current = store.getState().generatingOutlines;
        if (current.some((candidate) => candidate.id === outline.id)) return;
        store.getState().setGeneratingOutlines([...current, outline]);
      };

      // Create a new AbortController for this generation run
      fetchAbortRef.current = new AbortController();
      const signal = fetchAbortRef.current.signal;

      const state = store.getState();
      const { outlines, scenes, stage } = state;
      const startEpoch = state.generationEpoch;
      const generationStartedAt = Date.now();
      const generationRunId = `${stage?.id ?? 'unknown'}:${startEpoch}:${generationStartedAt}`;
      if (!stage || outlines.length === 0) {
        generatingRef.current = false;
        return;
      }

      store.getState().setGenerationStatus('generating');

      // Determine pending outlines
      const completedOrders = new Set(scenes.map((s) => s.order));
      const failedIds = new Set(state.failedOutlines.map((outline) => outline.id));
      const pending = outlines
        .filter((o) => !failedIds.has(o.id) && !completedOrders.has(o.order))
        .sort((a, b) => a.order - b.order);

      if (pending.length === 0) {
        store.getState().setGenerationStatus('completed');
        store.getState().setGeneratingOutlines([]);
        store.getState().setGenerationComplete(true);
        traceSceneGeneration('lesson-generation-complete', {
          stageId: stage.id,
          generationRunId,
          totalScenes: outlines.length,
          status: 'completed',
        });
        options.onComplete?.();
        generatingRef.current = false;
        return;
      }

      traceSceneGeneration('lesson-generation-start', {
        stageId: stage.id,
        generationRunId,
        pendingCount: pending.length,
        totalScenes: outlines.length,
      });
      for (const outline of pending) {
        traceSceneGeneration('scene-queued', {
          stageId: stage.id,
          generationRunId,
          outlineId: outline.id,
          sceneIndex: outline.order,
          totalScenes: outlines.length,
          sceneType: outline.type,
          title: outline.title,
        });
      }

      // Launch media generation in parallel — does not block content/action generation.
      // Under server-backed persistence, abort whatever the ref held first:
      // replacing it would orphan that loop with a signal nothing can ever
      // fire, leaving it calling providers and storing assets — real spend and
      // real storage — for a course the user may already have left, and leaving
      // `stop()` able to reach only the newest pass. The orchestrator then
      // waits for the aborted pass to settle before collecting, so the two
      // never overlap. Browser-only mode keeps its original behaviour, where an
      // overlapping pass costs a duplicate download and nothing else.
      if (isServerBackedMediaPersistence()) mediaAbortRef.current?.abort();
      mediaAbortRef.current = new AbortController();
      generateMediaForOutlines(outlines, stage.id, mediaAbortRef.current.signal).catch((err) => {
        log.warn('Media generation error:', err);
      });

      // Get previousSpeeches from last completed scene
      let previousSpeeches: string[] = [];
      const sortedScenes = [...scenes].sort((a, b) => a.order - b.order);
      if (sortedScenes.length > 0) {
        const lastScene = sortedScenes[sortedScenes.length - 1];
        previousSpeeches = (lastScene.actions || [])
          .filter((a): a is SpeechAction => a.type === 'speech')
          .map((a) => a.text);
      }

      // #572: opt-in parallel content fetch. Concurrency is server-configured
      // (PARALLEL_SCENE_CONCURRENCY), default 0 = off, so out-of-box behaviour is
      // unchanged.
      const parallelConcurrency = Math.max(
        0,
        // Belt-and-suspenders: the value is already clamped server-side and again
        // in the settings store; re-clamp here so a stale/garbage store value can
        // never spawn an unbounded fetch fan-out.
        Math.floor(useSettingsStore.getState().parallelSceneConcurrency ?? 0),
      );
      const useParallelContent = parallelConcurrency > 1 && pending.length > 1;

      // Pipelined generation loop (#572). When parallelism is on, scene *content*
      // fetches are kicked off up front with bounded concurrency (lazyBoundedMap)
      // but CONSUMED IN ORDER inside the serial loop below — there is no barrier.
      // So the first scene paints after content(1)+actions(1), while narration(1)
      // and later content fetches continue without hiding that renderable scene.
      // Content has no cross-scene dependency, so running it ahead is safe;
      // actions + TTS stay strictly serial to preserve previousSpeeches threading
      // and bounded provider load. With parallelism off this retains the original
      // one-at-a-time dispatch order.
      try {
        const fetchContent = (outline: SceneOutline) => {
          addGeneratingOutline(outline);
          traceSceneGeneration('scene-attempt-dispatch', {
            stageId: stage.id,
            generationRunId,
            outlineId: outline.id,
            generationEpoch: startEpoch,
          });
          return fetchSceneContent(
            {
              outline,
              allOutlines: outlines,
              stageId: stage.id,
              pdfImages: params.pdfImages,
              imageMapping: params.imageMapping,
              stageInfo: params.stageInfo,
              agents: params.agents,
              languageDirective: params.languageDirective,
            },
            signal,
          );
        };

        // Pre-warm content fetches (<= parallelConcurrency in flight), keyed by
        // outline id. Each promise resolves to a result and never rejects, so an
        // unexpected throw routes through the same mark-failed path as the serial
        // loop instead of taking sibling fetches down with it.
        const contentPromises = useParallelContent
          ? new Map(
              lazyBoundedMap(
                pending,
                parallelConcurrency,
                async (outline): Promise<SceneContentResult> => {
                  options.onPhaseChange?.('content', outline);
                  try {
                    return await fetchContent(outline);
                  } catch (err) {
                    return {
                      success: false,
                      error: err instanceof Error ? err.message : 'Content generation failed',
                    };
                  }
                },
                {
                  shouldContinue: () =>
                    !abortRef.current && store.getState().generationEpoch === startEpoch,
                },
              ).map((promise, i) => [pending[i].id, promise] as const),
            )
          : null;

        let pausedByFailureOrAbort = false;
        let hadContentFailure = false;
        for (const outline of pending) {
          if (abortRef.current || store.getState().generationEpoch !== startEpoch) {
            store.getState().setGenerationStatus('paused');
            pausedByFailureOrAbort = true;
            break;
          }
          if (store.getState().scenes.some((scene) => scene.order === outline.order)) {
            removeGeneratingOutline(outline.id);
            traceSceneGeneration('scene-attempt-skipped-committed', {
              stageId: stage.id,
              generationRunId,
              outlineId: outline.id,
              generationEpoch: startEpoch,
            });
            continue;
          }

          store.getState().setCurrentGeneratingOrder(outline.order);
          const sceneStartedAt = Date.now();
          traceSceneGeneration('scene-generation-start', {
            stageId: stage.id,
            generationRunId,
            outlineId: outline.id,
            sceneIndex: outline.order,
            totalScenes: outlines.length,
            sceneType: outline.type,
            title: outline.title,
          });

          // Step 1: content — await this outline's pre-warmed fetch (parallel),
          // which usually resolved while the previous scene's actions/TTS ran; or
          // fetch it now (serial).
          let contentResult: SceneContentResult;
          const contentStartedAt = Date.now();
          traceSceneGeneration('scene-content-start', {
            stageId: stage.id,
            generationRunId,
            outlineId: outline.id,
            sceneIndex: outline.order,
            totalScenes: outlines.length,
            sceneType: outline.type,
          });
          if (contentPromises) {
            contentResult = (await contentPromises.get(outline.id)) ?? {
              success: false,
              error: 'Content generation failed',
            };
          } else {
            options.onPhaseChange?.('content', outline);
            contentResult = await fetchContent(outline);
          }

          if (!contentResult.success || !contentResult.content) {
            traceSceneGeneration('scene-content-failed', {
              stageId: stage.id,
              generationRunId,
              outlineId: outline.id,
              sceneIndex: outline.order,
              durationMs: Date.now() - contentStartedAt,
              status: 'failed',
              errorCode: contentResult.errorCode,
              statusCode: contentResult.statusCode,
            });
            if (abortRef.current || store.getState().generationEpoch !== startEpoch) {
              pausedByFailureOrAbort = true;
              break;
            }
            if (contentResult.errorCode?.startsWith('GENERATION_ATTEMPT_')) {
              removeGeneratingOutline(outline.id);
              pausedByFailureOrAbort = true;
              traceSceneGeneration('scene-attempt-stale-rejected', {
                stageId: stage.id,
                generationRunId,
                outlineId: outline.id,
                generationEpoch: startEpoch,
                errorCode: contentResult.errorCode,
              });
              break;
            }
            store.getState().addFailedOutline(outline);
            removeGeneratingOutline(outline.id);
            options.onSceneFailed?.(outline, contentResult.error || 'Content generation failed');
            if (contentPromises) {
              // Parallel: surface the failure but keep going with the other scenes
              // (their content is already in flight).
              hadContentFailure = true;
              removeGeneratingOutline(outline.id);
              continue;
            }
            // Serial: pause the batch (unchanged behaviour).
            store.getState().setGenerationStatus('paused');
            pausedByFailureOrAbort = true;
            break;
          }

          if (abortRef.current || store.getState().generationEpoch !== startEpoch) {
            store.getState().setGenerationStatus('paused');
            pausedByFailureOrAbort = true;
            break;
          }
          traceSceneGeneration('scene-content-complete', {
            stageId: stage.id,
            generationRunId,
            outlineId: outline.id,
            sceneIndex: outline.order,
            durationMs: Date.now() - contentStartedAt,
            status: 'completed',
          });

          // Step 2: Generate actions + assemble scene
          options.onPhaseChange?.('actions', outline);
          const actionsStartedAt = Date.now();
          traceSceneGeneration('scene-actions-start', {
            stageId: stage.id,
            generationRunId,
            outlineId: outline.id,
            sceneIndex: outline.order,
            totalScenes: outlines.length,
            sceneType: outline.type,
          });
          const actionsResult = await fetchSceneActions(
            {
              outline: contentResult.effectiveOutline || outline,
              allOutlines: outlines,
              content: contentResult.content,
              stageId: stage.id,
              agents: params.agents,
              previousSpeeches,
              userProfile: params.userProfile,
              languageDirective: params.languageDirective,
              attemptId: contentResult.attemptId,
              generationVersion: contentResult.generationVersion,
            },
            signal,
          );

          if (actionsResult.success && actionsResult.scene) {
            traceSceneGeneration('scene-actions-complete', {
              stageId: stage.id,
              generationRunId,
              outlineId: outline.id,
              sceneId: actionsResult.scene.id,
              sceneIndex: outline.order,
              durationMs: Date.now() - actionsStartedAt,
              status: 'completed',
            });
            if (
              actionsResult.attemptId !== contentResult.attemptId ||
              actionsResult.generationVersion !== contentResult.generationVersion
            ) {
              removeGeneratingOutline(outline.id);
              pausedByFailureOrAbort = true;
              traceSceneGeneration('scene-attempt-stale-rejected', {
                stageId: stage.id,
                generationRunId,
                outlineId: outline.id,
                generationEpoch: startEpoch,
                errorCode: 'GENERATION_ATTEMPT_INVALID',
              });
              break;
            }
            const assembledScene = { ...actionsResult.scene, outlineId: outline.id };
            const settings = useSettingsStore.getState();
            const teacherVoiceProfileId = store.getState().stage?.teacherVoiceProfileId;
            const narrationEnabled = Boolean(
              teacherVoiceProfileId ||
              (settings.ttsEnabled &&
                settings.ttsProviderId !== 'browser-native-tts' &&
                isTTSProviderEnabled(
                  settings.ttsProviderId,
                  settings.ttsProvidersConfig?.[settings.ttsProviderId],
                )),
            );
            const scene = narrationEnabled
              ? sceneWithPendingNarration(assembledScene)
              : assembledScene;

            // Content + actions are the visual completion boundary. Commit the
            // scene before narration so a queued or failed voice job cannot
            // hide a renderable slide or turn it into a failed outline.
            if (store.getState().generationEpoch !== startEpoch) {
              pausedByFailureOrAbort = true;
              break;
            }
            const commitResult = await commitSceneAttempt({
              attemptId: contentResult.attemptId!,
              generationVersion: contentResult.generationVersion!,
              stageId: stage.id,
              outlineId: outline.id,
              sceneId: scene.id,
            });
            if (!commitResult.success || !commitResult.accepted) {
              removeGeneratingOutline(outline.id);
              pausedByFailureOrAbort = true;
              traceSceneGeneration('scene-attempt-stale-rejected', {
                stageId: stage.id,
                generationRunId,
                outlineId: outline.id,
                attemptId: contentResult.attemptId,
                generationEpoch: startEpoch,
                errorCode: commitResult.errorCode,
              });
              break;
            }
            removeGeneratingOutline(outline.id);
            const existingScene = store
              .getState()
              .scenes.find(
                (candidate) =>
                  candidate.outlineId === outline.id || candidate.order === outline.order,
              );
            if (!existingScene) useStageStore.getState().addScene(scene);
            traceSceneGeneration('scene-complete', {
              stageId: stage.id,
              generationRunId,
              outlineId: outline.id,
              sceneId: scene.id,
              sceneIndex: outline.order,
              totalScenes: outlines.length,
              durationMs: Date.now() - sceneStartedAt,
              status: 'completed',
            });
            if (!existingScene) options.onSceneGenerated?.(scene, outline.order);

            if (narrationEnabled && !existingScene) {
              scheduleNarration({
                scene,
                outline,
                stageId: stage.id,
                generationRunId,
                generationEpoch: startEpoch,
                language: params.languageDirective || params.stageInfo.language,
                provider: teacherVoiceProfileId ? 'teaching-voice' : settings.ttsProviderId,
              });
            }

            if (store.getState().generationEpoch !== startEpoch) {
              pausedByFailureOrAbort = true;
              break;
            }
            const nextOutline = pending.find((candidate) => candidate.order > outline.order);
            if (nextOutline) {
              traceSceneGeneration('next-scene-dispatch-after-visual-ready', {
                stageId: stage.id,
                generationRunId,
                outlineId: nextOutline.id,
                sceneIndex: nextOutline.order,
                totalScenes: outlines.length,
              });
            }
            previousSpeeches = actionsResult.previousSpeeches || [];
          } else {
            traceSceneGeneration('scene-actions-failed', {
              stageId: stage.id,
              generationRunId,
              outlineId: outline.id,
              sceneIndex: outline.order,
              durationMs: Date.now() - actionsStartedAt,
              status: 'failed',
              errorCode: actionsResult.errorCode,
              statusCode: actionsResult.statusCode,
            });
            if (abortRef.current || store.getState().generationEpoch !== startEpoch) {
              pausedByFailureOrAbort = true;
              break;
            }
            if (actionsResult.errorCode?.startsWith('GENERATION_ATTEMPT_')) {
              removeGeneratingOutline(outline.id);
              pausedByFailureOrAbort = true;
              traceSceneGeneration('scene-attempt-stale-rejected', {
                stageId: stage.id,
                generationRunId,
                outlineId: outline.id,
                attemptId: contentResult.attemptId,
                generationEpoch: startEpoch,
                errorCode: actionsResult.errorCode,
              });
              break;
            }
            store.getState().addFailedOutline(outline);
            removeGeneratingOutline(outline.id);
            options.onSceneFailed?.(outline, actionsResult.error || 'Actions generation failed');
            store.getState().setGenerationStatus('paused');
            pausedByFailureOrAbort = true;
            break;
          }
        }

        if (!abortRef.current && !pausedByFailureOrAbort) {
          if (hadContentFailure || store.getState().failedOutlines.length > 0) {
            // Parallel content phase left some outlines failed but kept going;
            // surface them for retry instead of signalling a clean completion.
            store.getState().setGenerationStatus('paused');
            traceSceneGeneration('generation-paused', {
              stageId: stage.id,
              generationRunId,
              status: 'paused',
            });
          } else {
            store.getState().setGenerationStatus('completed');
            store.getState().setGeneratingOutlines([]);
            store.getState().setGenerationComplete(true);
            traceSceneGeneration('lesson-generation-complete', {
              stageId: stage.id,
              generationRunId,
              totalScenes: outlines.length,
              totalGenerationElapsedMs: Date.now() - generationStartedAt,
              status: 'completed',
            });
            options.onComplete?.();
          }
        }
      } catch (err: unknown) {
        // AbortError is expected when stop() is called — don't treat as failure
        if (isAbortError(err)) {
          log.info('Generation aborted');
          store.getState().setGenerationStatus('paused');
          traceSceneGeneration('generation-aborted', {
            stageId: stage.id,
            generationRunId,
            status: 'aborted',
          });
        } else {
          throw err;
        }
      } finally {
        generatingRef.current = false;
        fetchAbortRef.current = null;
      }
    },
    [options, scheduleNarration, store],
  );

  // Keep ref in sync so retrySingleOutline can call it
  generateRemainingRef.current = generateRemaining;

  const stop = useCallback(() => {
    abortRef.current = true;
    store.getState().bumpGenerationEpoch();
    fetchAbortRef.current?.abort();
    mediaAbortRef.current?.abort();
    abortNarrationTasks();
    abortRetryTasks();
  }, [abortNarrationTasks, abortRetryTasks, store]);

  const isGenerating = useCallback(() => generatingRef.current, []);

  /** Retry a single failed outline from scratch (content → actions → TTS). */
  const retrySingleOutline = useCallback(
    async (outlineId: string) => {
      const state = store.getState();
      const outline = state.failedOutlines.find((o) => o.id === outlineId);
      const params = lastParamsRef.current;
      if (!outline || !state.stage || !params) return;
      // A whole-outline retry runs content, actions and narration on the
      // operator's keys. The surfaces already withhold the affordance when
      // generation is not permitted; refusing here keeps the precondition and
      // the render condition one rule.
      if (!mayGenerateForStage(state.stage.id)) return;
      const retryEpoch = state.generationEpoch;
      const retryKey = `${state.stage.id}:${retryEpoch}:${outline.id}`;
      if (retryTasksRef.current.has(retryKey)) return;

      // Regen-lock (#571): never silently replace a scene that is open in
      // edit mode. Failed outlines have no completed scene yet so this is
      // structurally a no-op today, but the guard is in place for the
      // moment a "regenerate a successful scene" path routes through here.
      const lockedScene = state.scenes.find((s) => s.order === outline.order);
      if (
        lockedScene &&
        isSceneEditLocked({
          sceneId: lockedScene.id,
          mode: state.mode,
          currentSceneId: state.currentSceneId,
        })
      ) {
        return;
      }

      const removeGeneratingOutline = () => {
        const current = store.getState().generatingOutlines;
        if (!current.some((o) => o.id === outlineId)) return;
        store.getState().setGeneratingOutlines(current.filter((o) => o.id !== outlineId));
      };

      // Remove from failed list and mark as generating
      store.getState().retryFailedOutline(outlineId);
      store.getState().setGenerationStatus('generating');
      const currentGenerating = store.getState().generatingOutlines;
      if (!currentGenerating.some((o) => o.id === outline.id)) {
        store.getState().setGeneratingOutlines([...currentGenerating, outline]);
      }

      const abortController = new AbortController();
      retryTasksRef.current.set(retryKey, abortController);
      const signal = abortController.signal;
      let committedSceneId: string | null = null;

      try {
        // Step 1: Content
        const contentResult = await fetchSceneContent(
          {
            outline,
            allOutlines: state.outlines,
            stageId: state.stage.id,
            pdfImages: params.pdfImages,
            imageMapping: params.imageMapping,
            stageInfo: params.stageInfo,
            agents: params.agents,
            languageDirective: params.languageDirective,
          },
          signal,
        );

        if (!contentResult.success || !contentResult.content) {
          if (contentResult.errorCode?.startsWith('GENERATION_ATTEMPT_')) return;
          store.getState().addFailedOutline(outline);
          options.onSceneFailed?.(outline, contentResult.error || 'Content generation failed');
          return;
        }

        // Step 2: Actions
        const sortedScenes = store
          .getState()
          .scenes.filter((scene) => scene.order < outline.order)
          .sort((a, b) => a.order - b.order);
        const lastScene = sortedScenes[sortedScenes.length - 1];
        const previousSpeeches = lastScene
          ? (lastScene.actions || [])
              .filter((a): a is SpeechAction => a.type === 'speech')
              .map((a) => a.text)
          : [];

        const actionsResult = await fetchSceneActions(
          {
            outline: contentResult.effectiveOutline || outline,
            allOutlines: state.outlines,
            content: contentResult.content,
            stageId: state.stage.id,
            agents: params.agents,
            previousSpeeches,
            userProfile: params.userProfile,
            languageDirective: params.languageDirective,
            attemptId: contentResult.attemptId,
            generationVersion: contentResult.generationVersion,
          },
          signal,
        );

        const actionsIdentityMismatch =
          actionsResult.attemptId !== contentResult.attemptId ||
          actionsResult.generationVersion !== contentResult.generationVersion;
        if (!actionsResult.success || !actionsResult.scene || actionsIdentityMismatch) {
          if (
            actionsIdentityMismatch ||
            actionsResult.errorCode?.startsWith('GENERATION_ATTEMPT_')
          ) {
            return;
          }
          store.getState().addFailedOutline(outline);
          options.onSceneFailed?.(outline, actionsResult.error || 'Actions generation failed');
          return;
        }

        const settings = useSettingsStore.getState();
        const teacherVoiceProfileId = state.stage.teacherVoiceProfileId;
        const narrationEnabled = Boolean(
          teacherVoiceProfileId ||
          (settings.ttsEnabled &&
            settings.ttsProviderId !== 'browser-native-tts' &&
            isTTSProviderEnabled(
              settings.ttsProviderId,
              settings.ttsProvidersConfig?.[settings.ttsProviderId],
            )),
        );
        const authoritativeScene = { ...actionsResult.scene, outlineId: outline.id };
        const scene = narrationEnabled
          ? sceneWithPendingNarration(authoritativeScene)
          : authoritativeScene;

        if (store.getState().generationEpoch !== retryEpoch) return;
        const commitResult = await commitSceneAttempt({
          attemptId: contentResult.attemptId!,
          generationVersion: contentResult.generationVersion!,
          stageId: state.stage.id,
          outlineId: outline.id,
          sceneId: scene.id,
        });
        if (!commitResult.success || !commitResult.accepted) return;
        removeGeneratingOutline();
        const existingScene = store
          .getState()
          .scenes.find(
            (candidate) => candidate.outlineId === outline.id || candidate.order === outline.order,
          );
        if (!existingScene) {
          useStageStore.getState().addScene(scene);
          committedSceneId = scene.id;
          options.onSceneGenerated?.(scene, outline.order);
        } else {
          committedSceneId = existingScene.id;
        }

        if (narrationEnabled && !existingScene) {
          scheduleNarration({
            scene,
            outline,
            stageId: state.stage.id,
            generationRunId: `${state.stage.id}:${retryEpoch}:retry-${outline.id}`,
            generationEpoch: retryEpoch,
            language: params.languageDirective || params.stageInfo.language,
            provider: teacherVoiceProfileId ? 'teaching-voice' : settings.ttsProviderId,
          });
        }

        if (store.getState().generationEpoch !== retryEpoch) {
          return;
        }

        // Resume from derived queued work. `generatingOutlines` contains only
        // requests actually dispatched, so it must never stand in for pending.
        const latest = store.getState();
        const completedOrders = new Set(latest.scenes.map((candidate) => candidate.order));
        const failedIds = new Set(latest.failedOutlines.map((candidate) => candidate.id));
        const hasPending = latest.outlines.some(
          (candidate) => !completedOrders.has(candidate.order) && !failedIds.has(candidate.id),
        );
        if (hasPending && lastParamsRef.current) {
          generateRemainingRef.current?.(lastParamsRef.current);
        } else if (store.getState().failedOutlines.length > 0) {
          store.getState().setGenerationStatus('paused');
        } else {
          // This retry may have materialized the final outstanding slide. The
          // generateRemaining completion path is not reached on the retry flow,
          // so mark completion here too — otherwise a later delete would treat
          // the orphaned outline as pending and regenerate it.
          store.getState().markGenerationCompleteIfDone();
          store.getState().setGenerationStatus('completed');
        }
      } catch (err) {
        if (!isAbortError(err)) {
          if (committedSceneId) {
            store.getState().updateScene(committedSceneId, narrationFailurePatch());
          } else {
            store.getState().addFailedOutline(outline);
          }
        }
      } finally {
        if (!committedSceneId) {
          removeGeneratingOutline();
          if (store.getState().generationEpoch === retryEpoch) {
            store.getState().setGenerationStatus('paused');
          }
        }
        if (retryTasksRef.current.get(retryKey) === abortController) {
          retryTasksRef.current.delete(retryKey);
        }
      }
    },
    [options, scheduleNarration, store],
  );

  return { generateRemaining, retrySingleOutline, stop, isGenerating };
}
