import {
  decodeAccessibilityNodes,
  isCDPRecord,
  readCDPArray,
  readCDPInteger,
  readCDPString,
  type DomTreeNode,
} from './cdp-decode';
import type { FrameRegistry } from './frame-registry';
import type {
  PageModelAccessibilityNode,
  PageModelDeps,
  PageModelListenerResult,
  PageModelNode,
} from './model-types';
import type { FrameFacts } from './page-model-assembly';
import type { FrameContext } from './page-model-capture';
import { isAbortError, REQUEST_TIMEOUT_MS, sendOnce } from './page-model-cdp';

const MAX_LISTENER_SCAN_NODES = 10_000;
const MAX_LISTENER_HITS = 100;
const PROBE_LISTENER_EVENTS = [
  'click',
  'mousedown',
  'mouseup',
  'pointerdown',
  'pointerup',
];
/** Accessible names that come from an attribute the model already exposes. */
const ATTRIBUTE_NAME_SOURCES = new Set([
  'aria-label',
  'title',
  'alt',
  'placeholder',
  'aria-placeholder',
]);
/** Text leaves carry raw page text, including a secret field's contents. */
const TEXT_ROLES = new Set(['StaticText', 'InlineTextBox', 'LineBreak']);

interface CachedAXNode {
  backendNodeId?: number;
  role?: string;
  name?: string;
  /** Whether the name came only from an exposed attribute. */
  attributeName: boolean;
}

const accessibilityCache: WeakMap<
  FrameRegistry,
  Map<string, CachedAXNode[]>
> = new WeakMap();

function accessibilityCacheKey(context: FrameContext): string {
  return `${context.registered.sessionId}\u0000${context.registered.frameId}\u0000${context.registered.loaderId}`;
}

function decodeAXText(value: unknown): string | undefined {
  if (!isCDPRecord(value)) return undefined;
  return readCDPString(value.value);
}

/** The winning name source: the first one with a value that is not superseded. */
function isAttributeName(name: unknown): boolean {
  if (!isCDPRecord(name)) return false;
  const sources = readCDPArray(name.sources);
  if (!sources) return false;
  for (const source of sources) {
    if (!isCDPRecord(source) || source.superseded === true) continue;
    if (!isCDPRecord(source.value)) continue;
    const attribute = readCDPString(source.attribute);
    return (
      (source.type === 'attribute' || source.type === 'placeholder') &&
      attribute !== undefined &&
      ATTRIBUTE_NAME_SOURCES.has(attribute)
    );
  }
  return false;
}

interface FrameRedaction {
  modelIds: Set<number>;
  sensitiveIds: Set<number>;
  hasSecrets: boolean;
}

function frameRedaction(
  frame: FrameFacts,
  nodes: PageModelNode[],
): FrameRedaction {
  const modelIds = new Set<number>();
  const sensitiveIds = new Set<number>();
  for (const node of nodes) {
    if (node.frameRef !== frame.context.registered.frameRef) continue;
    if (node.nodeType !== 1) continue;
    modelIds.add(node.identity.backendNodeId);
    if (node.secret || node.hasSecretDescendant || node.insideSecretSelect) {
      sensitiveIds.add(node.identity.backendNodeId);
    }
  }
  return { modelIds, sensitiveIds, hasSecrets: frame.hasSecrets };
}

/**
 * Keeps a name only for a model element that is not secret and has no secret
 * descendant. Text leaves never keep names. In a frame with any secret, only
 * names from an exposed attribute survive: content and `aria-labelledby` or
 * `<label>` names can carry a secret field's live value.
 */
function redactAXNodes(
  nodes: CachedAXNode[],
  redaction: FrameRedaction,
): CachedAXNode[] {
  return nodes.map((node) => {
    const keep =
      node.name !== undefined &&
      node.backendNodeId !== undefined &&
      redaction.modelIds.has(node.backendNodeId) &&
      !redaction.sensitiveIds.has(node.backendNodeId) &&
      !TEXT_ROLES.has(node.role ?? '') &&
      (!redaction.hasSecrets || node.attributeName);
    return {
      ...(node.backendNodeId === undefined
        ? {}
        : { backendNodeId: node.backendNodeId }),
      ...(node.role === undefined ? {} : { role: node.role }),
      ...(keep && node.name !== undefined ? { name: node.name } : {}),
      attributeName: node.attributeName,
    };
  });
}

