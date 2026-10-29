import type { BrowserRectangle } from '@canopy/desktop-shared/types/browser';

/**
 * One node of the pierced `DOM.getDocument({ depth: -1, pierce: true })`
 * tree. This tree is the model's only source of structure: light children,
 * open, closed and user-agent shadow roots, and same-process frame documents.
 * Pseudo-elements, template content and distributed-node lists are dropped.
 */
export interface DomTreeNode {
  /** Frontend ID, valid only until the session's next `DOM.getDocument`. */
  nodeId: number;
  backendNodeId: number;
  nodeType: number;
  nodeName: string;
  nodeValue: string;
  attributes: Record<string, string>;
  /** Set by Chromium on frame owner elements and on each `<html>` element. */
  frameId?: string;
  shadowRootType?: 'open' | 'closed' | 'user-agent';
  children: DomTreeNode[];
  shadowRoots: DomTreeNode[];
  contentDocument?: DomTreeNode;
  /** A `<slot>` with assigned nodes renders them instead of its children. */
  hasAssignedNodes: boolean;
  parent?: DomTreeNode;
}

export interface DecodedDomTree {
  root: DomTreeNode;
  byBackendNodeId: Map<number, DomTreeNode>;
}

/**
 * DOMSnapshot data for one node, looked up by backend node ID. The snapshot
 * walks the flat tree, so it has no shadow-root nodes and omits unslotted
 * light children; it is never used for structure.
 */
export interface SnapshotNodeInfo {
  documentIndex: number;
  /** First layout entry only: Chromium repeats pseudo-element boxes. */
  bounds?: BrowserRectangle;
  /** `clientLeft`, `clientTop`, `clientWidth`, `clientHeight`. */
  clientRect?: BrowserRectangle;
  computedStyles: Record<string, string>;
  inputValue?: string;
  textValue?: string;
  inputChecked: boolean;
  optionSelected: boolean;
  /**
   * The snapshot's own `type` and `autocomplete` attributes. The snapshot is
   * captured at a different instant from `DOM.getDocument`, so secrecy is
   * classified with both.
   */
  type?: string;
  autocomplete?: string;
}

export interface SnapshotDocumentInfo {
  documentIndex: number;
  frameId: string;
  documentURL: string;
  title: string;
  rootBackendNodeId?: number;
  scrollOffsetX: number;
  scrollOffsetY: number;
  contentWidth: number;
  contentHeight: number;
}

/** A whitespace-only text node, positioned by its flat-tree neighbors. */
export interface SnapshotWhitespaceText {
  backendNodeId: number;
  parentBackendNodeId: number;
  /** The previous non-pseudo sibling in the snapshot, if any. */
  previousBackendNodeId?: number;
  value: string;
}

export interface DecodedDOMSnapshot {
  documents: SnapshotDocumentInfo[];
  nodes: Map<number, SnapshotNodeInfo>;
  whitespaceTexts: SnapshotWhitespaceText[];
}

export const PAGE_MODEL_COMPUTED_STYLES: readonly string[] = [
  'display',
  'visibility',
  'opacity',
  'overflow',
  'overflow-x',
  'overflow-y',
  'cursor',
  'pointer-events',
  'position',
  // With clientRects, these give an iframe owner's content-box origin.
  'padding-left',
  'padding-top',
];

const DOM_TREE_MAX_NODES = 1_000_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function arrayValue(value: unknown): unknown[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result: unknown[] = value;
  return result;
}

function readString(
  value: unknown,
  strings: readonly string[],
): string | undefined {
  if (typeof value === 'string') return value;
  if (!isInteger(value)) return undefined;
  if (value === -1) return '';
  if (value < 0) return undefined;
  return strings[value];
}

function decodeAttributeList(
  value: unknown,
): Record<string, string> | undefined {
  if (value === undefined) return {};
  const list = arrayValue(value);
  if (!list || list.length % 2 !== 0) return undefined;
  const attributes: Record<string, string> = {};
  for (let offset = 0; offset < list.length; offset += 2) {
    const name = list[offset];
    const attributeValue = list[offset + 1];
    if (typeof name !== 'string' || typeof attributeValue !== 'string') {
      return undefined;
    }
    if (!Object.prototype.hasOwnProperty.call(attributes, name)) {
      attributes[name] = attributeValue;
    }
  }
  return attributes;
}

function decodeShadowRootType(
  value: unknown,
): DomTreeNode['shadowRootType'] | 'invalid' {
  if (value === undefined) return undefined;
  if (value === 'open' || value === 'closed' || value === 'user-agent') {
    return value;
  }
  return 'invalid';
}

