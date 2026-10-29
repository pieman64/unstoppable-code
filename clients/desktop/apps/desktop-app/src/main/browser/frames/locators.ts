import type { NodeIdentity } from './frame-registry';
import {
  parseSemanticLocator,
  parseTestIdLocator,
  type ParsedLocator,
} from '@canopy/desktop-shared/browser/locator-grammar';
import type {
  BrowserPageModel,
  PageModelFrame,
  PageModelNode,
} from './model-types';
import { matchGeneratedSelector } from './model-css';
import {
  accessibleName,
  compactText,
  isInteractiveElement,
  labelTextForControl,
  roleFor,
} from './model-semantics';

export type { ParsedLocator } from '@canopy/desktop-shared/browser/locator-grammar';

export interface LocatorEvaluationDeps {
  send(
    method: string,
    params: Record<string, unknown>,
    sessionId?: string,
  ): Promise<unknown>;
}

export interface LocatorScope {
  frameRef?: string;
  /** An explicit frame set (the `frame` field), instead of `frameRef`. */
  frames?: PageModelFrame[];
}

export interface LocatorOptions {
  purpose?: 'inspect';
  /**
   * An unparsable CSS selector throws `InvalidSelectorError` instead of
   * matching nothing (the deleted preload's `rejectInvalidCss`).
   */
  strictCss?: boolean;
  /**
   * Existence matching for action targets and waits: CSS also matches
   * elements under a secret select (the preload counted them). Their
   * descriptions and inspection stay redacted.
   */
  existence?: boolean;
}

interface LocatedNode {
  index: number;
  node: PageModelNode;
}

interface QueryRootResult {
  rootNodeId: number;
  nodeIds: Set<number>;
}

const TEST_ID_ATTRIBUTES: string[] = ['data-testid', 'data-test', 'data-cy'];
/** Bound for each `DOM.querySelectorAll` a locator sends. */
const LOCATOR_REQUEST_TIMEOUT_MS = 5_000;
const STALE_LOCATOR_ERROR_NAME = 'StaleLocatorError';
const INVALID_SELECTOR_ERROR_NAME = 'InvalidSelectorError';
const STALE_NODE_MESSAGE =
  /could not find node with given id|no node with given id|session with given id not found|no session with given id/i;
/** Chromium's `DOM.querySelectorAll` rejection for a selector it cannot parse. */
const INVALID_SELECTOR_MESSAGE = /DOM Error while querying/i;

export function isInvalidSelectorError(error: unknown): boolean {
  return error instanceof Error && error.name === INVALID_SELECTOR_ERROR_NAME;
}

function invalidSelectorError(): Error {
  const error = new Error('The CSS selector could not be parsed.');
  error.name = INVALID_SELECTOR_ERROR_NAME;
  return error;
}

/**
 * The model's frontend node IDs were invalidated (any later
 * `DOM.getDocument` does that), so "no match" would be wrong: the caller
 * must rebuild the model and evaluate again.
 */
function staleLocatorError(): Error {
  const error = new Error(
    'target_stale: The page changed while the locator was evaluated.',
  );
  error.name = STALE_LOCATOR_ERROR_NAME;
  return error;
}

export function isStaleLocatorError(error: unknown): boolean {
  return error instanceof Error && error.name === STALE_LOCATOR_ERROR_NAME;
}

function boundedSend(
  deps: LocatorEvaluationDeps,
  method: string,
  params: Record<string, unknown>,
  sessionId: string,
): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Locator evaluation timed out.'));
    }, LOCATOR_REQUEST_TIMEOUT_MS);
    deps.send(method, params, sessionId).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function errorMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (isRecord(value) && isRecord(value.error)) {
    const message = value.error.message;
    return typeof message === 'string' ? message : '';
  }
  return '';
}