async function fetchAccessibility(
  deps: PageModelDeps,
  context: FrameContext,
): Promise<CachedAXNode[] | undefined> {
  try {
    const response = await sendOnce(
      deps,
      'Accessibility.getFullAXTree',
      { frameId: context.registered.frameId },
      context.registered.sessionId,
    );
    const rawNodes = decodeAccessibilityNodes(response);
    if (!rawNodes) return undefined;
    const nodes: CachedAXNode[] = [];
    for (const rawNode of rawNodes) {
      if (!isCDPRecord(rawNode)) continue;
      const backendNodeId = readCDPInteger(rawNode.backendDOMNodeId);
      const role = decodeAXText(rawNode.role);
      const name = decodeAXText(rawNode.name);
      nodes.push({
        ...(backendNodeId === undefined ? {} : { backendNodeId }),
        ...(role === undefined ? {} : { role }),
        ...(name === undefined ? {} : { name }),
        attributeName: isAttributeName(rawNode.name),
      });
    }
    return nodes;
  } catch (error) {
    if (isAbortError(error)) throw error;
    return undefined;
  }
}

/**
 * Fetches `Accessibility.getFullAXTree` per frame and caches it per document.
 * Names are redacted before they are cached and again on every read, so the
 * cache never holds a name the current secret state would withhold.
 */
export async function collectAccessibility(
  deps: PageModelDeps,
  frames: FrameFacts[],
  nodes: PageModelNode[],
): Promise<PageModelAccessibilityNode[]> {
  let cache = accessibilityCache.get(deps.registry);
  if (!cache) {
    cache = new Map<string, CachedAXNode[]>();
    accessibilityCache.set(deps.registry, cache);
  }
  const frameCache = cache;
  const results = await Promise.all(
    frames.map(async (frame) => {
      const context = frame.context;
      const key = accessibilityCacheKey(context);
      const redaction = frameRedaction(frame, nodes);
      let cached = frameCache.get(key);
      if (!cached) {
        const fetched = await fetchAccessibility(deps, context);
        if (!fetched) return [];
        cached = redactAXNodes(fetched, redaction);
        const prefix = `${context.registered.sessionId}\u0000${context.registered.frameId}\u0000`;
        for (const entryKey of Array.from(frameCache.keys())) {
          if (entryKey.startsWith(prefix)) frameCache.delete(entryKey);
        }
        frameCache.set(key, cached);
      }
      return redactAXNodes(cached, redaction).map(
        (node): PageModelAccessibilityNode => ({
          frameId: context.registered.frameId,
          ...(node.backendNodeId === undefined
            ? {}
            : { backendNodeId: node.backendNodeId }),
          ...(node.role === undefined ? {} : { role: node.role }),
          ...(node.name === undefined ? {} : { name: node.name }),
        }),
      );
    }),
  );
  return results.flat();
}

interface ListenerHit {
  scope: number;
  path: Array<{ tag: string; position: number }>;
}

type ListenerScan =
  | { kind: 'scanned'; hits: ListenerHit[] }
  | { kind: 'skipped'; reason: string };

/** Deepest element path accepted from a scan; anything longer is dropped. */
const MAX_LISTENER_PATH_DEPTH = 512;
const ELEMENT_NAME = /^[a-z][a-z0-9-]*$/i;

/**
 * The scan runs in the page's main world: `getEventListeners` reports only
 * listeners registered from the context it is called in, so an isolated
 * world sees none (verified in Chromium). Page scripts there can replace
 * built-ins, so the host treats whatever comes back as untrusted: a throw
 * or a malformed result is a skipped frame, and only element paths are
 * read back, never page data.
 *
 * It first counts the elements of the document and its open shadow roots
 * (closed roots are unreachable from script), stopping as soon as there are
 * more than 10,000, then looks for click-like listeners until 100 elements
 * have one. A path climbs `parentNode` to its scope root, counting each
 * step among same-name element siblings. Scope order: the document, then
 * each open shadow root as its host is reached, depth first.
 */
