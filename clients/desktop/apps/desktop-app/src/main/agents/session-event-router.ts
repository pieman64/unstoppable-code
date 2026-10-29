import { isAgentDelegationTranscript } from '@canopy/protocol/delegation';
import type { BrowserWindow } from 'electron';
import type { AgentSession, AgentSessionOptions } from './types';
import { buildSessionKey, getOrCreateSession } from './session-manager';
import {
  EventPressureGate,
  GROUP_COMMIT_EVENT_PRESSURE_LIMITS,
} from './event-pressure';
import { hasErroredToolResult } from '../lib/tool-result-entries';
import {
  createPreviewVisualTracker,
  projectPreviewVisualResult,
} from '@canopy/desktop-shared/lib/preview-visual-projection';
import { deferredToolsReloadCoordinator } from '../deferred-tools/reload-coordinator';
import {
  isRecord,
  isRootTerminalChatEventData,
  isStaleCodexRootErrorEvent,
  readCodexRootThreadId,
  readCodexRootTurnId,
} from '../lib/chat-turn-audit';

interface EventRoute {
  session?: AgentSession;
  handle(data: unknown): void | Promise<void>;
  drain(): Promise<void>;
  pressureSnapshot(): ReturnType<EventPressureGate['snapshot']>;
  onRemoved?: () => void;
}

const currentRoutes = new Map<string, EventRoute>();
let sessionRoutes = new WeakMap<AgentSession, Set<EventRoute>>();

function isOwnedDelegationEvent(data: unknown): boolean {
  return (
    isRecord(data) &&
    data.type === 'canopy_delegation' &&
    isAgentDelegationTranscript(data.delegation)
  );
}

/** One delegate run generation's place in line, and the snapshot it carries. */
interface WaitingDelegationSnapshot {
  data: unknown;
  sequence: number;
  settled?: Promise<void>;
}

/**
 * A delegate's run generation and snapshot sequence. Each delegation event
 * carries that run's full snapshot, so a newer one replaces an older one.
 */
function delegationSnapshotIdentity(
  data: unknown,
): { key: string; sequence: number } | undefined {
  if (
    !isRecord(data) ||
    data.type !== 'canopy_delegation' ||
    !isAgentDelegationTranscript(data.delegation) ||
    data.delegation.transcriptMode !== undefined
  )
    return undefined;
  const { delegationId, runGeneration, sequence } = data.delegation;
  return { key: `${delegationId}:${String(runGeneration)}`, sequence };
}

/**
 * All native chat entry points share this route, including desktop and Portal
 * sends to the same cowork chat. Providers retain their creation callback;
 * each dispatch replaces its destination while preserving queued event work.
 */
