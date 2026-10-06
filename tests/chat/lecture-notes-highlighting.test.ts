// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LectureNotesView } from '@/components/chat/lecture-notes-view';
import type { LectureNoteEntry } from '@/lib/types/chat';

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

const text = 'Geopolitics links geography and politics.';
const notes: LectureNoteEntry[] = [
  {
    sceneId: 'scene-1',
    sceneTitle: 'Geopolitics',
    sceneOrder: 1,
    completedAt: 1,
    items: [
      {
        kind: 'speech',
        text,
        actionIndex: 0,
        actionId: 'speech-1',
        actionType: 'speech',
      },
    ],
  },
];

describe('lecture notes narration highlighting', () => {
  let root: Root;
  let container: HTMLDivElement;
  let scrollIntoView: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it('highlights only the active phrase without changing displayed narration text', async () => {
    await act(async () => {
      root.render(
        createElement(LectureNotesView, {
          notes,
          currentSceneId: 'scene-1',
          currentActionIndex: 0,
          narrationHighlight: {
            sceneId: 'scene-1',
            actionIndex: 0,
            actionId: 'speech-1',
            text,
            cue: { startOffset: 0, endOffset: 11, startMs: 0, endMs: 1000 },
          },
        }),
      );
    });

    expect(container.querySelector('mark')?.textContent).toBe('Geopolitics');
    expect(container.querySelector('button')?.textContent).toContain(text);
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'nearest' });
  });

  it('does not highlight stale audio text and pauses auto-scroll after manual scrolling', async () => {
    const render = (highlightText: string, startOffset: number, endOffset: number) =>
      createElement(LectureNotesView, {
        notes,
        currentSceneId: 'scene-1',
        currentActionIndex: 0,
        narrationHighlight: {
          sceneId: 'scene-1',
          actionIndex: 0,
          actionId: 'speech-1',
          text: highlightText,
          cue: { startOffset, endOffset, startMs: 0, endMs: 1000 },
        },
      });

    await act(async () => root.render(render(text, 0, 11)));
    const scrollCount = scrollIntoView.mock.calls.length;
    container.firstElementChild?.dispatchEvent(new WheelEvent('wheel', { bubbles: true }));
    await act(async () => root.render(render(text, 12, 27)));
    expect(scrollIntoView).toHaveBeenCalledTimes(scrollCount);

    await act(async () => root.render(render('Edited narration', 0, 6)));
    expect(container.querySelector('mark')).toBeNull();
    expect(container.querySelector('button')?.textContent).toContain(text);
  });
});
