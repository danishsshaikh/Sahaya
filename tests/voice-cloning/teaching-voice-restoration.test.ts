// @vitest-environment jsdom

import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TeachingVoiceCard } from '@/components/voice-cloning/teaching-voice-card';

const roots: Root[] = [];
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function readyEnglishProfileResponse(
  activeEngine: 'chatterbox' | 'qwen3-tts' = 'chatterbox',
): Response {
  const original = { format: 'wav', base64: 'cXdlbi1vcmlnaW5hbA==', createdAt: 'now' };
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
        activeEngine,
        qwenEnhancementMode: 'standard',
        ...(activeEngine === 'qwen3-tts'
          ? {
              qwenPreview: {
                previewModel: 'qwen3-tts-1.7b-base',
                qwenCloneMode: 'speaker-embedding',
                enhancementMode: 'standard',
                preview: original,
                comparison: { original },
              },
            }
          : {}),
        createdAt: '2026-10-16T07:00:00.000Z',
        updatedAt: '2026-10-16T07:10:00.000Z',
        consentTimestamp: '2026-10-16T07:00:00.000Z',
        consentVersion: '1',
        profileVersion: 1,
      },
      previewModels: ['chatterbox-v3', 'qwen3-tts-1.7b-base'],
      qwenClassroomEnabled: true,
      qwenClassroomEnhancementAvailable: false,
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

  it('restores the active Qwen engine and cached preview after refresh', async () => {
    vi.mocked(fetch).mockImplementation(async () => readyEnglishProfileResponse('qwen3-tts'));

    const firstRender = await mountTeachingVoiceCard();
    expect(firstRender.textContent).toContain('Teaching Voice selected: Qwen3-TTS 1.7B');
    const manage = [...firstRender.querySelectorAll('button')].find(
      (candidate) => candidate.textContent?.trim() === 'Manage Voice',
    );
    if (!(manage instanceof HTMLButtonElement)) throw new Error('Manage Voice button not found');
    act(() => manage.click());
    const customize = [...firstRender.querySelectorAll('button')].find(
      (candidate) => candidate.textContent?.trim() === 'Customize Voice',
    );
    if (!(customize instanceof HTMLButtonElement))
      throw new Error('Customize Voice button not found');
    act(() => customize.click());

    const qwen = [...firstRender.querySelectorAll('button')].find(
      (candidate) => candidate.textContent?.trim() === 'Qwen3-TTS 1.7B',
    );
    expect(qwen?.getAttribute('aria-pressed')).toBe('true');
    expect(firstRender.querySelector('[aria-label="Original Qwen3-TTS preview"]')).not.toBeNull();

    act(() => roots.shift()?.unmount());
    firstRender.remove();
    const refreshedRender = await mountTeachingVoiceCard();
    expect(refreshedRender.textContent).toContain('Teaching Voice selected: Qwen3-TTS 1.7B');
  });
});
