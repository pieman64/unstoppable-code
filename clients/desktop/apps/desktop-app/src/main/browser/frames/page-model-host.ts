import { locatorCandidatesFor } from './locator-candidates';
import {
  readDocumentViewport,
  readScrollState,
  writeScrollBy,
  scrollAncestors,
  textMatchRect,
  textMatchShown,
  wheelOwnerMatches,
  readViewportTelemetry,
  type ScrollState,
  type TextMatchRect,
  type ViewportTelemetry,
} from './scroll-state';
import { nodeAtViewportPoint } from './host-cdp';
import { randomUUID } from 'node:crypto';
import {
  INSPECT_RESOLVER_KEY,
  PASSWORD_HISTORY_RESOLVER_KEY,
} from '@canopy/desktop-shared/browser/secret-fields';
import {
  parseLocator,
  UNSUPPORTED_PLAYWRIGHT_LOCATOR_MESSAGE,
} from '@canopy/desktop-shared/browser/locator-grammar';
import {
  BrowserReadTargetError,
  type BrowserReadTargetCode,
} from '@canopy/desktop-shared/browser/read-target-error';
import type {
  BrowserActionTargetState,
  BrowserElementSnapshot,
  BrowserInputSnapshotRequest,
  BrowserInputSnapshotResponse,
  BrowserInspectRequest,
  BrowserLocatorCandidate,
} from '@canopy/execution-engine/types/browser';
import {
  mapToAncestors,
  releaseActionTarget,
  resolveFocusedTarget,
  resolveLocatorTarget,
  resolvePointTarget,
  resolveRefTarget,
  resolvePageTarget,
  resolveTextTarget,
  showsChildDocument,
  type ActionTargetDeps,
  type ActionTargetRequest,
  type ActionTargetResolution,
  type AncestorMapping,
  type ResolvedActionTarget,
} from './action-targets';
import type { DocumentMapping } from '../actions/actionability';
import { documentMapping, outerHitTest } from './frame-hit-test';
import { armInputRecorder, type InputRecorder } from './input-recorder';
import { resolveFrameScope } from './locator-requests';
import {
  describeActionTarget,
  fillActionTarget,
  hostWorldObject,
  isActionTargetSecret as isModelActionTargetSecret,
  type FillOutcome,
} from './target-state';
import {
  probeMatches,
  readTopReadyState,
  type DocumentReadyState,
  type WaitProbeRequest,
} from './wait-probe';
import {
  isCDPRecord,
  readCDPArray,
  readCDPFiniteNumber,
  readCDPInteger,
  readCDPString,
} from './cdp-decode';
import { DomTracking, type DomTrackingState } from './dom-tracking';
import { ExecutionContexts } from './execution-contexts';
import { bounded, HOST_WORLD_NAME, remoteValue } from './host-cdp';
import {
  DETACHED_FRAME_ERROR_PREFIX,
  FrameRegistry,
  type NodeIdentity,
} from './frame-registry';
import {
  buildConsistentModel,
  buildPageModelWithFallback,
  PageModelCache,
  type PageModelBuild,
} from './page-model';
import { evaluateLocator, isStaleLocatorError } from './locators';
import type {
  BrowserPageModel,
  ControlHistory,
  PageModelCacheKey,
  PageModelDeps,
  PageModelFrame,
  PageModelStyleRead,
  TrackerMemory,
  TrackerScope,
} from './model-types';
import {
  MAX_ENRICHMENT_SECRET_CONTROLS,
  projectInputSnapshot,
  projectInspect,
} from './projections';
import { PageTrackers, type TrackerStatus } from './tracker-host';
import { TRACKER_WORLD_NAME } from './trackers';

/** Worlds the host owns; the preload's bridges are never looked up there. */
const HOST_WORLDS = [TRACKER_WORLD_NAME, HOST_WORLD_NAME];

type InspectionEnrichment = Awaited<
  ReturnType<Parameters<typeof projectInspect>[2]['enrich']>
>;
export type PageModelBuildOptions = {
  cache: 'bypass' | 'use';
  accessibility?: boolean;
  listeners?: boolean;
};

/** Host-only adapter between BrowserService's CDP sessions and the model. */
export class PageModelHost {
  public readonly registry = new FrameRegistry();
  private readonly cache: PageModelCache;
  private readonly controller = new AbortController();
  private revision: PageModelCacheKey = {
    domEventRevision: 0,
    navigationSequence: 0,
    actionSequence: 0,
  };
  private readonly contexts = new ExecutionContexts();
  private readonly trackers: PageTrackers;
  private readonly trustedHistoryFrames = new Set<string>();
  private cacheOptions?: string;

  private readonly tracking: DomTracking;

  public constructor(
    private readonly deps: Pick<PageModelDeps, 'send' | 'now'>,
    options: { trackingIdleMs?: number } = {},
  ) {
    this.cache = new PageModelCache(deps.now);
    this.trackers = new PageTrackers(
      {
        send: deps.send,
        // The top document's main-world tracker is the preload's (E4).
        isTopDocument: (frameId, sessionId): boolean => {
          const frame = this.registry.getFrame(frameId);
          return (
            sessionId === '' &&
            frame?.sessionId === '' &&
            frame.parentId === undefined
          );
        },
        preloadContexts: (frameId, sessionId): number[] =>
          this.contextIds(frameId, sessionId),
      },
      this.contexts,
    );
    this.tracking = new DomTracking({
      send: deps.send,
      sessions: (): string[] => this.sessions(),
      onReleased: (): void => {
        // Frontend node ids die with releases and establishment re-pushes.
        this.revision.domEventRevision += 1;
        this.invalidate();
      },
      ...(options.trackingIdleMs === undefined
        ? {}
        : { idleMs: options.trackingIdleMs }),
    });
  }

  /** The root session and every attached child session. */
  private sessions(): string[] {
    return Array.from(
      new Set(['', ...this.registry.frames().map((frame) => frame.sessionId)]),
    );
  }

