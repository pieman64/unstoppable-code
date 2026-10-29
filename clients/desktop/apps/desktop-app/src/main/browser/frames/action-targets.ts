import { randomUUID } from 'node:crypto';
import {
  decodeBoxModel,
  decodeFrameOwnerBackendNodeId,
  isCDPRecord,
  readCDPArray,
  readCDPInteger,
  readCDPString,
} from './cdp-decode';
import type { ExecutionContexts } from './execution-contexts';
import { frameMappingOf } from './frame-geometry';
import type {
  FrameRegistry,
  NodeIdentity,
  RegisteredFrame,
} from './frame-registry';
import {
  HOST_WORLD_NAME,
  nodeAtViewportPoint,
  releaseObjectGroup,
  remoteObjectId,
  remoteValue,
  resolveNodeObject,
  type HostSend,
} from './host-cdp';
import {
  LocatorRequestError,
  matchLocator,
  resolveFrameScope,
} from './locator-requests';
import { accessibleName, roleFor } from './model-semantics';
import type { BrowserPageModel, PageModelNode } from './model-types';

/** What an action targets (phase 03's target fields). */
export type ActionTargetRequest =
  | { kind: 'ref'; ref: string }
  | { kind: 'locator'; locator: string; frame?: string }
  | { kind: 'point'; x: number; y: number }
  /** An untargeted `press`: the focused element. */
  | { kind: 'focused' }
  | { kind: 'page' }
  | { kind: 'text'; text: string; frame?: string };

/** A target resolved once, before actionability (D7). */
export interface ResolvedActionTarget {
  identity: NodeIdentity;
  frameRef: string;
  /** The model's ref for the node, when one can be minted. */
  ref?: string;
  /** Main-world remote object in `identity.sessionId`, kept in `objectGroup`. */
  objectId: string;
  objectGroup: string;
  /** In an out-of-process frame: input and geometry use its own session. */
  outOfProcess: boolean;
  /** Exact session point retained from a top-level coordinate resolution. */
  point?: { x: number; y: number };
  /**
   * The text node a text search matched, in this target's document. A
   * scroll goes to the text itself: its element can be far taller than the
   * viewport and already partly in view, where Chromium would not move.
   */
  scrollNode?: number;
}

export interface AmbiguousCandidate {
  frameRef: string;
  tagName: string;
  role?: string;
  name?: string;
}

export type ActionTargetResolution =
  | { status: 'found'; target: ResolvedActionTarget }
  | {
      status:
        | 'target_stale'
        | 'target_not_found'
        | 'frame_unavailable'
        | 'invalid_locator';
      message: string;
    }
  | {
      status: 'target_ambiguous';
      message: string;
      matchCount: number;
      /** Up to five matches, with the frames they are in. */
      candidates: AmbiguousCandidate[];
    };

/** One out-of-process boundary between a target and the top-level page. */
export interface FrameHop {
  /** The ancestor session the point is mapped into. */
  sessionId: string;
  /** The frame whose owner this is. */
  frameId: string;
  /** The owner element in `sessionId`: a hit test there must return it. */
  ownerBackendNodeId: number;
  /**
   * The point in `sessionId`'s viewport, unrounded. `DOM.getNodeForLocation`
   * accepts only integers: round it for the hit test.
   */
  point: { x: number; y: number };
}

export type AncestorMapping =
  | { status: 'mapped'; hops: FrameHop[] }
  | { status: 'frame_unavailable' | 'owner_transformed' };

export interface ActionTargetDeps {
  send: HostSend;
  registry: FrameRegistry;
  contexts: ExecutionContexts;
}

const MAX_CANDIDATES = 5;
/** Frame levels a coordinate or focus search descends at most. */
const MAX_FRAME_LEVELS = 6;

/**
 * Main world, like the action pipeline's own checks: the node is in its
 * frame's current document. A node of a replaced document is in a document
 * whose window no longer shows it.
 */
export const CONNECTED_FUNCTION =
  'function() { const owner = this.ownerDocument; return this.isConnected === true && !!owner && !!owner.defaultView && owner.defaultView.document === owner; }';

/**
 * Host world: the document's active element. Shadow roots (closed ones
 * too) and frames are followed through CDP by the caller.
 */
const ACTIVE_ELEMENT_EXPRESSION = 'document.activeElement';

/** Host world, called on a shadow root: its focused element, or null. */
const ROOT_ACTIVE_ELEMENT_FUNCTION =
  'function() { return this.activeElement; }';

