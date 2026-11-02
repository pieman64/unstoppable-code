import type { BrowserRectangle } from '@canopy/desktop-shared/types/browser';
import {
  decodeDOMSnapshot,
  decodeDomTree,
  decodeLayoutViewport,
  decodeLayoutZoom,
  PAGE_MODEL_COMPUTED_STYLES,
  restoreWhitespaceText,
  type DecodedDOMSnapshot,
  type DecodedDomTree,
  type DomTreeNode,
  type SnapshotDocumentInfo,
} from './cdp-decode';
import type { RegisteredFrame } from './frame-registry';
import type { PageModelDeps } from './model-types';
import {
  ensureNotAborted,
  isAbortError,
  REQUEST_RETRY_TIMEOUT_MS,
  REQUEST_TIMEOUT_MS,
  sendOnce,
} from './page-model-cdp';
import { requestPiercedDocument } from './pierced-document';

export interface SessionCapture {
  sessionId: string;
  tree: DecodedDomTree;
  /** Geometry already in CSS pixels; see `decodeDOMSnapshot`. */
  snapshot: DecodedDOMSnapshot;
  layoutViewport?: { width: number; height: number };
  /** Layout units per CSS pixel the snapshot was normalized with. */
  layoutZoom: number;
  /** `#document` nodes in this session, by frame ID. */
  documents: Map<string, DomTreeNode>;
  /** Frame owner elements (`iframe`, `frame`, ...) by the child's frame ID. */
  owners: Map<string, DomTreeNode>;
  /** Frame ID of every `#document` node in this session. */
  documentFrameIds: Map<DomTreeNode, string>;
}

export interface FrameContext {
  registered: RegisteredFrame;
  depth: number;
  capture: SessionCapture;
  /** The frame's `#document` node in its session's tree. */
  document: DomTreeNode;
  snapshotDocument?: SnapshotDocumentInfo;
  /**
   * Maps the frame's own viewport coordinates to the top-level viewport:
   * `top = translation + scale * local`. Owners that are not axis-aligned
   * with a positive scale are omitted, so this is always enough.
   */
  translationX: number;
  translationY: number;
  scaleX: number;
  scaleY: number;
  /** Visible part of the frame in top-level viewport coordinates. */
  clip: BrowserRectangle;
  /** The owner element in the parent frame's document. */
  owner?: DomTreeNode;
}

function isDocumentElement(node: DomTreeNode): boolean {
  return node.parent?.nodeType === 9;
}

/**
 * Chromium sets `frameId` on frame owner elements and on each `<html>`, never
 * on `#document`. A document's frame is the snapshot document rooted at it,
 * else its owner's frame, else its `<html>` element's frame.
 */
function documentFrameId(
  document: DomTreeNode,
  snapshotFrameByRoot: Map<number, string>,
): string | undefined {
  const fromSnapshot = snapshotFrameByRoot.get(document.backendNodeId);
  if (fromSnapshot) return fromSnapshot;
  const owner = document.parent;
  if (owner?.frameId && owner.contentDocument === document) {
    return owner.frameId;
  }
  for (const child of document.children) {
    if (child.nodeType === 1 && child.frameId) return child.frameId;
  }
  return undefined;
}

export function indexCapture(
  sessionId: string,
  tree: DecodedDomTree,
  snapshot: DecodedDOMSnapshot,
  layoutViewport: { width: number; height: number } | undefined,
  layoutZoom = 1,
): SessionCapture {
  const snapshotFrameByRoot = new Map<number, string>();
  for (const document of snapshot.documents) {
    if (document.rootBackendNodeId !== undefined && document.frameId) {
      snapshotFrameByRoot.set(document.rootBackendNodeId, document.frameId);
    }
  }
  const documents = new Map<string, DomTreeNode>();
  const owners = new Map<string, DomTreeNode>();
  const documentFrameIds = new Map<DomTreeNode, string>();
  const pending: DomTreeNode[] = [tree.root];
  while (pending.length > 0) {
    const node = pending.pop();
    if (!node) break;
    if (node.nodeType === 9) {
      const frameId = documentFrameId(node, snapshotFrameByRoot);
      if (frameId !== undefined) {
        documentFrameIds.set(node, frameId);
        if (!documents.has(frameId)) documents.set(frameId, node);
      }
    } else if (
      node.nodeType === 1 &&
      node.frameId !== undefined &&
      !isDocumentElement(node) &&
      !owners.has(node.frameId)
    ) {
      owners.set(node.frameId, node);
    }
    if (node.contentDocument) pending.push(node.contentDocument);
    for (const child of node.shadowRoots) pending.push(child);
    for (const child of node.children) pending.push(child);
  }
  return {
    sessionId,
    tree,
    snapshot,
    ...(layoutViewport === undefined ? {} : { layoutViewport }),
    layoutZoom,
    documents,
    owners,
    documentFrameIds,
  };
}

/**
 * Captures one session: the pierced document (structure), the DOM snapshot
 * (layout, styles and live values by backend node ID) and layout metrics.
 * One 10 s attempt and one 2 s retry; a failed session is omitted. Snapshot
 * geometry is normalized to CSS pixels with the session's layout zoom, else
 * `fallbackLayoutZoom` (the root session's) when its metrics are missing.
 */
export async function captureSession(
  deps: PageModelDeps,
  sessionId: string,
  expectedFrameId: string,
  fallbackLayoutZoom = 1,
): Promise<SessionCapture | undefined> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    ensureNotAborted(deps.signal);
    const timeoutMs =
      attempt === 0 ? REQUEST_TIMEOUT_MS : REQUEST_RETRY_TIMEOUT_MS;
    const deadline = deps.now() + timeoutMs;
    try {
      const [documentResponse, snapshotResponse, metricsResponse] =
        await Promise.all([
          requestPiercedDocument((method, params) =>
            sendOnce(deps, method, params, sessionId, timeoutMs, deadline),
          ),
          sendOnce(
            deps,
            'DOMSnapshot.captureSnapshot',
            {
              computedStyles: PAGE_MODEL_COMPUTED_STYLES,
              includeDOMRects: true,
              includePaintOrder: true,
            },
            sessionId,
            timeoutMs,
            deadline,
          ),
          sendOnce(
            deps,
            'Page.getLayoutMetrics',
            {},
            sessionId,
            timeoutMs,
            deadline,
          ).catch((error: unknown) => {
            if (isAbortError(error)) throw error;
            return undefined;
          }),
        ]);
      const layoutZoom =
        decodeLayoutZoom(metricsResponse) ?? fallbackLayoutZoom;
      const tree = decodeDomTree(documentResponse);
      const snapshot = decodeDOMSnapshot(
        snapshotResponse,
        PAGE_MODEL_COMPUTED_STYLES,
        layoutZoom,
      );
      if (!tree || !snapshot) {
        throw new Error('Malformed frame snapshot.');
      }
      restoreWhitespaceText(tree, snapshot.whitespaceTexts);
      const capture = indexCapture(
        sessionId,
        tree,
        snapshot,
        decodeLayoutViewport(metricsResponse),
        layoutZoom,
      );
      if (!capture.documents.has(expectedFrameId)) {
        throw new Error('The frame document is missing from its session.');
      }
      return capture;
    } catch (error) {
      if (isAbortError(error)) throw error;
    }
  }
  return undefined;
}
