import type { AuthDependencyFailure } from '@canopy/protocol/auth-recovery';
import { buildManagedMcpServerName } from '@canopy/desktop-shared/node/plugins/mcp-server-name';
import {
  claimPendingAuthFailures,
  clearPendingAuthFailures,
  PENDING_AUTH_FAILURE_TTL_MS,
  recordPendingInjectedToolAuthFailure,
  recordPendingMcpAuthFailure,
} from '../../mcp/pending-auth-failures';
import {
  pairPendingAuthFailures,
  pairPendingAuthFailuresWithTool,
} from '../auth-failure-event';

const failure: AuthDependencyFailure = {
  dependencyClass: 'mcp',
  dependencyId: 'srv-1:cfg-1',
  displayName: 'Prod MCP server',
  failureClass: 'expired',
  recovery: { kind: 'mcp_oauth', serverId: 'srv-1', configId: 'cfg-1' },
};

/**
 * The tool name a Claude session actually sees for a standalone proxied MCP
 * server: `mcp__<managed server name>__<tool>`, where the managed name ends in
 * a digest over `['managed-mcp-server-name-v1', 'proxy', serverId, configId]`
 * (`plugin-resolver.ts` registers the proxy route with
 * `identityParts = [definition.id, config.id]`, the same pair
 * `classifyMcpAuthFailure` stores on `recovery`).
 */
function proxiedMcpToolName(
  serverId: string,
  configId: string,
  friendlyLabel: string,
  tool = 'query',
): string {
  const serverName = buildManagedMcpServerName({
    kind: 'proxy',
    friendlyParts: [friendlyLabel],
    identityParts: [serverId, configId],
  });
  return `mcp__${serverName}__${tool}`;
}

/**
 * The plugin-provided counterpart. `identityParts` are
 * `[marketplaceId, pluginName, serverName]` under the `plugin` kind, none of
 * which the failure carries, so its digest is NOT recomputable from
 * `recovery.serverId`/`configId` — the case the preference must fall back on
 * rather than exclude.
 */
function pluginMcpToolName(
  marketplaceId: string,
  pluginName: string,
  serverName: string,
  tool = 'query',
): string {
  const managed = buildManagedMcpServerName({
    kind: 'plugin',
    friendlyParts: [pluginName, serverName],
    identityParts: [marketplaceId, pluginName, serverName],
  });
  return `mcp__${managed}__${tool}`;
}

/**
 * A streamed assistant message carrying a `tool_use` block, matching the
 * Claude Agent SDK shape. `pairPendingAuthFailures` must observe one of these
 * before it can resolve an errored `tool_use_id` to a tool name.
 */
function assistantToolUse(toolUseId: string, toolName: string): unknown {
  return {
    type: 'assistant',
    message: {
      content: [
        {
          type: 'tool_use',
          id: toolUseId,
          name: toolName,
          input: {},
        },
      ],
    },
  };
}

/**
 * The parallel-batch shape: ONE assistant message carrying several `tool_use`
 * blocks. Claude issues parallel tool calls this way, which is what makes a
 * session-wide cancel able to kill a sibling that has not finished.
 */
function assistantToolUseBatch(
  entries: readonly { toolUseId: string; toolName: string }[],
): unknown {
  return {
    type: 'assistant',
    message: {
      content: entries.map((entry) => ({
        type: 'tool_use',
        id: entry.toolUseId,
        name: entry.toolName,
        input: {},
      })),
    },
  };
}

function toolResultBlock(toolUseId: string, isError: boolean): unknown {
  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    is_error: isError,
    content: isError ? 'HTTP 401' : 'ok',
  };
}

function toolResult(toolUseId: string, isError: boolean): unknown {
  return {
    type: 'user',
    message: { content: [toolResultBlock(toolUseId, isError)] },
  };
}

/**
 * Claude batches the results of parallel tool calls into ONE `user` message,
 * so a turn that ran `Bash` and an MCP tool together delivers both
 * `tool_result` blocks in a single event.
 */
function batchedToolResults(
  entries: readonly { toolUseId: string; isError: boolean }[],
): unknown {
  return {
    type: 'user',
    message: {
      content: entries.map((entry) =>
        toolResultBlock(entry.toolUseId, entry.isError),
      ),
    },
  };
}