/** Evaluates a parsed locator only against page-model identities. */
export async function evaluateLocator(
  model: BrowserPageModel,
  deps: LocatorEvaluationDeps,
  parsed: ParsedLocator,
  scope?: LocatorScope,
  options: LocatorOptions = {},
): Promise<NodeIdentity[]> {
  const frames = scopedFrames(model, scope);
  if (frames.length === 0) return [];

  const matchedKeys = await evaluateParsed(
    model,
    deps,
    parsed,
    frames,
    options,
  );
  const results: NodeIdentity[] = [];
  const seen = new Set<string>();
  for (const node of model.nodes) {
    const key = identityKey(node.identity);
    if (!matchedKeys.has(key) || seen.has(key)) continue;
    seen.add(key);
    results.push(copyIdentity(node.identity));
  }
  return results;
}

function scopedFrames(
  model: BrowserPageModel,
  scope: LocatorScope | undefined,
): PageModelFrame[] {
  if (scope?.frames !== undefined) return scope.frames;
  if (scope?.frameRef === undefined) return model.frames;
  return model.frames.filter((frame) => frame.frameRef === scope.frameRef);
}

async function evaluateParsed(
  model: BrowserPageModel,
  deps: LocatorEvaluationDeps,
  parsed: ParsedLocator,
  frames: PageModelFrame[],
  options: LocatorOptions,
): Promise<Set<string>> {
  switch (parsed.kind) {
    case 'css': {
      const located = await queryFrames(
        model,
        deps,
        parsed.selector,
        frames,
        options.purpose === 'inspect' || options.existence === true,
        options.strictCss === true,
      );
      if (located.length > 0) return keysForLocatedNodes(located);
      return cssFallbackKeys(model, frames, parsed);
    }
    case 'frame': {
      const childFrames = await framesForFrameSelector(
        model,
        deps,
        parsed.frameSelector,
        frames,
        options.strictCss === true,
      );
      return evaluateParsed(model, deps, parsed.inner, childFrames, options);
    }
    default:
      return modelOnlyKeys(model, frames, parsed);
  }
}

/** The deleted preload fell back from CSS that matches nothing. */
function cssFallbackKeys(
  model: BrowserPageModel,
  frames: PageModelFrame[],
  parsed: Extract<ParsedLocator, { kind: 'css' }>,
): Set<string> {
  const testId = parsed.testIdFallback ?? parseTestIdLocator(parsed.selector);
  if (testId !== undefined) return testIdMatchKeys(model, frames, testId);
  if (parsed.explicit) return new Set<string>();
  const semantic = parseSemanticLocator(parsed.selector);
  return semantic === undefined
    ? new Set<string>()
    : evaluateSemantic(model, frames, semantic);
}

/**
 * Locator kinds evaluated over model nodes alone, without CDP. With `limit`,
 * kinds whose result is every node satisfying a predicate stop once that
 * many match; text and label locators always rank their full match set.
 */
function modelOnlyKeys(
  model: BrowserPageModel,
  frames: PageModelFrame[],
  parsed: Exclude<ParsedLocator, { kind: 'css' | 'frame' }>,
  limit?: number,
): Set<string> {
  return parsed.kind === 'testId'
    ? testIdMatchKeys(model, frames, parsed.value, limit)
    : evaluateSemantic(model, frames, parsed, limit);
}

/**
 * Whether the locator, evaluated in the model without CDP, matches exactly
 * the node with this identity: for checking locators the model generates.
 * Every kind except CSS shares the CDP path's code; CSS is matched in the
 * model for the selector forms the generators emit, and any other selector
 * counts as no match. Evaluation stops at a second match where it can.
 */
export function locatorMatchesOnlyInModel(
  model: BrowserPageModel,
  parsed: ParsedLocator,
  identity: NodeIdentity,
  options: { purpose?: 'inspect' } = {},
): boolean {
  const matchedKeys = evaluateParsedInModel(model, parsed, model.frames, {
    ...options,
    limit: 2,
  });
  return (
    matchedKeys !== undefined &&
    matchedKeys.size === 1 &&
    matchedKeys.has(identityKey(identity))
  );
}

