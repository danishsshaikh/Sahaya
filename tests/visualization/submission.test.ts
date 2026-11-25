import { describe, expect, it } from 'vitest';
import { applySceneEdits, editableSource, extractSubmission } from '@/lib/visualization/submission';

const segments = [
  { id: 'intro', narration: 'Start at “zero”.', caption: 'A \\ B' },
  { id: 'move', narration: 'Then move to the right.' },
];
const pythonSource = String.raw`from manim import MathTex, Write
from sahaya_timing import CueScene

class GeneratedScene(CueScene):
    def construct(self):
        with self.cue("intro"):
            equation = MathTex(r"\frac{a}{b}")
            label = "Quote: \"a\"\nPath: C:\\tmp"
            self.play(Write(equation))
        with self.cue("move"):
            self.wait(1)
`;
const annotated = `# sahaya-cues: ${JSON.stringify(segments)}\n${pythonSource}`;
const fenced = (language: string, code: string) =>
  '\x60\x60\x60' + language + '\n' + code + '\x60\x60\x60';
const envelope = (source: string) => JSON.stringify({ tool: 'submit_scene', source, segments });

describe('Manim response extraction', () => {
  it.each([
    ['standard', 'CueScene'],
    ['moving-camera', 'CueMovingCameraScene'],
    ['three-d', 'CueThreeDScene'],
  ])('assembles the %s scaffold around native Python', (mode, base) => {
    const body = `# sahaya-scene: ${mode}\nfrom manim import Dot\ndef animate(self):\n    pass\n`;
    const result = extractSubmission({ text: envelope(body) });
    expect(result).toMatchObject({ outcome: 'submitted', candidate: { segments } });
    if (result.outcome !== 'submitted') throw new Error('Expected a candidate');
    expect(result.candidate.source).toBe(
      body +
        `\nfrom sahaya_timing import ${base} as SahayaOwnedScene\n\nclass GeneratedScene(SahayaOwnedScene):\n    def construct(self):\n        return animate(self)\n`,
    );
  });

  it('applies disjoint edits atomically against the original line numbers and protects the scaffold and cues', () => {
    const fragment = `# sahaya-cues: ${JSON.stringify(segments)}\n# sahaya-scene: standard\nfrom manim import Dot\ndef animate(self):\n    with self.cue("intro"):\n        self.wait(1)\n    with self.cue("move"):\n        self.wait(2)\n`;
    const initial = extractSubmission({ text: fragment });
    if (initial.outcome !== 'submitted') throw new Error('Expected a scaffold candidate');
    const candidate = initial.candidate;
    const window = editableSource(candidate.source);
    const parsed = extractSubmission({
      text: fenced(
        'python',
        '# sahaya-edit: 6-5\n        dot = Dot()\n# sahaya-edit: 8-8\n        self.add(dot)\n        self.wait(2)\n',
      ),
    });
    if (parsed.outcome !== 'edit') throw new Error('Expected two edits');
    expect(applySceneEdits(candidate, parsed.edits, window)).toEqual({
      source: candidate.source
        .replace('        self.wait(1)', '        dot = Dot()\n        self.wait(1)')
        .replace('        self.wait(2)', '        self.add(dot)\n        self.wait(2)'),
      segments,
    });
    for (const edits of [
      [{ start: 1, end: 1, replacement: '# metadata changed' }],
      [{ start: window.lastLine + 2, end: window.lastLine + 2, replacement: 'pass' }],
      [
        { start: 4, end: 8, replacement: 'pass' },
        { start: 6, end: 7, replacement: '' },
      ],
      [{ start: 6, end: 6, replacement: '# sahaya-cues: []' }],
    ])
      expect(applySceneEdits(candidate, edits, window)).toBeUndefined();
    expect(candidate.source).toContain('        self.wait(1)');
  });

  it.each([
    ['python', annotated, annotated],
    ['fenced-python', fenced('python', annotated), annotated],
    ['fenced-python', 'Here is the module.\n' + fenced('py', annotated) + '\n', annotated],
    [
      'fenced-python',
      fenced('python', annotated).replaceAll('\n', '\r\n'),
      annotated.replaceAll('\n', '\r\n'),
    ],
    ['json', envelope(pythonSource), pythonSource],
    ['json', JSON.stringify({ source: pythonSource, segments }), pythonSource],
    ['fenced-json', fenced('json', envelope(pythonSource) + '\n'), pythonSource],
  ])('preserves the exact source and ordered cues from %s', (format, text, source) => {
    expect(extractSubmission({ text })).toEqual({
      format,
      outcome: 'submitted',
      candidate: { source, segments },
    });
  });

  it.each([
    [pythonSource, 'python', 'missing_cue_metadata'],
    [fenced('python', pythonSource), 'fenced-python', 'missing_cue_metadata'],
    [annotated.replace('[{', '[{oops'), 'python', 'invalid_cue_metadata'],
    [envelope(pythonSource.replaceAll('\n', '\\n')), 'json', 'encoded_source'],
    [envelope(fenced('python', pythonSource)), 'json', 'wrapped_source'],
    [envelope(pythonSource).slice(0, -1), 'json', 'malformed_json'],
    [
      fenced('python', annotated) + '\n' + fenced('python', annotated),
      'unknown',
      'ambiguous_response',
    ],
    [fenced('python', annotated) + '\n' + envelope(pythonSource), 'unknown', 'ambiguous_response'],
  ])('diagnoses an unusable response as %s', (text, format, outcome) => {
    expect(extractSubmission({ text })).toMatchObject({ format, outcome });
  });

  it('uses a single native tool payload and preserves its source and cues', () => {
    const tool = { toolName: 'submit_scene', input: { source: pythonSource, segments } };
    expect(extractSubmission({ text: 'I prepared the module.', toolCalls: [tool] })).toEqual({
      format: 'native-tool',
      outcome: 'submitted',
      candidate: { source: pythonSource, segments },
    });
    expect(extractSubmission({ text: '', toolCalls: [tool, tool] })).toEqual({
      format: 'native-tool',
      outcome: 'ambiguous_response',
    });
  });
});