export async function getOrCreateRoutedSession(
  options: AgentSessionOptions,
  onEvent: (
    data: unknown,
    markPersistenceSettled?: () => void,
  ) => void | Promise<void>,
  getWindow: () => BrowserWindow | null,
  lifecycle: {
    turnUserMessageId: string;
    /** Atomically arbitrate an autonomous steering root before routing it. */
    acceptTurnRoot?: (turnUserMessageId: string) => boolean | Promise<boolean>;
    drainEventsBeforeRemoval: () => Promise<void>;
    onRemoved?: () => void;
  },
): Promise<AgentSession> {
  const key = buildSessionKey(
    options.projectId,
    options.worktreeId,
    options.chatId,
  );
  let codexRootThreadId = options.sdkSessionId;
  let codexRootTurnId: string | undefined;
  let rootUserMessageId = lifecycle.turnUserMessageId;
  let pendingRouteEvents: Promise<void> | undefined;
  // While chat storage group-commits, several of this chat's commits are in
  // flight together, bounded by bytes instead of one unmeasured event at a
  // time.
  const pressure = new EventPressureGate(
    () => GROUP_COMMIT_EVENT_PRESSURE_LIMITS,
  );
  const deliverRouteEvent = (data: unknown, release: () => void): void => {
    const ownedDelegation = isOwnedDelegationEvent(data);
    if (
      data !== null &&
      typeof data === 'object' &&
      'canopy_turn_user_message_id' in data &&
      typeof data.canopy_turn_user_message_id === 'string' &&
      data.canopy_turn_user_message_id !== rootUserMessageId &&
      !ownedDelegation
    ) {
      release();
      return;
    }
    const nextRootThreadId = readCodexRootThreadId(data);
    if (nextRootThreadId && nextRootThreadId !== codexRootThreadId) {
      codexRootThreadId = nextRootThreadId;
      codexRootTurnId = undefined;
    }
    codexRootTurnId =
      readCodexRootTurnId(data, codexRootThreadId) ?? codexRootTurnId;
    if (isStaleCodexRootErrorEvent(data, codexRootThreadId, codexRootTurnId)) {
      release();
      return;
    }
    if (
      isRecord(data) &&
      isRootTerminalChatEventData(data, codexRootThreadId, codexRootTurnId) &&
      deferredToolsReloadCoordinator.shouldSuppressProviderTerminal(options)
    ) {
      release();
      return;
    }
    try {
      // The adapter settles this charge after persistence. Its remaining UI
      // delivery may recursively enqueue another event; do not await it here.
      const delivered = onEvent(data, release);
      if (delivered && typeof delivered.then === 'function') {
        void Promise.resolve(delivered).then(release, release);
      } else {
        // Legacy synchronous observers have no persistence boundary.
        release();
      }
    } catch (error) {
      release();
      throw error;
    }
  };
  const routeEvent = (
    data: unknown,
    release: () => void,
  ): void | Promise<void> => {
    // A correlated Claude pickup can open another execution window on this
    // same query without an ordinary dispatch installing another route.
    if (
      isRecord(data) &&
      data.type === 'canopy_input_delivery' &&
      data.provider === 'claude' &&
      data.phase === 'picked-up' &&
      data.startsTurn === true &&
      typeof data.userMessageId === 'string' &&
      typeof data.attemptId === 'string' &&
      typeof data.generation === 'string' &&
      data.generation === route.session?.getSteeringCapabilities?.().generation
    ) {
      const candidateRootUserMessageId = data.userMessageId;
      const accept =
        lifecycle.acceptTurnRoot?.(candidateRootUserMessageId) ?? true;
      if (typeof accept !== 'boolean') {
        return Promise.resolve(accept)
          .then((accepted) => {
            if (accepted) {
              rootUserMessageId = candidateRootUserMessageId;
            }
            deliverRouteEvent({ ...data, turnRootAccepted: accepted }, release);
          })
          .catch((error: unknown) => {
            release();
            throw error;
          });
      }
      if (accept) {
        rootUserMessageId = candidateRootUserMessageId;
      }
      deliverRouteEvent({ ...data, turnRootAccepted: accept }, release);
      return;
    }
    deliverRouteEvent(data, release);
  };
  const trackPendingRouteEvent = (promise: Promise<void>): void => {
    // A rejected provider/arbitration callback still reaches its producer,
    // but must not poison every subsequent event on this route.
    const current = promise.then(
      () => undefined,
      () => undefined,
    );
    pendingRouteEvents = current;
    void current.then(() => {
      if (pendingRouteEvents === current) pendingRouteEvents = undefined;
    });
  };
  // Delegation snapshots still waiting for admission, by delegate run.
  const waitingSnapshots = new Map<string, WaitingDelegationSnapshot>();
  const route: EventRoute = {
    handle(data): void | Promise<void> {
      // A busy delegation tree publishes a snapshot per child event, and each
      // one is committed durably before the next is admitted. A snapshot
      // that is still waiting takes the newer content instead of queueing
      // another commit, so the chat never falls behind its delegates.
      const snapshot = delegationSnapshotIdentity(data);
      const waiting = snapshot && waitingSnapshots.get(snapshot.key);
      if (snapshot && waiting) {
        if (snapshot.sequence >= waiting.sequence) {
          waiting.data = data;
          waiting.sequence = snapshot.sequence;
        }
        return waiting.settled;
      }
      // Charge before async root arbitration: events retained in that route
      // chain are part of the same backlog as the downstream commit queue.
      // While chat storage group-commits, several events are in flight at
      // once; an errored tool result is admitted alone, so the authentication
      // failure paired with it is queued before any later event (its terminal
      // event would otherwise settle the turn first).
      const admitted = pressure.admit(data, {
        alone: hasErroredToolResult(data),
      });
      const dispatch = (
        payload: unknown,
        release: () => void,
      ): void | Promise<void> => {
        try {
          if (pendingRouteEvents) {
            const pending = pendingRouteEvents.then(() =>
              routeEvent(payload, release),
            );
            trackPendingRouteEvent(pending);
            return pending.catch((error: unknown) => {
              release();
              throw error;
            });
          }
          const pending = routeEvent(payload, release);
          if (pending) {
            trackPendingRouteEvent(pending);
            return pending.catch((error: unknown) => {
              release();
              throw error;
            });
          }
          return;
        } catch (error) {
          release();
          throw error;
        }
      };
      if (typeof admitted === 'function') return dispatch(data, admitted);
      if (!snapshot) return admitted.then((release) => dispatch(data, release));
      // The gate charged the first snapshot; a replacement is the same
      // delegate's cumulative snapshot, admitted in its place.
      const entry: WaitingDelegationSnapshot = {
        data,
        sequence: snapshot.sequence,
      };
      waitingSnapshots.set(snapshot.key, entry);
      entry.settled = admitted.then((release) => {
        if (waitingSnapshots.get(snapshot.key) === entry)
          waitingSnapshots.delete(snapshot.key);
        return dispatch(entry.data, release);
      });
      return entry.settled;
    },
    drain: async (): Promise<void> => {
      await pendingRouteEvents;
      await pressure.drain();
      await lifecycle.drainEventsBeforeRemoval();
    },
    pressureSnapshot: () => pressure.snapshot(),
    onRemoved: lifecycle.onRemoved,
  };
  currentRoutes.set(key, route);
  let boundSession: AgentSession | undefined;
  // The provider keeps this call's callback for the session's lifetime, so
  // the PreviewVisual calls it has seen survive a later dispatch or steer.
  const previewVisualTracker = createPreviewVisualTracker();
  const onRemoved = (): void => {
    const current = currentRoutes.get(key);
    if (
      current === route ||
      (boundSession && current?.session === boundSession)
    ) {
      currentRoutes.delete(key);
      // A reused session retains its creation callback, but removal belongs
      // to its latest route. Never notify a replacement transport's route.
      current?.onRemoved?.();
    }
  };
  try {
    const session = await getOrCreateSession(
      options,
      (providerData): void | Promise<void> => {
        // A preview screenshot is for the agent only. It leaves the event
        // here, before any route can store, log, or forward it, for every
        // chat entry point.
        const data = projectPreviewVisualResult(
          providerData,
          previewVisualTracker,
        );
        const current = currentRoutes.get(key);
        if (isOwnedDelegationEvent(data)) {
          // Managed children can outlive the provider transport that created
          // this callback. Route their explicitly parent-owned snapshots to
          // the latest chat route when one exists, or finish on the retained
          // route after removal.
          return (current ?? route).handle(data);
        }
        // Creation can emit synchronously. Once bound, the old transport must
        // never forward output into a replacement session, even without a tag.
        if (
          current &&
          (boundSession ? current.session === boundSession : current === route)
        ) {
          return current.handle(data);
        }
      },
      getWindow,
      {
        onRemoved,
        drainEventsBeforeRemoval: async (): Promise<void> => {
          const routes = boundSession
            ? sessionRoutes.get(boundSession)
            : undefined;
          if (routes) {
            await Promise.all(Array.from(routes, (entry) => entry.drain()));
          } else {
            await route.drain();
          }
        },
      },
    );
    boundSession = session;
    route.session = session;
    const routes = sessionRoutes.get(session) ?? new Set<EventRoute>();
    routes.add(route);
    sessionRoutes.set(session, routes);
    // Retain old routes only while their queued/derived work is still pending.
    // Their concrete-session drain remains reachable during concurrent teardown.
    for (const previous of Array.from(routes)) {
      if (previous === route) continue;
      void Promise.resolve()
        .then(() => previous.drain())
        .then(
          () => routes.delete(previous),
          () => undefined,
        );
    }
    return session;
  } catch (error) {
    onRemoved();
    throw error;
  }
}

