import type { AuthDependencyFailure } from '@canopy/protocol/auth-recovery';
import {
  CANOPY_AUTH_FAILURE_EVENT_TYPE,
  type CanopyAuthFailureEventData,
} from '@canopy/desktop-shared/types';
import { parseMcpToolName } from '@canopy/desktop-shared/lib/turn-utils';
import {
  getCanonicalCanopyToolKey,
  type CanopyInjectedToolKey,
} from '@canopy/execution-engine/lib/canopy-injected-tools';
import {
  buildManagedMcpServerIdentityDigest,
  readManagedMcpServerNameDigest,
} from '@canopy/execution-engine/node/plugins/mcp-server-name';
import { claimPendingAuthFailures } from '../mcp/pending-auth-failures';
import { isRecord } from './type-guards';
import {
  readCodexDynamicToolItem,
  readMessageContent,
  readToolResultEntries,
  type ToolResultEntry,
} from './tool-result-entries';

/**
 * One `canopy_auth_failure` event plus the raw provider tool name of the
 * errored call it was paired with.
 *
 * The tool name never rides the event itself: it is only used inside main, to
 * decide whether the interrupted turn may be resumed without asking
 * (CAN-1814 PR 6).
 */
export interface AuthFailurePairing {
  event: CanopyAuthFailureEventData;
  /** As the provider emitted it, e.g. `mcp__<managed server name>__<tool>`. */
  toolName: string;
  /**
   * Did another tool call issued in the SAME parallel batch as {@link toolName}
   * fail to land a result in this event?
   *
   * Load-bearing for auto-resume safety (CAN-1814 review). The read-only name
   * check judges one tool, but the stop it triggers cancels the SESSION-WIDE
   * AbortController. Claude batches parallel tool calls, so `[list_issues,
   * create_issue]` can arrive with only the read's 401 while the write is still
   * in flight: cancelling kills it, its `tool_result` never lands, the resumed
   * session replays a `tool_use` with no result, and the model typically
   * re-issues it — a duplicated external write, invisible to a gate that only
   * reads names.
   *
   * Scoped to the failing call's own assistant batch rather than to every
   * outstanding id, because the name cache legitimately retains ids from
   * cancelled or truncated earlier turns; treating those as siblings would make
   * auto-resume permanently unreachable instead of merely conservative.
   */
  batchHasUnresolvedToolCalls: boolean;
}

/** An errored result already resolved to the raw tool name that produced it. */
interface ErroredMcpResult {
  toolUseId: string;
  /**
   * The name as the provider emitted it — `mcp__<managed server name>__<tool>`
   * — NOT `parseMcpToolName(...).server`, which normalizes the managed name and
   * throws away the identity digest this module matches on.
   */
  rawToolName: string;
  /** The assistant batch this call was issued in. */
  batch: number;
  origin: RecordedToolUse['origin'];
}

/**
 * An errored result resolved to the Canopy-injected tool that produced it.
 *
 * `toolKey` is the canonical registry key, so it compares equal across every
 * alias a provider may emit (`WatchGitHubItems`,
 * `mcp__<brand>__WatchGitHubItems`, `<brand>_watch_github_items`).
 */
interface ErroredInjectedToolResult {
  toolUseId: string;
  rawToolName: string;
  toolKey: CanopyInjectedToolKey;
  /** The assistant batch this call was issued in. */
  batch: number;
  origin: RecordedToolUse['origin'];
}