function listenerExpression(): string {
  return `(() => {
    const events = ${JSON.stringify(PROBE_LISTENER_EVENTS)};
    const scopes = [];
    let count = 0;
    const collect = (root) => {
      const elements = root.querySelectorAll('*');
      count += elements.length;
      if (count > ${MAX_LISTENER_SCAN_NODES}) return false;
      scopes.push({ root, elements });
      for (let index = 0; index < elements.length; index += 1) {
        const shadowRoot = elements[index].shadowRoot;
        if (shadowRoot && !collect(shadowRoot)) return false;
      }
      return true;
    };
    if (!collect(document)) return { count, hits: [], skipped: 'node_limit' };
    const hits = [];
    for (let scopeIndex = 0; scopeIndex < scopes.length; scopeIndex += 1) {
      const scope = scopes[scopeIndex];
      for (let index = 0; index < scope.elements.length; index += 1) {
        const element = scope.elements[index];
        const listeners = getEventListeners(element);
        if (!events.some((event) => Array.isArray(listeners[event]) && listeners[event].length > 0)) continue;
        const path = [];
        let current = element;
        while (current && current !== scope.root && current.nodeType === 1) {
          let position = 1;
          for (let sibling = current.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
            if (sibling.localName === current.localName) position += 1;
          }
          path.unshift({ tag: current.localName, position });
          current = current.parentNode;
        }
        if (current === scope.root && path.length > 0) hits.push({ scope: scopeIndex, path });
        if (hits.length >= ${MAX_LISTENER_HITS}) return { count, hits };
      }
    }
    return { count, hits };
  })()`;
}

/**
 * Decodes a scan result through guards. Only `node_limit` is accepted as a
 * skip reason, so no page-chosen string reaches the model.
 */
function decodeListenerScan(value: unknown): ListenerScan {
  const failed: ListenerScan = { kind: 'skipped', reason: 'scan_failed' };
  if (!isCDPRecord(value)) return failed;
  const rawHits = readCDPArray(value.hits);
  if (readCDPInteger(value.count) === undefined || !rawHits) return failed;
  if (value.skipped !== undefined) {
    return value.skipped === 'node_limit'
      ? { kind: 'skipped', reason: 'node_limit' }
      : failed;
  }
  const hits: ListenerHit[] = [];
  for (const rawHit of rawHits.slice(0, MAX_LISTENER_HITS)) {
    if (!isCDPRecord(rawHit)) continue;
    const scope = readCDPInteger(rawHit.scope);
    const rawPath = readCDPArray(rawHit.path);
    if (
      scope === undefined ||
      scope < 0 ||
      !rawPath ||
      rawPath.length === 0 ||
      rawPath.length > MAX_LISTENER_PATH_DEPTH
    ) {
      continue;
    }
    const path: ListenerHit['path'] = [];
    for (const rawPart of rawPath) {
      const tag = isCDPRecord(rawPart) ? readCDPString(rawPart.tag) : undefined;
      const position = isCDPRecord(rawPart)
        ? readCDPInteger(rawPart.position)
        : undefined;
      if (
        tag === undefined ||
        !ELEMENT_NAME.test(tag) ||
        position === undefined ||
        position < 1
      ) {
        path.length = 0;
        break;
      }
      path.push({ tag, position });
    }
    if (path.length > 0) hits.push({ scope, path });
  }
  return { kind: 'scanned', hits };
}

/** The scan's scope order: the document, then open roots as discovered. */
function listenerScopes(document: DomTreeNode): DomTreeNode[] {
  const scopes: DomTreeNode[] = [];
  const addScope = (root: DomTreeNode): void => {
    scopes.push(root);
    const pending: DomTreeNode[] = [...root.children].reverse();
    while (pending.length > 0) {
      const node = pending.pop();
      if (!node) break;
      if (node.nodeType !== 1) continue;
      const open = node.shadowRoots.find(
        (shadowRoot) => shadowRoot.shadowRootType === 'open',
      );
      if (open) addScope(open);
      for (let index = node.children.length - 1; index >= 0; index -= 1) {
        pending.push(node.children[index]);
      }
    }
  };
  addScope(document);
  return scopes;
}

function nodeForPath(
  root: DomTreeNode,
  path: ListenerHit['path'],
): DomTreeNode | undefined {
  let current: DomTreeNode | undefined = root;
  for (const step of path) {
    if (!current) return undefined;
    let seen = 0;
    let next: DomTreeNode | undefined;
    for (const child of current.children) {
      if (child.nodeType !== 1) continue;
      if (child.nodeName.toLowerCase() !== step.tag.toLowerCase()) continue;
      seen += 1;
      if (seen === step.position) {
        next = child;
        break;
      }
    }
    current = next;
  }
  return current;
}

