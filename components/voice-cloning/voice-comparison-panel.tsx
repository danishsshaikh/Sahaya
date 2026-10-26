'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Beaker, CircleAlert, Clock3, Loader2, Play, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Textarea } from '@/components/ui/textarea';
import type { PublicVoiceProfile } from '@/lib/voice-cloning/types';
import type {
  VoiceComparisonBootstrap,
  VoiceComparisonLanguageCode,
  VoiceComparisonPreviewResult,
  VoiceComparisonProviderAvailability,
  VoiceComparisonProviderId,
} from '@/lib/voice-comparison/types';

const DEFAULT_TEXT: Partial<Record<VoiceComparisonLanguageCode, string>> = {
  en: "Newton's first law states that an object remains at rest unless acted upon by an external force.",
  hi: 'न्यूटन का पहला नियम बताता है कि कोई वस्तु अपनी अवस्था में बनी रहती है जब तक उस पर बाहरी बल न लगाया जाए।',
  mr: 'न्यूटनच्या पहिल्या नियमानुसार, बाह्य बल लागू होत नाही तोपर्यंत वस्तू आपली अवस्था कायम ठेवते.',
};

type ResultState = {
  result: VoiceComparisonPreviewResult;
  signature: string;
};

type RatingName =
  | 'Naturalness'
  | 'Pronunciation'
  | 'Speaker similarity'
  | 'Expressiveness'
  | 'Classroom suitability';

interface VoiceComparisonPanelProps {
  profile: PublicVoiceProfile;
}

function responseError(body: unknown, fallback: string): string {
  if (body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string') {
    return (body as { error: string }).error;
  }
  return fallback;
}

function providerSignature(input: {
  providerId: VoiceComparisonProviderId;
  text: string;
  language: VoiceComparisonLanguageCode;
  voice: string;
  style: string;
}): string {
  return JSON.stringify(input);
}