/**
 * Decodes the pierced document tree iteratively, so deep pages cannot exhaust
 * the stack. Any malformed node rejects the whole tree.
 */
export function decodeDomTree(value: unknown): DecodedDomTree | undefined {
  if (!isRecord(value) || !isRecord(value.root)) return undefined;
  const byBackendNodeId = new Map<number, DomTreeNode>();
  interface PendingNode {
    raw: unknown;
    parent?: DomTreeNode;
    slot?: 'child' | 'shadow' | 'document';
  }
  const pending: PendingNode[] = [{ raw: value.root }];
  let root: DomTreeNode | undefined;
  let count = 0;
  while (pending.length > 0) {
    const item = pending.pop();
    if (!item) break;
    count += 1;
    if (count > DOM_TREE_MAX_NODES) return undefined;
    const raw = item.raw;
    if (!isRecord(raw)) return undefined;
    const nodeId = raw.nodeId;
    const backendNodeId = raw.backendNodeId;
    const nodeType = raw.nodeType;
    const nodeName = raw.nodeName;
    if (
      !isInteger(nodeId) ||
      nodeId <= 0 ||
      !isInteger(backendNodeId) ||
      backendNodeId <= 0 ||
      !isInteger(nodeType) ||
      nodeType <= 0 ||
      typeof nodeName !== 'string'
    ) {
      return undefined;
    }
    const attributes = decodeAttributeList(raw.attributes);
    const shadowRootType = decodeShadowRootType(raw.shadowRootType);
    if (!attributes || shadowRootType === 'invalid') return undefined;
    const distributed = arrayValue(raw.distributedNodes);
    const node: DomTreeNode = {
      nodeId,
      backendNodeId,
      nodeType,
      nodeName,
      nodeValue: typeof raw.nodeValue === 'string' ? raw.nodeValue : '',
      attributes,
      ...(typeof raw.frameId === 'string' && raw.frameId.length > 0
        ? { frameId: raw.frameId }
        : {}),
      ...(shadowRootType === undefined ? {} : { shadowRootType }),
      children: [],
      shadowRoots: [],
      hasAssignedNodes: distributed !== undefined && distributed.length > 0,
      ...(item.parent === undefined ? {} : { parent: item.parent }),
    };
    if (!byBackendNodeId.has(backendNodeId)) {
      byBackendNodeId.set(backendNodeId, node);
    }
    const parent = item.parent;
    if (!parent) root = node;
    else if (item.slot === 'shadow') parent.shadowRoots.push(node);
    else if (item.slot === 'document') parent.contentDocument = node;
    else parent.children.push(node);

    const children = raw.children === undefined ? [] : arrayValue(raw.children);
    const shadowRoots =
      raw.shadowRoots === undefined ? [] : arrayValue(raw.shadowRoots);
    if (!children || !shadowRoots) return undefined;
    // Pushed in reverse so each list is appended in document order.
    if (raw.contentDocument !== undefined && raw.contentDocument !== null) {
      pending.push({
        raw: raw.contentDocument,
        parent: node,
        slot: 'document',
      });
    }
    for (let index = children.length - 1; index >= 0; index -= 1) {
      pending.push({ raw: children[index], parent: node, slot: 'child' });
    }
    for (let index = shadowRoots.length - 1; index >= 0; index -= 1) {
      pending.push({ raw: shadowRoots[index], parent: node, slot: 'shadow' });
    }
  }
  if (!root) return undefined;
  return { root, byBackendNodeId };
}

/**
 * Restores whitespace-only text nodes that `DOM.getDocument` omitted (the
 * session's first `DOM.enable` lacked `includeWhitespace: 'all'`) from the
 * snapshot, which always reports them. A node is placed only where the flat
 * tree equals the DOM tree: under an element or document that hosts no
 * author shadow root and is not a slot with assigned nodes, or directly in a
 * host's shadow root. Returns the number of restored nodes.
 */
