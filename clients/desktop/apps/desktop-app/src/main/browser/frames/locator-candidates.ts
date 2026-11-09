import { parseLocator } from '@canopy/desktop-shared/browser/locator-grammar';
import type { BrowserLocatorCandidate } from '@canopy/execution-engine/types/browser';
import { locatorMatchesOnlyInModel } from './locators';
import {
  attributeForNode,
  domPathSelector,
  generateLocatorCandidates,
  quote,
  uniqueCssSelector,
} from './model-semantics';
import type {
  BrowserPageModel,
  PageModelFrame,
  PageModelNode,
} from './model-types';

const PAGE_PREFIX = 'page.';
const TEST_ID_ATTRIBUTES = ['data-testid', 'data-test', 'data-cy'];
const prefixes = new WeakMap<BrowserPageModel, Map<string, string | null>>();

/**
 * A page with only main-frame light DOM: the preload sees all of it, so its
 * candidates are used exactly as the preload makes them (C6 parity).
 */
export function isSingleScopeModel(model: BrowserPageModel): boolean {
  const [main, ...others] = model.frames;
  return others.length === 0 && (main?.queryRootNodeIds.length ?? 1) <= 1;
}

/**
 * Whether the locator parses with the shared grammar and evaluates to
 * exactly this node. The `inspect` purpose also matches inside secret
 * selects, so one match there is one match for every purpose.
 */
export function resolvesToNode(
  model: BrowserPageModel,
  locator: string,
  node: PageModelNode,
): boolean {
  const parsed = parseLocator(locator);
  if (parsed.kind === 'invalid') return false;
  return locatorMatchesOnlyInModel(model, parsed, node.identity, {
    purpose: 'inspect',
  });
}

/** The chain of frames from the main frame's child down to `frame`. */
function frameChain(
  model: BrowserPageModel,
  frame: PageModelFrame,
): PageModelFrame[] | undefined {
  const byId = new Map(model.frames.map((entry) => [entry.frameId, entry]));
  const chain: PageModelFrame[] = [];
  let current: PageModelFrame | undefined = frame;
  while (current?.parentFrameId !== undefined) {
    if (chain.includes(current)) return undefined;
    chain.unshift(current);
    current = byId.get(current.parentFrameId);
  }
  return current ? chain : undefined;
}

/**
 * `iframe[data-testid="..."]` for an owner with a test id that needs no CSS
 * escaping. Quotes are safe inside a `frameLocator('...')` argument.
 */
function ownerTestIdSelector(owner: PageModelNode): string | undefined {
  for (const name of TEST_ID_ATTRIBUTES) {
    const value = attributeForNode(owner, name)?.trim();
    if (!value) continue;
    return /["\\\r\n\f]/.test(value)
      ? undefined
      : `${owner.tagName}[${name}="${value}"]`;
  }
  return undefined;
}

/**
 * `page.frameLocator(...)...` reaching exactly the node's frame, choosing
 * for each owner its structural selector, its test id, or its full path.
 * `page` for the main frame; undefined when no supported form is unique.
 */
function framePrefix(
  model: BrowserPageModel,
  frameRef: string,
): string | undefined {
  let cache = prefixes.get(model);
  if (!cache) {
    cache = new Map();
    prefixes.set(model, cache);
  }
  const cached = cache.get(frameRef);
  if (cached !== undefined) return cached ?? undefined;
  const frame = model.frames.find((entry) => entry.frameRef === frameRef);
  const chain = frame ? frameChain(model, frame) : undefined;
  let prefix: string | undefined = chain ? 'page' : undefined;
  for (const child of chain ?? []) {
    const owner =
      child.ownerNodeIndex === undefined
        ? undefined
        : model.nodes[child.ownerNodeIndex];
    if (!owner || prefix === undefined) {
      prefix = undefined;
      break;
    }
    const scope = prefix;
    const testIdSelector = ownerTestIdSelector(owner);
    const options = Array.from(
      new Set([
        uniqueCssSelector(model, owner),
        ...(testIdSelector === undefined ? [] : [testIdSelector]),
        domPathSelector(model, owner),
      ]),
    );
    prefix = undefined;
    for (const selector of options) {
      const candidate = `${scope}.frameLocator(${quote(selector)})`;
      if (frameLocatorReaches(model, candidate, child)) {
        prefix = candidate;
        break;
      }
    }
  }
  cache.set(frameRef, prefix ?? null);
  return prefix;
}

/**
 * Whether `<prefix>.locator('html')` resolves to exactly `frame`'s root
 * element, i.e. the frame locators select that one frame and no other.
 */
function frameLocatorReaches(
  model: BrowserPageModel,
  prefix: string,
  frame: PageModelFrame,
): boolean {
  const root = model.nodes.find(
    (node) =>
      node.nodeType === 1 &&
      node.tagName === 'html' &&
      node.frameRef === frame.frameRef &&
      node.parentIndex !== undefined &&
      model.nodes[node.parentIndex]?.nodeType === 9,
  );
  const parsed = parseLocator(`${prefix}.locator('html')`);
  return (
    root !== undefined &&
    parsed.kind !== 'invalid' &&
    locatorMatchesOnlyInModel(model, parsed, root.identity, {
      purpose: 'inspect',
    })
  );
}

/**
 * The locator candidates the model hands out for a node. On a page with
 * only main-frame light DOM these are the preload's. Otherwise CSS is
 * evaluated in every document and shadow root of the frames in scope, and
 * the grammar has no shadow-host step, so each candidate is scoped with
 * `page.frameLocator(...)` for child frames and kept only if it parses and
 * resolves to exactly this node. A node can end up with none; it keeps its
 * ref. `first` stops at the first usable candidate.
 */
export function locatorCandidatesFor(
  model: BrowserPageModel,
  node: PageModelNode,
  options: { first?: boolean; candidates?: BrowserLocatorCandidate[] } = {},
): BrowserLocatorCandidate[] {
  // A model is frozen once built: the model's own candidates are verified
  // once per node, so paging over a cached model repeats no work.
  const memo =
    options.candidates === undefined
      ? options.first
        ? firstCandidates
        : allCandidates
      : undefined;
  const cached = memo?.get(node);
  if (cached) return cached;
  const result = computeLocatorCandidates(model, node, options);
  memo?.set(node, result);
  return result;
}

const firstCandidates = new WeakMap<PageModelNode, BrowserLocatorCandidate[]>();
const allCandidates = new WeakMap<PageModelNode, BrowserLocatorCandidate[]>();

function computeLocatorCandidates(
  model: BrowserPageModel,
  node: PageModelNode,
  options: { first?: boolean; candidates?: BrowserLocatorCandidate[] },
): BrowserLocatorCandidate[] {
  const generated =
    options.candidates ?? generateLocatorCandidates(model, node);
  if (isSingleScopeModel(model)) return generated;
  const prefix = framePrefix(model, node.frameRef);
  if (prefix === undefined) return [];
  const verified: BrowserLocatorCandidate[] = [];
  for (const candidate of generated) {
    const playwright = candidate.playwright;
    if (!playwright?.startsWith(PAGE_PREFIX)) continue;
    const scoped =
      prefix === 'page'
        ? playwright
        : `${prefix}.${playwright.slice(PAGE_PREFIX.length)}`;
    if (!resolvesToNode(model, scoped, node)) continue;
    verified.push({
      ...candidate,
      playwright: scoped,
      unique: true,
      confidence:
        candidate.kind === 'testId' || candidate.kind === 'css'
          ? 'high'
          : candidate.confidence,
    });
    if (options.first) break;
  }
  return verified;
}