describe('pairPendingAuthFailures', () => {
  afterEach(() => clearPendingAuthFailures('owner-a'));

  it('pairs a pending failure with the errored tool_use id', () => {
    recordPendingMcpAuthFailure('owner-a', failure);
    pairPendingAuthFailures(
      assistantToolUse('tu-1', 'mcp__prod__query'),
      'owner-a',
    );
    const out = pairPendingAuthFailures(toolResult('tu-1', true), 'owner-a');
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe('canopy_auth_failure');
    expect(out[0].toolUseId).toBe('tu-1');
    expect(out[0].failure.displayName).toBe('Prod MCP server');
  });

  it('emits one event carrying every pending dependency (CAN-1814 PR 2)', () => {
    // One event, not N: two events under the same `toolUseId` overwrote each
    // other, and a turn does not necessarily have a second attachment target.
    // Claiming is destructive, so a dependency left out of this array is LOST,
    // which is exactly what the multi-blocker checklist exists to stop.
    recordPendingMcpAuthFailure('owner-a', failure);
    recordPendingMcpAuthFailure('owner-a', {
      ...failure,
      dependencyId: 'srv-2:cfg-1',
      displayName: 'Other MCP server',
      recovery: { kind: 'mcp_oauth', serverId: 'srv-2', configId: 'cfg-1' },
    });
    pairPendingAuthFailures(
      assistantToolUse('tu-1', 'mcp__prod__query'),
      'owner-a',
    );

    const out = pairPendingAuthFailures(toolResult('tu-1', true), 'owner-a');

    expect(out).toHaveLength(1);
    // The primary keeps its existing selection rules and leads the checklist,
    // because it is what a reader predating the array still renders.
    expect(out[0].failure.dependencyId).toBe('srv-1:cfg-1');
    expect(out[0].failures?.map((entry) => entry.dependencyId)).toEqual([
      'srv-1:cfg-1',
      'srv-2:cfg-1',
    ]);
    // Claiming stays destructive, so nothing is left behind to be
    // misattributed to a later turn.
    expect(claimPendingAuthFailures('owner-a')).toEqual([]);
  });

  it('collapses two claims for one dependency, keeping the actionable one', () => {
    // `classifyMcpAuthFailure` can record both a background 403 and a genuine
    // 401 for the SAME server. Two checklist rows would offer two logins for
    // one token, and the row worth rendering is the one the user can act on.
    recordPendingMcpAuthFailure('owner-a', {
      ...failure,
      failureClass: 'insufficient_scope',
      recovery: { kind: 'none' },
    });
    recordPendingMcpAuthFailure('owner-a', failure);
    pairPendingAuthFailures(
      assistantToolUse('tu-1', 'mcp__prod__query'),
      'owner-a',
    );

    const out = pairPendingAuthFailures(toolResult('tu-1', true), 'owner-a');

    expect(out[0].failures).toHaveLength(1);
    expect(out[0].failures?.[0].recovery.kind).toBe('mcp_oauth');
  });

  it('carries a non-recoverable dependency as its own checklist row', () => {
    // A row logging in cannot fix is still worth naming: without it the user
    // reconnects the one server the card mentions and the turn fails again.
    recordPendingMcpAuthFailure('owner-a', failure);
    recordPendingMcpAuthFailure('owner-a', {
      dependencyClass: 'mcp',
      dependencyId: 'srv-quota:cfg-1',
      displayName: 'Metered MCP server',
      failureClass: 'quota_exceeded',
      recovery: { kind: 'none' },
    });
    pairPendingAuthFailures(
      assistantToolUse('tu-1', 'mcp__prod__query'),
      'owner-a',
    );

    const out = pairPendingAuthFailures(toolResult('tu-1', true), 'owner-a');

    expect(out[0].failure.dependencyId).toBe('srv-1:cfg-1');
    expect(out[0].failures?.map((entry) => entry.dependencyId)).toEqual([
      'srv-1:cfg-1',
      'srv-quota:cfg-1',
    ]);
  });

  it('prefers a recoverable pending failure over a non-recoverable one', () => {
    // `classifyMcpAuthFailure` records non-recoverable 403s into the same
    // registry, and `Map` iterates in insertion order. A background 403 on
    // server A recorded from `tools/list` before the genuine 401 on server B
    // used to win purely on ordering, and the claim is destructive — so the
    // failure that actually blocked the turn was discarded and the user got no
    // CTA at all.
    recordPendingMcpAuthFailure('owner-a', {
      dependencyClass: 'mcp',
      dependencyId: 'srv-a:cfg-1',
      displayName: 'Scope-limited MCP server',
      failureClass: 'insufficient_scope',
      recovery: { kind: 'none' },
    });
    recordPendingMcpAuthFailure('owner-a', failure);
    pairPendingAuthFailures(
      assistantToolUse('tu-1', 'mcp__prod__query'),
      'owner-a',
    );

    const out = pairPendingAuthFailures(toolResult('tu-1', true), 'owner-a');

    expect(out).toHaveLength(1);
    expect(out[0].failure.dependencyId).toBe('srv-1:cfg-1');
    expect(out[0].failure.recovery.kind).toBe('mcp_oauth');
  });

  it('still emits a non-recoverable failure when that is all there is', () => {
    recordPendingMcpAuthFailure('owner-a', {
      dependencyClass: 'mcp',
      dependencyId: 'srv-a:cfg-1',
      displayName: 'Scope-limited MCP server',
      failureClass: 'insufficient_scope',
      recovery: { kind: 'none' },
    });
    pairPendingAuthFailures(
      assistantToolUse('tu-1', 'mcp__prod__query'),
      'owner-a',
    );

    const out = pairPendingAuthFailures(toolResult('tu-1', true), 'owner-a');

    expect(out).toHaveLength(1);
    expect(out[0].failure.dependencyId).toBe('srv-a:cfg-1');
  });

  it('does not pair a stale pending failure recorded long before the turn', () => {
    // A 401 from `initialize` / `tools/list` / an SSE reconnect has no errored
    // tool result to claim it, and sessions outlive many turns.
    recordPendingMcpAuthFailure(
      'owner-a',
      failure,
      Date.now() - (PENDING_AUTH_FAILURE_TTL_MS + 1),
    );
    pairPendingAuthFailures(
      assistantToolUse('tu-1', 'mcp__prod__query'),
      'owner-a',
    );
    expect(
      pairPendingAuthFailures(toolResult('tu-1', true), 'owner-a'),
    ).toEqual([]);
  });

  it('forgets a tool_use id once its result has streamed', () => {
    // The name cache is process-global and, unlike `pendingByOwner`, had no
    // bound or TTL — it grew for the life of a session and was evicted only at
    // teardown. A `tool_use_id` correlates with exactly one result, so nothing
    // needs it afterwards (CAN-1814 review).
    recordPendingMcpAuthFailure('owner-a', failure);
    pairPendingAuthFailures(
      assistantToolUse('tu-1', 'mcp__prod__query'),
      'owner-a',
    );
    expect(
      pairPendingAuthFailures(toolResult('tu-1', true), 'owner-a'),
    ).toHaveLength(1);

    // A replayed result for the same id can no longer resolve a tool name, so
    // it fails closed instead of claiming a later failure.
    recordPendingMcpAuthFailure('owner-a', failure);
    expect(
      pairPendingAuthFailures(toolResult('tu-1', true), 'owner-a'),
    ).toEqual([]);
    expect(claimPendingAuthFailures('owner-a')).toHaveLength(1);
  });

  it('evicts the oldest tool names once the per-owner cap is exceeded', () => {
    for (let i = 0; i < 600; i += 1) {
      pairPendingAuthFailures(
        assistantToolUse(`tu-${String(i)}`, 'mcp__prod__query'),
        'owner-a',
      );
    }
    recordPendingMcpAuthFailure('owner-a', failure);

    // The oldest id is gone, so it fails closed...
    expect(
      pairPendingAuthFailures(toolResult('tu-0', true), 'owner-a'),
    ).toEqual([]);
    // ...while a recent one still resolves.
    expect(
      pairPendingAuthFailures(toolResult('tu-599', true), 'owner-a'),
    ).toHaveLength(1);
  });

  it('emits nothing when no failure is pending', () => {
    pairPendingAuthFailures(
      assistantToolUse('tu-1', 'mcp__prod__query'),
      'owner-a',
    );
    expect(
      pairPendingAuthFailures(toolResult('tu-1', true), 'owner-a'),
    ).toEqual([]);
  });

  it('does not claim a pending failure for a successful tool result', () => {
    recordPendingMcpAuthFailure('owner-a', failure);
    pairPendingAuthFailures(
      assistantToolUse('tu-1', 'mcp__prod__query'),
      'owner-a',
    );
    expect(
      pairPendingAuthFailures(toolResult('tu-1', false), 'owner-a'),
    ).toEqual([]);
    // The failure must still be pending: a successful result must not
    // silently consume it, or the real errored MCP result could never
    // claim it.
    expect(claimPendingAuthFailures('owner-a')).toHaveLength(1);
  });

  it('ignores events that are not tool results', () => {
    expect(pairPendingAuthFailures({ type: 'assistant' }, 'owner-a')).toEqual(
      [],
    );
  });

  it('does not pair an errored non-MCP tool result, even with a pending failure', () => {
    // Regression for CAN-1814 fix-round-1: before tool-name correlation was
    // added, ANY errored tool_result claimed a pending failure regardless of
    // which tool produced it. A pending MCP 401 must not attach to an
    // unrelated Bash/Read/Edit error.
    recordPendingMcpAuthFailure('owner-a', failure);
    pairPendingAuthFailures(assistantToolUse('tu-1', 'Bash'), 'owner-a');
    expect(
      pairPendingAuthFailures(toolResult('tu-1', true), 'owner-a'),
    ).toEqual([]);
    // The failure must survive the misattribution attempt so a later,
    // correctly identified MCP result can still claim it.
    expect(claimPendingAuthFailures('owner-a')).toHaveLength(1);
  });

  it('pairs the MCP result in a batch that also carries an errored non-MCP result', () => {
    // Claude delivers parallel tool results in ONE `user` message. Selecting
    // `errored[0]` picked whichever errored result streamed first — `Bash`
    // here — so the pairing failed AND `forgetToolUseNames` dropped the MCP
    // id in the same call, making the attachment unrecoverable rather than
    // merely deferred (CAN-1814 review round 2).
    recordPendingMcpAuthFailure('owner-a', failure);
    pairPendingAuthFailures(assistantToolUse('tu-bash', 'Bash'), 'owner-a');
    pairPendingAuthFailures(
      assistantToolUse('tu-mcp', 'mcp__prod__query'),
      'owner-a',
    );

    const out = pairPendingAuthFailures(
      batchedToolResults([
        { toolUseId: 'tu-bash', isError: true },
        { toolUseId: 'tu-mcp', isError: true },
      ]),
      'owner-a',
    );

    expect(out).toHaveLength(1);
    expect(out[0].toolUseId).toBe('tu-mcp');
    expect(out[0].failure.dependencyId).toBe('srv-1:cfg-1');
  });

  it('pairs the MCP result in a batch whose non-MCP sibling name was never seen', () => {
    // Same batch, but the `Bash` tool_use was never observed (resumed or
    // truncated stream). An unresolvable id must be skipped rather than
    // ending the scan.
    recordPendingMcpAuthFailure('owner-a', failure);
    pairPendingAuthFailures(
      assistantToolUse('tu-mcp', 'mcp__prod__query'),
      'owner-a',
    );

    const out = pairPendingAuthFailures(
      batchedToolResults([
        { toolUseId: 'tu-unseen', isError: true },
        { toolUseId: 'tu-mcp', isError: true },
      ]),
      'owner-a',
    );

    expect(out).toHaveLength(1);
    expect(out[0].toolUseId).toBe('tu-mcp');
  });

  it('pairs the failure whose server actually errored when several are pending', () => {
    // CAN-1814 review round 4 (failure-side residue). `selected` used to be
    // chosen from the pending failures FIRST -- recoverable-then-insertion-order
    // -- and only then was a result matched against it. With two recoverable
    // failures pending and only the SECOND server's tool erroring, `selected`
    // resolved to srv-1, no result proved srv-1, and the fallback paired
    // srv-1's failure with srv-2's tool call. Because the claim is destructive,
    // srv-2's real 401 was dropped and the emitted event named the wrong
    // server -- which becomes a wrong reconnect target in PR 2.
    recordPendingMcpAuthFailure('owner-a', failure); // srv-1, recorded first
    recordPendingMcpAuthFailure('owner-a', {
      ...failure,
      dependencyId: 'srv-2:cfg-2',
      displayName: 'Second server',
      recovery: { kind: 'mcp_oauth', serverId: 'srv-2', configId: 'cfg-2' },
    });
    pairPendingAuthFailures(
      assistantToolUse(
        'tu-second',
        proxiedMcpToolName('srv-2', 'cfg-2', 'Second server'),
      ),
      'owner-a',
    );

    const out = pairPendingAuthFailures(
      toolResult('tu-second', true),
      'owner-a',
    );

    expect(out).toHaveLength(1);
    expect(out[0].toolUseId).toBe('tu-second');
    expect(out[0].failure.recovery).toEqual({
      kind: 'mcp_oauth',
      serverId: 'srv-2',
      configId: 'cfg-2',
    });
  });

  it('KNOWN LIMITATION: an unmatchable errored MCP tool still claims a pending failure', () => {
    // Pinning current behavior, not endorsing it (CAN-1814 review round 2,
    // rationale corrected in round 3).
    //
    // Identity matching IS available for standalone proxied servers and is now
    // applied as a preference — see the three tests above. What remains is the
    // fallback: when NO errored MCP result proves it belongs to the failure,
    // the first one still claims it, and the claim is destructive, so the
    // correct attachment is destroyed. Two shapes reach this:
    //   - a plugin-provided server, whose managed name digests
    //     `[marketplaceId, pluginName, serverName]` under the `plugin` kind
    //     while its `recovery` ids are halves of an unrelated sha256
    //     (`plugin-mcp-auth.ts` `getPluginMcpOAuthIds`) — nothing computable
    //     from the failure can reproduce that digest;
    //   - any tool name that is not a managed one at all, as here.
    // Reachable with two OAuth MCP servers in one chat inside
    // `PENDING_AUTH_FAILURE_TTL_MS`.
    //
    // NARROWED in round 4: the failure-side half of this residue is fixed. The
    // pair is now chosen jointly, so a pending failure can no longer be paired
    // with an unrelated server's tool call whenever SOME pair proves itself.
    // What remains is only the case below, where NO pair can prove itself at
    // all — the digest is not recomputable (plugin servers) or the tool name is
    // not a managed one.
    //
    // The match is deliberately a PREFERENCE and not a filter: making it a
    // requirement would refuse to pair for every plugin-provided server, which
    // silently removes the only user-visible surface this feature ships.
    // Fixing the residue properly means carrying the managed server name (or
    // the dependency id) on the proxy route so the pairing key is exact for
    // every registration site.
    recordPendingMcpAuthFailure('owner-a', failure);
    pairPendingAuthFailures(
      assistantToolUse('tu-other', 'mcp__other-server__ping'),
      'owner-a',
    );

    const out = pairPendingAuthFailures(
      toolResult('tu-other', true),
      'owner-a',
    );

    expect(out).toHaveLength(1);
    expect(out[0].toolUseId).toBe('tu-other');
    expect(out[0].failure.recovery).toEqual({
      kind: 'mcp_oauth',
      serverId: 'srv-1',
      configId: 'cfg-1',
    });
  });

  it('prefers the errored MCP result whose managed name matches the failure', () => {
    // `buildManagedMcpServerName` digests `identityParts` ONLY — the friendly
    // label never enters the hash — and a standalone proxied server registers
    // with `identityParts = [definition.id, config.id]`, exactly the pair
    // `classifyMcpAuthFailure` writes onto `recovery`. So the raw tool name
    // cached in `toolNamesByRouteOwner` is an EXACT identity match for the
    // pending failure, and a batch carrying two errored MCP results must pick
    // the matching one rather than whichever streamed first.
    recordPendingMcpAuthFailure('owner-a', failure);
    pairPendingAuthFailures(
      assistantToolUse(
        'tu-other',
        proxiedMcpToolName('srv-2', 'cfg-2', 'Other server'),
      ),
      'owner-a',
    );
    pairPendingAuthFailures(
      assistantToolUse(
        'tu-match',
        proxiedMcpToolName('srv-1', 'cfg-1', 'Prod MCP server'),
      ),
      'owner-a',
    );

    const out = pairPendingAuthFailures(
      batchedToolResults([
        { toolUseId: 'tu-other', isError: true },
        { toolUseId: 'tu-match', isError: true },
      ]),
      'owner-a',
    );

    expect(out).toHaveLength(1);
    expect(out[0].toolUseId).toBe('tu-match');
    expect(out[0].failure.recovery).toEqual({
      kind: 'mcp_oauth',
      serverId: 'srv-1',
      configId: 'cfg-1',
    });
  });

  it('matches on identity, not on the friendly label in the managed name', () => {
    // The label is truncated, lowercased and collapsed before it is baked into
    // the name, and it is NOT part of the digest. A server whose display name
    // shares nothing with `failure.displayName` still matches on identity.
    recordPendingMcpAuthFailure('owner-a', failure);
    pairPendingAuthFailures(
      assistantToolUse('tu-decoy', 'mcp__prod-mcp-server__query'),
      'owner-a',
    );
    pairPendingAuthFailures(
      assistantToolUse(
        'tu-match',
        proxiedMcpToolName('srv-1', 'cfg-1', 'Totally Different Label!!'),
      ),
      'owner-a',
    );

    const out = pairPendingAuthFailures(
      batchedToolResults([
        { toolUseId: 'tu-decoy', isError: true },
        { toolUseId: 'tu-match', isError: true },
      ]),
      'owner-a',
    );

    expect(out).toHaveLength(1);
    expect(out[0].toolUseId).toBe('tu-match');
  });

  it('falls back to the first errored MCP result for a plugin-provided server', () => {
    // A plugin server's digest is taken over
    // `[marketplaceId, pluginName, serverName]`, and its `recovery.serverId` /
    // `configId` are halves of a DIFFERENT sha256
    // (`plugin-mcp-auth.ts` `getPluginMcpOAuthIds`), so no digest the failure
    // can compute will ever match it. The preference must therefore degrade to
    // today's first-MCP-result behavior rather than refusing to pair — which
    // is what makes it a preference with no false-negative risk.
    recordPendingMcpAuthFailure('owner-a', failure);
    pairPendingAuthFailures(
      assistantToolUse(
        'tu-plugin',
        pluginMcpToolName('mkt-1', 'my-plugin', 'srv'),
      ),
      'owner-a',
    );

    const out = pairPendingAuthFailures(
      toolResult('tu-plugin', true),
      'owner-a',
    );

    expect(out).toHaveLength(1);
    expect(out[0].toolUseId).toBe('tu-plugin');
    expect(out[0].failure.recovery).toEqual({
      kind: 'mcp_oauth',
      serverId: 'srv-1',
      configId: 'cfg-1',
    });
  });

  it('does not pair an errored tool result whose name was never captured', () => {
    // Fail closed: a resumed or truncated stream can surface a tool_result
    // whose preceding tool_use was never observed in this process. Claiming
    // is destructive, so guessing would risk losing the failure forever;
    // leaving it pending lets a later, correctly identified result claim it,
    // and an unclaimed entry is cleared at session teardown regardless.
    recordPendingMcpAuthFailure('owner-a', failure);
    expect(
      pairPendingAuthFailures(toolResult('tu-unseen', true), 'owner-a'),
    ).toEqual([]);
    expect(claimPendingAuthFailures('owner-a')).toHaveLength(1);
  });
});