  /** Whether any session may be streaming DOM events (D11), not establishment. */
  public get trackingState(): DomTrackingState {
    return this.tracking.state;
  }

  public get trackingIdleMs(): number {
    return this.tracking.idleMs;
  }

  /**
   * Marks agent activity (an action) so tracking is not released while it
   * runs; call the returned function when it ends.
   */
  public beginActivity(): () => void {
    return this.tracking.begin();
  }

  /** Makes DOM events flow before an action's effect baseline (D11). */
  public establishTracking(): Promise<void> {
    return this.tracking.establish();
  }

  /**
   * Runs a target API as an activity, after any release in progress
   * (review R2 question 6): its commands never overlap the DOM domain's
   * disable and re-enable, and no release starts while it runs.
   */
  private async whenSettled<T>(work: () => Promise<T>): Promise<T> {
    const end = this.tracking.begin();
    try {
      const releasing = this.tracking.pending();
      if (releasing) await releasing;
      return await work();
    } finally {
      end();
    }
  }

  /**
   * Registers the document-start trackers on a session. Call when a session
   * attaches and after every `Page.enable` on it: `Page.disable` drops
   * registered scripts. Documents created before it stay unknown (D4).
   */
  public installTrackers(sessionId: string): Promise<boolean> {
    return this.trackers.install(sessionId);
  }

  /** Whether the frame's current document is confirmed to be tracked. */
  public trackerStatus(frameId: string, sessionId: string): TrackerStatus {
    return this.trackers.status(frameId, sessionId);
  }

  /** The host's own resolver key (child documents; diagnostics). */
  public get trackerKey(): string {
    return this.trackers.key;
  }

  /** Whether a tracker of a frame remembers any password (diagnostics). */
  public trackerSummary(
    frameId: string,
    sessionId: string,
    scope: TrackerScope,
  ): Promise<TrackerMemory> {
    return this.trackers.summary(frameId, sessionId, scope);
  }

  /** Tracker answers for one frame, or undefined on a failed ask (diagnostics). */
  public trackerHistory(
    frameId: string,
    sessionId: string,
    scope: TrackerScope,
    backendNodeIds: number[],
  ): Promise<ControlHistory[] | undefined> {
    return this.trackers.history(frameId, sessionId, scope, backendNodeIds);
  }

  public get key(): PageModelCacheKey {
    return { ...this.revision };
  }

  private invalidate(): void {
    this.cache.invalidate();
    this.cacheOptions = undefined;
  }

  public actionBoundary(): void {
    this.revision.actionSequence += 1;
    this.invalidate();
  }

  public detachSession(sessionId: string): void {
    this.tracking.stopStreaming(sessionId);
    this.registry.noteSessionDetached(sessionId);
    this.contexts.sessionDetached(sessionId);
    this.trackers.forgetSession(sessionId);
    this.trustedHistoryFrames.clear();
    this.invalidate();
  }

  public dispose(): void {
    this.tracking.dispose();
    this.controller.abort();
    this.invalidate();
    for (const frame of this.registry.frames())
      this.registry.noteFrameDetached(frame.frameId);
    this.contexts.clear();
    for (const frame of this.registry.frames())
      this.trackers.forgetSession(frame.sessionId);
    this.trustedHistoryFrames.clear();
  }

  /**
   * Whether the top-level frame's committed document is known. Same-process
   * child frames share the root session, so their presence proves nothing.
   */
  public hasNavigatedRoot(): boolean {
    return this.registry
      .frames()
      .some(
        (frame) =>
          frame.sessionId === '' &&
          frame.parentId === undefined &&
          frame.loaderId.length > 0,
      );
  }

  /** The frame of a session's execution context, while that context lives. */
  public contextFrame(
    sessionId: string,
    contextId: number,
  ): string | undefined {
    return this.contexts.get(sessionId, contextId)?.frameId;
  }

  /** Called before BrowserService's child-session early return, even for root ''. */
  public noteEvent(method: string, params: unknown, sessionId = ''): void {
    // The cache compares this revision when a build completes, so a DOM
    // event needs no invalidation of its own.
    if (method.startsWith('DOM.')) this.revision.domEventRevision += 1;
    if (method === 'DOM.documentUpdated')
      this.tracking.stopStreaming(sessionId);
    else if (method === 'Page.frameNavigated')
      this.tracking.invalidateSession(sessionId);
    if (!isCDPRecord(params)) return;
    if (method.startsWith('Runtime.executionContext')) {
      this.contexts.noteEvent(method, params, sessionId);
    } else if (
      method === 'Target.attachedToTarget' ||
      method === 'Target.targetInfoChanged'
    ) {
      const info = params.targetInfo;
      if (!isCDPRecord(info)) return;
      const targetId = readCDPString(info.targetId);
      const type = readCDPString(info.type);
      if (!targetId || type !== 'iframe') return;
      const target = { targetId, type, url: readCDPString(info.url) };
      if (method === 'Target.attachedToTarget') {
        const child = readCDPString(params.sessionId);
        if (child) this.registry.noteAttached(child, target);
      } else this.registry.noteTargetInfoChanged(target);
      this.invalidate();
    } else if (method === 'Target.detachedFromTarget') {
      const child = readCDPString(params.sessionId);
      if (child) this.detachSession(child);
    } else if (method === 'Page.frameDetached') {
      const frameId = readCDPString(params.frameId);
      if (frameId) {
        this.registry.noteFrameDetached(frameId);
        this.contexts.frameDetached(frameId);
        this.trackers.noteFrameNavigated(frameId);
      }
      this.invalidate();
    } else if (method === 'Page.frameNavigated' && isCDPRecord(params.frame)) {
      const frame = params.frame;
      const id = readCDPString(frame.id);
      const loaderId = readCDPString(frame.loaderId);
      const url = readCDPString(frame.url);
      if (!id || loaderId === undefined || url === undefined) return;
      this.trustedHistoryFrames.delete(id);
      this.trackers.noteFrameNavigated(id);
      this.registry.noteFrameNavigated(sessionId, {
        id,
        loaderId,
        url,
        parentId: readCDPString(frame.parentId),
      });
      this.revision.navigationSequence += 1;
      this.invalidate();
    }
  }