/**
 * Runs the scan in one main world: the session's top frame without a
 * context id, any other frame in its default context. The evaluation is
 * silent and terminated by Chromium at the request timeout, so a page that
 * loops or throws cannot hold or fail the build.
 */
async function listenerScanInMainWorld(
  deps: PageModelDeps,
  sessionId: string,
  contextId: number | undefined,
): Promise<ListenerScan> {
  try {
    const response = await sendOnce(
      deps,
      'Runtime.evaluate',
      {
        ...(contextId === undefined ? {} : { contextId }),
        expression: listenerExpression(),
        includeCommandLineAPI: true,
        returnByValue: true,
        silent: true,
        timeout: REQUEST_TIMEOUT_MS,
      },
      sessionId,
    );
    if (
      !isCDPRecord(response) ||
      response.exceptionDetails !== undefined ||
      !isCDPRecord(response.result)
    ) {
      return { kind: 'skipped', reason: 'scan_failed' };
    }
    return decodeListenerScan(response.result.value);
  } catch (error) {
    if (isAbortError(error)) throw error;
    return { kind: 'skipped', reason: 'scan_failed' };
  }
}

/**
 * Bounded click-listener detection (02's limits) in each frame's main
 * world. Hits are mapped to model nodes by walking the scan's paths over
 * the frame's own tree. A frame that shares its session with its parent
 * needs its main-world context id; without one it is skipped, never scanned
 * in an isolated world, where the page's listeners are invisible.
 */
export async function collectListeners(
  deps: PageModelDeps,
  frames: FrameFacts[],
  nodes: PageModelNode[],
): Promise<PageModelListenerResult[]> {
  const output: PageModelListenerResult[] = [];
  const sessionByFrame = new Map(
    frames.map((frame) => [
      frame.context.registered.frameId,
      frame.context.registered.sessionId,
    ]),
  );
  let totalHits = 0;
  for (const frame of frames) {
    if (totalHits >= MAX_LISTENER_HITS) break;
    const context = frame.context;
    const { frameId, sessionId, parentId } = context.registered;
    const parentSession =
      parentId === undefined
        ? undefined
        : (sessionByFrame.get(parentId) ??
          deps.registry.getFrame(parentId)?.sessionId);
    const sessionTop = parentId === undefined || parentSession !== sessionId;
    const contextId = sessionTop
      ? undefined
      : deps.mainWorldContextId?.(frameId, sessionId);
    if (!sessionTop && contextId === undefined) {
      output.push({
        sessionId,
        frameId,
        backendNodeIds: [],
        skipped: 'main_world_unavailable',
      });
      continue;
    }
    const scan = await listenerScanInMainWorld(deps, sessionId, contextId);
    if (scan.kind === 'skipped') {
      output.push({
        sessionId,
        frameId,
        backendNodeIds: [],
        skipped: scan.reason,
      });
      continue;
    }
    const modelIds = new Set<number>();
    for (const node of nodes) {
      if (
        node.frameRef === context.registered.frameRef &&
        node.nodeType === 1
      ) {
        modelIds.add(node.identity.backendNodeId);
      }
    }
    const scopes = listenerScopes(context.document);
    const backendNodeIds = new Set<number>();
    for (const hit of scan.hits) {
      if (totalHits >= MAX_LISTENER_HITS) break;
      const scope = scopes[hit.scope];
      const target = scope ? nodeForPath(scope, hit.path) : undefined;
      if (!target || !modelIds.has(target.backendNodeId)) continue;
      if (backendNodeIds.has(target.backendNodeId)) continue;
      backendNodeIds.add(target.backendNodeId);
      totalHits += 1;
    }
    const hasClosedShadowRoots = frame.shadowRoots.some(
      (root) => root.shadowRootType === 'closed',
    );
    output.push({
      sessionId,
      frameId,
      backendNodeIds: Array.from(backendNodeIds),
      ...(hasClosedShadowRoots
        ? { skipped: 'closed_shadow_roots_not_scanned' }
        : {}),
    });
  }
  return output;
}
