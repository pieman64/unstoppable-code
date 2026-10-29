import { classifySecretField } from '@canopy/desktop-shared/browser/secret-fields';
import { readCDPArray, type DomTreeNode } from './cdp-decode';
import { attributeReader } from './model-semantics';
import type {
  BrowserPageModel,
  ControlHistory,
  PageModelDeps,
  TrackerMemory,
  TrackerScope,
} from './model-types';
import type { FrameContext } from './page-model-capture';
import {
  elapsed,
  ensureNotAborted,
  isAbortError,
  withTimeout,
} from './page-model-cdp';

/** Bound for one password-history bridge call. */
const HISTORY_TIMEOUT_MS = 2_000;

/** Most inputs asked about per build; the rest stay unknown (D6). */
export const MAX_TRACKER_QUERIES = 200;

export interface HistoryCollection {
  /**
   * Password history of every input the model needs it for, by tree node.
   * An input without an entry is unknown, and unknown counts as secret.
   */
  history: Map<DomTreeNode, ControlHistory>;
  summary: BrowserPageModel['trackerHistory'];
}

interface ScopedInput {
  node: DomTreeNode;
  /** `preload` is main-frame light DOM, which the preload tracks. */
  scope: TrackerScope | 'preload';
}

/** A frame's inputs, light DOM and shadow roots, not child documents. */
function inputsOf(context: FrameContext, isRoot: boolean): ScopedInput[] {
  const inputs: ScopedInput[] = [];
  const pending: Array<{ node: DomTreeNode; inShadow: boolean }> = [
    { node: context.document, inShadow: false },
  ];
  while (pending.length > 0) {
    const item = pending.pop();
    if (!item) break;
    const { node, inShadow } = item;
    if (node.nodeType === 1 && node.nodeName.toLowerCase() === 'input') {
      inputs.push({
        node,
        scope: inShadow ? 'shadow' : isRoot ? 'preload' : 'light',
      });
    }
    // Model order: a host's shadow tree comes before its light children.
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      pending.push({ node: node.children[index], inShadow });
    }
    for (let index = node.shadowRoots.length - 1; index >= 0; index -= 1) {
      const root = node.shadowRoots[index];
      if (root.shadowRootType === 'open' || root.shadowRootType === 'closed') {
        pending.push({ node: root, inShadow: true });
      }
    }
  }
  return inputs;
}

/** Secret by its current type or autocomplete, in the tree or the snapshot. */
function secretNow(context: FrameContext, node: DomTreeNode): boolean {
  const read = attributeReader(node.attributes);
  const info = context.capture.snapshot.nodes.get(node.backendNodeId);
  return (
    classifySecretField({
      tagName: 'input',
      type: read('type') ?? null,
      autocomplete: read('autocomplete') ?? null,
      insideSecretSelect: false,
      everPassword: false,
    }) ||
    (info !== undefined &&
      classifySecretField({
        tagName: 'input',
        type: info.type ?? null,
        autocomplete: info.autocomplete ?? null,
        insideSecretSelect: false,
        everPassword: false,
      }))
  );
}

function hasLabelAncestor(node: DomTreeNode): boolean {
  for (
    let current = node.parent;
    current && current.nodeType === 1;
    current = current.parent
  ) {
    if (current.nodeName.toLowerCase() === 'label') return true;
  }
  return false;
}

/**
 * Whether an input's secrecy changes what can leak (D6): it has a live value
 * (or the snapshot could not see it), a `value` attribute, or sits in a
 * `<label>`, whose text the page may derive from it.
 */
function canLeak(context: FrameContext, node: DomTreeNode): boolean {
  const info = context.capture.snapshot.nodes.get(node.backendNodeId);
  if (info === undefined || info.inputValue === undefined) return true;
  if (info.inputValue !== '') return true;
  if ((attributeReader(node.attributes)('value') ?? '') !== '') return true;
  return hasLabelAncestor(node);
}

/** One holder's per-element answers, or undefined when it did not answer. */
type HolderAnswers = Map<DomTreeNode, ControlHistory> | undefined;

