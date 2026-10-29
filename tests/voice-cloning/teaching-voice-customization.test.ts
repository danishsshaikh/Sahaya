// @vitest-environment jsdom

import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TeachingVoiceCard } from '@/components/voice-cloning/teaching-voice-card';
import type { PublicVoiceProfile } from '@/lib/voice-cloning/types';

const PROFILE_ID = 'vcp_existing_english';
const roots: Root[] = [];
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const original = { format: 'wav', base64: 'b3JpZ2luYWw=', createdAt: '2026-10-29T00:00:00Z' };
const enhanced = { format: 'wav', base64: 'ZW5oYW5jZA==', createdAt: '2026-10-29T00:00:01Z' };

function profile(ready = false): PublicVoiceProfile {
  return {
    id: PROFILE_ID,
    displayName: 'My Teaching Voice',
    provider: 'chatterbox',
    language: 'en',
    languageId: 'en',
    status: 'ready',
    activeEngine: ready ? 'qwen3-tts' : 'chatterbox',
    enhancementMode: 'standard',
    qwenEnhancementMode: ready ? 'resemble-enhance' : 'standard',
    ...(ready
      ? {
          qwenPreview: {
            previewModel: 'qwen3-tts-1.7b-base',
            qwenCloneMode: 'speaker-embedding',
            enhancementMode: 'resemble-enhance',
            preview: original,
            comparison: { original, enhanced },
            previewText: 'Welcome to the course.',
          },
        }
      : {}),
    createdAt: '2026-10-26T00:00:00Z',
    updatedAt: '2026-10-29T00:00:00Z',
    consentTimestamp: '2026-10-26T00:00:00Z',
    consentVersion: 'faculty-self-voice-v1',
    profileVersion: 1,
  };
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
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

async function flush() {
  await act(async () => {
    await new Promise((settle) => setTimeout(settle, 0));
  });
}

async function mount(): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(createElement(Harness)));
  await flush();
  return host;
}

function button(host: HTMLElement, label: string): HTMLButtonElement {
  const result = [...host.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!(result instanceof HTMLButtonElement)) throw new Error(`Missing button: ${label}`);
  return result;
}

function click(element: HTMLElement) {
  act(() => element.dispatchEvent(new MouseEvent('click', { bubbles: true })));
}

beforeEach(() => {
  window.localStorage.clear();
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => 'blob:voice'),
    revokeObjectURL: vi.fn(),
  });
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  window.localStorage.clear();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, 'mediaDevices');
});

