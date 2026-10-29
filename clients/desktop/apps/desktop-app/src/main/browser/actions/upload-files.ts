import {
  isCDPRecord,
  readCDPArray,
  readCDPInteger,
  readCDPString,
} from '../frames/cdp-decode';
import { randomUUID } from 'node:crypto';
import {
  releaseObjectGroup,
  remoteObjectId,
  remoteValue,
  resolveNodeObject,
  type HostSend,
} from '../frames/host-cdp';
import {
  CONNECTED_FUNCTION,
  type ResolvedActionTarget,
} from '../frames/action-targets';

/**
 * The file input for an upload's target: the target itself, an input inside
 * it (a drop zone usually hides one), one beside it or around it within three
 * levels, then the file input in its document nearest the viewport's centre.
 * The browser checks the found node's type again before anything is attached.
 */
export const NEAREST_FILE_INPUT_FUNCTION = `function () {
  const isFile = (node) => !!node && node.nodeType === 1 &&
    node.localName === 'input' &&
    String(node.getAttribute('type') || '').toLowerCase() === 'file';
  const below = (root, depth) => {
    let level = [root];
    for (let step = 0; step < depth && level.length; step++) {
      const next = [];
      for (const node of level)
        for (const child of Array.from(node.children || [])) {
          if (isFile(child)) return child;
          next.push(child);
        }
      level = next;
    }
    return null;
  };
  if (isFile(this)) return this;
  const within = below(this, 3);
  if (within) return within;
  const parent = this.parentElement;
  for (const sibling of Array.from(parent ? parent.children : [])) {
    if (sibling === this) continue;
    if (isFile(sibling)) return sibling;
    const near = below(sibling, 3);
    if (near) return near;
  }
  let ancestor = parent;
  for (let step = 0; step < 3 && ancestor; step++) {
    const near = below(ancestor, 3);
    if (near) return near;
    ancestor = ancestor.parentElement;
  }
  const doc = this.ownerDocument;
  const view = doc.defaultView;
  const x = (view ? view.innerWidth : 0) / 2;
  const y = (view ? view.innerHeight : 0) / 2;
  let best = null;
  let bestDistance = Infinity;
  for (const input of Array.from(doc.querySelectorAll('input'))) {
    if (!isFile(input)) continue;
    const rect = input.getBoundingClientRect();
    const distance = Math.hypot(rect.left + rect.width / 2 - x, rect.top + rect.height / 2 - y);
    if (distance < bestDistance) {
      best = input;
      bestDistance = distance;
    }
  }
  return best;
}`;

export interface FileInputInfo {
  backendNodeId: number;
  multiple: boolean;
  accept?: string;
  /** The input picks a folder (`webkitdirectory`). */
  directory?: boolean;
}

/** The target's file input, read from the browser's own view of the node. */
export async function describeFileInput(
  send: HostSend,
  target: Pick<ResolvedActionTarget, 'objectId' | 'objectGroup' | 'identity'>,
): Promise<FileInputInfo | undefined> {
  const sessionId = target.identity.sessionId;
  const found = remoteObjectId(
    await send(
      'Runtime.callFunctionOn',
      {
        objectId: target.objectId,
        functionDeclaration: NEAREST_FILE_INPUT_FUNCTION,
        returnByValue: false,
        objectGroup: target.objectGroup,
      },
      sessionId,
    ),
  );
  if (!found) return undefined;
  return fileInputInfo(
    await send('DOM.describeNode', { objectId: found }, sessionId),
  );
}