function queryFramesInModel(
  model: BrowserPageModel,
  selector: string,
  frames: PageModelFrame[],
  includeSecretSelect: boolean,
): LocatedNode[] | undefined {
  const located: LocatedNode[] = [];
  for (const frame of frames) {
    const indexes = matchGeneratedSelector(
      model,
      frame,
      selector,
      includeSecretSelect,
    );
    if (!indexes) return undefined;
    for (const index of indexes) {
      const node = model.nodes[index];
      if (node) located.push({ index, node });
    }
  }
  return located;
}

function evaluateParsedInModel(
  model: BrowserPageModel,
  parsed: ParsedLocator,
  frames: PageModelFrame[],
  options: { purpose?: 'inspect'; limit?: number },
): Set<string> | undefined {
  switch (parsed.kind) {
    case 'css': {
      const located = queryFramesInModel(
        model,
        parsed.selector,
        frames,
        options.purpose === 'inspect',
      );
      if (!located) return undefined;
      if (located.length > 0) return keysForLocatedNodes(located);
      return cssFallbackKeys(model, frames, parsed);
    }
    case 'frame': {
      const childFrames = new Map<string, PageModelFrame>();
      for (const parentFrame of frames) {
        const owners = queryFramesInModel(
          model,
          parsed.frameSelector,
          [parentFrame],
          false,
        );
        if (!owners) return undefined;
        for (const childFrame of childFramesOwnedBy(
          model,
          parentFrame,
          owners,
        )) {
          childFrames.set(childFrame.frameRef, childFrame);
        }
      }
      return evaluateParsedInModel(
        model,
        parsed.inner,
        Array.from(childFrames.values()),
        options,
      );
    }
    default:
      return modelOnlyKeys(model, frames, parsed, options.limit);
  }
}

async function queryFrames(
  model: BrowserPageModel,
  deps: LocatorEvaluationDeps,
  selector: string,
  frames: PageModelFrame[],
  inspectSecretDescendants = false,
  strictCss = false,
): Promise<LocatedNode[]> {
  const results = await Promise.all(
    frames.map((frame) =>
      queryFrame(
        model,
        deps,
        selector,
        frame,
        inspectSecretDescendants,
        strictCss,
      ),
    ),
  );
  return results.flat();
}

async function queryFrame(
  model: BrowserPageModel,
  deps: LocatorEvaluationDeps,
  selector: string,
  frame: PageModelFrame,
  inspectSecretDescendants = false,
  strictCss = false,
): Promise<LocatedNode[]> {
  const rootIds = Array.from(new Set(frame.queryRootNodeIds));
  const rootResults = await Promise.all(
    rootIds.map(async (rootNodeId): Promise<QueryRootResult> => {
      let response: unknown;
      try {
        response = await boundedSend(
          deps,
          'DOM.querySelectorAll',
          { nodeId: rootNodeId, selector },
          frame.sessionId,
        );
      } catch (error) {
        if (STALE_NODE_MESSAGE.test(errorMessage(error))) {
          throw staleLocatorError();
        }
        if (errorMessage(error) === 'Locator evaluation timed out.') {
          throw error;
        }
        if (strictCss && INVALID_SELECTOR_MESSAGE.test(errorMessage(error))) {
          throw invalidSelectorError();
        }
        // An invalid selector matches nothing, as in the preload.
        return { rootNodeId, nodeIds: new Set<number>() };
      }
      if (STALE_NODE_MESSAGE.test(errorMessage(response))) {
        throw staleLocatorError();
      }
      return { rootNodeId, nodeIds: decodeNodeIds(response) };
    }),
  );

  const rootsByNodeId = new Map<number, Set<number>>();
  for (const rootResult of rootResults) {
    rootsByNodeId.set(rootResult.rootNodeId, rootResult.nodeIds);
  }

  const located: LocatedNode[] = [];
  for (let index = 0; index < model.nodes.length; index += 1) {
    const node = model.nodes[index];
    if (!node) continue;
    if (
      node.nodeType !== 1 ||
      node.identity.sessionId !== frame.sessionId ||
      node.identity.frameId !== frame.frameId ||
      node.frameRef !== frame.frameRef ||
      (node.insideSecretSelect && !inspectSecretDescendants)
    ) {
      continue;
    }
    const rootNodeIds = rootsByNodeId.get(node.scopeNodeId);
    if (rootNodeIds?.has(node.nodeId)) located.push({ index, node });
  }
  return located;
}

