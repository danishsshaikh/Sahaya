'use client';

import { useEffect, useRef, useState } from 'react';
import {
  Check,
  CircleAlert,
  Loader2,
  Mic,
  Play,
  RotateCcw,
  SlidersHorizontal,
  Trash2,
  Volume2,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  CHATTERBOX_LANGUAGE_LABELS,
  CHATTERBOX_SUPPORTED_LANGUAGE_IDS,
} from '@/lib/audio/tts-language';
import { getVoiceEnrollmentPhrases } from '@/lib/voice-cloning/phrases';
import {
  isChatterboxFacultySynthesisLanguage,
  resolveTeachingVoiceLanguage,
} from '@/lib/voice-cloning/language';
import {
  MIN_RECORDING_SIZE_BYTES,
  VOICE_ENROLLMENT_TARGET_SECONDS,
} from '@/lib/voice-cloning/limits';
import {
  DEFAULT_CHATTERBOX_MODEL_VARIANT,
  RECOMMENDED_VOICE_GENERATION_SETTINGS,
  VOICE_SETTINGS_PRESETS,
  voiceGenerationPresetForSettings,
  resolveVoiceProfileProvider,
  type ChatterboxModelVariant,
  type PublicVoiceProfile,
  type Qwen3TtsCloneMode,
  type VoiceConfiguration,
  type VoiceEnhancementMode,
  type VoiceGenerationSettings,
  type VoiceModelPreviewResult,
  type VoicePreviewModel,
  type VoicePreviewTextLanguage,
  type VoiceSettingsPreset,
} from '@/lib/voice-cloning/types';
import { readVoiceApiResponse, voiceFetchError } from '@/lib/voice-cloning/api-client';
import {
  activateTeachingVoiceSelection,
  clearTeachingVoiceSelection,
  disableTeachingVoiceSelection,
  isTeachingVoiceExplicitlyDisabled,
  readTeachingVoiceSelection,
} from '@/lib/voice-cloning/selection-client';

interface TeachingVoiceCardProps {
  selectedProfileId?: string;
  onSelectedProfileIdChange: (profileId: string | undefined) => void;
}

type ClipState = {
  blob?: Blob;
  url?: string;
  duration?: number;
  error?: string;
};

type ApiProfileResponse = {
  success?: boolean;
  profile?: PublicVoiceProfile | null;
  error?: string;
  details?: string;
  previewModels?: VoicePreviewModel[];
  modelPreview?: VoiceModelPreviewResult;
};

type VoiceEnrollmentResponse = ApiProfileResponse & {
  attemptId?: string;
  status?: 'queued' | 'running' | 'completed' | 'failed';
  phase?:
    | 'queued'
    | 'quality_check'
    | 'preprocessing'
    | 'provider_registration'
    | 'finalizing'
    | 'completed'
    | 'failed';
  pollIntervalMs?: number;
};

type SetupStep = 'record' | 'preview' | 'review';
type BusyPhase = 'checking' | 'preparing' | 'generating' | 'finishing';

const BUSY_LABELS: Record<BusyPhase, string> = {
  checking: 'Checking your recording...',
  preparing: 'Preparing voice sample...',
  generating: 'Generating your voice preview...',
  finishing: 'Finishing audio...',
};

const ENROLLMENT_ATTEMPT_STORAGE_PREFIX = 'sahaya.teachingVoice.enrollmentAttempt';

function enrollmentStorageKey(language: string): string {
  return `${ENROLLMENT_ATTEMPT_STORAGE_PREFIX}.${language}`;
}

function createEnrollmentAttemptId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `voice_${Date.now()}_${Math.random().toString(36).slice(2)}`
  );
}

function busyPhaseForEnrollmentPhase(phase?: VoiceEnrollmentResponse['phase']): BusyPhase {
  if (phase === 'quality_check') return 'checking';
  if (phase === 'preprocessing') return 'preparing';
  if (phase === 'finalizing' || phase === 'completed') return 'finishing';
  return 'generating';
}

const PRESET_OPTIONS: Array<{
  value: Exclude<VoiceSettingsPreset, 'custom'>;
  label: string;
}> = [
  { value: 'natural', label: 'Natural' },
  { value: 'expressive', label: 'Expressive' },
];

const PRESET_DESCRIPTIONS: Record<Exclude<VoiceSettingsPreset, 'custom'>, string> = {
  natural: 'Clear, balanced classroom narration.',
  expressive: 'More emphasis for stories and key ideas.',
  'accent-test': 'Legacy saved style.',
};

function cloneRecommendedSettings(): VoiceGenerationSettings {
  return { ...RECOMMENDED_VOICE_GENERATION_SETTINGS };
}

function normalizeProfileLanguageId(profile: PublicVoiceProfile | null): string {
  return resolveTeachingVoiceLanguage(profile?.languageId || profile?.language) || 'en';
}

function profileSelectionLanguage(profile: PublicVoiceProfile | null): string {
  return resolveTeachingVoiceLanguage(profile?.language) || normalizeProfileLanguageId(profile);
}

function profileConfiguration(profile: PublicVoiceProfile): VoiceConfiguration {
  return {
    languageId: normalizeProfileLanguageId(profile),
    ...(resolveVoiceProfileProvider(profile) === 'chatterbox'
      ? {
          modelVariant: profile.modelVariant,
          generationSettings: profile.generationSettings ?? cloneRecommendedSettings(),
          enhancementMode: profile.enhancementMode ?? 'standard',
        }
      : {}),
  };
}

function voiceConfigurationsEqual(left: VoiceConfiguration, right: VoiceConfiguration): boolean {
  if (
    left.modelVariant !== right.modelVariant ||
    left.languageId !== right.languageId ||
    (left.enhancementMode ?? 'standard') !== (right.enhancementMode ?? 'standard')
  )
    return false;
  const a = left.generationSettings;
  const b = right.generationSettings;
  if (!a || !b) return a === b;
  return Object.keys(RECOMMENDED_VOICE_GENERATION_SETTINGS).every((key) => {
    const typedKey = key as keyof VoiceGenerationSettings;
    return Math.abs(a[typedKey] - b[typedKey]) < 0.000001;
  });
}

function voiceSynthesisConfigurationsEqual(
  left: VoiceConfiguration,
  right: VoiceConfiguration,
): boolean {
  return voiceConfigurationsEqual(
    { ...left, enhancementMode: 'standard' },
    { ...right, enhancementMode: 'standard' },
  );
}

function chooseMimeType(): string {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || '';
}

function formatSeconds(value: number | undefined): string {
  if (!value) return '';
  return `${value.toFixed(1)}s`;
}

