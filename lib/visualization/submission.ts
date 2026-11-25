import { z } from 'zod';
import {
  manimLookup,
  requestedReferenceTopics,
  sourceEdits,
  sourceSubmission,
} from './agent-tools';
import type { Lookup } from './knowledge';
import type { ReferenceTopic } from './skill';

export type Candidate = z.infer<typeof sourceSubmission>;
export const SUBMISSION_FORMAT = `Return plain text. First line: # sahaya-cues: [{"id":"intro","narration":"One sentence."}]. Second line: # sahaya-scene: standard (or moving-camera or three-d if needed). Then write native Python imports, any helpers, and def animate(self): using the same ordered self.cue IDs. Sahaya supplies the scene class and calls animate. Put Python on real lines. Do not output a class for the scene.`;
export const REPAIR_FORMAT = `Return only anchored edits. Put # sahaya-edit: START-END on its own line, then the replacement Python with its original indentation. START and END are inclusive candidate line numbers. Use an empty replacement for deletion, or END = START - 1 to insert before START. Submit up to three disjoint edits inside editableLines. Keep the cue metadata, scene wrapper, and all other lines. For example, # sahaya-edit: 9-9 followed by the indented corrected ninth line.`;
const cueHeader = /^\uFEFF?(?:[ \t]*\r?\n)*# sahaya-cues:[ \t]*([^\r\n]*)(?:\r?\n|$)/;
const editHeader = /^(?:[ \t]*\r?\n)*# sahaya-edit:/;
const scaffoldMarker = /^# sahaya-scene:[ \t]*([^\r\n]*)(?:\r?\n|$)/;
const sceneBases = {
  standard: 'CueScene',
  'moving-camera': 'CueMovingCameraScene',
  'three-d': 'CueThreeDScene',
};
const scaffoldStart = ' as SahayaOwnedScene\n\nclass GeneratedScene(SahayaOwnedScene):\n';
function sceneHeader(source: string) {
  const cues = cueHeader.exec(source)?.[0] ?? '';
  const marker = scaffoldMarker.exec(source.slice(cues.length));
  return { marker, length: cues.length + (marker?.[0].length ?? 0) };
}
const sceneClass = /^[ \t]*class[ \t]+GeneratedScene\b/m;
const fenceLine = /^[ \t]*(`{3,}|~{3,})([^\r\n]*)\r?$/gm;
const responseLimit = 90_000;
const sourceLimit = 48 * 1024;

type Format = 'native-tool' | 'json' | 'fenced-json' | 'python' | 'fenced-python' | 'unknown';
const rejectionMessages = {
  empty: 'Return the complete Python module and its cue metadata.',
  response_too_large: 'Return a shorter, complete response.',
  ambiguous_response: 'Return exactly one submission.',
  unsupported_format: 'Use the requested submission format.',
  malformed_json: 'The JSON envelope could not be decoded. Use the requested submission format.',
  invalid_envelope: 'The response must contain a source module and ordered cue metadata.',
  unsupported_tool: 'Use only the requested submission tool or an available reference tool.',
  invalid_reference: 'The reference request was invalid. Submit the complete Python module now.',
  missing_cue_metadata: 'Add the # sahaya-cues: comment with the ordered cue list.',
  invalid_cue_metadata:
    'Provide a valid JSON cue array with unique IDs and at least one narration.',
  invalid_source: 'Provide a nonempty, bounded Python module.',
  encoded_source: 'Write Python with actual line breaks and indentation.',
  wrapped_source:
    'Write the Python source directly, without fencing the source within the submission.',
  invalid_scaffold: 'Use standard, moving-camera, or three-d in the # sahaya-scene comment.',
  invalid_edit:
    'Return only line edits inside the numbered editable lines. Keep cue metadata and the scaffold.',
} as const;
type Rejection = keyof typeof rejectionMessages;
export function formatFeedback(code: Rejection) {
  return { code, message: rejectionMessages[code] };
}

type Edits = z.infer<typeof sourceEdits>['edits'];
type Extraction = { format: Format } & (
  | { outcome: 'submitted'; candidate: Candidate }
  | { outcome: 'edit'; edits: Edits }
  | { outcome: 'reference'; topics: ReferenceTopic[] }
  | { outcome: 'lookup'; lookup: Lookup }
  | { outcome: Rejection; source?: string }
);
type Reply = { text: string; toolCalls?: { toolName: string; input: unknown }[] };
type Fields = Record<string, unknown>;
const isObject = (value: unknown): value is Fields =>
  !!value && typeof value === 'object' && !Array.isArray(value);

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function candidate(format: Format, input: unknown): Extraction {
  if (!isObject(input)) return { format, outcome: 'invalid_envelope' };
  const { source } = input;
  if (typeof source !== 'string' || !source.trim() || Buffer.byteLength(source) > sourceLimit)
    return { format, outcome: 'invalid_source' };
  // Recognize lost physical lines. Replacing escapes globally would alter
  // legitimate Python strings and LaTeX on a correctly transported module.
  if (!/[\r\n]/.test(source.trimEnd()) && /\\(?:r\\)?n/.test(source))
    return { format, outcome: 'encoded_source', source };
  if (/^[ \t\r\n]*(?:`{3,}|~{3,})/.test(source))
    return { format, outcome: 'wrapped_source', source };
  if (Object.keys(input).some((key) => key !== 'source' && key !== 'segments'))
    return { format, outcome: 'invalid_envelope', source };
  if (!Object.hasOwn(input, 'segments')) return { format, outcome: 'missing_cue_metadata', source };
  const { marker } = sceneHeader(source);
  let authored = source;
  if (marker) {
    const mode = marker[1].trim();
    if (!Object.hasOwn(sceneBases, mode)) return { format, outcome: 'invalid_scaffold', source };
    const base = sceneBases[mode as keyof typeof sceneBases];
    authored = `${source.trimEnd()}\n\nfrom sahaya_timing import ${base}${scaffoldStart}    def construct(self):\n        return animate(self)\n`;
  }
  const checked = sourceSubmission.safeParse({ ...input, source: authored });
  return checked.success
    ? { format, outcome: 'submitted', candidate: checked.data }
    : { format, outcome: 'invalid_cue_metadata', source };
}

