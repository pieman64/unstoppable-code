import type { BrowserInputSnapshotResponse } from '@canopy/desktop-shared/types/browser';
import {
  hostsShadowRoot,
  hostWorldContext,
  type ActionTargetDeps,
  type ResolvedActionTarget,
} from './action-targets';
import {
  decodeFrameOwnerBackendNodeId,
  isCDPRecord,
  readCDPFiniteNumber,
  readCDPInteger,
  readCDPString,
} from './cdp-decode';
import { remoteObjectId, remoteValue, resolveNodeObject } from './host-cdp';

export interface ScrollState {
  x: number;
  y: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
  scrollWidth: number;
  scrollHeight: number;
  scriptX: boolean;
  scriptY: boolean;
  point?: { x: number; y: number };
}
export interface ViewportTelemetry {
  viewport: NonNullable<BrowserInputSnapshotResponse['viewport']>;
  scroll: NonNullable<BrowserInputSnapshotResponse['scroll']>;
}

/**
 * Offsets counted from the top-left of the scroll range. A right-to-left or
 * reversed container starts at its far edge: Chromium reports 0 there and
 * negative offsets from it, so a chat log in `column-reverse` is at -400
 * when it is 400 px above its bottom. The sign decides; the styles only
 * settle which edge 0 is.
 */
const SCROLL_OFFSETS = `(el, style, maxX, maxY) => {
  const mode = style.writingMode || 'horizontal-tb';
  const flex = style.display === 'flex' || style.display === 'inline-flex';
  const flow = flex ? style.flexDirection || '' : '';
  const wrapped = flex && style.flexWrap === 'wrap-reverse';
  let farX = mode === 'vertical-rl' || mode === 'sideways-rl', farY = false;
  if (mode === 'horizontal-tb') {
    farX = (style.direction === 'rtl') !== (flow === 'row-reverse');
    if (wrapped && flow.indexOf('column') === 0) farX = !farX;
    farY = (flow === 'column-reverse') !== (wrapped && flow.indexOf('row') === 0);
  }
  const left = el.scrollLeft, top = el.scrollTop;
  const x = left < 0 || (left === 0 && farX) ? maxX + left : left;
  const y = top < 0 || (top === 0 && farY) ? maxY + top : top;
  return { x: Math.max(0, Math.min(maxX, x)), y: Math.max(0, Math.min(maxY, y)) };
}`;

const SCROLL_READ = `function() {
  const doc = this.ownerDocument, win = doc.defaultView;
  if (!this.isConnected || !win || win.document !== doc) return null;
  const page = this === (doc.scrollingElement || doc.documentElement);
  const style = win.getComputedStyle(this);
  const maxX = Math.max(0, this.scrollWidth - this.clientWidth), maxY = Math.max(0, this.scrollHeight - this.clientHeight);
  const at = (${SCROLL_OFFSETS})(this, style, maxX, maxY);
  const r = this.getBoundingClientRect();
  const left = page ? 0 : Math.max(0, r.left), right = page ? win.innerWidth : Math.min(win.innerWidth, r.right);
  const top = page ? 0 : Math.max(0, r.top), bottom = page ? win.innerHeight : Math.min(win.innerHeight, r.bottom);
  return { x: at.x, y: at.y, maxX, maxY, width: this.clientWidth, height: this.clientHeight,
    scrollWidth: this.scrollWidth, scrollHeight: this.scrollHeight,
    scriptX: page || (maxX > 0 && style.overflowX !== 'visible' && style.overflowX !== 'clip'),
    scriptY: page || (maxY > 0 && style.overflowY !== 'visible' && style.overflowY !== 'clip'),
    point: right > left && bottom > top ? { x: (left + right)/2, y: (top + bottom)/2 } : undefined };
}`;

/**
 * One step up the flat tree, which is the tree Chromium scrolls and routes
 * a wheel through: a slotted node's parent is its slot. A slot in a closed
 * root is not visible to script.
 */
const FLAT_PARENT = `const root = n.getRootNode(); n = n.assignedSlot || n.parentElement || (root && root.host);`;

