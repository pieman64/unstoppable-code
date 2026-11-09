import {
  classifySecretField,
  isSecretAutocomplete,
} from '@canopy/desktop-shared/browser/secret-fields';
import type { BrowserRectangle } from '@canopy/execution-engine/types/browser';
import type { DomTreeNode, SnapshotNodeInfo } from './cdp-decode';
import {
  attributeReader,
  MODEL_TEXT_LIMIT,
  REDACTED_ATTRIBUTE_VALUE,
  type AttributeReader,
} from './model-semantics';
import type {
  ControlHistory,
  PageModelFrame,
  PageModelNode,
} from './model-types';
import type { FrameContext } from './page-model-capture';
import {
  intersectRectangles,
  rectangle,
  safeCoverageURL,
} from './page-model-cdp';
import type { StyleOutcome } from './page-model-styles';

const REDACTED_VALUE = REDACTED_ATTRIBUTE_VALUE;
const TEXT_LIMIT = MODEL_TEXT_LIMIT;
/** Enough collapsed text that trimming cannot change the first 120 units. */
const TEXT_PREFIX_LIMIT = 130;
const WHITESPACE = /\s/;
const ASCII_WHITESPACE = /[\t\n\f\r ]+/g;

/** A whitespace-collapsed prefix of `textContent`, bounded for linear cost. */
interface BoundedText {
  value: string;
  truncated: boolean;
}

const EMPTY_TEXT: BoundedText = { value: '', truncated: false };

function collapseText(raw: string): BoundedText {
  let value = '';
  let previousSpace = false;
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (WHITESPACE.test(character)) {
      if (!previousSpace) value += ' ';
      previousSpace = true;
    } else {
      value += character;
      previousSpace = false;
    }
    if (value.length > TEXT_PREFIX_LIMIT) {
      return { value: value.slice(0, TEXT_PREFIX_LIMIT), truncated: true };
    }
  }
  return { value, truncated: false };
}

function concatText(left: BoundedText, right: BoundedText): BoundedText {
  if (left.truncated || right.value.length === 0) return left;
  const addition =
    left.value.endsWith(' ') && right.value.startsWith(' ')
      ? right.value.slice(1)
      : right.value;
  const value = left.value + addition;
  if (value.length > TEXT_PREFIX_LIMIT) {
    return { value: value.slice(0, TEXT_PREFIX_LIMIT), truncated: true };
  }
  return { value, truncated: right.truncated };
}

/** Equals the preload's `compactText(textContent)` for the full text. */
function finishText(text: BoundedText): string {
  return text.truncated
    ? text.value.trimStart().slice(0, TEXT_LIMIT)
    : text.value.trim().slice(0, TEXT_LIMIT);
}

interface NodeFacts {
  scopeNodeId: number;
  inShadowRoot: boolean;
  shadowRootType?: 'open' | 'closed';
  /** The one effective secret predicate (R2), for elements. */
  secret: boolean;
  insideSecretSelect: boolean;
  /**
   * The root of a subtree whose content is all secret: an ARIA listbox with
   * secret options, or another secret element that is not a form control,
   * such as a secret editing host or ARIA combobox.
   */
  secretSubtreeRoot: boolean;
  /** This node is below such a root. */
  insideSecretSubtree: boolean;
  /** Below a secret element, e.g. a secret textarea's default text. */
  insideSecretContent: boolean;
  /**
   * The node is, or is inside, a `<label>` in a shadow root or child frame
   * that wraps a form control that is, or was, secret, or whose history is
   * unknown (see `markControlLabels`).
   */
  inControlLabel: boolean;
  hasSecretDescendant: boolean;
  ownHidden: boolean;
  hiddenWithAncestors: boolean;
  computedStyles: Record<string, string>;
  styleUnknown: boolean;
  snapshot?: SnapshotNodeInfo;
  /** `textContent`. */
  full: BoundedText;
  /** Children's text without secret elements (labelledby with secrets). */
  safeChildren: BoundedText;
  /** Children's text without secret elements or form controls (labels). */
  omitChildren: BoundedText;
  ownText: BoundedText;
}