/** Shadow roots a focus can be in at most, nested. */
const MAX_SHADOW_LEVELS = 32;

function failure(
  status: 'target_stale' | 'target_not_found' | 'frame_unavailable',
  message: string,
): ActionTargetResolution {
  return { status, message };
}

const STALE = failure(
  'target_stale',
  'The target reference is no longer available.',
);
const NOT_FOUND = failure('target_not_found', 'No element matched the target.');
const FRAME_UNAVAILABLE = failure(
  'frame_unavailable',
  'The frame is not available.',
);

/**
 * Retains the node as a main-world object in its own session, after
 * checking it is still in its frame's current document.
 */
async function retain(
  deps: ActionTargetDeps,
  identity: NodeIdentity,
): Promise<ActionTargetResolution> {
  const frame = deps.registry.getFrame(identity.frameId);
  if (
    !frame ||
    frame.sessionId !== identity.sessionId ||
    frame.loaderId !== identity.loaderId
  ) {
    return STALE;
  }
  const objectGroup = `canopy-action-target-${randomUUID()}`;
  try {
    const objectId = await resolveNodeObject(
      deps.send,
      identity.sessionId,
      identity.backendNodeId,
      objectGroup,
    );
    if (!objectId) throw new Error('Unresolved target.');
    const connected = remoteValue(
      await deps.send(
        'Runtime.callFunctionOn',
        {
          objectId,
          functionDeclaration: CONNECTED_FUNCTION,
          returnByValue: true,
        },
        identity.sessionId,
      ),
    );
    if (connected !== true) throw new Error('Detached target.');
    let ref: string | undefined;
    try {
      ref = deps.registry.mintRef(identity);
    } catch {
      ref = undefined;
    }
    return {
      status: 'found',
      target: {
        identity: { ...identity },
        frameRef: frame.frameRef,
        ...(ref === undefined ? {} : { ref }),
        objectId,
        objectGroup,
        outOfProcess: identity.sessionId !== '',
      },
    };
  } catch {
    releaseObjectGroup(deps.send, objectGroup, [identity.sessionId]);
    return STALE;
  }
}

/** A ref minted by `input_snapshot` or `inspect`: stale once its node is gone. */
export function resolveRefTarget(
  deps: ActionTargetDeps,
  ref: string,
): Promise<ActionTargetResolution> {
  const identity = deps.registry.resolveRef(ref.trim());
  return identity ? retain(deps, identity) : Promise.resolve(STALE);
}

/**
 * A locator over the model, narrowed by an optional `frame`. More than one
 * match, in one frame or several, is ambiguous.
 */
export async function resolveLocatorTarget(
  deps: ActionTargetDeps,
  model: BrowserPageModel,
  locator: string,
  frame?: string,
): Promise<ActionTargetResolution> {
  const frames =
    frame === undefined
      ? model.frames
      : await resolveFrameScope(model, deps, frame);
  if (!frames) return FRAME_UNAVAILABLE;
  let matches: NodeIdentity[];
  try {
    matches = await matchLocator(model, deps, locator, frames, 'target');
  } catch (error) {
    if (error instanceof LocatorRequestError) {
      return { status: 'invalid_locator', message: error.message };
    }
    throw error;
  }
  const [first] = matches;
  if (!first) return NOT_FOUND;
  if (matches.length === 1) return retain(deps, first);
  const candidates: AmbiguousCandidate[] = [];
  for (const identity of matches.slice(0, MAX_CANDIDATES)) {
    const node = model.nodes.find(
      (candidate) =>
        candidate.identity.sessionId === identity.sessionId &&
        candidate.identity.backendNodeId === identity.backendNodeId,
    );
    if (!node) continue;
    const name = node.insideSecretSelect ? '' : accessibleName(model, node);
    const role = roleFor(node);
    candidates.push({
      frameRef: node.frameRef,
      tagName: node.tagName.toLowerCase(),
      ...(role === undefined ? {} : { role }),
      ...(name ? { name } : {}),
    });
  }
  const frameRefs = Array.from(
    new Set(candidates.map((candidate) => candidate.frameRef)),
  );
  return {
    status: 'target_ambiguous',
    message: `The locator matched ${matches.length} elements${frameRefs.length > 1 ? ` in frames ${frameRefs.join(', ')}` : ''}.`,
    matchCount: matches.length,
    candidates,
  };
}

