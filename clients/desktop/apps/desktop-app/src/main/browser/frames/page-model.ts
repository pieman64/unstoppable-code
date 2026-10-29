import type { BrowserRectangle } from '@canopy/desktop-shared/types/browser';
import {
  decodeBoxModel,
  decodeFrameOwnerBackendNodeId,
  type DecodedBoxModel,
  type DomTreeNode,
} from './cdp-decode';
import { isAxisAlignedQuad } from './frame-geometry';
import type { RegisteredFrame } from './frame-registry';
import { attributeReader } from './model-semantics';
import type {
  BrowserPageModel,
  FrameCoverage,
  PageModelAccessibilityNode,
  PageModelCacheKey,
  PageModelDeps,
  PageModelListenerResult,
} from './model-types';
import {
  assemblePageModel,
  isVisuallyHidden,
  toTopLevel,
} from './page-model-assembly';
import {
  captureSession,
  type FrameContext,
  type SessionCapture,
} from './page-model-capture';
import {
  elapsed,
  ensureNotAborted,
  intersectRectangles,
  isAbortError,
  rectangle,
  REQUEST_RETRY_TIMEOUT_MS,
  REQUEST_TIMEOUT_MS,
  safeCoverageURL,
  sendOnce,
} from './page-model-cdp';
import { collectControlHistory } from './page-model-history';
import { collectAccessibility, collectListeners } from './page-model-optional';
import { readMissingLayoutStyles } from './page-model-styles';

export type {
  BrowserPageModel,
  FrameCoverage,
  PageModelAccessibilityNode,
  PageModelCacheKey,
  PageModelDeps,
  PageModelFrame,
  PageModelListenerResult,
  PageModelNode,
  PageModelStyleRead,
} from './model-types';

const MAX_FRAMES = 100;
const MAX_FRAME_DEPTH = 5;
/** An out-of-process frame is walked only if this much of it is visible. */
const MIN_VISIBLE_FRAME_EDGE = 10;
const MODEL_CACHE_TTL_MS = 500;
/**
 * Builds per request when the page changes underneath: one retry, then the
 * last model is used uncached, so a continuously mutating page costs at most
 * two builds.
 */
export const MAX_CONSISTENT_BUILD_ATTEMPTS = 2;

interface FrameCandidate {
  registered: RegisteredFrame;
  depth: number;
}

function copyKey(key: PageModelCacheKey): PageModelCacheKey {
  return {
    domEventRevision: key.domEventRevision,
    navigationSequence: key.navigationSequence,
    actionSequence: key.actionSequence,
  };
}

function sameKey(first: PageModelCacheKey, second: PageModelCacheKey): boolean {
  return (
    first.domEventRevision === second.domEventRevision &&
    first.navigationSequence === second.navigationSequence &&
    first.actionSequence === second.actionSequence
  );
}

/**
 * A built model and, for the same capture, the model with every form
 * control treated as secret.
 */
export interface PageModelBuild {
  model: BrowserPageModel;
  /**
   * Re-assembles the same capture with every input, textarea and select
   * secret, so the one secret predicate and its propagation withhold every
   * form value (attributes, text, markup). No CDP request is sent.
   */
  withheld(): BrowserPageModel;
}

/**
 * Builds until the revision observed when a build starts still holds when it
 * completes. A page that keeps changing gets the last capture after
 * `maxAttempts`, flagged as not consistent so it is not cached, and
 * re-assembled with every form control secret: its structure and values may
 * come from different instants.
 */
export async function buildConsistentModel(
  currentKey: () => PageModelCacheKey,
  build: () => Promise<PageModelBuild>,
  isCurrent: () => boolean = () => true,
  maxAttempts: number = MAX_CONSISTENT_BUILD_ATTEMPTS,
): Promise<{
  model: BrowserPageModel;
  key: PageModelCacheKey;
  consistent: boolean;
}> {
  for (let attempt = 1; ; attempt += 1) {
    const key = copyKey(currentKey());
    const built = await build();
    const consistent = sameKey(key, currentKey()) && isCurrent();
    if (consistent) return { model: built.model, key, consistent };
    if (attempt >= maxAttempts) {
      return { model: built.withheld(), key, consistent };
    }
  }
}