  /** Fill the Page.enable initial-commit gap without inventing frame identity. */
  public async discoverFrames(sessionId = ''): Promise<void> {
    const response = await bounded(
      this.deps.send('Page.getFrameTree', {}, sessionId),
      2000,
    );
    if (!isCDPRecord(response) || !isCDPRecord(response.frameTree)) return;
    const queue: unknown[] = [response.frameTree];
    for (let index = 0; index < queue.length && index < 1000; index += 1) {
      const tree = queue[index];
      if (!isCDPRecord(tree) || !isCDPRecord(tree.frame)) continue;
      const id = readCDPString(tree.frame.id);
      const previous = this.registry
        .frames()
        .find((frame) => frame.frameId === id);
      if (!previous || previous.loaderId !== tree.frame.loaderId) {
        this.noteEvent(
          'Page.frameNavigated',
          { frame: tree.frame },
          previous?.sessionId ?? sessionId,
        );
      }
      const children = readCDPArray(tree.childFrames);
      if (children)
        queue.push(...children.slice(0, Math.max(0, 1001 - queue.length)));
    }
  }

  /** Isolated worlds that can hold the preload's bridges. */
  private contextIds(frameId: string, sessionId: string): number[] {
    return this.contexts.isolated(frameId, sessionId, HOST_WORLDS);
  }

  /** The frame's main-world context in its session; the newest if several. */
  public mainWorldContextId(
    frameId: string,
    sessionId: string,
  ): number | undefined {
    return this.contexts.mainWorld(frameId, sessionId);
  }

  private release(group: string, sessions: Set<string>): void {
    for (const sessionId of Array.from(sessions)) {
      void this.deps
        .send('Runtime.releaseObjectGroup', { objectGroup: group }, sessionId)
        .catch(() => undefined);
    }
  }

  public async isPasswordEverSeen(
    frameId: string,
    sessionId: string,
    backendNodeIds: number[],
    purpose: 'scope' | 'remembered' = 'scope',
  ): Promise<boolean[]> {
    const group = `canopy-page-model-${randomUUID()}`;
    const sessions = new Set([sessionId]);
    try {
      return await this.passwordHistory(
        frameId,
        sessionId,
        backendNodeIds,
        group,
        sessions,
        purpose,
      );
    } finally {
      this.release(group, sessions);
    }
  }

  /** Whether the preload's history answered for the frame's last build. */
  public historyTrusted(frameId: string): boolean {
    return this.trustedHistoryFrames.has(frameId);
  }

  /**
   * The preload's password history. Only an ask about its own scope
   * decides inspect trust; a `remembered` ask (inputs now in shadow roots)
   * leaves it as it is.
   */
  private async passwordHistory(
    frameId: string,
    sessionId: string,
    ids: number[],
    group: string,
    sessions: Set<string>,
    purpose: 'scope' | 'remembered' = 'scope',
  ): Promise<boolean[]> {
    const decidesTrust = purpose === 'scope';
    if (decidesTrust) this.trustedHistoryFrames.delete(frameId);
    const secret = ids.map(() => true);
    if (ids.length === 0) return [];
    sessions.add(sessionId);
    // The deadline covers context selection, all resolveNode calls and the bridge.
    // Late CDP resolutions trigger another release so timeout cannot leak handles.
    let expired = false;
    const operation = (async (): Promise<boolean[]> => {
      for (const contextId of this.contextIds(frameId, sessionId)) {
        try {
          const result: boolean[] = [];
          for (let offset = 0; offset < ids.length; offset += 200) {
            const batch = ids.slice(offset, offset + 200);
            const objects = await Promise.all(
              batch.map(async (backendNodeId): Promise<string> => {
                const value = await this.deps.send(
                  'DOM.resolveNode',
                  {
                    backendNodeId,
                    executionContextId: contextId,
                    objectGroup: group,
                  },
                  sessionId,
                );
                const objectId =
                  isCDPRecord(value) && isCDPRecord(value.object)
                    ? readCDPString(value.object.objectId)
                    : undefined;
                if (!objectId)
                  throw new Error('Unresolved page model element.');
                return objectId;
              }),
            );
            const response = await this.deps.send(
              'Runtime.callFunctionOn',
              {
                executionContextId: contextId,
                functionDeclaration: `function(...elements) { const resolve = Reflect.get(globalThis, ${JSON.stringify(PASSWORD_HISTORY_RESOLVER_KEY)}); return typeof resolve === 'function' ? Reflect.apply(resolve, undefined, elements) : undefined; }`,
                arguments: objects.map((objectId) => ({ objectId })),
                returnByValue: true,
                objectGroup: group,
              },
              sessionId,
            );
            const flags = remoteValue(response);
            if (
              !Array.isArray(flags) ||
              flags.length !== batch.length ||
              !flags.every((flag: unknown) => typeof flag === 'boolean')
            )
              throw new Error('Password history unavailable.');
            for (const flag of flags) result.push(flag === true);
          }
          if (!expired && decidesTrust) this.trustedHistoryFrames.add(frameId);
          return result;
        } catch {
          /* Only the preload world owns the private resolver. */
        }
      }
      return secret;
    })();
    try {
      return await bounded(operation, 2000);
    } catch {
      expired = true;
      if (decidesTrust) this.trustedHistoryFrames.delete(frameId);
      void operation
        .finally(() => this.release(group, sessions))
        .catch(() => undefined);
      return secret;
    }
  }

