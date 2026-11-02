// @vitest-environment jsdom

import { act, createElement, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => ({
  state: {
    stage: null as Record<string, unknown> | null,
    scenes: [] as Array<Record<string, unknown>>,
    readOnly: false,
    saveToStorage: vi.fn(async () => true),
  },
}));

vi.mock('@/lib/store/stage', () => {
  const useStageStore = Object.assign(
    (selector: (state: typeof store.state) => unknown) => selector(store.state),
    {
      getState: () => store.state,
      setState: (next: Partial<typeof store.state>) => Object.assign(store.state, next),
    },
  );
  return { useStageStore, markStagePersistenceDirty: vi.fn() };
});

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? createElement('div', null, children) : null,
  DialogContent: ({ children }: { children: ReactNode }) => createElement('div', null, children),
  DialogTitle: ({ children }: { children: ReactNode }) => createElement('h1', null, children),
  DialogClose: ({ children }: { children: ReactNode }) =>
    createElement('button', { type: 'button' }, children),
}));

vi.mock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) =>
    createElement('button', props, children),
}));

import { NarrationVoiceDialog } from '@/components/edit/NarrationVoiceDialog';
import {
  BODHAN_STYLES,
  BODHAN_VOICES,
  VOICE_COMPARISON_LANGUAGES,
  VOICE_COMPARISON_PROVIDERS,
} from '@/lib/voice-comparison/catalog';
import type { CourseNarrationState } from '@/lib/course-narration/types';
import type { VoiceComparisonLanguageCode } from '@/lib/voice-comparison/types';

const roots: Root[] = [];
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function providerBootstrap(
  language: VoiceComparisonLanguageCode,
  activeEngine?: 'chatterbox' | 'qwen3-tts' | 'indicf5',
  sarvamMode: 'saved-voice-id' | 'inline-reference' | 'missing' = 'saved-voice-id',
  sarvamConfigured = true,
) {
  const sarvamCompatible = sarvamMode !== 'missing';
  const currentProfile = {
    id: `current-${language}-profile`,
    displayName: 'Current Teaching Voice',
    provider: language === 'hi' ? 'indicf5' : 'chatterbox',
    language,
    status: 'ready',
    activeEngine: activeEngine ?? (language === 'hi' ? 'indicf5' : 'chatterbox'),
    createdAt: '2026-01-02T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    consentTimestamp: '2026-01-01T00:00:00.000Z',
    consentVersion: 'v1',
    profileVersion: 1,
    compatibleProviders:
      language === 'hi'
        ? sarvamCompatible
          ? (['indicf5', 'sarvam'] as const)
          : (['indicf5'] as const)
        : sarvamCompatible
          ? (['chatterbox', 'qwen3-tts', 'ming3-tts', 'sarvam'] as const)
          : (['chatterbox', 'qwen3-tts', 'ming3-tts'] as const),
    ...(sarvamMode === 'saved-voice-id'
      ? {
          sarvamVoice: {
            ready: true as const,
            consentTimestamp: '2026-01-01T00:00:00.000Z',
            createdAt: '2026-01-01T00:00:00.000Z',
            referenceProvenance: 'original-upload' as const,
          },
        }
      : {}),
  };
  const previousProfile = {
    ...currentProfile,
    id: `previous-${language}-profile`,
    displayName: 'Previous Teaching Voice',
    createdAt: '2025-12-01T00:00:00.000Z',
  };
  return {
    providers: VOICE_COMPARISON_PROVIDERS.map((provider) => ({
      ...provider,
      configured: provider.id === 'sarvam' ? sarvamConfigured : true,
      available: provider.id === 'sarvam' ? sarvamConfigured && sarvamCompatible : true,
      courseNarrationEnabled: true,
      ...(provider.id === 'sarvam'
        ? {
            sarvamNarrationMode: sarvamMode === 'missing' ? undefined : sarvamMode,
          }
        : {}),
      ...(provider.id === 'sarvam' && !sarvamConfigured
        ? { unavailableReason: 'Sarvam AI credentials are not configured on this server.' }
        : provider.id === 'sarvam' && !sarvamCompatible
          ? { unavailableReason: 'The selected Teaching Voice has no usable Sarvam reference.' }
          : {}),
    })),
    languages: VOICE_COMPARISON_LANGUAGES,
    bodhanVoices: BODHAN_VOICES,
    bodhanStyles: [...BODHAN_STYLES],
    savedPreviews: [],
    profile: currentProfile,
    profiles: [currentProfile, previousProfile],
  };
}

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function flush() {
  await act(async () => {
    await new Promise((settle) => setTimeout(settle, 0));
  });
}