interface CacheEntry {
  key: PageModelCacheKey;
  model: BrowserPageModel;
  expiresAt: number;
}

interface PendingBuild {
  key: PageModelCacheKey;
  promise: Promise<BrowserPageModel>;
}

/**
 * Caches one model for 500 ms per revision key. The key is compared when a
 * build completes (not only when it starts), so a DOM change during a build
 * discards it; retries are capped so a continuously mutating page still gets
 * a model, which is then returned without being cached.
 */
export class PageModelCache {
  private cache: CacheEntry | undefined;

  private pending: PendingBuild | undefined;

  private generation: number = 0;

  public constructor(
    private readonly now: () => number = Date.now,
    private readonly maxAttempts: number = MAX_CONSISTENT_BUILD_ATTEMPTS,
  ) {}

  /** Host diagnostics distinguish a real cache hit from a coalesced build. */
  public hasFresh(key: PageModelCacheKey): boolean {
    return (
      this.cache !== undefined &&
      this.cache.expiresAt > this.now() &&
      sameKey(this.cache.key, key)
    );
  }

  public getOrBuild(
    currentKey: () => PageModelCacheKey,
    build: () => Promise<PageModelBuild>,
  ): Promise<BrowserPageModel> {
    const key = copyKey(currentKey());
    if (this.cache && this.hasFresh(key)) {
      return Promise.resolve(this.cache.model);
    }
    if (this.pending && sameKey(this.pending.key, key)) {
      return this.pending.promise;
    }
    this.cache = undefined;
    const promise = this.runBuild(currentKey, build);
    const pending: PendingBuild = { key, promise };
    this.pending = pending;
    void promise
      .finally(() => {
        if (this.pending === pending) this.pending = undefined;
      })
      .catch(() => undefined);
    return promise;
  }

  /** Discards the cached model and any in-flight build's result. */
  public invalidate(): void {
    this.generation += 1;
    this.cache = undefined;
    this.pending = undefined;
  }

  private async runBuild(
    currentKey: () => PageModelCacheKey,
    build: () => Promise<PageModelBuild>,
  ): Promise<BrowserPageModel> {
    let generation = this.generation;
    const result = await buildConsistentModel(
      currentKey,
      () => {
        generation = this.generation;
        return build();
      },
      () => generation === this.generation,
      this.maxAttempts,
    );
    if (result.consistent) {
      this.cache = {
        key: result.key,
        model: result.model,
        expiresAt: this.now() + MODEL_CACHE_TTL_MS,
      };
    }
    return result.model;
  }
}

function emptyPageModel(
  deps: PageModelDeps,
  coverage: FrameCoverage[],
  startedAt: number,
): BrowserPageModel {
  const capturedAt = deps.now();
  return {
    nodes: [],
    frames: [],
    coverage,
    registry: deps.registry,
    capturedAt: new Date(capturedAt).toISOString(),
    page: {
      browserId: '',
      url: '',
      title: '',
      viewport: { width: 0, height: 0, deviceScaleFactor: 1 },
      themeMode: 'light',
    },
    accessibility: [],
    listeners: [],
    styleSupplement: { candidates: 0, read: 0, skipped: 0 },
    trackerHistory: {
      inputs: 0,
      queried: 0,
      never: 0,
      was: 0,
      calls: 0,
      summaries: 0,
      durationMs: 0,
    },
    timings: {
      extractionMs: elapsed(startedAt, capturedAt),
      assemblyMs: 0,
      accessibilityMs: 0,
      listenersMs: 0,
      styleSupplementMs: 0,
      totalMs: elapsed(startedAt, capturedAt),
    },
  };
}

function candidateDepth(
  frame: RegisteredFrame,
  rootFrameId: string,
  byId: Map<string, RegisteredFrame>,
): number | undefined {
  let current: RegisteredFrame | undefined = frame;
  let depth = 0;
  const visited = new Set<string>();
  while (current) {
    if (current.frameId === rootFrameId) return depth;
    if (visited.has(current.frameId) || current.parentId === undefined) {
      return undefined;
    }
    visited.add(current.frameId);
    current = byId.get(current.parentId);
    depth += 1;
  }
  return undefined;
}