/**
 * CAN-1814 PR 4. A Canopy-injected tool that fails on a first-party
 * integration (today: `WatchGitHubItems` against an unauthenticated GitHub)
 * publishes into the SAME pending registry the MCP proxy uses, for the same
 * reason: the executor runs before its own `tool_result` block exists, and the
 * `toolUseId` it is handed on the Claude path is the MCP transport's JSON-RPC
 * id, not the transcript's `tool_use` id.
 *
 * What differs is attribution. The injected entry names the tool that failed,
 * so it may only be claimed by that tool's own errored result — an exact
 * identity match, unlike the MCP path's heuristic.
 */
describe('pairPendingAuthFailures — Canopy-injected tool failures (CAN-1814 PR 4)', () => {
  afterEach(() => clearPendingAuthFailures('owner-a'));

  const githubFailure: AuthDependencyFailure = {
    dependencyClass: 'integration',
    dependencyId: 'integration:github',
    displayName: 'GitHub',
    failureClass: 'unauthenticated',
    recovery: { kind: 'github_login' },
  };

  // Claude sees Canopy's own injected tools over the branded MCP HTTP server,
  // so the raw name is `mcp__<namespace>__WatchGitHubItems` regardless of
  // brand — `getCanonicalCanopyToolKey` resolves it either way.
  const WATCH_TOOL_NAME = 'mcp__canopy__WatchGitHubItems';

  it('pairs an injected-tool failure with that tool’s own errored result', () => {
    recordPendingInjectedToolAuthFailure(
      'owner-a',
      'watch_github_items',
      githubFailure,
    );
    pairPendingAuthFailuresWithTool(
      assistantToolUse('tu-gh', WATCH_TOOL_NAME),
      'owner-a',
    );

    const out = pairPendingAuthFailuresWithTool(
      toolResult('tu-gh', true),
      'owner-a',
    );

    expect(out).toHaveLength(1);
    expect(out[0].toolName).toBe(WATCH_TOOL_NAME);
    expect(out[0].event.toolUseId).toBe('tu-gh');
    expect(out[0].event.failure.dependencyClass).toBe('integration');
    expect(out[0].event.failure.recovery).toEqual({ kind: 'github_login' });
    expect(out[0].event.failures).toEqual([githubFailure]);
  });

  it('does not let an unrelated errored MCP result claim an injected-tool failure', () => {
    // Claiming is destructive. Attaching "GitHub needs to be reconnected" to
    // some other server's failed query would name the wrong tool AND destroy
    // the entry the real `WatchGitHubItems` result was going to take.
    recordPendingInjectedToolAuthFailure(
      'owner-a',
      'watch_github_items',
      githubFailure,
    );
    pairPendingAuthFailuresWithTool(
      assistantToolUse('tu-mcp', 'mcp__prod__query'),
      'owner-a',
    );

    expect(
      pairPendingAuthFailuresWithTool(toolResult('tu-mcp', true), 'owner-a'),
    ).toEqual([]);

    // Still pending, so the tool that actually failed can still claim it.
    pairPendingAuthFailuresWithTool(
      assistantToolUse('tu-gh', WATCH_TOOL_NAME),
      'owner-a',
    );
    expect(
      pairPendingAuthFailuresWithTool(toolResult('tu-gh', true), 'owner-a'),
    ).toHaveLength(1);
  });

  it('does not let an errored Canopy-injected result claim an MCP failure', () => {
    // The mirror image, and the reason Canopy's own tools are excluded from
    // the MCP anchor set even under a brand whose namespace `parseMcpToolName`
    // would otherwise accept: they are not third-party MCP servers.
    recordPendingMcpAuthFailure('owner-a', failure);
    pairPendingAuthFailuresWithTool(
      assistantToolUse('tu-gh', 'mcp__unstoppable-code__WatchGitHubItems'),
      'owner-a',
    );

    expect(
      pairPendingAuthFailuresWithTool(toolResult('tu-gh', true), 'owner-a'),
    ).toEqual([]);
    expect(claimPendingAuthFailures('owner-a')).toHaveLength(1);
  });

  it('emits one event per family when both kinds are blocked in the same batch', () => {
    // Two anchors, two attachment targets, so two events — unlike the
    // multi-MCP case, which shares one target and therefore one card.
    // Crucially each event carries ONLY its own family, so the checklist does
    // not render the same dependency twice under two cards.
    recordPendingMcpAuthFailure('owner-a', failure);
    recordPendingInjectedToolAuthFailure(
      'owner-a',
      'watch_github_items',
      githubFailure,
    );
    pairPendingAuthFailuresWithTool(
      assistantToolUse('tu-mcp', 'mcp__prod__query'),
      'owner-a',
    );
    pairPendingAuthFailuresWithTool(
      assistantToolUse('tu-gh', WATCH_TOOL_NAME),
      'owner-a',
    );

    const out = pairPendingAuthFailuresWithTool(
      batchedToolResults([
        { toolUseId: 'tu-mcp', isError: true },
        { toolUseId: 'tu-gh', isError: true },
      ]),
      'owner-a',
    );

    expect(out).toHaveLength(2);
    const byTarget = new Map(
      out.map((pairing) => [pairing.event.toolUseId, pairing.event]),
    );
    expect(byTarget.get('tu-mcp')?.failures).toEqual([failure]);
    expect(byTarget.get('tu-gh')?.failures).toEqual([githubFailure]);
  });

  it('ignores a successful injected-tool result', () => {
    recordPendingInjectedToolAuthFailure(
      'owner-a',
      'watch_github_items',
      githubFailure,
    );
    pairPendingAuthFailuresWithTool(
      assistantToolUse('tu-gh', WATCH_TOOL_NAME),
      'owner-a',
    );
    expect(
      pairPendingAuthFailuresWithTool(toolResult('tu-gh', false), 'owner-a'),
    ).toEqual([]);
    expect(claimPendingAuthFailures('owner-a')).toHaveLength(1);
  });
});

