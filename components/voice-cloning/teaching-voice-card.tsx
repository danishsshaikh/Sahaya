'use client';

import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, CircleAlert, FileAudio, Loader2, Mic, Volume2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { getVoiceEnrollmentPhrases } from '@/lib/voice-cloning/phrases';
import {
  MAX_RECORDING_SIZE_BYTES,
  MIN_RECORDING_SIZE_BYTES,
  VOICE_ENROLLMENT_TARGET_SECONDS,
} from '@/lib/voice-cloning/limits';
import type { PublicVoiceProfile } from '@/lib/voice-cloning/types';
import { readVoiceApiResponse, voiceFetchError } from '@/lib/voice-cloning/api-client';
import {
  activateTeachingVoiceSelection,
  isTeachingVoiceExplicitlyDisabled,
  readTeachingVoiceSelection,
} from '@/lib/voice-cloning/selection-client';

interface TeachingVoiceCardProps {
  selectedProfileId?: string;
  onSelectedProfileIdChange: (profileId: string | undefined) => void;
}

type EnrollmentMode = 'microphone' | 'audio-import';
type BusyPhase = 'checking' | 'preparing' | 'generating' | 'finishing';
type ClipState = { blob?: Blob; url?: string; duration?: number; error?: string };
type ApiProfileResponse = {
  profile?: PublicVoiceProfile | null;
  error?: string;
  details?: string;
};
type VoiceEnrollmentResponse = ApiProfileResponse & {
  attemptId?: string;
  status?: 'queued' | 'running' | 'completed' | 'failed';
  phase?:
    | 'queued'
    | 'quality_check'
    | 'preprocessing'
    | 'provider_registration'
    | 'preview_generation'
    | 'mastering'
    | 'finalizing'
    | 'completed'
    | 'failed';
  pollIntervalMs?: number;
};

const BUSY_LABELS: Record<BusyPhase, string> = {
  checking: 'Checking your recording…',
  preparing: 'Preparing your voice…',
  generating: 'Generating your voice…',
  finishing: 'Saving your voice…',
};
const ENROLLMENT_ATTEMPT_STORAGE_KEY = 'sahaya.teachingVoice.enrollmentAttempt.en';
const ENROLLMENT_PHRASE = getVoiceEnrollmentPhrases('en')[0];

function createEnrollmentAttemptId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `voice_${Date.now()}_${Math.random().toString(36).slice(2)}`
  );
}

function chooseMimeType(): string {
  const candidates = ['audio/ogg;codecs=opus', 'audio/webm;codecs=opus', 'audio/webm'];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || '';
}