  /**
   * The preload's inspection of the exact element. `secretControls` are the
   * controls the model classified as secret in its subtree; the bridge keeps
   * them redacted. If any of them cannot be resolved in the target's
   * context, there is no enrichment.
   */
  public async enrich(
    identity: NodeIdentity,
    secretControls: NodeIdentity[] = [],
  ): Promise<InspectionEnrichment> {
    if (
      secretControls.length > MAX_ENRICHMENT_SECRET_CONTROLS ||
      secretControls.some(
        (control) =>
          control.frameId !== identity.frameId ||
          control.sessionId !== identity.sessionId ||
          control.loaderId !== identity.loaderId,
      )
    ) {
      return null;
    }
    const group = `canopy-inspect-${randomUUID()}`;
    const sessions = new Set([identity.sessionId]);
    const resolve = async (
      backendNodeId: number,
      executionContextId: number,
    ): Promise<string | undefined> => {
      const resolved = await this.deps.send(
        'DOM.resolveNode',
        { backendNodeId, executionContextId, objectGroup: group },
        identity.sessionId,
      );
      return isCDPRecord(resolved) && isCDPRecord(resolved.object)
        ? readCDPString(resolved.object.objectId)
        : undefined;
    };
    const operation = (async (): Promise<InspectionEnrichment> => {
      for (const executionContextId of this.contextIds(
        identity.frameId,
        identity.sessionId,
      )) {
        try {
          const objectId = await resolve(
            identity.backendNodeId,
            executionContextId,
          );
          if (!objectId) continue;
          const secretHandles: string[] = [];
          for (const control of secretControls) {
            const handle = await resolve(
              control.backendNodeId,
              executionContextId,
            );
            // A secret control without a handle could reach the markup.
            if (!handle) throw new Error('Unresolved secret control.');
            secretHandles.push(handle);
          }
          const response = await this.deps.send(
            'Runtime.callFunctionOn',
            {
              objectId,
              functionDeclaration: `function(...secrets) { const resolve = Reflect.get(globalThis, ${JSON.stringify(INSPECT_RESOLVER_KEY)}); return typeof resolve === 'function' ? Reflect.apply(resolve, undefined, [this, ...secrets]) : null; }`,
              arguments: secretHandles.map((handle) => ({ objectId: handle })),
              returnByValue: true,
              objectGroup: group,
            },
            identity.sessionId,
          );
          const value = decodeEnrichment(remoteValue(response));
          if (value) return value;
        } catch {
          /* Redaction-safe host description is always available. */
        }
      }
      return null;
    })();
    try {
      return await bounded(operation, 2000);
    } catch {
      void operation
        .finally(() => this.release(group, sessions))
        .catch(() => undefined);
      return null;
    } finally {
      this.release(group, sessions);
    }
  }

  public async assertLive(identity: NodeIdentity): Promise<void> {
    try {
      const response = await bounded(
        this.deps.send(
          'DOM.describeNode',
          { backendNodeId: identity.backendNodeId },
          identity.sessionId,
        ),
        2000,
      );
      if (
        !isCDPRecord(response) ||
        !isCDPRecord(response.node) ||
        response.node.backendNodeId !== identity.backendNodeId
      )
        throw new Error('Missing node.');
    } catch {
      throw readFailure('target_stale');
    }
  }

  /**
   * Reads computed `display`/`visibility` for elements without a layout box:
   * one `Runtime.callFunctionOn` per at most 200 elements in an isolated
   * world of that frame (the preload's, else a page-model world created for
   * the frame). Resolves undefined when no isolated context works.
   */
  public async readStyles(
    frameId: string,
    sessionId: string,
    backendNodeIds: number[],
    group: string,
    sessions: Set<string>,
  ): Promise<Array<PageModelStyleRead | undefined> | undefined> {
    sessions.add(sessionId);
    // Any isolated world can read styles; the tracker's exists in every
    // frame it ran in, which saves creating one.
    let contextIds = this.contexts.isolated(frameId, sessionId);
    if (contextIds.length === 0) {
      const created = await this.deps
        .send(
          'Page.createIsolatedWorld',
          { frameId, worldName: HOST_WORLD_NAME },
          sessionId,
        )
        .catch(() => undefined);
      const contextId = isCDPRecord(created)
        ? readCDPInteger(created.executionContextId)
        : undefined;
      if (contextId === undefined) return undefined;
      contextIds = [contextId];
    }
    for (const executionContextId of contextIds) {
      try {
        const results: Array<PageModelStyleRead | undefined> = [];
        for (let offset = 0; offset < backendNodeIds.length; offset += 200) {
          const batch = backendNodeIds.slice(offset, offset + 200);
          const objects = await Promise.all(
            batch.map(async (backendNodeId): Promise<string | undefined> => {
              const value = await this.deps
                .send(
                  'DOM.resolveNode',
                  { backendNodeId, executionContextId, objectGroup: group },
                  sessionId,
                )
                .catch(() => undefined);
              return isCDPRecord(value) && isCDPRecord(value.object)
                ? readCDPString(value.object.objectId)
                : undefined;
            }),
          );
          const resolved = objects.filter(
            (objectId): objectId is string => objectId !== undefined,
          );
          const response =
            resolved.length === 0
              ? undefined
              : await this.deps.send(
                  'Runtime.callFunctionOn',
                  {
                    executionContextId,
                    functionDeclaration: `function(...elements) { return elements.map((element) => { if (!(element instanceof Element)) return null; const style = getComputedStyle(element); return [style.display, style.visibility]; }); }`,
                    arguments: resolved.map((objectId) => ({ objectId })),
                    returnByValue: true,
                    objectGroup: group,
                  },
                  sessionId,
                );
          const values = resolved.length === 0 ? [] : remoteValue(response);
          if (!Array.isArray(values) || values.length !== resolved.length) {
            throw new Error('Style read unavailable.');
          }
          let next = 0;
          for (const objectId of objects) {
            if (objectId === undefined) {
              results.push(undefined);
              continue;
            }
            results.push(decodeStylePair(values[next]));
            next += 1;
          }
        }
        return results;
      } catch {
        /* Try the frame's next isolated context. */
      }
    }
    return undefined;
  }

