// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import {
  findPronunciationPhraseOccurrences,
  isShortPronunciationSelection,
  selectionOffsetsWithin,
} from '@/lib/audio/pronunciation-selection';

describe('pronunciation text selection', () => {
  it('maps a selection across highlighted markup to the original narration offsets', () => {
    const container = document.createElement('span');
    container.append('DNA ');
    const mark = document.createElement('mark');
    mark.textContent = 'polymerase';
    container.append(mark, ' synthesizes a strand.');
    document.body.append(container);

    const range = document.createRange();
    range.setStart(mark.firstChild!, 0);
    range.setEnd(mark.firstChild!, 'polymerase'.length);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    expect(selectionOffsetsWithin(container, selection)).toEqual({
      startOffset: 4,
      endOffset: 14,
      text: 'polymerase',
    });
    container.remove();
  });

  it('accepts a short phrase and rejects an arbitrary long selection', () => {
    expect(
      isShortPronunciationSelection({ startOffset: 0, endOffset: 10, text: 'polymerase' }),
    ).toBe(true);
    expect(
      isShortPronunciationSelection({
        startOffset: 0,
        endOffset: 200,
        text: Array.from({ length: 20 }, () => 'word').join(' '),
      }),
    ).toBe(false);
  });

  it('returns deterministic offsets for repeated exact phrases', () => {
    expect(
      findPronunciationPhraseOccurrences('India influenced India-facing trade routes.', 'India'),
    ).toEqual([
      { startOffset: 0, endOffset: 5 },
      { startOffset: 17, endOffset: 22 },
    ]);
  });
});