/** Read-only route pressure across the current route and retained handoff
 * routes for the same live provider session. No event payloads are exposed. */
export function getRoutedSessionPressureSnapshot(target: {
  projectId: string;
  worktreeId: string;
  chatId: string;
}): {
  routeCount: number;
  activeCount: number;
  waitingCount: number;
  estimatedChargedBytes: number;
  oldestAgeMs: number;
  activeUncertainCount: number;
  waitingUncertainCount: number;
} {
  const current = currentRoutes.get(
    buildSessionKey(target.projectId, target.worktreeId, target.chatId),
  );
  const retained = current?.session
    ? sessionRoutes.get(current.session)
    : undefined;
  const routes = retained ? Array.from(retained) : current ? [current] : [];
  const total = {
    routeCount: routes.length,
    activeCount: 0,
    waitingCount: 0,
    estimatedChargedBytes: 0,
    oldestAgeMs: 0,
    activeUncertainCount: 0,
    waitingUncertainCount: 0,
  };
  for (const route of routes) {
    const snapshot = route.pressureSnapshot();
    total.activeCount += snapshot.activeCount;
    total.waitingCount += snapshot.waitingCount;
    total.estimatedChargedBytes += snapshot.chargedBytes;
    total.oldestAgeMs = Math.max(total.oldestAgeMs, snapshot.oldestAgeMs);
    total.activeUncertainCount += snapshot.activeUncertainCount;
    total.waitingUncertainCount += snapshot.uncertainWaitingCount;
  }
  return total;
}

/** Commit the already-received event prefix without stopping the live turn. */
export async function drainCurrentSessionEvents(target: {
  projectId: string;
  worktreeId: string;
  chatId: string;
}): Promise<void> {
  const current = currentRoutes.get(
    buildSessionKey(target.projectId, target.worktreeId, target.chatId),
  );
  if (!current) return;
  const routes = current.session
    ? sessionRoutes.get(current.session)
    : undefined;
  await Promise.all(
    routes ? Array.from(routes, (route) => route.drain()) : [current.drain()],
  );
}

export const sessionEventRouterTestExports = {
  currentRouteCount: (): number => currentRoutes.size,
  reset: (): void => {
    currentRoutes.clear();
    sessionRoutes = new WeakMap();
  },
};
