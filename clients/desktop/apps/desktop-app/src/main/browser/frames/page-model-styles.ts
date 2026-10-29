import {
  isCDPRecord,
  readCDPArray,
  readCDPString,
  type DomTreeNode,
} from './cdp-decode';
import { attributeReader, isInteractiveAttributes } from './model-semantics';
import type {
  BrowserPageModel,
  PageModelDeps,
  PageModelStyleRead,
} from './model-types';
import type { FrameContext } from './page-model-capture';
import {
  elapsed,
  isAbortError,
  REQUEST_TIMEOUT_MS,
  sendOnce,
  withTimeout,
} from './page-model-cdp';

/** Missing-layout style reads per build, across every frame. */
export const MAX_MISSING_LAYOUT_STYLE_NODES = 1_000;
/** The supplement is optional: past this, unread candidates count as hidden. */
export const STYLE_SUPPLEMENT_TIMEOUT_MS = 2_000;
const MAX_STYLE_REQUEST_CONCURRENCY = 20;

/** A read style, or `'unknown'` when the read was capped or failed. */
export type StyleOutcome = PageModelStyleRead | 'unknown';

export interface StyleSupplement {
  styles: Map<DomTreeNode, StyleOutcome>;
  summary: BrowserPageModel['styleSupplement'];
  durationMs: number;
}

/**
 * Visits a frame's own nodes in document order: light children and open or
 * closed shadow roots. User-agent shadow roots and child frame documents are
 * not part of the frame's model.
 */
export function forEachFrameNode(
  document: DomTreeNode,
  visit: (node: DomTreeNode) => void,
): void {
  const pending: DomTreeNode[] = [document];
  while (pending.length > 0) {
    const node = pending.pop();
    if (!node) break;
    visit(node);
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      pending.push(node.children[index]);
    }
    for (let index = node.shadowRoots.length - 1; index >= 0; index -= 1) {
      const root = node.shadowRoots[index];
      if (root.shadowRootType !== 'user-agent') pending.push(root);
    }
  }
}

/**
 * Interactive elements without a layout box: exactly the nodes the
 * projection could emit as rows whose own `display`/`visibility` the snapshot
 * did not report. Elements hidden by attribute are hidden either way.
 */
export function styleCandidates(context: FrameContext): DomTreeNode[] {
  const candidates: DomTreeNode[] = [];
  forEachFrameNode(context.document, (node) => {
    if (node.nodeType !== 1) return;
    if (context.capture.snapshot.nodes.get(node.backendNodeId)?.bounds) return;
    const read = attributeReader(node.attributes);
    if (!isInteractiveAttributes(node.nodeName, read)) return;
    if (read('hidden') !== undefined || read('aria-hidden') === 'true') return;
    candidates.push(node);
  });
  return candidates;
}

function decodeStyleRead(value: unknown): PageModelStyleRead | undefined {
  if (!isCDPRecord(value)) return undefined;
  const display = readCDPString(value.display);
  const visibility = readCDPString(value.visibility);
  return display === undefined || visibility === undefined
    ? undefined
    : { display, visibility };
}

function decodeComputedStyleResponse(
  response: unknown,
): PageModelStyleRead | undefined {
  if (!isCDPRecord(response)) return undefined;
  const entries = readCDPArray(response.computedStyle);
  if (!entries) return undefined;
  let display: string | undefined;
  let visibility: string | undefined;
  for (const entry of entries) {
    if (!isCDPRecord(entry)) continue;
    const name = readCDPString(entry.name);
    const value = readCDPString(entry.value);
    if (name === 'display') display = value;
    else if (name === 'visibility') visibility = value;
  }
  return display === undefined || visibility === undefined
    ? undefined
    : { display, visibility };
}

/**
 * Fallback when the host has no isolated context for a frame. `CSS.enable`
 * keeps the session reporting style-sheet changes, so it is disabled again.
 */