export interface FrameFacts {
  context: FrameContext;
  isRootFrame: boolean;
  facts: Map<DomTreeNode, NodeFacts>;
  /** Open and closed shadow roots, in document order. */
  shadowRoots: DomTreeNode[];
  hasSecrets: boolean;
}

export interface AssemblyInput {
  /** Root first, then by depth. */
  contexts: FrameContext[];
  rootFrameId: string;
  /**
   * Password history by input: the preload's in main-frame light DOM, the
   * trackers' elsewhere. An input without an entry is unknown: secret.
   */
  history: Map<DomTreeNode, ControlHistory>;
  styles: Map<DomTreeNode, StyleOutcome>;
  /**
   * Every input, textarea and select is secret, in every frame and scope.
   * For a capture whose page changed while it was taken: structure and
   * values may come from different instants.
   */
  allControlsSecret?: boolean;
}

export interface AssemblyResult {
  nodes: PageModelNode[];
  frames: PageModelFrame[];
  frameFacts: FrameFacts[];
}

function isFormControl(tagName: string): boolean {
  return tagName === 'input' || tagName === 'textarea' || tagName === 'select';
}

function isTextNode(node: DomTreeNode): boolean {
  return node.nodeType === 3 || node.nodeType === 4;
}

function hasInlineHiddenStyle(read: AttributeReader): boolean {
  const style = read('style')?.toLowerCase() ?? '';
  return (
    /(?:^|;)\s*display\s*:\s*none(?:\s*!important)?\s*(?:;|$)/.test(style) ||
    /(?:^|;)\s*visibility\s*:\s*(?:hidden|collapse)(?:\s*!important)?\s*(?:;|$)/.test(
      style,
    ) ||
    /(?:^|;)\s*opacity\s*:\s*0(?:\.0+)?(?:\s*!important)?\s*(?:;|$)/.test(style)
  );
}

/** Visual hiding, used for viewport state and frame-owner visibility. */
export function isVisuallyHidden(
  read: AttributeReader,
  computedStyles: Record<string, string>,
): boolean {
  if (read('hidden') !== undefined || hasInlineHiddenStyle(read)) return true;
  const display = computedStyles.display?.toLowerCase();
  const visibility = computedStyles.visibility?.toLowerCase();
  if (
    display === 'none' ||
    visibility === 'hidden' ||
    visibility === 'collapse'
  ) {
    return true;
  }
  const opacity = Number(computedStyles.opacity);
  return computedStyles.opacity !== undefined && Number.isFinite(opacity)
    ? opacity <= 0
    : false;
}

function stylesFor(
  node: DomTreeNode,
  info: SnapshotNodeInfo | undefined,
  styles: Map<DomTreeNode, StyleOutcome>,
): { computedStyles: Record<string, string>; styleUnknown: boolean } {
  if (info?.bounds) {
    return { computedStyles: info.computedStyles, styleUnknown: false };
  }
  const outcome = styles.get(node);
  if (outcome === 'unknown') return { computedStyles: {}, styleUnknown: true };
  if (outcome) {
    return {
      computedStyles: {
        display: outcome.display,
        visibility: outcome.visibility,
      },
      styleUnknown: false,
    };
  }
  return { computedStyles: {}, styleUnknown: false };
}

interface WalkState {
  node: DomTreeNode;
  scopeNodeId: number;
  inShadowRoot: boolean;
  shadowRootType?: 'open' | 'closed';
  /** Whether the nearest `select` ancestor in this tree is secret. */
  selectSecret?: boolean;
  insideSecretContent: boolean;
  hiddenAncestor: boolean;
}

/**
 * Computes structure-derived facts for one frame's own nodes. Top-down: scope,
 * shadow state, the effective secret predicate and hiding. Bottom-up over the
 * light tree: the three `textContent` variants the preload's name and label
 * rules use, and secret form-control descendants.
 */