/**
 * The model frames whose owner element matches `selector` in one of
 * `parentFrames`, as `page.frameLocator(selector)` selects them. A frame
 * the model omitted is not among them.
 */
export async function framesForFrameSelector(
  model: BrowserPageModel,
  deps: LocatorEvaluationDeps,
  selector: string,
  parentFrames: PageModelFrame[],
  strictCss = false,
): Promise<PageModelFrame[]> {
  const childFrames: Map<string, PageModelFrame> = new Map();
  for (const parentFrame of parentFrames) {
    const owners = await queryFrame(
      model,
      deps,
      selector,
      parentFrame,
      false,
      strictCss,
    );
    for (const childFrame of childFramesOwnedBy(model, parentFrame, owners)) {
      childFrames.set(childFrame.frameRef, childFrame);
    }
  }
  return Array.from(childFrames.values());
}

function childFramesOwnedBy(
  model: BrowserPageModel,
  parentFrame: PageModelFrame,
  owners: LocatedNode[],
): PageModelFrame[] {
  const childFrames: PageModelFrame[] = [];
  for (const owner of owners) {
    for (const childFrame of model.frames) {
      if (isFrameOwnedBy(model, childFrame, parentFrame, owner)) {
        childFrames.push(childFrame);
      }
    }
  }
  return childFrames;
}

function isFrameOwnedBy(
  model: BrowserPageModel,
  childFrame: PageModelFrame,
  parentFrame: PageModelFrame,
  owner: LocatedNode,
): boolean {
  const ownerIndexMatches = childFrame.ownerNodeIndex === owner.index;
  const ownerFrameIdMatches =
    owner.node.childFrameId !== undefined &&
    childFrame.frameId === owner.node.childFrameId;
  const parentMatches =
    childFrame.parentFrameId === parentFrame.frameId ||
    (childFrame.parentFrameId === undefined && ownerIndexMatches);
  const nodeIsInParentFrame =
    model.nodes[owner.index]?.identity.frameId === parentFrame.frameId &&
    model.nodes[owner.index]?.identity.sessionId === parentFrame.sessionId;
  return (
    nodeIsInParentFrame &&
    parentMatches &&
    (ownerIndexMatches || ownerFrameIdMatches)
  );
}

function keysForNodes(
  model: BrowserPageModel,
  frames: PageModelFrame[],
  predicate: (node: PageModelNode) => boolean,
  candidates: PageModelNode[] = model.nodes,
  limit: number = Number.POSITIVE_INFINITY,
): Set<string> {
  const matched = new Set<string>();
  const inFrames = frameMembership(frames);
  for (const node of candidates) {
    if (
      node.nodeType !== 1 ||
      node.insideSecretSelect ||
      !inFrames(node) ||
      !predicate(node)
    ) {
      continue;
    }
    matched.add(identityKey(node.identity));
    if (matched.size >= limit) break;
  }
  return matched;
}

function textMatchKeys(
  model: BrowserPageModel,
  frames: PageModelFrame[],
  rawValue: string,
  exactOnly = false,
): Set<string> {
  // The preload compares the query as given (never compacted or cut) with
  // each element's compacted text.
  const value = rawValue;
  if (value.length === 0) return new Set<string>();

  // Exact matches win over substring matches, so the substring scan is
  // needed only when no element's text equals the value.
  const exact = (textElements(model).exact.get(value) ?? []).filter((node) =>
    nodeIsInFrames(node, frames),
  );
  const pool =
    exact.length > 0 || exactOnly
      ? exact
      : textElements(model)
          .entries.filter(
            (entry) =>
              entry.text.includes(value) && nodeIsInFrames(entry.node, frames),
          )
          .map((entry) => entry.node);
  const preferred = pool.filter(
    (node) =>
      isInteractiveElement(node) || !hasMatchingTextChild(model, node, value),
  );
  if (preferred.length > 0) return keysForNodeList(preferred);
  const fallback = pool[pool.length - 1];
  return fallback ? keysForNodeList([fallback]) : new Set<string>();
}