async function mount(
  language: VoiceComparisonLanguageCode,
  narration?: CourseNarrationState,
  activeEngine?: 'chatterbox' | 'qwen3-tts' | 'indicf5',
  sarvamMode: 'saved-voice-id' | 'inline-reference' | 'missing' = 'saved-voice-id',
  sarvamConfigured = true,
) {
  store.state.stage = {
    id: 'browser-course-without-profile-pointer',
    name: 'Existing browser course',
    createdAt: 1,
    updatedAt: 2,
    lessonLanguage: language,
    ...(narration ? { narration } : {}),
  };
  store.state.scenes = [
    {
      id: 'scene-1',
      actions: [{ id: 'speech-1', type: 'speech', text: 'Exact existing narration.' }],
    },
  ];
  const bootstrap = providerBootstrap(language, activeEngine, sarvamMode, sarvamConfigured);
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'PUT') {
      const body = JSON.parse(String(init.body)) as {
        stage?: { teacherVoiceProfileId?: string };
      };
      const selected = bootstrap.profiles.find(
        (profile) => profile.id === body.stage?.teacherVoiceProfileId,
      );
      if (selected) bootstrap.profile = selected;
      return response({ success: true, synchronized: true });
    }
    if (init?.method === 'POST') {
      return response({
        success: true,
        preview: {
          profileId: `current-${language}-profile`,
          providerId: 'chatterbox',
          providerName: 'Chatterbox V3',
          voiceType: 'cloned',
          language,
          audio: { format: 'wav', base64: 'AA==' },
          durationSeconds: 1,
          generationLatencyMs: 1,
          generatedAt: '2026-01-01T00:00:00.000Z',
          cached: false,
          cacheKey: 'test-preview',
        },
      });
    }
    if (String(input).includes('?stageId=')) {
      return response({ success: true, narration: bootstrap, source: 'browser-registration' });
    }
    throw new Error(`Unexpected request: ${String(input)}`);
  });
  vi.stubGlobal('fetch', fetchMock);

  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  act(() =>
    root.render(
      createElement(NarrationVoiceDialog, {
        open: true,
        onOpenChange: vi.fn(),
        sceneId: 'scene-1',
      }),
    ),
  );
  await flush();
  await flush();
  return { host, fetchMock };
}

function engineButton(host: HTMLElement, name: string): HTMLButtonElement {
  const button = [...host.querySelectorAll('button')].find((candidate) =>
    candidate.textContent?.includes(name),
  );
  if (!button) throw new Error(`Missing engine control: ${name}`);
  return button;
}

