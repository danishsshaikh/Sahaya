import { readFileSync } from 'fs';
import { join } from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFeatureFlagBoolean } from '@/lib/config/feature-flags';
import { VOICE_ENROLLMENT_PARAGRAPH, getVoiceEnrollmentPhrases, getVoicePreviewText } from '@/lib/voice-cloning/phrases';
import {
  MAX_RECORDING_DURATION_SECONDS,
  MIN_RECORDING_DURATION_SECONDS,
  VOICE_ENROLLMENT_TARGET_SECONDS,
} from '@/lib/voice-cloning/limits';
import {
  DEFAULT_CHATTERBOX_MODEL_VARIANT,
  LEGACY_CHATTERBOX_MODEL_VARIANT,
  RECOMMENDED_VOICE_GENERATION_SETTINGS,
  VOICE_SETTINGS_PRESETS,
  resolveVoiceProfileGenerationSettings,
  resolveVoiceProfileModelVariant,
  toPublicVoiceProfile,
  validateVoiceGenerationSettings,
  voiceGenerationPresetForSettings,
  VoiceProviderProfileNotFoundError,
  type VoiceProfile,
} from '@/lib/voice-cloning/types';
import {
  clippingMetricsFromPcmFloat32,
  decideVoiceRecordingQuality,
  evaluateVoiceRecordingQuality,
  parseTotalSilenceSeconds,
  qualityMetricsFromFfmpegReports,
  VoiceRecordingQualityError,
} from '@/lib/voice-cloning/audio-validation';

const repoRoot = process.cwd();

describe('voice cloning feature flag', () => {
  it('defaults false for unset or non-truthy values', () => {
    expect(readFeatureFlagBoolean(undefined)).toBe(false);
    expect(readFeatureFlagBoolean('')).toBe(false);
    expect(readFeatureFlagBoolean('false')).toBe(false);
  });

  it('accepts canonical truthy values', () => {
    expect(readFeatureFlagBoolean('true')).toBe(true);
    expect(readFeatureFlagBoolean('1')).toBe(true);
    expect(readFeatureFlagBoolean('yes')).toBe(true);
    expect(readFeatureFlagBoolean('on')).toBe(true);
  });
});

describe('voice profile privacy', () => {
  it('returns an opaque public profile without private paths', () => {
    const profile: VoiceProfile = {
      id: 'vcp_test',
      ownerId: 'local-faculty',
      displayName: 'My Teaching Voice',
      provider: 'chatterbox',
      language: 'en',
      status: 'ready',
      modelVariant: 'v3',
      languageId: 'hi',
      generationSettings: VOICE_SETTINGS_PRESETS['accent-test'],
      createdAt: '2026-08-11T00:00:00.000Z',
      updatedAt: '2026-08-11T00:00:00.000Z',
      consentTimestamp: '2026-08-11T00:00:00.000Z',
      consentVersion: 'faculty-self-voice-v1',
      referenceAudioKey: '/private/reference.wav',
      providerReferenceId: 'internal-provider-id',
      profileVersion: 1,
    };

    expect(toPublicVoiceProfile(profile)).toEqual({
      id: 'vcp_test',
      displayName: 'My Teaching Voice',
      provider: 'chatterbox',
      language: 'en',
      status: 'ready',
      modelVariant: 'v3',
      languageId: 'hi',
      generationSettings: VOICE_SETTINGS_PRESETS['accent-test'],
      createdAt: '2026-08-11T00:00:00.000Z',
      updatedAt: '2026-08-11T00:00:00.000Z',
      consentTimestamp: '2026-08-11T00:00:00.000Z',
      consentVersion: 'faculty-self-voice-v1',
      profileVersion: 1,
    });
  });

  it('exposes legacy V2 semantics for pre-version profiles without private paths', () => {
    const profile = toPublicVoiceProfile({
      id: 'vcp_legacy',
      ownerId: 'local-faculty',
      displayName: 'Legacy',
      provider: 'chatterbox',
      language: 'en',
      status: 'ready',
      createdAt: '2026-08-11T00:00:00.000Z',
      updatedAt: '2026-08-11T00:00:00.000Z',
      consentTimestamp: '2026-08-11T00:00:00.000Z',
      consentVersion: 'faculty-self-voice-v1',
      referenceAudioKey: '/private/reference.wav',
      providerReferenceId: 'ref-legacy',
      profileVersion: 1,
    });

    expect(profile).toMatchObject({
      id: 'vcp_legacy',
      modelVariant: LEGACY_CHATTERBOX_MODEL_VARIANT,
    });
    expect(profile).not.toHaveProperty('referenceAudioKey');
    expect(profile).not.toHaveProperty('providerReferenceId');
  });

  it('hides deleted profiles', () => {
    expect(
      toPublicVoiceProfile({
        id: 'vcp_deleted',
        ownerId: 'local-faculty',
        displayName: 'Deleted',
        provider: 'chatterbox',
        language: 'en',
        status: 'deleted',
        createdAt: '2026-08-11T00:00:00.000Z',
        updatedAt: '2026-08-11T00:00:00.000Z',
        consentTimestamp: '2026-08-11T00:00:00.000Z',
        consentVersion: 'faculty-self-voice-v1',
        profileVersion: 1,
      }),
    ).toBeNull();
  });
});