/**
 * The first match of `text` inside a text node, as a Range, or null. `text`
 * is already normalized (whitespace collapsed, lower case); the loop maps
 * it back to offsets in the node's own text.
 */
const TEXT_MATCH_RANGE = `(node, text) => {
  const data = node.data;
  const raw = [];
  let flat = '', gap = true;
  for (let i = 0; i < data.length; i += 1) {
    if (/\\s/.test(data[i])) {
      if (!gap) { flat += ' '; raw.push(i); gap = true; }
      continue;
    }
    for (const unit of data[i].toLowerCase()) { flat += unit; raw.push(i); }
    gap = false;
  }
  const at = flat.indexOf(text);
  if (at < 0) return null;
  const range = node.ownerDocument.createRange();
  range.setStart(node, raw[at]);
  range.setEnd(node, raw[at + text.length - 1] + 1);
  return range;
}`;

/**
 * Where the matched words are inside their text node: their rectangle from
 * the corner of the node's bounds, as on screen. That is the `rect` that
 * `DOM.scrollIntoViewIfNeeded` takes, which Chromium then brings into view
 * through every scroller, slot, transform and frame around the node.
 * Chromium adds the rect to the node's layout box, in layout units (device
 * pixels times page zoom), so the CSS-pixel measure is scaled by
 * `devicePixelRatio`; unscaled, it lands short at a ratio of 2.
 */
const TEXT_MATCH_RECT = `function(text) {
  const range = (${TEXT_MATCH_RANGE})(this, text);
  if (!range) return null;
  const whole = this.ownerDocument.createRange();
  whole.selectNodeContents(this);
  const words = range.getBoundingClientRect(), node = whole.getBoundingClientRect();
  const z = this.ownerDocument.defaultView.devicePixelRatio || 1;
  return { x: (words.left - node.left) * z, y: (words.top - node.top) * z,
    width: (words.right - words.left) * z, height: (words.bottom - words.top) * z };
}`;

/**
 * For a recorded replay, which has only page script: centres the first
 * match of `text` inside a text node in every box around it that hides it,
 * in its own document. The live action asks Chromium instead (see
 * TEXT_MATCH_RECT) and calls this with `look` set, only to check the result.
 *
 * The walk follows the flat tree from the text node, whose parent there is
 * its slot. Distances are measured on screen, and `scrollBy` counts a box's
 * own pixels, so each is divided by the box's scale (`transform: scale(2)`
 * shows one scrolled pixel as two). Script cannot follow a slot in a
 * closed root, and a rotated or skewed box has no such scale.
 *
 * Returns null when the words are not in the node, and otherwise whether
 * they are in view: their middle inside the viewport and inside every box
 * that clips its content.
 */
export const CENTER_TEXT_MATCH = `(node, text, look) => {
  const range = (${TEXT_MATCH_RANGE})(node, text);
  if (!range) return null;
  const doc = node.ownerDocument, view = doc.defaultView;
  const page = doc.scrollingElement;
  const port = { top: 0, left: 0, bottom: view.innerHeight, right: view.innerWidth };
  const up = (box) => box.assignedSlot || box.parentElement || box.getRootNode().host;
  const first = up(node);
  for (let box = look ? null : first; box; box = up(box)) {
    const size = box === page ? null : box.getBoundingClientRect();
    const sx = size && box.offsetWidth > 0 && size.right > size.left
      ? (size.right - size.left) / box.offsetWidth : 1;
    const sy = size && box.offsetHeight > 0 && size.bottom > size.top
      ? (size.bottom - size.top) / box.offsetHeight : 1;
    // A second look corrects a rounded scale; a box that did not move is done.
    for (let pass = 0; pass < 3; pass += 1) {
      const frame = box === page ? port : box.getBoundingClientRect();
      const match = range.getBoundingClientRect();
      const top = match.top < frame.top || match.bottom > frame.bottom
        ? (match.top + match.bottom - frame.top - frame.bottom) / 2 : 0;
      const left = match.left < frame.left || match.right > frame.right
        ? (match.left + match.right - frame.left - frame.right) / 2 : 0;
      if (!top && !left) break;
      const x = box.scrollLeft, y = box.scrollTop;
      box.scrollBy({ left: left / sx, top: top / sy, behavior: 'instant' });
      if (box.scrollLeft === x && box.scrollTop === y) break;
    }
  }
  const match = range.getBoundingClientRect();
  const x = (match.left + match.right) / 2, y = (match.top + match.bottom) / 2;
  const holds = (frame) => x >= frame.left && x <= frame.right && y >= frame.top && y <= frame.bottom;
  if (!holds(port)) return false;
  for (let box = first; box; box = up(box)) {
    if (box === page) continue;
    const style = view.getComputedStyle(box);
    if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
    if (!holds(box.getBoundingClientRect())) return false;
  }
  return true;
}`;

