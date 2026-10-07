export interface TextSelectionOffsets {
  startOffset: number;
  endOffset: number;
  text: string;
}

export function selectionOffsetsWithin(
  container: HTMLElement,
  selection: Selection | null,
): TextSelectionOffsets | null {
  if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  if (!container.contains(range.commonAncestorContainer)) return null;

  const before = range.cloneRange();
  before.selectNodeContents(container);
  before.setEnd(range.startContainer, range.startOffset);
  const startOffset = before.toString().length;
  const text = range.toString();
  const endOffset = startOffset + text.length;
  if (!text.trim()) return null;
  return { startOffset, endOffset, text };
}

export function isShortPronunciationSelection(selection: TextSelectionOffsets): boolean {
  return selection.text.trim().length <= 120 && selection.text.trim().split(/\s+/u).length <= 12;
}