export function restoreWhitespaceText(
  tree: DecodedDomTree,
  whitespaceTexts: readonly SnapshotWhitespaceText[],
): number {
  // Group by container, then rebuild each child list once: linear in the
  // number of children and restored nodes, however wide a sibling list is.
  interface Insertions {
    atStart: DomTreeNode[];
    /** Nodes to place after the child (or restored node) with this ID. */
    after: Map<number, DomTreeNode[]>;
    known: Set<number>;
  }
  const byContainer = new Map<DomTreeNode, Insertions>();
  let restored = 0;
  for (const text of whitespaceTexts) {
    if (tree.byBackendNodeId.has(text.backendNodeId)) continue;
    const flatParent = tree.byBackendNodeId.get(text.parentBackendNodeId);
    if (!flatParent || flatParent.hasAssignedNodes) continue;
    const authorRoot = flatParent.shadowRoots.find(
      (root) => root.shadowRootType !== 'user-agent',
    );
    const container = authorRoot ?? flatParent;
    if (
      container.nodeType !== 1 &&
      container.nodeType !== 9 &&
      container.nodeType !== 11
    ) {
      continue;
    }
    let insertions = byContainer.get(container);
    if (!insertions) {
      insertions = {
        atStart: [],
        after: new Map(),
        known: new Set(container.children.map((child) => child.backendNodeId)),
      };
      byContainer.set(container, insertions);
    }
    const previous = text.previousBackendNodeId;
    // The snapshot lists siblings in order, so a restored previous sibling
    // is already known when its successor arrives.
    if (previous !== undefined && !insertions.known.has(previous)) continue;
    const node: DomTreeNode = {
      // Never a query root or a match: real frontend IDs are positive.
      nodeId: -text.backendNodeId,
      backendNodeId: text.backendNodeId,
      nodeType: 3,
      nodeName: '#text',
      nodeValue: text.value,
      attributes: {},
      children: [],
      shadowRoots: [],
      hasAssignedNodes: false,
      parent: container,
    };
    if (previous === undefined) insertions.atStart.push(node);
    else {
      const list = insertions.after.get(previous) ?? [];
      list.push(node);
      insertions.after.set(previous, list);
    }
    insertions.known.add(text.backendNodeId);
    tree.byBackendNodeId.set(text.backendNodeId, node);
    restored += 1;
  }
  for (const [container, insertions] of Array.from(byContainer.entries())) {
    const rebuilt: DomTreeNode[] = [];
    const pending: DomTreeNode[] = [];
    const emit = (node: DomTreeNode): void => {
      // Iterative, since restored nodes can chain after one another.
      pending.push(node);
      while (pending.length > 0) {
        const next = pending.pop();
        if (!next) break;
        rebuilt.push(next);
        const following = insertions.after.get(next.backendNodeId) ?? [];
        for (let index = following.length - 1; index >= 0; index -= 1) {
          pending.push(following[index]);
        }
      }
    };
    for (const node of insertions.atStart) emit(node);
    for (const child of container.children) emit(child);
    container.children = rebuilt;
  }
  return restored;
}

interface DecodedRareStrings {
  values: Map<number, string>;
}

function decodeRareStrings(
  value: unknown,
  strings: readonly string[],
  nodeCount: number,
): DecodedRareStrings | undefined {
  const values = new Map<number, string>();
  if (value === undefined) return { values };
  if (!isRecord(value)) return undefined;
  const indexes = arrayValue(value.index);
  const entries = arrayValue(value.value);
  if (!indexes || !entries || indexes.length !== entries.length) {
    return undefined;
  }
  for (let offset = 0; offset < indexes.length; offset += 1) {
    const nodeIndex = indexes[offset];
    if (!isInteger(nodeIndex) || nodeIndex < 0 || nodeIndex >= nodeCount) {
      return undefined;
    }
    const text = readString(entries[offset], strings);
    if (text === undefined) return undefined;
    if (!values.has(nodeIndex)) values.set(nodeIndex, text);
  }
  return { values };
}

function decodeRareBooleans(
  value: unknown,
  nodeCount: number,
): Set<number> | undefined {
  const decoded = new Set<number>();
  if (value === undefined) return decoded;
  if (!isRecord(value)) return undefined;
  const indexes = arrayValue(value.index);
  if (!indexes) return undefined;
  for (const nodeIndex of indexes) {
    if (!isInteger(nodeIndex) || nodeIndex < 0 || nodeIndex >= nodeCount) {
      return undefined;
    }
    decoded.add(nodeIndex);
  }
  return decoded;
}

function decodeRectangle(value: unknown): BrowserRectangle | undefined {
  const values = arrayValue(value);
  if (!values || values.length < 4) return undefined;
  const [x, y, width, height] = values;
  if (
    !isFiniteNumber(x) ||
    !isFiniteNumber(y) ||
    !isFiniteNumber(width) ||
    !isFiniteNumber(height)
  ) {
    return undefined;
  }
  return { x, y, width, height };
}