interface DescribedNode {
  backendNodeId: number;
  nodeType: number;
  /** On a frame owner, its child frame; on an `<html>`, its own frame. */
  childFrameId?: string;
  /** Open or closed (not user-agent) shadow root, with `pierce`. */
  shadowRootBackendNodeId?: number;
  /** Generated content (::before, ::after, ::marker), not a page element. */
  pseudo?: true;
}

function describedNode(response: unknown): DescribedNode | undefined {
  if (!isCDPRecord(response) || !isCDPRecord(response.node)) return undefined;
  const node = response.node;
  const backendNodeId = readCDPInteger(node.backendNodeId);
  const nodeType = readCDPInteger(node.nodeType);
  if (backendNodeId === undefined || nodeType === undefined) return undefined;
  const childFrameId = readCDPString(node.frameId);
  let shadowRootBackendNodeId: number | undefined;
  for (const root of readCDPArray(node.shadowRoots) ?? []) {
    if (!isCDPRecord(root)) continue;
    if (root.shadowRootType !== 'open' && root.shadowRootType !== 'closed')
      continue;
    shadowRootBackendNodeId = readCDPInteger(root.backendNodeId);
    break;
  }
  return {
    backendNodeId,
    nodeType,
    ...(childFrameId === undefined ? {} : { childFrameId }),
    ...(shadowRootBackendNodeId === undefined
      ? {}
      : { shadowRootBackendNodeId }),
    ...(readCDPString(node.pseudoType) === undefined ? {} : { pseudo: true }),
  };
}

/**
 * The hit test reports a ::before or ::after box as its own node, which page
 * script cannot see: the action belongs to the element that generates it.
 */
