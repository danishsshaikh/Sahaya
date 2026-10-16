// @vitest-environment jsdom

import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TeachingVoiceCard } from '@/components/voice-cloning/teaching-voice-card';

const roots: Root[] = [];
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function readyEnglishProfileResponse(): Response {
  return new Response(
    JSON.stringify({
      success: true,
      profile: {
        id: 'vcp_existing_english',
        displayName: 'My Teaching Voice',
        provider: 'chatterbox',
        language: 'en',
        languageId: 'hi',
        status: 'ready',
        modelVariant: 'v3',
        enhancementMode: 'resemble-enhance',
        createdAt: '2026-10-16T07:00:00.000Z',
        updatedAt: '2026-10-16T07:10:00.000Z',
        consentTimestamp: '2026-10-16T07:00:00.000Z',
        consentVersion: '1',
        profileVersion: 1,
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function Harness() {
  const [selectedProfileId, setSelectedProfileId] = useState<string>();
  return createElement(TeachingVoiceCard, {
    selectedProfileId,
    onSelectedProfileIdChange: setSelectedProfileId,
  });
}

async function mountTeachingVoiceCard(): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(createElement(Harness)));
  await act(async () => {
    await new Promise((settle) => setTimeout(settle, 0));
  });
  return host;
}

beforeEach(() => {
  window.localStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => readyEnglishProfileResponse()),
  );
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

describe('Teaching Voice profile restoration', () => {
  it('restores a ready English Chatterbox profile after refresh', async () => {
    window.localStorage.setItem(
      'sahaya.teachingVoice.selection.v1.en',
      JSON.stringify({
        enabled: true,
        profileId: 'vcp_stale_english',
        enhancementMode: 'standard',
      }),
    );
    window.localStorage.setItem(
      'sahaya.teachingVoice.selection.v1.hi',
      JSON.stringify({ enabled: false }),
    );

    const firstRender = await mountTeachingVoiceCard();
    expect(firstRender.textContent).toContain('Using Voice');
    expect(firstRender.textContent).toContain('Manage Voice');
    expect(firstRender.textContent).not.toContain('Create Voice');

    const restoredSelection = JSON.parse(
      window.localStorage.getItem('sahaya.teachingVoice.selection.v1.en') || '{}',
    );
    expect(restoredSelection).toEqual({
      enabled: true,
      profileId: 'vcp_existing_english',
      enhancementMode: 'resemble-enhance',
    });
    expect(
      JSON.parse(window.localStorage.getItem('sahaya.teachingVoice.selection.v1.hi') || '{}'),
    ).toEqual({ enabled: false });

    act(() => roots.shift()?.unmount());
    firstRender.remove();

    const refreshedRender = await mountTeachingVoiceCard();
    expect(refreshedRender.textContent).toContain('Using Voice');
    expect(refreshedRender.textContent).toContain('Manage Voice');
    expect(fetch).toHaveBeenCalledWith('/api/voice-cloning/profile?language=en');
  });
});