describe('explicit cloned voice TTS routing', () => {
  const synthesizeFacultyVoice = vi.fn();
  const generateTTS = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    synthesizeFacultyVoice.mockReset();
    generateTTS.mockReset();
    vi.doMock('@/lib/voice-cloning/synthesis', () => ({ synthesizeFacultyVoice }));
    vi.doMock('@/lib/audio/tts-providers', () => ({
      generateTTS,
      QwenTTSError: class QwenTTSError extends Error {},
      TTSRateLimitError: class TTSRateLimitError extends Error {},
      TTSInvalidResponseError: class TTSInvalidResponseError extends Error {},
    }));
    vi.doMock('@/lib/server/usage-storage', () => ({ recordGenerationUsage: vi.fn() }));
    vi.doMock('@/lib/server/provider-config', () => ({
      isServerConfiguredProvider: vi.fn(() => false),
      isServerTTSProviderDisabled: vi.fn(() => false),
      resolveTTSApiKey: vi.fn(() => undefined),
      resolveTTSBaseUrl: vi.fn(() => undefined),
      resolveTTSModel: vi.fn((_providerId, modelId) => modelId),
      TTSModelNotAllowedError: class TTSModelNotAllowedError extends Error {},
    }));
    vi.doMock('@/lib/server/ssrf-guard', () => ({ validateUrlForSSRF: vi.fn(() => null) }));
    vi.doMock('@/lib/auth/server', () => ({
      requireSessionUser: vi.fn(async () => ({
        id: 'usr_faculty_a',
        role: 'faculty',
        status: 'active',
      })),
    }));
  });

  function request(body: Record<string, unknown>) {
    return new Request('http://localhost/api/generate/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: 'Hello class',
        audioId: 'audio-1',
        ttsProviderId: 'browser-native-tts',
        ttsVoice: 'default',
        ...body,
      }),
    });
  }

  it('routes explicit faculty voice requests to the clone provider before default TTS guards', async () => {
    synthesizeFacultyVoice.mockResolvedValue({
      audio: new Uint8Array([1, 2, 3]),
      format: 'wav',
    });
    const { POST } = await import('@/app/api/generate/tts/route');

    const response = await POST(
      request({ teacherVoiceProfileId: 'vcp_ready', language: 'en' }) as never,
    );
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toMatchObject({ success: true, audioId: 'audio-1', format: 'wav' });
    expect(synthesizeFacultyVoice).toHaveBeenCalledWith({
      profileId: 'vcp_ready',
      ownerId: 'usr_faculty_a',
      text: 'Hello class',
      language: 'en',
    });
    expect(generateTTS).not.toHaveBeenCalled();
  });

  it('does not silently fall back when explicit faculty voice synthesis fails', async () => {
    synthesizeFacultyVoice.mockRejectedValue(new Error('voice service unavailable'));
    const { POST } = await import('@/app/api/generate/tts/route');

    const response = await POST(request({ teacherVoiceProfileId: 'vcp_ready' }) as never);
    const data = await response.json();

    expect(response.status).toBe(500);
    expect(data).toMatchObject({
      success: false,
      errorCode: 'GENERATION_FAILED',
    });
    expect(generateTTS).not.toHaveBeenCalled();
  });
});

