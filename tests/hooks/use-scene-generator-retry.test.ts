import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
  normalizeGenerationPreviewLanguageState,
  validateGenerationPreviewVoiceSelection,
} from '@/app/generation-preview/voice-language';
import type { GenerationSessionState } from '@/app/generation-preview/types';
import type { SceneOutline } from '@/lib/types/generation';

const mocks = vi.hoisted(() => ({
  getCurrentModelConfig: vi.fn(),
  settingsState: vi.fn(),
  audioPut: vi.fn(),
  audioDelete: vi.fn(),
  poolPut: vi.fn(),
  poolReplace: vi.fn(),
  poolRemove: vi.fn(),
  isTTSProviderEnabled: vi.fn(),
  pickNarratorAgent: vi.fn(),
  resolveAgentVoiceOptions: vi.fn(),
  listAgents: vi.fn(),
  stageState: vi.fn(),
  toastWarning: vi.fn(),
  staticVoiceEnabled: vi.fn(),
}));

vi.mock('@/lib/utils/model-config', () => ({
  getCurrentModelConfig: mocks.getCurrentModelConfig,
}));

vi.mock('@/lib/store/settings', () => ({
  useSettingsStore: {
    getState: mocks.settingsState,
  },
}));

vi.mock('@/lib/store/stage', () => ({
  flushStageSave: vi.fn().mockResolvedValue(undefined),
  useStageStore: {
    getState: mocks.stageState,
  },
}));

vi.mock('@/lib/utils/database', () => ({
  db: {
    audioFiles: {
      put: mocks.audioPut,
      delete: mocks.audioDelete,
    },
  },
}));

vi.mock('@/lib/media/asset-pool', () => ({
  putAsset: mocks.poolPut,
  replaceAsset: mocks.poolReplace,
  removeAsset: mocks.poolRemove,
}));

vi.mock('@/lib/audio/provider-enablement', () => ({
  isTTSProviderEnabled: mocks.isTTSProviderEnabled,
}));

vi.mock('@/lib/audio/agent-voice', () => ({
  pickNarratorAgent: mocks.pickNarratorAgent,
  resolveAgentVoiceOptions: mocks.resolveAgentVoiceOptions,
}));

vi.mock('@/lib/orchestration/registry/store', () => ({
  useAgentRegistry: {
    getState: () => ({
      listAgents: mocks.listAgents,
    }),
  },
}));

vi.mock('sonner', () => ({ toast: { warning: mocks.toastWarning } }));
vi.mock('@/lib/config/feature-flags', () => ({
  isStaticVoiceEnabled: mocks.staticVoiceEnabled,
}));

const mockFetch = vi.fn() as Mock;
vi.stubGlobal('fetch', mockFetch);

const outline = {
  id: 'outline-1',
  type: 'slide',
  title: 'Retry Scene',
  description: 'Retry transient failures',
  keyPoints: ['retry'],
  order: 2,
} as SceneOutline;

const simulationOutline = {
  id: 'outline-sim',
  type: 'interactive',
  title: 'Long Simulation',
  description: 'Generate a long-running simulation.',
  keyPoints: ['simulate'],
  order: 3,
  widgetType: 'simulation',
  widgetOutline: { concept: 'long_simulation' },
} as SceneOutline;

const retryOptions = {
  maxRetries: 1,
  sleep: async () => undefined,
  random: () => 0,
};

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 429 ? 'Too Many Requests' : status === 401 ? 'Unauthorized' : 'OK',
    json: async () => body,
  };
}

function teachingVoiceWav(): ArrayBuffer {
  const sampleCount = 2_400;
  const bytes = new Uint8Array(44 + sampleCount * 2);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode('RIFF'), 0);
  view.setUint32(4, 36 + sampleCount * 2, true);
  bytes.set(new TextEncoder().encode('WAVEfmt '), 8);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 24_000, true);
  view.setUint32(28, 48_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  bytes.set(new TextEncoder().encode('data'), 36);
  view.setUint32(40, sampleCount * 2, true);
  return bytes.buffer;
}