export function computeFrameFacts(
  context: FrameContext,
  isRootFrame: boolean,
  history: Map<DomTreeNode, ControlHistory>,
  styles: Map<DomTreeNode, StyleOutcome>,
  allControlsSecret: boolean = false,
): FrameFacts {
  const facts = new Map<DomTreeNode, NodeFacts>();
  const order: DomTreeNode[] = [];
  const shadowRoots: DomTreeNode[] = [];
  const elementsByScope = new Map<number, Map<string, DomTreeNode[]>>();
  const listboxes = new Set<DomTreeNode>();
  const secretControlReferences: Array<{
    scopeNodeId: number;
    ids: string[];
  }> = [];
  const secretAriaListboxes = new Set<DomTreeNode>();
  const secretContentRoots: DomTreeNode[] = [];
  let hasSecrets = false;
  const snapshotNodes = context.capture.snapshot.nodes;
  const pending: WalkState[] = [
    {
      node: context.document,
      scopeNodeId: context.document.nodeId,
      inShadowRoot: false,
      insideSecretContent: false,
      hiddenAncestor: false,
    },
  ];
  while (pending.length > 0) {
    const state = pending.pop();
    if (!state) break;
    const node = state.node;
    order.push(node);
    const read = attributeReader(node.attributes);
    const tagName = node.nodeName.toLowerCase();
    const isElement = node.nodeType === 1;
    const insideSecretSelect = isElement && state.selectSecret === true;
    const info = snapshotNodes.get(node.backendNodeId);
    const role = isElement
      ? read('role')?.trim().toLowerCase().split(/\s+/)[0]
      : undefined;
    let secret = false;
    if (isElement) {
      const control = isFormControl(tagName);
      const secretListboxToken =
        role === 'listbox' &&
        (isSecretAutocomplete(read('autocomplete')) ||
          isSecretAutocomplete(info?.autocomplete));
      const secretAriaComboboxToken =
        role === 'combobox' &&
        (isSecretAutocomplete(read('autocomplete')) ||
          isSecretAutocomplete(info?.autocomplete));
      // An editing host takes typed text like a field does.
      const editable = read('contenteditable')?.toLowerCase();
      const secretEditingHostToken =
        (editable === '' ||
          editable === 'true' ||
          editable === 'plaintext-only') &&
        (isSecretAutocomplete(read('autocomplete')) ||
          isSecretAutocomplete(info?.autocomplete));
      secret =
        classifySecretField({
          tagName,
          type: read('type') ?? null,
          autocomplete: read('autocomplete') ?? null,
          insideSecretSelect,
          // Missing or unknown history fails closed: a password (D3).
          everPassword: tagName === 'input' && history.get(node) !== 'never',
        }) ||
        // The snapshot is taken at another instant; a control that either
        // capture shows as secret is secret, so a value that became secret
        // between the two is never read as ordinary.
        (info !== undefined &&
          classifySecretField({
            tagName,
            type: info.type ?? null,
            autocomplete: info.autocomplete ?? null,
            insideSecretSelect,
            everPassword: false,
          })) ||
        secretListboxToken ||
        secretAriaComboboxToken ||
        secretEditingHostToken ||
        (control && allControlsSecret);
      if (secret && !control && !insideSecretSelect)
        secretContentRoots.push(node);
    }
    if (secret) hasSecrets = true;
    const { computedStyles, styleUnknown } = stylesFor(node, info, styles);
    const ownHidden = isElement && isVisuallyHidden(read, computedStyles);
    const hiddenWithAncestors = state.hiddenAncestor || ownHidden;
    facts.set(node, {
      scopeNodeId: state.scopeNodeId,
      inShadowRoot: state.inShadowRoot,
      ...(state.shadowRootType === undefined
        ? {}
        : { shadowRootType: state.shadowRootType }),
      secret,
      insideSecretSelect,
      secretSubtreeRoot: false,
      insideSecretSubtree: false,
      insideSecretContent: state.insideSecretContent,
      inControlLabel: false,
      hasSecretDescendant: false,
      ownHidden,
      hiddenWithAncestors,
      computedStyles,
      styleUnknown,
      ...(info === undefined ? {} : { snapshot: info }),
      full: EMPTY_TEXT,
      safeChildren: EMPTY_TEXT,
      omitChildren: EMPTY_TEXT,
      ownText: EMPTY_TEXT,
    });
    if (isElement && role === 'listbox') {
      listboxes.add(node);
      if (secret) secretAriaListboxes.add(node);
    }
    if (isElement) {
      const id = read('id');
      if (id) {
        let byId = elementsByScope.get(state.scopeNodeId);
        if (!byId) {
          byId = new Map<string, DomTreeNode[]>();
          elementsByScope.set(state.scopeNodeId, byId);
        }
        const matches = byId.get(id) ?? [];
        matches.push(node);
        byId.set(id, matches);
      }
    }
    if (
      isElement &&
      (isFormControl(tagName) || role === 'combobox') &&
      secret
    ) {
      const ids = [read('aria-controls'), read('aria-owns')].flatMap(
        (value) => value?.match(/\S+/g) ?? [],
      );
      if (ids.length > 0) {
        secretControlReferences.push({ scopeNodeId: state.scopeNodeId, ids });
      }
    }
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      pending.push({
        node: node.children[index],
        scopeNodeId: state.scopeNodeId,
        inShadowRoot: state.inShadowRoot,
        ...(state.shadowRootType === undefined
          ? {}
          : { shadowRootType: state.shadowRootType }),
        selectSecret:
          isElement && tagName === 'select' ? secret : state.selectSecret,
        insideSecretContent: state.insideSecretContent || secret,
        hiddenAncestor: hiddenWithAncestors,
      });
    }
    for (let index = node.shadowRoots.length - 1; index >= 0; index -= 1) {
      const root = node.shadowRoots[index];
      if (root.shadowRootType !== 'open' && root.shadowRootType !== 'closed') {
        continue;
      }
      shadowRoots.push(root);
      pending.push({
        node: root,
        scopeNodeId: root.nodeId,
        inShadowRoot: true,
        shadowRootType: root.shadowRootType,
        insideSecretContent: false,
        hiddenAncestor: hiddenWithAncestors,
      });
    }
  }

  for (const reference of secretControlReferences) {
    const byId = elementsByScope.get(reference.scopeNodeId);
    if (!byId) continue;
    for (const id of reference.ids) {
      // The named element can be a container around the list, as the
      // select_option page check reads it.
      const subtree = [...(byId.get(id) ?? [])];
      while (subtree.length > 0) {
        const element = subtree.pop();
        if (!element) break;
        if (listboxes.has(element)) secretAriaListboxes.add(element);
        subtree.push(...element.children);
      }
    }
  }
  // Whatever is inside a secret element that is not a form control is part
  // of what it holds: a control or list there is redacted like the options
  // of a secret list.
  for (const root of [
    ...Array.from(secretAriaListboxes),
    ...secretContentRoots,
  ]) {
    const nodeFacts = facts.get(root);
    if (!nodeFacts) continue;
    nodeFacts.secretSubtreeRoot = true;
    nodeFacts.secret = true;
    hasSecrets = true;
  }

  markControlLabels(order, facts, isRootFrame);

  // Reverse preorder visits every node after all of its descendants.
  for (let index = order.length - 1; index >= 0; index -= 1) {
    const node = order[index];
    const nodeFacts = facts.get(node);
    if (!nodeFacts) continue;
    if (isTextNode(node)) {
      // Text inside a control label contributes nothing, here or upward.
      nodeFacts.full = nodeFacts.inControlLabel
        ? EMPTY_TEXT
        : collapseText(node.nodeValue);
      nodeFacts.ownText = nodeFacts.full;
      continue;
    }
    if (node.nodeType !== 1 && node.nodeType !== 9 && node.nodeType !== 11) {
      continue;
    }
    let full = EMPTY_TEXT;
    let safeChildren = EMPTY_TEXT;
    let omitChildren = EMPTY_TEXT;
    let ownText = EMPTY_TEXT;
    let hasSecretDescendant = false;
    for (const child of node.children) {
      const childFacts = facts.get(child);
      if (!childFacts) continue;
      if (isTextNode(child)) {
        if (childFacts.insideSecretSubtree) {
          hasSecretDescendant = true;
        }
        full = concatText(full, childFacts.full);
        safeChildren = concatText(safeChildren, childFacts.full);
        omitChildren = concatText(omitChildren, childFacts.full);
        ownText = concatText(ownText, childFacts.full);
        continue;
      }
      if (child.nodeType !== 1) continue;
      const childTag = child.nodeName.toLowerCase();
      if (
        childFacts.secret ||
        childFacts.insideSecretSubtree ||
        childFacts.secretSubtreeRoot ||
        childFacts.hasSecretDescendant
      ) {
        hasSecretDescendant = true;
      }
      if (childFacts.inControlLabel) continue;
      full = concatText(full, childFacts.full);
      if (!childFacts.secret) {
        safeChildren = concatText(safeChildren, childFacts.safeChildren);
        if (!isFormControl(childTag)) {
          omitChildren = concatText(omitChildren, childFacts.omitChildren);
        }
      }
    }
    nodeFacts.hasSecretDescendant = hasSecretDescendant;
    if (nodeFacts.inControlLabel) continue;
    nodeFacts.full = full;
    nodeFacts.safeChildren = safeChildren;
    nodeFacts.omitChildren = omitChildren;
    nodeFacts.ownText = ownText;
  }
  return { context, isRootFrame, facts, shadowRoots, hasSecrets };
}