interface DecodedLayoutItem {
  bounds: BrowserRectangle;
  clientRect?: BrowserRectangle;
  computedStyles: Record<string, string>;
}

/**
 * Keeps the first layout entry per node. Chromium emits more than one entry
 * for a node with several boxes (`::marker`, `::before` with content), and a
 * repeated node is never a reason to reject the document.
 */
function decodeLayout(
  value: unknown,
  strings: readonly string[],
  nodeCount: number,
  styleNames: readonly string[],
): Map<number, DecodedLayoutItem> | undefined {
  const layout = new Map<number, DecodedLayoutItem>();
  if (value === undefined) return layout;
  if (!isRecord(value)) return undefined;
  const nodeIndexes = arrayValue(value.nodeIndex);
  const styles = arrayValue(value.styles);
  const bounds = arrayValue(value.bounds);
  if (
    !nodeIndexes ||
    !styles ||
    !bounds ||
    nodeIndexes.length !== styles.length ||
    nodeIndexes.length !== bounds.length
  ) {
    return undefined;
  }
  const clientRects = arrayValue(value.clientRects);
  const usableClientRects =
    clientRects !== undefined && clientRects.length === nodeIndexes.length
      ? clientRects
      : undefined;
  for (let offset = 0; offset < nodeIndexes.length; offset += 1) {
    const nodeIndex = nodeIndexes[offset];
    if (!isInteger(nodeIndex) || nodeIndex < 0 || nodeIndex >= nodeCount) {
      return undefined;
    }
    const styleIndexes = arrayValue(styles[offset]);
    const rectangle = decodeRectangle(bounds[offset]);
    if (!styleIndexes || !rectangle) return undefined;
    if (layout.has(nodeIndex)) continue;
    const computedStyles: Record<string, string> = {};
    for (let index = 0; index < styleNames.length; index += 1) {
      const stringIndex = styleIndexes[index];
      if (stringIndex === undefined) continue;
      const styleValue = readString(stringIndex, strings);
      if (styleValue === undefined) return undefined;
      computedStyles[styleNames[index]] = styleValue;
    }
    const clientRect =
      usableClientRects === undefined
        ? undefined
        : decodeRectangle(usableClientRects[offset]);
    layout.set(nodeIndex, {
      bounds: rectangle,
      ...(clientRect === undefined ? {} : { clientRect }),
      computedStyles,
    });
  }
  return layout;
}

const WHITESPACE_ONLY = /^\s+$/;

/**
 * Whitespace-only text nodes with their flat-tree parent and previous
 * sibling, so they can be restored when `DOM.getDocument` omitted them.
 */
function collectWhitespaceTexts(
  rawNodes: Record<string, unknown>,
  backendNodeIds: unknown[],
  strings: readonly string[],
  output: SnapshotWhitespaceText[],
): boolean {
  const nodeTypes = arrayValue(rawNodes.nodeType);
  const parentIndexes = arrayValue(rawNodes.parentIndex);
  const nodeValues = arrayValue(rawNodes.nodeValue);
  const nodeNames = arrayValue(rawNodes.nodeName);
  if (!nodeTypes || !parentIndexes || !nodeValues || !nodeNames) return true;
  const lastChild = new Map<number, number>();
  for (let index = 0; index < backendNodeIds.length; index += 1) {
    const parentIndex = parentIndexes[index];
    if (!isInteger(parentIndex) || parentIndex < -1) return false;
    if (parentIndex < 0) continue;
    const name = readString(nodeNames[index], strings);
    if (name === undefined) return false;
    if (name.startsWith('::')) continue;
    const previous = lastChild.get(parentIndex);
    lastChild.set(parentIndex, index);
    if (nodeTypes[index] !== 3) continue;
    const text = readString(nodeValues[index], strings);
    const backendNodeId = backendNodeIds[index];
    const parentBackendNodeId = backendNodeIds[parentIndex];
    if (
      text === undefined ||
      !isInteger(backendNodeId) ||
      !isInteger(parentBackendNodeId)
    ) {
      return false;
    }
    if (!WHITESPACE_ONLY.test(text)) continue;
    const previousBackendNodeId =
      previous === undefined ? undefined : backendNodeIds[previous];
    output.push({
      backendNodeId,
      parentBackendNodeId,
      ...(isInteger(previousBackendNodeId) ? { previousBackendNodeId } : {}),
      value: text,
    });
  }
  return true;
}