describe('simplified Teaching Voice journey', () => {
  it('records once and submits the approved paragraph through the enhanced workflow', async () => {
    class FakeMediaRecorder {
      static isTypeSupported = vi.fn(() => true);
      state: RecordingState = 'inactive';
      ondataavailable: ((event: BlobEvent) => void) | null = null;
      onerror: (() => void) | null = null;
      onstop: (() => void) | null = null;

      start() {
        this.state = 'recording';
      }

      stop() {
        this.state = 'inactive';
        this.ondataavailable?.({
          data: new Blob([new Uint8Array(1024)], { type: 'audio/webm;codecs=opus' }),
        } as BlobEvent);
        this.onstop?.();
      }
    }
    const stopTrack = vi.fn();
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: stopTrack }] })) },
    });
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) =>
      String(input) === '/api/voice-cloning/enrollment'
        ? response({ success: true, status: 'completed', profile: profile(true) })
        : response({ success: true, profile: null }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const host = await mount();
    const consent = host.querySelector('input[type="checkbox"]');
    if (!(consent instanceof HTMLInputElement)) throw new Error('Missing consent');
    act(() => consent.click());
    click(button(host, 'Start Recording'));
    await flush();
    click(button(host, 'Stop Recording'));
    await flush();
    expect(host.querySelector('[aria-label="Selected recording"]')).not.toBeNull();
    click(button(host, 'Generate Voice'));
    await flush();

    const enrollment = fetchMock.mock.calls.find(
      ([input]) => String(input) === '/api/voice-cloning/enrollment',
    );
    const body = enrollment?.[1]?.body as FormData;
    expect(body.get('workflow')).toBe('enhanced-qwen');
    expect(body.get('enrollmentSource')).toBe('microphone');
    expect(body.get('phraseId')).toBe('teaching-paragraph');
    expect(String(body.get('referenceText'))).toContain('Today we will take a simple idea');
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(host.textContent).toContain('Voice ready');
  });

  it('upgrades an existing authorized profile with one Generate Voice action', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === 'PATCH'
        ? response({ success: true, profile: profile(true) })
        : response({ success: true, profile: profile(false) }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const host = await mount();
    expect(host.textContent).toContain('Your saved recording can be used');
    expect(host.textContent).not.toContain('Customize Voice');
    click(button(host, 'Generate Voice'));
    await flush();

    const patch = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH');
    expect(JSON.parse(String(patch?.[1]?.body))).toEqual({
      profileId: PROFILE_ID,
      action: 'activate-enhanced-qwen',
    });
    expect(host.textContent).toContain('Voice ready');
    expect(host.querySelector('[aria-label="Teaching Voice sample"]')).not.toBeNull();
    expect(
      JSON.parse(window.localStorage.getItem('sahaya.teachingVoice.selection.v1.en') || '{}'),
    ).toMatchObject({
      enabled: true,
      profileId: PROFILE_ID,
      enhancementMode: 'resemble-enhance',
    });
  });

  it('keeps the existing profile unchanged when enhanced generation fails', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === 'PATCH'
        ? response({ success: false, error: 'Voice enhancement failed.' }, 502)
        : response({ success: true, profile: profile(false) }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const host = await mount();
    click(button(host, 'Generate Voice'));
    await flush();

    expect(host.textContent).toContain('Voice enhancement failed. Your saved voice is unchanged.');
    expect(host.querySelector('[aria-label="Teaching Voice sample"]')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('uploads, explicitly transcribes, permits correction, and submits one enhanced workflow', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      if (String(input) === '/api/transcription') {
        return response({ success: true, text: 'Automatic transcript' });
      }
      if (String(input) === '/api/voice-cloning/enrollment') {
        return response({ success: true, status: 'completed', profile: profile(true) });
      }
      return response({ success: true, profile: null });
    });
    vi.stubGlobal('fetch', fetchMock);

    const host = await mount();
    click(button(host, 'Upload Audio'));
    const consent = host.querySelector('input[type="checkbox"]');
    if (!(consent instanceof HTMLInputElement)) throw new Error('Missing consent');
    act(() => consent.click());
    const fileInput = host.querySelector('input[type="file"]');
    if (!(fileInput instanceof HTMLInputElement)) throw new Error('Missing file input');
    const file = new File([new Uint8Array(1024)], 'authorized.wav', { type: 'audio/wav' });
    Object.defineProperty(fileInput, 'files', { configurable: true, value: [file] });
    act(() => fileInput.dispatchEvent(new Event('change', { bubbles: true })));
    await flush();

    click(button(host, 'Transcribe Audio'));
    await flush();
    const transcript = host.querySelector('textarea');
    if (!(transcript instanceof HTMLTextAreaElement)) throw new Error('Missing transcript');
    act(() => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      setValue?.call(transcript, 'Corrected exact transcript');
      transcript.dispatchEvent(new Event('input', { bubbles: true }));
    });
    click(button(host, 'Generate Voice'));
    await flush();

    const enrollment = fetchMock.mock.calls.find(
      ([input]) => String(input) === '/api/voice-cloning/enrollment',
    );
    const body = enrollment?.[1]?.body;
    expect(body).toBeInstanceOf(FormData);
    expect((body as FormData).get('workflow')).toBe('enhanced-qwen');
    expect((body as FormData).get('referenceText')).toBe('Corrected exact transcript');
    const uploaded = (body as FormData).get('recording');
    expect(uploaded).toBeInstanceOf(File);
    expect(uploaded).toMatchObject({ name: file.name, size: file.size, type: file.type });
    expect(new Uint8Array(await (uploaded as File).arrayBuffer())).toEqual(
      new Uint8Array(await file.arrayBuffer()),
    );
    expect(host.textContent).toContain('Voice ready');
  });
});