/**
 * Per-route-owner cache of `tool_use_id -> tool name`, populated as
 * `tool_use` blocks stream from the provider (Claude) or as dynamic tool
 * items start (Codex).
 *
 * A `tool_result` event carries only the `tool_use_id`, never the tool name
 * (see `readMessageContent`), so this cache is the only way to know whether
 * an errored `tool_result` actually belongs to an MCP tool before pairing it
 * with a pending auth failure. Without it, ANY errored tool result in a
 * session with a pending failure would incorrectly claim and misattach that
 * failure to an unrelated tool call — see `pairPendingAuthFailures` for the
 * fail-closed handling of an id this cache never captured.
 *
 * Keyed by route owner id, matching `pending-auth-failures.ts`'s
 * `pendingByOwner`, so sessions cannot cross-contaminate. Cleared from the
 * same teardown path as that registry
 * (`McpHttpProxyService.unregisterRoutesForSession` calls both
 * `clearPendingAuthFailures` and `clearAuthFailureToolNameCache`) rather
 * than introducing a second forever-unbounded process-global map — the
 * exact defect that teardown wiring exists to avoid.
 *
 * That teardown is only complete because BOTH keys are unregistered. The
 * proxy publishes failures under the route's own `sessionId`, but
 * `worktree-chat-turn.ts` calls `pairPendingAuthFailures(data, sessionKey)` for
 * every chat regardless of provider, so entries also accumulate under the chat
 * session key. Claude registers its proxy routes under that same key, so one
 * `unregisterRoutesForSession` covers it; Codex registers under a per-client
 * `codex-session:${key}:${randomUUID()}` owner id and therefore calls
 * `unregisterRoutesForSession` a SECOND time with `key`
 * (`codex-session.ts` `disposeSession`). Removing that second call
 * reintroduces an unbounded map on the Codex path.
 */
interface RecordedToolUse {
  name: string;
  /**
   * Which assistant message introduced this `tool_use`.
   *
   * Monotonic per route owner, bumped once per assistant event that carries at
   * least one `tool_use`, so every call in one parallel batch shares a value
   * and calls from different batches never do. See
   * {@link AuthFailurePairing.batchHasUnresolvedToolCalls}.
   *
   * Codex items arrive one per event, so each gets its own ordinal; sibling
   * detection for them is by {@link RecordedToolUse.origin} instead.
   */
  batch: number;
  /**
   * Which provider shape recorded this call. Codex exposes no batch, so an
   * errored Codex call treats EVERY other in-flight Codex dynamic tool call of
   * the same owner as a sibling — conservative on purpose, since the stop it
   * triggers is session-wide (see `batchHasUnresolvedCalls`).
   */
  origin: 'claude' | 'codex';
}

const toolNamesByRouteOwner = new Map<string, Map<string, RecordedToolUse>>();

/** Next batch ordinal per route owner. See {@link RecordedToolUse.batch}. */
const toolUseBatchSeqByRouteOwner = new Map<string, number>();

/**
 * Per-owner ceiling on remembered `tool_use_id -> name` pairs.
 *
 * Entries are normally short-lived — {@link forgetToolUseNames} drops each id
 * as soon as its `tool_result` streams — but a turn can be cancelled, a stream
 * truncated, or a `tool_use` can simply never produce a result, and a session
 * outlives many turns. This bounds the leak the way `pendingByOwner` bounds
 * its own with a TTL. Oldest-first eviction is safe because `Map` preserves
 * insertion order and a name is only ever needed by the result that follows it.
 */
const MAX_TOOL_NAMES_PER_OWNER = 512;

function nextBatch(routeOwnerId: string): number {
  const batch = (toolUseBatchSeqByRouteOwner.get(routeOwnerId) ?? 0) + 1;
  toolUseBatchSeqByRouteOwner.set(routeOwnerId, batch);
  return batch;
}

function rememberToolUse(
  routeOwnerId: string,
  toolUseId: string,
  recorded: RecordedToolUse,
): void {
  const existing = toolNamesByRouteOwner.get(routeOwnerId);
  if (!existing) {
    toolNamesByRouteOwner.set(routeOwnerId, new Map([[toolUseId, recorded]]));
    return;
  }
  existing.set(toolUseId, recorded);
  while (existing.size > MAX_TOOL_NAMES_PER_OWNER) {
    const oldest = existing.keys().next();
    if (oldest.done) break;
    existing.delete(oldest.value);
  }
}

