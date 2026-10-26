import { describe, expect, it } from 'vitest';
import {
  createEstimatedNarrationCues,
  findNarrationCueIndex,
  resolveNarrationCues,
} from '@/lib/playback/narration-cues';

describe('narration transcript cues', () => {
  const text = 'Geopolitics links geography and politics. Institutions shape the outcome.';

  it('creates deterministic phrase cues scaled to actual audio duration', () => {
    const first = createEstimatedNarrationCues(text, 8000);
    const second = createEstimatedNarrationCues(text, 8000);

    expect(first).toEqual(second);
    expect(first.length).toBeGreaterThan(1);
    expect(first[0].startMs).toBe(0);
    expect(first.at(-1)?.endMs).toBe(8000);
    expect(text.slice(first[0].startOffset, first[0].endOffset)).toContain('Geopolitics');
  });

  it('maps t=0, forward seeks, backward seeks, and audio end without an independent clock', () => {
    const cues = createEstimatedNarrationCues(text, 8000);
    const first = findNarrationCueIndex(cues, 0);
    const later = findNarrationCueIndex(cues, 6500);

    expect(first).toBe(0);
    expect(later).toBeGreaterThan(first);
    expect(findNarrationCueIndex(cues, 0)).toBe(first);
    expect(findNarrationCueIndex(cues, 8000)).toBe(-1);
  });

  it('prefers real timing metadata when it is available', () => {
    const timings = [{ startOffset: 0, endOffset: 11, startMs: 100, endMs: 900 }];
    expect(resolveNarrationCues({ text, durationMs: 8000, timings })).toEqual(timings);
  });

  it('falls back to estimated cues when timing metadata is malformed', () => {
    expect(
      resolveNarrationCues({
        text,
        durationMs: 8000,
        timings: [{ startOffset: -1, endOffset: 3, startMs: 0, endMs: 100 }],
      }).length,
    ).toBeGreaterThan(1);
  });
});