describe('faculty voice synthesis language resolution', () => {
  const synthesize = vi.fn();
  const createProfile = vi.fn();
  const masterGeneratedVoiceAudio = vi.fn();
  const referenceAudioExists = vi.fn();
  const writeVoiceProfile = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    synthesize.mockReset();
    createProfile.mockReset();
    masterGeneratedVoiceAudio.mockReset();
    referenceAudioExists.mockReset();
    writeVoiceProfile.mockReset();
    referenceAudioExists.mockResolvedValue(true);
    writeVoiceProfile.mockResolvedValue(undefined);
    masterGeneratedVoiceAudio.mockImplementation(async (audio, _format) => ({
      audio: new Uint8Array([...audio, 8]),
      format: 'wav',
    }));
    vi.doUnmock('@/lib/voice-cloning/synthesis');
    vi.doMock('@/lib/voice-cloning/config', () => ({
      isVoiceCloningServerEnabled: () => true,
      getVoiceCloningProviderId: () => 'chatterbox',
    }));
    vi.doMock('@/lib/voice-cloning/storage', () => ({
      readVoiceProfile: vi.fn(async () => ({
        id: 'vcp_ready',
        ownerId: 'local-faculty',
        displayName: 'Faculty Voice',
        provider: 'chatterbox',
        language: 'hi',
        status: 'ready',
        modelVariant: 'v3',
        languageId: 'hi',
        generationSettings: VOICE_SETTINGS_PRESETS['accent-test'],
        createdAt: '2026-08-11T00:00:00.000Z',
        updatedAt: '2026-08-11T00:00:00.000Z',
        consentTimestamp: '2026-08-11T00:00:00.000Z',
        consentVersion: 'faculty-self-voice-v1',
        referenceAudioKey: '/private/reference.wav',
        providerReferenceId: 'ref-1',
        profileVersion: 1,
      })),
      referenceAudioExists,
      writeVoiceProfile,
      resolveReferenceAudioPath: (key: string) => key,
    }));
    vi.doMock('@/lib/voice-cloning/audio-validation', async () => {
      const actual = await vi.importActual<typeof import('@/lib/voice-cloning/audio-validation')>(
        '@/lib/voice-cloning/audio-validation',
      );
      return {
        ...actual,
        masterGeneratedVoiceAudio,
      };
    });
    vi.doMock('@/lib/voice-cloning/provider', () => ({
      getVoiceCloningProvider: () => ({
        createProfile,
        synthesize,
      }),
    }));
  });

  it('rejects ambiguous narration language before contacting the provider', async () => {
    synthesize.mockResolvedValue({ audio: new Uint8Array([1]), format: 'wav' });
    const { synthesizeFacultyVoice } = await import('@/lib/voice-cloning/synthesis');

    await expect(synthesizeFacultyVoice({
      profileId: 'vcp_ready',
      ownerId: 'local-faculty',
      text: 'Hello class',
      language: 'Use clear beginner-friendly wording throughout.',
    })).rejects.toThrow('unambiguous narration language');
    expect(synthesize).not.toHaveBeenCalled();
  });

  it('re-registers a persisted profile after provider restart and retries synthesis once', async () => {
    synthesize
      .mockRejectedValueOnce(new VoiceProviderProfileNotFoundError('voice profile not found'))
      .mockResolvedValueOnce({ audio: new Uint8Array([1]), format: 'wav' });
    createProfile.mockResolvedValue({ providerReferenceId: 'ref-1' });
    const { synthesizeFacultyVoice } = await import('@/lib/voice-cloning/synthesis');

    const result = await synthesizeFacultyVoice({
      profileId: 'vcp_ready',
      ownerId: 'local-faculty',
      text: 'Hello class',
      language: 'hi-IN',
    });

    expect(result).toEqual({ audio: new Uint8Array([1, 8]), format: 'wav' });
    expect(referenceAudioExists).toHaveBeenCalledWith('/private/reference.wav');
    expect(createProfile).toHaveBeenCalledTimes(1);
    expect(createProfile).toHaveBeenCalledWith({
      profileId: 'vcp_ready',
      referenceAudioKey: '/private/reference.wav',
      language: 'hi',
      modelVariant: 'v3',
      generationSettings: VOICE_SETTINGS_PRESETS['accent-test'],
    });
    expect(synthesize).toHaveBeenCalledTimes(2);
    expect(masterGeneratedVoiceAudio).toHaveBeenCalledTimes(1);
    expect(synthesize).toHaveBeenNthCalledWith(1, {
      providerReferenceId: 'ref-1',
      text: 'Hello class',
      language: 'hi',
      modelVariant: 'v3',
      generationSettings: VOICE_SETTINGS_PRESETS['accent-test'],
    });
    expect(synthesize).toHaveBeenNthCalledWith(2, {
      providerReferenceId: 'ref-1',
      text: 'Hello class',
      language: 'hi',
      modelVariant: 'v3',
      generationSettings: VOICE_SETTINGS_PRESETS['accent-test'],
    });
  });

  it('does not re-register when the persisted private reference audio is missing', async () => {
    referenceAudioExists.mockResolvedValue(false);
    const { synthesizeFacultyVoice } = await import('@/lib/voice-cloning/synthesis');

    await expect(
      synthesizeFacultyVoice({
        profileId: 'vcp_ready',
        ownerId: 'local-faculty',
        text: 'Hello class',
        language: 'en',
      }),
    ).rejects.toThrow('Voice profile reference audio not found');

    expect(createProfile).not.toHaveBeenCalled();
    expect(synthesize).not.toHaveBeenCalled();
  });
});

describe('faculty voice model variants', () => {
  it('defaults new profiles to V3 and legacy persisted profiles to V2', () => {
    expect(DEFAULT_CHATTERBOX_MODEL_VARIANT).toBe('v3');
    expect(resolveVoiceProfileModelVariant({ modelVariant: undefined })).toBe('v2');
    expect(resolveVoiceProfileModelVariant({ modelVariant: 'v2' })).toBe('v2');
    expect(resolveVoiceProfileModelVariant({ modelVariant: 'v3' })).toBe('v3');
  });
});

describe('faculty voice generation settings', () => {
  it('validates settings and fills missing values from recommended defaults', () => {
    expect(validateVoiceGenerationSettings({ cfgWeight: 0 })).toEqual({
      ...RECOMMENDED_VOICE_GENERATION_SETTINGS,
      cfgWeight: 0,
    });
    expect(resolveVoiceProfileGenerationSettings({ generationSettings: null })).toEqual(
      RECOMMENDED_VOICE_GENERATION_SETTINGS,
    );
    expect(() => validateVoiceGenerationSettings({ cfgWeight: 2 })).toThrow(
      'Invalid voice generation setting: cfgWeight',
    );
    expect(() => validateVoiceGenerationSettings({ unexpected: 1 })).toThrow(
      'Unknown voice generation setting: unexpected',
    );
  });

  it('recognizes safe presets and treats manual changes as custom', () => {
    expect(voiceGenerationPresetForSettings(RECOMMENDED_VOICE_GENERATION_SETTINGS)).toBe('natural');
    expect(voiceGenerationPresetForSettings(VOICE_SETTINGS_PRESETS['accent-test'])).toBe(
      'accent-test',
    );
    expect(
      voiceGenerationPresetForSettings({
        ...RECOMMENDED_VOICE_GENERATION_SETTINGS,
        temperature: 1,
      }),
    ).toBe('custom');
  });
});