/**
 * The wheel's owner, from the element under the point. Returns null when
 * it is not this element, and otherwise the ancestors that could host a
 * closed shadow root, which the caller has to rule out: content slotted
 * into one may sit inside a scroller this walk cannot see.
 */
const WHEEL_OWNER = `function(hit, axis) {
  const doc = this.ownerDocument, win = doc.defaultView;
  const page = doc.scrollingElement || doc.documentElement;
  const hosts = /^(article|aside|blockquote|body|div|footer|h[1-6]|header|main|nav|p|section|span)$/;
  const unseen = [];
  for (let n = hit; n && n.ownerDocument === doc; ) {
    if (n.nodeType === 1) {
      const style = win.getComputedStyle(n);
      const overflow = axis === 'x' ? style.overflowX : style.overflowY;
      const max = axis === 'x' ? n.scrollWidth - n.clientWidth : n.scrollHeight - n.clientHeight;
      if (max > 0 && (n === page || overflow === 'auto' || overflow === 'scroll'))
        return n === this ? unseen : null;
    }
    if (n.assignedSlot) { n = n.assignedSlot; continue; }
    const parent = n.parentElement;
    if (!parent) { const root = n.getRootNode(); n = root && root.host; continue; }
    // In an open root's host but in no slot: not laid out, so not a real hit.
    if (parent.shadowRoot) return null;
    if (parent.localName.indexOf('-') > 0 || hosts.test(parent.localName)) unseen.push(parent);
    n = parent;
  }
  return null;
}`;

async function hostObject(
  deps: ActionTargetDeps,
  target: ResolvedActionTarget,
): Promise<string> {
  const { identity } = target;
  const frame = deps.registry.getFrame(identity.frameId);
  if (
    !frame ||
    frame.loaderId !== identity.loaderId ||
    frame.sessionId !== identity.sessionId
  )
    throw new Error('The scroll target document is no longer available.');
  const context = await hostWorldContext(
    deps,
    identity.frameId,
    identity.sessionId,
  );
  if (context === undefined)
    throw new Error('The scroll target could not be read.');
  const object = await resolveNodeObject(
    deps.send,
    identity.sessionId,
    identity.backendNodeId,
    target.objectGroup,
    context,
  );
  if (!object) throw new Error('The scroll target is no longer available.');
  return object;
}

export async function readScrollState(
  deps: ActionTargetDeps,
  target: ResolvedActionTarget,
): Promise<ScrollState> {
  const objectId = await hostObject(deps, target);
  const value = remoteValue(
    await deps.send(
      'Runtime.callFunctionOn',
      { objectId, functionDeclaration: SCROLL_READ, returnByValue: true },
      target.identity.sessionId,
    ),
  );
  if (!isCDPRecord(value))
    throw new Error('The scroll position could not be read.');
  const fields = [
    'x',
    'y',
    'maxX',
    'maxY',
    'width',
    'height',
    'scrollWidth',
    'scrollHeight',
  ];
  if (
    !fields.every(
      (key) => typeof value[key] === 'number' && Number.isFinite(value[key]),
    )
  )
    throw new Error('The scroll position could not be read.');
  // Narrow each decoded scalar without trusting a CDP object shape.
  const finite = (v: unknown): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : 0;
  const point =
    isCDPRecord(value.point) &&
    typeof value.point.x === 'number' &&
    typeof value.point.y === 'number' &&
    Number.isFinite(value.point.x) &&
    Number.isFinite(value.point.y)
      ? { x: value.point.x, y: value.point.y }
      : undefined;
  return {
    x: finite(value.x),
    y: finite(value.y),
    maxX: finite(value.maxX),
    maxY: finite(value.maxY),
    width: finite(value.width),
    height: finite(value.height),
    scrollWidth: finite(value.scrollWidth),
    scrollHeight: finite(value.scrollHeight),
    scriptX: value.scriptX === true,
    scriptY: value.scriptY === true,
    ...(point ? { point } : {}),
  };
}

