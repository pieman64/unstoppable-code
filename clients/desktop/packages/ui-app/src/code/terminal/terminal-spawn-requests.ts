// ---------------------------------------------------------------------------
// Terminal spawn-request bus (renderer)
// ---------------------------------------------------------------------------
//
// A tiny module-level pub/sub (mirroring `browserDrawerActivation`) used to
// ask the mounted `TerminalPanelSurface` for a worktree to spawn a terminal.
// PTY spawning is deliberately component-local (`TerminalPanelSurface.spawn`
// measures the mounted pane to pick spawn cols/rows), so keyboard-shortcut
// callers request a spawn instead of spawning directly (ECW-7984):
//
// - `new-tab`: always spawn a fresh terminal panel (Cmd/Ctrl+T with a
//   terminal panel active).
// - `ensure`: spawn only when the worktree has no terminals yet, otherwise
//   just focus the current terminal (Ctrl+` open-terminal).
//
// The surface may not be mounted yet when requests fire (the shortcut may
// have just docked the terminal panel into the grid), so every new-tab request
// is retained in FIFO order. Redundant ensure requests for the same worktree
// are coalesced.

export type TerminalSpawnRequestMode = 'new-tab' | 'ensure';

/**
 * How long a *targeted* request stays claimable. Untargeted shortcut requests
 * are deliberately retained forever (their surface may simply not be mounted
 * yet), but a targeted reveal names a panel that may never become active — a
 * tab dropped elsewhere, a worktree switched away from mid-gesture. Left
 * pending, it would be claimed by the eventual PASSIVE activation of that
 * panel and spawn a PTY with no gesture behind it, which is exactly the
 * invariant reveal auto-start is built around (CAN-2309). Expiring bounds the
 * gesture to the interaction that produced it.
 */
export const TERMINAL_SPAWN_REQUEST_TTL_MS = 30_000;

export interface TerminalSpawnRequest {
  projectId: string;
  worktreeId: string;
  /** Concrete panel layout that originated the request, when known. */
  layoutKey?: string;
  /**
   * Concrete panel the request targets, when the caller resolved one.
   *
   * A targeted request is claimable ONLY by that panel's surface. Without it,
   * every *active* terminal surface in the layout is an equally valid
   * claimant: a reveal of an unbound placeholder could be claimed by a
   * different, already-bound terminal panel, which then merely re-focuses
   * itself — leaving the revealed tab unbound and moving the caret somewhere
   * the user never pointed at. Which surface won was `Set` (mount) order, so
   * the misrouting was non-deterministic.
   */
  panelId?: string;
  mode: TerminalSpawnRequestMode;
  /**
   * Monotonic-enough wall clock for expiry. Every *targeted* request carries
   * one — `requestTerminalSpawn` stamps it when a caller omits it — while
   * untargeted shortcut requests never expire. See
   * {@link TERMINAL_SPAWN_REQUEST_TTL_MS}.
   */
  requestedAt?: number;
}

type Listener = (request: TerminalSpawnRequest) => void;

const listeners = new Set<Listener>();
const pending: TerminalSpawnRequest[] = [];

function matchesWorktree(
  request: TerminalSpawnRequest,
  projectId: string,
  worktreeId: string,
): boolean {
  return request.projectId === projectId && request.worktreeId === worktreeId;
}

function matchesConsumer(
  request: TerminalSpawnRequest,
  projectId: string,
  worktreeId: string,
  layoutKey?: string,
  panelId?: string,
): boolean {
  return (
    matchesWorktree(request, projectId, worktreeId) &&
    (request.layoutKey === undefined || request.layoutKey === layoutKey) &&
    (request.panelId === undefined || request.panelId === panelId)
  );
}

function isExpired(request: TerminalSpawnRequest, now: number): boolean {
  return (
    request.requestedAt !== undefined &&
    now - request.requestedAt > TERMINAL_SPAWN_REQUEST_TTL_MS
  );
}

