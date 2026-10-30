'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { nanoid } from 'nanoid';
import { AudioLines, CircleAlert, Loader2, Pause, Play, RotateCcw, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { activateCourseNarrationVersion } from '@/lib/course-narration/activation';
import { storeCourseNarrationAudio } from '@/lib/course-narration/audio-storage';
import { buildBrowserCourseNarrationRegistration } from '@/lib/course-narration/browser-registration';
import type {
  CourseNarrationEnhancementMode,
  CourseNarrationSelection,
  CourseNarrationState,
  CourseNarrationVersion,
} from '@/lib/course-narration/types';
import {
  courseNarrationContentFingerprint,
  ensureOriginalNarrationState,
  isNarrationVersionStale,
  sceneNarrationText,
  transcriptFingerprint,
  versionMatchesSelection,
} from '@/lib/course-narration/versioning';
import { markStagePersistenceDirty, useStageStore } from '@/lib/store/stage';
import type { SpeechAction } from '@/lib/types/action';
import type { PublicVoiceProfile } from '@/lib/voice-cloning/types';
import type {
  VoiceComparisonBootstrap,
  VoiceComparisonLanguageCode,
  VoiceComparisonPreviewResult,
  VoiceComparisonProviderAvailability,
} from '@/lib/voice-comparison/types';

interface NarrationVoiceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sceneId: string;
}

interface NarrationProviderChoice {
  provider: VoiceComparisonProviderAvailability;
  name: string;
  enhancementMode?: CourseNarrationEnhancementMode;
  description: string;
}

class NarrationPersistenceError extends Error {
  override readonly name = 'NarrationPersistenceError';
}

function responseMessage(body: unknown, fallback: string): string {
  if (!body || typeof body !== 'object') return fallback;
  const value = body as { error?: unknown; details?: unknown };
  return typeof value.details === 'string'
    ? value.details
    : typeof value.error === 'string'
      ? value.error
      : fallback;
}

function responseRegistrationRequired(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  return (body as { registrationRequired?: unknown }).registrationRequired === true;
}

function speechActions(actions: readonly unknown[] | undefined): SpeechAction[] {
  return (actions ?? []).filter(
    (action): action is SpeechAction =>
      !!action && typeof action === 'object' && (action as { type?: unknown }).type === 'speech',
  );
}

function profileProviderName(profile: PublicVoiceProfile | null): string {
  if (!profile) return 'Original narration';
  if (profile.activeEngine === 'qwen3-tts') {
    return profile.qwenEnhancementMode === 'standard'
      ? 'Qwen3-TTS (Original)'
      : 'Qwen3-TTS (Enhanced)';
  }
  if (profile.activeEngine === 'indicf5') return 'IndicF5';
  return 'Chatterbox V3';
}

function narrationProviderName(
  provider: VoiceComparisonProviderAvailability,
  enhancementMode: CourseNarrationEnhancementMode,
): string {
  if (provider.id !== 'qwen3-tts') return provider.name;
  return enhancementMode === 'standard' ? 'Qwen3-TTS (Original)' : 'Qwen3-TTS (Enhanced)';
}

function profileSupportsProvider(
  profile: PublicVoiceProfile | null,
  providerId: CourseNarrationSelection['providerId'],
): boolean {
  if (providerId === 'bodhan') return true;
  if (!profile?.compatibleProviders?.includes(providerId)) return false;
  return providerId !== 'sarvam' || profile.sarvamVoice?.ready === true;
}

async function persistNarrationState(state: CourseNarrationState): Promise<boolean> {
  const current = useStageStore.getState();
  if (!current.stage) return false;
  useStageStore.setState({
    stage: { ...current.stage, narration: state, updatedAt: Date.now() },
  });
  markStagePersistenceDirty([{ kind: 'stage' }]);
  return useStageStore.getState().saveToStorage();
}