export async function writeScrollBy(
  deps: ActionTargetDeps,
  target: ResolvedActionTarget,
  dx: number,
  dy: number,
  beforeWrite: () => void = (): void => {},
): Promise<void> {
  const objectId = await hostObject(deps, target);
  beforeWrite();
  const result = await deps.send(
    'Runtime.callFunctionOn',
    {
      objectId,
      functionDeclaration: `function(dx, dy) { const doc = this.ownerDocument; if (!this.isConnected || !doc.defaultView || doc.defaultView.document !== doc) return false; this.scrollBy({ left: dx, top: dy, behavior: 'instant' }); return true; }`,
      arguments: [{ value: dx }, { value: dy }],
      returnByValue: true,
    },
    target.identity.sessionId,
  );
  if (remoteValue(result) !== true)
    throw new Error('The scroll target is no longer available.');
}

/** The text node a text search matched, in its frame's host world. */
async function matchedTextNode(
  deps: ActionTargetDeps,
  target: ResolvedActionTarget,
): Promise<string | undefined> {
  const { identity, scrollNode } = target;
  if (scrollNode === undefined) return undefined;
  const context = await hostWorldContext(
    deps,
    identity.frameId,
    identity.sessionId,
  );
  if (context === undefined) return undefined;
  return resolveNodeObject(
    deps.send,
    identity.sessionId,
    scrollNode,
    target.objectGroup,
    context,
  );
}

export interface TextMatchRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The rectangle of the words a text search matched, from the corner of
 * their text node's bounds: the `rect` for `DOM.scrollIntoViewIfNeeded` on
 * that node. Undefined when the node cannot be reached or no longer holds
 * the words; the node itself is then all there is to scroll to.
 */
export async function textMatchRect(
  deps: ActionTargetDeps,
  target: ResolvedActionTarget,
  text: string,
): Promise<TextMatchRect | undefined> {
  const node = await matchedTextNode(deps, target);
  if (!node) return undefined;
  const rect = remoteValue(
    await deps.send(
      'Runtime.callFunctionOn',
      {
        objectId: node,
        functionDeclaration: TEXT_MATCH_RECT,
        arguments: [{ value: text }],
        returnByValue: true,
      },
      target.identity.sessionId,
    ),
  );
  if (!isCDPRecord(rect)) return undefined;
  const x = readCDPFiniteNumber(rect.x);
  const y = readCDPFiniteNumber(rect.y);
  const width = readCDPFiniteNumber(rect.width);
  const height = readCDPFiniteNumber(rect.height);
  return x === undefined ||
    y === undefined ||
    width === undefined ||
    height === undefined
    ? undefined
    : { x, y, width, height };
}

/**
 * Whether the words a text search matched are in view in their document
 * now. A read: nothing is scrolled. Undefined when that is not known: the
 * node could not be reached, or no longer holds the words.
 */
export async function textMatchShown(
  deps: ActionTargetDeps,
  target: ResolvedActionTarget,
  text: string,
): Promise<boolean | undefined> {
  const node = await matchedTextNode(deps, target);
  if (!node) return undefined;
  const shown = remoteValue(
    await deps.send(
      'Runtime.callFunctionOn',
      {
        objectId: node,
        functionDeclaration: `function(text) { return (${CENTER_TEXT_MATCH})(this, text, true); }`,
        arguments: [{ value: text }],
        returnByValue: true,
      },
      target.identity.sessionId,
    ),
  );
  return typeof shown === 'boolean' ? shown : undefined;
}

/**
 * Ancestors nearest-first in the flat tree, through slots and root hosts, in
 * one document. A scroller around a slot in a closed root is not seen.
 * For a text match the walk starts at the text node, whose parent in the
 * flat tree is its slot: the element that holds the text is then one of
 * the ancestors, after any scroller around that slot.
 */
