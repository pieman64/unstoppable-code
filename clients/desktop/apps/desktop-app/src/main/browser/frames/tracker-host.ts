import { randomUUID } from 'node:crypto';
import {
  decodeTrackerWitness,
  TRACKER_WITNESS_RESOLVER_KEY,
} from '@canopy/desktop-shared/browser/page-trackers';
import { isCDPRecord, readCDPString } from './cdp-decode';
import type { ExecutionContexts } from './execution-contexts';
import {
  bounded,
  releaseObjectGroup,
  remoteValue,
  resolveNodeObject,
  type HostSend,
} from './host-cdp';
import type {
  ControlHistory,
  TrackerMemory,
  TrackerScope,
} from './model-types';
import {
  createTrackerKey,
  decodeTrackerAnswer,
  decodeTrackerSummary,
  isolatedTrackerSource,
  mainWorldTrackerSource,
  TRACKER_WORLD_NAME,
  trackerCallDeclaration,
} from './trackers';

/** Bound for one tracker query, context confirmation included. */
const QUERY_TIMEOUT_MS = 2_000;
const BATCH = 200;

/** Whether a frame's current document is known to carry the trackers. */
export type TrackerStatus = 'tracked' | 'late' | 'unconfirmed';

export type { TrackerMemory } from './model-types';

interface Confirmation {
  /** The witness's context: the tracker world, or the preload's world. */
  contextId: number;
  early: boolean;
  /** The document's main-world resolver key. */
  key: string;
  witness: 'tracker' | 'preload';
}

/** The call into the preload's witness, by syntax only. */
const WITNESS_CALL = `function() { const witness = this[${JSON.stringify(TRACKER_WITNESS_RESOLVER_KEY)}]; return typeof witness === 'function' ? witness() : undefined; }`;

export interface PageTrackerDeps {
  send: HostSend;
  /**
   * Whether a frame is a top document (the preload's). Its main-world
   * tracker is the preload's, under a key the preload's witness gives.
   */
  isTopDocument?: (frameId: string, sessionId: string) => boolean;
  /** Isolated worlds of a frame that can hold the preload's witness. */
  preloadContexts?: (frameId: string, sessionId: string) => number[];
}

/**
 * Installs the document-start trackers on each session and answers the
 * model's password-history queries (decisions D2 to D4).
 *
 * A child frame's document is confirmed when its isolated-world tracker
 * answers in a context of the tracker's world: `early` when it ran at
 * document start. Contexts with the world's name alone prove nothing
 * (Chromium creates empty ones). Since the main-world tracker is
 * registered first, an early isolated tracker also witnesses that the
 * main-world resolver of that document is the host's, before any page
 * script. A top document's main-world tracker is the preload's (E4): the
 * preload's witness says whether it ran at document start and under which
 * key, which is the document's own. Confirmation is per frame and context,
 * so navigation, reattachment and detach reset it.
 */
export class PageTrackers {
  private readonly scripts = new Map<string, string[]>();

  private readonly confirmations = new Map<string, Confirmation>();

  public constructor(
    private readonly deps: PageTrackerDeps,
    private readonly contexts: ExecutionContexts,
    public readonly key: string = createTrackerKey(),
  ) {}

  private isTop(frameId: string, sessionId: string): boolean {
    return this.deps.isTopDocument?.(frameId, sessionId) === true;
  }

  /**
   * Registers both trackers on a session, replacing this host's earlier
   * registrations there. Call at attach and after every `Page.enable`:
   * `Page.disable` drops registered scripts. False when registration
   * failed; documents of that session are then unknown.
   */
  public async install(sessionId: string): Promise<boolean> {
    const previous = this.scripts.get(sessionId) ?? [];
    this.scripts.delete(sessionId);
    // The witness goes first, so no document can have it without the
    // main-world tracker.
    for (const identifier of [...previous].reverse()) {
      await this.deps
        .send(
          'Page.removeScriptToEvaluateOnNewDocument',
          { identifier },
          sessionId,
        )
        .catch(() => undefined);
    }
    try {
      const main = await this.deps.send(
        'Page.addScriptToEvaluateOnNewDocument',
        {
          // Child documents only: the preload covers top documents.
          source: mainWorldTrackerSource(this.key, { documents: 'child' }),
        },
        sessionId,
      );
      const mainId = scriptIdentifier(main);
      if (mainId === undefined) return false;
      this.scripts.set(sessionId, [mainId]);
      const isolated = await this.deps.send(
        'Page.addScriptToEvaluateOnNewDocument',
        {
          source: isolatedTrackerSource(this.key),
          worldName: TRACKER_WORLD_NAME,
        },
        sessionId,
      );
      const isolatedId = scriptIdentifier(isolated);
      if (isolatedId === undefined) return false;
      this.scripts.set(sessionId, [mainId, isolatedId]);
      return true;
    } catch {
      return false;
    }
  }