/** Whether a file input is still in its frame's current document; false when it can't be read. */
export async function fileInputConnected(
  send: HostSend,
  sessionId: string,
  backendNodeId: number,
): Promise<boolean> {
  const objectGroup = `canopy-file-input-${randomUUID()}`;
  try {
    const objectId = await resolveNodeObject(
      send,
      sessionId,
      backendNodeId,
      objectGroup,
    );
    if (!objectId) return false;
    const connected = await send(
      'Runtime.callFunctionOn',
      {
        objectId,
        functionDeclaration: CONNECTED_FUNCTION,
        returnByValue: true,
      },
      sessionId,
    );
    return remoteValue(connected) === true;
  } catch {
    return false;
  } finally {
    releaseObjectGroup(send, objectGroup, [sessionId]);
  }
}

/** A file input by its node, as a chooser names it; undefined once it is gone. */
export async function describeFileInputNode(
  send: HostSend,
  sessionId: string,
  backendNodeId: number,
): Promise<FileInputInfo | undefined> {
  try {
    return fileInputInfo(
      await send('DOM.describeNode', { backendNodeId }, sessionId || undefined),
    );
  } catch {
    return undefined;
  }
}

function fileInputInfo(described: unknown): FileInputInfo | undefined {
  const node = isCDPRecord(described) ? described.node : undefined;
  if (!isCDPRecord(node)) return undefined;
  const backendNodeId = readCDPInteger(node.backendNodeId);
  const flat = readCDPArray(node.attributes) ?? [];
  const attributes = new Map<string, string>();
  for (let index = 0; index + 1 < flat.length; index += 2) {
    const name = readCDPString(flat[index]);
    const value = readCDPString(flat[index + 1]);
    if (name !== undefined && value !== undefined)
      attributes.set(name.toLowerCase(), value);
  }
  if (
    backendNodeId === undefined ||
    readCDPString(node.nodeName)?.toUpperCase() !== 'INPUT' ||
    attributes.get('type')?.toLowerCase() !== 'file'
  )
    return undefined;
  const accept = attributes.get('accept');
  return {
    backendNodeId,
    multiple: attributes.has('multiple'),
    ...(accept ? { accept } : {}),
    ...(attributes.has('webkitdirectory') ? { directory: true } : {}),
  };
}

interface FrameRecord {
  id: string;
  securityOrigin: string;
  loaderId: string;
}

function findFrame(tree: unknown, frameId: string): FrameRecord | undefined {
  if (!isCDPRecord(tree)) return undefined;
  const frame = tree.frame;
  if (isCDPRecord(frame) && readCDPString(frame.id) === frameId) {
    const securityOrigin = readCDPString(frame.securityOrigin);
    const loaderId = readCDPString(frame.loaderId);
    return securityOrigin !== undefined && loaderId !== undefined
      ? { id: frameId, securityOrigin, loaderId }
      : undefined;
  }
  for (const child of readCDPArray(tree.childFrames) ?? []) {
    const found = findFrame(child, frameId);
    if (found) return found;
  }
  return undefined;
}

function rootFrame(tree: unknown): FrameRecord | undefined {
  const frame =
    isCDPRecord(tree) && isCDPRecord(tree.frameTree)
      ? tree.frameTree.frame
      : undefined;
  const id = isCDPRecord(frame) ? readCDPString(frame.id) : undefined;
  return id && isCDPRecord(tree) ? findFrame(tree.frameTree, id) : undefined;
}

/**
 * The browser's security origin for a frame and for the page, with the
 * frame's current document. Undefined when the frame is gone.
 */
export async function frameOrigins(
  send: HostSend,
  sessionId: string,
  frameId: string,
): Promise<
  { frameOrigin: string; topOrigin: string; loaderId: string } | undefined
> {
  const local = await send('Page.getFrameTree', {}, sessionId || undefined);
  const frame = isCDPRecord(local)
    ? findFrame(local.frameTree, frameId)
    : undefined;
  if (!frame) return undefined;
  const top = sessionId
    ? rootFrame(await send('Page.getFrameTree', {}))
    : rootFrame(local);
  if (!top) return undefined;
  return {
    frameOrigin: frame.securityOrigin,
    topOrigin: top.securityOrigin,
    loaderId: frame.loaderId,
  };
}
