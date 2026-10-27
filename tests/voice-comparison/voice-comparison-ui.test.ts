// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VoiceComparisonPanel } from '@/components/voice-cloning/voice-comparison-panel';
import type { PublicVoiceProfile } from '@/lib/voice-cloning/types';
import type { VoiceComparisonBootstrap } from '@/lib/voice-comparison/types';

const roots: Root[] = [];
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const profile: PublicVoiceProfile = {
  id: 'vcp_existing',
  displayName: 'Teaching Voice',
  provider: 'chatterbox',
  language: 'en',
  languageId: 'en',
  status: 'ready',
  activeEngine: 'chatterbox',
  createdAt: '2026-10-26T00:00:00.000Z',
  updatedAt: '2026-10-26T00:00:00.000Z',
  consentTimestamp: '2026-10-26T00:00:00.000Z',
  consentVersion: 'faculty-self-voice-v1',
  profileVersion: 1,
};

const bootstrap: VoiceComparisonBootstrap = {
  savedPreviews: [],
  languages: [
    { code: 'en', label: 'English' },
    { code: 'hi', label: 'Hindi' },
  ],
  bodhanVoices: [
    { id: 'Kavya', name: 'Kavya', recordedLanguage: 'hi', recordedLanguageLabel: 'Hindi' },
  ],
  bodhanStyles: ['educational lecture'],
  providers: [
    {
      id: 'chatterbox',
      name: 'Chatterbox V3',
      category: 'voice-cloning',
      voiceType: 'cloned',
      supportedLanguages: ['en', 'hi'],
      supportsCloning: true,
      supportsPresetVoices: false,
      supportsEnhancement: true,
      supportsClassroom: true,
      supportsPreview: true,
      experimental: false,
      configured: true,
      available: true,
    },
    {
      id: 'sarvam',
      name: 'Sarvam AI',
      category: 'voice-cloning',
      voiceType: 'cloned',
      supportedLanguages: ['en', 'hi'],
      supportsCloning: true,
      supportsPresetVoices: false,
      supportsEnhancement: false,
      supportsClassroom: false,
      supportsPreview: true,
      experimental: true,
      configured: true,
      available: true,
      requiresExternalConsent: true,
      externalVoiceReady: false,
    },
    {
      id: 'bodhan',
      name: 'Bodhan Indic-Speak',
      category: 'preset-voices',
      voiceType: 'preset',
      supportedLanguages: ['en', 'hi'],
      supportsCloning: false,
      supportsPresetVoices: true,
      supportsEnhancement: false,
      supportsClassroom: false,
      supportsPreview: true,
      experimental: true,
      configured: false,
      available: false,
      unavailableReason: 'Not configured',
    },
  ],
};