/**
 * D3 text boundary. Pages mirror a field's value into the text of the
 * `<label>` that wraps it. In a shadow root or child frame, a `<label>` that
 * wraps a form control that is, or was, secret, or whose history is unknown,
 * therefore exposes no text at all: not its own, not any descendant's
 * (nested elements included, so `aria-labelledby` pointing inside it finds
 * nothing), and none to its ancestors' text. The rule stops at that label.
 * A label whose wrapped controls are all known never to have been secret
 * uses the preload's rule, as does other text in the scope, including an
 * ancestor that contains a control (a form, `<body>`) and `for=` labels that
 * do not wrap one. The main frame's light DOM keeps the preload's rule (D1).
 */
function markControlLabels(
  order: DomTreeNode[],
  facts: Map<DomTreeNode, NodeFacts>,
  isRootFrame: boolean,
): void {
  const containsSecretControl = new Set<DomTreeNode>();
  for (let index = order.length - 1; index >= 0; index -= 1) {
    const node = order[index];
    for (const child of node.children) {
      if (child.nodeType !== 1) continue;
      if (
        containsSecretControl.has(child) ||
        facts.get(child)?.secret === true
      ) {
        containsSecretControl.add(node);
        break;
      }
    }
  }
  for (const node of order) {
    const nodeFacts = facts.get(node);
    if (!nodeFacts) continue;
    const parentFacts = node.parent ? facts.get(node.parent) : undefined;
    const startsSecretList = nodeFacts.secretSubtreeRoot;
    const insideSecretList =
      startsSecretList || parentFacts?.insideSecretSubtree === true;
    nodeFacts.insideSecretSubtree = insideSecretList;
    if (insideSecretList && !startsSecretList) {
      nodeFacts.insideSecretSelect = true;
      if (node.nodeType === 1) nodeFacts.secret = true;
      else if (isTextNode(node)) nodeFacts.insideSecretContent = true;
    }
    nodeFacts.inControlLabel =
      parentFacts?.inControlLabel === true ||
      ((nodeFacts.inShadowRoot || !isRootFrame) &&
        node.nodeType === 1 &&
        node.nodeName.toLowerCase() === 'label' &&
        containsSecretControl.has(node));
  }
}