function envelope(format: Format, name: unknown, input: unknown): Extraction {
  if (name === 'edit_scene') {
    const parsed = sourceEdits.safeParse(input);
    return parsed.success
      ? { format, outcome: 'edit', edits: parsed.data.edits }
      : { format, outcome: 'invalid_edit' };
  }
  if (name === 'look_up_manim') {
    const parsed = manimLookup.safeParse(input);
    return parsed.success
      ? { format, outcome: 'lookup', lookup: parsed.data }
      : { format, outcome: 'invalid_reference' };
  }
  if (name === 'read_reference') {
    const topics = requestedReferenceTopics(input);
    return topics
      ? { format, outcome: 'reference', topics }
      : { format, outcome: 'invalid_reference' };
  }
  if (name === 'submit_scene') return candidate(format, input);
  return { format, outcome: 'unsupported_tool' };
}

function jsonSubmission(text: string, format: Format): Extraction {
  const decoded = parseJson(text);
  if (decoded === undefined) return { format, outcome: 'malformed_json' };
  if (!isObject(decoded)) return { format, outcome: 'invalid_envelope' };
  const { tool, ...input } = decoded;
  return envelope(format, Object.hasOwn(decoded, 'tool') ? tool : 'submit_scene', input);
}

function pythonSubmission(source: string, format: Format): Extraction {
  if (editHeader.test(source)) return plainEdits(source, format);
  const header = cueHeader.exec(source);
  if (!header) return { format, outcome: 'missing_cue_metadata', source };
  // Keep the comment in the module so publisher line numbers match the reply.
  return candidate(format, { source, segments: parseJson(header[1]) });
}

function plainEdits(source: string, format: Format): Extraction {
  const lines = source.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  const edits: Edits = [];
  let replacement: string[] = [];
  for (const line of lines) {
    if (line.startsWith('# sahaya-edit:')) {
      const match = /^# sahaya-edit: (\d{1,5})-(\d{1,5})[ \t]*$/.exec(line);
      if (!match || edits.length === 3) return { format, outcome: 'invalid_edit' };
      const previous = edits.at(-1);
      if (previous) previous.replacement = replacement.join('\n');
      edits.push({ start: Number(match[1]), end: Number(match[2]), replacement: '' });
      replacement = [];
    } else replacement.push(line);
  }
  const last = edits.at(-1);
  if (last) last.replacement = replacement.join('\n');
  return envelope(format, 'edit_scene', { edits });
}

