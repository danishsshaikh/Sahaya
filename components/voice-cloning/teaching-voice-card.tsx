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
  isTTSLanguageCode,
} from '@/lib/audio/tts-language';
import { getVoiceEnrollmentPhrases } from '@/lib/voice-cloning/phrases';
import { resolveTeachingVoiceLanguage } from '@/lib/voice-cloning/language';
import {
  MIN_RECORDING_SIZE_BYTES,
  VOICE_ENROLLMENT_TARGET_SECONDS,
} from '@/lib/voice-cloning/limits';
import {
  DEFAULT_CHATTERBOX_MODEL_VARIANT,
  RECOMMENDED_VOICE_GENERATION_SETTINGS,
  VOICE_GENERATION_SETTING_RANGES,
  VOICE_SETTINGS_PRESETS,
  voiceGenerationPresetForSettings,
  resolveVoiceProfileProvider,
  type ChatterboxModelVariant,
  type PublicVoiceProfile,
  type VoiceConfiguration,
  type VoiceGenerationSettings,
  type VoiceSettingsPreset,
} from '@/lib/voice-cloning/types';

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
};

type SetupStep = 'record' | 'preview' | 'review';
type BusyPhase = 'checking' | 'preparing' | 'generating' | 'finishing';

const BUSY_LABELS: Record<BusyPhase, string> = {
  checking: 'Checking your recording...',
  preparing: 'Preparing voice sample...',
  generating: 'Generating your voice preview...',
  finishing: 'Finishing audio...',
};

const MODEL_OPTIONS: Array<{
  value: ChatterboxModelVariant;
  label: string;
  description: string;
}> = [
  { value: 'v3', label: 'V3 — Recommended', description: 'Newer multilingual voice model' },
  { value: 'v2', label: 'V2 — Legacy', description: 'Previous voice model' },
];

const PRESET_OPTIONS: Array<{
  value: Exclude<VoiceSettingsPreset, 'custom'>;
  label: string;
}> = [
  { value: 'natural', label: 'Natural' },
  { value: 'expressive', label: 'Expressive' },
  { value: 'accent-test', label: 'Accent Test' },
];

const PRESET_DESCRIPTIONS: Record<Exclude<VoiceSettingsPreset, 'custom'>, string> = {
  natural: 'Balanced settings for clear, natural teaching narration.',
  expressive: 'Adds more emphasis and energy to the delivery.',
  'accent-test':
    'Uses lower voice guidance to test whether the generated accent stays closer to your recording.',
};

const SETTING_LABELS: Record<keyof VoiceGenerationSettings, { label: string; helper: string }> = {
  exaggeration: {
    label: 'Voice Variation',
    helper: 'Controls emphasis and expressiveness in the generated line.',
  },
  cfgWeight: {
    label: 'Voice Guidance',
    helper: 'Lower values leave more room for the reference voice during A/B testing.',
  },
  temperature: {
    label: 'Speech Randomness',
    helper: 'Controls how much variation Chatterbox can use while speaking.',
  },
  topP: {
    label: 'Speech Variation',
    helper: 'Expert sampling control for the range of likely next sounds.',
  },
  minP: {
    label: 'Low-Probability Filtering',
    helper: 'Expert sampling control for filtering unlikely sounds.',
  },
  repetitionPenalty: {
    label: 'Repeat Control',
    helper: 'Expert control that discourages repeated words or phrases.',
  },
};

const BASIC_SETTING_KEYS: Array<keyof VoiceGenerationSettings> = [
  'exaggeration',
  'cfgWeight',
  'temperature',
];

const EXPERT_SETTING_KEYS: Array<keyof VoiceGenerationSettings> = [
  'topP',
  'minP',
  'repetitionPenalty',
];

function cloneRecommendedSettings(): VoiceGenerationSettings {
  return { ...RECOMMENDED_VOICE_GENERATION_SETTINGS };
}

function normalizeProfileLanguageId(profile: PublicVoiceProfile | null): string {
  return resolveTeachingVoiceLanguage(profile?.languageId || profile?.language) || 'en';
}

function profileConfiguration(profile: PublicVoiceProfile): VoiceConfiguration {
  return {
    languageId: normalizeProfileLanguageId(profile),
    ...(resolveVoiceProfileProvider(profile) === 'chatterbox' ? {
      modelVariant: profile.modelVariant,
      generationSettings: profile.generationSettings ?? cloneRecommendedSettings(),
    } : {}),
  };
}

