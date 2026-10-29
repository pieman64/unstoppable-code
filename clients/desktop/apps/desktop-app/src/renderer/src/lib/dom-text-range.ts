/**
 * Locate a substring within the rendered text of a container and return a DOM
 * `Range` covering it — even when the match spans multiple text nodes (common
 * for rendered markdown with inline formatting). Whitespace must match the
 * concatenated text-node content, so this resolves single-block selections
 * reliably and degrades gracefully for cross-block ones (returns null).
 *
 * Works in the container's own document, so a panel popped out into another
 * window (a separate JS realm) resolves ranges in that window's document.
 */

interface TextLocation {
  node: Text;
  offset: number;
}

/** Realm-safe text-node check (`instanceof Text` fails across windows). */
function isTextNode(node: Node): node is Text {
  return node.nodeType === Node.TEXT_NODE;
}

function locate(
  nodes: Text[],
  starts: number[],
  position: number,
): TextLocation | null {
  for (let i = 0; i < nodes.length; i += 1) {
    const start = starts[i];
    const end = start + nodes[i].data.length;
    if (position >= start && position <= end) {
      return { node: nodes[i], offset: position - start };
    }
  }
  return null;
}

export function findTextRange(
  container: HTMLElement,
  text: string,
): Range | null {
  if (text.length === 0) {
    return null;
  }
  const ownerDocument = container.ownerDocument;
  const walker = ownerDocument.createTreeWalker(
    container,
    NodeFilter.SHOW_TEXT,
  );
  const nodes: Text[] = [];
  const starts: number[] = [];
  let full = '';
  let current = walker.nextNode();
  while (current) {
    if (
      isTextNode(current) &&
      !current.parentElement?.closest('[data-markdown-generated]')
    ) {
      starts.push(full.length);
      nodes.push(current);
      full += current.data;
    }
    current = walker.nextNode();
  }

  const index = full.indexOf(text);
  if (index < 0) {
    return null;
  }
  const startLocation = locate(nodes, starts, index);
  const endLocation = locate(nodes, starts, index + text.length);
  if (!startLocation || !endLocation) {
    return null;
  }
  const range = ownerDocument.createRange();
  range.setStart(startLocation.node, startLocation.offset);
  range.setEnd(endLocation.node, endLocation.offset);
  return range;
}

/** True when both range endpoints are still attached inside `container`. */
export function isRangeInContainer(
  range: Range,
  container: HTMLElement,
): boolean {
  return (
    range.startContainer.isConnected &&
    container.contains(range.startContainer) &&
    container.contains(range.endContainer)
  );
}

/** True when the viewport point falls within any client rect of the range. */
export function rangeContainsPoint(
  range: Range,
  x: number,
  y: number,
): boolean {
  const rects = range.getClientRects();
  for (let i = 0; i < rects.length; i += 1) {
    const rect = rects[i];
    if (
      x >= rect.left &&
      x <= rect.right &&
      y >= rect.top &&
      y <= rect.bottom
    ) {
      return true;
    }
  }
  return false;
}