export async function scrollAncestors(
  deps: ActionTargetDeps,
  target: ResolvedActionTarget,
  depth = 0,
  registerSessionGroup?: (sessionId: string) => void,
): Promise<ResolvedActionTarget[]> {
  const objectId =
    (await matchedTextNode(deps, target)) ?? (await hostObject(deps, target));
  const count = remoteValue(
    await deps.send(
      'Runtime.callFunctionOn',
      {
        objectId,
        functionDeclaration: `function() { let n = this, count = 0; while (n) { ${FLAT_PARENT} if (n) count++; } return count; }`,
        returnByValue: true,
      },
      target.identity.sessionId,
    ),
  );
  const ancestors: ResolvedActionTarget[] = [];
  if (typeof count !== 'number' || !Number.isInteger(count)) return ancestors;
  for (let index = 1; index <= Math.min(count, 128); index++) {
    const ancestorObject = remoteObjectId(
      await deps.send(
        'Runtime.callFunctionOn',
        {
          objectId,
          functionDeclaration: `function(level) { let n = this; for(let i = 0; n && i < level; i++) { ${FLAT_PARENT} } return n; }`,
          arguments: [{ value: index }],
          objectGroup: target.objectGroup,
        },
        target.identity.sessionId,
      ),
    );
    if (!ancestorObject) continue;
    const described = await deps.send(
      'DOM.describeNode',
      { objectId: ancestorObject },
      target.identity.sessionId,
    );
    const backendNodeId =
      isCDPRecord(described) && isCDPRecord(described.node)
        ? readCDPInteger(described.node.backendNodeId)
        : undefined;
    if (backendNodeId === undefined) continue;
    const ancestor = {
      ...target,
      identity: { ...target.identity, backendNodeId },
      objectId: ancestorObject,
      ref: undefined,
      scrollNode: undefined,
    };
    const state = await readScrollState(deps, ancestor);
    if (state.maxX > 0 || state.maxY > 0) ancestors.push(ancestor);
  }
  const frame = deps.registry.getFrame(target.identity.frameId);
  const parent =
    frame?.parentId === undefined
      ? undefined
      : deps.registry.getFrame(frame.parentId);
  if (frame && parent?.loaderId && depth < 6) {
    const backendNodeId = decodeFrameOwnerBackendNodeId(
      await deps.send(
        'DOM.getFrameOwner',
        { frameId: frame.frameId },
        parent.sessionId,
      ),
    );
    if (backendNodeId !== undefined) {
      // Register before resolution: a late or rejected resolve can still retain objects.
      if (parent.sessionId !== target.identity.sessionId)
        registerSessionGroup?.(parent.sessionId);
      const objectId = await resolveNodeObject(
        deps.send,
        parent.sessionId,
        backendNodeId,
        target.objectGroup,
      );
      if (objectId) {
        const owner: ResolvedActionTarget = {
          identity: {
            sessionId: parent.sessionId,
            frameId: parent.frameId,
            loaderId: parent.loaderId,
            backendNodeId,
          },
          frameRef: parent.frameRef,
          objectId,
          objectGroup: target.objectGroup,
          outOfProcess: parent.sessionId !== '',
        };
        ancestors.push(
          ...(await scrollAncestors(
            deps,
            owner,
            depth + 1,
            registerSessionGroup,
          )),
        );
      }
    }
  }
  return ancestors;
}