function recordToolUseNames(routeOwnerId: string, event: unknown): void {
  const codexItem = readCodexDynamicToolItem(event);
  if (codexItem) {
    // Recorded on `item.started` and again on `item.completed`, because a
    // completion can arrive without its start having been forwarded (deferred
    // or replayed items) and the completion itself carries the tool name. A
    // re-record keeps the original ordinal so nothing is double-counted.
    const names = toolNamesByRouteOwner.get(routeOwnerId);
    if (names?.has(codexItem.toolUseId)) return;
    rememberToolUse(routeOwnerId, codexItem.toolUseId, {
      name: codexItem.tool,
      batch: nextBatch(routeOwnerId),
      origin: 'codex',
    });
    return;
  }

  const content = readMessageContent(event);
  if (!content) return;

  // One ordinal per assistant message, allocated lazily so an event with no
  // `tool_use` block does not consume one. Every call in the same parallel
  // batch therefore shares it.
  let batch: number | undefined;
  for (const entry of content) {
    if (!isRecord(entry)) continue;
    if (entry.type !== 'tool_use') continue;
    const { id, name } = entry;
    if (typeof id !== 'string' || typeof name !== 'string') continue;

    if (batch === undefined) batch = nextBatch(routeOwnerId);
    rememberToolUse(routeOwnerId, id, { name, batch, origin: 'claude' });
  }
}

/**
 * Drop the ids a `tool_result` just consumed. A `tool_use_id` correlates with
 * exactly one result, so nothing needs it afterwards.
 */
function forgetToolUseNames(
  routeOwnerId: string,
  results: readonly ToolResultEntry[],
): void {
  const names = toolNamesByRouteOwner.get(routeOwnerId);
  if (!names) return;
  for (const result of results) {
    names.delete(result.toolUseId);
  }
  if (names.size === 0) {
    toolNamesByRouteOwner.delete(routeOwnerId);
    toolUseBatchSeqByRouteOwner.delete(routeOwnerId);
  }
}

/**
 * Does any tool call from `batch` still have no landed result?
 *
 * Call BEFORE {@link forgetToolUseNames}, while the batch's own ids are still
 * in the cache, and pass the ids this event resolved. See
 * {@link AuthFailurePairing.batchHasUnresolvedToolCalls}.
 */
function batchHasUnresolvedCalls(
  routeOwnerId: string,
  errored: Pick<RecordedToolUse, 'batch' | 'origin'>,
  resolvedToolUseIds: ReadonlySet<string>,
): boolean {
  const names = toolNamesByRouteOwner.get(routeOwnerId);
  if (!names) return false;
  for (const [toolUseId, recorded] of Array.from(names.entries())) {
    if (resolvedToolUseIds.has(toolUseId)) continue;
    // Claude: siblings share the assistant message's ordinal. Codex: no batch
    // exists, so any other in-flight Codex dynamic tool call counts.
    const sibling =
      errored.origin === 'codex'
        ? recorded.origin === 'codex'
        : recorded.batch === errored.batch;
    if (sibling) return true;
  }
  return false;
}

/**
 * Drop the tool-name correlation cache for an owner, e.g. session teardown.
 * Call alongside `clearPendingAuthFailures` — see that function's doc
 * comment and `toolNamesByRouteOwner` above.
 */
export function clearAuthFailureToolNameCache(routeOwnerId: string): void {
  toolNamesByRouteOwner.delete(routeOwnerId);
  toolUseBatchSeqByRouteOwner.delete(routeOwnerId);
}