  private modelDeps(group: string, sessions: Set<string>): PageModelDeps {
    return {
      ...this.deps,
      // Capture attempts can start mutation reporting even if snapshots fail.
      // Mark before sending: success and model membership prove neither fact.
      send: (method, params, sessionId = ''): Promise<unknown> => {
        if (method === 'DOM.getDocument' && params.pierce === true)
          this.tracking.noteStreaming(sessionId);
        return this.deps.send(method, params, sessionId);
      },
      registry: this.registry,
      signal: this.controller.signal,
      isPasswordEverSeen: (frameId, sessionId, ids, purpose) =>
        this.passwordHistory(frameId, sessionId, ids, group, sessions, purpose),
      readStyles: (frameId, sessionId, ids) =>
        this.readStyles(frameId, sessionId, ids, group, sessions),
      mainWorldContextId: (frameId, sessionId) =>
        this.mainWorldContextId(frameId, sessionId),
      controlHistorySummary: (frameId, sessionId, scope) =>
        this.trackers.summary(frameId, sessionId, scope),
      controlHistory: (frameId, sessionId, scope, ids) =>
        this.trackers.history(frameId, sessionId, scope, ids),
    };
  }

  public async build(
    options: PageModelBuildOptions = { cache: 'use' },
  ): Promise<{ model: BrowserPageModel; cached: boolean; durationMs: number }> {
    const started = this.deps.now();
    const optionKey = JSON.stringify([
      options.accessibility === true,
      options.listeners === true,
    ]);
    if (options.cache === 'use') {
      if (this.cacheOptions !== undefined && this.cacheOptions !== optionKey)
        this.invalidate();
      this.cacheOptions = optionKey;
    }
    this.controller.signal.throwIfAborted();
    const endActivity = this.tracking.begin();
    try {
      const releasing = this.tracking.pending();
      if (releasing) await releasing;
      return await this.buildNow(options, started);
    } finally {
      endActivity();
    }
  }

  private async buildNow(
    options: PageModelBuildOptions,
    started: number,
  ): Promise<{ model: BrowserPageModel; cached: boolean; durationMs: number }> {
    const cached = options.cache === 'use' && this.cache.hasFresh(this.key);
    const build = async (): Promise<PageModelBuild> => {
      const markCaptured = this.tracking.capture();
      const group = `canopy-page-model-${randomUUID()}`;
      const sessions = new Set<string>();
      try {
        const result = await buildPageModelWithFallback(
          this.modelDeps(group, sessions),
          options,
        );
        markCaptured(
          new Set(result.model.frames.map((frame) => frame.sessionId)),
        );
        return result;
      } finally {
        this.release(group, sessions);
      }
    };
    const model =
      options.cache === 'use'
        ? await this.cache.getOrBuild(() => this.key, build)
        : (await buildConsistentModel(() => this.key, build)).model;
    this.controller.signal.throwIfAborted();
    return { model, cached, durationMs: this.deps.now() - started };
  }

  /**
   * Rebuilds once when a model went stale between build and use. The stale
   * model is dropped from the cache and its replacement is cached, so later
   * calls do not hit the same stale model.
   */
  private async withFreshModel<T>(
    use: (model: BrowserPageModel) => Promise<T>,
  ): Promise<T> {
    const { model } = await this.build();
    try {
      return await use(model);
    } catch (error) {
      if (!isStaleLocatorError(error) && !isDetachedFrameError(error)) {
        throw error;
      }
      this.invalidate();
      const rebuilt = await this.build();
      return use(rebuilt.model);
    }
  }

  private get targetDeps(): ActionTargetDeps {
    return {
      send: this.deps.send,
      registry: this.registry,
      contexts: this.contexts,
    };
  }

  /**
   * Resolves an action target once, before actionability (D7): to its
   * identity and a retained main-world object in its own session. Locators
   * run on the model (rebuilt once if its node ids went stale); refs,
   * coordinates and the focused element need no model. The caller releases
   * a found target with `releaseActionTarget`.
   */
  public resolveActionTarget(
    request: ActionTargetRequest,
  ): Promise<ActionTargetResolution> {
    const deps = this.targetDeps;
    return this.whenSettled(() => {
      switch (request.kind) {
        case 'ref':
          return resolveRefTarget(deps, request.ref);
        case 'point':
          return resolvePointTarget(deps, request.x, request.y);
        case 'page':
          return resolvePageTarget(deps);
        case 'text':
          return this.withFreshModel((model) =>
            resolveTextTarget(deps, model, request.text, request.frame),
          );
        case 'focused':
          return resolveFocusedTarget(deps);
        case 'locator':
          return this.withFreshModel((model) =>
            resolveLocatorTarget(deps, model, request.locator, request.frame),
          );
      }
    });
  }

  /** Resolves a retained action target in its frame's isolated host world. */
  public hostActionTarget(
    target: ResolvedActionTarget,
  ): Promise<ResolvedActionTarget | undefined> {
    return this.whenSettled(async () => {
      const objectId = await hostWorldObject(
        this.targetDeps,
        target.identity,
        target.objectGroup,
      );
      return objectId === undefined ? undefined : { ...target, objectId };
    });
  }

  /**
   * Reads only the cached/model secrecy markers, never a live page value.
   * Unknown targets fail closed so post-action readback is redacted.
   */
  public async isActionTargetSecret(
    target: ResolvedActionTarget,
  ): Promise<boolean> {
    const { model } = await this.build();
    return isModelActionTargetSecret(model, target);
  }

