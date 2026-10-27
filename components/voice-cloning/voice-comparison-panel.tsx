'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { CircleAlert, Clock3, Loader2, Play, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import type { PublicVoiceProfile } from '@/lib/voice-cloning/types';
import type {
  VoiceComparisonBootstrap,
  VoiceComparisonLanguageCode,
  VoiceComparisonPreviewResult,
  VoiceComparisonProviderAvailability,
} from '@/lib/voice-comparison/types';

type ExternalPreviewProviderId = 'sarvam' | 'bodhan' | 'ming3-tts';

type ResultState = {
  result: VoiceComparisonPreviewResult;
  signature: string;
};

interface VoiceComparisonPanelProps {
  profile: PublicVoiceProfile;
  providerId: ExternalPreviewProviderId;
  text: string;
}

function responseError(body: unknown, fallback: string): string {
  if (body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string') {
    return (body as { error: string }).error;
  }
  return fallback;
}

function providerSignature(input: {
  providerId: ExternalPreviewProviderId;
  text: string;
  language: VoiceComparisonLanguageCode;
  voice?: string;
  style?: string;
}): string {
  return JSON.stringify({
    providerId: input.providerId,
    text:
      input.providerId === 'sarvam' || input.providerId === 'ming3-tts'
        ? input.text
        : input.text.trim(),
    language: input.language,
    voice: input.providerId === 'bodhan' ? (input.voice ?? '') : '',
    style: input.providerId === 'bodhan' ? (input.style ?? '') : '',
  });
}

function resultSignature(result: VoiceComparisonPreviewResult): string | null {
  if (
    !result.request ||
    (result.providerId !== 'sarvam' &&
      result.providerId !== 'bodhan' &&
      result.providerId !== 'ming3-tts')
  ) {
    return null;
  }
  return providerSignature({
    providerId: result.providerId,
    text: result.request.text,
    language: result.request.language,
    voice: result.request.voice,
    style: result.request.style,
  });
}