// CAN-1814 review (important). `autoResumeSafe` was derived from the single
// tool the failure was paired with, but `cancelChatTurn` aborts the
// SESSION-WIDE AbortController. Claude batches parallel tool calls, so if the
// model issued `[list_issues, create_issue]` and `list_issues` 401'd,
// `create_issue` could still be in flight: its `tool_result` never lands, the
// resumed session replays a `tool_use` with no result, and the model typically
// re-issues it — a duplicated external write, the one unrecoverable outcome,
// completely invisible to the read-only name gate.
//
// The pairing function already has the whole batch, so it reports whether any
// sibling from the failing tool's own batch is still unresolved.
describe('pairPendingAuthFailuresWithTool batch safety', () => {
  afterEach(() => clearPendingAuthFailures('owner-batch'));

  it('flags a batch whose sibling tool call has no landed result', () => {
    recordPendingMcpAuthFailure('owner-batch', failure);
    pairPendingAuthFailuresWithTool(
      assistantToolUseBatch([
        { toolUseId: 'tu-read', toolName: 'mcp__prod__list_issues' },
        { toolUseId: 'tu-write', toolName: 'mcp__prod__create_issue' },
      ]),
      'owner-batch',
    );

    // Only the read's error comes back; `create_issue` is still in flight.
    const pairings = pairPendingAuthFailuresWithTool(
      toolResult('tu-read', true),
      'owner-batch',
    );

    expect(pairings).toHaveLength(1);
    expect(pairings[0].batchHasUnresolvedToolCalls).toBe(true);
  });

  it('does not flag a batch whose every tool call has landed', () => {
    recordPendingMcpAuthFailure('owner-batch', failure);
    pairPendingAuthFailuresWithTool(
      assistantToolUseBatch([
        { toolUseId: 'tu-read', toolName: 'mcp__prod__list_issues' },
        { toolUseId: 'tu-write', toolName: 'mcp__prod__create_issue' },
      ]),
      'owner-batch',
    );

    const pairings = pairPendingAuthFailuresWithTool(
      batchedToolResults([
        { toolUseId: 'tu-read', isError: true },
        { toolUseId: 'tu-write', isError: false },
      ]),
      'owner-batch',
    );

    expect(pairings).toHaveLength(1);
    expect(pairings[0].batchHasUnresolvedToolCalls).toBe(false);
  });

  it('does not flag a single-call batch', () => {
    recordPendingMcpAuthFailure('owner-batch', failure);
    pairPendingAuthFailuresWithTool(
      assistantToolUse('tu-only', 'mcp__prod__list_issues'),
      'owner-batch',
    );

    const pairings = pairPendingAuthFailuresWithTool(
      toolResult('tu-only', true),
      'owner-batch',
    );

    expect(pairings).toHaveLength(1);
    expect(pairings[0].batchHasUnresolvedToolCalls).toBe(false);
  });

  // An unresolved call from an EARLIER assistant message must not poison every
  // later pairing: entries linger in the name cache when a turn is cancelled or
  // a stream truncates, and treating those as siblings would make auto-resume
  // permanently unreachable rather than merely conservative.
  it('ignores unresolved calls from a previous batch', () => {
    recordPendingMcpAuthFailure('owner-batch', failure);
    pairPendingAuthFailuresWithTool(
      assistantToolUse('tu-stale', 'mcp__prod__create_issue'),
      'owner-batch',
    );
    pairPendingAuthFailuresWithTool(
      assistantToolUse('tu-read', 'mcp__prod__list_issues'),
      'owner-batch',
    );

    const pairings = pairPendingAuthFailuresWithTool(
      toolResult('tu-read', true),
      'owner-batch',
    );

    expect(pairings).toHaveLength(1);
    expect(pairings[0].batchHasUnresolvedToolCalls).toBe(false);
  });
});

