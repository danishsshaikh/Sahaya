import katex from 'katex';

const MARKDOWN_BOLD_PATTERN = /\*\*([^*\n]+(?:\*(?!\*)[^*\n]*)*)\*\*/g;
const LATEX_ARROW_PATTERN =
  /\$?\\{1,2}(leftrightarrow|rightarrow|leftarrow|Rightarrow|to)(?![A-Za-z])\$?/g;
const SKIP_INLINE_MARKDOWN_TAGS = new Set(['code', 'pre', 'kbd', 'samp']);
const MATH_DELIMITERS = [
  { open: '$$', close: '$$', displayMode: true },
  { open: '\\[', close: '\\]', displayMode: true },
  { open: '\\(', close: '\\)', displayMode: false },
  { open: '$', close: '$', displayMode: false },
] as const;
const LATEX_COMMAND_RE = /\\[a-zA-Z]+/;
const INLINE_OPERATOR_RE = /[A-Za-z0-9)\]}]\s*[+\-*/]\s*[A-Za-z0-9({\\]/;
const FORMULA_CHAR_RE = /^[\s0-9A-Za-z\\{}()[\]^_+\-*/=<>≤≥≈.,:;|!%√πθαβγδελμνρσφωΑΒΓΔΘΛΜΝΠΡΣΦΩ]+$/;
const EQUATION_OR_POWER_RE = /[=<>≤≥≈^_]/;
const SINGLE_SYMBOL_RE = /^(?:[A-Za-z]|\\[a-zA-Z]+|\d+(?:\.\d+)?)$/;
const WORD_RE = /[A-Za-z]{3,}/g;
const MATH_TRIGGER_RE = /(?:^|[^\\])(?:\$\$?|\s*\\[([])/;

function formatInlineMarks(segment: string): string {
  const marked = segment
    .replace(LATEX_ARROW_PATTERN, (_match, command: string) => {
      switch (command) {
        case 'leftarrow':
          return '←';
        case 'leftrightarrow':
          return '↔';
        case 'Rightarrow':
          return '⇒';
        case 'rightarrow':
        case 'to':
        default:
          return '→';
      }
    })
    .replace(MARKDOWN_BOLD_PATTERN, '<strong>$1</strong>');

  return renderDelimitedMath(marked);
}

function formatTextSegment(segment: string): string {
  return formatGeneratedListSegment(segment) ?? formatInlineMarks(segment).replace(/\n/g, '<br>');
}

function formatGeneratedListSegment(segment: string): string | null {
  const trimmed = segment.trim();
  if (!trimmed) return null;

  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length > 1) {
    const ordered = lines.map(parseOrderedListLine);
    if (ordered.every(Boolean)) {
      const start = ordered[0]?.number ?? 1;
      return `<ol${start === 1 ? '' : ` start="${start}"`}>${ordered
        .map((item) => `<li>${formatInlineMarks(item!.text)}</li>`)
        .join('')}</ol>`;
    }

    const unordered = lines.map(parseUnorderedListLine);
    if (unordered.every(Boolean)) {
      return `<ul>${unordered.map((item) => `<li>${formatInlineMarks(item!)}</li>`).join('')}</ul>`;
    }

    return lines.map(formatInlineMarks).join('<br>');
  }

  const bulletList = parseInlineBulletList(trimmed);
  if (bulletList) {
    const prefix = bulletList.prefix ? `${formatInlineMarks(bulletList.prefix)}<br>` : '';
    return `${prefix}<ul>${bulletList.items
      .map((item) => `<li>${formatInlineMarks(item)}</li>`)
      .join('')}</ul>`;
  }

  return null;
}

function parseInlineBulletList(text: string): { prefix: string; items: string[] } | null {
  const bulletCount = (text.match(/•/g) ?? []).length;
  if (bulletCount === 0) return null;
  if (!text.trimStart().startsWith('•') && bulletCount < 2) return null;

  const firstBullet = text.indexOf('•');
  const prefix = text.slice(0, firstBullet).trim();
  const items = text
    .slice(firstBullet)
    .split(/\s*•\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? { prefix, items } : null;
}

function parseUnorderedListLine(line: string): string | null {
  return /^(?:[-*]\s+|•\s*)(.+)$/.exec(line)?.[1]?.trim() ?? null;
}

function parseOrderedListLine(line: string): { number: number; text: string } | null {
  const match = /^(\d+)[.)]\s+(.+)$/.exec(line);
  if (!match) return null;
  return { number: Number(match[1]), text: match[2].trim() };
}

function renderDelimitedMath(value: string): string {
  if (!MATH_TRIGGER_RE.test(value)) return value;

  const output: string[] = [];
  let cursor = 0;

  while (cursor < value.length) {
    const opening = findNextDelimiter(value, cursor);
    if (!opening) break;

    output.push(value.slice(cursor, opening.index));
    const mathStart = opening.index + opening.delimiter.open.length;
    const closeIndex = findUnescaped(value, opening.delimiter.close, mathStart);
    if (closeIndex === -1) {
      output.push(value.slice(opening.index));
      cursor = value.length;
      break;
    }

    const raw = value.slice(opening.index, closeIndex + opening.delimiter.close.length);
    const latex = value.slice(mathStart, closeIndex).trim();
    const tooLong = latex.length > 500;
    const shouldRender =
      latex.length > 0 &&
      !tooLong &&
      (opening.delimiter.open !== '$' || isLikelyDelimitedMathText(latex));
    const html = shouldRender ? renderLatex(latex, opening.delimiter.displayMode) : null;
    output.push(
      html ?? (tooLong ? '<span class="slide-math-unavailable">Formula unavailable</span>' : raw),
    );
    cursor = closeIndex + opening.delimiter.close.length;
  }

  output.push(value.slice(cursor));
  return output.join('');
}

function renderLatex(value: string, displayMode: boolean): string | null {
  try {
    return katex.renderToString(escapeLiteralPercents(value), {
      displayMode,
      output: 'html',
      strict: false,
      throwOnError: true,
    });
  } catch {
    return null;
  }
}

function escapeLiteralPercents(value: string): string {
  let escaped = '';
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== '%') {
      escaped += value[index];
      continue;
    }
    escaped += isEscaped(value, index) ? '%' : '\\%';
  }
  return escaped;
}

function isLikelyDelimitedMathText(value: string): boolean {
  const text = value.trim();
  if (!text || !FORMULA_CHAR_RE.test(text)) return false;
  if (SINGLE_SYMBOL_RE.test(text)) return true;
  if (LATEX_COMMAND_RE.test(text) || EQUATION_OR_POWER_RE.test(text)) return true;
  if (INLINE_OPERATOR_RE.test(text) && (text.match(WORD_RE) ?? []).length <= 1) return true;
  return false;
}

function findNextDelimiter(
  value: string,
  startIndex: number,
): { delimiter: (typeof MATH_DELIMITERS)[number]; index: number } | null {
  let match: { delimiter: (typeof MATH_DELIMITERS)[number]; index: number } | null = null;

  for (const delimiter of MATH_DELIMITERS) {
    const index = findUnescaped(value, delimiter.open, startIndex);
    if (index === -1) continue;
    if (
      !match ||
      index < match.index ||
      (index === match.index && delimiter.open.length > match.delimiter.open.length)
    ) {
      match = { delimiter, index };
    }
  }

  return match;
}

function findUnescaped(value: string, search: string, startIndex: number): number {
  let index = value.indexOf(search, startIndex);
  while (index !== -1) {
    if (!isEscaped(value, index)) return index;
    index = value.indexOf(search, index + search.length);
  }
  return -1;
}

function isEscaped(value: string, index: number): boolean {
  let slashCount = 0;
  for (let i = index - 1; i >= 0 && value[i] === '\\'; i -= 1) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
}

function shouldSkipFormattingTag(token: string, tag: string): boolean {
  return SKIP_INLINE_MARKDOWN_TAGS.has(tag) || /\bclass\s*=\s*["'][^"']*\bkatex\b/i.test(token);
}

export function formatInlineMarkdownBold(html: string): string {
  if (!/[\\*$\n•]|<br\s*\/?>|(?:^|\n)\s*(?:[-*]|\d+[.)])\s+/i.test(html)) return html;

  const tokens = html.split(/(<\/?[^>]+>)/g);
  const tagStack: string[] = [];
  let textBuffer = '';
  const output: string[] = [];

  const flushText = () => {
    if (!textBuffer) return;
    output.push(formatTextSegment(textBuffer));
    textBuffer = '';
  };

  for (const token of tokens) {
    if (!token) continue;
    if (token.startsWith('<') && token.endsWith('>')) {
      if (/^<\s*br\s*\/?\s*>$/i.test(token) && tagStack.length === 0) {
        textBuffer += '\n';
        continue;
      }

      flushText();
      const closing = /^<\s*\/\s*([a-z0-9-]+)/i.exec(token);
      if (closing) {
        const tag = closing[1].toLowerCase();
        const idx = tagStack.lastIndexOf(tag);
        if (idx >= 0) tagStack.splice(idx, 1);
        output.push(token);
        continue;
      }

      const opening = /^<\s*([a-z0-9-]+)/i.exec(token);
      if (opening && !/\/\s*>$/.test(token)) {
        const tag = opening[1].toLowerCase();
        if (shouldSkipFormattingTag(token, tag)) tagStack.push(tag);
      }
      output.push(token);
      continue;
    }

    if (tagStack.length > 0) {
      flushText();
      output.push(token);
    } else {
      textBuffer += token;
    }
  }

  flushText();
  return output.join('');
}