async function generatedContentOwner(
  deps: ActionTargetDeps,
  sessionId: string,
  backendNodeId: number,
): Promise<DescribedNode | undefined> {
  const group = `canopy-point-owner-${randomUUID()}`;
  try {
    let current = backendNodeId;
    // A ::marker can sit inside a ::before; nothing nests deeper than that.
    for (let level = 0; level < 3; level += 1) {
      const objectId = await resolveNodeObject(
        deps.send,
        sessionId,
        current,
        group,
      );
      if (!objectId) return undefined;
      const parent = remoteObjectId(
        await deps.send(
          'Runtime.callFunctionOn',
          {
            objectId,
            functionDeclaration: 'function() { return this.parentElement; }',
            objectGroup: group,
          },
          sessionId,
        ),
      );
      if (!parent) return undefined;
      const node = describedNode(
        await deps.send('DOM.describeNode', { objectId: parent }, sessionId),
      );
      if (!node?.pseudo) return node;
      current = node.backendNodeId;
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    releaseObjectGroup(deps.send, group, [sessionId]);
  }
}

/**
 * Whether the node shows a child document. Real input at a point over it
 * goes to that document, which in another process is not this session's.
 * Chromium sets `frameId` on a frame owner and on every `<html>`, so a
 * document's own root element carries `ownFrameId` and is not an owner.
 * A node that cannot be read counts, so nothing is aimed at it.
 */
export async function showsChildDocument(
  deps: ActionTargetDeps,
  sessionId: string,
  backendNodeId: number,
  ownFrameId: string,
): Promise<boolean> {
  const node = describedNode(
    await deps
      .send('DOM.describeNode', { backendNodeId }, sessionId)
      .catch(() => undefined),
  );
  return (
    node === undefined ||
    (node.childFrameId !== undefined && node.childFrameId !== ownFrameId)
  );
}

/**
 * Whether the element hosts a shadow root, open or closed. Page script
 * cannot see a closed one, or where it slots the host's children. An
 * element that cannot be read counts.
 */
export async function hostsShadowRoot(
  deps: ActionTargetDeps,
  sessionId: string,
  objectId: string,
): Promise<boolean> {
  const node = describedNode(
    await deps
      .send('DOM.describeNode', { objectId }, sessionId)
      .catch(() => undefined),
  );
  return node === undefined || node.shadowRootBackendNodeId !== undefined;
}

/** The registered child frame an owner shows, if it is another session's. */
function outOfProcessChild(
  deps: ActionTargetDeps,
  node: DescribedNode,
  sessionId: string,
): RegisteredFrame | undefined {
  if (node.childFrameId === undefined) return undefined;
  const child = deps.registry.getFrame(node.childFrameId);
  return child && child.sessionId !== sessionId ? child : undefined;
}

/**
 * Coordinates in the top-level viewport: the hit test on the root session,
 * which reaches into same-process frames and shadow roots;
 * an out-of-process frame's owner hands the point, in its content box's
 * coordinates, to the child session.
 */
export async function resolvePointTarget(
  deps: ActionTargetDeps,
  x: number,
  y: number,
): Promise<ActionTargetResolution> {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return NOT_FOUND;
  let sessionId = '';
  let point = { x, y };
  for (let level = 0; level < MAX_FRAME_LEVELS; level += 1) {
    const hit = await nodeAtViewportPoint(deps.send, sessionId, point);
    if (!hit?.frameId) return NOT_FOUND;
    const { frameId } = hit;
    const hitNode = describedNode(
      await deps
        .send(
          'DOM.describeNode',
          { backendNodeId: hit.backendNodeId },
          sessionId,
        )
        .catch(() => undefined),
    );
    const node = hitNode?.pseudo
      ? await generatedContentOwner(deps, sessionId, hitNode.backendNodeId)
      : hitNode;
    if (!node || node.nodeType !== 1) return NOT_FOUND;
    const { backendNodeId } = node;
    const child = outOfProcessChild(deps, node, sessionId);
    if (child) {
      const box = decodeBoxModel(
        await deps
          .send('DOM.getBoxModel', { backendNodeId }, sessionId)
          .catch(() => undefined),
      );
      const mapping = box ? frameMappingOf(box) : undefined;
      if (!mapping || mapping === 'transformed') return FRAME_UNAVAILABLE;
      const local = {
        x: (point.x - mapping.originX) / mapping.scaleX,
        y: (point.y - mapping.originY) / mapping.scaleY,
      };
      const inside =
        local.x >= 0 &&
        local.y >= 0 &&
        local.x * mapping.scaleX < mapping.width &&
        local.y * mapping.scaleY < mapping.height;
      if (inside) {
        sessionId = child.sessionId;
        point = local;
        continue;
      }
      // On the owner's border or padding: the owner itself.
    }
    const frame = deps.registry.getFrame(frameId);
    if (!frame || frame.sessionId !== sessionId || !frame.loaderId) {
      return FRAME_UNAVAILABLE;
    }
    const result = await retain(deps, {
      sessionId,
      frameId,
      loaderId: frame.loaderId,
      backendNodeId: node.backendNodeId,
    });
    if (result.status === 'found') result.target.point = { ...point };
    return result;
  }
  return FRAME_UNAVAILABLE;
}

/**
 * The host world of a frame, created on demand; `fresh` creates one even
 * when a context of that name is known (it may belong to a replaced
 * document whose destruction has not been reported yet).
 */
export async function hostWorldContext(
  deps: ActionTargetDeps,
  frameId: string,
  sessionId: string,
  fresh = false,
): Promise<number | undefined> {
  const existing = fresh
    ? undefined
    : deps.contexts.named(frameId, sessionId, HOST_WORLD_NAME)[0];
  if (existing !== undefined) return existing;
  const created = await deps
    .send(
      'Page.createIsolatedWorld',
      { frameId, worldName: HOST_WORLD_NAME },
      sessionId,
    )
    .catch(() => undefined);
  return isCDPRecord(created)
    ? readCDPInteger(created.executionContextId)
    : undefined;
}

/**
 * Follows a document's active element into the shadow roots it hosts,
 * closed ones too, with CDP's access rather than page script: describe the
 * element with `pierce`, resolve its root by backend id in the host world,
 * and read the root's `activeElement`. A host whose root has no focused
 * element is itself the focus. Undefined when a step cannot be proved, so
 * a host is never reported for focus inside it.
 */
async function focusInShadowRoots(
  deps: ActionTargetDeps,
  sessionId: string,
  contextId: number,
  objectId: string,
  group: string,
): Promise<DescribedNode | undefined> {
  let current = objectId;
  for (let level = 0; level < MAX_SHADOW_LEVELS; level += 1) {
    const node = describedNode(
      await deps
        .send(
          'DOM.describeNode',
          { objectId: current, depth: 1, pierce: true },
          sessionId,
        )
        .catch(() => undefined),
    );
    if (!node || node.nodeType !== 1) return undefined;
    if (node.shadowRootBackendNodeId === undefined) return node;
    const root = await resolveNodeObject(
      deps.send,
      sessionId,
      node.shadowRootBackendNodeId,
      group,
      contextId,
    ).catch(() => undefined);
    if (!root) return undefined;
    const response = await deps
      .send(
        'Runtime.callFunctionOn',
        {
          objectId: root,
          functionDeclaration: ROOT_ACTIVE_ELEMENT_FUNCTION,
          objectGroup: group,
        },
        sessionId,
      )
      .catch(() => undefined);
    if (
      !isCDPRecord(response) ||
      response.exceptionDetails !== undefined ||
      !isCDPRecord(response.result)
    )
      return undefined;
    if (response.result.subtype === 'null') return node;
    const inner = remoteObjectId(response);
    if (!inner) return undefined;
    current = inner;
  }
  return undefined;
}

/**
 * The element that receives an untargeted key press: each frame's active
 * element, read in the host world, followed through open and closed shadow
 * roots and into the frame an active iframe shows.
 */
export async function resolveFocusedTarget(
  deps: ActionTargetDeps,
): Promise<ActionTargetResolution> {
  let frame = deps.registry
    .frames()
    .find((candidate) => candidate.sessionId === '' && !candidate.parentId);
  const group = `canopy-focus-${randomUUID()}`;
  const sessions = new Set<string>();
  try {
    for (let level = 0; frame && level < MAX_FRAME_LEVELS; level += 1) {
      sessions.add(frame.sessionId);
      const contextId = await hostWorldContext(
        deps,
        frame.frameId,
        frame.sessionId,
      );
      if (contextId === undefined) return NOT_FOUND;
      const objectId = remoteObjectId(
        await deps
          .send(
            'Runtime.evaluate',
            {
              expression: ACTIVE_ELEMENT_EXPRESSION,
              contextId,
              objectGroup: group,
            },
            frame.sessionId,
          )
          .catch(() => undefined),
      );
      if (!objectId) return NOT_FOUND;
      const node = await focusInShadowRoots(
        deps,
        frame.sessionId,
        contextId,
        objectId,
        group,
      );
      if (!node) return NOT_FOUND;
      // A focused root element carries its own frame's id, not a child's.
      const child =
        node.childFrameId === undefined || node.childFrameId === frame.frameId
          ? undefined
          : deps.registry.getFrame(node.childFrameId);
      if (child?.loaderId) {
        frame = child;
        continue;
      }
      if (!frame.loaderId) return FRAME_UNAVAILABLE;
      return await retain(deps, {
        sessionId: frame.sessionId,
        frameId: frame.frameId,
        loaderId: frame.loaderId,
        backendNodeId: node.backendNodeId,
      });
    }
    return NOT_FOUND;
  } finally {
    releaseObjectGroup(deps.send, group, sessions);
  }
}

/**
 * For hit tests across documents (D9): the point, given in the target's
 * session, mapped into each ancestor session above an out-of-process frame,
 * with the owner element a hit there must return. Owner geometry is read
 * fresh, by backend node id.
 */
export async function mapToAncestors(
  deps: ActionTargetDeps,
  identity: NodeIdentity,
  point: { x: number; y: number },
): Promise<AncestorMapping> {
  const hops: FrameHop[] = [];
  let frame = deps.registry.getFrame(identity.frameId);
  if (!frame || frame.sessionId !== identity.sessionId) {
    return { status: 'frame_unavailable' };
  }
  let current = { ...point };
  for (let level = 0; level <= MAX_FRAME_LEVELS; level += 1) {
    // The session's top frame: its parent lives in another session.
    while (frame.parentId !== undefined) {
      const parent = deps.registry.getFrame(frame.parentId);
      if (!parent) return { status: 'frame_unavailable' };
      if (parent.sessionId !== frame.sessionId) break;
      frame = parent;
    }
    if (frame.parentId === undefined) return { status: 'mapped', hops };
    const parent = deps.registry.getFrame(frame.parentId);
    if (!parent) return { status: 'frame_unavailable' };
    const ownerBackendNodeId = decodeFrameOwnerBackendNodeId(
      await deps
        .send('DOM.getFrameOwner', { frameId: frame.frameId }, parent.sessionId)
        .catch(() => undefined),
    );
    if (ownerBackendNodeId === undefined)
      return { status: 'frame_unavailable' };
    const box = decodeBoxModel(
      await deps
        .send(
          'DOM.getBoxModel',
          { backendNodeId: ownerBackendNodeId },
          parent.sessionId,
        )
        .catch(() => undefined),
    );
    const mapping = box ? frameMappingOf(box) : undefined;
    if (mapping === 'transformed') return { status: 'owner_transformed' };
    if (!mapping) return { status: 'frame_unavailable' };
    current = {
      x: mapping.originX + mapping.scaleX * current.x,
      y: mapping.originY + mapping.scaleY * current.y,
    };
    hops.push({
      sessionId: parent.sessionId,
      frameId: frame.frameId,
      ownerBackendNodeId,
      point: { ...current },
    });
    frame = parent;
  }
  return { status: 'frame_unavailable' };
}

/** Releases the target's retained object; best effort. */
export async function releaseActionTarget(
  deps: ActionTargetDeps,
  target: ResolvedActionTarget,
): Promise<void> {
  await deps
    .send(
      'Runtime.releaseObjectGroup',
      { objectGroup: target.objectGroup },
      target.identity.sessionId,
    )
    .catch(() => undefined);
}

/** How to-text compares text: whitespace collapsed, case ignored. */
export function normalizeTextQuery(query: string): string {
  return query.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * The best eligible full text node, never a text locator rerun: a node whose
 * whole text is the query, then one containing it in the same case, then one
 * containing it in any case; the first of the best rank in pierced model order.
 */
export async function resolveTextTarget(
  deps: ActionTargetDeps,
  model: BrowserPageModel,
  query: string,
  scope?: string,
): Promise<ActionTargetResolution> {
  const frames =
    scope === undefined
      ? model.frames
      : await resolveFrameScope(model, deps, scope);
  if (!frames) return FRAME_UNAVAILABLE;
  const allowed = new Set(frames.map((frame) => frame.frameId));
  const needle = normalizeTextQuery(query);
  const sameCase = query.replace(/\s+/g, ' ').trim();
  let best:
    | { node: PageModelNode; parent: PageModelNode; rank: number }
    | undefined;
  for (const node of model.nodes) {
    if (
      node.nodeType !== 3 ||
      node.secret ||
      node.insideSecretSelect ||
      node.fullText === undefined ||
      !allowed.has(node.identity.frameId)
    )
      continue;
    const text = node.fullText.replace(/\s+/g, ' ').trim();
    if (!text.toLowerCase().includes(needle)) continue;
    const rank =
      text.toLowerCase() === needle ? 0 : text.includes(sameCase) ? 1 : 2;
    if (best && best.rank <= rank) continue;
    let parent = model.nodes[node.parentIndex ?? -1];
    // Text directly in a shadow root is scrolled to by the root's host.
    while (parent?.nodeType === 11)
      parent = model.nodes[parent.parentIndex ?? -1];
    if (
      !parent ||
      parent.nodeType !== 1 ||
      parent.hidden ||
      parent.secret ||
      parent.insideSecretSelect
    )
      continue;
    best = { node, parent, rank };
    if (rank === 0) break;
  }
  if (!best) return NOT_FOUND;
  const held = await retain(deps, best.parent.identity);
  if (held.status === 'found')
    held.target.scrollNode = best.node.identity.backendNodeId;
  return held;
}

/** Top document's actual scrolling element, retained by identity. */
export async function resolvePageTarget(
  deps: ActionTargetDeps,
): Promise<ActionTargetResolution> {
  const root = deps.registry
    .frames()
    .find((frame) => frame.sessionId === '' && frame.parentId === undefined);
  if (!root?.loaderId) return FRAME_UNAVAILABLE;
  const loader = root.loaderId;
  const group = `canopy-page-target-${randomUUID()}`;
  try {
    const contextId = await hostWorldContext(deps, root.frameId, '');
    if (contextId === undefined) return FRAME_UNAVAILABLE;
    const objectId = remoteObjectId(
      await deps.send(
        'Runtime.evaluate',
        {
          expression: 'document.scrollingElement || document.documentElement',
          contextId,
          objectGroup: group,
        },
        '',
      ),
    );
    if (!objectId) return NOT_FOUND;
    const described = describedNode(
      await deps.send('DOM.describeNode', { objectId }, ''),
    );
    if (!described || deps.registry.getFrame(root.frameId)?.loaderId !== loader)
      return FRAME_UNAVAILABLE;
    return await retain(deps, {
      sessionId: '',
      frameId: root.frameId,
      loaderId: loader,
      backendNodeId: described.backendNodeId,
    });
  } finally {
    releaseObjectGroup(deps.send, group, ['']);
  }
}