  /** Safe executable locator, including a proven iframe chain; closed roots are not replayable. */
  public async recordingLocator(
    target: ResolvedActionTarget,
  ): Promise<string | undefined> {
    const { model } = await this.build();
    const node = model.nodes.find(
      (node) =>
        node.identity.sessionId === target.identity.sessionId &&
        node.identity.frameId === target.identity.frameId &&
        node.identity.loaderId === target.identity.loaderId &&
        node.identity.backendNodeId === target.identity.backendNodeId,
    );
    if (!node || node.shadowRootType === 'closed') return undefined;
    return locatorCandidatesFor(model, node, { first: true })[0]?.playwright;
  }

  /**
   * Top-left of the bounds of the element's border box, in top-level
   * coordinates: where Playwright's `boundingBox()` puts the element.
   */
  public async boxOrigin(
    target: ResolvedActionTarget,
  ): Promise<{ x: number; y: number } | undefined> {
    const response = await this.deps.send(
      'DOM.getBoxModel',
      { backendNodeId: target.identity.backendNodeId },
      target.identity.sessionId,
    );
    const model = isCDPRecord(response) ? response.model : undefined;
    const border = isCDPRecord(model) ? readCDPArray(model.border) : undefined;
    if (border?.length !== 8) return undefined;
    const xs: number[] = [];
    const ys: number[] = [];
    for (let index = 0; index < border.length; index += 1) {
      const number = readCDPFiniteNumber(border[index]);
      if (number === undefined) return undefined;
      (index % 2 === 0 ? xs : ys).push(number);
    }
    return this.topPoint(target, { x: Math.min(...xs), y: Math.min(...ys) });
  }

  public readViewportTelemetry(): Promise<ViewportTelemetry | undefined> {
    return readViewportTelemetry(this.targetDeps);
  }

  public readDocumentViewport(
    target: ResolvedActionTarget,
  ): Promise<{ width: number; height: number } | undefined> {
    return readDocumentViewport(this.targetDeps, target);
  }

  public readScrollState(target: ResolvedActionTarget): Promise<ScrollState> {
    return readScrollState(this.targetDeps, target);
  }

  public scrollAncestors(
    target: ResolvedActionTarget,
    registerSessionGroup?: (sessionId: string) => void,
  ): Promise<ResolvedActionTarget[]> {
    return scrollAncestors(this.targetDeps, target, 0, registerSessionGroup);
  }

  public scrollBy(
    target: ResolvedActionTarget,
    dx: number,
    dy: number,
    send: ActionTargetDeps['send'],
    beforeWrite: () => void,
  ): Promise<void> {
    return writeScrollBy(
      { ...this.targetDeps, send },
      target,
      dx,
      dy,
      beforeWrite,
    );
  }

  /** Where the matched words are inside their text node; see textMatchRect. */
  public textMatchRect(
    target: ResolvedActionTarget,
    text: string,
  ): Promise<TextMatchRect | undefined> {
    return textMatchRect(this.targetDeps, target, text);
  }

  /** Whether the matched words are in view now; see textMatchShown. */
  public textMatchShown(
    target: ResolvedActionTarget,
    text: string,
  ): Promise<boolean | undefined> {
    return textMatchShown(this.targetDeps, target, text);
  }

  public async wheelPoint(
    target: ResolvedActionTarget,
    point: { x: number; y: number },
    axis: 'x' | 'y',
  ): Promise<{ x: number; y: number } | undefined> {
    if (!(await this.outerHitTest(target, point)).receivesEvents)
      return undefined;
    const hit = await nodeAtViewportPoint(
      this.deps.send,
      target.identity.sessionId,
      point,
    );
    if (!hit || hit.frameId !== target.identity.frameId) return undefined;
    // A cross-site frame is its owner element here, inside the container:
    // the owner walk would pass, and Chromium would wheel the frame.
    if (
      await showsChildDocument(
        this.targetDeps,
        target.identity.sessionId,
        hit.backendNodeId,
        target.identity.frameId,
      )
    )
      return undefined;
    return (await wheelOwnerMatches(
      this.targetDeps,
      target,
      hit.backendNodeId,
      axis,
    ))
      ? point
      : undefined;
  }

  /** Fresh affine transform above OOPIF boundaries; same-session points stay unchanged. */
  public async topPoint(
    target: Pick<ResolvedActionTarget, 'identity'>,
    point: { x: number; y: number },
  ): Promise<{ x: number; y: number } | undefined> {
    const mapped = await this.mapToAncestors(target, point);
    if (mapped.status !== 'mapped') return undefined;
    return mapped.hops[mapped.hops.length - 1]?.point ?? point;
  }

  public async sessionPoint(
    target: Pick<ResolvedActionTarget, 'identity'>,
    point: { x: number; y: number },
  ): Promise<{ x: number; y: number } | undefined> {
    const origin = await this.topPoint(target, { x: 0, y: 0 });
    const unit = await this.topPoint(target, { x: 1, y: 1 });
    if (!origin || !unit || unit.x === origin.x || unit.y === origin.y)
      return undefined;
    return {
      x: (point.x - origin.x) / (unit.x - origin.x),
      y: (point.y - origin.y) / (unit.y - origin.y),
    };
  }

  public releaseActionTarget(target: ResolvedActionTarget): Promise<void> {
    return this.whenSettled(() => releaseActionTarget(this.targetDeps, target));
  }

  /**
   * The target's `BrowserActionTargetState`, read from its retained node
   * after the action; names and refs come from the current model (cached
   * or rebuilt). Undefined when the node left its document.
   */
  public describeActionTarget(
    target: ResolvedActionTarget,
    options: { secret?: boolean } = {},
  ): Promise<BrowserActionTargetState | undefined> {
    return this.whenSettled(async () => {
      const { model } = await this.build();
      return describeActionTarget(this.targetDeps, model, target, options);
    });
  }

  public fillActionTarget(
    target: ResolvedActionTarget,
    text: string,
    signal?: AbortSignal,
    send?: ActionTargetDeps['send'],
  ): Promise<FillOutcome> {
    return this.whenSettled(() =>
      fillActionTarget(
        { ...this.targetDeps, ...(send === undefined ? {} : { send }) },
        target,
        text,
        signal,
      ),
    );
  }