export function VoiceComparisonPanel({ profile, providerId, text }: VoiceComparisonPanelProps) {
  const [bootstrap, setBootstrap] = useState<VoiceComparisonBootstrap | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [language, setLanguage] = useState<VoiceComparisonLanguageCode>(
    (['en', 'hi', 'mr'].includes(profile.language)
      ? profile.language
      : 'en') as VoiceComparisonLanguageCode,
  );
  const [bodhanVoice, setBodhanVoice] = useState('');
  const [bodhanStyle, setBodhanStyle] = useState('educational lecture');
  const [sarvamConsent, setSarvamConsent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<Partial<Record<ExternalPreviewProviderId, ResultState>>>(
    {},
  );
  const requestController = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setBootstrap(null);
    setLoadError(null);
    void fetch(`/api/voice-cloning/comparison?profileId=${encodeURIComponent(profile.id)}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        const body = (await response.json().catch(() => null)) as {
          comparison?: VoiceComparisonBootstrap;
        } | null;
        if (!response.ok || !body?.comparison) {
          throw new Error(responseError(body, 'Voice preview providers are unavailable.'));
        }
        setBootstrap(body.comparison);
        setBodhanVoice((current) => current || body.comparison!.bodhanVoices[0]?.id || '');
        setBodhanStyle((current) => current || body.comparison!.bodhanStyles[0] || '');
        const restored: Partial<Record<ExternalPreviewProviderId, ResultState>> = {};
        for (const id of ['sarvam', 'bodhan', 'ming3-tts'] as const) {
          const saved = body.comparison.savedPreviews.find((preview) => preview.providerId === id);
          const signature = saved ? resultSignature(saved) : null;
          if (saved && signature) restored[id] = { result: saved, signature };
        }
        setResults(restored);
      })
      .catch((caught: unknown) => {
        if ((caught as { name?: string }).name !== 'AbortError') {
          setLoadError(
            caught instanceof Error ? caught.message : 'Voice preview providers are unavailable.',
          );
        }
      });
    return () => controller.abort();
  }, [profile.id]);

  useEffect(() => {
    if (providerId !== 'bodhan') return;
    const matchingVoice = bootstrap?.bodhanVoices.find(
      (voice) => voice.recordedLanguage === language,
    );
    if (matchingVoice) setBodhanVoice(matchingVoice.id);
  }, [bootstrap, language, providerId]);

  useEffect(
    () => () => {
      requestController.current?.abort();
    },
    [],
  );

  const provider = useMemo(
    () => bootstrap?.providers.find((candidate) => candidate.id === providerId),
    [bootstrap, providerId],
  );
  const resultState = results[providerId];
  const signature = providerSignature({
    providerId,
    text,
    language,
    voice: bodhanVoice,
    style: bodhanStyle,
  });
  const result = resultState?.result;
  const stale = Boolean(resultState && resultState.signature !== signature);

  const generate = async (
    selectedProvider: VoiceComparisonProviderAvailability,
    options: { bypassCache: boolean; createRawVoice?: boolean },
  ) => {
    if (!text.trim() || loading) return;
    requestController.current?.abort();
    const controller = new AbortController();
    requestController.current = controller;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/voice-cloning/comparison', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          profileId: profile.id,
          providerId,
          text: providerId === 'sarvam' || providerId === 'ming3-tts' ? text : text.trim(),
          language,
          bypassCache: options.bypassCache,
          ...(providerId === 'bodhan' ? { voice: bodhanVoice, style: bodhanStyle } : {}),
          ...(providerId === 'sarvam' &&
          (selectedProvider.requiresExternalConsent || options.createRawVoice)
            ? { sarvamExternalConsent: sarvamConsent }
            : {}),
          ...(providerId === 'sarvam' && options.createRawVoice
            ? { sarvamCreateRawVoice: true }
            : {}),
        }),
      });
      const body = (await response.json().catch(() => null)) as {
        preview?: VoiceComparisonPreviewResult;
      } | null;
      if (!response.ok || !body?.preview) {
        throw new Error(
          responseError(body, `${selectedProvider.name} could not generate a preview.`),
        );
      }
      setResults((current) => ({
        ...current,
        [providerId]: { result: body.preview!, signature },
      }));
      if (
        providerId === 'sarvam' &&
        (selectedProvider.requiresExternalConsent || options.createRawVoice)
      ) {
        setBootstrap((current) =>
          current
            ? {
                ...current,
                providers: current.providers.map((item) =>
                  item.id === 'sarvam'
                    ? {
                        ...item,
                        requiresExternalConsent: false,
                        externalVoiceReady: true,
                        sarvamReferenceProvenance: 'original-upload',
                        sarvamCanCreateRawClone: false,
                      }
                    : item,
                ),
              }
            : current,
        );
        setSarvamConsent(false);
      }
    } catch (caught) {
      if ((caught as { name?: string }).name !== 'AbortError') {
        setError(caught instanceof Error ? caught.message : 'Preview generation failed.');
      }
    } finally {
      if (requestController.current === controller) requestController.current = null;
      setLoading(false);
    }
  };

  if (loadError) {
    return (
      <div role="alert" className="flex items-start gap-2 text-xs text-destructive">
        <CircleAlert className="mt-0.5 size-4 shrink-0" />
        <span>{loadError}</span>
      </div>
    );
  }
  if (!bootstrap || !provider) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Loading voice settings...
      </div>
    );
  }

  const canGenerate =
    provider.available &&
    Boolean(text.trim()) &&
    !loading &&
    (providerId !== 'bodhan' || Boolean(bodhanVoice)) &&
    (providerId !== 'sarvam' ||
      provider.externalVoiceReady ||
      (!provider.requiresExternalConsent ? true : sarvamConsent));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <label className="min-w-40 flex-1 space-y-1 text-xs font-medium">
          Language
          <select
            value={language}
            onChange={(event) => setLanguage(event.target.value as VoiceComparisonLanguageCode)}
            className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm"
          >
            {bootstrap.languages
              .filter((item) => provider.supportedLanguages.includes(item.code))
              .map((item) => (
                <option key={item.code} value={item.code}>
                  {item.label}
                </option>
              ))}
          </select>
        </label>
        {providerId === 'bodhan' && (
          <>
            <label className="min-w-40 flex-1 space-y-1 text-xs font-medium">
              Preset voice
              <select
                value={bodhanVoice}
                onChange={(event) => setBodhanVoice(event.target.value)}
                className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm"
              >
                {bootstrap.bodhanVoices.map((voice) => (
                  <option key={voice.id} value={voice.id}>
                    {voice.name} ({voice.recordedLanguageLabel})
                  </option>
                ))}
              </select>
            </label>
            <label className="min-w-40 flex-1 space-y-1 text-xs font-medium">
              Speaking style
              <select
                value={bodhanStyle}
                onChange={(event) => setBodhanStyle(event.target.value)}
                className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm"
              >
                {bootstrap.bodhanStyles.map((style) => (
                  <option key={style} value={style}>
                    {style}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
      </div>

      {!provider.available && (
        <p className="text-xs text-muted-foreground">
          {provider.unavailableReason || 'Unavailable'}
        </p>
      )}

      {providerId === 'sarvam' && provider.externalVoiceReady && (
        <p className="text-xs text-muted-foreground">
          Existing cloned voice ready
          {provider.sarvamReferenceProvenance === 'original-upload'
            ? ' · Raw-reference clone'
            : ' · Legacy processed-reference clone'}
        </p>
      )}

      {providerId === 'sarvam' && provider.requiresExternalConsent && (
        <label className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
          <Checkbox
            checked={sarvamConsent}
            onCheckedChange={(checked) => setSarvamConsent(checked === true)}
            aria-label="Consent to Sarvam AI voice processing"
            className="mt-0.5"
          />
          <span>
            I agree to send my retained original recording to Sarvam AI to create a reusable clone.
            This can use voice quota and may incur provider charges.
          </span>
        </label>
      )}

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          disabled={!canGenerate}
          onClick={() => generate(provider, { bypassCache: Boolean(result) })}
        >
          {loading ? (
            <Loader2 className="size-4 animate-spin" />
          ) : result ? (
            <RotateCcw className="size-4" />
          ) : (
            <Play className="size-4" />
          )}
          {result ? 'Regenerate Preview' : 'Generate Preview'}
        </Button>
        {providerId === 'sarvam' && provider.sarvamCanCreateRawClone && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!sarvamConsent || loading || !text.trim()}
            onClick={() => generate(provider, { bypassCache: true, createRawVoice: true })}
          >
            Create New Raw Clone
          </Button>
        )}
      </div>

      {providerId === 'sarvam' && provider.sarvamCanCreateRawClone && (
        <label className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
          <Checkbox
            checked={sarvamConsent}
            onCheckedChange={(checked) => setSarvamConsent(checked === true)}
            aria-label="Consent to create a new raw-reference Sarvam clone"
            className="mt-0.5"
          />
          <span>
            Create a separate clone from the retained original recording. The existing clone stays
            unchanged; this can use quota and may incur provider charges.
          </span>
        </label>
      )}

      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}

      {result && (
        <div className="border-t border-border/70 pt-3">
          {stale && (
            <p className="mb-2 text-xs text-amber-700 dark:text-amber-300">
              This saved preview uses different text or settings. Regenerate when you are ready.
            </p>
          )}
          <audio
            controls
            className="w-full"
            aria-label={`${result.providerName} voice preview`}
            src={`data:audio/${result.audio.format};base64,${result.audio.base64}`}
          />
          <details className="mt-2 text-[11px] text-muted-foreground">
            <summary className="cursor-pointer">Preview details</summary>
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
              <span>{result.language.toUpperCase()}</span>
              <span>{result.durationSeconds.toFixed(1)}s audio</span>
              <span className="inline-flex items-center gap-1">
                <Clock3 className="size-3" />
                {(result.generationLatencyMs / 1000).toFixed(1)}s generation
              </span>
              {result.cached && <span>Saved preview</span>}
              {result.processingMode === 'raw-provider-output' && (
                <span>No Sahaya audio processing</span>
              )}
              {result.processingMode === 'model-native-output' && (
                <>
                  <span>Ming model preprocessing · No Sahaya output enhancement</span>
                  <span>
                    {result.referenceProvenance === 'original-upload'
                      ? 'Retained original reference'
                      : 'Prepared enrollment reference'}
                  </span>
                </>
              )}
            </div>
          </details>
        </div>
      )}
    </div>
  );
}
