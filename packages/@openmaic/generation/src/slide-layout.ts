import type { PPTElement, PPTTextElement } from '@openmaic/dsl';
import type { GenerationLogger } from './logger.js';

const CANVAS_WIDTH = 1000;
const CANVAS_HEIGHT = 562.5;
const SAFE_MARGIN_X = 48;
const SAFE_MARGIN_Y = 30;
const TITLE_TOP = 30;
const TITLE_HEIGHT = 64;
const CONTENT_TOP = 118;
const CONTENT_BOTTOM = CANVAS_HEIGHT - 38;
const GUTTER = 22;
const MIN_CARD_HEIGHT = 74;
const MIN_MEDIA_HEIGHT = 110;

type BoxElement = Exclude<PPTElement, Extract<PPTElement, { type: 'line' }>>;

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface SlideLayoutRepairSummary {
  repaired: boolean;
  reasons: string[];
  elementCount: number;
}

export interface SlideLayoutRepairResult {
  elements: PPTElement[];
  summary: SlideLayoutRepairSummary;
}

function isBoxElement(element: PPTElement): element is BoxElement {
  return (
    element.type !== 'line' &&
    Number.isFinite(element.left) &&
    Number.isFinite(element.top) &&
    Number.isFinite(element.width) &&
    Number.isFinite(element.height)
  );
}

function boxOf(element: BoxElement): Box {
  return {
    left: element.left,
    top: element.top,
    width: element.width,
    height: element.height,
  };
}

function overlaps(a: Box, b: Box): number {
  const width = Math.max(
    0,
    Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left),
  );
  const height = Math.max(0, Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top));
  return width * height;
}

function boxArea(box: Box): number {
  return Math.max(0, box.width) * Math.max(0, box.height);
}

function outsideSafeArea(box: Box): boolean {
  return (
    box.left < SAFE_MARGIN_X - 6 ||
    box.top < SAFE_MARGIN_Y - 6 ||
    box.left + box.width > CANVAS_WIDTH - SAFE_MARGIN_X + 6 ||
    box.top + box.height > CANVAS_HEIGHT - SAFE_MARGIN_Y + 6 ||
    box.width < 24 ||
    box.height < 18
  );
}

function plainText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizedHeadingText(element: PPTTextElement): string {
  return plainText(element.content)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function isTitleCandidate(element: BoxElement): element is PPTTextElement {
  if (element.type !== 'text') return false;
  if (element.textType === 'title' || element.textType === 'header') return true;
  const text = plainText(element.content);
  return element.top <= CONTENT_TOP - 18 && text.length > 0 && text.length <= 140;
}

function findTitleElement(elements: BoxElement[]): PPTTextElement | undefined {
  const explicit = elements.find(
    (element): element is PPTTextElement =>
      element.type === 'text' && (element.textType === 'title' || element.textType === 'header'),
  );
  if (explicit) return explicit;
  return elements.find(isTitleCandidate);
}

function detectLayoutIssues(elements: BoxElement[], title?: PPTTextElement): string[] {
  const reasons = new Set<string>();
  const boxes = elements.map((element) => ({ element, box: boxOf(element) }));

  for (const { element, box } of boxes) {
    if (outsideSafeArea(box)) reasons.add('out-of-safe-area');
    if (element !== title && box.top < CONTENT_TOP - 8) reasons.add('content-in-title-band');
  }

  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i]!;
      const b = boxes[j]!;
      const overlapArea = overlaps(a.box, b.box);
      if (overlapArea === 0) continue;
      const smaller = Math.max(1, Math.min(boxArea(a.box), boxArea(b.box)));
      if (overlapArea / smaller > 0.12 || overlapArea > 900) {
        reasons.add('overlapping-elements');
      }
    }
  }

  const titleTexts = elements
    .filter(isTitleCandidate)
    .map((element) => normalizedHeadingText(element))
    .filter((text) => text.length > 0);
  if (new Set(titleTexts).size < titleTexts.length) reasons.add('duplicate-title-candidates');

  return [...reasons];
}

function preferredColumns(count: number): number {
  if (count <= 2) return 1;
  if (count <= 6) return 2;
  return 3;
}

function elementMinHeight(element: BoxElement): number {
  if (element.type === 'image' || element.type === 'video' || element.type === 'chart') {
    return MIN_MEDIA_HEIGHT;
  }
  if (element.type === 'latex') return 58;
  return MIN_CARD_HEIGHT;
}

function reflowContentElements(elements: BoxElement[]): BoxElement[] {
  if (elements.length === 0) return [];

  const columns = preferredColumns(elements.length);
  const rows = Math.ceil(elements.length / columns);
  const availableWidth = CANVAS_WIDTH - SAFE_MARGIN_X * 2;
  const availableHeight = CONTENT_BOTTOM - CONTENT_TOP;
  const cellWidth = (availableWidth - GUTTER * (columns - 1)) / columns;
  const cellHeight = (availableHeight - GUTTER * (rows - 1)) / rows;

  return elements.map((element, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const minHeight = elementMinHeight(element);
    const height = Math.max(48, Math.min(cellHeight, Math.max(minHeight, element.height)));
    const top = Math.min(CONTENT_BOTTOM - height, CONTENT_TOP + row * (cellHeight + GUTTER));
    return {
      ...element,
      left: Math.round(SAFE_MARGIN_X + column * (cellWidth + GUTTER)),
      top: Math.round(top),
      width: Math.round(cellWidth),
      height: Math.round(height),
      rotate: 0,
    } as BoxElement;
  });
}

function reflowTitleElement(title: PPTTextElement): PPTTextElement {
  return {
    ...title,
    left: SAFE_MARGIN_X,
    top: TITLE_TOP,
    width: CANVAS_WIDTH - SAFE_MARGIN_X * 2,
    height: TITLE_HEIGHT,
    rotate: 0,
    vAlign: title.vAlign ?? 'middle',
  };
}

export function repairGeneratedSlideLayout(
  elements: PPTElement[],
  logger?: Pick<GenerationLogger, 'warn'>,
): SlideLayoutRepairResult {
  const boxElements = elements.filter(isBoxElement);
  const title = findTitleElement(boxElements);
  const reasons = detectLayoutIssues(boxElements, title);
  if (reasons.length === 0) {
    return {
      elements,
      summary: { repaired: false, reasons: [], elementCount: elements.length },
    };
  }

  const titleId = title?.id;
  const reflowedById = new Map<string, PPTElement>();
  if (title) reflowedById.set(title.id, reflowTitleElement(title));

  const contentElements = boxElements.filter((element) => element.id !== titleId);
  for (const element of reflowContentElements(contentElements)) {
    reflowedById.set(element.id, element);
  }

  const repaired = elements.map((element) => reflowedById.get(element.id) ?? element);
  logger?.warn(
    `Repaired generated slide layout (${reasons.join(', ')}) for ${boxElements.length} visible element(s)`,
  );
  return {
    elements: repaired,
    summary: { repaired: true, reasons, elementCount: elements.length },
  };
}
