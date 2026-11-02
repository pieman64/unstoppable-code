/**
 * Copying rendered Markdown math (CAN-5012). KaTeX renders each formula as
 * visible HTML plus hidden MathML, so a native copy of `\(R(3,3)\)` would
 * paste "R ( 3 , 3 ) R(3,3)". These helpers swap each formula a selection
 * touches for its original delimited TeX source.
 *
 */

/** The class every rendered formula container carries. */
export const MATH_CONTAINER_CLASS = 'canopy-markdown-math-container';

/** The container attribute that holds the formula's delimited TeX source. */
export const MATH_SOURCE_ATTRIBUTE = 'data-math-source';

const MATH_CONTAINER_SELECTOR = `.${MATH_CONTAINER_CLASS}`;
const START_TO_START = 0;

interface BoundaryPoint {
  node: Node;
  offset: number;
}

interface MathContainerSelection {
  container: Element;
  source: string;
}

const documentsWithCopyListener = new WeakSet<Document>();

function isElement(node: Node | null): node is Element {
  return node?.nodeType === 1;
}

function isQueryRoot(node: Node): node is Node & ParentNode {
  return node.nodeType === 1 || node.nodeType === 9 || node.nodeType === 11;
}

function getQueryRoot(node: Node): (Node & ParentNode) | null {
  if (isQueryRoot(node)) return node;
  return node.parentElement;
}

function hasMathContainerAncestor(element: Element): boolean {
  let ancestor = element.parentElement;
  while (ancestor) {
    if (ancestor.matches(MATH_CONTAINER_SELECTOR)) return true;
    ancestor = ancestor.parentElement;
  }
  return false;
}

function outermostMathContainerAncestor(node: Node | null): Element | null {
  let current: Element | null = isElement(node)
    ? node
    : (node?.parentElement ?? null);
  let outermost: Element | null = null;
  while (current) {
    if (current.matches(MATH_CONTAINER_SELECTOR)) outermost = current;
    current = current.parentElement;
  }
  return outermost;
}

function topLevelMathContainers(rootNode: Node): Element[] {
  const root = getQueryRoot(rootNode);
  if (!root) return [];

  const containers: Element[] = [];
  if (isElement(root) && root.matches(MATH_CONTAINER_SELECTOR)) {
    containers.push(root);
  }
  containers.push(
    ...Array.from(root.querySelectorAll<Element>(MATH_CONTAINER_SELECTOR)),
  );
  return containers.filter((container) => !hasMathContainerAncestor(container));
}

function comparePoints(
  referenceRange: Range,
  left: BoundaryPoint,
  right: BoundaryPoint,
): number {
  const leftRange = referenceRange.cloneRange();
  leftRange.setStart(left.node, left.offset);
  leftRange.collapse(true);

  const rightRange = referenceRange.cloneRange();
  rightRange.setStart(right.node, right.offset);
  rightRange.collapse(true);

  return leftRange.compareBoundaryPoints(START_TO_START, rightRange);
}

function compareDocumentOrder(left: Element, right: Element): number {
  const position = left.compareDocumentPosition(right);
  if (position & 4) return -1;
  if (position & 2) return 1;
  return 0;
}

function intersectingMathContainers(range: Range): MathContainerSelection[] {
  const candidates = new Set<Element>(
    topLevelMathContainers(range.commonAncestorContainer),
  );
  const startAncestor = outermostMathContainerAncestor(range.startContainer);
  const endAncestor = outermostMathContainerAncestor(range.endContainer);
  if (startAncestor) candidates.add(startAncestor);
  if (endAncestor) candidates.add(endAncestor);

  const containers: MathContainerSelection[] = [];
  for (const container of candidates) {
    const source = container.getAttribute(MATH_SOURCE_ATTRIBUTE);
    if (
      source === null ||
      hasMathContainerAncestor(container) ||
      !range.intersectsNode(container)
    ) {
      continue;
    }
    containers.push({ container, source });
  }
  containers.sort((left, right) =>
    compareDocumentOrder(left.container, right.container),
  );
  return containers;
}

function elementBoundaryPoints(
  element: Element,
): { before: BoundaryPoint; after: BoundaryPoint } | null {
  const parent = element.parentNode;
  if (!parent) return null;
  const index = Array.from(parent.childNodes).indexOf(element);
  if (index < 0) return null;
  return {
    before: { node: parent, offset: index },
    after: { node: parent, offset: index + 1 },
  };
}

function serializeSegment(
  selection: Selection,
  range: Range,
  start: BoundaryPoint,
  end: BoundaryPoint,
): string {
  if (comparePoints(range, start, end) >= 0) return '';
  selection.setBaseAndExtent(start.node, start.offset, end.node, end.offset);
  return selection.toString();
}

function rangeTextWithMathSources(
  selection: Selection,
  range: Range,
  containers: MathContainerSelection[],
): string {
  let result = '';
  let cursor: BoundaryPoint = {
    node: range.startContainer,
    offset: range.startOffset,
  };

  for (const { container, source } of containers) {
    const boundaries = elementBoundaryPoints(container);
    if (!boundaries) continue;

    if (comparePoints(range, cursor, boundaries.before) < 0) {
      result += serializeSegment(selection, range, cursor, boundaries.before);
    }
    result += source;
    cursor = boundaries.after;
  }

  const rangeEnd: BoundaryPoint = {
    node: range.endContainer,
    offset: range.endOffset,
  };
  if (comparePoints(range, cursor, rangeEnd) < 0) {
    result += serializeSegment(selection, range, cursor, rangeEnd);
  }
  return result;
}