function ResultRatings({ cloned }: { cloned: boolean }) {
  const ratings: RatingName[] = [
    'Naturalness',
    'Pronunciation',
    ...(cloned ? (['Speaker similarity'] as const) : []),
    'Expressiveness',
    'Classroom suitability',
  ];
  return (
    <details className="mt-3 border-t border-border/60 pt-2 text-xs">
      <summary className="cursor-pointer text-muted-foreground">
        Subjective listening ratings
      </summary>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        {ratings.map((rating) => (
          <label key={rating} className="flex items-center justify-between gap-2">
            <span>{rating}</span>
            <select
              aria-label={`${rating} rating`}
              defaultValue=""
              className="h-8 rounded-md border border-border bg-background px-2"
            >
              <option value="">-</option>
              {[1, 2, 3, 4, 5].map((score) => (
                <option key={score} value={score}>
                  {score}/5
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
    </details>
  );
}

export function VoiceComparisonPanel({ profile }: VoiceComparisonPanelProps) {
  const [bootstrap, setBootstrap] = useState<VoiceComparisonBootstrap | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [language, setLanguage] = useState<VoiceComparisonLanguageCode>(
    (['en', 'hi', 'mr'].includes(profile.language)
      ? profile.language
      : 'en') as VoiceComparisonLanguageCode,
  );
  const [text, setText] = useState(DEFAULT_TEXT[language] || '');
  const [bodhanVoice, setBodhanVoice] = useState('');
  const [bodhanStyle, setBodhanStyle] = useState('educational lecture');
  const [sarvamConsent, setSarvamConsent] = useState(false);
  const [sarvamCreateRawVoice, setSarvamCreateRawVoice] = useState(false);
  const [loading, setLoading] = useState<Partial<Record<VoiceComparisonProviderId, boolean>>>({});
  const [errors, setErrors] = useState<Partial<Record<VoiceComparisonProviderId, string>>>({});
  const [results, setResults] = useState<Partial<Record<VoiceComparisonProviderId, ResultState>>>(
    {},
  );
  const requestControllers = useRef(new Map<VoiceComparisonProviderId, AbortController>());

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
          throw new Error(responseError(body, 'Voice comparison is unavailable.'));
        }
        setBootstrap(body.comparison);
        setBodhanVoice((current) => current || body.comparison!.bodhanVoices[0]?.id || '');
      })
      .catch((error: unknown) => {
        if ((error as { name?: string }).name !== 'AbortError') {
          setLoadError(error instanceof Error ? error.message : 'Voice comparison is unavailable.');
        }
      });
    return () => controller.abort();
  }, [profile.id]);

  useEffect(() => {
    const matchingVoice = bootstrap?.bodhanVoices.find(
      (voice) => voice.recordedLanguage === language,
    );
    if (matchingVoice) setBodhanVoice(matchingVoice.id);
  }, [bootstrap, language]);

  useEffect(
    () => () => {
      for (const controller of requestControllers.current.values()) controller.abort();
      requestControllers.current.clear();
    },
    [],
  );

  const supportedProviders = useMemo(
    () =>
      bootstrap?.providers.filter((provider) => provider.supportedLanguages.includes(language)) ||
      [],
    [bootstrap, language],
  );
  const providerGroups = [
    {
      category: 'voice-cloning' as const,
      title: 'Voice cloning',
      providers: supportedProviders.filter((provider) => provider.category === 'voice-cloning'),
    },
    {
      category: 'preset-voices' as const,
      title: 'Preset voices',
      providers: supportedProviders.filter((provider) => provider.category === 'preset-voices'),
    },
  ];

  const signatureFor = (providerId: VoiceComparisonProviderId) =>
    providerSignature({
      providerId,
      text: providerId === 'sarvam' ? text : text.trim(),
      language,
      voice: bodhanVoice,
      style: bodhanStyle,
    });

  const generate = async (provider: VoiceComparisonProviderAvailability) => {
    if (!text.trim() || loading[provider.id]) return;
    requestControllers.current.get(provider.id)?.abort();
    const controller = new AbortController();
    requestControllers.current.set(provider.id, controller);
    setLoading((current) => ({ ...current, [provider.id]: true }));
    setErrors((current) => ({ ...current, [provider.id]: undefined }));
    try {
      const response = await fetch('/api/voice-cloning/comparison', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          profileId: profile.id,
          providerId: provider.id,
          text: provider.id === 'sarvam' ? text : text.trim(),
          language,
          ...(provider.id === 'bodhan' ? { voice: bodhanVoice, style: bodhanStyle } : {}),
          ...(provider.id === 'sarvam' && provider.requiresExternalConsent
            ? { sarvamExternalConsent: sarvamConsent }
            : {}),
          ...(provider.id === 'sarvam' && sarvamCreateRawVoice
            ? { sarvamExternalConsent: sarvamConsent, sarvamCreateRawVoice: true }
            : {}),
        }),
      });
      const body = (await response.json().catch(() => null)) as {
        preview?: VoiceComparisonPreviewResult;
      } | null;
      if (!response.ok || !body?.preview) {
        throw new Error(responseError(body, `${provider.name} could not generate a preview.`));
      }
      setResults((current) => ({
        ...current,
        [provider.id]: { result: body.preview!, signature: signatureFor(provider.id) },
      }));
      if (provider.id === 'sarvam' && (provider.requiresExternalConsent || sarvamCreateRawVoice)) {
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
        setSarvamCreateRawVoice(false);
        setSarvamConsent(false);
      }
    } catch (error) {
      if ((error as { name?: string }).name !== 'AbortError') {
        setErrors((current) => ({
          ...current,
          [provider.id]: error instanceof Error ? error.message : 'Preview generation failed.',
        }));
      }
    } finally {
      requestControllers.current.delete(provider.id);
      setLoading((current) => ({ ...current, [provider.id]: false }));
    }
  };

  return (
    <details className="border-t border-border/70 pt-3">
      <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-semibold text-foreground">
        <Beaker className="size-4 text-primary" />
        Compare Voices
        <span className="ml-auto text-xs font-normal text-muted-foreground">Preview only</span>
      </summary>
      <div className="mt-3 space-y-4">
        <p className="text-xs leading-relaxed text-muted-foreground">
          Compare the same passage without changing your active classroom voice.
        </p>
        {loadError ? (
          <div role="alert" className="flex items-start gap-2 text-xs text-destructive">
            <CircleAlert className="mt-0.5 size-4 shrink-0" />
            <span>{loadError}</span>
          </div>
        ) : !bootstrap ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading voice providers...
          </div>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_11rem]">
              <label className="space-y-1 text-xs font-medium">
                Comparison text
                <Textarea
                  value={text}
                  maxLength={3000}
                  onChange={(event) => setText(event.target.value)}
                  className="mt-1 min-h-24 resize-y font-normal"
                />
                <span className="block text-right font-normal tabular-nums text-muted-foreground">
                  {text.length}/3000
                </span>
              </label>
              <label className="space-y-1 text-xs font-medium">
                Language
                <select
                  value={language}
                  onChange={(event) => {
                    const next = event.target.value as VoiceComparisonLanguageCode;
                    setLanguage(next);
                  }}
                  className="mt-1 h-10 w-full rounded-md border border-border bg-background px-3 text-sm"
                >
                  {bootstrap.languages.map((item) => (
                    <option key={item.code} value={item.code}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            {providerGroups.map((group) =>
              group.providers.length ? (
                <section key={group.category} aria-labelledby={`voice-provider-${group.category}`}>
                  <h4
                    id={`voice-provider-${group.category}`}
                    className="mb-2 text-[11px] font-semibold uppercase text-muted-foreground"
                  >
                    {group.title}
                  </h4>
                  <div className="grid gap-3 lg:grid-cols-2">
                    {group.providers.map((provider) => {
                      const state = results[provider.id];
                      const stale = Boolean(state && state.signature !== signatureFor(provider.id));
                      const result = state?.result;
                      return (
                        <div key={provider.id} className="min-w-0 border border-border/70 p-3">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                                <span>{provider.name}</span>
                                {provider.experimental && (
                                  <span className="text-[10px] uppercase text-primary">
                                    Experimental
                                  </span>
                                )}
                              </div>
                              <p className="mt-0.5 text-xs text-muted-foreground">
                                {provider.voiceType === 'cloned' ? 'Cloned voice' : 'Preset voice'}
                                {provider.supportsClassroom
                                  ? profile.activeEngine === provider.id
                                    ? ' · Active in classroom'
                                    : ''
                                  : ' · Preview only'}
                              </p>
                            </div>
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              disabled={
                                !provider.available ||
                                !text.trim() ||
                                loading[provider.id] ||
                                (provider.id === 'bodhan' && !bodhanVoice) ||
                                (provider.id === 'sarvam' &&
                                  (provider.requiresExternalConsent || sarvamCreateRawVoice) &&
                                  !sarvamConsent)
                              }
                              onClick={() => generate(provider)}
                            >
                              {loading[provider.id] ? (
                                <Loader2 className="size-4 animate-spin" />
                              ) : result ? (
                                <RotateCcw className="size-4" />
                              ) : (
                                <Play className="size-4" />
                              )}
                              {result ? 'Regenerate' : 'Generate'}
                            </Button>
                          </div>

                          {!provider.available && (
                            <p className="mt-3 text-xs text-muted-foreground">
                              {provider.unavailableReason || 'Unavailable'}
                            </p>
                          )}

                          {provider.id === 'bodhan' && provider.available && (
                            <div className="mt-3 grid gap-2 sm:grid-cols-2">
                              <label className="space-y-1 text-xs">
                                Voice
                                <select
                                  value={bodhanVoice}
                                  onChange={(event) => setBodhanVoice(event.target.value)}
                                  className="h-9 w-full rounded-md border border-border bg-background px-2"
                                >
                                  {bootstrap.languages.map((item) => {
                                    const voices = bootstrap.bodhanVoices.filter(
                                      (voice) => voice.recordedLanguage === item.code,
                                    );
                                    return voices.length ? (
                                      <optgroup key={item.code} label={item.label}>
                                        {voices.map((voice) => (
                                          <option key={voice.id} value={voice.id}>
                                            {voice.name}
                                          </option>
                                        ))}
                                      </optgroup>
                                    ) : null;
                                  })}
                                </select>
                              </label>
                              <label className="space-y-1 text-xs">
                                Style
                                <select
                                  value={bodhanStyle}
                                  onChange={(event) => setBodhanStyle(event.target.value)}
                                  className="h-9 w-full rounded-md border border-border bg-background px-2"
                                >
                                  {bootstrap.bodhanStyles.map((style) => (
                                    <option key={style} value={style}>
                                      {style}
                                    </option>
                                  ))}
                                </select>
                              </label>
                            </div>
                          )}

                          {provider.id === 'sarvam' &&
                            provider.available &&
                            (provider.requiresExternalConsent || sarvamCreateRawVoice) && (
                              <label className="mt-3 flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
                                <Checkbox
                                  checked={sarvamConsent}
                                  onCheckedChange={(checked) => setSarvamConsent(checked === true)}
                                  aria-label="Consent to Sarvam AI voice processing"
                                  className="mt-0.5"
                                />
                                <span>
                                  I agree to send this recording to Sarvam AI, where a reusable
                                  cloned voice may be stored. This can consume a voice quota and may
                                  incur provider charges.
                                </span>
                              </label>
                            )}

                          {provider.id === 'sarvam' &&
                            provider.externalVoiceReady &&
                            provider.sarvamReferenceProvenance !== 'original-upload' && (
                              <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                                The existing Sarvam clone is preserved and reused, but its reference
                                came from Sahaya&apos;s processed WAV.
                              </p>
                            )}

                          {provider.id === 'sarvam' && provider.sarvamCanCreateRawClone && (
                            <label className="mt-3 flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
                              <Checkbox
                                checked={sarvamCreateRawVoice}
                                onCheckedChange={(checked) => {
                                  setSarvamCreateRawVoice(checked === true);
                                  if (checked !== true) setSarvamConsent(false);
                                }}
                                aria-label="Create a new raw-reference Sarvam clone"
                                className="mt-0.5"
                              />
                              <span>
                                Create a separate raw-reference clone. The existing clone will not
                                be overwritten or deleted; this may use quota and incur cost.
                              </span>
                            </label>
                          )}

                          {errors[provider.id] && (
                            <p role="alert" className="mt-3 text-xs text-destructive">
                              {errors[provider.id]}
                            </p>
                          )}

                          {result && (
                            <div className="mt-3 border-t border-border/60 pt-3">
                              {stale && (
                                <p className="mb-2 text-xs text-amber-700 dark:text-amber-300">
                                  Outdated preview. Regenerate to use the current comparison
                                  settings.
                                </p>
                              )}
                              <audio
                                controls
                                className="w-full"
                                aria-label={`${result.providerName} voice preview`}
                                src={`data:audio/${result.audio.format};base64,${result.audio.base64}`}
                              />
                              <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                                <span>{result.language.toUpperCase()}</span>
                                {result.voice && <span>{result.voice}</span>}
                                <span>{result.durationSeconds.toFixed(1)}s audio</span>
                                <span className="inline-flex items-center gap-1">
                                  <Clock3 className="size-3" />
                                  {(result.generationLatencyMs / 1000).toFixed(1)}s generation
                                </span>
                                {result.cached && <span>Cached</span>}
                                {result.processingMode === 'raw-provider-output' && (
                                  <span>No Sahaya audio processing</span>
                                )}
                              </div>
                              <ResultRatings cloned={result.voiceType === 'cloned'} />
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </section>
              ) : null,
            )}
          </>
        )}
      </div>
    </details>
  );
}
