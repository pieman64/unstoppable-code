import { create } from 'zustand';
import type {
  ShareRequestSource,
  ShareTarget,
  SkillShareNudgeOrigin,
  ResolveSkillShareNudgeRequest,
} from '@canopy/desktop-shared/lib/skill-share-nudge';

/**
 * The one pending chat-side share request (CAN-3611).
 *
 * Entry points never open a share dialog themselves: they ask this store, and
 * the mounted `ChatShareHost` runs the sign-in gate, resolves the target and
 * renders the common dialog. One request is active at a time; a newer request
 * replaces it, and every continuation checks the request id so a stale load,
 * gate or callback cannot open or clear its replacement.
 *
 * Documents stay in renderer memory only and never cross IPC.
 */

/** The nudge a request came from, so a completed share can be routed back. */
export interface ShareRequestNudgeOrigin extends SkillShareNudgeOrigin {
  pendingId: string;
}

/**
 * What a chat-side request can share. Skills and plugins are the installed
 * identities the usage nudge counts; a pipeline is a saved-item locator from
 * an artifact tile (CAN-3488) and never comes from a nudge.
 */
export type ChatShareTarget = ShareTarget;

export interface ShareRequest {
  id: string;
  target: ChatShareTarget;
  source: ShareRequestSource;
  /** Document of the element that asked; pop-outs open the dialog there. */
  ownerDocument?: Document;
  origin?: ShareRequestNudgeOrigin;
}

export interface ShareRequestOptions {
  source: ShareRequestSource;
  ownerDocument?: Document;
  origin?: ShareRequestNudgeOrigin;
}

interface ShareRequestState {
  /** Mounted hosts. Entry points render only while this is above zero. */
  hostCount: number;
  request: ShareRequest | null;
  /** Renderer-memory intents survive composer remounts until main acknowledges. */
  nudgeResolutions: Readonly<Record<string, NudgeResolutionIntent>>;
  registerHost: () => () => void;
  /** Returns the request id, or `null` when no host can serve it. */
  requestShare: (
    target: ChatShareTarget,
    options: ShareRequestOptions,
  ) => string | null;
  /** Clears the request only while `id` is still the current one. */
  clearRequest: (id: string) => void;
}

let nextRequestId = 0;

export const useShareRequestStore = create<ShareRequestState>((set, get) => ({
  hostCount: 0,
  request: null,
  nudgeResolutions: {},
  registerHost: (): (() => void) => {
    set((state) => ({ hostCount: state.hostCount + 1 }));
    let registered = true;
    return (): void => {
      if (!registered) return;
      registered = false;
      set((state) => {
        const hostCount = Math.max(0, state.hostCount - 1);
        // Without a host nothing can serve the request; drop it.
        return hostCount === 0 ? { hostCount, request: null } : { hostCount };
      });
    };
  },
  requestShare: (target, options): string | null => {
    if (get().hostCount === 0) return null;
    nextRequestId += 1;
    const id = `share-${String(nextRequestId)}`;
    set({
      request: {
        id,
        target,
        source: options.source,
        ...(options.ownerDocument
          ? { ownerDocument: options.ownerDocument }
          : {}),
        ...(options.origin ? { origin: options.origin } : {}),
      },
    });
    return id;
  },
  clearRequest: (id): void => {
    if (get().request?.id === id) set({ request: null });
  },
}));

interface NudgeResolutionIntent {
  request: ResolveSkillShareNudgeRequest;
  acknowledged: boolean;
  timer?: number;
}

/** Send once at a time and retry failures even when the composer unmounts. */
export function reportSkillShareNudgeResolution(
  request: ResolveSkillShareNudgeRequest,
): void {
  const previous =
    useShareRequestStore.getState().nudgeResolutions[request.pendingId];
  if (previous) {
    if (previous.request.resolution === request.resolution) return;
    if (previous.request.resolution !== 'shown') return;
    if (previous.timer !== undefined) window.clearTimeout(previous.timer);
  }
  const intent: NudgeResolutionIntent = { request, acknowledged: false };
  useShareRequestStore.setState((state) => ({
    nudgeResolutions: {
      ...state.nudgeResolutions,
      [request.pendingId]: intent,
    },
  }));
  const isCurrent = (): boolean =>
    useShareRequestStore.getState().nudgeResolutions[request.pendingId] ===
    intent;
  const send = (attempt: number): void => {
    if (!isCurrent()) return;
    const retry = (): void => {
      if (!isCurrent()) return;
      intent.timer = window.setTimeout(
        () => {
          delete intent.timer;
          send(attempt + 1);
        },
        Math.min(5_000 * 2 ** Math.min(attempt - 1, 4), 60_000),
      );
    };
    void window.skillShareNudge.resolve(request).then((result) => {
      if (!isCurrent()) return;
      if (!result.success) {
        retry();
        return;
      }
      // data=false is a stale pending id: main already replaced or cleared it.
      intent.acknowledged = true;
    }, retry);
  };
  send(1);
}

/** Release acknowledged intents once an authoritative read moves past them. */
export function forgetAcknowledgedNudgeResolutions(
  origin: SkillShareNudgeOrigin,
  pendingId: string | null,
): void {
  useShareRequestStore.setState((state) => {
    const nudgeResolutions = { ...state.nudgeResolutions };
    let changed = false;
    for (const [id, intent] of Object.entries(nudgeResolutions)) {
      const request = intent.request;
      if (
        intent.acknowledged &&
        id !== pendingId &&
        request.projectId === origin.projectId &&
        request.worktreeId === origin.worktreeId &&
        request.chatId === origin.chatId
      ) {
        delete nudgeResolutions[id];
        changed = true;
      }
    }
    return changed ? { nudgeResolutions } : state;
  });
}

/** Whether this window can open a chat-side share dialog at all. */
export function useShareHostAvailable(): boolean {
  return useShareRequestStore((state) => state.hostCount > 0);
}

export function requestShare(
  target: ChatShareTarget,
  options: ShareRequestOptions,
): string | null {
  return useShareRequestStore.getState().requestShare(target, options);
}

type ShareCompletedListener = (request: ShareRequest) => void;
const completedListeners = new Set<ShareCompletedListener>();

/** Fires only after a share actually completed, never on close or cancel. */
export function subscribeShareCompleted(
  listener: ShareCompletedListener,
): () => void {
  completedListeners.add(listener);
  return (): void => {
    completedListeners.delete(listener);
  };
}

export function notifyShareCompleted(request: ShareRequest): void {
  for (const listener of Array.from(completedListeners)) listener(request);
}