export function NarrationVoiceDialog({ open, onOpenChange, sceneId }: NarrationVoiceDialogProps) {
  const stage = useStageStore((state) => state.stage);
  const stageId = stage?.id;
  const lessonLanguage = stage?.lessonLanguage;
  const teacherVoiceProfileId = stage?.teacherVoiceProfileId;
  const scenes = useStageStore((state) => state.scenes);
  const readOnly = useStageStore((state) => state.readOnly);
  const [bootstrap, setBootstrap] = useState<VoiceComparisonBootstrap | null>(null);
  const [profile, setProfile] = useState<PublicVoiceProfile | null>(null);
  const [providerId, setProviderId] =
    useState<CourseNarrationSelection['providerId']>('chatterbox');
  const [language, setLanguage] = useState<VoiceComparisonLanguageCode>('en');
  const [voice, setVoice] = useState('');
  const [style, setStyle] = useState('educational lecture');
  const [enhancementMode, setEnhancementMode] =
    useState<CourseNarrationEnhancementMode>('resemble-enhance');
  const [loading, setLoading] = useState(false);
  const [registering, setRegistering] = useState(false);
  const [registrationRequired, setRegistrationRequired] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<VoiceComparisonPreviewResult | null>(null);
  const [jobVersionId, setJobVersionId] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);

  const currentScene = scenes.find((scene) => scene.id === sceneId);
  const segments = useMemo(
    () =>
      scenes.flatMap((scene) => speechActions(scene.actions).map((action) => ({ scene, action }))),
    [scenes],
  );
  const provider = bootstrap?.providers.find((candidate) => candidate.id === providerId);
  const providerChoices = useMemo<NarrationProviderChoice[]>(
    () =>
      (bootstrap?.providers ?? []).flatMap<NarrationProviderChoice>((candidate) =>
        candidate.id === 'qwen3-tts'
          ? [
              {
                provider: candidate,
                name: 'Qwen3-TTS (Enhanced)',
                enhancementMode: 'resemble-enhance' as const,
                description: 'Resemble-enhanced',
              },
              {
                provider: candidate,
                name: 'Qwen3-TTS (Original)',
                enhancementMode: 'standard' as const,
                description: 'Original Qwen output',
              },
            ]
          : [
              {
                provider: candidate,
                name: candidate.name,
                enhancementMode: undefined,
                description: candidate.experimental
                  ? 'Experimental'
                  : candidate.voiceType === 'preset'
                    ? 'Preset voice'
                    : 'Saved faculty voice',
              },
            ],
      ),
    [bootstrap?.providers],
  );
  const matchingVoices = useMemo(() => bootstrap?.bodhanVoices ?? [], [bootstrap?.bodhanVoices]);
  const selection: CourseNarrationSelection | null = provider
    ? {
        providerId,
        providerName: narrationProviderName(provider, enhancementMode),
        ...(profile && providerId !== 'bodhan' ? { profileId: profile.id } : {}),
        language,
        ...(providerId === 'bodhan' ? { voice, style } : {}),
        ...(provider.supportsEnhancement ? { enhancementMode } : {}),
        experimental: provider.experimental,
      }
    : null;
  const matchingSaved = selection
    ? stage?.narration?.versions.find((version) =>
        versionMatchesSelection(version, selection, scenes),
      )
    : undefined;
  const active = stage?.narration?.versions.find(
    (version) => version.id === stage.narration?.activeVersionId,
  );
  const runningVersion = stage?.narration?.versions.find(
    (version) => version.id === jobVersionId && version.status === 'generating',
  );

  useEffect(() => {
    if (!open || !stageId) return;
    const request = new AbortController();
    setBootstrap(null);
    setProfile(null);
    setLoadError(null);
    setRegistrationRequired(false);
    const load = async () => {
      const current = useStageStore.getState();
      if (!current.stage || current.stage.id !== stageId) {
        throw new Error('The current classroom changed. Reopen Narration Voice.');
      }
      const synchronized = await fetch('/api/course-narration', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        signal: request.signal,
        body: JSON.stringify(
          buildBrowserCourseNarrationRegistration(current.stage, current.scenes),
        ),
      });
      const synchronizedBody = (await synchronized.json().catch(() => null)) as unknown;
      if (synchronized.ok && responseRegistrationRequired(synchronizedBody)) {
        const hasNarration = current.scenes.some(
          (scene) => speechActions(scene.actions).length > 0,
        );
        if (!hasNarration) {
          setLoadError('This classroom has no narration segments to preview or regenerate.');
          return;
        }
        setRegistrationRequired(true);
        return;
      }
      if (!synchronized.ok) {
        throw new Error(
          responseMessage(synchronizedBody, 'The classroom narration could not be synchronized.'),
        );
      }
      const response = await fetch(`/api/course-narration?stageId=${encodeURIComponent(stageId)}`, {
        signal: request.signal,
      });
      const body = (await response.json().catch(() => null)) as {
        narration?: VoiceComparisonBootstrap;
      } | null;
      if (!response.ok || !body?.narration) {
        throw new Error(responseMessage(body, 'Narration providers are unavailable.'));
      }
      setBootstrap(body.narration);
      setProfile(body.narration.profile ?? null);
      const preferredSelection = current.stage.narration?.preferredSelection;
      const initialLanguage = body.narration.languages.some(
        (candidate) => candidate.code === preferredSelection?.language,
      )
        ? preferredSelection!.language
        : body.narration.languages.some((candidate) => candidate.code === lessonLanguage)
          ? lessonLanguage!
          : body.narration.languages.some(
                (candidate) => candidate.code === body.narration?.profile?.language,
              )
            ? (body.narration.profile!.language as VoiceComparisonLanguageCode)
            : 'en';
      setLanguage(initialLanguage);
      const preferredProvider = body.narration.providers.find(
        (candidate) =>
          candidate.id === preferredSelection?.providerId &&
          candidate.configured &&
          candidate.courseNarrationEnabled &&
          candidate.supportedLanguages.includes(initialLanguage) &&
          profileSupportsProvider(body.narration?.profile ?? null, candidate.id),
      );
      const profileDefaultProvider = !preferredSelection
        ? body.narration.providers.find(
            (candidate) =>
              candidate.id === body.narration?.profile?.activeEngine &&
              candidate.configured &&
              candidate.courseNarrationEnabled &&
              candidate.supportedLanguages.includes(initialLanguage) &&
              profileSupportsProvider(body.narration?.profile ?? null, candidate.id),
          )
        : undefined;
      const first =
        preferredProvider ??
        profileDefaultProvider ??
        body.narration.providers.find(
          (candidate) =>
            candidate.configured &&
            candidate.courseNarrationEnabled &&
            candidate.supportedLanguages.includes(initialLanguage) &&
            profileSupportsProvider(body.narration?.profile ?? null, candidate.id),
        );
      if (first) {
        setProviderId(first.id);
        setEnhancementMode(
          first.id === 'qwen3-tts'
            ? preferredSelection?.enhancementMode === 'standard'
              ? 'standard'
              : 'resemble-enhance'
            : preferredSelection?.providerId === first.id && preferredSelection.enhancementMode
              ? preferredSelection.enhancementMode
              : 'standard',
        );
      }
      setVoice(
        preferredSelection?.providerId === 'bodhan' && preferredSelection.voice
          ? preferredSelection.voice
          : (body.narration.bodhanVoices[0]?.id ?? ''),
      );
      setStyle(
        preferredSelection?.providerId === 'bodhan' && preferredSelection.style
          ? preferredSelection.style
          : (body.narration.bodhanStyles[0] ?? 'educational lecture'),
      );
    };
    void load().catch((caught: unknown) => {
      if ((caught as { name?: string }).name !== 'AbortError') {
        setLoadError(
          caught instanceof Error ? caught.message : 'Narration providers are unavailable.',
        );
      }
    });
    return () => request.abort();
  }, [lessonLanguage, loadAttempt, open, stageId, teacherVoiceProfileId]);

  const selectionForProvider = (
    candidate: VoiceComparisonProviderAvailability,
    mode: CourseNarrationEnhancementMode,
    selectedProfile: PublicVoiceProfile | null = profile,
  ): CourseNarrationSelection => ({
    providerId: candidate.id,
    providerName: narrationProviderName(candidate, mode),
    ...(selectedProfile && candidate.id !== 'bodhan' ? { profileId: selectedProfile.id } : {}),
    language,
    ...(candidate.id === 'bodhan' ? { voice, style } : {}),
    ...(candidate.supportsEnhancement ? { enhancementMode: mode } : {}),
    experimental: candidate.experimental,
  });

  const persistPreferredSelection = async (
    nextSelection: CourseNarrationSelection,
    selectedProfile: PublicVoiceProfile | null = profile,
  ) => {
    if (readOnly) return;
    const current = useStageStore.getState();
    if (!current.stage || current.stage.id !== stageId) return;
    const narration = ensureOriginalNarrationState(
      current.stage.narration,
      current.scenes,
      nextSelection.language,
      profileProviderName(selectedProfile),
    );
    if (!(await persistNarrationState({ ...narration, preferredSelection: nextSelection }))) {
      throw new NarrationPersistenceError('The course narration selection could not be saved.');
    }
  };

  const selectProviderChoice = (
    candidate: VoiceComparisonProviderAvailability,
    selectedMode?: CourseNarrationEnhancementMode,
  ) => {
    const mode = candidate.id === 'qwen3-tts' ? (selectedMode ?? 'resemble-enhance') : 'standard';
    setProviderId(candidate.id);
    setEnhancementMode(mode);
    setPreview(null);
    setError(null);
    void persistPreferredSelection(selectionForProvider(candidate, mode)).catch((caught) => {
      setError(
        caught instanceof Error
          ? caught.message
          : 'The course narration selection could not be saved.',
      );
    });
  };

  const selectCourseProfile = async (profileId: string) => {
    if (!stageId || loading) return;
    const selected = bootstrap?.profiles?.find((candidate) => candidate.id === profileId);
    if (!selected) return;
    const current = useStageStore.getState();
    if (!current.stage || current.stage.id !== stageId) {
      setError('The current classroom changed. Reopen Narration Voice.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const nextStage = { ...current.stage, teacherVoiceProfileId: selected.id };
      const response = await fetch('/api/course-narration', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildBrowserCourseNarrationRegistration(nextStage, current.scenes)),
      });
      const body = (await response.json().catch(() => null)) as unknown;
      if (!response.ok) {
        throw new Error(responseMessage(body, 'The selected voice could not be saved.'));
      }
      useStageStore.setState({ stage: { ...nextStage, updatedAt: Date.now() } });
      markStagePersistenceDirty([{ kind: 'stage' }]);
      if (!(await useStageStore.getState().saveToStorage())) {
        throw new Error('The selected voice could not be saved in this browser.');
      }
      setProfile(selected);
      let selectedProvider = provider;
      let selectedMode = enhancementMode;
      if (!profileSupportsProvider(selected, providerId)) {
        selectedProvider = bootstrap?.providers.find(
          (candidate) =>
            candidate.configured &&
            candidate.courseNarrationEnabled &&
            candidate.supportedLanguages.includes(language) &&
            profileSupportsProvider(selected, candidate.id),
        );
        if (selectedProvider) {
          selectedMode = selectedProvider.id === 'qwen3-tts' ? 'resemble-enhance' : 'standard';
          setProviderId(selectedProvider.id);
          setEnhancementMode(selectedMode);
        }
      }
      if (selectedProvider) {
        await persistPreferredSelection(
          selectionForProvider(selectedProvider, selectedMode, selected),
          selected,
        );
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The selected voice could not be saved.');
    } finally {
      setLoading(false);
    }
  };

  const registerBrowserCourse = async () => {
    if (registering) return;
    const current = useStageStore.getState();
    if (!current.stage || current.stage.id !== stageId) {
      setLoadError('The current classroom changed. Reopen Narration Voice.');
      return;
    }
    if (segments.length === 0) {
      setLoadError('This classroom has no narration segments to save.');
      return;
    }
    const confirmed = window.confirm(
      'This course currently exists only in this browser. Save its narration identity to your authenticated account so Narration Voice can use it? This does not regenerate or modify course content, visuals, audio, or Teaching Voice profiles.',
    );
    if (!confirmed) return;
    setRegistering(true);
    setLoadError(null);
    try {
      const response = await fetch('/api/course-narration', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          buildBrowserCourseNarrationRegistration(current.stage, current.scenes),
        ),
      });
      const body = (await response.json().catch(() => null)) as unknown;
      if (!response.ok) {
        throw new Error(responseMessage(body, 'The browser course could not be saved.'));
      }
      setRegistrationRequired(false);
      setLoadAttempt((attempt) => attempt + 1);
    } catch (caught) {
      setLoadError(
        caught instanceof Error ? caught.message : 'The browser course could not be saved.',
      );
    } finally {
      setRegistering(false);
    }
  };

  useEffect(() => {
    const preferred = matchingVoices[0]?.id;
    if (providerId === 'bodhan' && preferred && !matchingVoices.some((item) => item.id === voice)) {
      setVoice(preferred);
    }
  }, [matchingVoices, providerId, voice]);

  useEffect(() => () => controller.current?.abort(), []);

  useEffect(() => {
    if (!bootstrap || !currentScene) return;
    const text = sceneNarrationText(currentScene);
    const saved = bootstrap.savedPreviews.find(
      (candidate) =>
        candidate.providerId === providerId &&
        candidate.request?.text === text &&
        candidate.request.language === language &&
        (!provider?.supportsEnhancement ||
          (candidate.request.enhancementMode ?? 'standard') === enhancementMode) &&
        (providerId !== 'bodhan' ||
          (candidate.request.voice === voice && candidate.request.style === style)),
    );
    setPreview(saved ?? null);
  }, [bootstrap, currentScene, enhancementMode, language, provider, providerId, style, voice]);

  const requestAudio = async (input: {
    sceneId: string;
    text: string;
    actionId?: string;
    signal: AbortSignal;
    selected?: CourseNarrationSelection;
  }): Promise<VoiceComparisonPreviewResult> => {
    const requestedSelection = input.selected ?? selection;
    if (!stage || !requestedSelection) throw new Error('Narration selection is unavailable.');
    const response = await fetch('/api/course-narration', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: input.signal,
      body: JSON.stringify({
        stageId: stage.id,
        sceneId: input.sceneId,
        ...(input.actionId ? { actionId: input.actionId } : {}),
        profileId: requestedSelection.profileId,
        providerId: requestedSelection.providerId,
        text: input.text,
        language: requestedSelection.language,
        voice: requestedSelection.voice,
        style: requestedSelection.style,
        enhancementMode: requestedSelection.enhancementMode,
      }),
    });
    const body = (await response.json().catch(() => null)) as {
      preview?: VoiceComparisonPreviewResult;
    } | null;
    if (!response.ok || !body?.preview) {
      throw new Error(
        responseMessage(body, `${requestedSelection.providerName} could not synthesize audio.`),
      );
    }
    return body.preview;
  };

  const previewScene = async () => {
    if (!currentScene || !selection || loading) return;
    const text = sceneNarrationText(currentScene);
    if (!text) return;
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    setLoading(true);
    setError(null);
    try {
      setPreview(await requestAudio({ sceneId: currentScene.id, text, signal: request.signal }));
    } catch (caught) {
      if ((caught as { name?: string }).name !== 'AbortError') {
        setError(caught instanceof Error ? caught.message : 'Preview failed.');
      }
    } finally {
      if (controller.current === request) controller.current = null;
      setLoading(false);
    }
  };

  const generateVersion = async (resume?: CourseNarrationVersion) => {
    if (!stage || !selection || readOnly || loading) return;
    if (!resume) {
      const confirmed = window.confirm(
        `Regenerate ${segments.length} narration segment${segments.length === 1 ? '' : 's'} with ${selection.providerName}? Course content and visuals will not change.`,
      );
      if (!confirmed) return;
    }
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    setLoading(true);
    setError(null);
    setPreview(null);

    const jobSelection: CourseNarrationSelection = resume
      ? {
          providerId: resume.providerId as CourseNarrationSelection['providerId'],
          providerName: resume.providerName,
          ...(resume.profileId ? { profileId: resume.profileId } : {}),
          language: resume.language,
          ...(resume.settings.voice ? { voice: resume.settings.voice } : {}),
          ...(resume.settings.style ? { style: resume.settings.style } : {}),
          ...(resume.settings.enhancementMode
            ? { enhancementMode: resume.settings.enhancementMode }
            : {}),
          experimental: resume.experimental,
        }
      : selection;

    const snapshotScenes = structuredClone(useStageStore.getState().scenes);
    const originalState = ensureOriginalNarrationState(
      useStageStore.getState().stage?.narration,
      snapshotScenes,
      jobSelection.language,
      profileProviderName(profile),
    );
    const now = new Date().toISOString();
    const version: CourseNarrationVersion = resume
      ? { ...structuredClone(resume), status: 'generating', failures: [], updatedAt: now }
      : {
          id: nanoid(12),
          providerId: selection.providerId,
          providerName: selection.providerName,
          ...(selection.profileId ? { profileId: selection.profileId } : {}),
          voiceLabel:
            selection.providerId === 'bodhan'
              ? (matchingVoices.find((candidate) => candidate.id === selection.voice)?.name ??
                selection.voice)
              : profile?.displayName,
          language: selection.language,
          settings: {
            ...(selection.voice ? { voice: selection.voice } : {}),
            ...(selection.style ? { style: selection.style } : {}),
            ...(selection.enhancementMode ? { enhancementMode: selection.enhancementMode } : {}),
            ...(selection.providerId === 'sarvam'
              ? { processingMode: 'raw-provider-output' }
              : selection.providerId === 'ming3-tts'
                ? { processingMode: 'model-native-output' }
                : selection.providerId === 'qwen3-tts'
                  ? {
                      processingMode:
                        selection.enhancementMode === 'standard'
                          ? 'model-native-output'
                          : 'resemble-enhanced-output',
                    }
                  : {}),
          },
          createdAt: now,
          updatedAt: now,
          status: 'generating',
          contentFingerprint: courseNarrationContentFingerprint(snapshotScenes),
          scenes: Object.fromEntries(
            snapshotScenes.map((scene) => [scene.id, { sceneId: scene.id, clips: {} }]),
          ),
          failures: [],
          experimental: selection.experimental,
        };
    setJobVersionId(version.id);

    const saveVersion = async () => {
      const latest = useStageStore.getState().stage?.narration ?? originalState;
      const versions = latest.versions.some((candidate) => candidate.id === version.id)
        ? latest.versions.map((candidate) => (candidate.id === version.id ? version : candidate))
        : [...latest.versions, version];
      if (
        !(await persistNarrationState({
          ...latest,
          preferredSelection: jobSelection,
          versions,
        }))
      ) {
        throw new NarrationPersistenceError(
          'Narration progress could not be saved. No further synthesis was requested.',
        );
      }
    };

    try {
      // Persist the separate version before the first (potentially paid) request.
      await saveVersion();
      for (const scene of snapshotScenes) {
        let sceneDuration = 0;
        for (const action of speechActions(scene.actions)) {
          if (request.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
          const existing = version.scenes[scene.id]?.clips[action.id];
          if (existing?.audioId && existing.transcript === action.text) {
            sceneDuration += existing.durationSeconds ?? 0;
            continue;
          }
          try {
            const result = await requestAudio({
              sceneId: scene.id,
              actionId: action.id,
              text: action.text,
              signal: request.signal,
              selected: jobSelection,
            });
            const stored = await storeCourseNarrationAudio({
              stageId: stage.id,
              versionId: version.id,
              sceneId: scene.id,
              actionId: action.id,
              text: action.text,
              format: result.audio.format,
              base64: result.audio.base64,
              durationSeconds: result.durationSeconds,
            });
            version.scenes[scene.id].clips[action.id] = {
              transcript: action.text,
              transcriptFingerprint: transcriptFingerprint(action.text),
              audioId: stored.audioId,
              durationSeconds: stored.durationSeconds,
              outputCodec: result.outputCodec ?? result.audio.format,
              chunked: result.chunked,
            };
            sceneDuration += stored.durationSeconds ?? 0;
            version.updatedAt = new Date().toISOString();
            await saveVersion();
          } catch (caught) {
            if ((caught as { name?: string }).name === 'AbortError') throw caught;
            if (caught instanceof NarrationPersistenceError) throw caught;
            version.failures.push({
              sceneId: scene.id,
              actionId: action.id,
              message: caught instanceof Error ? caught.message : 'Narration synthesis failed.',
            });
          }
        }
        version.scenes[scene.id].durationSeconds = sceneDuration || undefined;
      }
      version.status = version.failures.length > 0 ? 'failed' : 'complete';
      version.totalDurationSeconds = Object.values(version.scenes).reduce(
        (total, scene) => total + (scene.durationSeconds ?? 0),
        0,
      );
    } catch (caught) {
      if ((caught as { name?: string }).name === 'AbortError') version.status = 'cancelled';
      else {
        version.status = 'failed';
        setError(caught instanceof Error ? caught.message : 'Narration regeneration failed.');
      }
    } finally {
      version.updatedAt = new Date().toISOString();
      try {
        await saveVersion();
      } catch (saveError) {
        setError(
          saveError instanceof Error ? saveError.message : 'Narration progress could not be saved.',
        );
      }
      if (controller.current === request) controller.current = null;
      setLoading(false);
      setJobVersionId(null);
    }
  };

  const activate = async (versionId: string) => {
    setLoading(true);
    setError(null);
    try {
      if (!(await activateCourseNarrationVersion(versionId))) {
        throw new Error(
          'Narration activation could not be saved. The previous narration remains active.',
        );
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Narration activation failed.');
    } finally {
      setLoading(false);
    }
  };

  const previewUrl = preview
    ? `data:audio/${preview.audio.format};base64,${preview.audio.base64}`
    : undefined;
  const compatible = Boolean(
    provider?.configured &&
    provider.courseNarrationEnabled &&
    provider.supportedLanguages.includes(language) &&
    profileSupportsProvider(profile, providerId) &&
    (providerId !== 'bodhan' || voice),
  );
  const eligibleProfiles = (bootstrap?.profiles ?? []).filter((candidate) =>
    bootstrap?.providers.some(
      (engine) =>
        engine.configured &&
        engine.courseNarrationEnabled &&
        engine.supportedLanguages.includes(language) &&
        engine.id !== 'bodhan' &&
        profileSupportsProvider(candidate, engine.id),
    ),
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="narration-voice-dialog"
        showCloseButton={false}
        className="max-h-[85vh] w-full max-w-[calc(100vw-2rem)] overflow-y-auto p-0 sm:max-w-2xl"
      >
        <DialogTitle className="sr-only">Narration Voice</DialogTitle>
        <div className="flex items-center justify-between border-b px-5 py-4">
          <div>
            <h2 className="font-medium">Narration Voice</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Current:{' '}
              {active?.providerName ??
                stage?.narration?.preferredSelection?.providerName ??
                profileProviderName(profile)}
            </p>
          </div>
          <DialogClose className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-muted">
            <X className="size-4" />
            <span className="sr-only">Close</span>
          </DialogClose>
        </div>

        <div className="space-y-5 p-5">
          {loadError ? (
            <p role="alert" className="text-sm text-destructive">
              {loadError}
            </p>
          ) : null}
          {!bootstrap && !loadError && !registrationRequired ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading narration providers…
            </p>
          ) : null}

          {registrationRequired ? (
            <section className="space-y-3 rounded-lg border p-4">
              <div>
                <h3 className="text-sm font-medium">Save this browser course to your account</h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  This older course is stored only in this browser. Narration Voice needs an
                  authenticated owner binding and its existing narration transcript before it can
                  call a voice engine. Your slides, visuals, original audio, and course structure
                  stay unchanged.
                </p>
              </div>
              <Button size="sm" disabled={registering} onClick={() => void registerBrowserCourse()}>
                {registering ? <Loader2 className="animate-spin" /> : null}
                Save to My Account
              </Button>
            </section>
          ) : null}

          {bootstrap ? (
            <>
              <section className="space-y-2">
                <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Voice engine
                </h3>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {providerChoices.map((choice) => {
                    const candidate = choice.provider;
                    const disabled =
                      !candidate.configured ||
                      !candidate.courseNarrationEnabled ||
                      !candidate.supportedLanguages.includes(language) ||
                      !profileSupportsProvider(profile, candidate.id);
                    return (
                      <button
                        key={`${candidate.id}:${choice.enhancementMode ?? 'default'}`}
                        type="button"
                        disabled={disabled || loading}
                        onClick={() => selectProviderChoice(candidate, choice.enhancementMode)}
                        title={
                          disabled
                            ? (candidate.unavailableReason ??
                              'Unavailable for this course language')
                            : choice.name
                        }
                        className={`rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                          providerId === candidate.id &&
                          (candidate.id !== 'qwen3-tts' ||
                            enhancementMode === choice.enhancementMode)
                            ? 'border-primary bg-primary/5'
                            : 'border-border hover:bg-muted/50'
                        } disabled:cursor-not-allowed disabled:opacity-45`}
                      >
                        <span className="block font-medium">{choice.name}</span>
                        <span className="text-[11px] text-muted-foreground">
                          {choice.description}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </section>

              <section className="grid gap-3 rounded-lg border bg-muted/20 p-3 sm:grid-cols-2">
                <label className="space-y-1 text-xs font-medium">
                  Language
                  <select
                    value={language}
                    onChange={(event) =>
                      setLanguage(event.target.value as VoiceComparisonLanguageCode)
                    }
                    disabled={loading}
                    className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                  >
                    {bootstrap.languages.map((item) => (
                      <option key={item.code} value={item.code}>
                        {item.label}
                      </option>
                    ))}
                  </select>
                </label>
                {providerId === 'bodhan' ? (
                  <label className="space-y-1 text-xs font-medium">
                    Preset voice
                    <select
                      value={voice}
                      onChange={(event) => setVoice(event.target.value)}
                      className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                    >
                      {matchingVoices.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name} ({item.recordedLanguageLabel})
                        </option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <label className="space-y-1 text-xs font-medium">
                    Faculty voice
                    <select
                      aria-label="Saved faculty voice"
                      value={profile?.id ?? ''}
                      disabled={loading || eligibleProfiles.length === 0}
                      onChange={(event) => void selectCourseProfile(event.target.value)}
                      className="h-9 w-full rounded-md border bg-background px-2 text-sm font-normal"
                    >
                      {!profile ? <option value="">Select a saved voice</option> : null}
                      {profile &&
                      !eligibleProfiles.some((candidate) => candidate.id === profile.id) ? (
                        <option value={profile.id} disabled>
                          {profile.displayName} · unavailable for {language.toUpperCase()}
                        </option>
                      ) : null}
                      {eligibleProfiles.map((candidate) => (
                        <option key={candidate.id} value={candidate.id}>
                          {candidate.displayName} ·{' '}
                          {new Date(candidate.createdAt).toLocaleDateString()}
                        </option>
                      ))}
                    </select>
                    <span className="block font-normal text-muted-foreground">
                      Saved for this course only. Your default Teaching Voice is unchanged.
                    </span>
                  </label>
                )}
                {providerId === 'bodhan' ? (
                  <label className="space-y-1 text-xs font-medium sm:col-span-2">
                    Speaking style
                    <select
                      value={style}
                      onChange={(event) => setStyle(event.target.value)}
                      className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                    >
                      {bootstrap.bodhanStyles.map((item) => (
                        <option key={item} value={item}>
                          {item}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
                {provider?.supportsEnhancement && providerId !== 'qwen3-tts' ? (
                  <label className="space-y-1 text-xs font-medium sm:col-span-2">
                    Audio mode
                    <select
                      value={enhancementMode}
                      onChange={(event) =>
                        setEnhancementMode(event.target.value as CourseNarrationEnhancementMode)
                      }
                      className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                    >
                      <option value="standard">Original provider output</option>
                      <option value="resemble-enhance">Resemble Enhance</option>
                    </select>
                  </label>
                ) : null}
              </section>

              {providerId === 'sarvam' ? (
                <p className="rounded-md border border-amber-300/60 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
                  Uses the existing saved Sarvam clone and raw provider output. Sahaya will not
                  create a new clone or process the returned audio.
                </p>
              ) : null}
              {providerId === 'sarvam' || providerId === 'bodhan' ? (
                <p className="text-xs text-muted-foreground">
                  This external API may use provider quota or incur charges. No request runs until
                  you click Preview or Regenerate.
                </p>
              ) : null}

              <section className="flex flex-wrap items-center justify-between gap-3 rounded-lg border px-3 py-3">
                <div className="text-xs text-muted-foreground">
                  <strong className="font-medium text-foreground">
                    {scenes.filter((scene) => speechActions(scene.actions).length > 0).length}
                  </strong>{' '}
                  scenes ·{' '}
                  <strong className="font-medium text-foreground">{segments.length}</strong>{' '}
                  narration segments
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={
                      !compatible || !sceneNarrationText(currentScene ?? { actions: [] }) || loading
                    }
                    onClick={() => void previewScene()}
                  >
                    {loading && !runningVersion ? <Loader2 className="animate-spin" /> : <Play />}
                    Preview This Scene
                  </Button>
                  {runningVersion ? (
                    <Button variant="outline" size="sm" onClick={() => controller.current?.abort()}>
                      <Pause /> Cancel
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      disabled={!compatible || readOnly || loading || segments.length === 0}
                      onClick={() => void generateVersion()}
                    >
                      <RotateCcw /> Regenerate Course Narration
                    </Button>
                  )}
                </div>
              </section>

              {segments.length === 0 ? (
                <p className="rounded-md border px-3 py-2 text-sm text-muted-foreground">
                  This classroom has no narration segments to preview or regenerate.
                </p>
              ) : null}

              {previewUrl ? (
                <audio
                  data-testid="narration-scene-preview"
                  controls
                  src={previewUrl}
                  className="h-10 w-full"
                />
              ) : null}
              {error ? (
                <p role="alert" className="flex items-start gap-2 text-sm text-destructive">
                  <CircleAlert className="mt-0.5 size-4 shrink-0" />
                  {error}
                </p>
              ) : null}

              <section className="space-y-2">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Saved narration
                  </h3>
                  {matchingSaved && matchingSaved.id !== stage?.narration?.activeVersionId ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void activate(matchingSaved.id)}
                    >
                      Switch to saved narration
                    </Button>
                  ) : null}
                </div>
                <div className="space-y-2">
                  {(stage?.narration?.versions ?? []).map((version) => {
                    const stale = isNarrationVersionStale(version, scenes);
                    const isActive = version.id === stage?.narration?.activeVersionId;
                    const completedSegments = Object.values(version.scenes).reduce(
                      (total, scene) => total + Object.keys(scene.clips).length,
                      0,
                    );
                    return (
                      <div
                        key={version.id}
                        className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm"
                      >
                        <div className="min-w-0">
                          <p className="truncate font-medium">
                            {version.providerName}
                            {version.experimental ? ' · Experimental' : ''}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {stale ? 'Outdated after transcript edits' : version.status}
                            {version.status === 'generating'
                              ? ` · ${completedSegments}/${segments.length}`
                              : ''}
                            {version.totalDurationSeconds
                              ? ` · ${version.totalDurationSeconds.toFixed(1)}s`
                              : ''}
                            {version.failures.length ? ` · ${version.failures.length} failed` : ''}
                          </p>
                        </div>
                        <div className="flex shrink-0 gap-1">
                          {(version.status === 'failed' || version.status === 'cancelled') &&
                          !stale ? (
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={loading}
                              onClick={() => void generateVersion(version)}
                            >
                              Retry
                            </Button>
                          ) : null}
                          {version.status === 'complete' && !stale && !isActive ? (
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={loading}
                              onClick={() => void activate(version.id)}
                            >
                              Use This Narration
                            </Button>
                          ) : null}
                          {isActive ? (
                            <span className="rounded-full bg-primary/10 px-2 py-1 text-xs text-primary">
                              Active
                            </span>
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
                  {!stage?.narration?.versions.length ? (
                    <p className="text-xs text-muted-foreground">
                      The current course narration will be preserved as Original when you generate
                      another version.
                    </p>
                  ) : null}
                </div>
              </section>
            </>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function NarrationVoiceButton({ sceneId }: { sceneId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        data-testid="edit-dock-narration-voice"
        onClick={() => setOpen(true)}
        className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:border-primary/30 hover:text-foreground"
      >
        <AudioLines className="size-3" /> Narration Voice
      </button>
      <NarrationVoiceDialog open={open} onOpenChange={setOpen} sceneId={sceneId} />
    </>
  );
}
