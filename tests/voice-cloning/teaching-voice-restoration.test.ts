// @vitest-environment jsdom

import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TeachingVoiceCard } from '@/components/voice-cloning/teaching-voice-card';
import type { PublicVoiceProfile } from '@/lib/voice-cloning/types';

const PROFILE_ID = 'vcp_enhanced_ready';
const roots: Root[] = [];
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const readyProfile: PublicVoiceProfile = {
  id: PROFILE_ID,
  displayName: 'My Teaching Voice',
  provider: 'chatterbox',
  language: 'en',
  languageId: 'en',
  status: 'ready',
  activeEngine: 'qwen3-tts',
  enhancementMode: 'standard',
  qwenEnhancementMode: 'resemble-enhance',
  qwenPreview: {
    previewModel: 'qwen3-tts-1.7b-base',
    qwenCloneMode: 'speaker-embedding',
    enhancementMode: 'resemble-enhance',
    preview: { format: 'wav', base64: 'b3JpZ2luYWw=', createdAt: '2026-10-29T00:00:00Z' },
    comparison: {
      original: { format: 'wav', base64: 'b3JpZ2luYWw=', createdAt: '2026-10-29T00:00:00Z' },
      enhanced: { format: 'wav', base64: 'ZW5oYW5jZA==', createdAt: '2026-10-29T00:00:01Z' },
    },
    previewText: 'Welcome to the course.',
  },
  createdAt: '2026-10-26T00:00:00Z',
  updatedAt: '2026-10-29T00:00:00Z',
  consentTimestamp: '2026-10-26T00:00:00Z',
  consentVersion: 'faculty-self-voice-v1',
  profileVersion: 1,
};

function response(): Response {
  return new Response(JSON.stringify({ success: true, profile: readyProfile }), {
    headers: { 'content-type': 'application/json' },
  });
}

function Harness() {
  const [selectedProfileId, setSelectedProfileId] = useState<string>();
  return createElement(TeachingVoiceCard, {
    selectedProfileId,
    onSelectedProfileIdChange: setSelectedProfileId,
  });
}

async function mount(): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(createElement(Harness));
    await new Promise((settle) => setTimeout(settle, 0));
  });
  await act(async () => new Promise((settle) => setTimeout(settle, 0)));
  return host;
}

beforeEach(() => {
  window.localStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => response()),
  );
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

describe('Teaching Voice restoration', () => {
  it('restores the enhanced ready voice and its playable sample after reload', async () => {
    const host = await mount();

    expect(fetch).toHaveBeenCalledWith('/api/voice-cloning/profile?language=en');
    expect(host.textContent).toContain('Voice ready');
    const audio = host.querySelector('[aria-label="Teaching Voice sample"]');
    expect(audio).not.toBeNull();
    expect(audio?.getAttribute('src')).toContain('data:audio/wav;base64,ZW5oYW5jZA==');
    expect(
      JSON.parse(window.localStorage.getItem('sahaya.teachingVoice.selection.v1.en') || '{}'),
    ).toMatchObject({
      enabled: true,
      profileId: PROFILE_ID,
      enhancementMode: 'resemble-enhance',
    });
  });

  it('does not silently re-enable a voice the faculty explicitly disabled', async () => {
    window.localStorage.setItem(
      'sahaya.teachingVoice.selection.v1.en',
      JSON.stringify({ enabled: false }),
    );
    const host = await mount();

    expect(host.textContent).toContain('Voice ready');
    const use = [...host.querySelectorAll('button')].find(
      (candidate) => candidate.textContent?.trim() === 'Use Voice',
    );
    expect(use).toBeDefined();
    expect(
      JSON.parse(window.localStorage.getItem('sahaya.teachingVoice.selection.v1.en') || '{}'),
    ).toMatchObject({ enabled: false });
  });
});