  /** The target-session point in each ancestor session above it (D9). */
  public mapToAncestors(
    target: Pick<ResolvedActionTarget, 'identity'>,
    point: { x: number; y: number },
  ): Promise<AncestorMapping> {
    return this.whenSettled(() =>
      mapToAncestors(this.targetDeps, target.identity, point),
    );
  }

  /**
   * How the target's document maps to its session's coordinates: identity
   * at a session top, the owner's content box for a same-process frame;
   * undefined when the frame is gone or its owner unreadable or transformed.
   */
  public documentMapping(
    target: Pick<ResolvedActionTarget, 'identity'>,
  ): Promise<DocumentMapping | undefined> {
    return this.whenSettled(() =>
      documentMapping(this.targetDeps, target.identity),
    );
  }

  /**
   * Whether the target's frame still shows the document the target was
   * resolved in (same session, frame and loader). Input by coordinates or
   * keys goes to whatever document the frame shows, so actions check this
   * before arming, after, and before every input event (review R2).
   */
  public isTargetDocumentCurrent(
    target: Pick<ResolvedActionTarget, 'identity'>,
  ): boolean {
    const frame = this.registry.getFrame(target.identity.frameId);
    return (
      frame !== undefined &&
      frame.sessionId === target.identity.sessionId &&
      frame.loaderId === target.identity.loaderId
    );
  }

  /**
   * Records trusted input in the target's document (its host world), for
   * delivery confirmation of targets the main frame's preload cannot see.
   */
  public armInputRecorder(
    target: Pick<ResolvedActionTarget, 'identity'>,
  ): Promise<InputRecorder | undefined> {
    return this.whenSettled(() =>
      armInputRecorder(this.targetDeps, target.identity),
    );
  }

  /** The D9 hit test in every document above the target's own. */
  public outerHitTest(
    target: Pick<ResolvedActionTarget, 'identity'>,
    point: { x: number; y: number },
  ): Promise<{ receivesEvents: boolean; cover?: string }> {
    return this.whenSettled(() =>
      outerHitTest(this.targetDeps, target.identity, point),
    );
  }

  /**
   * The deleted preload `wait-for-probe`, on the model: matches and visible
   * matches of a locator or text in every frame, and the top document's
   * `readyState`. Without a locator or text it reads only `readyState`, so
   * load-state waits build no model. Invalid or unsupported locators throw
   * an error whose message names them.
   */
  public waitProbe(request: WaitProbeRequest): Promise<{
    matchCount: number;
    visibleCount: number;
    readyState: DocumentReadyState;
  }> {
    const deps = this.targetDeps;
    return this.whenSettled(async () => {
      const counts =
        request.locator === undefined && request.text === undefined
          ? { matchCount: 0, visibleCount: 0 }
          : await this.withFreshModel((model) =>
              probeMatches(deps, model, request),
            );
      return { ...counts, readyState: await readTopReadyState(deps) };
    });
  }

  /** The frames a `frame` field selects, or a `frame_unavailable` error. */
  private async frameScope(
    model: BrowserPageModel,
    frame: string | undefined,
  ): Promise<PageModelFrame[] | undefined> {
    if (frame === undefined) return undefined;
    const frames = await resolveFrameScope(model, this.deps, frame);
    if (!frames) throw readFailure('frame_unavailable');
    return frames;
  }

  /**
   * `input_snapshot` on the model; `frame` keeps only that frame's rows and
   * rejects with a `frame_unavailable` read failure when it selects none.
   */
  public async snapshot(
    request: BrowserInputSnapshotRequest,
    page: () => Promise<BrowserPageModel['page']>,
    options: { frame?: string } = {},
  ): Promise<BrowserInputSnapshotResponse> {
    return typedRead(() =>
      this.withFreshModel(async (model) => {
        const frames = await this.frameScope(model, options.frame);
        model.page = await page();
        const root = model.frames.find(
          (frame) => frame.parentFrameId === undefined,
        );
        const telemetry = await this.readViewportTelemetry();
        model.page.telemetry =
          root &&
          this.registry.getFrame(root.frameId)?.loaderId === root.loaderId
            ? telemetry
            : undefined;
        return projectInputSnapshot(model, request, model.page, {
          ...(frames === undefined ? {} : { frames }),
        });
      }),
    );
  }

  /** `inspect` on the model; `frame` narrows a locator as in actions. */
  public async inspect(
    request: BrowserInspectRequest,
    page: () => Promise<BrowserPageModel['page']>,
    options: { frame?: string } = {},
  ): Promise<BrowserElementSnapshot> {
    return typedRead(() =>
      this.withFreshModel((model) =>
        this.inspectModel(model, request, page, options.frame),
      ),
    );
  }

  /**
   * The element at a top-level point (as for a coordinate action), through
   * same-process frames, shadow roots and out-of-process frames. Only its
   * identity is kept; the object resolution retained is released.
   */
  private async identityAtPoint(
    x: number,
    y: number,
  ): Promise<NodeIdentity | undefined> {
    const resolution = await resolvePointTarget(this.targetDeps, x, y);
    switch (resolution.status) {
      case 'found':
        break;
      case 'target_not_found':
        return undefined;
      case 'frame_unavailable':
        throw readFailure('frame_unavailable', POINT_FRAME_UNAVAILABLE_MESSAGE);
      case 'invalid_locator':
        throw readFailure('invalid_locator', resolution.message);
      case 'target_stale':
        throw readFailure('target_stale');
      case 'target_ambiguous':
        // A point names one element; kept for the union's sake.
        throw new BrowserReadTargetError(
          'target_ambiguous',
          resolution.message,
        );
    }
    await releaseActionTarget(this.targetDeps, resolution.target);
    return resolution.target.identity;
  }

