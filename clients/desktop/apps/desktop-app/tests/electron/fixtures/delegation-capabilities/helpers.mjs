// Small, focused helpers for `managed-delegation-capabilities.spec.mjs`.
// Deterministic inference only; no live agents, no network beyond the
// fixtures this suite starts itself.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { expect } from '@playwright/test';

/**
 * Read every retained delegation run record for a worktree.
 *
 * On-disk path: `workspaces/{workspaceId}/worktree-data/{worktreeId}/delegation/runs/*.json`
 * (mirrors `retainedRuns` in `managed-delegation.spec.mjs`). Each file is a
 * `StoredDelegation` (`packages/desktop-shared/src/node/delegation/broker.ts`),
 * so `capabilityGrant` is the raw `DelegationCapabilityGrant` (never the
 * Portal-safe `state.capabilities` projection the renderer reads).
 */
export function retainedDelegationRuns({
  userDataDir,
  workspaceId,
  worktreeId,
}) {
  const directory = path.join(
    userDataDir,
    'workspaces',
    workspaceId,
    'worktree-data',
    worktreeId,
    'delegation',
    'runs',
  );
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .map((name) =>
      JSON.parse(readFileSync(path.join(directory, name), 'utf8')),
    );
}

/**
 * Wait for a `chat-delegated-agent` card to be reachable and return its
 * section locator with "Expand delegated task" guaranteed visible (expanding
 * any collapsed ancestor turn-group first). Mirrors `revealDelegatedAgent` in
 * `managed-delegation.spec.mjs`. Does NOT click the expand button itself —
 * callers decide whether they need the metadata (and its Capabilities row)
 * visible.
 */
export async function revealDelegatedAgent(
  surface,
  { timeoutMs = 15_000 } = {},
) {
  const delegated = surface.getByTestId('chat-delegated-agent');
  const expand = delegated.getByRole('button', {
    name: 'Expand delegated task',
  });
  const collapsedTurns = surface.locator(
    'button[aria-label^="Agent steps"][aria-expanded="false"]',
  );
  await expect
    .poll(
      async () =>
        (await expand.isVisible().catch(() => false)) ||
        (await collapsedTurns.count()) > 0,
      { timeout: timeoutMs },
    )
    .toBe(true);
  // Re-query the first remaining collapsed group on every iteration rather
  // than clicking a snapshot taken once: an earlier turn-group's Watch/Output
  // round trip can span a real wait, splitting the transcript into more than
  // one collapsed "Agent steps" summary, and expanding one can reflow/merge
  // the rest, turning a captured locator for a later one stale.
  for (
    let guard = 0;
    guard < 20 && !(await expand.isVisible().catch(() => false));
    guard += 1
  ) {
    const summary = collapsedTurns.first();
    if ((await summary.count()) === 0) break;
    await summary.click().catch(() => undefined);
  }
  await expect(delegated).toHaveCount(1);
  await expect(expand).toBeVisible();
  return delegated;
}

/** Extract the raw JSON text carried by one captured tool-result block. */
function extractResultText(block) {
  if (typeof block.output === 'string') return block.output;
  if (Array.isArray(block.content)) {
    const textBlock = block.content.find(
      (entry) =>
        entry && entry.type === 'text' && typeof entry.text === 'string',
    );
    if (textBlock) return textBlock.text;
  }
  return undefined;
}