function formatClock(value: number): string {
  const seconds = Math.max(0, Math.floor(value));
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

export function TeachingVoiceCard({
  selectedProfileId,
  onSelectedProfileIdChange,
}: TeachingVoiceCardProps) {
  const [enrollmentLanguage, setEnrollmentLanguage] = useState('en');
  const enrollmentPhrase = getVoiceEnrollmentPhrases(enrollmentLanguage)[0];
  const enrollmentParagraph = enrollmentPhrase?.text;
  const [profile, setProfile] = useState<PublicVoiceProfile | null>(null);
  const [profileLoading, setProfileLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [consented, setConsented] = useState(false);
  const [recording, setRecording] = useState<ClipState>({});
  const [recordingStartedAt, setRecordingStartedAt] = useState<number | null>(null);
  const [recordingPending, setRecordingPending] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [draftModelVariant, setDraftModelVariant] = useState<ChatterboxModelVariant>(
    DEFAULT_CHATTERBOX_MODEL_VARIANT,
  );
  const [draftLanguageId, setDraftLanguageId] = useState('en');
  const [previewTextLanguageId, setPreviewTextLanguageId] =
    useState<VoicePreviewTextLanguage>('en');
  const [draftGenerationSettings, setDraftGenerationSettings] =
    useState<VoiceGenerationSettings>(cloneRecommendedSettings);
  const [draftEnhancementMode, setDraftEnhancementMode] =
    useState<VoiceEnhancementMode>('standard');
  const [availablePreviewModels, setAvailablePreviewModels] = useState<VoicePreviewModel[]>([
    'chatterbox-v3',
  ]);
  const [draftPreviewModel, setDraftPreviewModel] = useState<VoicePreviewModel>('chatterbox-v3');
  const [qwenCloneMode, setQwenCloneMode] = useState<Qwen3TtsCloneMode>('speaker-embedding');
  const [qwenEnhancementMode, setQwenEnhancementMode] = useState<VoiceEnhancementMode>('standard');
  const [qwenModelPreviews, setQwenModelPreviews] = useState<
    Partial<Record<Qwen3TtsCloneMode, VoiceModelPreviewResult>>
  >({});
  const [busy, setBusy] = useState(false);
  const [busyPhase, setBusyPhase] = useState<BusyPhase | null>(null);
  const [busyStartedAt, setBusyStartedAt] = useState<number | null>(null);
  const [busyElapsedSeconds, setBusyElapsedSeconds] = useState(0);
  const [setupStep, setSetupStep] = useState<SetupStep>('record');
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const [enrollmentError, setEnrollmentError] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [enrollmentAttemptId, setEnrollmentAttemptId] = useState<string | null>(null);
  const [recordingRequiresRetry, setRecordingRequiresRetry] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const candidateAudioRef = useRef<HTMLAudioElement | null>(null);
  const enrollmentRequestInFlightRef = useRef(false);
  const previewRequestInFlightRef = useRef(false);
  const enrollmentPollTokenRef = useRef(0);
  const busyTimersRef = useRef<number[]>([]);
  const selectedProfileIdRef = useRef(selectedProfileId);
  const onSelectedProfileIdChangeRef = useRef(onSelectedProfileIdChange);
  const recordingUrlRef = useRef<string | undefined>(undefined);

  const readyProfile = profile?.status === 'ready' ? profile : null;
  const readyProfileDisabled = readyProfile
    ? isTeachingVoiceExplicitlyDisabled(
        readTeachingVoiceSelection(profileSelectionLanguage(readyProfile)),
        readyProfile.id,
      )
    : false;
  const isChatterboxProfile = !!profile && resolveVoiceProfileProvider(profile) === 'chatterbox';
  const isQwenPreview = draftPreviewModel === 'qwen3-tts-1.7b-base';
  const selectedEnhancementMode = isQwenPreview ? qwenEnhancementMode : draftEnhancementMode;
  const qwenModelPreview = qwenModelPreviews[qwenCloneMode];
  const draftConfiguration: VoiceConfiguration = {
    languageId: draftLanguageId,
    ...(isChatterboxProfile
      ? {
          modelVariant: draftModelVariant,
          generationSettings: draftGenerationSettings,
          enhancementMode: draftEnhancementMode,
        }
      : {}),
  };
  const draftPreset = voiceGenerationPresetForSettings(draftGenerationSettings);
  const draftPresetDescription =
    draftPreset === 'custom'
      ? 'Manual settings are active. Choose a style above to return to a preset.'
      : PRESET_DESCRIPTIONS[draftPreset];
  const acceptedConfiguration = readyProfile ? profileConfiguration(readyProfile) : null;
  const draftMatchesAccepted =
    acceptedConfiguration && voiceConfigurationsEqual(draftConfiguration, acceptedConfiguration);
  const matchingDraftPreview =
    profile?.draftPreview &&
    voiceSynthesisConfigurationsEqual(profile.draftPreview.config, draftConfiguration) &&
    (profile.draftPreview.config.previewTextLanguageId ?? 'en') === previewTextLanguageId
      ? profile.draftPreview
      : undefined;
  const acceptedPreviewMatches = Boolean(
    acceptedConfiguration &&
    voiceSynthesisConfigurationsEqual(draftConfiguration, acceptedConfiguration) &&
    (readyProfile?.previewTextLanguageId ?? 'en') === previewTextLanguageId,
  );
  const selectedComparison = isQwenPreview
    ? qwenModelPreview?.comparison
    : (matchingDraftPreview?.comparison ??
      (acceptedPreviewMatches ? readyProfile?.previewComparison : undefined));
  const selectedPreview = isQwenPreview
    ? selectedComparison
      ? selectedEnhancementMode === 'resemble-enhance' && selectedComparison.enhanced
        ? selectedComparison.enhanced
        : selectedComparison.original
      : undefined
    : selectedComparison
      ? selectedEnhancementMode === 'resemble-enhance' && selectedComparison.enhanced
        ? selectedComparison.enhanced
        : selectedComparison.original
      : matchingDraftPreview &&
          voiceConfigurationsEqual(matchingDraftPreview.config, draftConfiguration)
        ? matchingDraftPreview.preview
        : draftMatchesAccepted && acceptedPreviewMatches
          ? readyProfile?.preview
          : undefined;
  const previewOutdated = Boolean(
    isQwenPreview
      ? !qwenModelPreview
      : isChatterboxProfile &&
          (profile?.draftPreview?.preview || readyProfile?.preview) &&
          !matchingDraftPreview &&
          !acceptedPreviewMatches,
  );
  const canApplyDraftConfiguration = Boolean(
    !isQwenPreview &&
    !draftMatchesAccepted &&
    selectedPreview &&
    (draftEnhancementMode === 'standard' || selectedComparison?.enhanced),
  );
  const recordingReady = Boolean(recording.blob);
  const canSubmitRecording = recordingReady && !recordingRequiresRetry && !busy;
  const recordingGuidance =
    recordingStartedAt !== null
      ? 'Speak naturally and do not rush.'
      : `Most recordings take about 10 to ${VOICE_ENROLLMENT_TARGET_SECONDS} seconds.`;

  useEffect(() => {
    recordingUrlRef.current = recording.url;
  }, [recording.url]);

  useEffect(() => {
    if (recordingStartedAt === null) return undefined;
    const updateElapsed = () => setElapsedSeconds((performance.now() - recordingStartedAt) / 1000);
    updateElapsed();
    const timer = window.setInterval(updateElapsed, 250);
    return () => window.clearInterval(timer);
  }, [recordingStartedAt]);

  useEffect(() => {
    if (!busy || busyStartedAt === null) {
      setBusyElapsedSeconds(0);
      return undefined;
    }
    const updateElapsed = () => setBusyElapsedSeconds((performance.now() - busyStartedAt) / 1000);
    updateElapsed();
    const timer = window.setInterval(updateElapsed, 250);
    return () => window.clearInterval(timer);
  }, [busy, busyStartedAt]);

  useEffect(
    () => () => {
      enrollmentPollTokenRef.current += 1;
      if (recordingUrlRef.current) URL.revokeObjectURL(recordingUrlRef.current);
      busyTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    },
    [],
  );

  useEffect(() => {
    selectedProfileIdRef.current = selectedProfileId;
    onSelectedProfileIdChangeRef.current = onSelectedProfileIdChange;
  }, [onSelectedProfileIdChange, selectedProfileId]);

  useEffect(() => {
    let cancelled = false;
    setProfileLoading(true);
    fetch(`/api/voice-cloning/profile?language=${encodeURIComponent(enrollmentLanguage)}`)
      .then(async (res) => {
        return readVoiceApiResponse<ApiProfileResponse>(res);
      })
      .then((data: ApiProfileResponse | null) => {
        if (cancelled) return;
        const next = data?.profile ?? null;
        const previewModels = data?.previewModels?.length
          ? data.previewModels
          : (['chatterbox-v3'] as VoicePreviewModel[]);
        setAvailablePreviewModels(previewModels);
        setDraftPreviewModel((current) =>
          previewModels.includes(current) ? current : 'chatterbox-v3',
        );
        setQwenCloneMode('speaker-embedding');
        setQwenEnhancementMode('standard');
        setQwenModelPreviews({});
        setProfile(next);
        if (next?.status === 'preview-ready' || next?.status === 'ready') {
          setSetupStep('review');
          setCustomizeOpen(false);
        }
        if (next?.draftPreview) {
          setDraftModelVariant(
            next.draftPreview.config.modelVariant ?? DEFAULT_CHATTERBOX_MODEL_VARIANT,
          );
          setDraftLanguageId(next.draftPreview.config.languageId);
          setPreviewTextLanguageId(next.draftPreview.config.previewTextLanguageId ?? 'en');
          setDraftGenerationSettings(
            next.draftPreview.config.generationSettings ?? cloneRecommendedSettings(),
          );
          setDraftEnhancementMode(next.draftPreview.config.enhancementMode ?? 'standard');
        } else if (next) {
          const config = profileConfiguration(next);
          setDraftModelVariant(config.modelVariant ?? DEFAULT_CHATTERBOX_MODEL_VARIANT);
          setDraftLanguageId(config.languageId);
          setPreviewTextLanguageId(next.previewTextLanguageId ?? 'en');
          setDraftGenerationSettings(config.generationSettings ?? cloneRecommendedSettings());
          setDraftEnhancementMode(config.enhancementMode ?? 'standard');
        }
        if (next?.status === 'ready') {
          const language = profileSelectionLanguage(next);
          const persisted = readTeachingVoiceSelection(language);
          const selectedId = selectedProfileIdRef.current;
          const mayRestore = !selectedId || selectedId === next.id;
          const explicitlyDisabled = isTeachingVoiceExplicitlyDisabled(persisted, next.id);
          if (!explicitlyDisabled && mayRestore) {
            activateTeachingVoiceSelection(language, next.id, next.enhancementMode ?? 'standard');
            selectedProfileIdRef.current = next.id;
            onSelectedProfileIdChangeRef.current(next.id);
          }
        }
      })
      .catch(() => {
        if (!cancelled)
          setError('Could not load Teaching Voice. Try again before selecting a voice.');
      })
      .finally(() => {
        if (!cancelled) setProfileLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [enrollmentLanguage]);

  useEffect(() => {
    return () => {
      if (recorderRef.current?.state === 'recording') {
        recorderRef.current.stop();
      }
      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  const replaceRecording = (next: ClipState) => {
    if (candidateAudioRef.current) {
      candidateAudioRef.current.pause();
      candidateAudioRef.current.currentTime = 0;
    }
    setRecording((prev) => {
      if (prev.url) URL.revokeObjectURL(prev.url);
      return next;
    });
    setEnrollmentError(null);
    setPreviewError(null);
    setRecordingRequiresRetry(false);
    setSetupStep('record');
  };

  const clearCandidateRecording = () => {
    enrollmentPollTokenRef.current += 1;
    if (enrollmentAttemptId) {
      window.localStorage.removeItem(enrollmentStorageKey(enrollmentLanguage));
      setEnrollmentAttemptId(null);
    }
    busyTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    busyTimersRef.current = [];
    replaceRecording({});
    setBusy(false);
    setBusyPhase(null);
    setBusyStartedAt(null);
    setEnrollmentError(null);
    setPreviewError(null);
    setError(null);
    setRecordingRequiresRetry(false);
    setSetupStep('record');
  };

  const prepareForRerecord = () => {
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    recorderRef.current = null;
    streamRef.current = null;
    setRecordingStartedAt(null);
    setElapsedSeconds(0);
    clearCandidateRecording();
  };

  const activateProfile = (next: PublicVoiceProfile) => {
    const language = profileSelectionLanguage(next);
    activateTeachingVoiceSelection(language, next.id, next.enhancementMode ?? 'standard');
    selectedProfileIdRef.current = next.id;
    onSelectedProfileIdChange(next.id);
  };

  const disableProfile = (next: PublicVoiceProfile) => {
    disableTeachingVoiceSelection(profileSelectionLanguage(next), next.id);
    selectedProfileIdRef.current = undefined;
    onSelectedProfileIdChange(undefined);
  };

  const startBusy = (initialPhase: BusyPhase, stagedPhases: Array<[number, BusyPhase]> = []) => {
    busyTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    busyTimersRef.current = stagedPhases.map(([delay, phase]) =>
      window.setTimeout(() => setBusyPhase(phase), delay),
    );
    setBusy(true);
    setBusyPhase(initialPhase);
    setBusyStartedAt(performance.now());
  };

  const stopBusy = () => {
    busyTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    busyTimersRef.current = [];
    setBusy(false);
    setBusyPhase(null);
    setBusyStartedAt(null);
  };

  const applyEnrollmentProfile = (next: PublicVoiceProfile) => {
    setProfile(next);
    setSetupStep('review');
    setCustomizeOpen(false);
    setRecordingRequiresRetry(false);
    const config = next.draftPreview?.config ?? profileConfiguration(next);
    setDraftModelVariant(config.modelVariant ?? DEFAULT_CHATTERBOX_MODEL_VARIANT);
    setDraftLanguageId(config.languageId);
    setPreviewTextLanguageId(next.draftPreview?.config.previewTextLanguageId ?? 'en');
    setDraftGenerationSettings(config.generationSettings ?? cloneRecommendedSettings());
    setDraftEnhancementMode(config.enhancementMode ?? 'standard');
  };

  const finishEnrollmentAttempt = (attemptId: string) => {
    setEnrollmentAttemptId(null);
    window.localStorage.removeItem(enrollmentStorageKey(enrollmentLanguage));
    if (enrollmentAttemptId === attemptId) setEnrollmentAttemptId(null);
  };

  const pollEnrollmentAttempt = async (attemptId: string) => {
    const pollToken = ++enrollmentPollTokenRef.current;
    enrollmentRequestInFlightRef.current = true;
    setEnrollmentAttemptId(attemptId);
    window.localStorage.setItem(enrollmentStorageKey(enrollmentLanguage), attemptId);
    setSetupStep('preview');
    if (!busy) startBusy('generating', [[14000, 'finishing']]);

    try {
      while (pollToken === enrollmentPollTokenRef.current) {
        let data: VoiceEnrollmentResponse | null = null;
        try {
          const response = await fetch(
            `/api/voice-cloning/enrollment/${encodeURIComponent(attemptId)}`,
          );
          data = await readVoiceApiResponse<VoiceEnrollmentResponse>(response);
        } catch (error) {
          const parsed = voiceFetchError(error);
          setPreviewError(
            parsed.kind === 'non-json' || parsed.kind === 'network'
              ? 'Voice creation could not be confirmed. Checking enrollment status...'
              : parsed.message,
          );
        }

        if (pollToken !== enrollmentPollTokenRef.current) return;

        if (data?.phase) setBusyPhase(busyPhaseForEnrollmentPhase(data.phase));
        if (data?.status === 'completed' && data.profile) {
          applyEnrollmentProfile(data.profile);
          setPreviewError(null);
          finishEnrollmentAttempt(attemptId);
          return;
        }
        if (data?.status === 'failed') {
          finishEnrollmentAttempt(attemptId);
          setPreviewError(data.error || 'Voice enrollment failed. Please try again.');
          return;
        }

        const delay = Math.max(1500, Math.min(data?.pollIntervalMs ?? 3000, 8000));
        await new Promise((resolve) => window.setTimeout(resolve, delay));
      }
    } finally {
      if (pollToken === enrollmentPollTokenRef.current) {
        enrollmentRequestInFlightRef.current = false;
        stopBusy();
      }
    }
  };

  useEffect(() => {
    const storedAttemptId = window.localStorage.getItem(enrollmentStorageKey(enrollmentLanguage));
    if (!storedAttemptId || profile?.status === 'preview-ready' || profile?.status === 'ready') {
      return;
    }
    setOpen(true);
    setPreviewError('Checking Teaching Voice enrollment status...');
    void pollEnrollmentAttempt(storedAttemptId);
    return () => {
      enrollmentPollTokenRef.current += 1;
    };
    // The poller deliberately owns its own token lifecycle; re-enter only when
    // the selected enrollment language changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enrollmentLanguage]);

  const applyPreset = (preset: VoiceSettingsPreset) => {
    if (preset === 'custom') return;
    setDraftGenerationSettings({ ...VOICE_SETTINGS_PRESETS[preset] });
  };

  const renderVoiceConfigurationControls = () => (
    <div className="space-y-4">
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <div className="text-sm font-semibold text-foreground">Customize Voice</div>
          {draftPreset === 'custom' && (
            <span className="rounded-full border border-border/70 px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
              Custom
            </span>
          )}
        </div>
      </div>

      {availablePreviewModels.includes('qwen3-tts-1.7b-base') && (
        <fieldset className="space-y-2">
          <legend className="text-xs font-medium text-foreground">Preview Model</legend>
          <div className="inline-flex flex-wrap rounded-md border border-border/70 p-0.5">
            {(
              [
                ['chatterbox-v3', 'Chatterbox V3'],
                ['qwen3-tts-1.7b-base', 'Qwen3-TTS 1.7B'],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={draftPreviewModel === value}
                onClick={() => {
                  setDraftPreviewModel(value);
                  if (value === 'qwen3-tts-1.7b-base') {
                    setQwenEnhancementMode('standard');
                  }
                  setPreviewError(null);
                }}
                className={cn(
                  'rounded px-3 py-1.5 text-xs font-medium transition-colors',
                  draftPreviewModel === value
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground',
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </fieldset>
      )}

      {!isQwenPreview ? (
        <div className="space-y-2">
          <div className="text-xs font-medium text-foreground">Voice Style</div>
          <div className="flex flex-wrap gap-2">
            {PRESET_OPTIONS.map((preset) => {
              const selected = draftPreset === preset.value;
              return (
                <button
                  key={preset.value}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => applyPreset(preset.value)}
                  className={cn(
                    'min-w-[104px] rounded-full border px-3 py-1.5 text-center text-sm font-medium transition-colors',
                    selected
                      ? 'border-primary bg-primary/5 text-foreground'
                      : 'border-border/70 text-muted-foreground hover:bg-muted/40',
                  )}
                >
                  {preset.label}
                </button>
              );
            })}
          </div>
          <p className="max-w-[62ch] text-xs leading-snug text-muted-foreground">
            {draftPresetDescription}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="max-w-[62ch] text-xs leading-snug text-muted-foreground">
            Uses your saved English recording for this comparison only. Your active Chatterbox voice
            and settings stay unchanged.
          </p>
          <fieldset className="space-y-2">
            <legend className="text-xs font-medium text-foreground">Clone Method</legend>
            <div className="flex flex-wrap gap-2">
              {(
                [
                  ['speaker-embedding', 'Speaker only'],
                  ['icl', 'Full reference (ICL)'],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={qwenCloneMode === value}
                  onClick={() => {
                    setQwenCloneMode(value);
                    setQwenEnhancementMode('standard');
                    setPreviewError(null);
                  }}
                  className={cn(
                    'rounded-full border px-3 py-1.5 text-sm font-medium transition-colors',
                    qwenCloneMode === value
                      ? 'border-primary bg-primary/5 text-foreground'
                      : 'border-border/70 text-muted-foreground hover:bg-muted/40',
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
            <p className="max-w-[62ch] text-xs leading-snug text-muted-foreground">
              {qwenCloneMode === 'speaker-embedding'
                ? 'Recommended. Avoids carrying enrollment words into the preview, with a possible reduction in voice similarity.'
                : 'Uses the recording and exact saved transcript for closer matching, but may repeat words from the recording.'}
            </p>
          </fieldset>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        {!isQwenPreview ? (
          <div className="space-y-2">
            <label htmlFor="voice-language-id" className="text-xs font-medium text-foreground">
              Accent
            </label>
            <select
              id="voice-language-id"
              value={draftLanguageId}
              onChange={(event) => {
                const languageId = event.target.value;
                if (!isChatterboxFacultySynthesisLanguage(languageId)) return;
                setDraftLanguageId(languageId);
                setPreviewTextLanguageId('en');
              }}
              className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground"
            >
              <option value="en">English</option>
              <option value="hi">Hindi-influenced</option>
            </select>
            <p className="text-xs leading-snug text-muted-foreground">
              Adjusts pronunciation conditioning only. Your lesson text is not translated.
            </p>
          </div>
        ) : (
          <div className="space-y-1 text-xs leading-snug text-muted-foreground">
            <div className="font-medium text-foreground">Preview Language</div>
            <p>English, based on the transcript saved with your recording.</p>
          </div>
        )}

        <fieldset className="space-y-2">
          <legend className="text-xs font-medium text-foreground">Voice Output</legend>
          <div className="inline-flex rounded-md border border-border/70 p-0.5">
            {(
              [
                ['standard', 'Original'],
                ['resemble-enhance', 'Enhanced'],
              ] as const
            ).map(([value, label]) => {
              const selected = selectedEnhancementMode === value;
              const unavailable =
                value === 'resemble-enhance' &&
                !!selectedComparison &&
                !selectedComparison.enhanced;
              return (
                <button
                  key={value}
                  type="button"
                  aria-pressed={selected}
                  disabled={unavailable}
                  onClick={() =>
                    isQwenPreview ? setQwenEnhancementMode(value) : setDraftEnhancementMode(value)
                  }
                  className={cn(
                    'rounded px-3 py-1.5 text-xs font-medium transition-colors',
                    selected ? 'bg-primary text-primary-foreground' : 'text-muted-foreground',
                    unavailable && 'cursor-not-allowed opacity-50',
                  )}
                >
                  {label}
                </button>
              );
            })}
          </div>
          {selectedComparison?.enhancementError && (
            <p className="text-xs text-muted-foreground">{selectedComparison.enhancementError}</p>
          )}
        </fieldset>
      </div>

      {readyProfile && (
        <div className="flex flex-col gap-3 border-t border-border/70 pt-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-xs leading-snug text-muted-foreground" aria-live="polite">
            {previewOutdated
              ? isQwenPreview
                ? 'Generate a Qwen3-TTS comparison from your saved recording.'
                : 'Preview required for the selected accent and style.'
              : isQwenPreview
                ? 'Preview only. Your saved Chatterbox voice remains active.'
                : 'Your saved Teaching Voice remains active until changes are applied.'}
          </div>
          <Button type="button" size="sm" onClick={generateModelPreview} disabled={busy}>
            <Play className="size-4" />
            Preview Changes
          </Button>
        </div>
      )}
    </div>
  );

  const startRecording = async () => {
    if (busy || profileLoading || recordingPending || recorderRef.current || !enrollmentPhrase)
      return;
    clearCandidateRecording();
    if (!consented) {
      setEnrollmentError('Consent is required before recording.');
      return;
    }
    if (typeof MediaRecorder === 'undefined') {
      setEnrollmentError('This browser does not support audio recording.');
      return;
    }
    const mimeType = chooseMimeType();
    if (!mimeType) {
      setEnrollmentError('This browser cannot record a supported audio format.');
      return;
    }
    setRecordingPending(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const chunks: BlobPart[] = [];
      const recorder = new MediaRecorder(stream, { mimeType });
      const recordingStartedAt = performance.now();
      streamRef.current = stream;
      recorderRef.current = recorder;
      setRecordingStartedAt(recordingStartedAt);
      setElapsedSeconds(0);
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      recorder.onerror = () => {
        setEnrollmentError('Recording failed. Please try again.');
      };
      recorder.onstop = () => {
        const duration = (performance.now() - recordingStartedAt) / 1000;
        stream.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        recorderRef.current = null;
        setRecordingStartedAt(null);
        const blob = new Blob(chunks, { type: mimeType });
        if (blob.size < MIN_RECORDING_SIZE_BYTES) {
          replaceRecording({
            error: 'The recording appears empty. Please check your microphone and try again.',
          });
          return;
        }
        replaceRecording({
          blob,
          duration,
          url: URL.createObjectURL(blob),
        });
      };
      recorder.start();
    } catch (err) {
      setRecordingStartedAt(null);
      setEnrollmentError(
        err instanceof DOMException && err.name === 'NotAllowedError'
          ? 'Microphone permission was denied.'
          : 'Microphone is unavailable.',
      );
    } finally {
      setRecordingPending(false);
    }
  };

  const stopRecording = () => {
    if (recorderRef.current?.state === 'recording') {
      recorderRef.current.stop();
    }
  };

  const submitEnrollment = async () => {
    if (
      !recordingReady ||
      !recording.blob ||
      !enrollmentPhrase ||
      recordingRequiresRetry ||
      enrollmentRequestInFlightRef.current
    ) {
      return;
    }
    enrollmentRequestInFlightRef.current = true;
    startBusy('checking', [
      [900, 'preparing'],
      [2600, 'generating'],
    ]);
    setSetupStep('preview');
    setError(null);
    setEnrollmentError(null);
    setPreviewError(null);
    const attemptId = enrollmentAttemptId ?? createEnrollmentAttemptId();
    setEnrollmentAttemptId(attemptId);
    window.localStorage.setItem(enrollmentStorageKey(enrollmentLanguage), attemptId);
    let pollingStarted = false;
    try {
      const formData = new FormData();
      formData.set('attemptId', attemptId);
      formData.set('consent', 'true');
      formData.set('displayName', 'My Teaching Voice');
      formData.set('language', enrollmentLanguage);
      formData.set('languageId', enrollmentLanguage);
      formData.set('phraseId', enrollmentPhrase.id);
      formData.set('referenceText', enrollmentPhrase.text);
      formData.set('recording', recording.blob, 'teaching-voice.webm');
      const response = await fetch('/api/voice-cloning/enrollment', {
        method: 'POST',
        body: formData,
      });
      const data = await readVoiceApiResponse<VoiceEnrollmentResponse>(response);
      if (data.status === 'completed' && data.profile) {
        applyEnrollmentProfile(data.profile);
        finishEnrollmentAttempt(attemptId);
        return;
      }
      if (data.status === 'failed') {
        setPreviewError(data.error || 'Voice enrollment failed.');
        return;
      }
      pollingStarted = true;
      await pollEnrollmentAttempt(data.attemptId || attemptId);
    } catch (err) {
      const parsed = voiceFetchError(err);
      if (parsed.kind === 'http' && parsed.status !== undefined && parsed.status < 500) {
        finishEnrollmentAttempt(attemptId);
        setSetupStep('record');
        setRecordingRequiresRetry(true);
        setEnrollmentError(parsed.message);
        return;
      }
      setPreviewError(
        parsed.kind === 'non-json' || parsed.kind === 'network'
          ? 'Voice creation could not be confirmed. Checking enrollment status...'
          : parsed.message,
      );
      pollingStarted = true;
      await pollEnrollmentAttempt(attemptId);
    } finally {
      enrollmentRequestInFlightRef.current = false;
      if (!pollingStarted) stopBusy();
    }
  };

  const acceptPreview = async () => {
    if (!profile || previewRequestInFlightRef.current) return;
    previewRequestInFlightRef.current = true;
    setSetupStep('preview');
    startBusy('finishing');
    setError(null);
    setPreviewError(null);
    try {
      const response = await fetch('/api/voice-cloning/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          profileId: profile.id,
          action: 'accept-preview',
          ...draftConfiguration,
        }),
      });
      const data = await readVoiceApiResponse<ApiProfileResponse>(response);
      if (!data.profile) throw new Error('Could not accept preview.');
      setProfile(data.profile);
      setSetupStep('review');
      setCustomizeOpen(false);
      const config = profileConfiguration(data.profile);
      setDraftModelVariant(config.modelVariant ?? DEFAULT_CHATTERBOX_MODEL_VARIANT);
      setDraftLanguageId(config.languageId);
      setPreviewTextLanguageId(data.profile.previewTextLanguageId ?? 'en');
      setDraftGenerationSettings(config.generationSettings ?? cloneRecommendedSettings());
      setDraftEnhancementMode(config.enhancementMode ?? 'standard');
      activateProfile(data.profile);
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : 'Could not accept preview.');
    } finally {
      previewRequestInFlightRef.current = false;
      stopBusy();
    }
  };

  async function generateModelPreview() {
    if (!profile || previewRequestInFlightRef.current) return;
    const previewConfiguration = isChatterboxProfile
      ? { ...draftConfiguration, modelVariant: DEFAULT_CHATTERBOX_MODEL_VARIANT }
      : draftConfiguration;
    previewRequestInFlightRef.current = true;
    setSetupStep('preview');
    startBusy('generating', [[14000, 'finishing']]);
    setError(null);
    setPreviewError(null);
    try {
      const response = await fetch('/api/voice-cloning/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          profileId: profile.id,
          action: 'preview-model',
          previewModel: draftPreviewModel,
          ...(isQwenPreview
            ? { enhancementMode: qwenEnhancementMode, qwenCloneMode }
            : { ...previewConfiguration, previewTextLanguageId }),
        }),
      });
      const data = await readVoiceApiResponse<ApiProfileResponse>(response);
      if (!data.profile) throw new Error('Could not generate preview.');
      if (isQwenPreview) {
        if (!data.modelPreview || data.modelPreview.previewModel !== 'qwen3-tts-1.7b-base') {
          throw new Error('Qwen3-TTS returned an invalid preview.');
        }
        if (data.modelPreview.qwenCloneMode !== qwenCloneMode) {
          throw new Error('Qwen3-TTS returned a preview for the wrong clone method.');
        }
        setQwenModelPreviews((current) => ({
          ...current,
          [qwenCloneMode]: data.modelPreview,
        }));
        setSetupStep('review');
        return;
      }
      setProfile(data.profile);
      setSetupStep('review');
      const generatedConfig = data.profile.draftPreview?.config;
      if (generatedConfig) {
        setDraftModelVariant(generatedConfig.modelVariant ?? DEFAULT_CHATTERBOX_MODEL_VARIANT);
        setDraftLanguageId(generatedConfig.languageId);
        setPreviewTextLanguageId(generatedConfig.previewTextLanguageId ?? 'en');
        setDraftGenerationSettings(
          generatedConfig.generationSettings ?? cloneRecommendedSettings(),
        );
        setDraftEnhancementMode(generatedConfig.enhancementMode ?? 'standard');
      }
    } catch (err) {
      setSetupStep('review');
      const message = err instanceof Error ? err.message : 'Could not generate preview.';
      setPreviewError(`${message} Your saved Teaching Voice is unchanged. Try again.`);
    } finally {
      previewRequestInFlightRef.current = false;
      stopBusy();
    }
  }

  const deleteProfile = async (profileId?: string) => {
    if (previewRequestInFlightRef.current) return;
    previewRequestInFlightRef.current = true;
    startBusy('finishing');
    setError(null);
    try {
      const id = profileId ?? profile?.id;
      if (!id) return;
      const response = await fetch(
        `/api/voice-cloning/profile?profileId=${encodeURIComponent(id)}`,
        { method: 'DELETE' },
      );
      await readVoiceApiResponse(response);
      setProfile(null);
      setSetupStep('record');
      setCustomizeOpen(false);
      setEnrollmentError(null);
      setPreviewError(null);
      if (enrollmentAttemptId) {
        window.localStorage.removeItem(enrollmentStorageKey(enrollmentLanguage));
        setEnrollmentAttemptId(null);
      }
      if (!profileId || selectedProfileId === profileId) {
        clearTeachingVoiceSelection(profileSelectionLanguage(profile));
        selectedProfileIdRef.current = undefined;
        onSelectedProfileIdChange(undefined);
      }
      if (!profileId) setOpen(false);
    } catch {
      setError('Could not delete the voice profile.');
    } finally {
      previewRequestInFlightRef.current = false;
      stopBusy();
    }
  };

  const discardCandidateProfile = async (profileId: string) => {
    if (previewRequestInFlightRef.current) return;
    previewRequestInFlightRef.current = true;
    startBusy('finishing');
    try {
      const response = await fetch(
        `/api/voice-cloning/profile?profileId=${encodeURIComponent(profileId)}`,
        {
          method: 'DELETE',
        },
      );
      await readVoiceApiResponse(response);
      clearCandidateRecording();
      setProfile(null);
      setCustomizeOpen(false);
    } catch {
      setError('Could not delete the candidate voice preview.');
    } finally {
      previewRequestInFlightRef.current = false;
      stopBusy();
    }
  };

  const renderStepHeader = (step: SetupStep, title: string) => {
    const stepNumber = step === 'record' ? 1 : step === 'preview' ? 2 : 3;
    return (
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-[11px] font-medium uppercase tracking-normal text-muted-foreground">
            Step {stepNumber} of 3
          </div>
          <div className="text-sm font-semibold text-foreground">{title}</div>
        </div>
        <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
          {(['record', 'preview', 'review'] as const).map((item) => (
            <span
              key={item}
              className={cn('h-1.5 w-7 rounded-full', item === step ? 'bg-primary' : 'bg-border')}
              aria-hidden="true"
            />
          ))}
        </div>
      </div>
    );
  };

  const renderBusyPreview = () => (
    <div className="rounded-lg border border-border/70 p-4">
      {renderStepHeader('preview', 'Preview')}
      <div className="mt-4 flex items-center gap-3 text-sm text-foreground" aria-live="polite">
        <Loader2 className="size-4 animate-spin" />
        <span>{busyPhase ? BUSY_LABELS[busyPhase] : 'Generating your voice preview...'}</span>
        <span className="ml-auto text-xs tabular-nums text-muted-foreground">
          {formatClock(busyElapsedSeconds)}
        </span>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        You can reconnect to this page while the voice is being prepared.
      </p>
    </div>
  );

  const renderPreviewError = () =>
    previewError ? (
      <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
        {previewError}
      </div>
    ) : null;

  const renderVoicePreview = () => {
    if (!selectedComparison) {
      return selectedPreview ? (
        <audio
          controls
          ref={candidateAudioRef}
          className="w-full"
          src={`data:audio/${selectedPreview.format};base64,${selectedPreview.base64}`}
        />
      ) : null;
    }
    return (
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="border border-border/70 p-3">
          <div className="mb-2 flex items-center justify-between gap-2 text-xs font-medium">
            <span>Original</span>
            {selectedEnhancementMode === 'standard' && (
              <span className="text-primary">Selected</span>
            )}
          </div>
          <audio
            controls
            ref={candidateAudioRef}
            className="w-full"
            aria-label={
              isQwenPreview ? 'Original Qwen3-TTS preview' : 'Original Chatterbox preview'
            }
            src={`data:audio/${selectedComparison.original.format};base64,${selectedComparison.original.base64}`}
          />
        </div>
        <div className="border border-border/70 p-3">
          <div className="mb-2 flex items-center justify-between gap-2 text-xs font-medium">
            <span>Enhanced</span>
            {selectedEnhancementMode === 'resemble-enhance' && selectedComparison.enhanced && (
              <span className="text-primary">Selected</span>
            )}
          </div>
          {selectedComparison.enhanced ? (
            <audio
              controls
              className="w-full"
              aria-label="Resemble Enhance preview"
              src={`data:audio/${selectedComparison.enhanced.format};base64,${selectedComparison.enhanced.base64}`}
            />
          ) : (
            <p className="text-xs text-muted-foreground">
              {selectedComparison.enhancementError || 'Enhanced preview is not available.'}
            </p>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="mt-4 w-full rounded-xl border border-border/70 bg-background/85 p-4 shadow-sm">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <label htmlFor="teaching-voice-language" className="text-xs font-medium">
          Teaching Voice language
        </label>
        <select
          id="teaching-voice-language"
          value={enrollmentLanguage}
          disabled={busy || recordingPending || recordingStartedAt !== null}
          onChange={(event) => {
            clearCandidateRecording();
            setProfile(null);
            setCustomizeOpen(false);
            setDraftLanguageId(event.target.value);
            setEnrollmentLanguage(event.target.value);
          }}
          className="h-9 rounded-md border border-border bg-background px-2 text-sm"
        >
          {['en', 'hi', 'mr'].map((language) => (
            <option key={language} value={language}>
              {language === 'en' ? 'English' : language === 'hi' ? 'Hindi' : 'Marathi'}
            </option>
          ))}
          <optgroup label="Existing voices">
            {CHATTERBOX_SUPPORTED_LANGUAGE_IDS.filter(
              (language) => language !== 'en' && language !== 'hi',
            ).map((language) => (
              <option key={language} value={language}>
                {CHATTERBOX_LANGUAGE_LABELS[language]}
              </option>
            ))}
          </optgroup>
        </select>
      </div>
      {error && !open && (
        <p role="alert" className="mb-3 text-xs text-destructive">
          {error}
        </p>
      )}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-foreground">My Teaching Voice</div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            {readyProfile
              ? selectedProfileId === readyProfile.id
                ? 'Teaching Voice selected'
                : readyProfileDisabled
                  ? 'Teaching Voice ready, narration disabled'
                  : 'Teaching Voice ready'
              : profile?.status === 'preview-ready'
                ? 'Preview is ready for review'
                : 'Narration is off until you create a Teaching Voice'}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {readyProfile && (
            <Button
              type="button"
              size="sm"
              variant={selectedProfileId === readyProfile.id ? 'default' : 'outline'}
              onClick={() =>
                selectedProfileId === readyProfile.id
                  ? disableProfile(readyProfile)
                  : activateProfile(readyProfile)
              }
            >
              <Check className="size-4" />
              {selectedProfileId === readyProfile.id ? 'Using Voice' : 'Use Voice'}
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={profileLoading}
            onClick={() => setOpen((v) => !v)}
          >
            <Volume2 className="size-4" />
            {readyProfile ? 'Manage Voice' : profile ? 'Continue Setup' : 'Create Voice'}
          </Button>
        </div>
      </div>

      {open && (
        <div className="mt-4 border-t border-border/70 pt-4">
          {error && (
            <div className="mb-3 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
              <CircleAlert className="mt-0.5 size-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {busy && setupStep === 'preview' ? (
            renderBusyPreview()
          ) : profile?.status === 'preview-ready' ? (
            <div className="space-y-3">
              {renderStepHeader('review', 'Use Voice')}
              {profile.enrollmentQuality?.severity === 'warning' &&
                profile.enrollmentQuality.warnings.length > 0 && (
                  <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
                    <CircleAlert className="mt-0.5 size-4 shrink-0" />
                    <span>{profile.enrollmentQuality.warnings[0]}</span>
                  </div>
                )}
              {selectedPreview ? (
                renderVoicePreview()
              ) : (
                <Button type="button" size="sm" onClick={generateModelPreview} disabled={busy}>
                  <Play className="size-4" />
                  Generate Preview
                </Button>
              )}
              {isChatterboxProfile && customizeOpen && (
                <div className="rounded-lg border border-border/70 p-3">
                  {renderVoiceConfigurationControls()}
                </div>
              )}
              {renderPreviewError()}
              <div className="flex flex-wrap gap-2">
                {!selectedPreview && (
                  <Button type="button" size="sm" onClick={generateModelPreview} disabled={busy}>
                    <Play className="size-4" />
                    Generate Preview
                  </Button>
                )}
                <Button
                  type="button"
                  size="sm"
                  onClick={acceptPreview}
                  disabled={busy || !selectedPreview}
                >
                  <Check className="size-4" />
                  Use This Voice
                </Button>
                {isChatterboxProfile && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setCustomizeOpen((value) => !value)}
                    disabled={busy}
                  >
                    <SlidersHorizontal className="size-4" />
                    {customizeOpen ? 'Hide Settings' : 'Customize Voice'}
                  </Button>
                )}
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => discardCandidateProfile(profile.id)}
                  disabled={busy}
                >
                  <RotateCcw className="size-4" />
                  Re-record
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
                  <X className="size-4" />
                  Cancel
                </Button>
              </div>
            </div>
          ) : readyProfile ? (
            <div className="space-y-3">
              {renderStepHeader('review', 'Use Voice')}
              {selectedPreview && renderVoicePreview()}
              {isChatterboxProfile && customizeOpen && (
                <div className="rounded-lg border border-border/70 p-3">
                  {renderVoiceConfigurationControls()}
                </div>
              )}
              {renderPreviewError()}
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant={selectedProfileId === readyProfile.id ? 'default' : 'outline'}
                  onClick={() => activateProfile(readyProfile)}
                  disabled={busy || selectedProfileId === readyProfile.id}
                >
                  <Check className="size-4" />
                  {selectedProfileId === readyProfile.id ? 'Using Voice' : 'Use This Voice'}
                </Button>
                {canApplyDraftConfiguration && (
                  <Button type="button" size="sm" onClick={acceptPreview} disabled={busy}>
                    <Check className="size-4" />
                    Use These Settings
                  </Button>
                )}
                {isChatterboxProfile && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setCustomizeOpen((value) => !value)}
                    disabled={busy}
                  >
                    <SlidersHorizontal className="size-4" />
                    {customizeOpen ? 'Hide Settings' : 'Customize Voice'}
                  </Button>
                )}
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setProfile(null);
                    setSetupStep('record');
                    setCustomizeOpen(false);
                  }}
                  disabled={busy}
                >
                  <RotateCcw className="size-4" />
                  Replace Voice
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="destructive"
                  onClick={() => deleteProfile()}
                  disabled={busy}
                >
                  <Trash2 className="size-4" />
                  Delete Voice
                </Button>
              </div>
            </div>
          ) : setupStep === 'preview' && previewError ? (
            <div className="space-y-3">
              {renderStepHeader('preview', 'Preview')}
              {renderPreviewError()}
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  onClick={submitEnrollment}
                  disabled={!recordingReady || busy}
                >
                  <Play className="size-4" />
                  Try Again
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={prepareForRerecord}
                  disabled={busy}
                >
                  <RotateCcw className="size-4" />
                  Back to Recording
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              {renderStepHeader('record', 'Record')}
              <label className="flex items-start gap-3 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={consented}
                  onChange={(event) => setConsented(event.target.checked)}
                  className="mt-0.5"
                />
                <span>
                  I am recording my own voice. These samples will be stored privately and used to
                  generate course narration in my voice. I can delete my voice profile later.
                </span>
              </label>

              <div className="rounded-lg border border-border/70 p-3">
                <div className="text-sm font-medium text-foreground">
                  Record Your Teaching Voice
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  Read this paragraph naturally. Most recordings take about 10 to 15 seconds, but do
                  not rush.
                </p>
                <p className="mt-3 max-w-[70ch] text-sm leading-relaxed text-foreground">
                  {enrollmentParagraph ||
                    'New voice enrollment is available in English, Hindi and Marathi.'}
                </p>
                <div className="mt-3 flex flex-wrap gap-2 text-xs text-muted-foreground">
                  <span>Quiet room</span>
                  <span aria-hidden="true">•</span>
                  <span>Steady mic distance</span>
                  <span aria-hidden="true">•</span>
                  <span>Natural voice</span>
                </div>
                <p className="mt-2 text-xs leading-snug text-muted-foreground">
                  Your recording is used only to create your private teaching-voice reference. A
                  quiet, natural recording usually produces the closest result.
                </p>

                <div className="mt-4 flex flex-wrap items-center gap-2">
                  {recordingStartedAt !== null ? (
                    <Button
                      type="button"
                      size="sm"
                      onClick={stopRecording}
                      aria-label="Stop recording teaching voice"
                    >
                      <Mic className="size-4" />
                      Stop Recording
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={
                        !consented ||
                        busy ||
                        profileLoading ||
                        recordingPending ||
                        !enrollmentPhrase
                      }
                      onClick={startRecording}
                      aria-label="Start recording teaching voice"
                    >
                      <Mic className="size-4" />
                      Start Recording
                    </Button>
                  )}
                  <span
                    className={cn(
                      'rounded-md border px-2 py-1 text-sm tabular-nums',
                      recordingStartedAt !== null
                        ? 'border-destructive/30 bg-destructive/5 text-destructive'
                        : 'border-border text-muted-foreground',
                    )}
                    aria-live="polite"
                  >
                    {formatClock(
                      recordingStartedAt !== null ? elapsedSeconds : (recording.duration ?? 0),
                    )}
                  </span>
                  <span className="text-xs text-muted-foreground">{recordingGuidance}</span>
                </div>

                {recording.url && (
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <audio
                      controls
                      ref={candidateAudioRef}
                      className="h-9 min-w-[240px] max-w-full flex-1"
                      src={recording.url}
                    />
                    <span className="text-xs text-muted-foreground">
                      {formatSeconds(recording.duration)}
                    </span>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={prepareForRerecord}
                      disabled={!consented || busy}
                    >
                      <RotateCcw className="size-4" />
                      Re-record
                    </Button>
                  </div>
                )}

                {recording.error && (
                  <p className="mt-2 text-xs text-destructive" role="alert">
                    {recording.error}
                  </p>
                )}
                {enrollmentError && (
                  <p className="mt-2 text-xs text-destructive" role="alert">
                    {enrollmentError}
                  </p>
                )}
              </div>

              <div className="flex flex-wrap justify-end gap-2">
                <Button
                  type="button"
                  size="sm"
                  onClick={submitEnrollment}
                  disabled={!canSubmitRecording}
                >
                  <Play className="size-4" />
                  Continue
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
