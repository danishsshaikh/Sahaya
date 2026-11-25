import { z } from 'zod';
import { manimLookup, requestedReferenceTopics, sourceSubmission } from './agent-tools';
import type { Lookup } from './knowledge';
import type { ReferenceTopic } from './skill';

export type Candidate = z.infer<typeof sourceSubmission>;
export const SUBMISSION_FORMAT = `Write a complete Python module as plain text. The first line must be a single Python comment: # sahaya-cues: [{"id":"intro","narration":"One sentence."}]. Write Python on real lines after the comment and use the same ordered cue IDs. Optional caption strings belong in the cue array. Return the module only.`;
const cueHeader = /^\uFEFF?(?:[ \t]*\r?\n)*# sahaya-cues:[ \t]*([^\r\n]*)(?:\r?\n|$)/;
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
} as const;
type Rejection = keyof typeof rejectionMessages;
export function formatFeedback(code: Rejection) {
  return { code, message: rejectionMessages[code] };
}

type Extraction = { format: Format } & (
  | { outcome: 'submitted'; candidate: Candidate }
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
  const checked = sourceSubmission.safeParse(input);
  return checked.success
    ? { format, outcome: 'submitted', candidate: checked.data }
    : { format, outcome: 'invalid_cue_metadata', source };
}

function envelope(format: Format, name: unknown, input: unknown): Extraction {
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
  const header = cueHeader.exec(source);
  if (!header) return { format, outcome: 'missing_cue_metadata', source };
  // Keep the comment in the module so publisher line numbers match the reply.
  return candidate(format, { source, segments: parseJson(header[1]) });
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
      (!language && (cueHeader.test(source) || sceneClass.test(source)))
    )
      return pythonSubmission(source, 'fenced-python');
    return { format: 'unknown', outcome: 'unsupported_format' };
  }
  return sceneClass.test(text)
    ? pythonSubmission(text, 'python')
    : { format: 'unknown', outcome: 'unsupported_format' };
}