/** Verify the actual deepest hit's wheel-scrollable chain in the host world. */
export async function wheelOwnerMatches(
  deps: ActionTargetDeps,
  target: ResolvedActionTarget,
  hitBackendNodeId: number,
  axis: 'x' | 'y',
): Promise<boolean> {
  const objectId = await hostObject(deps, target);
  const context = await hostWorldContext(
    deps,
    target.identity.frameId,
    target.identity.sessionId,
  );
  if (context === undefined) return false;
  const hit = await resolveNodeObject(
    deps.send,
    target.identity.sessionId,
    hitBackendNodeId,
    target.objectGroup,
    context,
  );
  if (!hit) return false;
  const sessionId = target.identity.sessionId;
  const unseen = remoteObjectId(
    await deps.send(
      'Runtime.callFunctionOn',
      {
        objectId,
        functionDeclaration: WHEEL_OWNER,
        arguments: [{ objectId: hit }, { value: axis }],
        objectGroup: target.objectGroup,
      },
      sessionId,
    ),
  );
  if (!unseen) return false;
  const listed = await deps.send(
    'Runtime.getProperties',
    { objectId: unseen, ownProperties: true },
    sessionId,
  );
  if (!isCDPRecord(listed) || !Array.isArray(listed.result)) return false;
  const candidates: string[] = [];
  for (const entry of listed.result) {
    if (!isCDPRecord(entry) || typeof entry.name !== 'string') return false;
    if (!/^\d+$/.test(entry.name)) continue;
    const candidate = isCDPRecord(entry.value)
      ? readCDPString(entry.value.objectId)
      : undefined;
    if (candidate === undefined) return false;
    candidates.push(candidate);
  }
  const hosting = await Promise.all(
    candidates.map((candidate) => hostsShadowRoot(deps, sessionId, candidate)),
  );
  return !hosting.includes(true);
}

export async function readViewportTelemetry(
  deps: ActionTargetDeps,
): Promise<ViewportTelemetry | undefined> {
  const root = deps.registry
    .frames()
    .find((frame) => frame.sessionId === '' && frame.parentId === undefined);
  if (!root?.loaderId) return undefined;
  const loader = root.loaderId;
  try {
    const contextId = await hostWorldContext(deps, root.frameId, '');
    if (contextId === undefined) return undefined;
    const value = remoteValue(
      await deps.send(
        'Runtime.evaluate',
        {
          contextId,
          expression: `(() => { const el = document.documentElement, view = document.scrollingElement, scroller = view || el; if (!scroller) return null; const maxX = Math.max(0, scroller.scrollWidth - scroller.clientWidth), maxY = Math.max(0, scroller.scrollHeight - scroller.clientHeight); const at = (${SCROLL_OFFSETS})(scroller, getComputedStyle(scroller), maxX, maxY); return { viewport: view ? { width: view.clientWidth, height: view.clientHeight } : { width: innerWidth, height: innerHeight }, scroll: { x: at.x, y: at.y, maxX, maxY } }; })()`,
          returnByValue: true,
        },
        '',
      ),
    );
    if (
      deps.registry.getFrame(root.frameId)?.loaderId !== loader ||
      !isCDPRecord(value) ||
      !isCDPRecord(value.viewport) ||
      !isCDPRecord(value.scroll)
    )
      return undefined;
    const viewport = value.viewport,
      scroll = value.scroll;
    const width = viewport.width,
      height = viewport.height,
      x = scroll.x,
      y = scroll.y,
      maxX = scroll.maxX,
      maxY = scroll.maxY;
    if (
      typeof width !== 'number' ||
      typeof height !== 'number' ||
      typeof x !== 'number' ||
      typeof y !== 'number' ||
      typeof maxX !== 'number' ||
      typeof maxY !== 'number' ||
      ![width, height, x, y, maxX, maxY].every(Number.isFinite)
    )
      return undefined;
    return { viewport: { width, height }, scroll: { x, y, maxX, maxY } };
  } catch {
    return undefined;
  }
}

export async function readDocumentViewport(
  deps: ActionTargetDeps,
  target: ResolvedActionTarget,
): Promise<{ width: number; height: number } | undefined> {
  const objectId = await hostObject(deps, target);
  const value = remoteValue(
    await deps.send(
      'Runtime.callFunctionOn',
      {
        objectId,
        functionDeclaration:
          'function() { const win = this.ownerDocument.defaultView; return win ? { width: win.innerWidth, height: win.innerHeight } : null; }',
        returnByValue: true,
      },
      target.identity.sessionId,
    ),
  );
  return isCDPRecord(value) &&
    typeof value.width === 'number' &&
    typeof value.height === 'number' &&
    Number.isFinite(value.width) &&
    Number.isFinite(value.height)
    ? { width: value.width, height: value.height }
    : undefined;
}