interface TextIndex {
  entries: Array<{ node: PageModelNode; text: string }>;
  exact: Map<string, PageModelNode[]>;
}

const textIndexes = new WeakMap<BrowserPageModel, TextIndex>();

/**
 * Elements a text locator can match, with their compacted text, in model
 * order (cached per model): not `html`/`body`, not inside a secret select,
 * and with text, since a non-empty value never matches empty text.
 */
function textElements(model: BrowserPageModel): TextIndex {
  const cached = textIndexes.get(model);
  if (cached) return cached;
  const index: TextIndex = { entries: [], exact: new Map() };
  for (const node of model.nodes) {
    if (node.nodeType !== 1 || node.insideSecretSelect) continue;
    if (['html', 'body'].includes(node.tagName.toLowerCase())) continue;
    const text = compactText(matchingText(node));
    if (text.length === 0) continue;
    index.entries.push({ node, text });
    const list = index.exact.get(text);
    if (list) list.push(node);
    else index.exact.set(text, [node]);
  }
  textIndexes.set(model, index);
  return index;
}

function hasMatchingTextChild(
  model: BrowserPageModel,
  node: PageModelNode,
  value: string,
): boolean {
  for (const childIndex of node.childIndexes) {
    const child = model.nodes[childIndex];
    if (
      child &&
      child.nodeType === 1 &&
      !child.insideSecretSelect &&
      child.frameRef === node.frameRef &&
      child.scopeNodeId === node.scopeNodeId &&
      child.identity.frameId === node.identity.frameId &&
      child.identity.sessionId === node.identity.sessionId &&
      textMatches(child, value)
    ) {
      return true;
    }
  }
  return false;
}

function evaluateSemantic(
  model: BrowserPageModel,
  frames: PageModelFrame[],
  parsed: Extract<
    ParsedLocator,
    { kind: 'role' | 'label' | 'placeholder' | 'alt' | 'text' }
  >,
  limit?: number,
): Set<string> {
  switch (parsed.kind) {
    case 'role':
      return keysForNodes(
        model,
        frames,
        (node) => {
          if (parsed.name === undefined || parsed.name.length === 0) {
            return true;
          }
          const name = accessibleName(model, node);
          return name === parsed.name || name.includes(parsed.name);
        },
        nodesWithRole(model, parsed.role),
        limit,
      );
    case 'label':
      return labelMatchKeys(model, frames, parsed.value);
    case 'placeholder':
      return keysForNodes(
        model,
        frames,
        () => true,
        nodesWithAttribute(model, 'placeholder', parsed.value),
        limit,
      );
    case 'alt':
      return keysForNodes(
        model,
        frames,
        () => true,
        nodesWithAttribute(model, 'alt', parsed.value),
        limit,
      );
    case 'text':
      return textMatchKeys(model, frames, parsed.value, parsed.exact);
    default:
      return new Set<string>();
  }
}

const attributeIndexes = new WeakMap<
  BrowserPageModel,
  Map<string, Map<string, PageModelNode[]>>
>();
const roleIndexes = new WeakMap<
  BrowserPageModel,
  Map<string, PageModelNode[]>
>();

/** Elements whose attribute equals `value`, in model order (cached per model). */
function nodesWithAttribute(
  model: BrowserPageModel,
  name: string,
  value: string,
): PageModelNode[] {
  let byName = attributeIndexes.get(model);
  if (!byName) {
    byName = new Map();
    attributeIndexes.set(model, byName);
  }
  let byValue = byName.get(name);
  if (!byValue) {
    byValue = new Map();
    for (const node of model.nodes) {
      if (node.nodeType !== 1) continue;
      const attribute = attributeValue(node, name);
      if (attribute === undefined) continue;
      const list = byValue.get(attribute);
      if (list) list.push(node);
      else byValue.set(attribute, [node]);
    }
    byName.set(name, byValue);
  }
  return byValue.get(value) ?? [];
}