  private async inspectModel(
    model: BrowserPageModel,
    request: BrowserInspectRequest,
    page: () => Promise<BrowserPageModel['page']>,
    frame?: string,
  ): Promise<BrowserElementSnapshot> {
    const frames = await this.frameScope(model, frame);
    model.page = await page();
    let identity: NodeIdentity | undefined;
    if (request.ref) {
      identity = this.registry.resolveRef(request.ref);
      if (!identity) throw readFailure('target_stale');
    } else if (request.locator) {
      const parsed = parseLocator(request.locator);
      if (parsed.kind === 'invalid')
        throw readFailure('invalid_locator', parsed.message);
      const matches = await evaluateLocator(
        model,
        this.deps,
        parsed,
        frames === undefined ? undefined : { frames },
        { purpose: 'inspect' },
      );
      if (matches.length > 1) {
        const refs = Array.from(
          new Set(
            matches.map(
              (match) =>
                this.registry.getFrame(match.frameId)?.frameRef ?? 'detached',
            ),
          ),
        );
        throw new BrowserReadTargetError(
          'target_ambiguous',
          `The locator matches ${matches.length} elements, in frame${refs.length === 1 ? '' : 's'} ${refs.join(', ')}. Add frame, use a more specific locator, or use a reference from browser.input_snapshot.`,
        );
      }
      identity = matches[0];
    } else if (typeof request.x === 'number' && typeof request.y === 'number') {
      identity = await this.identityAtPoint(request.x, request.y);
    }
    if (!identity) throw readFailure('target_not_found');
    await this.assertLive(identity);
    const inspected = await projectInspect(model, identity, {
      // The isolated bridge is redaction-safe when password history is known.
      // Missing/timeout history must not reintroduce values via enriched markup.
      allowSensitiveEnrichment: this.trustedHistoryFrames.has(identity.frameId),
      enrich: (target, secretControls) => this.enrich(target, secretControls),
    });
    if (!inspected) throw readFailure('target_stale');
    return inspected;
  }
}

/** Agent-facing messages of read failures (docs/ux-writing.md). */
const READ_FAILURE_MESSAGES: Record<
  Exclude<BrowserReadTargetCode, 'target_ambiguous' | 'invalid_locator'>,
  string
> = {
  frame_unavailable:
    "No frame matches the frame field. Run browser.input_snapshot without frame to list the page's frames.",
  target_stale:
    'That reference is no longer on the page. Run browser.input_snapshot for current references.',
  target_not_found:
    'No element matches the target. Run browser.input_snapshot for current references.',
};

/** A point whose element is in a frame the model cannot map or read. */
const POINT_FRAME_UNAVAILABLE_MESSAGE =
  "The element at that point is in a frame that can't be read. Run browser.input_snapshot for current references.";

function readFailure(
  code: Exclude<BrowserReadTargetCode, 'target_ambiguous'>,
  message?: string,
): BrowserReadTargetError {
  return new BrowserReadTargetError(
    code,
    message ??
      (code === 'invalid_locator'
        ? UNSUPPORTED_PLAYWRIGHT_LOCATOR_MESSAGE
        : READ_FAILURE_MESSAGES[code]),
  );
}

/**
 * A read whose model went stale twice in a row, or whose frame detached
 * while it ran, fails as a stale target, like any other read failure.
 */
async function typedRead<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (isStaleLocatorError(error) || isDetachedFrameError(error))
      throw readFailure('target_stale');
    throw error;
  }
}

function isDetachedFrameError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.startsWith(DETACHED_FRAME_ERROR_PREFIX)
  );
}

function decodeStylePair(value: unknown): PageModelStyleRead | undefined {
  if (!Array.isArray(value) || value.length !== 2) return undefined;
  const display: unknown = value[0];
  const visibility: unknown = value[1];
  return typeof display === 'string' && typeof visibility === 'string'
    ? { display, visibility }
    : undefined;
}

function decodeCandidate(value: unknown): BrowserLocatorCandidate | undefined {
  if (
    !isCDPRecord(value) ||
    typeof value.value !== 'string' ||
    typeof value.unique !== 'boolean'
  )
    return undefined;
  const kind = value.kind;
  const confidence = value.confidence;
  if (
    kind !== 'testId' &&
    kind !== 'role' &&
    kind !== 'label' &&
    kind !== 'placeholder' &&
    kind !== 'text' &&
    kind !== 'alt' &&
    kind !== 'title' &&
    kind !== 'css' &&
    kind !== 'domPath'
  )
    return undefined;
  if (confidence !== 'high' && confidence !== 'medium' && confidence !== 'low')
    return undefined;
  return {
    kind,
    confidence,
    value: value.value,
    unique: value.unique,
    ...(typeof value.name === 'string' ? { name: value.name } : {}),
    ...(typeof value.playwright === 'string'
      ? { playwright: value.playwright }
      : {}),
  };
}

function decodeEnrichment(value: unknown): InspectionEnrichment {
  if (!isCDPRecord(value) || typeof value.outerHtml !== 'string') return null;
  const rawCandidates = readCDPArray(value.locatorCandidates);
  const path = readCDPArray(value.domPath);
  if (!rawCandidates || !path) return null;
  const locatorCandidates: BrowserLocatorCandidate[] = [];
  const domPath: string[] = [];
  for (const raw of rawCandidates) {
    const candidate = decodeCandidate(raw);
    if (!candidate) return null;
    locatorCandidates.push(candidate);
  }
  for (const part of path) {
    if (typeof part !== 'string') return null;
    domPath.push(part);
  }
  const preferredLocator =
    value.preferredLocator === undefined
      ? undefined
      : decodeCandidate(value.preferredLocator);
  if (value.preferredLocator !== undefined && !preferredLocator) return null;
  return {
    locatorCandidates,
    domPath,
    outerHtml: value.outerHtml,
    ...(preferredLocator ? { preferredLocator } : {}),
  };
}