/** The preload's `attributes()`, including `[redacted]` for secret values. */
function exposedAttributes(
  node: DomTreeNode,
  tagName: string,
  nodeFacts: NodeFacts,
): Record<string, string> {
  const attributes: Record<string, string> = {};
  const listOption = tagName === 'option' || tagName === 'optgroup';
  for (const [name, value] of Object.entries(node.attributes)) {
    if (nodeFacts.secret && tagName === 'option' && name === 'selected') {
      continue;
    }
    attributes[name] =
      nodeFacts.secret &&
      (nodeFacts.insideSecretSelect ||
        name === 'value' ||
        (listOption && name === 'label'))
        ? REDACTED_VALUE
        : value;
  }
  return attributes;
}

/** A text-derived option value longer than this is not kept whole. */
const OPTION_VALUE_LIMIT = 241;

/**
 * `HTMLOptionElement.value`: the attribute, else the text with ASCII
 * whitespace stripped and collapsed. Other whitespace, such as a no-break
 * space, is kept, as the browser keeps it. With `limit`, reading stops once
 * the text is longer than that.
 */
function optionValue(option: DomTreeNode, limit?: number): string {
  const attribute = attributeReader(option.attributes)('value');
  if (attribute !== undefined) return attribute;
  let text = '';
  const pending: DomTreeNode[] = [...option.children].reverse();
  while (pending.length > 0) {
    const node = pending.pop();
    if (!node) break;
    if (limit !== undefined && text.length > limit * 2) break;
    if (isTextNode(node)) {
      text += node.nodeValue;
      continue;
    }
    if (node.nodeType !== 1 || node.nodeName.toLowerCase() === 'script') {
      continue;
    }
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      pending.push(node.children[index]);
    }
  }
  const value = text
    .replace(ASCII_WHITESPACE, ' ')
    .replace(/^ /, '')
    .replace(/ $/, '');
  return limit === undefined ? value : value.slice(0, limit);
}