async function flush() {
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe('voice comparison UI', () => {
  it('renders only the selected external engine without synthesis on mount', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, comparison: bootstrap }), {
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    roots.push(root);
    act(() =>
      root.render(
        createElement(VoiceComparisonPanel, {
          profile,
          providerId: 'sarvam',
          text: "Newton's first law.",
        }),
      ),
    );
    await flush();

    expect(host.textContent).toContain('create a reusable clone');
    expect(host.textContent).not.toContain('Compare Voices');
    expect(host.textContent).not.toContain('Bodhan Indic-Speak');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]).not.toMatchObject({ method: 'POST' });
  });

  it('shows an actionable Bodhan provider error without falling back to another engine', async () => {
    const available = {
      ...bootstrap,
      providers: bootstrap.providers.map((provider) =>
        provider.id === 'bodhan'
          ? { ...provider, configured: true, available: true, unavailableReason: undefined }
          : provider,
      ),
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true, comparison: available }), {
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: false,
            errorCode: 'BODHAN_PERMISSION_ERROR',
            error: 'Your Bodhan API key does not have access to this model.',
          }),
          { status: 403, headers: { 'content-type': 'application/json' } },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    roots.push(root);
    act(() =>
      root.render(
        createElement(VoiceComparisonPanel, {
          profile,
          providerId: 'bodhan',
          text: "Newton's first law.",
        }),
      ),
    );
    await flush();

    const button = Array.from(host.querySelectorAll('button')).find((candidate) =>
      candidate.textContent?.includes('Generate Preview'),
    );
    expect(button).not.toBeNull();
    act(() => button!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await flush();

    expect(host.textContent).toContain('does not have access to this model');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({
      providerId: 'bodhan',
      bypassCache: false,
    });
  });

  it('restores a saved Sarvam preview and regenerates with the existing clone and cache bypass', async () => {
    const saved = {
      profileId: profile.id,
      providerId: 'sarvam' as const,
      providerName: 'Sarvam AI',
      voiceType: 'cloned' as const,
      language: 'en' as const,
      audio: { format: 'wav', base64: 'c2F2ZWQ=', createdAt: '2026-10-26T00:00:00.000Z' },
      durationSeconds: 1,
      generationLatencyMs: 100,
      generatedAt: '2026-10-26T00:00:00.000Z',
      cached: true,
      cacheKey: 'saved-key',
      processingMode: 'raw-provider-output' as const,
      outputCodec: 'wav',
      chunked: false,
      request: { text: "Newton's first law.", language: 'en' as const },
    };
    const available = {
      ...bootstrap,
      savedPreviews: [saved],
      providers: bootstrap.providers.map((provider) =>
        provider.id === 'sarvam'
          ? {
              ...provider,
              requiresExternalConsent: false,
              externalVoiceReady: true,
              sarvamReferenceProvenance: 'processed-reference' as const,
            }
          : provider,
      ),
    };
    const fresh = { ...saved, audio: { ...saved.audio, base64: 'ZnJlc2g=' }, cached: false };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true, comparison: available }), {
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true, preview: fresh }), {
          headers: { 'content-type': 'application/json' },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    roots.push(root);
    act(() =>
      root.render(
        createElement(VoiceComparisonPanel, {
          profile,
          providerId: 'sarvam',
          text: "Newton's first law.",
        }),
      ),
    );
    await flush();

    expect(host.querySelector('audio')?.getAttribute('src')).toContain('c2F2ZWQ=');
    const regenerate = Array.from(host.querySelectorAll('button')).find((candidate) =>
      candidate.textContent?.includes('Regenerate Preview'),
    );
    expect(regenerate).not.toBeNull();
    expect(regenerate?.hasAttribute('disabled')).toBe(false);
    act(() => regenerate!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await flush();

    const request = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(request).toMatchObject({
      providerId: 'sarvam',
      bypassCache: true,
      text: "Newton's first law.",
    });
    expect(request).not.toHaveProperty('sarvamCreateRawVoice');
    expect(request).not.toHaveProperty('sarvamExternalConsent');
    expect(host.querySelector('audio')?.getAttribute('src')).toContain('ZnJlc2g=');
  });

  it('keeps the saved Sarvam audio playable when regeneration fails', async () => {
    const saved = {
      profileId: profile.id,
      providerId: 'sarvam' as const,
      providerName: 'Sarvam AI',
      voiceType: 'cloned' as const,
      language: 'en' as const,
      audio: { format: 'wav', base64: 'cHJldmlvdXM=', createdAt: '2026-10-26T00:00:00.000Z' },
      durationSeconds: 1,
      generationLatencyMs: 100,
      generatedAt: '2026-10-26T00:00:00.000Z',
      cached: true,
      cacheKey: 'saved-key',
      processingMode: 'raw-provider-output' as const,
      outputCodec: 'wav',
      chunked: false,
      request: { text: "Newton's first law.", language: 'en' as const },
    };
    const available = {
      ...bootstrap,
      savedPreviews: [saved],
      providers: bootstrap.providers.map((provider) =>
        provider.id === 'sarvam'
          ? {
              ...provider,
              requiresExternalConsent: false,
              externalVoiceReady: true,
              sarvamReferenceProvenance: 'processed-reference' as const,
            }
          : provider,
      ),
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true, comparison: available }), {
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'Sarvam AI is temporarily unavailable.' }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    roots.push(root);
    act(() =>
      root.render(
        createElement(VoiceComparisonPanel, {
          profile,
          providerId: 'sarvam',
          text: "Newton's first law.",
        }),
      ),
    );
    await flush();

    const regenerate = Array.from(host.querySelectorAll('button')).find((candidate) =>
      candidate.textContent?.includes('Regenerate Preview'),
    );
    act(() => regenerate!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await flush();

    expect(host.textContent).toContain('temporarily unavailable');
    expect(host.querySelector('audio')?.getAttribute('src')).toContain('cHJldmlvdXM=');
  });

  it('generates and regenerates only the selected Ming preview with exact text', async () => {
    const mingProvider = {
      id: 'ming3-tts' as const,
      name: 'Ming 3.0 TTS 0.5B',
      category: 'voice-cloning' as const,
      voiceType: 'cloned' as const,
      supportedLanguages: ['en' as const],
      supportsCloning: true,
      supportsPresetVoices: false,
      supportsEnhancement: false,
      supportsClassroom: false,
      supportsPreview: true,
      experimental: true,
      configured: true,
      available: true,
    };
    const comparison = { ...bootstrap, providers: [...bootstrap.providers, mingProvider] };
    const text = " Newton's first law. ";
    const preview = {
      profileId: profile.id,
      providerId: 'ming3-tts' as const,
      providerName: mingProvider.name,
      voiceType: 'cloned' as const,
      language: 'en' as const,
      audio: { format: 'wav', base64: 'bWluZw==', createdAt: '2026-10-27T00:00:00.000Z' },
      durationSeconds: 1,
      generationLatencyMs: 120,
      generatedAt: '2026-10-27T00:00:00.000Z',
      cached: false,
      cacheKey: 'ming-key',
      processingMode: 'model-native-output' as const,
      outputCodec: 'wav',
      referenceProvenance: 'processed-reference' as const,
      referenceTransformation: 'official-runtime-mono-resample-and-front-pad',
      chunked: false,
      request: { text, language: 'en' as const },
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true, comparison }), {
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValue(
        new Response(JSON.stringify({ success: true, preview }), {
          headers: { 'content-type': 'application/json' },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    roots.push(root);
    act(() =>
      root.render(createElement(VoiceComparisonPanel, { profile, providerId: 'ming3-tts', text })),
    );
    await flush();

    const generate = Array.from(host.querySelectorAll('button')).find((candidate) =>
      candidate.textContent?.includes('Generate Preview'),
    );
    act(() => generate!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await flush();
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({
      providerId: 'ming3-tts',
      text,
      bypassCache: false,
    });
    expect(host.textContent).toContain('Ming model preprocessing');

    const regenerate = Array.from(host.querySelectorAll('button')).find((candidate) =>
      candidate.textContent?.includes('Regenerate Preview'),
    );
    act(() => regenerate!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await flush();
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toMatchObject({
      providerId: 'ming3-tts',
      text,
      bypassCache: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