function isControlHistory(value: unknown): value is ControlHistory {
  return value === 'never' || value === 'was' || value === 'unknown';
}

/**
 * The preload's history. For its own scope (main-frame light DOM) `false`
 * is "never"; for inputs that moved into a shadow root (`remembered`) only
 * `true` means anything.
 */
async function askPreload(
  deps: PageModelDeps,
  root: FrameContext,
  inputs: DomTreeNode[],
  purpose: 'scope' | 'remembered',
): Promise<HolderAnswers> {
  if (inputs.length === 0) return new Map();
  try {
    ensureNotAborted(deps.signal);
    const { frameId, sessionId } = root.registered;
    const ids = inputs.map((input) => input.backendNodeId);
    const raw: unknown = await withTimeout(
      purpose === 'scope'
        ? deps.isPasswordEverSeen(frameId, sessionId, ids)
        : deps.isPasswordEverSeen(frameId, sessionId, ids, 'remembered'),
      HISTORY_TIMEOUT_MS,
      deps.signal,
    );
    const values = readCDPArray(raw);
    if (
      !values ||
      values.length !== inputs.length ||
      values.some((value) => typeof value !== 'boolean')
    ) {
      return undefined;
    }
    const answers = new Map<DomTreeNode, ControlHistory>();
    inputs.forEach((input, index) => {
      answers.set(
        input,
        values[index] === true
          ? 'was'
          : purpose === 'scope'
            ? 'never'
            : 'unknown',
      );
    });
    return answers;
  } catch (error) {
    if (isAbortError(error)) throw error;
    return undefined;
  }
}

/**
 * Asks one frame's tracker. An answer counts only if it is well formed and
 * the frame still shows the captured document afterwards.
 */
async function askTracker(
  deps: PageModelDeps,
  context: FrameContext,
  scope: TrackerScope,
  inputs: DomTreeNode[],
): Promise<HolderAnswers> {
  if (!deps.controlHistory) return undefined;
  if (inputs.length === 0) return new Map();
  const { frameId, sessionId, loaderId } = context.registered;
  try {
    ensureNotAborted(deps.signal);
    const raw: unknown = await withTimeout(
      deps.controlHistory(
        frameId,
        sessionId,
        scope,
        inputs.map((input) => input.backendNodeId),
      ),
      HISTORY_TIMEOUT_MS,
      deps.signal,
    );
    const values = readCDPArray(raw);
    if (
      !values ||
      values.length !== inputs.length ||
      !values.every(isControlHistory)
    ) {
      return undefined;
    }
    const current = deps.registry.getFrame(frameId);
    if (current?.loaderId !== loaderId || current.sessionId !== sessionId) {
      return undefined;
    }
    const answers = new Map<DomTreeNode, ControlHistory>();
    inputs.forEach((input, index) => {
      const value = values[index];
      if (value !== undefined) answers.set(input, value);
    });
    return answers;
  } catch (error) {
    if (isAbortError(error)) throw error;
    return undefined;
  }
}

/** Whether a tracker remembers any password; `unknown` on any failure. */
async function askSummary(
  deps: PageModelDeps,
  context: FrameContext,
  scope: TrackerScope,
): Promise<TrackerMemory> {
  if (!deps.controlHistorySummary) return 'unknown';
  try {
    ensureNotAborted(deps.signal);
    const value: unknown = await withTimeout(
      deps.controlHistorySummary(
        context.registered.frameId,
        context.registered.sessionId,
        scope,
      ),
      HISTORY_TIMEOUT_MS,
      deps.signal,
    );
    return value === 'none' || value === 'some' ? value : 'unknown';
  } catch (error) {
    if (isAbortError(error)) throw error;
    return 'unknown';
  }
}

/** An input's holders: the one for its current scope and the others. */
interface Candidate {
  node: DomTreeNode;
  context: FrameContext;
  scope: TrackerScope | 'preload';
  /** Within the per-build budget of inputs asked about trackers. */
  budgeted: boolean;
}

