import { mapToAncestors, type ActionTargetDeps } from './action-targets';
import {
  decodeBoxModel,
  decodeFrameOwnerBackendNodeId,
  isCDPRecord,
  readCDPArray,
  readCDPString,
} from './cdp-decode';
import type { DocumentMapping } from '../actions/actionability';
import { frameMappingOf } from './frame-geometry';
import type { NodeIdentity } from './frame-registry';
import { nodeAtViewportPoint } from './host-cdp';

const IDENTITY: DocumentMapping = {
  originX: 0,
  originY: 0,
  scaleX: 1,
  scaleY: 1,
};

/**
 * How a target's document maps to its session's coordinates (one rule for
 * every frame): the identity for a session's top document (the main frame,
 * an out-of-process frame), and for a same-process child frame its owner's
 * content box, read fresh by backend node id (CDP geometry of a shared
 * session already includes every ancestor frame's offset and scale).
 * Undefined when the frame is gone, its owner cannot be read, or the owner
 * is rotated, skewed or mirrored.
 */
export async function documentMapping(
  deps: ActionTargetDeps,
  identity: NodeIdentity,
): Promise<DocumentMapping | undefined> {
  const frame = deps.registry.getFrame(identity.frameId);
  if (!frame || frame.sessionId !== identity.sessionId) return undefined;
  if (frame.parentId === undefined) return IDENTITY;
  const parent = deps.registry.getFrame(frame.parentId);
  if (!parent) return undefined;
  if (parent.sessionId !== frame.sessionId) return IDENTITY;
  const owner = decodeFrameOwnerBackendNodeId(
    await deps
      .send('DOM.getFrameOwner', { frameId: frame.frameId }, frame.sessionId)
      .catch(() => undefined),
  );
  if (owner === undefined) return undefined;
  const box = decodeBoxModel(
    await deps
      .send('DOM.getBoxModel', { backendNodeId: owner }, frame.sessionId)
      .catch(() => undefined),
  );
  const mapping = box ? frameMappingOf(box) : undefined;
  if (!mapping || mapping === 'transformed') return undefined;
  return {
    originX: mapping.originX,
    originY: mapping.originY,
    scaleX: mapping.scaleX,
    scaleY: mapping.scaleY,
  };
}

/** `tag.class1.class2` of a node in a session, as covers are named. */
async function coverName(
  deps: ActionTargetDeps,
  sessionId: string,
  backendNodeId: number,
): Promise<string> {
  const response = await deps
    .send('DOM.describeNode', { backendNodeId }, sessionId)
    .catch(() => undefined);
  const node =
    isCDPRecord(response) && isCDPRecord(response.node)
      ? response.node
      : undefined;
  const tag = (readCDPString(node?.nodeName) ?? 'element').toLowerCase();
  const attributes = readCDPArray(node?.attributes) ?? [];
  const index = attributes.indexOf('class');
  const classes =
    index >= 0 && index % 2 === 0
      ? (readCDPString(attributes[index + 1]) ?? '')
          .trim()
          .split(/\s+/)
          .filter(Boolean)
          .slice(0, 2)
      : [];
  return [tag, ...classes].join('.').slice(0, 80);
}

/**
 * The hit test in every document above the target's own (D9), at the
 * point the input will use (session coordinates). Within the target's
 * session the deepest hit must be in the target's document (same-process
 * frames share the session; an overlay in a parent document is hit
 * instead). Above an out-of-process boundary, the hit at the mapped point
 * in each ancestor session must be that frame's owner. The in-document
 * check stays the caller's.
 */
export async function outerHitTest(
  deps: ActionTargetDeps,
  identity: NodeIdentity,
  point: { x: number; y: number },
): Promise<{ receivesEvents: boolean; cover?: string }> {
  const frame = deps.registry.getFrame(identity.frameId);
  if (!frame || frame.sessionId !== identity.sessionId)
    return { receivesEvents: false, cover: 'a frame that is gone' };
  if (frame.parentId === undefined) return { receivesEvents: true };
  const parent = deps.registry.getFrame(frame.parentId);
  if (parent?.sessionId === frame.sessionId) {
    const hit = await nodeAtViewportPoint(deps.send, identity.sessionId, point);
    if (!hit) return { receivesEvents: false, cover: 'nothing at the point' };
    if (hit.frameId !== identity.frameId)
      return {
        receivesEvents: false,
        cover: await coverName(deps, identity.sessionId, hit.backendNodeId),
      };
  }
  const mapping = await mapToAncestors(deps, identity, point);
  if (mapping.status !== 'mapped')
    return {
      receivesEvents: false,
      cover:
        mapping.status === 'owner_transformed'
          ? 'a transformed frame owner'
          : 'a frame owner that could not be found',
    };
  for (const hop of mapping.hops) {
    const hit = await nodeAtViewportPoint(deps.send, hop.sessionId, hop.point);
    if (!hit) return { receivesEvents: false, cover: 'nothing at the point' };
    if (hit.backendNodeId !== hop.ownerBackendNodeId)
      return {
        receivesEvents: false,
        cover: await coverName(deps, hop.sessionId, hit.backendNodeId),
      };
  }
  return { receivesEvents: true };
}