/**
 * Drop every request whose gesture has gone stale. Pruning at claim time (not
 * on a timer) keeps this module free of scheduling: an expired request is only
 * harmful at the moment something would otherwise act on it.
 */
function pruneExpired(now: number): void {
  for (let index = pending.length - 1; index >= 0; index -= 1) {
    const request = pending[index];
    if (request !== undefined && isExpired(request, now)) {
      pending.splice(index, 1);
    }
  }
}

/** Ask the mounted terminal surface for this worktree to spawn/focus. */
export function requestTerminalSpawn(request: TerminalSpawnRequest): void {
  pruneExpired(Date.now());
  if (request.mode === 'ensure') {
    const existing = pending.find(
      (candidate) =>
        candidate.mode === 'ensure' &&
        candidate.layoutKey === request.layoutKey &&
        candidate.panelId === request.panelId &&
        matchesWorktree(candidate, request.projectId, request.worktreeId),
    );
    if (existing !== undefined) {
      // Coalesce, but let the LATEST gesture set the clock. Measuring the
      // TTL from the first gesture meant a request that had sat unclaimed
      // for nearly the whole window absorbed a brand-new reveal and then
      // expired moments later — the user's most recent click producing no
      // terminal, in the one feature this request exists to serve.
      //
      // Both stamps are defined or neither is: the predicate above requires
      // an exact `panelId` match, and only targeted requests are stamped, so
      // a targeted request never coalesces with an untargeted one. Updating
      // only when both are present keeps an untargeted request from
      // acquiring an expiry it never had.
      if (
        existing.requestedAt !== undefined &&
        request.requestedAt !== undefined
      ) {
        existing.requestedAt = Math.max(
          existing.requestedAt,
          request.requestedAt,
        );
      }
      return;
    }
  }
  // Stamp here rather than trusting every caller to. A targeted request that
  // arrived unstamped would be immortal: it coalesces as `existing`, is never
  // refreshed, never expires, and eventually fires on a passive activation —
  // the exact CAN-2309 failure the TTL exists to prevent, failing OPEN. This
  // makes "targeted implies expiring" a property of the bus instead of a
  // convention three call sites have to remember.
  const stamped =
    request.panelId !== undefined && request.requestedAt === undefined
      ? { ...request, requestedAt: Date.now() }
      : request;
  pending.push(stamped);
  // Broadcast the SAME object that was retained. Handing listeners the
  // caller's unstamped original would leave the notification disagreeing
  // with the entry a claim later reads, right under a contract that says
  // every targeted request carries a stamp.
  listeners.forEach((listener) => {
    listener(stamped);
  });
}

/** Subscribe to spawn requests. Returns an unsubscribe fn. */
export function subscribeTerminalSpawnRequests(listener: Listener): () => void {
  listeners.add(listener);
  return (): void => {
    listeners.delete(listener);
  };
}

/**
 * Whether the given surface is an eligible claimant for `request`. Shared with
 * the surface's own subscription filter so the "should I even try to claim?"
 * test and the claim itself can never diverge.
 */
export function terminalSpawnRequestTargets(
  request: TerminalSpawnRequest,
  projectId: string,
  worktreeId: string,
  layoutKey?: string,
  panelId?: string,
): boolean {
  return matchesConsumer(request, projectId, worktreeId, layoutKey, panelId);
}

/**
 * Claims the pending request for this worktree. Returns the request when the
 * caller should act on it (at most one claimant wins), else null.
 */
export function consumePendingTerminalSpawn(
  projectId: string,
  worktreeId: string,
  layoutKey?: string,
  panelId?: string,
): TerminalSpawnRequest | null {
  pruneExpired(Date.now());
  const index = pending.findIndex((request) =>
    matchesConsumer(request, projectId, worktreeId, layoutKey, panelId),
  );
  if (index === -1) {
    return null;
  }
  return pending.splice(index, 1)[0] ?? null;
}