export function extractSubmission(reply: Reply): Extraction {
  const { text, toolCalls } = reply;
  if (Buffer.byteLength(text) > responseLimit)
    return { format: 'unknown', outcome: 'response_too_large' };
  if (toolCalls?.length) {
    if (toolCalls.length !== 1) return { format: 'native-tool', outcome: 'ambiguous_response' };
    return envelope('native-tool', toolCalls[0].toolName, toolCalls[0].input);
  }
  const trimmed = text.trim();
  if (!trimmed) return { format: 'unknown', outcome: 'empty' };
  if (editHeader.test(text)) return plainEdits(text, 'python');
  if (cueHeader.test(text)) return pythonSubmission(text, 'python');
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return jsonSubmission(trimmed, 'json');
  const fences = [...text.matchAll(fenceLine)];
  if (fences.length) {
    const [open, close] = fences;
    if (
      fences.length !== 2 ||
      close[1][0] !== open[1][0] ||
      close[1].length < open[1].length ||
      close[2].trim()
    )
      return {
        format: 'unknown',
        outcome: fences.length > 2 ? 'ambiguous_response' : 'invalid_envelope',
      };
    // Allow surrounding prose around a single block. A second container
    // outside it is ambiguous. Never strip indentation from the code block.
    const exterior = text.slice(0, open.index) + '\n' + text.slice(close.index + close[0].length);
    if (cueHeader.test(exterior) || sceneClass.test(exterior) || /^[ \t]*[\[{]/m.test(exterior))
      return { format: 'unknown', outcome: 'ambiguous_response' };
    const source = text.slice(open.index + open[0].length + 1, close.index);
    const language = open[2].trim().toLowerCase();
    if (language === 'json' || (!language && source.trimStart().startsWith('{')))
      return jsonSubmission(source, 'fenced-json');
    if (
      language === 'python' ||
      language === 'py' ||
      (!language && (cueHeader.test(source) || sceneClass.test(source) || editHeader.test(source)))
    )
      return pythonSubmission(source, 'fenced-python');
    return { format: 'unknown', outcome: 'unsupported_format' };
  }
  return sceneClass.test(text)
    ? pythonSubmission(text, 'python')
    : { format: 'unknown', outcome: 'unsupported_format' };
}

export function editableSource(source: string) {
  const lines = source.split('\n');
  const { marker, length } = sceneHeader(source);
  const firstLine = source.slice(0, length).split('\n').length;
  const tail = marker ? source.lastIndexOf(scaffoldStart) : -1;
  const lastLine = tail < 0 ? lines.length : source.slice(0, tail).split('\n').length - 1;
  return { lines, firstLine, lastLine };
}

export function applySceneEdits(
  previous: Candidate,
  edits: Edits,
  window: { firstLine: number; lastLine: number },
) {
  const { lines, firstLine, lastLine } = editableSource(previous.source);
  if (window.firstLine < firstLine || window.lastLine > lastLine) return undefined;
  let next = window.lastLine + 2;
  for (const { start, end, replacement } of [...edits].sort((a, b) => b.start - a.start)) {
    if (
      start < window.firstLine ||
      start > window.lastLine + 1 ||
      start >= next ||
      end < start - 1 ||
      end > window.lastLine ||
      end >= next ||
      /^\s*# sahaya-(?:cues|scene|edit):/m.test(replacement)
    )
      return undefined;
    const editedLines = replacement ? replacement.split(/\r?\n/) : [];
    const ending = /\r\n/.test(previous.source) ? '\r' : '';
    lines.splice(start - 1, end - start + 1, ...editedLines.map((line) => line + ending));
    next = start;
  }
  const source = lines.join('\n');
  if (
    source === previous.source ||
    !sourceSubmission.safeParse({ source, segments: previous.segments }).success
  )
    return undefined;
  return { source, segments: previous.segments };
}