/**
 * Does this errored MCP result provably belong to `failure`?
 *
 * The provider names an MCP tool `mcp__<managed server name>__<tool>`, and the
 * managed name ends in a digest over
 * `['managed-mcp-server-name-v1', kind, ...identityParts]`
 * (`buildManagedMcpServerName`). Crucially the FRIENDLY LABEL does not enter
 * that digest, so it survives display-name churn and truncation, and a
 * standalone proxied server registers with
 * `identityParts = [definition.id, config.id]`
 * (`plugin-resolver.ts`) — precisely the pair `classifyMcpAuthFailure` stores
 * as `recovery.serverId` / `recovery.configId`. That makes the comparison an
 * exact identity check for the dominant case, not a heuristic on the label.
 *
 * It is a one-way test. A PLUGIN-provided server digests
 * `[marketplaceId, pluginName, serverName]` under the `plugin` kind, and its
 * `recovery` ids are halves of an unrelated sha256
 * (`plugin-mcp-auth.ts` `getPluginMcpOAuthIds`), so nothing computable from the
 * failure can reproduce it. `false` therefore means "unproven", never
 * "mismatched", which is why the caller uses this to RANK candidates and never
 * to reject them.
 *
 * Only the `proxy` kind is checked: pending failures are published solely by
 * the MCP HTTP proxy (`http-proxy-service.ts`), so a `dynamic` server — which
 * the provider connects to directly, without a Canopy route — has no path to
 * record one.
 */
function resultMatchesFailureIdentity(
  result: ErroredMcpResult,
  failure: AuthDependencyFailure,
): boolean {
  const { recovery } = failure;
  if (recovery.kind !== 'mcp_oauth') return false;
  // Split raw: `parseMcpToolName` normalizes the server segment and drops the
  // digest, so the name must be taken apart here instead.
  const serverName = result.rawToolName.split('__')[1];
  if (serverName === undefined) return false;
  const digest = readManagedMcpServerNameDigest(serverName);
  if (digest === null) return false;
  return (
    digest ===
    buildManagedMcpServerIdentityDigest({
      kind: 'proxy',
      identityParts: [recovery.serverId, recovery.configId],
    })
  );
}

/**
 * Collapse a claimed failure list to one entry per `dependencyId`, preserving
 * first-seen order so the primary stays at the head of the checklist.
 *
 * `Map.set` on an existing key keeps that key's position, which is what lets a
 * later RECOVERABLE entry replace an earlier non-recoverable one for the same
 * dependency without reordering the list. That replacement matters:
 * `classifyMcpAuthFailure` records a background 403 and a genuine 401 for the
 * same server into the same registry, and the row the user can act on is the
 * one worth rendering.
 */
function dedupeAuthFailures(
  values: readonly AuthDependencyFailure[],
): AuthDependencyFailure[] {
  const byDependency = new Map<string, AuthDependencyFailure>();
  for (const value of values) {
    const existing = byDependency.get(value.dependencyId);
    if (existing === undefined) {
      byDependency.set(value.dependencyId, value);
      continue;
    }
    if (existing.recovery.kind === 'none' && value.recovery.kind !== 'none') {
      byDependency.set(value.dependencyId, value);
    }
  }
  return Array.from(byDependency.values());
}