describe('one-paragraph voice enrollment contract', () => {
  it('uses a single natural enrollment paragraph with duration as guidance only', () => {
    expect(VOICE_ENROLLMENT_PARAGRAPH).toContain('Today we will take a simple idea');
    expect(VOICE_ENROLLMENT_PARAGRAPH.length).toBeGreaterThan(120);
    expect(VOICE_ENROLLMENT_PARAGRAPH.length).toBeLessThan(260);
    expect(VOICE_ENROLLMENT_TARGET_SECONDS).toBe(15);
    expect(MIN_RECORDING_DURATION_SECONDS).toBeLessThanOrEqual(1);
    expect(MAX_RECORDING_DURATION_SECONDS).toBeGreaterThanOrEqual(180);
  });
});

describe('faculty voice setup UI contract', () => {
  const componentSource = () =>
    readFileSync(join(repoRoot, 'components/voice-cloning/teaching-voice-card.tsx'), 'utf8');

  it('keeps customization behind an explicit control and prevents duplicate enrollments', () => {
    const source = componentSource();

    expect(source).toContain("type SetupStep = 'record' | 'preview' | 'review'");
    expect(source).toContain("checking: 'Checking your recording...'");
    expect(source).toContain("preparing: 'Preparing voice sample...'");
    expect(source).toContain("generating: 'Generating your voice preview...'");
    expect(source).toContain("finishing: 'Finishing audio...'");
    expect(source).toContain('const [customizeOpen, setCustomizeOpen] = useState(false)');
    expect(source).toContain("value: Exclude<VoiceSettingsPreset, 'custom'>");
    expect(source).toContain("{ value: 'natural', label: 'Natural' }");
    expect(source).toContain("{ value: 'expressive', label: 'Expressive' }");
    expect(source).toContain("{ value: 'accent-test', label: 'Accent Test' }");
    expect(source).toContain('draftPresetDescription');
    expect(source).toContain('Manual settings are active.');
    expect(source).not.toContain("{ value: 'custom'");
    expect(source).toContain('Speak naturally and do not rush.');
    expect(source).not.toContain('Minimum');
    expect(source).not.toContain('MAX_RECORDING_DURATION_SECONDS');
    expect(source).not.toContain('MIN_RECORDING_DURATION_SECONDS');
    expect(source).toContain('enrollmentRequestInFlightRef.current');
    expect(source).toContain('setRecordingRequiresRetry(true)');
    expect(source).toContain('Customize Voice');
    expect(source).not.toContain('{renderVoiceConfigurationControls()}\n\n              <div');
  });

  it('keeps customization controls compact and teacher-facing', () => {
    const source = componentSource();

    expect(source).toContain('Balanced settings for clear, natural teaching narration.');
    expect(source).toContain('Adds more emphasis and energy to the delivery.');
    expect(source).toContain('Uses lower voice guidance to test whether the generated accent');
    expect(source).toContain("The reference recording fixes this voice's language.");
    expect(source).toContain('Voice Model');
    expect(source).toContain('Advanced Voice Settings');
    expect(source).toContain('Expert Settings');
    expect(source).toContain('sm:grid-cols-2');
    expect(source).not.toContain('Chatterbox receives');
    expect(source).not.toContain('grid gap-2 sm:grid-cols-4');
  });

  it('cleans candidate recording state during re-record without deleting accepted voice state', () => {
    const source = componentSource();

    expect(source).toContain('const candidateAudioRef = useRef<HTMLAudioElement | null>(null)');
    expect(source).toContain('candidateAudioRef.current.pause()');
    expect(source).toContain('candidateAudioRef.current.currentTime = 0');
    expect(source).toContain('URL.revokeObjectURL(prev.url)');
    expect(source).toContain('const clearCandidateRecording = () =>');
    expect(source).toContain('setRecordingRequiresRetry(false)');
    expect(source).toContain('setPreviewError(null)');
    expect(source).toContain('setEnrollmentError(null)');
    expect(source).toContain('const discardCandidateProfile = async (profileId: string)');
    expect(source).toContain('onClick={() => discardCandidateProfile(profile.id)}');
    expect(source).toContain("method: 'DELETE'");
    expect(source).not.toContain('Discard');
  });
});