function formatClock(value: number): string {
  const seconds = Math.max(0, Math.floor(value));
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function phaseForEnrollment(phase?: VoiceEnrollmentResponse['phase']): BusyPhase {
  if (phase === 'quality_check') return 'checking';
  if (phase === 'preprocessing') return 'preparing';
  if (phase === 'finalizing' || phase === 'completed') return 'finishing';
  return 'generating';
}

function enhancedSample(profile: PublicVoiceProfile | null) {
  return profile?.qwenPreview?.comparison.enhanced;
}

function isReady(profile: PublicVoiceProfile | null): profile is PublicVoiceProfile {
  return Boolean(
    profile?.status === 'ready' &&
    profile.activeEngine === 'qwen3-tts' &&
    profile.qwenEnhancementMode === 'resemble-enhance' &&
    enhancedSample(profile),
  );
}

export function TeachingVoiceCard({
  selectedProfileId,
  onSelectedProfileIdChange,
}: TeachingVoiceCardProps) {
  const [profile, setProfile] = useState<PublicVoiceProfile | null>(null);
  const [profileLoading, setProfileLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [mode, setMode] = useState<EnrollmentMode>('microphone');
  const [consented, setConsented] = useState(false);
  const [recording, setRecording] = useState<ClipState>({});
  const [recordingFileName, setRecordingFileName] = useState('teaching-voice.webm');
  const [recordingStartedAt, setRecordingStartedAt] = useState<number | null>(null);
  const [recordingPending, setRecordingPending] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [transcript, setTranscript] = useState('');
  const [transcribing, setTranscribing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [busyPhase, setBusyPhase] = useState<BusyPhase>('checking');
  const [error, setError] = useState<string | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const requestInFlightRef = useRef(false);
  const pollTokenRef = useRef(0);
  const recordingUrlRef = useRef<string | undefined>(undefined);
  const selectedProfileIdRef = useRef(selectedProfileId);
  const onSelectedProfileIdChangeRef = useRef(onSelectedProfileIdChange);

  const sample = enhancedSample(profile);
  const ready = isReady(profile);
  const persistedSelection = profile ? readTeachingVoiceSelection('en') : undefined;
  const intentionallyDisabled = profile
    ? isTeachingVoiceExplicitlyDisabled(persistedSelection, profile.id)
    : false;
  const selected = ready && selectedProfileId === profile.id;

  useEffect(() => {
    selectedProfileIdRef.current = selectedProfileId;
    onSelectedProfileIdChangeRef.current = onSelectedProfileIdChange;
  }, [onSelectedProfileIdChange, selectedProfileId]);

  useEffect(() => {
    recordingUrlRef.current = recording.url;
  }, [recording.url]);

  useEffect(() => {
    if (recordingStartedAt === null) return undefined;
    const update = () => setElapsedSeconds((performance.now() - recordingStartedAt) / 1000);
    update();
    const timer = window.setInterval(update, 250);
    return () => window.clearInterval(timer);
  }, [recordingStartedAt]);

  useEffect(
    () => () => {
      pollTokenRef.current += 1;
      if (recordingUrlRef.current) URL.revokeObjectURL(recordingUrlRef.current);
      if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
      streamRef.current?.getTracks().forEach((track) => track.stop());
    },
    [],
  );

  const activateReadyProfile = (next: PublicVoiceProfile) => {
    activateTeachingVoiceSelection('en', next.id, 'resemble-enhance');
    selectedProfileIdRef.current = next.id;
    onSelectedProfileIdChangeRef.current(next.id);
  };

  function clearRecording() {
    setRecording((current) => {
      if (current.url) URL.revokeObjectURL(current.url);
      return {};
    });
    setRecordingStartedAt(null);
    setElapsedSeconds(0);
    setRecordingFileName('teaching-voice.webm');
  }

  const applyCompletedProfile = (next: PublicVoiceProfile): boolean => {
    if (!isReady(next)) {
      setError('Voice generation did not finish successfully. Your previous voice is unchanged.');
      return false;
    }
    setProfile(next);
    setEditing(false);
    setError(null);
    setConsented(false);
    setTranscript('');
    clearRecording();
    activateReadyProfile(next);
    return true;
  };

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setProfileLoading(true);
      try {
        const request = async (profileId?: string) => {
          const query = new URLSearchParams({ language: 'en' });
          if (profileId) query.set('profileId', profileId);
          return readVoiceApiResponse<ApiProfileResponse>(
            await fetch(`/api/voice-cloning/profile?${query}`),
          );
        };
        let data: ApiProfileResponse;
        try {
          data = await request(selectedProfileIdRef.current);
        } catch {
          data = await request();
        }
        if (cancelled) return;
        const next = data.profile ?? null;
        setProfile(next);
        setEditing(!next);
        if (
          isReady(next) &&
          !isTeachingVoiceExplicitlyDisabled(readTeachingVoiceSelection('en'), next.id)
        ) {
          activateReadyProfile(next);
        }
      } catch (caught) {
        if (!cancelled) {
          setEditing(true);
          setError(caught instanceof Error ? caught.message : 'Could not load Teaching Voice.');
        }
      } finally {
        if (!cancelled) setProfileLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const finishAttempt = () => window.localStorage.removeItem(ENROLLMENT_ATTEMPT_STORAGE_KEY);

  const pollEnrollment = async (attemptId: string) => {
    const token = ++pollTokenRef.current;
    requestInFlightRef.current = true;
    setBusy(true);
    setBusyPhase('generating');
    window.localStorage.setItem(ENROLLMENT_ATTEMPT_STORAGE_KEY, attemptId);
    try {
      while (token === pollTokenRef.current) {
        try {
          const data = await readVoiceApiResponse<VoiceEnrollmentResponse>(
            await fetch(`/api/voice-cloning/enrollment/${encodeURIComponent(attemptId)}`),
          );
          if (token !== pollTokenRef.current) return;
          setBusyPhase(phaseForEnrollment(data.phase));
          if (data.status === 'completed' && data.profile) {
            finishAttempt();
            applyCompletedProfile(data.profile);
            return;
          }
          if (data.status === 'failed') {
            finishAttempt();
            setError(data.error || 'Voice generation failed. Please try again.');
            return;
          }
        } catch (caught) {
          const parsed = voiceFetchError(caught);
          if (
            (parsed.kind === 'http' || parsed.kind === 'non-json') &&
            parsed.status !== undefined &&
            parsed.status >= 400 &&
            parsed.status < 500
          ) {
            finishAttempt();
            setError(parsed.message);
            return;
          }
          setError(
            parsed.kind === 'network' || parsed.kind === 'non-json'
              ? 'Voice generation could not be confirmed. Checking again…'
              : parsed.message,
          );
        }
        await new Promise((resolve) => window.setTimeout(resolve, 3000));
      }
    } finally {
      if (token === pollTokenRef.current) {
        requestInFlightRef.current = false;
        setBusy(false);
      }
    }
  };

  useEffect(() => {
    const attemptId = window.localStorage.getItem(ENROLLMENT_ATTEMPT_STORAGE_KEY);
    if (!attemptId) return;
    void pollEnrollment(attemptId);
    return () => {
      pollTokenRef.current += 1;
    };
    // Resume only once after mount. The poller owns its lifecycle token.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const beginReplacement = (nextMode: EnrollmentMode) => {
    if (busy) return;
    clearRecording();
    setMode(nextMode);
    setEditing(true);
    setConsented(false);
    setTranscript('');
    setError(null);
  };

  const startRecording = async () => {
    if (busy || recordingPending || recorderRef.current) return;
    if (!consented) {
      setError('Confirm that this is your voice before recording.');
      return;
    }
    if (typeof MediaRecorder === 'undefined') {
      setError('This browser does not support audio recording.');
      return;
    }
    const mimeType = chooseMimeType();
    if (!mimeType) {
      setError('This browser cannot record a supported audio format.');
      return;
    }
    clearRecording();
    setRecordingPending(true);
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const chunks: BlobPart[] = [];
      const recorder = new MediaRecorder(stream, { mimeType });
      const startedAt = performance.now();
      streamRef.current = stream;
      recorderRef.current = recorder;
      setRecordingStartedAt(startedAt);
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      recorder.onerror = () => setError('Recording failed. Please try again.');
      recorder.onstop = () => {
        const duration = (performance.now() - startedAt) / 1000;
        stream.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        recorderRef.current = null;
        setRecordingStartedAt(null);
        const blob = new Blob(chunks, { type: mimeType });
        if (blob.size < MIN_RECORDING_SIZE_BYTES) {
          setRecording({
            error: 'The recording appears empty. Check your microphone and try again.',
          });
          return;
        }
        const fileName = mimeType.includes('ogg') ? 'teaching-voice.ogg' : 'teaching-voice.webm';
        setRecordingFileName(fileName);
        setRecording({ blob, duration, url: URL.createObjectURL(blob) });
      };
      recorder.start();
    } catch (caught) {
      setRecordingStartedAt(null);
      setError(
        caught instanceof DOMException && caught.name === 'NotAllowedError'
          ? 'Microphone permission was denied.'
          : 'Microphone is unavailable.',
      );
    } finally {
      setRecordingPending(false);
    }
  };

  const stopRecording = () => {
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
  };

  const importAudioFile = (file: File | undefined) => {
    if (!file) return;
    const extension = file.name.split('.').pop()?.toLowerCase();
    const inferredType =
      file.type ||
      (
        {
          wav: 'audio/wav',
          mp3: 'audio/mpeg',
          m4a: 'audio/mp4',
          mp4: 'audio/mp4',
          ogg: 'audio/ogg',
          opus: 'audio/ogg',
          flac: 'audio/flac',
          webm: 'audio/webm',
        } as Record<string, string>
      )[extension ?? ''];
    const supported = new Set([
      'audio/wav',
      'audio/x-wav',
      'audio/mpeg',
      'audio/mp4',
      'audio/ogg',
      'audio/flac',
      'audio/webm',
    ]);
    const baseType = inferredType?.toLowerCase().split(';', 1)[0];
    if (!baseType || !supported.has(baseType)) {
      setRecording({ error: 'Choose a WAV, MP3, M4A, OGG, FLAC, or WebM audio file.' });
      return;
    }
    if (file.size < MIN_RECORDING_SIZE_BYTES || file.size > MAX_RECORDING_SIZE_BYTES) {
      setRecording({ error: 'The audio file is empty or exceeds the upload size limit.' });
      return;
    }
    clearRecording();
    const preserved = file.type ? file : new File([file], file.name, { type: baseType });
    const url = URL.createObjectURL(preserved);
    setRecordingFileName(file.name);
    setRecording({ blob: preserved, url });
    setTranscript('');
    setError(null);
    const probe = new Audio(url);
    probe.addEventListener(
      'loadedmetadata',
      () => setRecording((current) => ({ ...current, duration: probe.duration })),
      { once: true },
    );
    probe.addEventListener(
      'error',
      () => setRecording({ error: 'The browser could not decode this audio file.' }),
      { once: true },
    );
  };

  const transcribeAudio = async () => {
    if (!recording.blob || transcribing) return;
    setTranscribing(true);
    setError(null);
    try {
      const formData = new FormData();
      formData.set('audio', recording.blob, recordingFileName);
      formData.set('language', 'en');
      const data = await readVoiceApiResponse<{ text?: string }>(
        await fetch('/api/transcription', { method: 'POST', body: formData }),
      );
      const text = data.text?.trim();
      if (!text) throw new Error('The transcription service returned no text.');
      setTranscript(text);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Transcription is unavailable. Enter the spoken words manually.',
      );
    } finally {
      setTranscribing(false);
    }
  };

  const generateFromExistingProfile = async () => {
    if (!profile || requestInFlightRef.current) return;
    requestInFlightRef.current = true;
    setBusy(true);
    setBusyPhase('generating');
    setError(null);
    try {
      const data = await readVoiceApiResponse<ApiProfileResponse>(
        await fetch('/api/voice-cloning/profile', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ profileId: profile.id, action: 'activate-enhanced-qwen' }),
        }),
      );
      if (!data.profile) throw new Error('Voice generation returned no saved voice.');
      applyCompletedProfile(data.profile);
    } catch (caught) {
      setError(
        `${caught instanceof Error ? caught.message : 'Voice generation failed.'} Your saved voice is unchanged.`,
      );
    } finally {
      requestInFlightRef.current = false;
      setBusy(false);
    }
  };

  const generateFromRecording = async () => {
    if (!recording.blob || requestInFlightRef.current) return;
    if (!consented) {
      setError('Confirm that you own this voice or have permission to use it.');
      return;
    }
    if (mode === 'audio-import' && !transcript.trim()) {
      setError('Transcribe the uploaded audio or enter the exact spoken words.');
      return;
    }
    requestInFlightRef.current = true;
    setBusy(true);
    setBusyPhase('checking');
    setError(null);
    const attemptId = createEnrollmentAttemptId();
    window.localStorage.setItem(ENROLLMENT_ATTEMPT_STORAGE_KEY, attemptId);
    let polling = false;
    try {
      const formData = new FormData();
      formData.set('attemptId', attemptId);
      formData.set('workflow', 'enhanced-qwen');
      formData.set('consent', 'true');
      formData.set('displayName', 'My Teaching Voice');
      formData.set('language', 'en');
      formData.set('languageId', 'en');
      formData.set('enrollmentSource', mode);
      if (mode === 'microphone') {
        formData.set('phraseId', ENROLLMENT_PHRASE!.id);
        formData.set('referenceText', ENROLLMENT_PHRASE!.text);
      } else {
        formData.set('referenceText', transcript.trim());
      }
      formData.set('recording', recording.blob, recordingFileName);
      const data = await readVoiceApiResponse<VoiceEnrollmentResponse>(
        await fetch('/api/voice-cloning/enrollment', { method: 'POST', body: formData }),
      );
      if (data.status === 'completed' && data.profile) {
        finishAttempt();
        applyCompletedProfile(data.profile);
        return;
      }
      if (data.status === 'failed') {
        finishAttempt();
        setError(data.error || 'Voice generation failed. Please try again.');
        return;
      }
      polling = true;
      await pollEnrollment(data.attemptId || attemptId);
    } catch (caught) {
      const parsed = voiceFetchError(caught);
      if (parsed.kind === 'http' && parsed.status !== undefined && parsed.status < 500) {
        finishAttempt();
        setError(parsed.message);
        return;
      }
      polling = true;
      setError('Voice generation could not be confirmed. Checking again…');
      await pollEnrollment(attemptId);
    } finally {
      if (!polling) {
        requestInFlightRef.current = false;
        setBusy(false);
      }
    }
  };

  const generateVoice = () => {
    if (editing || !profile) return generateFromRecording();
    return generateFromExistingProfile();
  };

  const canGenerate =
    !busy &&
    !transcribing &&
    (editing
      ? Boolean(recording.blob && consented && (mode === 'microphone' || transcript.trim()))
      : Boolean(profile));

  return (
    <section className="mt-4 w-full rounded-xl border border-border/70 bg-background/85 p-4 shadow-sm">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-sm font-semibold text-foreground">My Teaching Voice</h2>
          {!profileLoading && ready && !editing ? (
            <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
              <CheckCircle2 className="size-3.5 text-emerald-600 dark:text-emerald-400" />
              {intentionallyDisabled && !selected ? 'Voice ready, narration is off' : 'Voice ready'}
            </p>
          ) : null}
        </div>
        {!profileLoading && ready && !editing ? (
          <div className="flex flex-wrap gap-2">
            {intentionallyDisabled && !selected ? (
              <Button type="button" size="sm" onClick={() => activateReadyProfile(profile)}>
                Use Voice
              </Button>
            ) : null}
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => beginReplacement('microphone')}
              disabled={busy}
            >
              <Mic className="size-4" />
              Record again
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => beginReplacement('audio-import')}
              disabled={busy}
            >
              <FileAudio className="size-4" />
              Upload Audio
            </Button>
          </div>
        ) : null}
      </div>

      {profileLoading ? (
        <div className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Loading voice…
        </div>
      ) : null}

      {error ? (
        <div
          role="alert"
          className="mt-4 flex items-start gap-2 rounded-lg border border-destructive/25 bg-destructive/5 p-3 text-sm text-destructive"
        >
          <CircleAlert className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      {busy ? (
        <div
          className="mt-4 flex items-center gap-3 border-t border-border/70 pt-4"
          aria-live="polite"
        >
          <Loader2 className="size-5 shrink-0 animate-spin text-primary" />
          <div>
            <p className="text-sm font-medium text-foreground">{BUSY_LABELS[busyPhase]}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Keep this page open while your sample is prepared.
            </p>
          </div>
        </div>
      ) : null}

      {!profileLoading && ready && !editing && sample ? (
        <div className="mt-4 border-t border-border/70 pt-4">
          <audio
            controls
            className="h-10 w-full"
            aria-label="Teaching Voice sample"
            src={`data:audio/${sample.format};base64,${sample.base64}`}
          />
        </div>
      ) : null}

      {!profileLoading && !ready && !editing && profile ? (
        <div className="mt-4 flex flex-col gap-3 border-t border-border/70 pt-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-muted-foreground">
            Your saved recording can be used to finish creating your voice.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => beginReplacement('microphone')}
            >
              <Mic className="size-4" />
              Record again
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => beginReplacement('audio-import')}
            >
              <FileAudio className="size-4" />
              Upload Audio
            </Button>
            <Button type="button" size="sm" onClick={generateVoice} disabled={!canGenerate}>
              <Volume2 className="size-4" />
              Generate Voice
            </Button>
          </div>
        </div>
      ) : null}

      {!profileLoading && editing ? (
        <div className="mt-4 space-y-4 border-t border-border/70 pt-4">
          <div
            className="inline-flex rounded-md border border-border/70 p-0.5"
            aria-label="Voice input"
          >
            <button
              type="button"
              aria-pressed={mode === 'microphone'}
              onClick={() => beginReplacement('microphone')}
              className={cn(
                'rounded px-3 py-1.5 text-xs font-medium transition-colors',
                mode === 'microphone'
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              Record Voice
            </button>
            <button
              type="button"
              aria-pressed={mode === 'audio-import'}
              onClick={() => beginReplacement('audio-import')}
              className={cn(
                'rounded px-3 py-1.5 text-xs font-medium transition-colors',
                mode === 'audio-import'
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              Upload Audio
            </button>
          </div>

          <label className="flex items-start gap-3 text-xs leading-relaxed text-muted-foreground">
            <input
              type="checkbox"
              checked={consented}
              onChange={(event) => setConsented(event.target.checked)}
              className="mt-0.5"
            />
            <span>
              {mode === 'microphone'
                ? 'I am recording my own voice and authorize its use for synthetic course narration.'
                : 'I own this recording or have explicit permission from the speaker to create a synthetic voice.'}{' '}
              Your original audio is stored privately and previous voices are preserved.
            </span>
          </label>

          {mode === 'microphone' ? (
            <div className="space-y-3">
              <p className="max-w-[70ch] text-sm leading-relaxed text-foreground">
                {ENROLLMENT_PHRASE?.text}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                {recordingStartedAt !== null ? (
                  <Button type="button" size="sm" onClick={stopRecording}>
                    <Mic className="size-4" />
                    Stop Recording
                  </Button>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={startRecording}
                    disabled={!consented || recordingPending || busy}
                  >
                    <Mic className="size-4" />
                    Start Recording
                  </Button>
                )}
                <span className="text-xs tabular-nums text-muted-foreground" aria-live="polite">
                  {formatClock(
                    recordingStartedAt !== null ? elapsedSeconds : (recording.duration ?? 0),
                  )}
                </span>
                <span className="text-xs text-muted-foreground">
                  Most recordings take about 10 to {VOICE_ENROLLMENT_TARGET_SECONDS} seconds.
                </span>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <label className="block text-xs font-medium text-foreground">
                <span className="sr-only">Choose voice recording</span>
                <input
                  type="file"
                  accept="audio/wav,audio/x-wav,audio/mpeg,audio/mp4,audio/ogg,audio/flac,audio/webm,.wav,.mp3,.m4a,.ogg,.opus,.flac,.webm"
                  disabled={busy}
                  onChange={(event) => importAudioFile(event.target.files?.[0])}
                  className="block w-full text-sm text-muted-foreground file:mr-3 file:rounded-md file:border file:border-border file:bg-background file:px-3 file:py-2 file:text-xs file:font-medium file:text-foreground"
                />
              </label>
              {recording.blob ? (
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="truncate text-xs text-muted-foreground">
                      {recordingFileName}
                    </span>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={transcribeAudio}
                      disabled={transcribing || busy}
                    >
                      {transcribing ? <Loader2 className="size-4 animate-spin" /> : null}
                      {transcribing ? 'Transcribing…' : 'Transcribe Audio'}
                    </Button>
                  </div>
                  <label className="block space-y-1 text-xs font-medium text-foreground">
                    Transcript
                    <Textarea
                      value={transcript}
                      maxLength={2000}
                      placeholder="Enter or correct the exact words spoken in the recording."
                      onChange={(event) => setTranscript(event.target.value)}
                      className="min-h-20 resize-y font-normal"
                    />
                  </label>
                </div>
              ) : null}
            </div>
          )}

          {recording.url ? (
            <audio
              controls
              className="h-10 w-full"
              aria-label="Selected recording"
              src={recording.url}
            />
          ) : null}
          {recording.error ? (
            <p role="alert" className="text-xs text-destructive">
              {recording.error}
            </p>
          ) : null}

          <div className="flex flex-wrap items-center justify-end gap-2">
            {profile ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  clearRecording();
                  setEditing(false);
                  setError(null);
                }}
                disabled={busy}
              >
                Cancel
              </Button>
            ) : null}
            <Button type="button" size="sm" onClick={generateVoice} disabled={!canGenerate}>
              <Volume2 className="size-4" />
              Generate Voice
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