/**
 * `HTMLSelectElement.value`: the first option in tree order whose live
 * selectedness (`optionSelected`) is set, else the empty string. Undefined
 * when an option has no snapshot entry (the options changed between the two
 * captures), since its selectedness is then unknown.
 */
function selectValue(
  select: DomTreeNode,
  snapshotNodes: Map<number, SnapshotNodeInfo>,
): string | undefined {
  const pending: DomTreeNode[] = [...select.children].reverse();
  let selected: DomTreeNode | undefined;
  while (pending.length > 0) {
    const node = pending.pop();
    if (!node || node.nodeType !== 1) continue;
    const tagName = node.nodeName.toLowerCase();
    if (tagName === 'option') {
      const info = snapshotNodes.get(node.backendNodeId);
      if (!info) return undefined;
      if (info.optionSelected && !selected) selected = node;
      continue;
    }
    if (tagName === 'select' || tagName === 'datalist') continue;
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      pending.push(node.children[index]);
    }
  }
  return selected ? optionValue(selected) : '';
}

interface LiveState {
  value?: string;
  valueUnknown?: boolean;
  checked?: boolean;
}

/** Live value and checked state; never read for secret controls. */
function liveState(
  node: DomTreeNode,
  tagName: string,
  nodeFacts: NodeFacts,
  snapshotNodes: Map<number, SnapshotNodeInfo>,
): LiveState {
  if (!isFormControl(tagName)) return {};
  const info = nodeFacts.snapshot;
  const checked =
    tagName === 'input'
      ? info
        ? info.inputChecked
        : attributeReader(node.attributes)('checked') !== undefined
      : undefined;
  const withChecked = (state: LiveState): LiveState =>
    checked === undefined ? state : { ...state, checked };
  if (nodeFacts.secret) return withChecked({});
  // Not in the flat tree (an unslotted light child): the value is unknown.
  if (!info) return withChecked({ valueUnknown: true });
  if (tagName === 'input') {
    return withChecked(
      info.inputValue === undefined
        ? { valueUnknown: true }
        : { value: info.inputValue },
    );
  }
  if (tagName === 'textarea') {
    return info.textValue === undefined
      ? { valueUnknown: true }
      : { value: info.textValue };
  }
  const value = selectValue(node, snapshotNodes);
  return value === undefined ? { valueUnknown: true } : { value };
}

function frameLocalBounds(
  context: FrameContext,
  info: SnapshotNodeInfo | undefined,
): BrowserRectangle {
  const bounds = info?.bounds;
  if (!info || !bounds) return rectangle(0, 0, 0, 0);
  const document = context.capture.snapshot.documents[info.documentIndex];
  return rectangle(
    bounds.x - (document?.scrollOffsetX ?? 0),
    bounds.y - (document?.scrollOffsetY ?? 0),
    bounds.width,
    bounds.height,
  );
}

function isDocumentElement(node: DomTreeNode): boolean {
  return node.parent?.nodeType === 9;
}

/** A rectangle in the frame's viewport, in top-level viewport coordinates. */
export function toTopLevel(
  context: FrameContext,
  local: BrowserRectangle,
): BrowserRectangle {
  return rectangle(
    context.translationX + context.scaleX * local.x,
    context.translationY + context.scaleY * local.y,
    context.scaleX * local.width,
    context.scaleY * local.height,
  );
}