describe('faculty voice recording quality analysis', () => {
  const validMetrics = {
    durationSeconds: 15,
    meanVolumeDb: -24,
    maxVolumeDb: -4,
    silenceSeconds: 1.5,
    silenceRatio: 0.1,
    clippedSampleRatio: 0,
    maxConsecutiveClippingMs: 0,
    clippedSampleCount: 0,
    totalSampleCount: 360000,
  };

  it('parses deterministic FFmpeg quality reports', () => {
    expect(
      qualityMetricsFromFfmpegReports({
        durationSeconds: 15,
        volumeReport: '[Parsed_volumedetect_0] mean_volume: -23.5 dB\nmax_volume: -3.1 dB',
        silenceReport:
          'silence_start: 0\nsilence_end: 0.7 | silence_duration: 0.7\nsilence_duration: 0.4',
        clipping: {
          clippedSampleRatio: 0.001,
          maxConsecutiveClippingMs: 2,
          clippedSampleCount: 360,
          totalSampleCount: 360000,
        },
      }),
    ).toMatchObject({
      durationSeconds: 15,
      meanVolumeDb: -23.5,
      maxVolumeDb: -3.1,
      silenceSeconds: 1.1,
      silenceRatio: expect.closeTo(0.073333, 6),
      clippedSampleRatio: 0.001,
      maxConsecutiveClippingMs: 2,
    });
    expect(parseTotalSilenceSeconds('silence_duration: 2\nsilence_duration: 1.25')).toBe(3.25);
  });

  it('accepts a valid teaching-voice signal', () => {
    expect(evaluateVoiceRecordingQuality(validMetrics)).toEqual({
      severity: 'pass',
      warnings: [],
    });
  });

  it('accepts ordinary natural paragraph recordings without a narrow duration window', () => {
    expect(evaluateVoiceRecordingQuality({ ...validMetrics, durationSeconds: 15 }).severity).toBe(
      'pass',
    );
    expect(evaluateVoiceRecordingQuality({ ...validMetrics, durationSeconds: 20 }).severity).toBe(
      'pass',
    );
    expect(evaluateVoiceRecordingQuality({ ...validMetrics, durationSeconds: 45 }).severity).toBe(
      'pass',
    );
  });

  it('warns for hot audio without rejecting isolated peaks', () => {
    expect(
      decideVoiceRecordingQuality({
        ...validMetrics,
        maxVolumeDb: -0.2,
        clippedSampleRatio: 0.00001,
        maxConsecutiveClippingMs: 0.2,
        clippedSampleCount: 4,
      }),
    ).toMatchObject({
      severity: 'warning',
      warnings: ['The recording is a little loud, but still usable.'],
    });
  });

  it('rejects sustained clipping using clipped sample ratio and consecutive clipping duration', () => {
    expect(() =>
      evaluateVoiceRecordingQuality({
        ...validMetrics,
        maxVolumeDb: -0.1,
        clippedSampleRatio: 0.02,
        maxConsecutiveClippingMs: 5,
        clippedSampleCount: 7200,
      }),
    ).toThrow('sustained distortion');
    expect(() =>
      evaluateVoiceRecordingQuality({
        ...validMetrics,
        clippedSampleRatio: 0.001,
        maxConsecutiveClippingMs: 30,
      }),
    ).toThrow('sustained distortion');
  });

  it('computes clipped sample ratio and longest clipped run from decoded PCM', () => {
    const pcm = Buffer.alloc(8 * 4);
    [0, 0.25, 0.999, 1, -1, 0, -0.999, 0.1].forEach((sample, index) => {
      pcm.writeFloatLE(sample, index * 4);
    });

    expect(clippingMetricsFromPcmFloat32(pcm, 1000)).toEqual({
      clippedSampleRatio: 0.5,
      maxConsecutiveClippingMs: 3,
      clippedSampleCount: 4,
      totalSampleCount: 8,
    });
  });

  it('rejects near-empty, quiet, silent, clipped, and invalid audio', () => {
    expect(() => evaluateVoiceRecordingQuality({ ...validMetrics, durationSeconds: 0.2 })).toThrow(
      VoiceRecordingQualityError,
    );
    expect(() => evaluateVoiceRecordingQuality({ ...validMetrics, meanVolumeDb: -54 })).toThrow(
      'The recording is too quiet',
    );
    expect(() =>
      evaluateVoiceRecordingQuality({ ...validMetrics, silenceSeconds: 7, silenceRatio: 0.7 }),
    ).toThrow('too much silence');
    expect(() =>
      qualityMetricsFromFfmpegReports({
        durationSeconds: 15,
        volumeReport: 'no volume here',
        silenceReport: '',
      }),
    ).toThrow('could not be analyzed');
  });
});