/** Reads `type` and `autocomplete` from a snapshot attribute list. */
function decodeSecretAttributes(
  value: unknown,
  strings: readonly string[],
): { type?: string; autocomplete?: string } | undefined {
  if (value === undefined) return {};
  const list = arrayValue(value);
  if (!list || list.length % 2 !== 0) return undefined;
  const result: { type?: string; autocomplete?: string } = {};
  for (let offset = 0; offset < list.length; offset += 2) {
    const name = readString(list[offset], strings);
    const attributeValue = readString(list[offset + 1], strings);
    if (name === undefined || attributeValue === undefined) return undefined;
    const lower = name.toLowerCase();
    if (lower === 'type' && result.type === undefined) {
      result.type = attributeValue;
    } else if (lower === 'autocomplete' && result.autocomplete === undefined) {
      result.autocomplete = attributeValue;
    }
  }
  return result;
}

function decodeSnapshotDocument(
  value: unknown,
  strings: readonly string[],
  documentIndex: number,
  nodes: Map<number, SnapshotNodeInfo>,
  styleNames: readonly string[],
  whitespaceTexts: SnapshotWhitespaceText[],
): SnapshotDocumentInfo | undefined {
  if (!isRecord(value) || !isRecord(value.nodes)) return undefined;
  const rawNodes = value.nodes;
  const backendNodeIds = arrayValue(rawNodes.backendNodeId);
  if (!backendNodeIds) return undefined;
  const nodeCount = backendNodeIds.length;
  for (const key of ['nodeType', 'nodeName', 'parentIndex']) {
    const list = arrayValue(rawNodes[key]);
    if (list !== undefined && list.length !== nodeCount) return undefined;
  }
  const inputValues = decodeRareStrings(
    rawNodes.inputValue,
    strings,
    nodeCount,
  );
  const textValues = decodeRareStrings(rawNodes.textValue, strings, nodeCount);
  const checked = decodeRareBooleans(rawNodes.inputChecked, nodeCount);
  const selected = decodeRareBooleans(rawNodes.optionSelected, nodeCount);
  const layout = decodeLayout(value.layout, strings, nodeCount, styleNames);
  if (!inputValues || !textValues || !checked || !selected || !layout) {
    return undefined;
  }
  if (
    !collectWhitespaceTexts(rawNodes, backendNodeIds, strings, whitespaceTexts)
  ) {
    return undefined;
  }
  const attributeLists =
    rawNodes.attributes === undefined ? [] : arrayValue(rawNodes.attributes);
  if (
    !attributeLists ||
    (rawNodes.attributes !== undefined && attributeLists.length !== nodeCount)
  ) {
    return undefined;
  }
  let rootBackendNodeId: number | undefined;
  for (let index = 0; index < nodeCount; index += 1) {
    const backendNodeId = backendNodeIds[index];
    if (!isInteger(backendNodeId) || backendNodeId <= 0) return undefined;
    if (index === 0) rootBackendNodeId = backendNodeId;
    const secretAttributes = decodeSecretAttributes(
      attributeLists[index],
      strings,
    );
    if (!secretAttributes) return undefined;
    if (nodes.has(backendNodeId)) continue;
    const layoutItem = layout.get(index);
    const inputValue = inputValues.values.get(index);
    const textValue = textValues.values.get(index);
    nodes.set(backendNodeId, {
      ...secretAttributes,
      documentIndex,
      ...(layoutItem === undefined ? {} : { bounds: layoutItem.bounds }),
      ...(layoutItem?.clientRect === undefined
        ? {}
        : { clientRect: layoutItem.clientRect }),
      computedStyles: layoutItem?.computedStyles ?? {},
      ...(inputValue === undefined ? {} : { inputValue }),
      ...(textValue === undefined ? {} : { textValue }),
      inputChecked: checked.has(index),
      optionSelected: selected.has(index),
    });
  }
  const frameId = readString(value.frameId, strings);
  const documentURL = readString(value.documentURL, strings);
  const title = readString(value.title, strings);
  if (
    frameId === undefined ||
    documentURL === undefined ||
    title === undefined
  ) {
    return undefined;
  }
  const finiteOrZero = (entry: unknown): number =>
    isFiniteNumber(entry) ? entry : 0;
  return {
    documentIndex,
    frameId,
    documentURL,
    title,
    ...(rootBackendNodeId === undefined ? {} : { rootBackendNodeId }),
    scrollOffsetX: finiteOrZero(value.scrollOffsetX),
    scrollOffsetY: finiteOrZero(value.scrollOffsetY),
    contentWidth: finiteOrZero(value.contentWidth),
    contentHeight: finiteOrZero(value.contentHeight),
  };
}