describe('pairPendingAuthFailures — Codex dynamic tool calls', () => {
  afterEach(() => clearPendingAuthFailures('owner-codex'));

  const githubFailure: AuthDependencyFailure = {
    dependencyClass: 'integration',
    dependencyId: 'integration:github',
    displayName: 'GitHub',
    failureClass: 'unauthenticated',
    recovery: { kind: 'github_login' },
  };
  // Codex sees Canopy's injected tools as dynamic tools under the branded
  // snake_case name; the legacy alias resolves through the same registry.
  const CODEX_WATCH_TOOL_NAME = 'canopy_watch_github_items';

  /**
   * The envelope `codex-session.ts` forwards for an app-server thread item:
   * `{ type: 'codex', event: { type: 'item.started' | 'item.completed',
   * item } }`, where `item` is the projected `dynamic_tool_call` shape
   * (`thread-item-projection.ts`). Failure is `success: false` or
   * `status: 'failed'`; there is no `is_error` and no `tool_use_id`.
   */
  function codexDynamicToolItem(
    phase: 'item.started' | 'item.completed',
    itemId: string,
    tool: string,
    outcome: { status: string; success: boolean | null },
  ): unknown {
    return {
      type: 'codex',
      event: {
        type: phase,
        item: {
          type: 'dynamic_tool_call',
          id: itemId,
          namespace: null,
          tool,
          arguments: { items: ['https://github.com/acme/api/actions/runs/1'] },
          status: outcome.status,
          content_items: null,
          success: outcome.success,
        },
      },
    };
  }

  it('pairs an injected-tool failure with the errored Codex dynamic tool call', () => {
    recordPendingInjectedToolAuthFailure(
      'owner-codex',
      'watch_github_items',
      githubFailure,
    );
    expect(
      pairPendingAuthFailuresWithTool(
        codexDynamicToolItem('item.started', 'item-1', CODEX_WATCH_TOOL_NAME, {
          status: 'in_progress',
          success: null,
        }),
        'owner-codex',
      ),
    ).toEqual([]);

    const out = pairPendingAuthFailuresWithTool(
      codexDynamicToolItem('item.completed', 'item-1', CODEX_WATCH_TOOL_NAME, {
        status: 'completed',
        success: false,
      }),
      'owner-codex',
    );

    expect(out).toHaveLength(1);
    expect(out[0].toolName).toBe(CODEX_WATCH_TOOL_NAME);
    // The transcript keys Codex tool blocks as `codex-<item id>`
    // (`transcript-parser.ts`), so that is the id the card attaches to.
    expect(out[0].event.toolUseId).toBe('codex-item-1');
    expect(out[0].event.failure.recovery).toEqual({ kind: 'github_login' });
    expect(out[0].event.failures).toEqual([githubFailure]);
    expect(out[0].batchHasUnresolvedToolCalls).toBe(false);
  });

  it('pairs from a completed item alone when the started item was never seen', () => {
    recordPendingInjectedToolAuthFailure(
      'owner-codex',
      'watch_github_items',
      githubFailure,
    );
    const out = pairPendingAuthFailuresWithTool(
      codexDynamicToolItem('item.completed', 'item-2', CODEX_WATCH_TOOL_NAME, {
        status: 'failed',
        success: null,
      }),
      'owner-codex',
    );
    expect(out).toHaveLength(1);
    expect(out[0].event.toolUseId).toBe('codex-item-2');
  });

  it('leaves the failure pending for a successful or unrelated Codex tool call', () => {
    recordPendingInjectedToolAuthFailure(
      'owner-codex',
      'watch_github_items',
      githubFailure,
    );
    expect(
      pairPendingAuthFailuresWithTool(
        codexDynamicToolItem(
          'item.completed',
          'item-ok',
          CODEX_WATCH_TOOL_NAME,
          {
            status: 'completed',
            success: true,
          },
        ),
        'owner-codex',
      ),
    ).toEqual([]);
    expect(
      pairPendingAuthFailuresWithTool(
        codexDynamicToolItem(
          'item.completed',
          'item-other',
          'canopy_show_files',
          {
            status: 'completed',
            success: false,
          },
        ),
        'owner-codex',
      ),
    ).toEqual([]);
    expect(claimPendingAuthFailures('owner-codex')).toHaveLength(1);
  });

  it('flags a sibling Codex tool call that is still in flight', () => {
    recordPendingInjectedToolAuthFailure(
      'owner-codex',
      'watch_github_items',
      githubFailure,
    );
    pairPendingAuthFailuresWithTool(
      codexDynamicToolItem('item.started', 'item-gh', CODEX_WATCH_TOOL_NAME, {
        status: 'in_progress',
        success: null,
      }),
      'owner-codex',
    );
    pairPendingAuthFailuresWithTool(
      codexDynamicToolItem(
        'item.started',
        'item-write',
        'canopy_dispatch_action',
        {
          status: 'in_progress',
          success: null,
        },
      ),
      'owner-codex',
    );
    const out = pairPendingAuthFailuresWithTool(
      codexDynamicToolItem('item.completed', 'item-gh', CODEX_WATCH_TOOL_NAME, {
        status: 'completed',
        success: false,
      }),
      'owner-codex',
    );
    expect(out).toHaveLength(1);
    expect(out[0].batchHasUnresolvedToolCalls).toBe(true);
  });

  it('never claims an MCP-proxy failure from a Codex mcp_tool_call item', () => {
    // The MCP family stays Claude-only: Codex records proxy failures under a
    // per-client route owner id this module is never handed.
    recordPendingMcpAuthFailure('owner-codex', failure);
    expect(
      pairPendingAuthFailuresWithTool(
        {
          type: 'codex',
          event: {
            type: 'item.completed',
            item: {
              type: 'mcp_tool_call',
              id: 'item-mcp',
              server: 'prod',
              tool: 'query',
              status: 'failed',
              error: { message: 'HTTP 401' },
            },
          },
        },
        'owner-codex',
      ),
    ).toEqual([]);
    expect(claimPendingAuthFailures('owner-codex')).toHaveLength(1);
  });
});
