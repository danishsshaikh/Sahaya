export interface NarrationCue {
  startOffset: number;
  endOffset: number;
  startMs: number;
  endMs: number;
}

export interface NarrationTiming {
  startOffset: number;
  endOffset: number;
  startMs: number;
  endMs: number;
}

const WORD_RE = /\S+/g;
const SENTENCE_END_RE = /[.!?]["')\]}]*$/;
const PHRASE_END_RE = /[,;:]["')\]}]*$/;

function tokenWeight(token: string): number {
  const wordLength = token.replace(/[^\p{L}\p{N}]/gu, '').length;
  return (
    1 +
    Math.min(wordLength, 12) * 0.08 +
    (SENTENCE_END_RE.test(token) ? 0.7 : 0) +
    (PHRASE_END_RE.test(token) ? 0.3 : 0)
  );
}

export function createEstimatedNarrationCues(text: string, durationMs: number): NarrationCue[] {
  if (!text.trim() || !Number.isFinite(durationMs) || durationMs <= 0) return [];
  const tokens = [...text.matchAll(WORD_RE)].map((match) => ({
    text: match[0],
    startOffset: match.index,
    endOffset: match.index + match[0].length,
    weight: tokenWeight(match[0]),
  }));
  if (tokens.length === 0) return [];

  const phrases: Array<{
    startOffset: number;
    endOffset: number;
    weight: number;
  }> = [];
  let phraseStart = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const phraseLength = index - phraseStart + 1;
    const atBoundary =
      SENTENCE_END_RE.test(tokens[index].text) || PHRASE_END_RE.test(tokens[index].text);
    if (phraseLength < 4 && !atBoundary && index < tokens.length - 1) continue;

    const group = tokens.slice(phraseStart, index + 1);
    phrases.push({
      startOffset: group[0].startOffset,
      endOffset: group[group.length - 1].endOffset,
      weight: group.reduce((sum, token) => sum + token.weight, 0),
    });
    phraseStart = index + 1;
  }
  if (phraseStart < tokens.length) {
    const group = tokens.slice(phraseStart);
    phrases.push({
      startOffset: group[0].startOffset,
      endOffset: group[group.length - 1].endOffset,
      weight: group.reduce((sum, token) => sum + token.weight, 0),
    });
  }

  const totalWeight = phrases.reduce((sum, phrase) => sum + phrase.weight, 0);
  let elapsed = 0;
  return phrases.map((phrase, index) => {
    const startMs = elapsed;
    elapsed =
      index === phrases.length - 1
        ? durationMs
        : elapsed + (durationMs * phrase.weight) / totalWeight;
    return { ...phrase, startMs, endMs: elapsed };
  });
}

export function resolveNarrationCues(input: {
  text: string;
  durationMs: number;
  timings?: readonly NarrationTiming[];
}): NarrationCue[] {
  const validTimings = input.timings?.filter(
    (timing) =>
      timing.startOffset >= 0 &&
      timing.endOffset > timing.startOffset &&
      timing.endOffset <= input.text.length &&
      timing.startMs >= 0 &&
      timing.endMs > timing.startMs,
  );
  return validTimings?.length
    ? validTimings.map((timing) => ({ ...timing }))
    : createEstimatedNarrationCues(input.text, input.durationMs);
}

export function findNarrationCueIndex(
  cues: readonly NarrationCue[],
  currentTimeMs: number,
): number {
  if (cues.length === 0 || !Number.isFinite(currentTimeMs) || currentTimeMs < 0) return -1;
  let low = 0;
  let high = cues.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const cue = cues[middle];
    if (currentTimeMs < cue.startMs) high = middle - 1;
    else if (currentTimeMs >= cue.endMs) low = middle + 1;
    else return middle;
  }
  return -1;
}

export interface ActiveNarrationHighlight {
  sceneId: string;
  actionIndex: number;
  actionId: string;
  text: string;
  cue: NarrationCue;
}