function coverageFor(
  frame: RegisteredFrame,
  status: 'included' | 'omitted',
  reason?: string,
  documentURL?: string,
): FrameCoverage {
  return {
    frameRef: frame.frameRef,
    url: safeCoverageURL(documentURL || frame.url),
    status,
    ...(reason === undefined ? {} : { reason }),
  };
}

/** Child frames by depth, within the 5-level and 100-frame limits. */
function buildCandidateList(
  registeredFrames: RegisteredFrame[],
  root: RegisteredFrame,
): { candidates: FrameCandidate[]; omitted: FrameCoverage[] } {
  const byId = new Map(registeredFrames.map((frame) => [frame.frameId, frame]));
  const candidates: FrameCandidate[] = [];
  const omitted: FrameCoverage[] = [];
  for (const frame of registeredFrames) {
    if (frame.frameId === root.frameId) continue;
    const depth = candidateDepth(frame, root.frameId, byId);
    if (depth === undefined) {
      omitted.push(coverageFor(frame, 'omitted', 'unmatched_parent'));
    } else if (depth > MAX_FRAME_DEPTH) {
      omitted.push(coverageFor(frame, 'omitted', 'max_depth'));
    } else if (frame.loaderId.length === 0) {
      omitted.push(coverageFor(frame, 'omitted', 'not_navigated'));
    } else {
      candidates.push({ registered: frame, depth });
    }
  }
  candidates.sort((first, second) => first.depth - second.depth);
  const admitted = candidates.slice(0, MAX_FRAMES - 1);
  for (const candidate of candidates.slice(MAX_FRAMES - 1)) {
    omitted.push(
      coverageFor(candidate.registered, 'omitted', 'max_child_frames'),
    );
  }
  return { candidates: admitted, omitted };
}

/** The `#document` node containing a node, crossing shadow roots. */
function documentOf(node: DomTreeNode): DomTreeNode | undefined {
  let current: DomTreeNode | undefined = node;
  while (current && current.nodeType !== 9) current = current.parent;
  return current;
}

function parsePixels(value: string | undefined): number {
  const parsed = Number.parseFloat(value ?? '');
  return Number.isFinite(parsed) ? parsed : 0;
}

/** The owner's on-screen geometry and the child frame's mapping. */
interface OwnerGeometry {
  /** Content box in top-level viewport coordinates. */
  content: BrowserRectangle;
  scaleX: number;
  scaleY: number;
}

/**
 * The owner's border box in its own document's viewport, from the DOM
 * snapshot: the bounding box after its own and its ancestors' CSS
 * transforms within that document. Undefined without a layout box.
 */
function ownerBorderBox(
  parent: FrameContext,
  owner: DomTreeNode,
): BrowserRectangle | undefined {
  const info = parent.capture.snapshot.nodes.get(owner.backendNodeId);
  const bounds = info?.bounds;
  if (!info || !bounds) return undefined;
  const document = parent.capture.snapshot.documents[info.documentIndex];
  return rectangle(
    bounds.x - (document?.scrollOffsetX ?? 0),
    bounds.y - (document?.scrollOffsetY ?? 0),
    bounds.width,
    bounds.height,
  );
}

/**
 * Maps an axis-aligned owner: its scale is the transformed border box over
 * its untransformed size, and its content box starts `clientLeft` plus the
 * left/top padding (both untransformed, so scaled) inside the border box.
 */
function ownerGeometry(
  parent: FrameContext,
  owner: DomTreeNode,
  border: BrowserRectangle,
  untransformed: { width: number; height: number } | undefined,
): OwnerGeometry {
  const info = parent.capture.snapshot.nodes.get(owner.backendNodeId);
  const scaleX =
    untransformed && untransformed.width > 0
      ? border.width / untransformed.width
      : 1;
  const scaleY =
    untransformed && untransformed.height > 0
      ? border.height / untransformed.height
      : 1;
  const paddingLeft = parsePixels(info?.computedStyles['padding-left']);
  const paddingTop = parsePixels(info?.computedStyles['padding-top']);
  const client = info?.clientRect;
  const local = rectangle(
    border.x + scaleX * ((client?.x ?? 0) + paddingLeft),
    border.y + scaleY * ((client?.y ?? 0) + paddingTop),
    scaleX *
      Math.max(
        0,
        (client ? client.width : border.width / scaleX) - paddingLeft,
      ),
    scaleY *
      Math.max(
        0,
        (client ? client.height : border.height / scaleY) - paddingTop,
      ),
  );
  return {
    content: toTopLevel(parent, local),
    scaleX: parent.scaleX * scaleX,
    scaleY: parent.scaleY * scaleY,
  };
}