  public forgetSession(sessionId: string): void {
    this.scripts.delete(sessionId);
    for (const key of Array.from(this.confirmations.keys())) {
      if (key.startsWith(`${sessionId}\u0000`)) this.confirmations.delete(key);
    }
  }

  /** A new document in the frame needs its own confirmation. */
  public noteFrameNavigated(frameId: string): void {
    for (const key of Array.from(this.confirmations.keys())) {
      if (key.endsWith(`\u0000${frameId}`)) this.confirmations.delete(key);
    }
  }

  public status(frameId: string, sessionId: string): TrackerStatus {
    const confirmation = this.currentConfirmation(frameId, sessionId);
    if (!confirmation) return 'unconfirmed';
    return confirmation.early ? 'tracked' : 'late';
  }

  private currentConfirmation(
    frameId: string,
    sessionId: string,
  ): Confirmation | undefined {
    const key = `${sessionId}\u0000${frameId}`;
    const confirmation = this.confirmations.get(key);
    if (!confirmation) return undefined;
    const context = this.contexts.get(sessionId, confirmation.contextId);
    const witnessWorld =
      confirmation.witness === 'tracker'
        ? context?.name === TRACKER_WORLD_NAME
        : context?.isolated === true && context.name !== TRACKER_WORLD_NAME;
    if (context?.frameId !== frameId || !witnessWorld) {
      this.confirmations.delete(key);
      return undefined;
    }
    return confirmation;
  }

  /** A top document's witness: the preload's, in its isolated world. */
  private async confirmTop(
    frameId: string,
    sessionId: string,
  ): Promise<Confirmation | undefined> {
    for (const contextId of this.deps.preloadContexts?.(frameId, sessionId) ??
      []) {
      if (this.contexts.get(sessionId, contextId)?.name === TRACKER_WORLD_NAME)
        continue;
      try {
        const response = await this.deps.send(
          'Runtime.callFunctionOn',
          {
            executionContextId: contextId,
            functionDeclaration: WITNESS_CALL,
            returnByValue: true,
          },
          sessionId,
        );
        const witness = decodeTrackerWitness(remoteValue(response));
        if (!witness) continue;
        const confirmation: Confirmation = {
          contextId,
          early: witness.early,
          key: witness.early ? witness.key : '',
          witness: 'preload',
        };
        this.confirmations.set(`${sessionId}\u0000${frameId}`, confirmation);
        return confirmation;
      } catch {
        // A world of a replaced document, or one without the preload.
      }
    }
    return undefined;
  }

  /** Finds the context of the frame's tracker world whose tracker answers. */
  private async confirm(
    frameId: string,
    sessionId: string,
  ): Promise<Confirmation | undefined> {
    const current = this.currentConfirmation(frameId, sessionId);
    if (current) return current;
    if (this.isTop(frameId, sessionId))
      return this.confirmTop(frameId, sessionId);
    for (const contextId of this.contexts.named(
      frameId,
      sessionId,
      TRACKER_WORLD_NAME,
    )) {
      try {
        const response = await this.deps.send(
          'Runtime.callFunctionOn',
          {
            executionContextId: contextId,
            functionDeclaration: trackerCallDeclaration(this.key, 0),
            returnByValue: true,
          },
          sessionId,
        );
        const answer = decodeTrackerSummary(remoteValue(response));
        if (!answer) continue;
        const confirmation: Confirmation = {
          contextId,
          early: answer.early,
          key: this.key,
          witness: 'tracker',
        };
        this.confirmations.set(`${sessionId}\u0000${frameId}`, confirmation);
        return confirmation;
      } catch {
        // A context of a replaced document, or an empty same-named world.
      }
    }
    return undefined;
  }

