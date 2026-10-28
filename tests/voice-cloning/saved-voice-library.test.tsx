// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SavedVoiceLibrary } from '@/components/voice-cloning/saved-voice-library';
import type { PublicVoiceProfile } from '@/lib/voice-cloning/types';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function profile(id: string, name: string, createdAt: string): PublicVoiceProfile {
  return {
    id,
    displayName: name,
    provider: 'chatterbox',
    language: 'en',
    status: 'ready',
    createdAt,
    updatedAt: createdAt,
    consentTimestamp: createdAt,
    consentVersion: 'v1',
    languageId: 'en',
    activeEngine: 'chatterbox',
    profileVersion: 1,
    enrollmentSource: 'audio-import',
    compatibleProviders: ['chatterbox', 'qwen3-tts', 'ming3-tts', 'sarvam'],
    preview: { format: 'wav', base64: 'UklGRg==', createdAt },
  };
}

afterEach(() => document.body.replaceChildren());

describe('Saved Voice Library controls', () => {
  it('renders creation metadata and synthetic previews and selects a previous voice', () => {
    const onSelect = vi.fn();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const newest = profile('vcp_new', 'Newest voice', '2026-10-20T00:00:00.000Z');
    const previous = profile('vcp_previous', 'Previous voice', '2026-09-10T00:00:00.000Z');
    act(() =>
      root.render(
        createElement(SavedVoiceLibrary, {
          profiles: [newest, previous],
          selectedProfileId: newest.id,
          onSelect,
          onRename: vi.fn(),
        }),
      ),
    );

    expect(host.textContent).toContain('Created');
    expect(host.textContent).toContain('Imported audio');
    expect(host.textContent).toContain('Ming 3.0');
    expect(host.textContent).toContain('Synthetic voice preview');
    expect(host.querySelector('audio')?.getAttribute('src')).toContain('data:audio/wav;base64,');
    const selectButtons = [...host.querySelectorAll('button')].filter(
      (button) => button.textContent?.trim() === 'Select',
    );
    act(() => selectButtons[0]?.click());
    expect(onSelect).toHaveBeenCalledWith(previous);
    act(() => root.unmount());
  });

  it('submits a bounded renamed display name for the selected owner profile', () => {
    const onRename = vi.fn();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const saved = profile('vcp_saved', 'Saved voice', '2026-09-10T00:00:00.000Z');
    act(() =>
      root.render(
        createElement(SavedVoiceLibrary, {
          profiles: [saved],
          onSelect: vi.fn(),
          onRename,
        }),
      ),
    );
    const rename = [...host.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Rename'),
    );
    act(() => rename?.click());
    const input = host.querySelector('input');
    expect(input?.maxLength).toBe(80);
    act(() => {
      if (!input) return;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, 'Archive lecture voice');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() =>
      host
        .querySelector('form')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    );
    expect(onRename).toHaveBeenCalledWith(saved, 'Archive lecture voice');
    act(() => root.unmount());
  });
});