function createNode(
  frame: FrameFacts,
  node: DomTreeNode,
  nodeFacts: NodeFacts,
  parentIndex: number | undefined,
): PageModelNode {
  const context = frame.context;
  const tagName = node.nodeName.toLowerCase();
  const textNode = isTextNode(node);
  // Control labels in shadow roots and child frames: see markControlLabels.
  const blocked =
    nodeFacts.secret ||
    nodeFacts.insideSecretContent ||
    nodeFacts.inControlLabel;
  const text = textNode
    ? nodeFacts.insideSecretContent || nodeFacts.inControlLabel
      ? ''
      : finishText(nodeFacts.full)
    : blocked || nodeFacts.hasSecretDescendant
      ? ''
      : finishText(nodeFacts.full);
  const labelText = textNode
    ? text
    : blocked
      ? ''
      : finishText(
          nodeFacts.hasSecretDescendant
            ? nodeFacts.omitChildren
            : nodeFacts.full,
        );
  const nameText = textNode
    ? text
    : blocked
      ? ''
      : finishText(
          nodeFacts.hasSecretDescendant
            ? nodeFacts.safeChildren
            : nodeFacts.full,
        );
  const ownText =
    blocked || nodeFacts.insideSecretSelect
      ? ''
      : finishText(nodeFacts.ownText);
  const local = frameLocalBounds(context, nodeFacts.snapshot);
  const bounds = toTopLevel(context, local);
  const visible = intersectRectangles(bounds, context.clip);
  const live = liveState(
    node,
    tagName,
    nodeFacts,
    context.capture.snapshot.nodes,
  );
  const childFrameId =
    node.nodeType === 1 &&
    node.frameId !== undefined &&
    !isDocumentElement(node)
      ? node.frameId
      : undefined;
  return {
    identity: {
      sessionId: context.registered.sessionId,
      frameId: context.registered.frameId,
      loaderId: context.registered.loaderId,
      backendNodeId: node.backendNodeId,
    },
    nodeId: node.nodeId,
    nodeType: textNode ? 3 : node.nodeType,
    frameRef: context.registered.frameRef,
    inShadowRoot: nodeFacts.inShadowRoot,
    ...(nodeFacts.shadowRootType === undefined
      ? {}
      : { shadowRootType: nodeFacts.shadowRootType }),
    scopeNodeId: nodeFacts.scopeNodeId,
    tagName,
    attributes: exposedAttributes(node, tagName, nodeFacts),
    computedStyles: nodeFacts.computedStyles,
    ...(nodeFacts.styleUnknown ? { styleUnknown: true } : {}),
    hidden: nodeFacts.ownHidden,
    bounds,
    frameLocalBounds: local,
    inViewport:
      !nodeFacts.hiddenWithAncestors && visible.width > 0 && visible.height > 0,
    ...(live.value === undefined ? {} : { value: live.value }),
    ...(live.valueUnknown ? { valueUnknown: true } : {}),
    ...(live.checked === undefined ? {} : { checked: live.checked }),
    ...(tagName === 'option' &&
    !nodeFacts.secret &&
    !nodeFacts.insideSecretSelect &&
    nodeFacts.snapshot !== undefined
      ? { selected: nodeFacts.snapshot.optionSelected }
      : {}),
    ...(tagName === 'option' &&
    !nodeFacts.secret &&
    !nodeFacts.insideSecretSelect &&
    attributeReader(node.attributes)('value') === undefined
      ? { optionValue: optionValue(node, OPTION_VALUE_LIMIT) }
      : {}),
    ...(attributeReader(node.attributes)('role')
      ?.trim()
      .toLowerCase()
      .split(/\s+/)[0] === 'option'
      ? { isAriaOption: true }
      : {}),
    text,
    labelText,
    nameText,
    ownText: textNode ? text : ownText,
    // Only text with a layout box: title, style, script, and display: none
    // text is in the tree but never drawn, and has no styles to say so.
    ...(textNode &&
    !blocked &&
    !nodeFacts.insideSecretSelect &&
    !nodeFacts.hiddenWithAncestors &&
    local.width > 0 &&
    local.height > 0
      ? { fullText: node.nodeValue.replace(/\s+/g, ' ').trim() }
      : {}),
    secret:
      nodeFacts.secret ||
      (textNode && (nodeFacts.insideSecretContent || nodeFacts.inControlLabel)),
    insideSecretSelect: nodeFacts.insideSecretSelect,
    hasSecretDescendant: nodeFacts.hasSecretDescendant,
    ...(parentIndex === undefined ? {} : { parentIndex }),
    childIndexes: [],
    ...(childFrameId === undefined ? {} : { childFrameId }),
  };
}