  /**
   * The context of a holder in a confirmed, early document, and the key of
   * its resolver. A top document has no light-DOM tracker: the preload
   * answers for its light DOM.
   */
  private async holderContext(
    frameId: string,
    sessionId: string,
    holder: TrackerScope,
  ): Promise<{ contextId: number; key: string } | undefined> {
    const witness = await this.confirm(frameId, sessionId);
    if (!witness?.early) return undefined;
    if (holder === 'light')
      return witness.witness === 'tracker'
        ? { contextId: witness.contextId, key: witness.key }
        : undefined;
    const contextId = this.contexts.mainWorld(frameId, sessionId);
    return contextId === undefined
      ? undefined
      : { contextId, key: witness.key };
  }

  /**
   * Whether one holder of a frame remembers any password now: the isolated
   * tracker (`light`) or the main-world tracker (`shadow`). Asked fresh,
   * since pages reveal passwords at any time.
   */
  public async summary(
    frameId: string,
    sessionId: string,
    holder: TrackerScope,
  ): Promise<TrackerMemory> {
    const operation = (async (): Promise<TrackerMemory> => {
      const holderContext = await this.holderContext(
        frameId,
        sessionId,
        holder,
      );
      if (holderContext === undefined) return 'unknown';
      const response = await this.deps.send(
        'Runtime.callFunctionOn',
        {
          executionContextId: holderContext.contextId,
          functionDeclaration: trackerCallDeclaration(holderContext.key, 0),
          returnByValue: true,
        },
        sessionId,
      );
      const summary = decodeTrackerSummary(remoteValue(response));
      if (!summary?.early) return 'unknown';
      return summary.remembers ? 'some' : 'none';
    })();
    try {
      return await bounded(operation, QUERY_TIMEOUT_MS);
    } catch {
      return 'unknown';
    }
  }

  /**
   * Password history of inputs in one frame from one holder: `light` is the
   * isolated tracker (the frame's light DOM), `shadow` the main-world
   * tracker (its shadow roots). Each answers `was` for any element it
   * remembers, wherever it is now, and `never` only inside its own scope.
   * An early per-element unknown is a real answer; any failed ask is
   * undefined, so it cannot vouch for another holder.
   */
  public async history(
    frameId: string,
    sessionId: string,
    scope: TrackerScope,
    backendNodeIds: number[],
  ): Promise<ControlHistory[] | undefined> {
    if (backendNodeIds.length === 0) return [];
    const group = `canopy-tracker-${randomUUID()}`;
    const operation = (async (): Promise<ControlHistory[] | undefined> => {
      const holderContext = await this.holderContext(frameId, sessionId, scope);
      if (holderContext === undefined) return undefined;
      const { contextId } = holderContext;
      const statuses: ControlHistory[] = [];
      for (let offset = 0; offset < backendNodeIds.length; offset += BATCH) {
        const batch = backendNodeIds.slice(offset, offset + BATCH);
        const objects = await Promise.all(
          batch.map((backendNodeId) =>
            resolveNodeObject(
              this.deps.send,
              sessionId,
              backendNodeId,
              group,
              contextId,
            ),
          ),
        );
        if (objects.some((objectId) => objectId === undefined))
          return undefined;
        const response = await this.deps.send(
          'Runtime.callFunctionOn',
          {
            executionContextId: contextId,
            functionDeclaration: trackerCallDeclaration(
              holderContext.key,
              batch.length,
            ),
            arguments: objects.map((objectId) => ({ objectId })),
            returnByValue: true,
            objectGroup: group,
          },
          sessionId,
        );
        const answer = decodeTrackerAnswer(remoteValue(response), batch.length);
        if (!answer?.early) return undefined;
        statuses.push(...answer.statuses);
      }
      return statuses;
    })();
    try {
      return await bounded(operation, QUERY_TIMEOUT_MS);
    } catch {
      return undefined;
    } finally {
      // Late resolutions are released again once the operation settles.
      releaseObjectGroup(this.deps.send, group, [sessionId]);
      void operation
        .finally(() => releaseObjectGroup(this.deps.send, group, [sessionId]))
        .catch(() => undefined);
    }
  }
}

function scriptIdentifier(response: unknown): string | undefined {
  return isCDPRecord(response) ? readCDPString(response.identifier) : undefined;
}
