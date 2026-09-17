import { describe, expect, it } from 'vitest';
import type { PPTElement } from '@openmaic/dsl';
import { repairGeneratedSlideLayout } from '@openmaic/generation';

function text(id: string, top: number, left = 80, content = 'Topic'): PPTElement {
  return {
    id,
    type: 'text',
    left,
    top,
    width: 760,
    height: 110,
    rotate: 0,
    content: `<p>${content}</p>`,
    defaultFontName: '',
    defaultColor: '#111111',
  };
}

function latex(id: string, top: number, left = 100): PPTElement {
  return {
    id,
    type: 'latex',
    left,
    top,
    width: 500,
    height: 90,
    rotate: 0,
    latex: '\\frac{a}{b}=c',
    html: '<span class="katex"></span>',
    color: '#111111',
    align: 'center',
    fixedRatio: true,
  };
}

function boxes(elements: PPTElement[]) {
  return elements
    .filter((element) => element.type !== 'line')
    .map((element) => ({
      left: element.left,
      top: element.top,
      width: element.width,
      height: element.height,
    }));
}

function overlapArea(
  a: { left: number; top: number; width: number; height: number },
  b: { left: number; top: number; width: number; height: number },
): number {
  const width = Math.max(
    0,
    Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left),
  );
  const height = Math.max(0, Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top));
  return width * height;
}

function expectNoUnsafeOverlap(elements: PPTElement[]) {
  const all = boxes(elements);
  for (let i = 0; i < all.length; i += 1) {
    for (let j = i + 1; j < all.length; j += 1) {
      expect(overlapArea(all[i]!, all[j]!)).toBe(0);
    }
  }
}

describe('repairGeneratedSlideLayout', () => {
  it('does not move a valid generated slide', () => {
    const elements = [
      { ...text('title', 42, 70, 'Concurrency'), width: 860, height: 58, textType: 'title' },
      { ...text('body', 145, 70, 'Key ideas'), width: 400, height: 140 },
      { ...latex('formula', 145, 540), width: 360, height: 120 },
    ] as PPTElement[];

    const result = repairGeneratedSlideLayout(elements);
    expect(result.summary.repaired).toBe(false);
    expect(result.elements).toBe(elements);
  });

  it('reflows overlapping generated text and formula elements below the title band', () => {
    const elements = [
      { ...text('title', 40, 60, 'Quantum states'), textType: 'title' },
      text('body-1', 70, 90, 'The state vector $|\\psi\\rangle$ evolves.'),
      text('body-2', 82, 110, 'Measurement probabilities overlap in the generated layout.'),
      latex('formula', 90, 130),
    ] as PPTElement[];

    const result = repairGeneratedSlideLayout(elements);
    expect(result.summary.repaired).toBe(true);
    expect(result.summary.reasons).toContain('overlapping-elements');
    expect(result.elements[0]).toMatchObject({ left: 48, top: 30, width: 904, height: 64 });
    expect(result.elements.slice(1).every((element) => element.top >= 118)).toBe(true);
    expectNoUnsafeOverlap(result.elements);
  });

  it('treats duplicate top-band headings as content instead of stacking title text', () => {
    const elements = [
      { ...text('title-a', 34, 58, 'Sorting'), textType: 'title' },
      text('title-b', 58, 75, 'Sorting'),
      text('explanation', 170, 90, 'Stable sorting preserves equal-key order.'),
    ] as PPTElement[];

    const result = repairGeneratedSlideLayout(elements);
    expect(result.summary.reasons).toContain('duplicate-title-candidates');
    expect(result.elements[0]).toMatchObject({ top: 30, height: 64 });
    expect(result.elements[1]?.top).toBeGreaterThanOrEqual(118);
    expectNoUnsafeOverlap(result.elements);
  });

  it('repairs out-of-bounds generated content without deleting elements', () => {
    const elements = [
      { ...text('title', 22, 60, 'Neural networks'), textType: 'title' },
      { ...text('overflow', 500, 780, 'Output layer'), width: 360, height: 120 },
      { ...latex('formula', 500, -30), width: 420, height: 120 },
    ] as PPTElement[];

    const result = repairGeneratedSlideLayout(elements);
    expect(result.summary.reasons).toContain('out-of-safe-area');
    expect(result.elements).toHaveLength(elements.length);
    for (const box of boxes(result.elements)) {
      expect(box.left).toBeGreaterThanOrEqual(48);
      expect(box.left + box.width).toBeLessThanOrEqual(952);
      expect(box.top + box.height).toBeLessThanOrEqual(524.5);
    }
    expectNoUnsafeOverlap(result.elements);
  });
});
