import { describe, expect, it } from 'vitest';
import { extractSubmission } from '@/lib/visualization/submission';

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