beforeEach(() => {
  store.state.saveToStorage.mockClear();
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe('Narration Voice provider controls', () => {
  it('makes the actual English-capable saved-profile engines selectable and lists Bodhan presets', async () => {
    const { host, fetchMock } = await mount('en');

    for (const name of [
      'Chatterbox V3',
      'Qwen3-TTS (Enhanced)',
      'Qwen3-TTS (Original)',
      'Sarvam AI',
      'Ming 3.0 TTS 0.5B',
      'Bodhan Indic-Speak',
    ]) {
      expect(engineButton(host, name).disabled, name).toBe(false);
    }
    expect(engineButton(host, 'IndicF5').disabled).toBe(true);

    act(() => engineButton(host, 'Preview This Scene').click());
    await flush();
    await flush();
    const previewRequest = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(previewRequest).toBeDefined();
    expect(JSON.parse(String(previewRequest![1]?.body))).toMatchObject({
      profileId: 'current-en-profile',
      providerId: 'chatterbox',
      text: 'Exact existing narration.',
    });

    act(() => engineButton(host, 'Bodhan Indic-Speak').click());
    const presetSelect = [...host.querySelectorAll('select')].find((select) =>
      select.parentElement?.textContent?.includes('Preset voice'),
    );
    expect(presetSelect).toBeDefined();
    expect([...presetSelect!.options].map((option) => option.text)).toContain(
      'Prastuti (Assamese)',
    );
  });

  it('makes IndicF5 selectable for a compatible existing Hindi course', async () => {
    const { host } = await mount('hi');

    expect(engineButton(host, 'IndicF5').disabled).toBe(false);
    expect(engineButton(host, 'Chatterbox V3').disabled).toBe(true);
    expect(engineButton(host, 'Sarvam AI').disabled).toBe(false);
    expect(engineButton(host, 'Qwen3-TTS (Enhanced)').disabled).toBe(true);
    expect(engineButton(host, 'Qwen3-TTS (Original)').disabled).toBe(true);
  });

  it('selects Sarvam inline cloning with the current Teaching Voice and no preset control', async () => {
    const { host, fetchMock } = await mount('en', undefined, undefined, 'inline-reference', true);
    const sarvam = engineButton(host, 'Sarvam AI');
    expect(sarvam.disabled).toBe(false);

    act(() => sarvam.click());
    await flush();
    expect(store.state.stage).toMatchObject({
      narration: {
        preferredSelection: {
          providerId: 'sarvam',
          language: 'en',
          profileId: 'current-en-profile',
        },
      },
    });
    expect(host.querySelector('select[aria-label="Sarvam voice"]')).toBeNull();
    expect(host.textContent).toContain('exact original recording');

    act(() => engineButton(host, 'Preview This Scene').click());
    await flush();
    await flush();
    const request = fetchMock.mock.calls
      .filter(([, init]) => init?.method === 'POST')
      .map(([, init]) => JSON.parse(String(init?.body)))
      .find((body) => body.providerId === 'sarvam');
    expect(request).toMatchObject({
      providerId: 'sarvam',
      language: 'en',
      profileId: 'current-en-profile',
      text: 'Exact existing narration.',
    });
    expect(request).not.toHaveProperty('voice');
  });

  it('shows why the selected Teaching Voice cannot be used by Sarvam', async () => {
    const { host } = await mount('en', undefined, undefined, 'missing', true);
    const sarvam = engineButton(host, 'Sarvam AI');

    expect(sarvam.disabled).toBe(true);
    expect(sarvam.textContent).toContain(
      'The selected Teaching Voice has no usable Sarvam reference.',
    );
  });

  it('shows the server reason when Sarvam credentials are unavailable', async () => {
    const { host } = await mount('en', undefined, undefined, 'saved-voice-id', false);
    const sarvam = engineButton(host, 'Sarvam AI');

    expect(sarvam.disabled).toBe(true);
    expect(sarvam.textContent).toContain(
      'Sarvam AI credentials are not configured on this server.',
    );
    expect(sarvam.title).toBe('Sarvam AI credentials are not configured on this server.');
  });

  it('persists explicit Original Qwen selection and sends it to preview generation', async () => {
    const { host, fetchMock } = await mount('en');

    const enhanced = engineButton(host, 'Qwen3-TTS (Enhanced)');
    const original = engineButton(host, 'Qwen3-TTS (Original)');
    expect(enhanced.disabled).toBe(false);
    expect(original.disabled).toBe(false);

    act(() => original.click());
    await flush();
    expect(store.state.stage).toMatchObject({
      narration: {
        preferredSelection: {
          providerId: 'qwen3-tts',
          providerName: 'Qwen3-TTS (Original)',
          enhancementMode: 'standard',
          profileId: 'current-en-profile',
        },
      },
    });

    act(() => engineButton(host, 'Preview This Scene').click());
    await flush();
    await flush();
    const request = fetchMock.mock.calls
      .filter(([, init]) => init?.method === 'POST')
      .map(([, init]) => JSON.parse(String(init?.body)))
      .find((body) => body.providerId === 'qwen3-tts');
    expect(request).toMatchObject({
      providerId: 'qwen3-tts',
      enhancementMode: 'standard',
      text: 'Exact existing narration.',
    });

    const savedNarration = (store.state.stage as { narration: CourseNarrationState }).narration;
    const restored = await mount('en', savedNarration);
    expect(engineButton(restored.host, 'Qwen3-TTS (Original)').className).toContain(
      'border-primary',
    );
    expect(
      [...restored.host.querySelectorAll('select')].some((select) =>
        select.parentElement?.textContent?.includes('Audio mode'),
      ),
    ).toBe(false);
  });

  it('defaults an unconfigured Qwen Teaching Voice course to Enhanced', async () => {
    const { host } = await mount('en', undefined, 'qwen3-tts');

    expect(engineButton(host, 'Qwen3-TTS (Enhanced)').className).toContain('border-primary');
    expect(engineButton(host, 'Qwen3-TTS (Original)').className).not.toContain('border-primary');
  });

  it('persists a previous saved voice for only this course and previews with that profile', async () => {
    const { host, fetchMock } = await mount('en');
    const voiceSelect = host.querySelector(
      'select[aria-label="Saved faculty voice"]',
    ) as HTMLSelectElement | null;
    expect(voiceSelect).not.toBeNull();

    act(() => {
      voiceSelect!.value = 'previous-en-profile';
      voiceSelect!.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();

    const selectionPut = fetchMock.mock.calls
      .filter(([, init]) => init?.method === 'PUT')
      .map(([, init]) => JSON.parse(String(init?.body)))
      .find((body) => body.stage?.teacherVoiceProfileId === 'previous-en-profile');
    expect(selectionPut).toBeDefined();
    expect(store.state.stage).toMatchObject({ teacherVoiceProfileId: 'previous-en-profile' });

    act(() => engineButton(host, 'Preview This Scene').click());
    await flush();
    const previewRequest = fetchMock.mock.calls
      .filter(([, init]) => init?.method === 'POST')
      .map(([, init]) => JSON.parse(String(init?.body)))
      .find((body) => body.profileId === 'previous-en-profile');
    expect(previewRequest).toMatchObject({
      profileId: 'previous-en-profile',
      text: 'Exact existing narration.',
    });
  });
});