describe('voice profile model preview API', () => {
  const createProfile = vi.fn();
  const deleteProfile = vi.fn();
  const generatePreview = vi.fn();
  const writeVoiceProfile = vi.fn();
  const readVoiceProfile = vi.fn();
  const findCurrentVoiceProfile = vi.fn();
  const deleteVoiceProfileAssets = vi.fn();
  const writeReferenceAudio = vi.fn();
  const referenceAudioExists = vi.fn();
  const normalizeVoiceEnrollmentRecording = vi.fn();
  const masterGeneratedVoiceAudio = vi.fn();
  const createVoiceProfileId = vi.fn(() => 'vcp_new');

  beforeEach(() => {
    vi.resetModules();
    createProfile.mockReset();
    deleteProfile.mockReset();
    generatePreview.mockReset();
    writeVoiceProfile.mockReset();
    readVoiceProfile.mockReset();
    findCurrentVoiceProfile.mockReset();
    deleteVoiceProfileAssets.mockReset();
    writeReferenceAudio.mockReset();
    referenceAudioExists.mockReset();
    normalizeVoiceEnrollmentRecording.mockReset();
    masterGeneratedVoiceAudio.mockReset();
    createVoiceProfileId.mockClear();
    referenceAudioExists.mockResolvedValue(true);
    createProfile.mockImplementation(async ({ profileId }) => ({ providerReferenceId: profileId }));
    deleteProfile.mockResolvedValue(undefined);
    generatePreview.mockResolvedValue({ audio: new Uint8Array([1, 2]), format: 'wav' });
    writeVoiceProfile.mockResolvedValue(undefined);
    findCurrentVoiceProfile.mockResolvedValue(null);
    writeReferenceAudio.mockResolvedValue('/private/reference.wav');
    normalizeVoiceEnrollmentRecording.mockResolvedValue({
      referenceAudio: new Uint8Array([9, 9]),
      durationSeconds: 15,
      quality: {
        durationSeconds: 15,
        meanVolumeDb: -24,
        maxVolumeDb: -4,
        silenceSeconds: 1,
        silenceRatio: 0.067,
        clippedSampleRatio: 0,
        maxConsecutiveClippingMs: 0,
        clippedSampleCount: 0,
        totalSampleCount: 360000,
      },
      qualityDecision: { severity: 'pass', warnings: [] },
      format: 'wav',
    });
    masterGeneratedVoiceAudio.mockImplementation(async (audio, _format) => ({
      audio: new Uint8Array([...audio, 9]),
      format: 'wav',
    }));
    vi.doMock('@/lib/voice-cloning/config', () => ({
      getVoiceCloningDefaultLanguage: () => 'en',
      getChatterboxDefaultModelVariant: () => 'v3',
      isVoiceCloningServerEnabled: () => true,
    }));
    vi.doMock('@/lib/voice-cloning/audio-validation', () => ({
      isVoiceRecordingQualityError: (error: unknown) =>
        error instanceof VoiceRecordingQualityError ||
        (typeof error === 'object' &&
          error !== null &&
          (error as { name?: string }).name === 'VoiceRecordingQualityError'),
      masterGeneratedVoiceAudio,
      normalizeVoiceEnrollmentRecording,
    }));
    vi.doMock('@/lib/voice-cloning/storage', () => ({
      createVoiceProfileId,
      deleteVoiceProfileAssets,
      findCurrentVoiceProfile,
      readVoiceProfile,
      referenceAudioExists,
      writeReferenceAudio,
      writeVoiceProfile,
      resolveReferenceAudioPath: (key: string) => key,
    }));
    vi.doMock('@/lib/voice-cloning/provider', () => ({
      getVoiceCloningProvider: () => ({
        createProfile,
        generatePreview,
        deleteProfile,
      }),
    }));
    vi.doMock('@/lib/auth/server', () => ({
      markVoiceConfigured: vi.fn(),
      requireSessionUser: vi.fn(async () => ({
        id: 'local-faculty',
        role: 'faculty',
        status: 'active',
      })),
    }));
  });

  function readyProfile(modelVariant: 'v2' | 'v3' = 'v2'): VoiceProfile {
    return {
      id: 'vcp_ready',
      ownerId: 'local-faculty',
      displayName: 'Faculty Voice',
      provider: 'chatterbox',
      language: 'en',
      status: 'ready',
      modelVariant,
      languageId: 'en',
      generationSettings: RECOMMENDED_VOICE_GENERATION_SETTINGS,
      createdAt: '2026-08-11T00:00:00.000Z',
      updatedAt: '2026-08-11T00:00:00.000Z',
      consentTimestamp: '2026-08-11T00:00:00.000Z',
      consentVersion: 'faculty-self-voice-v1',
      referenceAudioKey: '/private/reference.wav',
      providerReferenceId: 'vcp_ready',
      profileVersion: 1,
      preview: { format: 'wav', base64: 'old', createdAt: '2026-08-11T00:00:00.000Z' },
    };
  }

  function enrollmentForm(): FormData {
    const data = new FormData();
    data.set('consent', 'true');
    data.set('languageId', 'en');
    data.set('phraseId', 'teaching-paragraph');
    data.set('referenceText', VOICE_ENROLLMENT_PARAGRAPH);
    return data;
  }

  it('creates new English profiles with Qwen and the exact approved transcript', async () => {
    const { POST } = await import('@/app/api/voice-cloning/profile/route');
    const formData = enrollmentForm();
    formData.set(
      'recording',
      new File([new Uint8Array([1, 2, 3, 4])], 'voice.webm', { type: 'audio/webm' }),
    );

    const response = await POST(
      new Request('http://localhost/api/voice-cloning/profile', {
        method: 'POST',
        body: formData,
      }) as never,
    );
    const data = await response.json();

    expect(response.status).toBe(201);
    expect(createVoiceProfileId).toHaveBeenCalledTimes(1);
    expect(normalizeVoiceEnrollmentRecording).toHaveBeenCalledTimes(1);
    expect(normalizeVoiceEnrollmentRecording).toHaveBeenCalledWith(
      expect.objectContaining({
        mimeType: 'audio/webm',
        fileName: 'voice.webm',
      }),
    );
    expect(data.profile.provider).toBe('qwen3');
    expect(data.profile.modelVariant).toBeUndefined();
    expect(data.profile.languageId).toBe('en');
    expect(data.profile.generationSettings).toBeUndefined();
    expect(data.profile.referenceText).toBeUndefined();
    expect(writeVoiceProfile).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'qwen3', referenceText: VOICE_ENROLLMENT_PARAGRAPH,
    }));
    expect(findCurrentVoiceProfile).toHaveBeenCalledWith('local-faculty', 'en', true);
    expect(data.profile.draftPreview.config).toEqual({
      languageId: 'en',
    });
    expect(data.profile.draftPreview.preview.base64).toBe(
      Buffer.from([1, 2, 9]).toString('base64'),
    );
    expect(createProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        language: 'en',
        referenceAudioKey: '/private/reference.wav',
        referenceText: VOICE_ENROLLMENT_PARAGRAPH,
      }),
    );
    expect(generatePreview).toHaveBeenCalledWith(
      expect.objectContaining({
        language: 'en',
      }),
    );
    expect(masterGeneratedVoiceAudio).toHaveBeenCalledWith(new Uint8Array([1, 2]), 'wav');
  });

  it('rejects an enrollment transcript that differs from the displayed approved phrase', async () => {
    const { POST } = await import('@/app/api/voice-cloning/profile/route');
    const formData = enrollmentForm();
    formData.set('referenceText', 'An unrelated recording transcript');

    const response = await POST(
      new Request('http://localhost/api/voice-cloning/profile', {
        method: 'POST',
        body: formData,
      }) as never,
    );
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data).toMatchObject({ success: false, errorCode: 'INVALID_REQUEST' });
    expect(createProfile).not.toHaveBeenCalled();
  });

  it.each(['hi', 'mr'])('enrolls %s with its approved transcript and Indic preview', async (language) => {
    const { POST } = await import('@/app/api/voice-cloning/profile/route');
    const form = enrollmentForm();
    const phrase = getVoiceEnrollmentPhrases(language)[0];
    form.set('languageId', language);
    form.set('phraseId', phrase.id);
    form.set('referenceText', phrase.text);
    form.set('recording', new File([new Uint8Array([1, 2])], 'voice.webm', { type: 'audio/webm' }));
    const response = await POST(new Request('http://localhost/api/voice-cloning/profile', {
      method: 'POST', body: form,
    }) as never);
    expect(response.status).toBe(201);
    expect(writeVoiceProfile).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'indicf5', languageId: language, referenceText: phrase.text,
    }));
    expect(findCurrentVoiceProfile).toHaveBeenCalledWith('local-faculty', language, true);
    expect(generatePreview).toHaveBeenCalledWith(expect.objectContaining({
      language, text: getVoicePreviewText(language, 'indicf5'),
    }));
  });

  it('rejects changing a recorded profile language through preview settings', async () => {
    readVoiceProfile.mockResolvedValue(readyProfile());
    const { PATCH } = await import('@/app/api/voice-cloning/profile/route');
    const response = await PATCH(new Request('http://localhost/api/voice-cloning/profile', {
      method: 'PATCH', body: JSON.stringify({
        profileId: 'vcp_ready', action: 'preview-model', languageId: 'hi',
      }),
    }) as never);
    expect(response.status).toBe(400);
    expect(generatePreview).not.toHaveBeenCalled();
    expect(writeVoiceProfile).not.toHaveBeenCalled();
  });

  it('rejects unsupported languages and mismatched phrase IDs clearly', async () => {
    const { POST } = await import('@/app/api/voice-cloning/profile/route');
    const unsupportedLanguage = new FormData();
    unsupportedLanguage.set('consent', 'true');
    unsupportedLanguage.set('languageId', 'xx');

    const languageResponse = await POST(
      new Request('http://localhost/api/voice-cloning/profile', {
        method: 'POST',
        body: unsupportedLanguage,
      }) as never,
    );
    expect(languageResponse.status).toBe(400);

    const malformedSettings = enrollmentForm();
    malformedSettings.set('phraseId', 'unknown-phrase');

    const settingsResponse = await POST(
      new Request('http://localhost/api/voice-cloning/profile', {
        method: 'POST',
        body: malformedSettings,
      }) as never,
    );
    expect(settingsResponse.status).toBe(400);
    expect(createProfile).not.toHaveBeenCalled();
  });

  it('rejects invalid one-paragraph recordings without creating a profile', async () => {
    normalizeVoiceEnrollmentRecording.mockRejectedValue(
      new VoiceRecordingQualityError(
        'too_quiet',
        'The recording is too quiet. Please try again a little closer to your microphone.',
      ),
    );
    const { POST } = await import('@/app/api/voice-cloning/profile/route');
    const formData = enrollmentForm();
    formData.set(
      'recording',
      new File([new Uint8Array([1, 2])], 'voice.webm', { type: 'audio/webm' }),
    );

    const response = await POST(
      new Request('http://localhost/api/voice-cloning/profile', {
        method: 'POST',
        body: formData,
      }) as never,
    );
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data).toMatchObject({
      success: false,
      error: 'The recording is too quiet. Please try again a little closer to your microphone.',
    });
    expect(writeVoiceProfile).not.toHaveBeenCalled();
    expect(createVoiceProfileId).not.toHaveBeenCalled();
    expect(createProfile).not.toHaveBeenCalled();
  });

  it('keeps the existing accepted profile until a replacement preview is accepted', async () => {
    const existingProfile = readyProfile('v3');
    findCurrentVoiceProfile.mockResolvedValue(existingProfile);
    const { POST } = await import('@/app/api/voice-cloning/profile/route');
    const formData = enrollmentForm();
    formData.set(
      'recording',
      new File([new Uint8Array([1, 2, 3, 4])], 'replacement.webm', { type: 'audio/webm' }),
    );

    const response = await POST(
      new Request('http://localhost/api/voice-cloning/profile', {
        method: 'POST',
        body: formData,
      }) as never,
    );
    const data = await response.json();

    expect(response.status).toBe(201);
    expect(data.profile.id).toBe('vcp_new');
    expect(writeVoiceProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'vcp_new',
        replacesProfileId: 'vcp_ready',
        status: 'processing',
      }),
    );
    expect(writeVoiceProfile).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: 'vcp_ready', status: 'deleted' }),
    );
    expect(deleteVoiceProfileAssets).not.toHaveBeenCalled();
    expect(deleteProfile).not.toHaveBeenCalled();
  });

  it('previews V2 and V3 from the same persisted reference without re-recording', async () => {
    readVoiceProfile.mockResolvedValue(readyProfile('v2'));
    const { PATCH } = await import('@/app/api/voice-cloning/profile/route');

    await PATCH(
      new Request('http://localhost/api/voice-cloning/profile', {
        method: 'PATCH',
        body: JSON.stringify({
          profileId: 'vcp_ready',
          action: 'preview-model',
          modelVariant: 'v2',
          languageId: 'en',
          generationSettings: RECOMMENDED_VOICE_GENERATION_SETTINGS,
        }),
      }) as never,
    );
    await PATCH(
      new Request('http://localhost/api/voice-cloning/profile', {
        method: 'PATCH',
        body: JSON.stringify({
          profileId: 'vcp_ready',
          action: 'preview-model',
          modelVariant: 'v3',
          languageId: 'en',
          generationSettings: VOICE_SETTINGS_PRESETS['accent-test'],
        }),
      }) as never,
    );

    expect(referenceAudioExists).toHaveBeenCalledWith('/private/reference.wav');
    expect(createProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        modelVariant: 'v2',
        language: 'en',
        referenceAudioKey: '/private/reference.wav',
        generationSettings: RECOMMENDED_VOICE_GENERATION_SETTINGS,
      }),
    );
    expect(createProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        modelVariant: 'v3',
        language: 'en',
        referenceAudioKey: '/private/reference.wav',
        generationSettings: VOICE_SETTINGS_PRESETS['accent-test'],
      }),
    );
    expect(writeVoiceProfile).toHaveBeenLastCalledWith(
      expect.objectContaining({
        modelVariant: 'v2',
        languageId: 'en',
        generationSettings: RECOMMENDED_VOICE_GENERATION_SETTINGS,
        draftPreview: expect.objectContaining({
          config: {
            modelVariant: 'v3',
            languageId: 'en',
            generationSettings: VOICE_SETTINGS_PRESETS['accent-test'],
          },
        }),
      }),
    );
  });

  it('persists accepted preview config while preserving the reference audio', async () => {
    readVoiceProfile
      .mockResolvedValueOnce({
        ...readyProfile('v2'),
        replacesProfileId: 'vcp_old',
        draftPreview: {
          config: {
            modelVariant: 'v3',
            languageId: 'en',
            generationSettings: VOICE_SETTINGS_PRESETS['accent-test'],
          },
          preview: { format: 'wav', base64: 'new', createdAt: '2026-08-12T00:00:00.000Z' },
        },
      })
      .mockResolvedValueOnce({
        ...readyProfile('v2'),
        id: 'vcp_old',
        providerReferenceId: 'ref-old',
      });
    const { PATCH } = await import('@/app/api/voice-cloning/profile/route');

    const response = await PATCH(
      new Request('http://localhost/api/voice-cloning/profile', {
        method: 'PATCH',
        body: JSON.stringify({
          profileId: 'vcp_ready',
          action: 'accept-preview',
          modelVariant: 'v3',
          languageId: 'en',
          generationSettings: VOICE_SETTINGS_PRESETS['accent-test'],
        }),
      }) as never,
    );
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.profile.modelVariant).toBe('v3');
    expect(data.profile.languageId).toBe('en');
    expect(data.profile.generationSettings).toEqual(VOICE_SETTINGS_PRESETS['accent-test']);
    expect(writeVoiceProfile).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: 'vcp_old',
        status: 'deleted',
        referenceAudioKey: undefined,
      }),
    );
    expect(deleteVoiceProfileAssets).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'vcp_old' }),
    );
    expect(deleteProfile).toHaveBeenCalledWith({ providerReferenceId: 'ref-old' });
    expect(writeVoiceProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        modelVariant: 'v3',
        language: 'en',
        languageId: 'en',
        generationSettings: VOICE_SETTINGS_PRESETS['accent-test'],
        referenceAudioKey: '/private/reference.wav',
        preview: { format: 'wav', base64: 'new', createdAt: '2026-08-12T00:00:00.000Z' },
        draftPreview: undefined,
      }),
    );
  });
});

