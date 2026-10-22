// @vitest-environment jsdom

import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TeachingVoiceCard } from '@/components/voice-cloning/teaching-voice-card';
import {
  RECOMMENDED_VOICE_GENERATION_SETTINGS,
  VOICE_SETTINGS_PRESETS,
  type PublicVoiceProfile,
  type VoiceModelPreviewResult,
} from '@/lib/voice-cloning/types';

const PROFILE_ID = 'vcp_existing_english';
const roots: Root[] = [];
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const savedProfile = {
  id: PROFILE_ID,
  displayName: 'My Teaching Voice',
  provider: 'chatterbox',
  language: 'en',
  languageId: 'en',
  status: 'ready',
  modelVariant: 'v3',
  generationSettings: RECOMMENDED_VOICE_GENERATION_SETTINGS,
  enhancementMode: 'standard',
  activeEngine: 'chatterbox',
  qwenEnhancementMode: 'standard',
  createdAt: '2026-10-16T07:00:00.000Z',
  updatedAt: '2026-10-16T07:10:00.000Z',
  consentTimestamp: '2026-10-16T07:00:00.000Z',
  consentVersion: '1',
  profileVersion: 1,
  previewTextLanguageId: 'en',
  preview: { format: 'wav', base64: 'b2xk', createdAt: '2026-10-16T07:10:00.000Z' },
  previewComparison: {
    original: { format: 'wav', base64: 'b2xk', createdAt: '2026-10-16T07:10:00.000Z' },
    enhancementError: 'Enhanced preview is disabled for this language or deployment.',
  },
} as const;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function generatedProfile() {
  const original = { format: 'wav', base64: 'b3JpZ2luYWw=', createdAt: '2026-10-19T07:00:00.000Z' };
  const enhanced = { format: 'wav', base64: 'ZW5oYW5jZWQ=', createdAt: '2026-10-19T07:00:01.000Z' };
  return {
    ...savedProfile,
    draftPreview: {
      config: {
        modelVariant: 'v3',
        languageId: 'hi',
        previewTextLanguageId: 'en',
        generationSettings: VOICE_SETTINGS_PRESETS.expressive,
        enhancementMode: 'resemble-enhance',
      },
      preview: enhanced,
      comparison: { original, enhanced },
    },
  };
}

function Harness() {
  const [selectedProfileId, setSelectedProfileId] = useState<string>();
  return createElement(TeachingVoiceCard, {
    selectedProfileId,
    onSelectedProfileIdChange: setSelectedProfileId,
  });
}

async function flush() {
  await act(async () => {
    await new Promise((settle) => setTimeout(settle, 0));
  });
}

async function mountTeachingVoiceCard(): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(createElement(Harness)));
  await flush();
  return host;
}

function button(host: HTMLElement, label: string): HTMLButtonElement {
  const match = [...host.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!(match instanceof HTMLButtonElement)) throw new Error(`Button not found: ${label}`);
  return match;
}

function click(target: HTMLElement) {
  act(() => target.dispatchEvent(new MouseEvent('click', { bubbles: true })));
}