/**
 * Decodes `DOMSnapshot.captureSnapshot` into a lookup by backend node ID.
 * `styleNames` must be the `computedStyles` list the snapshot was taken with.
 */
export function decodeDOMSnapshot(
  value: unknown,
  styleNames: readonly string[] = PAGE_MODEL_COMPUTED_STYLES,
): DecodedDOMSnapshot | undefined {
  if (!isRecord(value)) return undefined;
  const rawStrings = arrayValue(value.strings);
  const rawDocuments = arrayValue(value.documents);
  if (!rawStrings || !rawDocuments) return undefined;
  const strings: string[] = [];
  for (const entry of rawStrings) {
    if (typeof entry !== 'string') return undefined;
    strings.push(entry);
  }
  const nodes = new Map<number, SnapshotNodeInfo>();
  const documents: SnapshotDocumentInfo[] = [];
  const whitespaceTexts: SnapshotWhitespaceText[] = [];
  for (let index = 0; index < rawDocuments.length; index += 1) {
    const document = decodeSnapshotDocument(
      rawDocuments[index],
      strings,
      index,
      nodes,
      styleNames,
      whitespaceTexts,
    );
    if (!document) return undefined;
    documents.push(document);
  }
  return { documents, nodes, whitespaceTexts };
}

/** `DOM.getBoxModel`: the border quad and the untransformed size. */
export interface DecodedBoxModel {
  /** Corners in order: top-left, top-right, bottom-right, bottom-left. */
  border: number[];
  /** The content quad, same corner order, when well formed. */
  content?: number[];
  width: number;
  height: number;
}

function quad(value: unknown): number[] | undefined {
  const values = arrayValue(value);
  return values && values.length === 8 && values.every(isFiniteNumber)
    ? values.filter(isFiniteNumber)
    : undefined;
}

export function decodeBoxModel(value: unknown): DecodedBoxModel | undefined {
  if (!isRecord(value) || !isRecord(value.model)) return undefined;
  const model = value.model;
  const border = quad(model.border);
  if (
    !border ||
    !isFiniteNumber(model.width) ||
    !isFiniteNumber(model.height)
  ) {
    return undefined;
  }
  const content = quad(model.content);
  return {
    border,
    ...(content === undefined ? {} : { content }),
    width: model.width,
    height: model.height,
  };
}

export function decodeFrameOwnerBackendNodeId(
  value: unknown,
): number | undefined {
  if (!isRecord(value)) return undefined;
  return isInteger(value.backendNodeId) && value.backendNodeId > 0
    ? value.backendNodeId
    : undefined;
}

export function decodeLayoutViewport(
  value: unknown,
): { width: number; height: number } | undefined {
  if (!isRecord(value)) return undefined;
  const viewport = isRecord(value.cssLayoutViewport)
    ? value.cssLayoutViewport
    : isRecord(value.layoutViewport)
      ? value.layoutViewport
      : undefined;
  if (!viewport) return undefined;
  const width = viewport.clientWidth;
  const height = viewport.clientHeight;
  if (
    !isFiniteNumber(width) ||
    !isFiniteNumber(height) ||
    width < 0 ||
    height < 0
  ) {
    return undefined;
  }
  return { width, height };
}

/** A document's scroll offset, from `Page.getLayoutMetrics` in its session. */
export function decodeLayoutScroll(
  value: unknown,
): { x: number; y: number } | undefined {
  if (!isRecord(value)) return undefined;
  const viewport = isRecord(value.cssLayoutViewport)
    ? value.cssLayoutViewport
    : isRecord(value.layoutViewport)
      ? value.layoutViewport
      : undefined;
  if (
    !viewport ||
    !isFiniteNumber(viewport.pageX) ||
    !isFiniteNumber(viewport.pageY)
  )
    return undefined;
  return { x: viewport.pageX, y: viewport.pageY };
}

export function decodeAccessibilityNodes(
  value: unknown,
): unknown[] | undefined {
  if (!isRecord(value)) return undefined;
  return arrayValue(value.nodes);
}

export function isCDPRecord(value: unknown): value is Record<string, unknown> {
  return isRecord(value);
}

export function readCDPString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function readCDPInteger(value: unknown): number | undefined {
  return isInteger(value) ? value : undefined;
}

export function readCDPFiniteNumber(value: unknown): number | undefined {
  return isFiniteNumber(value) ? value : undefined;
}

export function readCDPArray(value: unknown): unknown[] | undefined {
  return arrayValue(value);
}