const tagIndexes = new WeakMap<
  BrowserPageModel,
  Map<string, PageModelNode[]>
>();

/** Elements with this lowercase tag name, in model order (cached per model). */
function nodesWithTag(model: BrowserPageModel, tag: string): PageModelNode[] {
  let byTag = tagIndexes.get(model);
  if (!byTag) {
    byTag = new Map();
    for (const node of model.nodes) {
      if (node.nodeType !== 1) continue;
      const name = node.tagName.toLowerCase();
      const list = byTag.get(name);
      if (list) list.push(node);
      else byTag.set(name, [node]);
    }
    tagIndexes.set(model, byTag);
  }
  return byTag.get(tag) ?? [];
}

/** Elements whose role equals `role`, in model order (cached per model). */
function nodesWithRole(model: BrowserPageModel, role: string): PageModelNode[] {
  let byRole = roleIndexes.get(model);
  if (!byRole) {
    byRole = new Map();
    for (const node of model.nodes) {
      if (node.nodeType !== 1) continue;
      const nodeRole = roleFor(node);
      if (nodeRole === undefined) continue;
      const list = byRole.get(nodeRole);
      if (list) list.push(node);
      else byRole.set(nodeRole, [node]);
    }
    roleIndexes.set(model, byRole);
  }
  return byRole.get(role) ?? [];
}

function testIdMatchKeys(
  model: BrowserPageModel,
  frames: PageModelFrame[],
  value: string,
  limit?: number,
): Set<string> {
  for (const attribute of TEST_ID_ATTRIBUTES) {
    const matches = keysForNodes(
      model,
      frames,
      () => true,
      nodesWithAttribute(model, attribute, value),
      limit,
    );
    if (matches.size > 0) return matches;
  }
  return new Set<string>();
}

function labelMatchKeys(
  model: BrowserPageModel,
  frames: PageModelFrame[],
  value: string,
): Set<string> {
  const labels = nodesWithTag(model, 'label').filter(
    (node) =>
      !node.insideSecretSelect &&
      nodeIsInFrames(node, frames) &&
      compactText(node.labelText).includes(value),
  );
  const idIndex = labels.some((label) => attributeValue(label, 'for'))
    ? firstElementsById(model, frames)
    : new Map<string, PageModelNode>();
  const matches: PageModelNode[] = [];
  for (const label of labels) {
    const forId = attributeValue(label, 'for');
    const target = forId
      ? idIndex.get(scopedIdKey(label, forId))
      : firstLabelControl(model, label);
    if (!target || target.insideSecretSelect) continue;
    const associatedText = labelTextForControl(model, target);
    if (
      associatedText === undefined ||
      !compactText(associatedText).includes(value)
    ) {
      continue;
    }
    matches.push(target);
  }
  return keysForNodeList(matches);
}

function scopedIdKey(node: PageModelNode, id: string): string {
  return JSON.stringify([
    node.frameRef,
    node.identity.sessionId,
    node.identity.frameId,
    node.scopeNodeId,
    id,
  ]);
}

const idIndexes = new WeakMap<
  BrowserPageModel,
  Map<string, Map<string, PageModelNode>>
>();

/**
 * `getElementById` per document or shadow root: the first element wins.
 * Cached per model and frame set.
 */
function firstElementsById(
  model: BrowserPageModel,
  frames: PageModelFrame[],
): Map<string, PageModelNode> {
  let byFrames = idIndexes.get(model);
  if (!byFrames) {
    byFrames = new Map();
    idIndexes.set(model, byFrames);
  }
  const framesKey = frames.map((frame) => frame.frameRef).join('\u0000');
  const cached = byFrames.get(framesKey);
  if (cached) return cached;
  const index = new Map<string, PageModelNode>();
  for (const node of model.nodes) {
    if (node.nodeType !== 1 || !nodeIsInFrames(node, frames)) continue;
    const id = attributeValue(node, 'id');
    if (id === undefined) continue;
    const key = scopedIdKey(node, id);
    if (!index.has(key)) index.set(key, node);
  }
  byFrames.set(framesKey, index);
  return index;
}