function changeSelect(select: HTMLSelectElement, value: string) {
  act(() => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

async function openCustomization(host: HTMLElement) {
  click(button(host, 'Manage Voice'));
  click(button(host, 'Customize Voice'));
  await flush();
}

beforeEach(() => {
  window.localStorage.clear();
  window.localStorage.setItem(
    'sahaya.teachingVoice.selection.v1.en',
    JSON.stringify({ enabled: true, profileId: PROFILE_ID, enhancementMode: 'standard' }),
  );
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

describe('Teaching Voice customization previews', () => {
  it('regenerates an enhanced V3 preview without changing the saved voice', async () => {
    let resolvePreview!: (response: Response) => void;
    const previewResponse = new Promise<Response>((resolve) => {
      resolvePreview = resolve;
    });
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PATCH') return previewResponse;
      return Promise.resolve(jsonResponse({ success: true, profile: savedProfile }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const host = await mountTeachingVoiceCard();
    expect(host.textContent).toContain('Using Voice');
    await openCustomization(host);
    expect(button(host, 'Preview Changes').disabled).toBe(false);

    const accent = host.querySelector('#voice-language-id');
    if (!(accent instanceof HTMLSelectElement)) throw new Error('Accent selector not found');
    changeSelect(accent, 'hi');
    click(button(host, 'Expressive'));
    expect(host.textContent).toContain('Preview required for the selected accent and style.');
    expect(host.querySelector('[aria-label="Original Chatterbox preview"]')).toBeNull();

    click(button(host, 'Enhanced'));
    click(button(host, 'Preview Changes'));
    expect(host.textContent).toContain('Generating your voice preview...');

    const previewRequest = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH');
    expect(previewRequest?.[0]).toBe('/api/voice-cloning/profile');
    expect(JSON.parse(String(previewRequest?.[1]?.body))).toMatchObject({
      profileId: PROFILE_ID,
      action: 'preview-model',
      modelVariant: 'v3',
      languageId: 'hi',
      previewTextLanguageId: 'en',
      generationSettings: VOICE_SETTINGS_PRESETS.expressive,
      enhancementMode: 'resemble-enhance',
    });

    resolvePreview(jsonResponse({ success: true, profile: generatedProfile() }));
    await flush();

    expect(host.querySelector('[aria-label="Original Chatterbox preview"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="Resemble Enhance preview"]')).not.toBeNull();
    expect(host.textContent).toContain('Use These Settings');
    expect(host.textContent).toContain('Using Voice');
    expect(host.textContent).not.toContain(
      'Enhanced preview is disabled for this language or deployment.',
    );
    expect(
      JSON.parse(window.localStorage.getItem('sahaya.teachingVoice.selection.v1.en') || '{}'),
    ).toEqual({ enabled: true, profileId: PROFILE_ID, enhancementMode: 'standard' });
  });

  it('keeps the active profile and prior preview when regeneration fails', async () => {
    const previouslySavedProfile = { ...savedProfile, modelVariant: 'v2' as const };
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        return Promise.resolve(
          jsonResponse({ error: 'GENERATION_FAILED', details: 'Preview service is busy.' }, 503),
        );
      }
      return Promise.resolve(jsonResponse({ success: true, profile: previouslySavedProfile }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const host = await mountTeachingVoiceCard();
    await openCustomization(host);
    const accent = host.querySelector('#voice-language-id');
    if (!(accent instanceof HTMLSelectElement)) throw new Error('Accent selector not found');
    changeSelect(accent, 'hi');
    click(button(host, 'Preview Changes'));
    await flush();

    expect(host.textContent).toContain(
      'Preview service is busy. Your saved Teaching Voice is unchanged. Try again.',
    );
    expect(host.textContent).toContain('Using Voice');
    expect(
      JSON.parse(window.localStorage.getItem('sahaya.teachingVoice.selection.v1.en') || '{}'),
    ).toEqual({ enabled: true, profileId: PROFILE_ID, enhancementMode: 'standard' });

    const restoredAccent = host.querySelector('#voice-language-id');
    if (!(restoredAccent instanceof HTMLSelectElement)) {
      throw new Error('Restored accent selector not found');
    }
    changeSelect(restoredAccent, 'en');
    expect(host.querySelector('[aria-label="Original Chatterbox preview"]')).not.toBeNull();
  });

  it('previews and explicitly activates Qwen without changing Chatterbox enrollment metadata', async () => {
    const original = { format: 'wav', base64: 'cXdlbi1vcmlnaW5hbA==', createdAt: 'now' };
    const enhanced = { format: 'wav', base64: 'cXdlbi1lbmhhbmNlZA==', createdAt: 'later' };
    const modelPreview: VoiceModelPreviewResult = {
      previewModel: 'qwen3-tts-1.7b-base',
      qwenCloneMode: 'speaker-embedding',
      enhancementMode: 'standard',
      preview: original,
      comparison: { original, enhanced },
    };
    let serverProfile: PublicVoiceProfile = { ...savedProfile };
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        const request = JSON.parse(String(init.body)) as { action: string };
        if (request.action === 'preview-model') {
          serverProfile = { ...serverProfile, qwenPreview: modelPreview };
        } else if (request.action === 'activate-engine') {
          serverProfile = {
            ...serverProfile,
            activeEngine: 'qwen3-tts',
            qwenEnhancementMode: 'resemble-enhance',
          };
        }
        return Promise.resolve(
          jsonResponse({
            success: true,
            profile: serverProfile,
            previewModels: ['chatterbox-v3', 'qwen3-tts-1.7b-base'],
            modelPreview: request.action === 'preview-model' ? modelPreview : undefined,
            qwenClassroomEnabled: true,
            qwenClassroomEnhancementAvailable: true,
          }),
        );
      }
      return Promise.resolve(
        jsonResponse({
          success: true,
          profile: { ...savedProfile, languageId: 'hi' },
          previewModels: ['chatterbox-v3', 'qwen3-tts-1.7b-base'],
          qwenClassroomEnabled: true,
          qwenClassroomEnhancementAvailable: true,
        }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const host = await mountTeachingVoiceCard();
    await openCustomization(host);
    click(button(host, 'Qwen3-TTS 1.7B'));

    expect(host.querySelector('#voice-language-id')).toBeNull();
    expect(host.textContent).toContain('Uses your saved recording with Qwen3-TTS');
    expect(host.textContent).not.toContain('Clone Method');
    expect(host.textContent).not.toContain('Full reference (ICL)');
    expect(host.querySelector('[aria-label="Original Chatterbox preview"]')).toBeNull();
    click(button(host, 'Preview Changes'));
    await flush();

    const previewRequest = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH');
    expect(JSON.parse(String(previewRequest?.[1]?.body))).toEqual({
      profileId: PROFILE_ID,
      action: 'preview-model',
      previewModel: 'qwen3-tts-1.7b-base',
      enhancementMode: 'standard',
    });
    expect(host.querySelector('[aria-label="Original Qwen3-TTS preview"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="Resemble Enhance preview"]')).not.toBeNull();
    expect(button(host, 'Original').getAttribute('aria-pressed')).toBe('true');
    click(button(host, 'Enhanced'));
    expect(button(host, 'Enhanced').getAttribute('aria-pressed')).toBe('true');
    click(button(host, 'Use Qwen3-TTS'));
    await flush();
    const previewRequests = fetchMock.mock.calls.filter(([, init]) => init?.method === 'PATCH');
    expect(JSON.parse(String(previewRequests.at(-1)?.[1]?.body))).toMatchObject({
      action: 'activate-engine',
      previewModel: 'qwen3-tts-1.7b-base',
      enhancementMode: 'resemble-enhance',
    });
    expect(host.textContent).toContain('Currently active: Qwen3-TTS 1.7B');
    expect(host.textContent).toContain('Teaching Voice selected: Qwen3-TTS 1.7B');
    expect(host.textContent).not.toContain('Use These Settings');
    expect(host.textContent).toContain('Using Voice');
    expect(
      JSON.parse(window.localStorage.getItem('sahaya.teachingVoice.selection.v1.en') || '{}'),
    ).toEqual({ enabled: true, profileId: PROFILE_ID, enhancementMode: 'standard' });
  });
});