/**
 * Pair pending authentication failures with the errored tool call that
 * surfaced them.
 *
 * TWO FAMILIES, kept separate by the pending entry's anchor (CAN-1814 PR 4;
 * see `PendingAuthFailureAnchor` in `../mcp/pending-auth-failures`):
 *   - MCP proxy failures, matched against any errored MCP tool result by the
 *     heuristics documented below. The proxy knows only that some upstream
 *     server 401'd, so it cannot do better.
 *   - Canopy-injected tool failures (today `WatchGitHubItems` against an
 *     unauthenticated GitHub), matched against that tool's OWN errored result
 *     by canonical tool key. That is an exact identity match, not a heuristic,
 *     so none of the MCP caveats below apply to it.
 * Each family gets its own event, because each has its own proven attachment
 * target and merging them would render one dependency as a row under two cards.
 *
 * Claiming is destructive (see `claimPendingAuthFailures`), so a failure
 * attaches to exactly one turn. Nothing is claimed unless an errored tool
 * result resolves — via `toolNamesByRouteOwner` — to a name the corresponding
 * family accepts. Canopy's own injected tools are excluded from the MCP family
 * even under a brand whose namespace `parseMcpToolName` would accept, because
 * they are not third-party servers. Two failure modes this guards against:
 *   1. A background 401 consumed by an unrelated successful turn (no errored
 *      result at all).
 *   2. A background 401 misattached to a DIFFERENT, non-MCP tool's error
 *      (e.g. Bash, Read, Edit) that streamed before the real failing MCP
 *      tool result, INCLUDING inside the same batched `user` message — this
 *      both shows the wrong card and, because claiming is destructive,
 *      permanently loses the correct attachment.
 * An errored `tool_use_id` whose name was never captured (a resumed or
 * truncated stream) is skipped rather than ending the scan, and a batch in
 * which NO errored result resolves to a name the family accepts claims nothing
 * from that family at all. The
 * PENDING FAILURE survives that miss — it is never claimed — so a later,
 * correctly identified result inside
 * `PENDING_AUTH_FAILURE_TTL_MS` can still take it, and an unclaimed entry
 * is cleared at session teardown regardless; a wrong claim is not recoverable
 * the same way. The ids in the batch itself are NOT recoverable, because each
 * `tool_use_id` yields exactly one result and its name is forgotten with it —
 * which is precisely why the MCP result must be picked by name rather than by
 * position.
 *
 * When several errored MCP results are in play, the one whose managed server
 * name proves it belongs to the claimed failure is preferred — see
 * {@link resultMatchesFailureIdentity}. That preference is exact for standalone
 * proxied servers and simply never fires for plugin-provided ones.
 *
 * KNOWN LIMITATION, scoped to PLUGIN-PROVIDED servers: for those the failure
 * still attaches to the first errored MCP result regardless of which server it
 * names, because their digest is not recomputable from the failure (see
 * {@link resultMatchesFailureIdentity}). It is also still a preference rather
 * than a filter, so a turn whose only errored MCP result names a different
 * proxied server continues to claim the failure. Closing either properly means
 * carrying the managed server name (or the dependency id) on the proxy route so
 * the pairing key is exact for every registration site. See the
 * `KNOWN LIMITATION` test in `__tests__/auth-failure-event.test.ts`.
 *
 * Provider coverage differs BY FAMILY, not by module:
 *   - Injected-tool failures pair for both providers. They are recorded under
 *     the chat session key (`canopy-tools/core.ts`), which is exactly the
 *     `routeOwnerId` `worktree-chat-turn.ts` passes for every provider, and
 *     Codex surfaces the errored call as a `dynamic_tool_call` item that
 *     {@link readCodexDynamicToolItem} resolves to the transcript's
 *     `codex-<id>` block.
 *   - MCP-proxy failures remain Claude-only (CAN-1814). Codex records them
 *     under a per-client `codex-session:${sessionKey}:${randomUUID()}` route
 *     owner id minted in `codex-session.ts` that this module is never handed,
 *     so Codex `mcp_tool_call` items are deliberately not parsed: a branch
 *     that silently never matched would be worse than the honest gap.
 */
