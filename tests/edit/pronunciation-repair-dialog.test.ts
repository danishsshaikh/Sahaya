// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PronunciationRepairDialog } from '@/components/edit/ActionsBar/PronunciationRepairDialog';

const mocks = vi.hoisted(() => ({ requestRepair: vi.fn() }));

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${JSON.stringify(options)}` : key,
  }),
}));

vi.mock('@/lib/audio/pronunciation-repair', () => ({
  requestPronunciationRepair: mocks.requestRepair,
}));

let root: Root | null = null;
let host: HTMLDivElement | null = null;

describe('edit-mode pronunciation repair dialog', () => {
  beforeEach(() => {
    mocks.requestRepair.mockReset().mockResolvedValue({
      status: 'replaced',
      audioId: 'audio-repaired',
      repairIdentity: 'repair-1',
    });
  });

  afterEach(() => {
    if (root) act(() => root?.unmount());
    host?.remove();
    document.querySelectorAll('[data-slot="dialog-portal"]').forEach((node) => node.remove());
    root = null;
    host = null;
  });

  it('accepts manual phrase input and targets the selected repeated occurrence', async () => {
    const repaired = vi.fn();
    const pendingChanged = vi.fn();
    mount({
      actionId: 'speech-3',
      actionIndex: 2,
      displayText: 'India influenced India-facing trade routes.',
      onRepaired: repaired,
      onPendingChange: pendingChanged,
    });

    click(buttonByLabel('edit.tts.fixPronunciation'));
    expect(document.querySelector('[data-testid="pronunciation-repair-dialog"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="pronunciation-original-text"]')?.textContent).toBe(
      'India influenced India-facing trade routes.',
    );

    inputByPlaceholder('edit.tts.pronunciationPhrasePlaceholder', 'India');
    const occurrence = document.querySelector('select') as HTMLSelectElement;
    expect(occurrence).not.toBeNull();
    changeSelect(occurrence, '1');
    inputByPlaceholder('edit.tts.pronounceAsPlaceholder', 'IN-dee-ah');
    click(buttonWithText('edit.tts.regenerateVoice'));

    await waitFor(() => mocks.requestRepair.mock.calls.length === 1);
    expect(mocks.requestRepair).toHaveBeenCalledWith({
      stageId: 'stage-1',
      sceneId: 'scene-1',
      actionId: 'speech-3',
      actionIndex: 2,
      displayText: 'India influenced India-facing trade routes.',
      startOffset: 17,
      endOffset: 22,
      pronounceAs: 'IN-dee-ah',
      language: 'English',
    });
    await waitFor(() => repaired.mock.calls.length === 1);
    expect(repaired).toHaveBeenCalledWith('audio-repaired');
    expect(pendingChanged.mock.calls).toEqual([[true], [false]]);
    expect(document.querySelector('[data-testid="pronunciation-original-text"]')?.textContent).toBe(
      'India influenced India-facing trade routes.',
    );
  });

  it('keeps the control visible but locally disabled while that action voice is pending', () => {
    mount({ actionVoicePending: true });

    const button = buttonByLabel('edit.tts.fixPronunciation');
    expect(button.disabled).toBe(true);
    expect(button.title).toBe('edit.tts.pronunciationVoicePending');
  });
});

function mount(overrides: Partial<React.ComponentProps<typeof PronunciationRepairDialog>> = {}) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root?.render(
      React.createElement(PronunciationRepairDialog, {
        stageId: 'stage-1',
        sceneId: 'scene-1',
        actionId: 'speech-1',
        actionIndex: 0,
        displayText: 'Hinduism, Buddhism, and Jainism.',
        language: 'English',
        actionVoicePending: false,
        onRepaired: () => undefined,
        onPendingChange: () => undefined,
        ...overrides,
      }),
    );
  });
}

function buttonByLabel(label: string): HTMLButtonElement {
  const button = document.querySelector(`[aria-label="${label}"]`) as HTMLButtonElement | null;
  if (!button) throw new Error(`Missing button: ${label}`);
  return button;
}

function buttonWithText(text: string): HTMLButtonElement {
  const button = [...document.querySelectorAll('button')].find((item) =>
    item.textContent?.includes(text),
  ) as HTMLButtonElement | undefined;
  if (!button) throw new Error(`Missing button text: ${text}`);
  return button;
}

function click(button: HTMLButtonElement) {
  act(() => button.click());
}

function inputByPlaceholder(placeholder: string, value: string) {
  const input = document.querySelector(`[placeholder="${placeholder}"]`) as HTMLInputElement | null;
  if (!input) throw new Error(`Missing input: ${placeholder}`);
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function changeSelect(select: HTMLSelectElement, value: string) {
  act(() => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await act(async () => Promise.resolve());
  }
  throw new Error('Timed out waiting for condition');
}