async function readStylesThroughCSS(
  deps: PageModelDeps,
  context: FrameContext,
  nodes: DomTreeNode[],
  deadline: number,
): Promise<Array<PageModelStyleRead | undefined>> {
  const sessionId = context.registered.sessionId;
  const results: Array<PageModelStyleRead | undefined> = nodes.map(
    () => undefined,
  );
  try {
    await sendOnce(
      deps,
      'CSS.enable',
      {},
      sessionId,
      REQUEST_TIMEOUT_MS,
      deadline,
    );
  } catch (error) {
    if (isAbortError(error)) throw error;
    return results;
  }
  try {
    for (
      let offset = 0;
      offset < nodes.length && deps.now() < deadline;
      offset += MAX_STYLE_REQUEST_CONCURRENCY
    ) {
      const batch = nodes.slice(offset, offset + MAX_STYLE_REQUEST_CONCURRENCY);
      await Promise.all(
        batch.map(async (node, index) => {
          try {
            const response = await sendOnce(
              deps,
              'CSS.getComputedStyleForNode',
              { nodeId: node.nodeId },
              sessionId,
              REQUEST_TIMEOUT_MS,
              deadline,
            );
            results[offset + index] = decodeComputedStyleResponse(response);
          } catch (error) {
            if (isAbortError(error)) throw error;
          }
        }),
      );
    }
  } finally {
    void deps.send('CSS.disable', {}, sessionId).catch(() => undefined);
  }
  return results;
}

async function readFrameStyles(
  deps: PageModelDeps,
  context: FrameContext,
  nodes: DomTreeNode[],
  deadline: number,
): Promise<Array<PageModelStyleRead | undefined>> {
  const unread = (): Array<PageModelStyleRead | undefined> =>
    nodes.map(() => undefined);
  if (deps.readStyles) {
    const remaining = deadline - deps.now();
    if (remaining <= 0) return unread();
    try {
      const result: unknown = await withTimeout(
        deps.readStyles(
          context.registered.frameId,
          context.registered.sessionId,
          nodes.map((node) => node.backendNodeId),
        ),
        remaining,
        deps.signal,
      );
      if (result !== undefined) {
        const values = readCDPArray(result);
        if (!values || values.length !== nodes.length) return unread();
        return values.map(decodeStyleRead);
      }
    } catch (error) {
      if (isAbortError(error)) throw error;
      return unread();
    }
  }
  return readStylesThroughCSS(deps, context, nodes, deadline);
}

/**
 * Reads `display`/`visibility` for interactive nodes the snapshot gave no
 * layout box, so the preload's own-style hidden rule still applies (a child
 * of `display: none` keeps its own display; a `display: contents` wrapper is
 * visible). The main frame's candidates take the per-build budget first.
 * A candidate that is capped or fails is `'unknown'`: its own row counts as
 * hidden, its descendants are unaffected.
 */
export async function readMissingLayoutStyles(
  deps: PageModelDeps,
  contexts: FrameContext[],
): Promise<StyleSupplement> {
  const startedAt = deps.now();
  const deadline = startedAt + STYLE_SUPPLEMENT_TIMEOUT_MS;
  const styles = new Map<DomTreeNode, StyleOutcome>();
  let candidates = 0;
  let read = 0;
  let skipped = 0;
  let capped = false;
  let failed = false;
  let budget = MAX_MISSING_LAYOUT_STYLE_NODES;
  const work: Array<{ context: FrameContext; nodes: DomTreeNode[] }> = [];
  for (const context of contexts) {
    const nodes = styleCandidates(context);
    candidates += nodes.length;
    const admitted = nodes.slice(0, Math.max(0, budget));
    budget -= admitted.length;
    for (const node of nodes.slice(admitted.length)) {
      styles.set(node, 'unknown');
      skipped += 1;
      capped = true;
    }
    if (admitted.length > 0) work.push({ context, nodes: admitted });
  }
  await Promise.all(
    work.map(async ({ context, nodes }) => {
      const results = await readFrameStyles(deps, context, nodes, deadline);
      nodes.forEach((node, index) => {
        const result = results[index];
        if (result) {
          styles.set(node, result);
          read += 1;
        } else {
          styles.set(node, 'unknown');
          skipped += 1;
          failed = true;
        }
      });
    }),
  );
  const reason =
    capped && failed
      ? 'cap_and_error'
      : capped
        ? 'cap'
        : failed
          ? 'error'
          : undefined;
  return {
    styles,
    summary: {
      candidates,
      read,
      skipped,
      ...(reason === undefined ? {} : { reason }),
    },
    durationMs: elapsed(startedAt, deps.now()),
  };
}
