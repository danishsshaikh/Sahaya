// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LessonGenerationProgress } from '@/components/generation/lesson-generation-progress';

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function mountProgress() {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      createElement(
        'section',
        { 'data-generation-job': 'active' },
        createElement(LessonGenerationProgress, {
          sceneIndex: 3,
          totalScenes: 6,
          phase: 'narration',
          teachingVoiceQueue: {
            status: 'running',
            queuePosition: null,
            jobsAhead: null,
            estimatedWaitMs: null,
          },
        }),
      ),
    );
  });
}

function trigger(): HTMLButtonElement {
  const button = document.querySelector('button[aria-controls]');
  if (!(button instanceof HTMLButtonElement)) throw new Error('Missing generation status trigger');
  return button;
}

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  mountProgress();
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

describe('lesson generation progress interactions', () => {
  it('collapses details without changing the active generation owner', () => {
    act(() => trigger().click());
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();

    act(() => trigger().click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.querySelector('[data-generation-job="active"]')).not.toBeNull();
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
  });

  it('dismisses expanded details with Escape and outside pointer input', () => {
    act(() => trigger().click());
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    act(() => trigger().click());
    act(() => document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.querySelector('[data-generation-job="active"]')).not.toBeNull();
  });
});