function collectToolResultObjects(value, into) {
  if (Array.isArray(value)) {
    for (const item of value) collectToolResultObjects(item, into);
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (
    value.type === 'tool_result' ||
    value.type === 'function_call_output' ||
    value.type === 'custom_tool_call_output'
  ) {
    const text = extractResultText(value);
    if (text) {
      try {
        into.push(JSON.parse(text));
      } catch {
        // Not JSON (a plain error string); ignore for structured lookups.
      }
    }
  }
  for (const nested of Object.values(value))
    if (nested && typeof nested === 'object')
      collectToolResultObjects(nested, into);
}

/**
 * Every captured tool-result block in a request body, JSON-parsed.
 *
 * Claude wraps a tool result as `{ type: 'tool_result', content: [{ type:
 * 'text', text: <json> }] }`; Codex's Responses wire renders one as
 * `{ type: 'function_call_output' | 'custom_tool_call_output', output:
 * <json string> }`. Both carry the exact `JSON.stringify(...)` text our own
 * app/delegation tool handlers produce (`executeCanopyInjectedTool`,
 * `DelegateCanopyTools`, `DelegationParent.invokeClaude/invokeCodex`), so
 * parsing that text back gives the same structured value the model saw.
 */
export function toolResultObjects(body) {
  const into = [];
  collectToolResultObjects(body.messages ?? body.input ?? [], into);
  return into;
}

/**
 * The first `ref` from a Search Deferred Tools result
 * (`{ provider, results: [{ query, matches: [{ ref, ... }] }] }`).
 */
export function findDeferredSearchRef(body) {
  for (const result of toolResultObjects(body)) {
    const groups = result?.results;
    if (!Array.isArray(groups)) continue;
    for (const group of groups)
      for (const match of group?.matches ?? [])
        if (typeof match?.ref === 'string' && match.ref) return match.ref;
  }
  return undefined;
}

/**
 * The catalog `id` for a named capability from a
 * `ListDelegates { includeCapabilities: true }` result
 * (`{ ok: true, value: { delegations, capabilities: [{ id, name, ... }] } }`).
 */
export function findListDelegatesCapabilityId(body, name) {
  for (const result of toolResultObjects(body)) {
    const capabilities = result?.value?.capabilities;
    if (!Array.isArray(capabilities)) continue;
    for (const capability of capabilities)
      if (capability?.name === name && typeof capability?.id === 'string')
        return capability.id;
  }
  return undefined;
}

/** Whether a flattened `toolNames` list offers a tool by its raw name,
 * matching either a flat entry (Claude `mcp__ns__Tool`, Codex `ns_tool`) or a
 * namespaced one (`<namespace>.<name>`, see `delegationRuntime.mjs`'s
 * `toolNames` projection). */
export function hasToolName(toolNames, name) {
  return (toolNames ?? []).some(
    (candidate) => candidate === name || candidate.endsWith(`.${name}`),
  );
}

/** Shared, deterministic preferences shape for these capability cases:
 * explicit-only managed delegation, onboarding already complete, a fixed
 * default provider. Mirrors the preferences seeded by
 * `managed-delegation.spec.mjs`. */
export function baseManagedDelegationPreferences({
  parentProvider = 'claude',
} = {}) {
  return {
    version: 1,
    preferences: {
      managedDelegationMode: 'explicit-only',
      onboardingCompleted: ['v1'],
      defaultChatInterfaceMode: 'canopy',
      defaultWorktreeProvider: parentProvider,
      defaultChatProvider: parentProvider,
      codexMultiAgentWorktreeChatsEnabled: false,
    },
  };
}

const DELEGATION_ID_PATTERN =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  for (let index = haystack.indexOf(needle); index !== -1; ) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/**
 * Drive a parent's post-spawn turn to completion with an explicit Watch
 * Delegates + Get Delegate Output round trip, then hand back to the
 * built-in state machine's own "finding already in history" check to
 * produce `ctx.integrated`.
 *
 * This mirrors the proven `needsWatcher` flow in `delegationRuntime.mjs`'s
 * built-in state machine (used by its `watch`/`isolation`/`resume*` actions),
 * which only activates for those specific action strings. A case using its
 * own unique `action` value gets none of that behavior for free — without an
 * explicit watch, `run_in_background: false` (`executionMode: 'foreground'`)
 * does not itself block the spawn tool call until settlement (the spawn
 * result comes back `pending` immediately either way), so the parent must
 * still watch and read the output like a background spawn does. Returns
 * `undefined` to fall through: to the built-in's own spawn (before a
 * `delegationId` exists) or its "finding already appeared" integration
 * check (once the read output carries the finding).
 *
 * A single watch/output pair is not always enough: `WatchDelegates` also
 * resolves on its own deadline (not only on completion), and the "Canopy
 * watcher fired." acknowledgement text stays part of the resent history
 * forever afterward, so checking only for that text would re-issue Get
 * Delegate Output on every later turn too. Count watch/output calls already
 * in this exact history instead: re-watch whenever a prior watch has already
 * been answered (an output call for it exists), and only ask for output once
 * per watch, so a still-running result correctly triggers one more
 * watch/output cycle rather than a busy retry loop.
 */
export function driveParentWatchFlow(ctx) {
  if (!ctx.results.includes('delegationId')) return undefined;
  if (ctx.context.includes(ctx.finding)) return undefined;
  const id = ctx.results.match(DELEGATION_ID_PATTERN)?.[0];
  if (!id) return undefined;
  const watchName = ctx.toolName('WatchDelegates', 'watch_delegates');
  const outputName = ctx.toolName('GetDelegateOutput', 'get_delegate_output');
  const watchCalls = countOccurrences(ctx.context, watchName);
  const outputCalls = countOccurrences(ctx.context, outputName);
  if (watchCalls <= outputCalls)
    return ctx.reply({
      toolCalls: [
        {
          name: watchName,
          input: { delegationIds: [id], mode: 'all', timeoutMs: 60_000 },
        },
      ],
      stopReason: 'tool_use',
    });
  if (ctx.text.includes('watcher fired'))
    return ctx.reply({
      toolCalls: [{ name: outputName, input: { delegationId: id } }],
      stopReason: 'tool_use',
    });
  return ctx.reply({
    text: 'Waiting for the delegated task to settle.',
    stopReason: 'end_turn',
  });
}
