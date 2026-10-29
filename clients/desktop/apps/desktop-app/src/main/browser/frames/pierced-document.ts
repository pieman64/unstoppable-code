import { isCDPRecord } from './cdp-decode';

/**
 * DOM levels requested in one nested `DOM.getDocument`. Chromium's CBOR
 * encoder fails on responses nested about 200 deep (about 100 DOM levels in
 * Electron 42), and the failure detaches the debugger, so deeper documents
 * are read flat instead.
 */
export const PIERCED_DOCUMENT_DEPTH = 48;

type Send = (
  method: string,
  params: Record<string, unknown>,
) => Promise<unknown>;

/**
 * The whole pierced document in `DOM.getDocument({ depth: -1, pierce: true })`
 * form, without ever requesting an unbounded nested response.
 */
export async function requestPiercedDocument(send: Send): Promise<unknown> {
  const response = await send('DOM.getDocument', {
    depth: PIERCED_DOCUMENT_DEPTH,
    pierce: true,
  });
  if (!isCDPRecord(response) || !hasTruncatedNode(response.root)) {
    return response;
  }
  const flat = await send('DOM.getFlattenedDocument', {
    depth: -1,
    pierce: true,
  });
  const nested = nestFlattenedDocument(flat);
  if (!nested) throw new Error('Malformed flattened document.');
  return nested;
}

/** A node at the depth limit has children but no `children` list. */
function hasTruncatedNode(root: unknown): boolean {
  const pending: unknown[] = [root];
  while (pending.length > 0) {
    const node = pending.pop();
    if (!isCDPRecord(node)) continue;
    if (
      typeof node.childNodeCount === 'number' &&
      node.childNodeCount > 0 &&
      !Array.isArray(node.children)
    ) {
      return true;
    }
    if (Array.isArray(node.children))
      pending.push(...Array.from<unknown>(node.children));
    if (Array.isArray(node.shadowRoots))
      pending.push(...Array.from<unknown>(node.shadowRoots));
    if (node.contentDocument !== undefined) pending.push(node.contentDocument);
  }
  return false;
}

/**
 * Rebuilds the nested tree from `DOM.getFlattenedDocument`. Its list is in
 * document order and each entry names its parent; shadow roots and frame
 * documents stay nested in their host, with their own children listed flat.
 */
export function nestFlattenedDocument(
  value: unknown,
): { root: Record<string, unknown> } | undefined {
  if (!isCDPRecord(value) || !Array.isArray(value.nodes)) return undefined;
  const nodes: Record<string, unknown>[] = [];
  for (const node of value.nodes) {
    if (!isCDPRecord(node)) return undefined;
    nodes.push(node);
  }
  const byNodeId = new Map<unknown, Record<string, unknown>>();
  const register = (node: Record<string, unknown>): void => {
    node.children = [];
    byNodeId.set(node.nodeId, node);
    if (Array.isArray(node.shadowRoots)) {
      for (const shadowRoot of node.shadowRoots) {
        if (isCDPRecord(shadowRoot)) register(shadowRoot);
      }
    }
    if (isCDPRecord(node.contentDocument)) register(node.contentDocument);
  };
  for (const node of nodes) register(node);
  let root: Record<string, unknown> | undefined;
  for (const node of nodes) {
    if (node.parentId === undefined) {
      if (root) return undefined;
      root = node;
      continue;
    }
    const parent = byNodeId.get(node.parentId);
    if (!parent || !Array.isArray(parent.children)) return undefined;
    parent.children.push(node);
  }
  return root ? { root } : undefined;
}