function isModelNode(node: DomTreeNode): boolean {
  return (
    node.nodeType === 1 ||
    isTextNode(node) ||
    node.nodeType === 9 ||
    node.nodeType === 11
  );
}

interface EmitItem {
  frame: FrameFacts;
  node: DomTreeNode;
  parentIndex: number | undefined;
  ordinary: boolean;
}

/**
 * Emits every frame's nodes in document order. A shadow tree follows its
 * host, before the host's light children; a child frame's document follows
 * its owner element. Child documents are roots (no parent index).
 */
export function assemblePageModel(input: AssemblyInput): AssemblyResult {
  const frameFacts = input.contexts.map((context) =>
    computeFrameFacts(
      context,
      context.registered.frameId === input.rootFrameId,
      input.history,
      input.styles,
      input.allControlsSecret === true,
    ),
  );
  const childFrameByOwner = new Map<DomTreeNode, FrameFacts>();
  for (const frame of frameFacts) {
    if (frame.context.owner) childFrameByOwner.set(frame.context.owner, frame);
  }
  const nodes: PageModelNode[] = [];
  const indexByNode = new Map<DomTreeNode, number>();
  const rootFrame = frameFacts[0];
  const pending: EmitItem[] = rootFrame
    ? [
        {
          frame: rootFrame,
          node: rootFrame.context.document,
          parentIndex: undefined,
          ordinary: false,
        },
      ]
    : [];
  while (pending.length > 0) {
    const item = pending.pop();
    if (!item) break;
    const { frame, node } = item;
    const nodeFacts = frame.facts.get(node);
    if (!nodeFacts || !isModelNode(node) || indexByNode.has(node)) continue;
    const index = nodes.length;
    nodes.push(createNode(frame, node, nodeFacts, item.parentIndex));
    indexByNode.set(node, index);
    if (item.ordinary && item.parentIndex !== undefined) {
      nodes[item.parentIndex]?.childIndexes.push(index);
    }
    const childFrame = childFrameByOwner.get(node);
    if (childFrame) {
      pending.push({
        frame: childFrame,
        node: childFrame.context.document,
        parentIndex: undefined,
        ordinary: false,
      });
    }
    for (let offset = node.children.length - 1; offset >= 0; offset -= 1) {
      pending.push({
        frame,
        node: node.children[offset],
        parentIndex: index,
        ordinary: true,
      });
    }
    for (let offset = node.shadowRoots.length - 1; offset >= 0; offset -= 1) {
      pending.push({
        frame,
        node: node.shadowRoots[offset],
        parentIndex: index,
        ordinary: false,
      });
    }
  }

  const frames: PageModelFrame[] = frameFacts.map((frame) => {
    const context = frame.context;
    const ownerIndex = context.owner
      ? indexByNode.get(context.owner)
      : undefined;
    return {
      frameId: context.registered.frameId,
      frameRef: context.registered.frameRef,
      sessionId: context.registered.sessionId,
      loaderId: context.registered.loaderId,
      url: safeCoverageURL(
        context.snapshotDocument?.documentURL || context.registered.url,
      ),
      ...(context.registered.parentId === undefined
        ? {}
        : { parentFrameId: context.registered.parentId }),
      ...(ownerIndex === undefined ? {} : { ownerNodeIndex: ownerIndex }),
      documentNodeId: context.document.nodeId,
      queryRootNodeIds: [
        context.document.nodeId,
        ...frame.shadowRoots.map((root) => root.nodeId),
      ],
      depth: context.depth,
      viewportTransform: {
        x: context.translationX,
        y: context.translationY,
        scaleX: context.scaleX,
        scaleY: context.scaleY,
      },
      clip: { ...context.clip },
    };
  });
  return { nodes, frames, frameFacts };
}
