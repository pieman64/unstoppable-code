import type { PersistedChatMessage } from '../types';

const CLAUDE_CHAIN_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True only for a CLI-minted Claude transcript chain UUID. */
export function isClaudeChainUuid(value: unknown): value is string {
  return typeof value === 'string' && CLAUDE_CHAIN_UUID_PATTERN.test(value);
}

/**
 * Resolve the Claude Code chain entry a forked chat must resume at.
 *
 * A fork keeps a prefix of its source transcript. When the source session has
 * already advanced past that prefix, resuming it verbatim would hand the model
 * turns the fork deliberately discarded, so the SDK resume must name the last
 * chain entry the fork kept (`resumeSessionAt`, used with `resume` +
 * `forkSession`). The SDK's rule is "fork at the KEPT turn's last chain
 * entry", which is exactly the fork anchor when that anchor came from a
 * provider event.
 *
 * `atMessageId` is the fork anchor — the last message inherited from the
 * source (`forkedFrom.atMessageId`). It is frequently a Canopy-minted row
 * (a `turn_timer`, a sync warning) that has no chain entry of its own, so the
 * search walks backwards to the nearest earlier message that does. Omit
 * `atMessageId` to anchor on the transcript's last stamped message.
 *
 * Returns `undefined` when nothing in the kept range carries a chain uuid —
 * a transcript written before `claudeUuid` existed, or a non-Claude one.
 * Callers must then start the fork fresh rather than resume blindly.
 */
export function resolveClaudeForkResumePoint(
  messages: readonly PersistedChatMessage[],
  atMessageId: string | undefined,
): string | undefined {
  let start = messages.length - 1;
  if (atMessageId !== undefined) {
    start = messages.findIndex((message) => message.id === atMessageId);
    if (start < 0) return undefined;
  }
  for (let index = start; index >= 0; index -= 1) {
    const candidate = messages[index];
    const claudeUuid = candidate?.claudeUuid;
    if (!isClaudeChainUuid(claudeUuid)) continue;
    // The CLI silently accepts an anchor whose tool calls are still open and
    // inserts no synthetic results, so resuming there would hand the model a
    // dangling `tool_use`. Everything past the anchor is dropped, so a
    // matching `tool_result` only counts when it is at or before it — which
    // in practice means the carrier itself, stamped, is the better anchor.
    // When it is not stamped there is no usable fork point at all.
    if (hasUnansweredToolUse(messages, index)) return undefined;
    return claudeUuid;
  }
  return undefined;
}

function hasUnansweredToolUse(
  messages: readonly PersistedChatMessage[],
  anchorIndex: number,
): boolean {
  const openToolUseIds = new Set<string>();
  for (let index = 0; index <= anchorIndex; index += 1) {
    const message = messages[index];
    // Sidechain entries describe nested agent work, not the main Claude
    // conversation being resumed. A cancelled subagent may legitimately leave
    // one of its own tool calls open without invalidating the main-chain
    // anchor.
    if (message?.parentToolUseId) continue;
    for (const block of message?.blocks ?? []) {
      if (block.type === 'tool_use') {
        openToolUseIds.add(block.toolUseId);
      } else if (block.type === 'tool_result') {
        openToolUseIds.delete(block.toolUseId);
      }
    }
  }
  return openToolUseIds.size > 0;
}
