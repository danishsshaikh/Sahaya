import { describe, expect, it } from 'vitest';
import { retrieveManimKnowledge, validateKnowledgeVersion } from '@/lib/visualization/knowledge';
import { readPreflight } from '@/lib/visualization/preflight';

describe('pinned Manim knowledge', () => {
  it('selects plotting, coordinates and updater APIs before authoring diffraction', async () => {
    const result = await retrieveManimKnowledge('Animate a diffraction pattern and moving maxima');
    expect(result.version).toBe('0.22.1');
    expect(result.entries.map((entry) => entry.symbol)).toEqual(
      expect.arrayContaining(['Axes.plot', 'Axes.c2p', 'ValueTracker', 'always_redraw']),
    );
    expect(result.examples.map((example) => example.id)).toContain('wave');
    expect(result.entries.length).toBeLessThanOrEqual(11);
    expect(result.examples.length).toBeLessThanOrEqual(2);
  });

  it('returns pinned parameters and verified alternatives for the live NumberLine failure', async () => {
    const constructor = await retrieveManimKnowledge('', {
      query: 'NumberLine',
      kind: 'constructor',
    });
    expect(constructor.entries[0]).toMatchObject({
      symbol: 'NumberLine',
      signature: expect.stringContaining('include_numbers'),
    });
    const alternatives = await retrieveManimKnowledge('', {
      query: 'NumberLine.nudge',
      kind: 'alternatives',
    });
    const symbols = alternatives.entries.map((entry) => entry.symbol);
    expect(symbols).toEqual(
      expect.arrayContaining(['NumberLine.n2p', 'NumberLine.number_to_point']),
    );
    expect(symbols).not.toContain('NumberLine.nudge');
    const examples = await retrieveManimKnowledge('', { query: 'number line', kind: 'examples' });
    expect(examples.entries).toHaveLength(0);
    expect(examples.examples[0]?.id).toBe('number-line');
  });

  it('rejects mismatched knowledge and publisher versions', () => {
    expect(() => validateKnowledgeVersion('0.22.0')).toThrow('version mismatch');
    expect(() => readPreflight({ version: '0.22.0', source: 'valid', findings: [] })).toThrow();
  });
});