describe('browser scene generation retry wrappers', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mocks.audioPut.mockReset();
    mocks.audioDelete.mockReset().mockResolvedValue(undefined);
    mocks.poolPut.mockReset();
    mocks.poolReplace.mockReset().mockResolvedValue(undefined);
    mocks.poolRemove.mockReset().mockResolvedValue(undefined);
    mocks.poolPut.mockResolvedValue('ast_audio_allocated');
    mocks.getCurrentModelConfig.mockReturnValue({});
    mocks.settingsState.mockReturnValue({
      imageProviderId: '',
      imageProvidersConfig: {},
      imageGenerationEnabled: false,
      videoProviderId: '',
      videoProvidersConfig: {},
      videoGenerationEnabled: false,
      ttsProviderId: 'server-tts',
      ttsProvidersConfig: {
        'server-tts': {
          apiKey: 'tts-key',
          modelId: 'tts-model',
        },
      },
      ttsVoice: 'narrator',
      ttsSpeed: 1,
    });
    mocks.isTTSProviderEnabled.mockReturnValue(true);
    mocks.pickNarratorAgent.mockReturnValue(undefined);
    mocks.resolveAgentVoiceOptions.mockClear();
    mocks.resolveAgentVoiceOptions.mockResolvedValue({});
    mocks.listAgents.mockReturnValue([]);
    mocks.stageState.mockReturnValue({ stage: { id: 'stage-1' } });
    mocks.toastWarning.mockReset();
    mocks.staticVoiceEnabled.mockReturnValue(true);
  });

  it('retries transient scene content HTTP failures before returning success', async () => {
    const { fetchSceneContent } = await import('@/lib/hooks/use-scene-generator');
    mockFetch
      .mockResolvedValueOnce(jsonResponse(429, { error: 'rate limited' }))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          success: true,
          content: { elements: [] },
          attemptId: 'attempt-content',
          generationVersion: 'version-1',
        }),
      );

    const result = await fetchSceneContent(
      {
        outline,
        allOutlines: [outline],
        stageId: 'stage-1',
        stageInfo: { name: 'Retry Course' },
      },
      undefined,
      retryOptions,
    );

    expect(result).toMatchObject({ success: true, content: { elements: [] } });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('does not retry permanent scene action HTTP failures', async () => {
    const { fetchSceneActions } = await import('@/lib/hooks/use-scene-generator');
    mockFetch.mockResolvedValue(jsonResponse(401, { error: 'unauthorized' }));

    const result = await fetchSceneActions(
      {
        outline,
        allOutlines: [outline],
        content: { elements: [] },
        stageId: 'stage-1',
      },
      undefined,
      retryOptions,
    );

    expect(result).toMatchObject({ success: false, error: 'unauthorized' });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('preserves scene content error metadata for localized UI messages', async () => {
    const { fetchSceneContent } = await import('@/lib/hooks/use-scene-generator');
    mockFetch.mockResolvedValue(
      jsonResponse(429, {
        success: false,
        errorCode: 'RATE_LIMITED',
        error: 'Upstream rate limit reached. Please try again shortly.',
      }),
    );

    const result = await fetchSceneContent(
      {
        outline,
        allOutlines: [outline],
        stageId: 'stage-1',
        stageInfo: { name: 'Retry Course' },
      },
      undefined,
      { ...retryOptions, maxRetries: 0 },
    );

    expect(result).toMatchObject({
      success: false,
      errorCode: 'RATE_LIMITED',
      statusCode: 429,
    });
  });

  it('polls async simulation content until the job completes', async () => {
    const { fetchSceneContent } = await import('@/lib/hooks/use-scene-generator');
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse(202, {
          success: true,
          async: true,
          jobId: 'job-1',
          stageId: 'stage-1',
          outlineId: simulationOutline.id,
          status: 'queued',
          pollIntervalMs: 1,
          attemptId: 'attempt-simulation',
          generationVersion: 'version-1',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          success: true,
          async: true,
          jobId: 'job-1',
          stageId: 'stage-1',
          outlineId: simulationOutline.id,
          status: 'generating',
          attemptId: 'attempt-simulation',
          generationVersion: 'version-1',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          success: true,
          async: true,
          jobId: 'job-1',
          stageId: 'stage-1',
          outlineId: simulationOutline.id,
          status: 'completed',
          content: { html: '<html>Simulation</html>', widgetType: 'simulation' },
          effectiveOutline: simulationOutline,
          attemptId: 'attempt-simulation',
          generationVersion: 'version-1',
        }),
      );

    const result = await fetchSceneContent(
      {
        outline: simulationOutline,
        allOutlines: [simulationOutline],
        stageId: 'stage-1',
        stageInfo: { name: 'Retry Course' },
      },
      undefined,
      retryOptions,
    );

    expect(result).toMatchObject({
      success: true,
      content: { html: '<html>Simulation</html>', widgetType: 'simulation' },
      jobId: 'job-1',
      status: 'completed',
    });
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(mockFetch.mock.calls[1][0]).toBe('/api/generate/scene-content/status?jobId=job-1');
  });

  it('stops polling async simulation content after a failed job', async () => {
    const { fetchSceneContent } = await import('@/lib/hooks/use-scene-generator');
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse(202, {
          success: true,
          async: true,
          jobId: 'job-failed',
          stageId: 'stage-1',
          outlineId: simulationOutline.id,
          status: 'queued',
          pollIntervalMs: 1,
          attemptId: 'attempt-failed',
          generationVersion: 'version-1',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          success: true,
          async: true,
          jobId: 'job-failed',
          stageId: 'stage-1',
          outlineId: simulationOutline.id,
          status: 'failed',
          error: 'Simulation generation failed',
          attemptId: 'attempt-failed',
          generationVersion: 'version-1',
        }),
      );

    const result = await fetchSceneContent(
      {
        outline: simulationOutline,
        allOutlines: [simulationOutline],
        stageId: 'stage-1',
        stageInfo: { name: 'Retry Course' },
      },
      undefined,
      retryOptions,
    );

    expect(result).toMatchObject({
      success: false,
      error: 'Simulation generation failed',
      jobId: 'job-failed',
      status: 'failed',
    });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('rejects an async job whose stage or outline identity does not match the request', async () => {
    const { fetchSceneContent } = await import('@/lib/hooks/use-scene-generator');
    mockFetch.mockResolvedValueOnce(
      jsonResponse(202, {
        success: true,
        async: true,
        jobId: 'job-wrong-outline',
        stageId: 'stage-1',
        outlineId: 'outline-other',
        status: 'queued',
        attemptId: 'attempt-wrong-outline',
        generationVersion: 'version-1',
      }),
    );

    const result = await fetchSceneContent(
      {
        outline: simulationOutline,
        allOutlines: [simulationOutline],
        stageId: 'stage-1',
        stageInfo: { name: 'Retry Course' },
      },
      undefined,
      retryOptions,
    );

    expect(result).toMatchObject({
      success: false,
      status: 'failed',
      jobTerminal: true,
      errorCode: 'GENERATION_FAILED',
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('rethrows aborts while polling async simulation content', async () => {
    const { fetchSceneContent } = await import('@/lib/hooks/use-scene-generator');
    const controller = new AbortController();
    const abort = Object.assign(new Error('Aborted'), { name: 'AbortError' });
    mockFetch.mockResolvedValueOnce(
      jsonResponse(202, {
        success: true,
        async: true,
        jobId: 'job-abort',
        stageId: 'stage-1',
        outlineId: simulationOutline.id,
        status: 'queued',
        pollIntervalMs: 1,
        attemptId: 'attempt-abort',
        generationVersion: 'version-1',
      }),
    );

    await expect(
      fetchSceneContent(
        {
          outline: simulationOutline,
          allOutlines: [simulationOutline],
          stageId: 'stage-1',
          stageInfo: { name: 'Retry Course' },
        },
        controller.signal,
        {
          ...retryOptions,
          sleep: async () => {
            controller.abort();
            throw abort;
          },
        },
      ),
    ).rejects.toBe(abort);

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('preserves internal scene content errors for localized fallback messages', async () => {
    const { fetchSceneContent } = await import('@/lib/hooks/use-scene-generator');
    mockFetch.mockResolvedValue(
      jsonResponse(500, {
        success: false,
        errorCode: 'INTERNAL_ERROR',
        error: 'Scene generation failed. Please try again.',
      }),
    );

    const result = await fetchSceneContent(
      {
        outline,
        allOutlines: [outline],
        stageId: 'stage-1',
        stageInfo: { name: 'Retry Course' },
      },
      undefined,
      { ...retryOptions, maxRetries: 0 },
    );

    expect(result).toMatchObject({
      success: false,
      errorCode: 'INTERNAL_ERROR',
      statusCode: 500,
    });
  });

  it('rethrows an aborted scene content request', async () => {
    const { fetchSceneContent } = await import('@/lib/hooks/use-scene-generator');
    const abort = Object.assign(new Error('Aborted'), { name: 'AbortError' });
    mockFetch.mockRejectedValueOnce(abort);

    await expect(
      fetchSceneContent(
        {
          outline,
          allOutlines: [outline],
          stageId: 'stage-1',
          stageInfo: { name: 'Retry Course' },
        },
        undefined,
        retryOptions,
      ),
    ).rejects.toBe(abort);

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('rethrows an aborted scene actions request', async () => {
    const { fetchSceneActions } = await import('@/lib/hooks/use-scene-generator');
    const abort = Object.assign(new Error('Aborted'), { name: 'AbortError' });
    mockFetch.mockRejectedValueOnce(abort);

    await expect(
      fetchSceneActions(
        {
          outline,
          allOutlines: [outline],
          content: { elements: [] },
          stageId: 'stage-1',
        },
        undefined,
        retryOptions,
      ),
    ).rejects.toBe(abort);

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('retries transient TTS failures before storing audio', async () => {
    const { generateAndStoreTTS } = await import('@/lib/hooks/use-scene-generator');
    mockFetch
      .mockResolvedValueOnce(jsonResponse(503, { error: 'provider overloaded' }))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          success: true,
          base64: btoa('audio-data'),
          format: 'wav',
        }),
      );

    const audioId = await generateAndStoreTTS(
      'tts_s2_action_1',
      'Hello class',
      'English',
      undefined,
      retryOptions,
    );

    expect(audioId).toBe('tts_s2_action_1');
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mocks.poolPut).not.toHaveBeenCalled();
    expect(mocks.audioPut).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'tts_s2_action_1',
        format: 'wav',
      }),
    );
  });

  it('does not initialize or request a generic narrator when static voice is disabled', async () => {
    mocks.staticVoiceEnabled.mockReturnValue(false);
    const { generateAndStoreTTS } = await import('@/lib/hooks/use-scene-generator');

    await expect(generateAndStoreTTS('tts_static_off', 'Hello class')).resolves.toBeNull();

    expect(mockFetch).not.toHaveBeenCalled();
    expect(mocks.resolveAgentVoiceOptions).not.toHaveBeenCalled();
  });

  it('uses the structured lesson language instead of an ambiguous narration directive', async () => {
    mocks.stageState.mockReturnValue({
      stage: { id: 'stage-1', teacherVoiceProfileId: 'vcp_ready', lessonLanguage: 'hi' },
    });
    const { generateAndStoreTTS } = await import('@/lib/hooks/use-scene-generator');
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse(200, {
          success: true,
          async: true,
          teachingVoiceProvider: 'indicf5',
          jobId: 'rq_completed_indicf5_language_test',
          status: 'completed',
          statusUrl: '/api/generate/tts/jobs/rq_completed_indicf5_language_test',
          audioUrl: '/api/generate/tts/jobs/rq_completed_indicf5_language_test/audio',
        }),
      )
      .mockResolvedValueOnce(
        new Response(teachingVoiceWav(), {
          status: 200,
          headers: { 'content-type': 'audio/wav' },
        }),
      );

    await generateAndStoreTTS(
      'tts_s2_action_1',
      'Hello class',
      'Teach in Hindi while retaining technical terms in English.',
      undefined,
      retryOptions,
    );

    const body = JSON.parse(String(mockFetch.mock.calls[0][1]?.body));
    expect(body).toMatchObject({
      teacherVoiceProfileId: 'vcp_ready',
      ttsLanguageCode: 'hi',
    });
    expect(body.language).toBeUndefined();
  });

  it('sends the explicit course Qwen mode for individual narration generation', async () => {
    mocks.stageState.mockReturnValue({
      stage: {
        id: 'stage-1',
        teacherVoiceProfileId: 'vcp_ready',
        lessonLanguage: 'en',
        narration: {
          schemaVersion: 1,
          activeVersionId: 'original',
          versions: [],
          preferredSelection: {
            providerId: 'qwen3-tts',
            providerName: 'Qwen3-TTS (Original)',
            profileId: 'vcp_ready',
            language: 'en',
            enhancementMode: 'standard',
          },
        },
      },
    });
    const { generateAndStoreTTS } = await import('@/lib/hooks/use-scene-generator');
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse(200, {
          success: true,
          async: true,
          teachingVoiceProvider: 'qwen3-tts',
          jobId: 'rq_completed_qwen_original_test',
          status: 'completed',
          statusUrl: '/api/generate/tts/jobs/rq_completed_qwen_original_test',
          audioUrl: '/api/generate/tts/jobs/rq_completed_qwen_original_test/audio',
        }),
      )
      .mockResolvedValueOnce(
        new Response(teachingVoiceWav(), {
          status: 200,
          headers: { 'content-type': 'audio/wav' },
        }),
      );

    await generateAndStoreTTS(
      'tts_qwen_original',
      'Exact narration text.',
      'English',
      undefined,
      retryOptions,
    );

    expect(JSON.parse(String(mockFetch.mock.calls[0][1]?.body))).toMatchObject({
      teacherVoiceProfileId: 'vcp_ready',
      teachingVoiceProviderId: 'qwen3-tts',
      teachingVoiceEnhancementMode: 'standard',
      ttsLanguageCode: 'en',
    });
  });

  it('takes the exact Hindi Force preview through Scene 1 and IndicF5 queue admission', async () => {
    const outlines: SceneOutline[] = Array.from({ length: 4 }, (_, index) => ({
      id: `force-outline-${index + 1}`,
      type: index === 2 ? 'quiz' : 'slide',
      title: `Force ${index + 1}`,
      description: 'Force lesson scene.',
      keyPoints: ['Force'],
      order: index + 1,
    }));
    const previewSession = normalizeGenerationPreviewLanguageState({
      sessionId: 'force-hindi-session',
      requirements: {
        requirement:
          'Generate a short 4-slide lesson on Force in Hindi, including 2 explanation slides, 1 quiz, and 1 summary slide. Use simple Hindi throughout.',
      },
      pdfText: '',
      sceneOutlines: outlines,
      currentStep: 'generating',
      previewPhase: 'generating-content',
      teacherVoiceProfileId: 'vcp_force_hindi',
      languageDirective: 'Teach in the language that matches the user requirement.',
    } satisfies GenerationSessionState);
    const profileFetch = vi.fn(async () =>
      jsonResponse(200, {
        profile: {
          id: 'vcp_force_hindi',
          status: 'ready',
          provider: 'indicf5',
          language: 'hi',
          languageId: 'hi',
        },
      }),
    );

    const profile = await validateGenerationPreviewVoiceSelection(
      previewSession,
      profileFetch as typeof fetch,
    );
    mocks.stageState.mockReturnValue({
      stage: {
        id: 'stage-force-hindi',
        teacherVoiceProfileId: previewSession.teacherVoiceProfileId,
        lessonLanguage: previewSession.lessonLanguage,
      },
    });
    const { fetchSceneContent, generateAndStoreTTS } =
      await import('@/lib/hooks/use-scene-generator');
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse(200, {
          success: true,
          content: { elements: [] },
          attemptId: 'attempt-force-scene-1',
          generationVersion: 'version-force-1',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(202, {
          success: true,
          async: true,
          teachingVoiceProvider: 'indicf5',
          jobId: 'rq_force_hindi_scene_1',
          status: 'completed',
          statusUrl: '/api/generate/tts/jobs/rq_force_hindi_scene_1',
          audioUrl: '/api/generate/tts/jobs/rq_force_hindi_scene_1/audio',
        }),
      )
      .mockResolvedValueOnce(
        new Response(teachingVoiceWav(), {
          status: 200,
          headers: { 'content-type': 'audio/wav' },
        }),
      );

    const scene = await fetchSceneContent(
      {
        outline: outlines[0],
        allOutlines: outlines,
        stageId: 'stage-force-hindi',
        stageInfo: { name: 'Force in Hindi' },
        languageDirective: previewSession.languageDirective,
        requirements: previewSession.requirements,
      },
      undefined,
      retryOptions,
    );
    const audioId = await generateAndStoreTTS(
      'tts_force_hindi_scene_1',
      'बल किसी वस्तु की गति को बदल सकता है।',
      previewSession.languageDirective,
      undefined,
      retryOptions,
      undefined,
      'stage-force-hindi',
      undefined,
      0,
      'scene-force-hindi-1',
      undefined,
      outlines[0].id,
    );

    expect(previewSession.lessonLanguage).toBe('hi');
    expect(profile).toMatchObject({ provider: 'indicf5', language: 'hi' });
    expect(scene).toMatchObject({ success: true, attemptId: 'attempt-force-scene-1' });
    expect(audioId).toBe('tts_force_hindi_scene_1');
    expect(mockFetch.mock.calls[0][0]).toBe('/api/generate/scene-content');
    expect(JSON.parse(String(mockFetch.mock.calls[1][1]?.body))).toMatchObject({
      teacherVoiceProfileId: 'vcp_force_hindi',
      ttsLanguageCode: 'hi',
      stageId: 'stage-force-hindi',
      outlineId: 'force-outline-1',
    });
  });

  it('keeps scene content requests independent from selected faculty voice profiles', async () => {
    mocks.stageState.mockReturnValue({
      stage: { id: 'stage-1', teacherVoiceProfileId: 'vcp_ready' },
    });
    const { fetchSceneContent } = await import('@/lib/hooks/use-scene-generator');
    mockFetch.mockResolvedValue(
      jsonResponse(200, {
        success: true,
        content: { elements: [] },
        attemptId: 'attempt-content',
        generationVersion: 'version-1',
      }),
    );

    await fetchSceneContent(
      {
        outline,
        allOutlines: [outline],
        stageId: 'stage-1',
        stageInfo: { name: 'Retry Course' },
        languageDirective: 'Deliver the entire course in English.',
      },
      undefined,
      retryOptions,
    );

    expect(mockFetch).toHaveBeenCalledWith(
      '/api/generate/scene-content',
      expect.objectContaining({ method: 'POST' }),
    );
    const body = JSON.parse(String(mockFetch.mock.calls[0][1]?.body));
    expect(body.teacherVoiceProfileId).toBeUndefined();
  });

  it('falls back once from a missing narrator clone to the global voice', async () => {
    const { generateAndStoreTTS } = await import('@/lib/hooks/use-scene-generator');
    mocks.settingsState.mockReturnValue({
      ...mocks.settingsState(),
      ttsProviderId: 'qwen-tts',
      ttsVoice: 'Cherry',
      ttsProvidersConfig: {
        'qwen-tts': { apiKey: 'tts-key', modelId: 'qwen3-tts-vc-2026-01-22' },
      },
    });
    mocks.pickNarratorAgent.mockReturnValue({
      id: 'teacher-missing-clone',
      role: 'teacher',
      voiceConfig: { providerId: 'qwen-tts', voiceId: 'deleted-clone-id' },
    });
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse(400, {
          errorCode: 'QWEN_VC_VOICE_NOT_FOUND',
          error: 'The cloned Qwen voice no longer exists.',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, { success: true, base64: btoa('fallback-audio'), format: 'wav' }),
      );

    await expect(
      generateAndStoreTTS('request-fallback', 'Hello class', undefined, undefined, {
        ...retryOptions,
        maxRetries: 0,
      }),
    ).resolves.toBe('request-fallback');
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse(String(mockFetch.mock.calls[0][1]?.body));
    const secondBody = JSON.parse(String(mockFetch.mock.calls[1][1]?.body));
    expect(firstBody).toMatchObject({
      ttsVoice: 'deleted-clone-id',
      ttsModelId: 'qwen3-tts-vc-2026-01-22',
    });
    expect(secondBody).toMatchObject({ ttsVoice: 'Cherry', ttsModelId: 'qwen3-tts-flash' });
    expect(mocks.toastWarning).toHaveBeenCalledOnce();
  });

  it('stores directly in Dexie without consulting the asset pool', async () => {
    const { generateAndStoreTTS } = await import('@/lib/hooks/use-scene-generator');
    mockFetch.mockResolvedValue(
      jsonResponse(200, {
        success: true,
        base64: btoa('audio-data'),
        format: 'wav',
      }),
    );
    mocks.poolPut.mockRejectedValueOnce(new Error('pool unavailable'));

    await expect(generateAndStoreTTS('request-1', 'Hello class')).resolves.toBe('request-1');
    expect(mocks.poolPut).not.toHaveBeenCalled();
    expect(mocks.audioPut).toHaveBeenCalledOnce();
  });

  it('does not report an allocated id when the compatibility write fails', async () => {
    const { generateAndStoreTTS } = await import('@/lib/hooks/use-scene-generator');
    mockFetch.mockResolvedValue(
      jsonResponse(200, {
        success: true,
        base64: btoa('audio-data'),
        format: 'wav',
      }),
    );
    mocks.audioPut.mockRejectedValueOnce(new Error('Dexie unavailable'));

    await expect(generateAndStoreTTS('request-1', 'Hello class')).rejects.toThrow(
      'Dexie unavailable',
    );
    expect(mocks.poolPut).not.toHaveBeenCalled();
    expect(mocks.poolRemove).not.toHaveBeenCalled();
  });

  it('reclaims earlier allocations when partial scene synthesis fails', async () => {
    const { generateTTSForScene } = await import('@/lib/hooks/use-scene-generator');
    mocks.poolPut.mockResolvedValueOnce('ast_first_audio');
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse(200, {
          success: true,
          base64: btoa('first-audio'),
          format: 'wav',
        }),
      )
      .mockResolvedValueOnce(jsonResponse(401, { error: 'second speech rejected' }));
    const scene = {
      id: 'scene-1',
      stageId: 'stage-1',
      type: 'slide',
      title: 'Scene',
      order: 1,
      content: { type: 'slide', canvas: { id: 'slide-1', elements: [] } },
      actions: [
        { id: 'speech-1', type: 'speech', text: 'First line' },
        { id: 'speech-2', type: 'speech', text: 'Second line' },
      ],
    } as unknown as Parameters<typeof generateTTSForScene>[0];

    const result = await generateTTSForScene(scene, 'English', undefined, {
      ...retryOptions,
      maxRetries: 0,
    });

    expect(result).toMatchObject({ success: false, failedCount: 1 });
    expect(mocks.poolRemove).not.toHaveBeenCalled();
    expect(mocks.audioDelete).toHaveBeenCalledExactlyOnceWith('tts_s1_speech-1');
    expect(scene.actions?.every((action) => !('audioId' in action))).toBe(true);
  });

  it('waits for parallel TTS workers before rolling back an abandoned scene', async () => {
    const { generateTTSForScene } = await import('@/lib/hooks/use-scene-generator');
    mocks.settingsState.mockReturnValue({
      ...mocks.settingsState(),
      parallelSceneConcurrency: 2,
    });
    const abort = Object.assign(new Error('Aborted'), { name: 'AbortError' });
    let releaseSibling!: () => void;
    const siblingMayFinish = new Promise<void>((resolve) => {
      releaseSibling = resolve;
    });
    mockFetch.mockRejectedValueOnce(abort).mockImplementationOnce(async () => {
      await siblingMayFinish;
      return jsonResponse(200, {
        success: true,
        base64: btoa('late-audio'),
        format: 'wav',
      });
    });
    mocks.poolPut.mockResolvedValueOnce('ast_late_audio');
    const scene = {
      id: 'scene-1',
      stageId: 'stage-1',
      type: 'slide',
      title: 'Scene',
      order: 1,
      content: { type: 'slide', canvas: { id: 'slide-1', elements: [] } },
      actions: [
        { id: 'speech-1', type: 'speech', text: 'Aborted line' },
        { id: 'speech-2', type: 'speech', text: 'Late line' },
      ],
    } as unknown as Parameters<typeof generateTTSForScene>[0];

    const generating = generateTTSForScene(scene, 'English', undefined, retryOptions);
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
    expect(mocks.poolRemove).not.toHaveBeenCalled();

    releaseSibling();
    await expect(generating).rejects.toBe(abort);

    expect(mocks.poolRemove).not.toHaveBeenCalled();
    expect(mocks.audioDelete).toHaveBeenCalledExactlyOnceWith('tts_s1_speech-2');
    expect(scene.actions?.every((action) => !('audioId' in action))).toBe(true);
  });

  it('replaces allocated audio under the stable id and refreshes its compatibility row', async () => {
    const { generateAndStoreTTS } = await import('@/lib/hooks/use-scene-generator');
    mockFetch.mockResolvedValue(
      jsonResponse(200, {
        success: true,
        base64: btoa('replacement-audio'),
        format: 'wav',
      }),
    );

    await expect(
      generateAndStoreTTS(
        'request-1',
        'Updated class',
        'English',
        undefined,
        undefined,
        'ast_stable_audio',
      ),
    ).resolves.toBe('ast_stable_audio');

    expect(mocks.poolPut).not.toHaveBeenCalled();
    expect(mocks.poolReplace).not.toHaveBeenCalled();
    expect(mocks.audioPut).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: 'ast_stable_audio', format: 'wav' }),
    );
  });
});
