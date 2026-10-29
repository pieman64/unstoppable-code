import type { AuthDependencyFailure } from '@canopy/protocol/auth-recovery';
import type { CanopyInjectedToolKey } from '@canopy/desktop-shared/lib/canopy-injected-tools';

/**
 * Which errored tool result is allowed to claim a pending failure.
 *
 * The registry holds failures from two producers whose attribution rules are
 * NOT interchangeable (CAN-1814 PR 4). The MCP proxy knows only that *some*
 * upstream server 401'd, so its entry is anchored loosely and matched against
 * any errored MCP tool result. A Canopy-injected tool knows exactly which tool
 * failed, so its entry names that tool and can only be claimed by that tool's
 * own errored result — an exact identity match rather than a heuristic.
 *
 * Without the anchor, one registry means an errored MCP call could claim (and
 * permanently misattach, since claiming is destructive) a GitHub integration
 * failure, and an errored `WatchGitHubItems` could claim an unrelated MCP
 * server's 401.
 */
export type PendingAuthFailureAnchor =
  | { kind: 'mcp' }
  | { kind: 'injected-tool'; toolKey: CanopyInjectedToolKey };

/** A pending failure together with the anchor that may claim it. */
export interface PendingAuthFailureClaim {
  failure: AuthDependencyFailure;
  anchor: PendingAuthFailureAnchor;
}

interface PendingEntry {
  failure: AuthDependencyFailure;
  anchor: PendingAuthFailureAnchor;
  recordedAt: number;
}

/**
 * How long a published-but-unclaimed failure stays claimable.
 *
 * The proxy serves `initialize`, `tools/list`, and SSE reconnects, not just
 * tool calls, so a 401 can be recorded with no errored tool result to claim it.
 * Entries are otherwise removed only by a claim or by session teardown, and a
 * session outlives many turns — without this bound a 401 recorded at session
 * init could be claimed by the first errored MCP tool result twenty turns later
 * and rendered as that turn's failure. The fail-closed pairing rules
 * deliberately PRESERVE unclaimable entries, which makes that more likely, not
 * less.
 *
 * Two minutes is a generous ceiling on the gap between the upstream 401 and the
 * errored tool result it produced (they are the same request/response cycle),
 * while being far shorter than a session.
 */
export const PENDING_AUTH_FAILURE_TTL_MS = 120_000;

/**
 * In-memory authentication failures awaiting attachment to a transcript.
 *
 * The MCP HTTP proxy is shared across every chat and its routes carry no
 * project/worktree/chat identity, so it cannot address a transcript directly.
 * It publishes here keyed by route owner id — the same id used by
 * `unregisterRoutesForSession` — and the owning agent session claims the entry
 * when it sees the errored tool result (CAN-1814).
 *
 * Canopy-injected tools publish here for the same reason, not a different one:
 * a tool executor runs BEFORE its own `tool_result` block exists, and the
 * `toolUseId` it receives on the Claude path is the MCP transport's JSON-RPC id
 * rather than the transcript's `tool_use` id (`http-proxy-service.ts`), so it
 * cannot address the block either. See {@link PendingAuthFailureAnchor} for how
 * the two producers stay separable inside one registry.
 *
 * Entries are deduped per `dependencyId` so one broken dependency reports once
 * per turn rather than once per retried tool call.
 */
const pendingByOwner = new Map<string, Map<string, PendingEntry>>();

function record(routeOwnerId: string, entry: PendingEntry): void {
  const existing = pendingByOwner.get(routeOwnerId);
  if (existing) {
    existing.set(entry.failure.dependencyId, entry);
    return;
  }
  pendingByOwner.set(
    routeOwnerId,
    new Map([[entry.failure.dependencyId, entry]]),
  );
}

export function recordPendingMcpAuthFailure(
  routeOwnerId: string,
  failure: AuthDependencyFailure,
  recordedAt: number = Date.now(),
): void {
  record(routeOwnerId, { failure, anchor: { kind: 'mcp' }, recordedAt });
}

/**
 * Publish a failure raised by a Canopy-injected tool, anchored to that tool so
 * only its own errored result can claim it (CAN-1814 PR 4).
 */
export function recordPendingInjectedToolAuthFailure(
  routeOwnerId: string,
  toolKey: CanopyInjectedToolKey,
  failure: AuthDependencyFailure,
  recordedAt: number = Date.now(),
): void {
  record(routeOwnerId, {
    failure,
    anchor: { kind: 'injected-tool', toolKey },
    recordedAt,
  });
}

export interface ClaimPendingAuthFailuresOptions {
  now?: number;
  /**
   * Which anchors the caller can actually attach right now. An entry this
   * rejects is LEFT IN THE REGISTRY, so a later result that can anchor it still
   * takes it — claiming is destructive, and a wrong claim is not recoverable
   * the way a deferred one is. Defaults to claiming everything.
   */
  canClaim?: (anchor: PendingAuthFailureAnchor) => boolean;
}

/**
 * Read and remove, so a failure attaches to exactly one turn. Entries older
 * than {@link PENDING_AUTH_FAILURE_TTL_MS} are dropped rather than returned,
 * so a stale background 401 cannot be rendered as a later turn's failure — and
 * they are dropped even when `canClaim` rejects them, since a stale entry that
 * survived an anchor mismatch would outlive its own window.
 */
export function claimPendingAuthFailures(
  routeOwnerId: string,
  options: ClaimPendingAuthFailuresOptions = {},
): PendingAuthFailureClaim[] {
  const entries = pendingByOwner.get(routeOwnerId);
  if (!entries) {
    return [];
  }
  const now = options.now ?? Date.now();
  const canClaim = options.canClaim;
  const claimed: PendingAuthFailureClaim[] = [];
  for (const [dependencyId, entry] of Array.from(entries.entries())) {
    if (now - entry.recordedAt > PENDING_AUTH_FAILURE_TTL_MS) {
      entries.delete(dependencyId);
      continue;
    }
    if (canClaim !== undefined && !canClaim(entry.anchor)) {
      continue;
    }
    entries.delete(dependencyId);
    claimed.push({ failure: entry.failure, anchor: entry.anchor });
  }
  if (entries.size === 0) {
    pendingByOwner.delete(routeOwnerId);
  }
  return claimed;
}

/** Drop pending failures for an owner, e.g. when its session tears down. */
export function clearPendingAuthFailures(routeOwnerId: string): void {
  pendingByOwner.delete(routeOwnerId);
}