function selectionRanges(selection: Selection): Range[] {
  return Array.from({ length: selection.rangeCount }, (_, index) =>
    selection.getRangeAt(index).cloneRange(),
  );
}

function restoreSelection(
  selection: Selection,
  ranges: Range[],
  anchorNode: Node | null,
  anchorOffset: number,
  focusNode: Node | null,
  focusOffset: number,
): void {
  if (ranges.length === 1 && anchorNode && focusNode) {
    selection.setBaseAndExtent(
      anchorNode,
      anchorOffset,
      focusNode,
      focusOffset,
    );
    return;
  }

  selection.removeAllRanges();
  for (const range of ranges) selection.addRange(range);
}

/**
 * The selection's text with every formula container it intersects replaced
 * by that formula's `data-math-source`. Returns `selection.toString()`
 * unchanged when no formula is selected.
 */
export function selectionTextWithMathSource(selection: Selection): string {
  const originalText = selection.toString();
  if (selection.isCollapsed || selection.rangeCount === 0) return originalText;

  const ranges = selectionRanges(selection);
  const containersByRange = ranges.map(intersectingMathContainers);
  if (!containersByRange.some((containers) => containers.length > 0)) {
    return originalText;
  }

  const anchorNode = selection.anchorNode;
  const anchorOffset = selection.anchorOffset;
  const focusNode = selection.focusNode;
  const focusOffset = selection.focusOffset;

  try {
    return ranges
      .map((range, index) =>
        rangeTextWithMathSources(
          selection,
          range,
          containersByRange[index] ?? [],
        ),
      )
      .join('');
  } finally {
    restoreSelection(
      selection,
      ranges,
      anchorNode,
      anchorOffset,
      focusNode,
      focusOffset,
    );
  }
}

function rangeIsWithinContainer(range: Range, container: Element): boolean {
  const boundaries = elementBoundaryPoints(container);
  if (!boundaries) return false;
  const start: BoundaryPoint = {
    node: range.startContainer,
    offset: range.startOffset,
  };
  const end: BoundaryPoint = {
    node: range.endContainer,
    offset: range.endOffset,
  };
  return (
    comparePoints(range, start, boundaries.before) >= 0 &&
    comparePoints(range, end, boundaries.after) <= 0
  );
}

function htmlForRange(doc: Document, range: Range): DocumentFragment {
  const containers = intersectingMathContainers(range);
  if (
    containers.length === 1 &&
    rangeIsWithinContainer(range, containers[0].container)
  ) {
    const fragment = doc.createDocumentFragment();
    fragment.append(doc.createTextNode(containers[0].source));
    return fragment;
  }

  const fragment = range.cloneContents();
  for (const container of topLevelMathContainers(fragment)) {
    const source = container.getAttribute(MATH_SOURCE_ATTRIBUTE);
    if (source !== null) container.replaceWith(doc.createTextNode(source));
  }
  return fragment;
}

function isEditableContent(element: Element): boolean {
  const computedValue =
    'isContentEditable' in element ? element.isContentEditable : undefined;
  if (typeof computedValue === 'boolean' && computedValue) return true;

  let current: Element | null = element;
  while (current) {
    const value = current.getAttribute('contenteditable');
    if (value !== null) {
      const normalizedValue = value.trim().toLowerCase();
      if (normalizedValue === 'inherit') {
        current = current.parentElement;
        continue;
      }
      if (normalizedValue === 'false') return false;
      if (
        normalizedValue === '' ||
        normalizedValue === 'true' ||
        normalizedValue === 'plaintext-only'
      ) {
        return true;
      }
    }
    current = current.parentElement;
  }
  return false;
}

function activeElementIsEditable(doc: Document): boolean {
  const activeElement = doc.activeElement;
  if (!activeElement) return false;
  if (
    activeElement.localName === 'input' ||
    activeElement.localName === 'textarea'
  ) {
    return true;
  }
  return isEditableContent(activeElement);
}

/**
 * Installs one bubble-phase `copy` listener on `doc` (idempotent per
 * document) that puts formula sources on the clipboard.
 */
export function ensureMathCopyListener(doc: Document): void {
  if (documentsWithCopyListener.has(doc)) return;
  documentsWithCopyListener.add(doc);

  doc.addEventListener(
    'copy',
    (event: ClipboardEvent): void => {
      if (event.defaultPrevented || !event.clipboardData) return;
      if (activeElementIsEditable(doc)) return;

      const selection = doc.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
        return;
      }

      const ranges = selectionRanges(selection);
      if (
        !ranges.some((range) => intersectingMathContainers(range).length > 0)
      ) {
        return;
      }

      const plainText = selectionTextWithMathSource(selection);
      const htmlContainer = doc.createElement('div');
      for (const range of ranges) {
        htmlContainer.append(htmlForRange(doc, range));
      }
      event.clipboardData.setData('text/plain', plainText);
      event.clipboardData.setData('text/html', htmlContainer.innerHTML);
      event.preventDefault();
    },
    false,
  );
}