function firstLabelControl(
  model: BrowserPageModel,
  label: PageModelNode,
): PageModelNode | undefined {
  const pending = [...label.childIndexes];
  const visited = new Set<number>();
  while (pending.length > 0) {
    const childIndex = pending.shift();
    if (childIndex === undefined || visited.has(childIndex)) continue;
    visited.add(childIndex);
    const child = model.nodes[childIndex];
    if (
      !child ||
      child.nodeType !== 1 ||
      child.frameRef !== label.frameRef ||
      child.scopeNodeId !== label.scopeNodeId ||
      child.identity.frameId !== label.identity.frameId ||
      child.identity.sessionId !== label.identity.sessionId ||
      child.insideSecretSelect
    ) {
      continue;
    }
    const tagName = child.tagName.toLowerCase();
    if (['input', 'textarea', 'select', 'button'].includes(tagName)) {
      return child;
    }
    pending.unshift(...child.childIndexes);
  }
  return undefined;
}

const framesByRef = new WeakMap<
  PageModelFrame[],
  Map<string, PageModelFrame>
>();

/** A membership test for these frames, built once per frame list. */
function frameMembership(
  frames: PageModelFrame[],
): (node: PageModelNode) => boolean {
  let byRef = framesByRef.get(frames);
  if (!byRef) {
    byRef = new Map(frames.map((frame) => [frame.frameRef, frame]));
    framesByRef.set(frames, byRef);
  }
  const lookup = byRef;
  return (node) => {
    const frame = lookup.get(node.frameRef);
    return (
      frame !== undefined &&
      node.identity.frameId === frame.frameId &&
      node.identity.sessionId === frame.sessionId
    );
  };
}

function nodeIsInFrames(
  node: PageModelNode,
  frames: PageModelFrame[],
): boolean {
  return frameMembership(frames)(node);
}

/**
 * The text a text locator compares with: the element's text with the
 * content of secret controls left out (`nameText`), not its output text,
 * which is empty around any secret. A D13 label in a frame or shadow root
 * has none, as in output.
 */
function matchingText(node: PageModelNode): string {
  return node.nameText ?? node.text;
}

function textMatches(node: PageModelNode, value: string): boolean {
  const text = compactText(matchingText(node));
  return text === value || text.includes(value);
}

function keysForLocatedNodes(located: LocatedNode[]): Set<string> {
  return keysForNodeList(located.map((candidate) => candidate.node));
}

function keysForNodeList(nodes: PageModelNode[]): Set<string> {
  return new Set(nodes.map((node) => identityKey(node.identity)));
}

function decodeNodeIds(response: unknown): Set<number> {
  if (!isRecord(response) || !Array.isArray(response.nodeIds)) {
    return new Set<number>();
  }
  const nodeIds = new Set<number>();
  for (const nodeId of response.nodeIds) {
    if (
      typeof nodeId === 'number' &&
      Number.isSafeInteger(nodeId) &&
      nodeId > 0
    ) {
      nodeIds.add(nodeId);
    }
  }
  return nodeIds;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function identityKey(identity: NodeIdentity): string {
  return JSON.stringify([
    identity.sessionId,
    identity.frameId,
    identity.loaderId,
    identity.backendNodeId,
  ]);
}

function attributeValue(node: PageModelNode, name: string): string | undefined {
  const normalizedName = name.toLowerCase();
  for (const [attributeName, value] of Object.entries(node.attributes)) {
    if (attributeName.toLowerCase() === normalizedName) return value;
  }
  return undefined;
}

function copyIdentity(identity: NodeIdentity): NodeIdentity {
  return {
    frameId: identity.frameId,
    sessionId: identity.sessionId,
    loaderId: identity.loaderId,
    backendNodeId: identity.backendNodeId,
  };
}