/** The holders outside a candidate's scope that can remember it. */
function otherHolders(
  candidate: Candidate,
  isRoot: boolean,
): Array<TrackerScope | 'preload'> {
  if (candidate.scope === 'preload') return ['shadow'];
  if (candidate.scope === 'light') return ['shadow'];
  return [isRoot ? 'preload' : 'light'];
}

/**
 * Password history for every input in the captured frames (decisions D2 to
 * D6). History belongs to the element (D5): an input moved between light
 * DOM and a shadow root, or between roots, is secret if any holder that can
 * know it remembers it. Holders: the preload (main-frame light DOM), the
 * isolated tracker (a child frame's light DOM) and the main-world tracker
 * (shadow roots, any frame). Outside main-frame light DOM, "never" needs
 * the current holder's "never" AND every other holder's vouch: an empty
 * summary, or an available per-input answer that is not "was". Unknown
 * summaries and failed asks fail closed. Main-frame light DOM preserves
 * the legacy limit: its preload answer stands if the shadow holder is
 * unavailable. A tracker outside the scope is asked only for summary "some";
 * the preload is always asked about main-frame shadow inputs.
 * An input secret by type or autocomplete needs none; one with nothing that
 * could leak is never a password for output purposes and is not asked
 * about (D6).
 */
export async function collectControlHistory(
  deps: PageModelDeps,
  contexts: FrameContext[],
  rootFrameId: string,
): Promise<HistoryCollection> {
  const startedAt = deps.now();
  const history = new Map<DomTreeNode, ControlHistory>();
  const preloadLight: DomTreeNode[] = [];
  const candidates: Candidate[] = [];
  let rootContext: FrameContext | undefined;
  let inputCount = 0;
  let budget = MAX_TRACKER_QUERIES;
  for (const context of contexts) {
    const isRoot = context.registered.frameId === rootFrameId;
    if (isRoot) rootContext = context;
    for (const { node, scope } of inputsOf(context, isRoot)) {
      if (scope === 'preload') {
        // The preload answers for all of its scope, as in phase 04.
        preloadLight.push(node);
        if (!secretNow(context, node) && canLeak(context, node))
          candidates.push({ node, context, scope, budgeted: false });
        continue;
      }
      if (secretNow(context, node)) continue;
      inputCount += 1;
      if (!canLeak(context, node)) {
        history.set(node, 'never');
        continue;
      }
      if (budget <= 0) continue;
      budget -= 1;
      candidates.push({ node, context, scope, budgeted: true });
    }
  }

  // Which holders outside an input's scope remember anything, per frame.
  const memoryKey = (context: FrameContext, holder: TrackerScope): string =>
    `${holder}\u0000${context.registered.frameId}`;
  const memoryAsks = new Map<
    string,
    { context: FrameContext; holder: TrackerScope }
  >();
  for (const candidate of candidates) {
    const isRoot = candidate.context.registered.frameId === rootFrameId;
    for (const holder of otherHolders(candidate, isRoot)) {
      if (holder === 'preload') continue;
      memoryAsks.set(memoryKey(candidate.context, holder), {
        context: candidate.context,
        holder,
      });
    }
  }
  const scopeAsks = new Map<
    string,
    { context: FrameContext; holder: TrackerScope; inputs: DomTreeNode[] }
  >();
  for (const candidate of candidates) {
    if (candidate.scope === 'preload') continue;
    const key = memoryKey(candidate.context, candidate.scope);
    const ask = scopeAsks.get(key) ?? {
      context: candidate.context,
      holder: candidate.scope,
      inputs: [],
    };
    ask.inputs.push(candidate.node);
    scopeAsks.set(key, ask);
  }
  const rootShadowInputs = candidates
    .filter(
      (candidate) =>
        candidate.scope === 'shadow' &&
        candidate.context.registered.frameId === rootFrameId,
    )
    .map((candidate) => candidate.node);

  const [preloadScope, preloadRemembered, scopeAnswers, memories] =
    await Promise.all([
      rootContext
        ? askPreload(deps, rootContext, preloadLight, 'scope')
        : Promise.resolve(undefined),
      rootContext && deps.controlHistory
        ? askPreload(deps, rootContext, rootShadowInputs, 'remembered')
        : Promise.resolve(undefined),
      Promise.all(
        Array.from(scopeAsks.values(), (ask) =>
          askTracker(deps, ask.context, ask.holder, ask.inputs),
        ),
      ),
      Promise.all(
        Array.from(
          memoryAsks.entries(),
          async ([key, ask]): Promise<[string, TrackerMemory]> => [
            key,
            await askSummary(deps, ask.context, ask.holder),
          ],
        ),
      ),
    ]);
  const memory = new Map<string, TrackerMemory>(memories);

  // Holders outside the scope that remember something are asked per input;
  // main-frame light inputs take whatever budget the others left, and the
  // rest are unknown, since a remembered password could be among them.
  const otherAsks = new Map<
    string,
    { context: FrameContext; holder: TrackerScope; inputs: DomTreeNode[] }
  >();
  const unaskable = new Set<DomTreeNode>();
  for (const candidate of candidates) {
    const isRoot = candidate.context.registered.frameId === rootFrameId;
    for (const holder of otherHolders(candidate, isRoot)) {
      if (holder === 'preload') continue;
      const key = memoryKey(candidate.context, holder);
      if (memory.get(key) !== 'some') continue;
      if (!candidate.budgeted) {
        if (budget <= 0) {
          unaskable.add(candidate.node);
          continue;
        }
        budget -= 1;
        candidate.budgeted = true;
      }
      const ask = otherAsks.get(key) ?? {
        context: candidate.context,
        holder,
        inputs: [],
      };
      ask.inputs.push(candidate.node);
      otherAsks.set(key, ask);
    }
  }
  const otherAnswers = await Promise.all(
    Array.from(otherAsks.values(), (ask) =>
      askTracker(deps, ask.context, ask.holder, ask.inputs),
    ),
  );

  const otherAnswer = new Map(
    Array.from(otherAsks.keys(), (key, index) => [key, otherAnswers[index]]),
  );

  const remembered = new Set<DomTreeNode>();
  for (const answers of [preloadRemembered, ...scopeAnswers, ...otherAnswers])
    for (const [node, value] of Array.from(answers?.entries() ?? []))
      if (value === 'was') remembered.add(node);
  const scopeAnswer = new Map<DomTreeNode, ControlHistory>();
  for (const answers of [preloadScope, ...scopeAnswers])
    for (const [node, value] of Array.from(answers?.entries() ?? []))
      scopeAnswer.set(node, value);

  let never = 0;
  let was = 0;
  for (const node of preloadLight) {
    const value = scopeAnswer.get(node);
    if (remembered.has(node)) history.set(node, 'was');
    else if (unaskable.has(node)) continue;
    else if (value === 'never' || value === 'was') history.set(node, value);
  }
  for (const candidate of candidates) {
    if (candidate.scope === 'preload') continue;
    const node = candidate.node;
    if (remembered.has(node)) {
      history.set(node, 'was');
      was += 1;
    } else if (
      scopeAnswer.get(node) === 'never' &&
      otherHolders(
        candidate,
        candidate.context.registered.frameId === rootFrameId,
      ).every((holder) => {
        if (holder === 'preload') return preloadRemembered?.has(node) === true;
        const key = memoryKey(candidate.context, holder);
        return (
          memory.get(key) === 'none' ||
          (memory.get(key) === 'some' &&
            otherAnswer.get(key)?.has(node) === true)
        );
      })
    ) {
      history.set(node, 'never');
      never += 1;
    }
  }
  return {
    history,
    summary: {
      inputs: inputCount,
      queried: MAX_TRACKER_QUERIES - budget,
      never,
      was,
      calls: deps.controlHistory ? scopeAsks.size + otherAsks.size : 0,
      summaries: deps.controlHistorySummary ? memoryAsks.size : 0,
      durationMs: elapsed(startedAt, deps.now()),
    },
  };
}