function voiceConfigurationsEqual(left: VoiceConfiguration, right: VoiceConfiguration): boolean {
  if (left.modelVariant !== right.modelVariant || left.languageId !== right.languageId) return false;
  const a = left.generationSettings;
  const b = right.generationSettings;
  if (!a || !b) return a === b;
  return Object.keys(RECOMMENDED_VOICE_GENERATION_SETTINGS).every((key) => {
    const typedKey = key as keyof VoiceGenerationSettings;
    return Math.abs(a[typedKey] - b[typedKey]) < 0.000001;
  });
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
  const [draftGenerationSettings, setDraftGenerationSettings] =
    useState<VoiceGenerationSettings>(cloneRecommendedSettings);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [expertOpen, setExpertOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [busyPhase, setBusyPhase] = useState<BusyPhase | null>(null);
  const [busyStartedAt, setBusyStartedAt] = useState<number | null>(null);
  const [busyElapsedSeconds, setBusyElapsedSeconds] = useState(0);
  const [setupStep, setSetupStep] = useState<SetupStep>('record');
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const [enrollmentError, setEnrollmentError] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [recordingRequiresRetry, setRecordingRequiresRetry] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const candidateAudioRef = useRef<HTMLAudioElement | null>(null);
  const enrollmentRequestInFlightRef = useRef(false);
  const previewRequestInFlightRef = useRef(false);
  const busyTimersRef = useRef<number[]>([]);
  const selectedProfileIdRef = useRef(selectedProfileId);
  const onSelectedProfileIdChangeRef = useRef(onSelectedProfileIdChange);
  const recordingUrlRef = useRef<string | undefined>(undefined);

  const readyProfile = profile?.status === 'ready' ? profile : null;
  const isChatterboxProfile = !!profile && resolveVoiceProfileProvider(profile) === 'chatterbox';
  const draftConfiguration: VoiceConfiguration = {
    languageId: draftLanguageId,
    ...(isChatterboxProfile ? {
      modelVariant: draftModelVariant,
      generationSettings: draftGenerationSettings,
    } : {}),
  };
  const draftPreset = voiceGenerationPresetForSettings(draftGenerationSettings);
  const draftPresetDescription =
    draftPreset === 'custom'
      ? 'Manual settings are active. Choose a style above to return to a preset.'
      : PRESET_DESCRIPTIONS[draftPreset];
  const acceptedConfiguration = readyProfile ? profileConfiguration(readyProfile) : null;
  const draftMatchesAccepted =
    acceptedConfiguration && voiceConfigurationsEqual(draftConfiguration, acceptedConfiguration);
  const selectedPreview =
    profile?.draftPreview &&
    voiceConfigurationsEqual(profile.draftPreview.config, draftConfiguration)
      ? profile.draftPreview.preview
      : draftMatchesAccepted
        ? readyProfile?.preview
        : undefined;
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
        const data = await res.json() as ApiProfileResponse;
        if (!res.ok) throw new Error(data.error || 'Could not load Teaching Voice.');
        return data;
      })
      .then((data: ApiProfileResponse | null) => {
        if (cancelled) return;
        const next = data?.profile ?? null;
        setProfile(next);
        if (next?.status === 'preview-ready' || next?.status === 'ready') {
          setSetupStep('review');
          setCustomizeOpen(false);
        }
        if (next?.draftPreview) {
          setDraftModelVariant(next.draftPreview.config.modelVariant ?? DEFAULT_CHATTERBOX_MODEL_VARIANT);
          setDraftLanguageId(next.draftPreview.config.languageId);
          setDraftGenerationSettings(next.draftPreview.config.generationSettings ?? cloneRecommendedSettings());
        } else if (next) {
          const config = profileConfiguration(next);
          setDraftModelVariant(config.modelVariant ?? DEFAULT_CHATTERBOX_MODEL_VARIANT);
          setDraftLanguageId(config.languageId);
          setDraftGenerationSettings(config.generationSettings ?? cloneRecommendedSettings());
        }
        if (next?.status === 'ready' && !selectedProfileIdRef.current) {
          onSelectedProfileIdChangeRef.current(next.id);
        }
      })
      .catch(() => {
        if (!cancelled) setError('Could not load Teaching Voice. Try again before selecting a voice.');
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

  const updateGenerationSetting = (key: keyof VoiceGenerationSettings, value: number) => {
    setDraftGenerationSettings((prev) => ({ ...prev, [key]: value }));
  };

  const applyPreset = (preset: VoiceSettingsPreset) => {
    if (preset === 'custom') return;
    setDraftGenerationSettings({ ...VOICE_SETTINGS_PRESETS[preset] });
  };

  const resetRecommendedDraft = () => {
    setDraftModelVariant(DEFAULT_CHATTERBOX_MODEL_VARIANT);
    setDraftLanguageId(
      isTTSLanguageCode(acceptedConfiguration?.languageId)
        ? acceptedConfiguration.languageId
        : draftLanguageId,
    );
    setDraftGenerationSettings(cloneRecommendedSettings());
  };

  const renderSettingSlider = (key: keyof VoiceGenerationSettings) => {
    const range = VOICE_GENERATION_SETTING_RANGES[key];
    const metadata = SETTING_LABELS[key];
    const value = draftGenerationSettings[key];
    return (
      <div key={key} className="space-y-1.5">
        <div className="flex items-baseline justify-between gap-3">
          <label htmlFor={`voice-setting-${key}`} className="text-xs font-medium text-foreground">
            {metadata.label}
          </label>
          <span className="text-xs tabular-nums text-muted-foreground">{value.toFixed(2)}</span>
        </div>
        <input
          id={`voice-setting-${key}`}
          type="range"
          min={range.min}
          max={range.max}
          step={range.step}
          value={value}
          aria-valuetext={`${metadata.label} ${value.toFixed(2)}`}
          onChange={(event) => updateGenerationSetting(key, Number(event.target.value))}
          className="w-full accent-primary"
        />
        <div className="flex justify-between text-[10px] tabular-nums text-muted-foreground">
          <span>{range.min.toFixed(2)}</span>
          <span>Recommended {range.recommended.toFixed(2)}</span>
          <span>{range.max.toFixed(2)}</span>
        </div>
        <p className="text-xs leading-snug text-muted-foreground">{metadata.helper}</p>
      </div>
    );
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

      <div className="space-y-2">
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
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-2">
          <label htmlFor="voice-language-id" className="text-xs font-medium text-foreground">
            Language
          </label>
          <select
            id="voice-language-id"
            value={draftLanguageId}
            disabled
            className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground"
          >
            {CHATTERBOX_SUPPORTED_LANGUAGE_IDS.map((languageId) => (
              <option key={languageId} value={languageId}>
                {CHATTERBOX_LANGUAGE_LABELS[languageId]}
              </option>
            ))}
          </select>
          <p className="text-xs leading-snug text-muted-foreground">
            The reference recording fixes this voice's language. Record another voice to change it.
          </p>
        </div>

        <div className="space-y-2">
          <label htmlFor="voice-model-variant" className="text-xs font-medium text-foreground">
            Voice Model
          </label>
          <select
            id="voice-model-variant"
            value={draftModelVariant}
            onChange={(event) => setDraftModelVariant(event.target.value as ChatterboxModelVariant)}
            className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground"
          >
            {MODEL_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="rounded-lg border border-border/70">
        <button
          type="button"
          onClick={() => setAdvancedOpen((value) => !value)}
          className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm font-medium text-foreground"
          aria-expanded={advancedOpen}
        >
          <span className="flex items-center gap-2">
            <SlidersHorizontal className="size-4" />
            Advanced Voice Settings
          </span>
          <span className="text-xs text-muted-foreground">{advancedOpen ? 'Hide' : 'Show'}</span>
        </button>

        {advancedOpen && (
          <div className="space-y-4 border-t border-border/70 p-3">
            <div className="grid gap-4 md:grid-cols-3">
              {BASIC_SETTING_KEYS.map(renderSettingSlider)}
            </div>

            <div className="rounded-md border border-border/70">
              <button
                type="button"
                onClick={() => setExpertOpen((value) => !value)}
                className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-xs font-medium text-foreground"
                aria-expanded={expertOpen}
              >
                <span>Expert Settings</span>
                <span className="text-muted-foreground">{expertOpen ? 'Hide' : 'Show'}</span>
              </button>
              {expertOpen && (
                <div className="grid gap-4 border-t border-border/70 p-3 md:grid-cols-3">
                  {EXPERT_SETTING_KEYS.map(renderSettingSlider)}
                </div>
              )}
            </div>

            <Button type="button" size="sm" variant="outline" onClick={resetRecommendedDraft}>
              <RotateCcw className="size-4" />
              Reset to Recommended
            </Button>
          </div>
        )}
      </div>
    </div>
  );

  const startRecording = async () => {
    if (busy || profileLoading || recordingPending || recorderRef.current || !enrollmentPhrase) return;
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
      [14000, 'finishing'],
    ]);
    setSetupStep('preview');
    setError(null);
    setEnrollmentError(null);
    setPreviewError(null);
    try {
      const formData = new FormData();
      formData.set('consent', 'true');
      formData.set('displayName', 'My Teaching Voice');
      formData.set('language', enrollmentLanguage);
      formData.set('languageId', enrollmentLanguage);
      formData.set('phraseId', enrollmentPhrase.id);
      formData.set('referenceText', enrollmentPhrase.text);
      formData.set('recording', recording.blob, 'teaching-voice.webm');
      const response = await fetch('/api/voice-cloning/profile', {
        method: 'POST',
        body: formData,
      });
      const data = (await response.json()) as ApiProfileResponse;
      if (!response.ok || !data.profile) {
        const message = data.details || data.error || 'Voice enrollment failed.';
        if (response.status === 400) {
          setSetupStep('record');
          setRecordingRequiresRetry(true);
          setEnrollmentError(message);
          return;
        }
        setPreviewError(message);
        return;
      }
      setProfile(data.profile);
      setSetupStep('review');
      setCustomizeOpen(false);
      setRecordingRequiresRetry(false);
      const config = data.profile.draftPreview?.config ?? profileConfiguration(data.profile);
      setDraftModelVariant(config.modelVariant ?? DEFAULT_CHATTERBOX_MODEL_VARIANT);
      setDraftLanguageId(config.languageId);
      setDraftGenerationSettings(config.generationSettings ?? cloneRecommendedSettings());
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : 'Voice enrollment failed.');
    } finally {
      enrollmentRequestInFlightRef.current = false;
      stopBusy();
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
      const data = (await response.json()) as ApiProfileResponse;
      if (!response.ok || !data.profile) {
        throw new Error(data.details || data.error || 'Could not accept preview.');
      }
      setProfile(data.profile);
      setSetupStep('review');
      setCustomizeOpen(false);
      const config = profileConfiguration(data.profile);
      setDraftModelVariant(config.modelVariant ?? DEFAULT_CHATTERBOX_MODEL_VARIANT);
      setDraftLanguageId(config.languageId);
      setDraftGenerationSettings(config.generationSettings ?? cloneRecommendedSettings());
      onSelectedProfileIdChange(data.profile.id);
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : 'Could not accept preview.');
    } finally {
      previewRequestInFlightRef.current = false;
      stopBusy();
    }
  };

  const generateModelPreview = async () => {
    if (!profile || previewRequestInFlightRef.current) return;
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
          ...draftConfiguration,
        }),
      });
      const data = (await response.json()) as ApiProfileResponse;
      if (!response.ok || !data.profile) {
        throw new Error(data.details || data.error || 'Could not generate preview.');
      }
      setProfile(data.profile);
      setSetupStep('review');
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : 'Could not generate preview.');
    } finally {
      previewRequestInFlightRef.current = false;
      stopBusy();
    }
  };

  const deleteProfile = async (profileId?: string) => {
    if (previewRequestInFlightRef.current) return;
    previewRequestInFlightRef.current = true;
    startBusy('finishing');
    setError(null);
    try {
      const id = profileId ?? profile?.id;
      if (!id) return;
      const response = await fetch(`/api/voice-cloning/profile?profileId=${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!response.ok) throw new Error('Could not delete Teaching Voice');
      setProfile(null);
      setSetupStep('record');
      setCustomizeOpen(false);
      setEnrollmentError(null);
      setPreviewError(null);
      if (!profileId || selectedProfileId === profileId) {
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
      const response = await fetch(`/api/voice-cloning/profile?profileId=${encodeURIComponent(profileId)}`, {
        method: 'DELETE',
      });
      if (!response.ok) throw new Error('Could not delete Teaching Voice');
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
        Keep this page open while the preview is prepared.
      </p>
    </div>
  );

  const renderPreviewError = () =>
    previewError ? (
      <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
        {previewError}
      </div>
    ) : null;

  return (
    <div className="mt-4 w-full rounded-xl border border-border/70 bg-background/85 p-4 shadow-sm">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <label htmlFor="teaching-voice-language" className="text-xs font-medium">Teaching Voice language</label>
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
            selectedProfileIdRef.current = undefined;
            onSelectedProfileIdChange(undefined);
          }}
          className="h-9 rounded-md border border-border bg-background px-2 text-sm"
        >
          {['en', 'hi', 'mr'].map((language) => (
            <option key={language} value={language}>
              {language === 'en' ? 'English' : language === 'hi' ? 'Hindi' : 'Marathi'}
            </option>
          ))}
          <optgroup label="Existing voices">
            {CHATTERBOX_SUPPORTED_LANGUAGE_IDS.filter((language) => language !== 'en' && language !== 'hi').map((language) => (
              <option key={language} value={language}>{CHATTERBOX_LANGUAGE_LABELS[language]}</option>
            ))}
          </optgroup>
        </select>
      </div>
      {error && !open && <p role="alert" className="mb-3 text-xs text-destructive">{error}</p>}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-foreground">My Teaching Voice</div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            {readyProfile
              ? selectedProfileId === readyProfile.id
                ? 'Teaching Voice selected'
                : 'Teaching Voice ready'
              : profile?.status === 'preview-ready'
                ? 'Preview is ready for review'
                : 'Create a private voice for AI Teacher narration'}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {readyProfile && (
            <Button
              type="button"
              size="sm"
              variant={selectedProfileId === readyProfile.id ? 'default' : 'outline'}
              onClick={() =>
                onSelectedProfileIdChange(
                  selectedProfileId === readyProfile.id ? undefined : readyProfile.id,
                )
              }
            >
              <Check className="size-4" />
              {selectedProfileId === readyProfile.id ? 'Using Voice' : 'Use Voice'}
            </Button>
          )}
          <Button type="button" size="sm" variant="outline" disabled={profileLoading} onClick={() => setOpen((v) => !v)}>
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
                <audio
                  controls
                  ref={candidateAudioRef}
                  className="w-full"
                  src={`data:audio/${selectedPreview.format};base64,${selectedPreview.base64}`}
                />
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
                <Button
                  type="button"
                  size="sm"
                  onClick={acceptPreview}
                  disabled={busy || !selectedPreview}
                >
                  <Check className="size-4" />
                  Use This Voice
                </Button>
                {isChatterboxProfile && <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setCustomizeOpen((value) => !value)}
                  disabled={busy}
                >
                  <SlidersHorizontal className="size-4" />
                  {customizeOpen ? 'Hide Settings' : 'Customize Voice'}
                </Button>}
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
              {selectedPreview && (
                <audio
                  controls
                  className="w-full"
                  src={`data:audio/${selectedPreview.format};base64,${selectedPreview.base64}`}
                />
              )}
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
                  onClick={() => onSelectedProfileIdChange(readyProfile.id)}
                  disabled={busy || selectedProfileId === readyProfile.id}
                >
                  <Check className="size-4" />
                  {selectedProfileId === readyProfile.id ? 'Using Voice' : 'Use This Voice'}
                </Button>
                {!draftMatchesAccepted &&
                  (selectedPreview ? (
                    <Button type="button" size="sm" onClick={acceptPreview} disabled={busy}>
                      <Check className="size-4" />
                      Use These Settings
                    </Button>
                  ) : (
                    <Button type="button" size="sm" onClick={generateModelPreview} disabled={busy}>
                      <Play className="size-4" />
                      Generate Preview
                    </Button>
                  ))}
                {isChatterboxProfile && <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setCustomizeOpen((value) => !value)}
                  disabled={busy}
                >
                  <SlidersHorizontal className="size-4" />
                  {customizeOpen ? 'Hide Settings' : 'Customize Voice'}
                </Button>}
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
                  onClick={() => setSetupStep('record')}
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
                  {enrollmentParagraph || 'New voice enrollment is available in English, Hindi and Marathi.'}
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
                      disabled={!consented || busy || profileLoading || recordingPending || !enrollmentPhrase}
                      onClick={startRecording}
                      aria-label={
                        recording.blob
                          ? 'Record teaching voice again'
                          : 'Start recording teaching voice'
                      }
                    >
                      <Mic className="size-4" />
                      {recording.blob ? 'Re-record' : 'Start Recording'}
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
                      onClick={startRecording}
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