/** `DOM.getBoxModel` for an owner in its parent's session, one retry. */
async function ownerBoxModel(
  deps: PageModelDeps,
  parent: FrameContext,
  owner: DomTreeNode,
): Promise<DecodedBoxModel | undefined> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await sendOnce(
        deps,
        'DOM.getBoxModel',
        { backendNodeId: owner.backendNodeId },
        parent.registered.sessionId,
        attempt === 0 ? REQUEST_TIMEOUT_MS : REQUEST_RETRY_TIMEOUT_MS,
      );
      return decodeBoxModel(response);
    } catch (error) {
      if (isAbortError(error)) throw error;
    }
  }
  return undefined;
}

function ownerOrAncestorHidden(
  parent: FrameContext,
  owner: DomTreeNode,
): boolean {
  let current: DomTreeNode | undefined = owner;
  while (current && current.nodeType !== 9) {
    if (current.nodeType === 1) {
      const info = parent.capture.snapshot.nodes.get(current.backendNodeId);
      if (
        isVisuallyHidden(
          attributeReader(current.attributes),
          info?.computedStyles ?? {},
        )
      ) {
        return true;
      }
    }
    current = current.parent;
  }
  return false;
}

async function frameOwnerFallback(
  deps: PageModelDeps,
  parent: FrameContext,
  childFrameId: string,
): Promise<DomTreeNode | undefined> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await sendOnce(
        deps,
        'DOM.getFrameOwner',
        { frameId: childFrameId },
        parent.registered.sessionId,
        attempt === 0 ? REQUEST_TIMEOUT_MS : REQUEST_RETRY_TIMEOUT_MS,
      );
      const backendNodeId = decodeFrameOwnerBackendNodeId(response);
      return backendNodeId === undefined
        ? undefined
        : parent.capture.tree.byBackendNodeId.get(backendNodeId);
    } catch (error) {
      if (isAbortError(error)) throw error;
    }
  }
  return undefined;
}

type OwnerResolution =
  | { candidate: FrameCandidate; reason: string }
  | {
      candidate: FrameCandidate;
      parent: FrameContext;
      owner: DomTreeNode;
      geometry: OwnerGeometry;
    };

function visibleEnough(
  rectangleOnScreen: BrowserRectangle,
  parent: FrameContext,
  viewport: BrowserRectangle,
): boolean {
  const visible = intersectRectangles(
    intersectRectangles(rectangleOnScreen, parent.clip),
    viewport,
  );
  return (
    visible.width >= MIN_VISIBLE_FRAME_EDGE &&
    visible.height >= MIN_VISIBLE_FRAME_EDGE
  );
}