export function pairPendingAuthFailuresWithTool(
  event: unknown,
  routeOwnerId: string,
): AuthFailurePairing[] {
  recordToolUseNames(routeOwnerId, event);

  const results = readToolResultEntries(event);
  const errored = results.filter((result) => result.isError);
  if (errored.length === 0) {
    forgetToolUseNames(routeOwnerId, results);
    return [];
  }

  // Select on the resolved NAME, not on position. Claude batches parallel tool
  // results into one `user` message, so `[Bash (error), mcp__prod__query
  // (error)]` arrives as a single event; taking `errored[0]` picked `Bash`,
  // failed the MCP check, and dropped BOTH ids from the name cache in the same
  // call — making the attachment unrecoverable rather than deferred
  // (CAN-1814 review round 2).
  const names = toolNamesByRouteOwner.get(routeOwnerId);
  const erroredMcpResults: ErroredMcpResult[] = [];
  const erroredInjectedResults: ErroredInjectedToolResult[] = [];
  for (const result of errored) {
    const recorded = names?.get(result.toolUseId);
    if (recorded === undefined) continue;
    const { name: rawToolName, batch, origin } = recorded;
    // Canopy's OWN injected tools are checked first and are never treated as
    // MCP anchors, even though Claude reaches them over a branded MCP HTTP
    // server whose namespace `parseMcpToolName` accepts. They are not
    // third-party servers, so an errored `ShowFiles` must not claim some
    // upstream server's 401 (CAN-1814 PR 4).
    const toolKey = getCanonicalCanopyToolKey(rawToolName);
    if (toolKey !== null) {
      erroredInjectedResults.push({
        toolUseId: result.toolUseId,
        rawToolName,
        toolKey,
        batch,
        origin,
      });
      continue;
    }
    if (parseMcpToolName(rawToolName) === null) continue;
    erroredMcpResults.push({
      toolUseId: result.toolUseId,
      rawToolName,
      batch,
      origin,
    });
  }

  // Computed BEFORE `forgetToolUseNames` clears this event's ids, and keyed on
  // each errored call's own batch. See
  // `AuthFailurePairing.batchHasUnresolvedToolCalls`.
  const resolvedToolUseIds = new Set(results.map((entry) => entry.toolUseId));
  const unresolvedByBatch = new Map<number, boolean>();
  for (const entry of [...erroredMcpResults, ...erroredInjectedResults]) {
    if (unresolvedByBatch.has(entry.batch)) continue;
    unresolvedByBatch.set(
      entry.batch,
      batchHasUnresolvedCalls(routeOwnerId, entry, resolvedToolUseIds),
    );
  }

  forgetToolUseNames(routeOwnerId, results);
  if (erroredMcpResults.length === 0 && erroredInjectedResults.length === 0) {
    return [];
  }

  // Only claim what this batch can actually anchor. An entry the batch cannot
  // attach is LEFT PENDING for a later result rather than claimed and
  // misattached — claiming is destructive, so a wrong claim is permanent while
  // a deferred one is not.
  const claimed = claimPendingAuthFailures(routeOwnerId, {
    canClaim: (anchor) =>
      anchor.kind === 'mcp'
        ? erroredMcpResults.length > 0
        : erroredInjectedResults.some(
            (result) => result.toolKey === anchor.toolKey,
          ),
  });
  if (claimed.length === 0) return [];

  const failures = claimed
    .filter((entry) => entry.anchor.kind === 'mcp')
    .map((entry) => entry.failure);
  const injectedClaims = claimed.filter(
    (entry) => entry.anchor.kind === 'injected-tool',
  );

  const pairings: AuthFailurePairing[] = [];

  if (failures.length > 0) {
    // Still exactly ONE event for the MCP family, carrying every claimed
    // dependency (CAN-1814 PR 2). The alternative — one event per dependency —
    // needs a distinct attachment target each, and a turn does not necessarily
    // have one: N pending failures can surface through a single errored MCP
    // result, and two events sharing a `toolUseId` overwrote each other. The
    // checklist is also a single card with a row per dependency, so a single
    // anchor is what it renders from. Claiming is destructive, so anything not
    // carried here is lost, not deferred.
    //
    // The PRIMARY failure keeps its existing selection rules, because it is
    // what a reader predating the array still shows, and it leads the
    // checklist.
    //
    // Prefer a RECOVERABLE entry, not merely the first. `classifyMcpAuthFailure`
    // records non-recoverable 403s into the same registry and `Map` iterates in
    // insertion order, so a background 403 from `initialize`/`tools/list` on one
    // server recorded before the genuine 401 on another would otherwise win on
    // ordering alone — and because the claim is destructive, the 401 that
    // actually blocked the turn would be dropped, leaving no CTA at all.
    //
    // Picking `selected` first and only then matching a result meant that when
    // the chosen failure had no matching result, the fallback paired it with an
    // unrelated server's tool call — naming the wrong server AND destroying the
    // right failure, since the claim is destructive (CAN-1814 review round 4).
    //
    // An identity-proven pair is the truth: that result demonstrably belongs to
    // that failure. It therefore outranks recoverability — pairing a different
    // server's failure onto this tool call is wrong even when that other failure
    // would have rendered a CTA. Within proven pairs a recoverable one is
    // preferred, so a background 403 cannot shadow a genuine 401 on the same
    // server.
    const provenPairs = erroredMcpResults.flatMap((result) =>
      failures
        .filter((candidate) => resultMatchesFailureIdentity(result, candidate))
        .map((candidate) => ({ result, failure: candidate })),
    );
    const provenPair =
      provenPairs.find((pair) => pair.failure.recovery.kind !== 'none') ??
      provenPairs[0];

    // No pair proves itself — the plugin case, whose digest is not recomputable,
    // and any non-managed tool name. Fall back to the previous heuristics
    // unchanged: recoverable-preferred failure, first errored MCP result. A
    // preference rather than a requirement, because requiring proof would drop
    // every plugin-provided server's CTA entirely.
    const selected =
      provenPair?.failure ??
      failures.find((candidate) => candidate.recovery.kind !== 'none') ??
      failures[0];
    const primary = provenPair?.result ?? erroredMcpResults[0];
    pairings.push({
      event: {
        type: CANOPY_AUTH_FAILURE_EVENT_TYPE,
        toolUseId: primary.toolUseId,
        failure: selected,
        failures: dedupeAuthFailures([selected, ...failures]),
      },
      toolName: primary.rawToolName,
      batchHasUnresolvedToolCalls:
        unresolvedByBatch.get(primary.batch) === true,
    });
  }

  // One event per errored injected tool, NOT one shared with the MCP family:
  // each has its own proven attachment target, and merging them would render
  // the same dependency as a row under two different cards.
  const injectedByResult = new Map<
    string,
    { result: ErroredInjectedToolResult; failures: AuthDependencyFailure[] }
  >();
  for (const entry of injectedClaims) {
    const { anchor } = entry;
    if (anchor.kind !== 'injected-tool') continue;
    const result = erroredInjectedResults.find(
      (candidate) => candidate.toolKey === anchor.toolKey,
    );
    if (result === undefined) continue;
    const group = injectedByResult.get(result.toolUseId);
    if (group === undefined) {
      injectedByResult.set(result.toolUseId, {
        result,
        failures: [entry.failure],
      });
      continue;
    }
    group.failures.push(entry.failure);
  }
  for (const group of Array.from(injectedByResult.values())) {
    const deduped = dedupeAuthFailures(group.failures);
    // Same recoverable-first rule the MCP branch uses, for the same reason: the
    // primary is what a reader predating the array renders, so a row with a
    // usable action must not be shadowed by one without.
    const selected =
      deduped.find((candidate) => candidate.recovery.kind !== 'none') ??
      deduped[0];
    if (selected === undefined) continue;
    pairings.push({
      event: {
        type: CANOPY_AUTH_FAILURE_EVENT_TYPE,
        toolUseId: group.result.toolUseId,
        failure: selected,
        failures: dedupeAuthFailures([selected, ...deduped]),
      },
      toolName: group.result.rawToolName,
      batchHasUnresolvedToolCalls:
        unresolvedByBatch.get(group.result.batch) === true,
    });
  }

  return pairings;
}

/**
 * The chat-event view of {@link pairPendingAuthFailuresWithTool}.
 *
 * Kept as the narrow default because `toolName` is a MAIN-PROCESS concern —
 * it decides whether the interrupted work was safe to repeat (CAN-1814 PR 6)
 * — and must not leak onto the wire envelope that crosses into the transcript
 * and the web Portal.
 */
export function pairPendingAuthFailures(
  event: unknown,
  routeOwnerId: string,
): CanopyAuthFailureEventData[] {
  return pairPendingAuthFailuresWithTool(event, routeOwnerId).map(
    (pairing) => pairing.event,
  );
}