describe('Chatterbox provider model routing', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock('@/lib/voice-cloning/config');
    vi.stubEnv('VOICE_CLONING_BASE_URL', 'http://voice.local');
    vi.stubEnv('VOICE_CLONING_TIMEOUT_MS', '1000');
  });

  it('sends explicit V2 and V3 model variants to the service', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      if (String(input).endsWith('/synthesize')) {
        return new Response(new Uint8Array([1]), {
          status: 200,
          headers: { 'content-type': 'audio/wav' },
        });
      }
      return new Response(JSON.stringify({ providerReferenceId: 'vcp_ready' }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const { ChatterboxVoiceCloningProvider } =
      await import('@/lib/voice-cloning/providers/chatterbox');
    const provider = new ChatterboxVoiceCloningProvider();

    await provider.createProfile({
      profileId: 'vcp_ready',
      referenceAudioKey: '/private/reference.wav',
      language: 'en',
      modelVariant: 'v2',
      generationSettings: RECOMMENDED_VOICE_GENERATION_SETTINGS,
    });
    await provider.synthesize({
      providerReferenceId: 'vcp_ready',
      text: 'Hello class',
      language: 'hi',
      modelVariant: 'v3',
      generationSettings: VOICE_SETTINGS_PRESETS['accent-test'],
    });

    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({
      modelVariant: 'v2',
    });
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toMatchObject({
      modelVariant: 'v3',
      language: 'hi',
      generationSettings: VOICE_SETTINGS_PRESETS['accent-test'],
    });
  });
});