async function resolveOwner(
  deps: PageModelDeps,
  candidate: FrameCandidate,
  contexts: Map<string, FrameContext>,
  viewport: BrowserRectangle,
): Promise<OwnerResolution> {
  const parentId = candidate.registered.parentId;
  const parent = parentId === undefined ? undefined : contexts.get(parentId);
  if (!parent) return { candidate, reason: 'parent_document_unavailable' };
  const childFrameId = candidate.registered.frameId;
  let owner = parent.capture.owners.get(childFrameId);
  if (!owner) owner = await frameOwnerFallback(deps, parent, childFrameId);
  if (
    !owner ||
    (owner.frameId !== undefined && owner.frameId !== childFrameId)
  ) {
    return { candidate, reason: 'owner_unresolved' };
  }
  const ownerDocument = documentOf(owner);
  if (
    !ownerDocument ||
    parent.capture.documentFrameIds.get(ownerDocument) !==
      parent.registered.frameId
  ) {
    return { candidate, reason: 'owner_unresolved' };
  }
  const outOfProcess =
    candidate.registered.sessionId !== parent.registered.sessionId;
  const border = ownerBorderBox(parent, owner);
  if (!border) {
    // No layout box: nothing of the frame is on screen. A same-process
    // frame is still modeled, at the owner's origin.
    if (outOfProcess) return { candidate, reason: 'owner_not_visible' };
    return {
      candidate,
      parent,
      owner,
      geometry: {
        content: rectangle(parent.translationX, parent.translationY, 0, 0),
        scaleX: parent.scaleX,
        scaleY: parent.scaleY,
      },
    };
  }
  // The 10 px rule applies to the on-screen size. The bounding box already
  // includes the owner's transforms, so hidden or tiny owners need no
  // geometry request.
  if (
    outOfProcess &&
    (ownerOrAncestorHidden(parent, owner) ||
      !visibleEnough(toTopLevel(parent, border), parent, viewport))
  ) {
    return { candidate, reason: 'owner_not_visible' };
  }
  const boxModel = await ownerBoxModel(deps, parent, owner);
  if (!boxModel) return { candidate, reason: 'owner_geometry_unavailable' };
  if (!isAxisAlignedQuad(boxModel.border)) {
    return { candidate, reason: 'owner_transformed' };
  }
  const geometry = ownerGeometry(parent, owner, border, boxModel);
  if (outOfProcess && !visibleEnough(geometry.content, parent, viewport)) {
    return { candidate, reason: 'owner_not_visible' };
  }
  return { candidate, parent, owner, geometry };
}

/**
 * Reports, once per session, documents and frame owners whose frame the
 * registry does not know. Registered frames are already covered as included
 * or omitted.
 */
function unmatchedCoverage(
  captures: SessionCapture[],
  registeredIds: Set<string>,
): FrameCoverage[] {
  const coverage: FrameCoverage[] = [];
  const reported = new Set<string>();
  for (const capture of captures) {
    for (const [document, frameId] of Array.from(
      capture.documentFrameIds.entries(),
    )) {
      if (registeredIds.has(frameId) || reported.has(frameId)) continue;
      reported.add(frameId);
      const snapshotDocument = capture.snapshot.documents.find(
        (entry) => entry.rootBackendNodeId === document.backendNodeId,
      );
      coverage.push({
        frameRef: '',
        url: safeCoverageURL(snapshotDocument?.documentURL ?? ''),
        status: 'omitted',
        reason: 'unmatched_frame_identity',
      });
    }
  }
  for (const capture of captures) {
    for (const frameId of Array.from(capture.owners.keys())) {
      if (registeredIds.has(frameId) || reported.has(frameId)) continue;
      reported.add(frameId);
      coverage.push({
        frameRef: '',
        url: '',
        status: 'omitted',
        reason: 'frame_identity_unavailable',
      });
    }
  }
  return coverage;
}

function snapshotDocumentFor(
  capture: SessionCapture,
  document: DomTreeNode,
): FrameContext['snapshotDocument'] {
  return capture.snapshot.documents.find(
    (entry) => entry.rootBackendNodeId === document.backendNodeId,
  );
}

/**
 * Builds the page model from CDP. Structure comes from the pierced
 * `DOM.getDocument` of each session; the DOM snapshot is only a lookup for
 * layout, styles and live values. Out-of-process frames are captured only
 * after their owner is found visible, level by level.
 */
export async function buildPageModel(
  deps: PageModelDeps,
  options: { accessibility?: boolean; listeners?: boolean } = {},
): Promise<BrowserPageModel> {
  return (await buildPageModelWithFallback(deps, options)).model;
}

