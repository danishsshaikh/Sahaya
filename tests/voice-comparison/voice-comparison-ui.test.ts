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
  it('groups cloned and preset providers without making synthesis calls on render', async () => {
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
    act(() => root.render(createElement(VoiceComparisonPanel, { profile })));
    await flush();

    expect(host.textContent).toContain('Voice cloning');
    expect(host.textContent).toContain('Preset voices');
    expect(host.textContent).toContain('Sarvam AI');
    expect(host.textContent).toContain('Bodhan Indic-Speak');
    expect(host.textContent).toContain('Not configured');
    expect(host.textContent).toContain('reusable cloned voice may be stored');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]).not.toMatchObject({ method: 'POST' });
  });
});