/** `buildPageModel`, plus the withheld re-assembly of the same capture. */
export async function buildPageModelWithFallback(
  deps: PageModelDeps,
  options: { accessibility?: boolean; listeners?: boolean } = {},
): Promise<PageModelBuild> {
  const unchanged = (model: BrowserPageModel): PageModelBuild => ({
    model,
    withheld: () => model,
  });
  const startedAt = deps.now();
  ensureNotAborted(deps.signal);
  const registeredFrames = deps.registry.frames();
  const root = registeredFrames.find(
    (frame) => frame.sessionId === '' && frame.parentId === undefined,
  );
  if (!root || root.loaderId.length === 0) {
    const coverage = registeredFrames.map((frame) =>
      coverageFor(frame, 'omitted', 'root_not_navigated'),
    );
    if (coverage.length === 0) {
      coverage.push({
        frameRef: '',
        url: '',
        status: 'omitted',
        reason: 'root_not_navigated',
      });
    }
    return unchanged(emptyPageModel(deps, coverage, startedAt));
  }

  const extractionStartedAt = deps.now();
  const { candidates, omitted } = buildCandidateList(registeredFrames, root);
  const captures = new Map<string, SessionCapture | undefined>();
  const rootCapture = await captureSession(deps, root.sessionId, root.frameId);
  captures.set(root.sessionId, rootCapture);
  const rootDocument = rootCapture?.documents.get(root.frameId);
  if (!rootCapture || !rootDocument) {
    return unchanged(
      emptyPageModel(
        deps,
        [
          coverageFor(root, 'omitted', 'session_unavailable'),
          ...omitted,
          ...candidates.map((candidate) =>
            coverageFor(
              candidate.registered,
              'omitted',
              'root_session_unavailable',
            ),
          ),
        ],
        startedAt,
      ),
    );
  }
  const rootSnapshotDocument = snapshotDocumentFor(rootCapture, rootDocument);
  const viewportSize = rootCapture.layoutViewport ?? {
    width: rootSnapshotDocument?.contentWidth ?? 0,
    height: rootSnapshotDocument?.contentHeight ?? 0,
  };
  const viewport = rectangle(0, 0, viewportSize.width, viewportSize.height);
  const rootContext: FrameContext = {
    registered: root,
    depth: 0,
    capture: rootCapture,
    document: rootDocument,
    ...(rootSnapshotDocument === undefined
      ? {}
      : { snapshotDocument: rootSnapshotDocument }),
    translationX: 0,
    translationY: 0,
    scaleX: 1,
    scaleY: 1,
    clip: viewport,
  };
  const contexts = new Map<string, FrameContext>([[root.frameId, rootContext]]);
  const ordered: FrameContext[] = [rootContext];
  const omissions = [...omitted];
  const transformedFrameIds = new Set<string>();

  for (let depth = 1; depth <= MAX_FRAME_DEPTH; depth += 1) {
    ensureNotAborted(deps.signal);
    const atDepth = candidates.filter((candidate) => candidate.depth === depth);
    if (atDepth.length === 0) continue;
    const resolutions = await Promise.all(
      atDepth.map(
        (candidate): Promise<OwnerResolution> =>
          // A frame inside a transformed owner is omitted with it.
          candidate.registered.parentId !== undefined &&
          transformedFrameIds.has(candidate.registered.parentId)
            ? Promise.resolve({ candidate, reason: 'owner_transformed' })
            : resolveOwner(deps, candidate, contexts, viewport),
      ),
    );
    for (const resolution of resolutions) {
      if ('reason' in resolution && resolution.reason === 'owner_transformed') {
        transformedFrameIds.add(resolution.candidate.registered.frameId);
      }
    }
    const sessionsToCapture = new Map<string, string>();
    for (const resolution of resolutions) {
      if ('reason' in resolution) continue;
      const sessionId = resolution.candidate.registered.sessionId;
      if (!captures.has(sessionId) && !sessionsToCapture.has(sessionId)) {
        sessionsToCapture.set(
          sessionId,
          resolution.candidate.registered.frameId,
        );
      }
    }
    await Promise.all(
      Array.from(sessionsToCapture.entries(), async ([sessionId, frameId]) => {
        captures.set(sessionId, await captureSession(deps, sessionId, frameId));
      }),
    );
    for (const resolution of resolutions) {
      const registered = resolution.candidate.registered;
      if ('reason' in resolution) {
        omissions.push(coverageFor(registered, 'omitted', resolution.reason));
        continue;
      }
      const capture = captures.get(registered.sessionId);
      const document = capture?.documents.get(registered.frameId);
      if (!capture || !document) {
        omissions.push(
          coverageFor(
            registered,
            'omitted',
            capture ? 'document_missing' : 'session_unavailable',
          ),
        );
        continue;
      }
      const snapshotDocument = snapshotDocumentFor(capture, document);
      const context: FrameContext = {
        registered,
        depth,
        capture,
        document,
        ...(snapshotDocument === undefined ? {} : { snapshotDocument }),
        translationX: resolution.geometry.content.x,
        translationY: resolution.geometry.content.y,
        scaleX: resolution.geometry.scaleX,
        scaleY: resolution.geometry.scaleY,
        clip: intersectRectangles(
          resolution.geometry.content,
          resolution.parent.clip,
        ),
        owner: resolution.owner,
      };
      contexts.set(registered.frameId, context);
      ordered.push(context);
    }
  }

  const [supplement, history] = await Promise.all([
    readMissingLayoutStyles(deps, ordered),
    collectControlHistory(deps, ordered, root.frameId),
  ]);
  const extractionEndedAt = deps.now();

  const assemblyStartedAt = deps.now();
  const assemblyInput = {
    contexts: ordered,
    rootFrameId: root.frameId,
    history: history.history,
    styles: supplement.styles,
  };
  const assembly = assemblePageModel(assemblyInput);
  const registeredIds = new Set(registeredFrames.map((frame) => frame.frameId));
  const capturedSessions = Array.from(captures.values()).filter(
    (capture): capture is SessionCapture => capture !== undefined,
  );
  const coverage: FrameCoverage[] = [
    ...ordered.map((context) =>
      coverageFor(
        context.registered,
        'included',
        undefined,
        context.snapshotDocument?.documentURL,
      ),
    ),
    ...omissions,
    ...unmatchedCoverage(capturedSessions, registeredIds),
  ];
  const assemblyEndedAt = deps.now();

  let accessibility: PageModelAccessibilityNode[] = [];
  let accessibilityMs = 0;
  if (options.accessibility === true) {
    const accessibilityStartedAt = deps.now();
    accessibility = await collectAccessibility(
      deps,
      assembly.frameFacts,
      assembly.nodes,
    );
    accessibilityMs = elapsed(accessibilityStartedAt, deps.now());
  }
  let listeners: PageModelListenerResult[] = [];
  let listenersMs = 0;
  if (options.listeners === true) {
    const listenersStartedAt = deps.now();
    listeners = await collectListeners(
      deps,
      assembly.frameFacts,
      assembly.nodes,
    );
    listenersMs = elapsed(listenersStartedAt, deps.now());
  }
  const capturedAt = deps.now();
  const model: BrowserPageModel = {
    nodes: assembly.nodes,
    frames: assembly.frames,
    coverage,
    registry: deps.registry,
    capturedAt: new Date(capturedAt).toISOString(),
    page: {
      browserId: '',
      url: safeCoverageURL(rootSnapshotDocument?.documentURL ?? root.url),
      title: rootSnapshotDocument?.title ?? '',
      viewport: {
        width: viewportSize.width,
        height: viewportSize.height,
        deviceScaleFactor: 1,
      },
      themeMode: 'light',
    },
    accessibility,
    listeners,
    styleSupplement: supplement.summary,
    trackerHistory: history.summary,
    timings: {
      extractionMs: elapsed(extractionStartedAt, extractionEndedAt),
      assemblyMs: elapsed(assemblyStartedAt, assemblyEndedAt),
      accessibilityMs,
      listenersMs,
      styleSupplementMs: supplement.durationMs,
      totalMs: elapsed(startedAt, capturedAt),
    },
  };
  return {
    model,
    withheld: (): BrowserPageModel => {
      const withheldStartedAt = deps.now();
      const withheldAssembly = assemblePageModel({
        ...assemblyInput,
        allControlsSecret: true,
      });
      const withheldAt = deps.now();
      // The optional stages are not re-run: their names could carry values.
      return {
        ...model,
        nodes: withheldAssembly.nodes,
        frames: withheldAssembly.frames,
        coverage: [...coverage],
        capturedAt: new Date(withheldAt).toISOString(),
        accessibility: [],
        listeners: [],
        timings: {
          ...model.timings,
          assemblyMs:
            model.timings.assemblyMs + elapsed(withheldStartedAt, withheldAt),
          accessibilityMs: 0,
          listenersMs: 0,
          totalMs: elapsed(startedAt, withheldAt),
        },
      };
    },
  };
}
