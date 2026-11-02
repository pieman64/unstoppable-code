/**
 * Transcript block identity: the single home for the content fingerprint used
 * to dedupe replayed messages, and for the set of block types that are pure
 * layout/system chrome rather than conversation content.
 *
 * Before CAN-3083 this logic existed four times — twice verbatim
 * (`main/integration/claude-terminal-transcript-sync.ts` and
 * `renderer/stores/chat/transcript-dedupe.ts`) and twice more as a
 * hand-maintained layout list (`transcript-parser.isLayoutSystemMessage`,
 * `ChatMessageItem.isSystemSingleBlock`) — and the copies had already drifted:
 * main was missing the `claude_terminal_sync_warning` arm, so the two dedupers
 * disagreed about that one variant. Collapsing them here means a new
 * `PersistedChatBlock` variant costs one arm and one set entry instead of six
 * edits.
 *
 * This lives in `@canopy/agent-transcript` rather than `@canopy/desktop-shared`
 * because `transcript-parser.ts` is one of the consumers and agent-transcript
 * may not import desktop-shared. The package is browser-safe and already
 * reachable from Electron main and the renderer alike.
 *
 * Fingerprints are computed in memory at compare time and are **never
 * persisted**, so changing one is not a stored-value migration.
 */
import { readMcpActivationRecord } from '@canopy/protocol/mcp-servers';
import type { PersistedChatBlock } from '../types';

/** Collapses insignificant whitespace so re-wrapped text still matches. */
export function normalizeFingerprintText(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

/**
 * A stable content identity for one transcript block.
 *
 * Deliberately not `JSON.stringify` for known variants: key order and
 * incidental fields (ids, refs, truncation markers) would make two renderings
 * of the same content compare unequal. Unknown variants fall back to
 * `JSON.stringify` so a block added without an arm here still dedupes by shape
 * rather than throwing.
 */
export function blockFingerprint(block: PersistedChatBlock): string {
  switch (block.type) {
    case 'text':
    case 'thinking':
      return `${block.type}:${normalizeFingerprintText(block.text)}`;
    case 'file_references':
      return `file_references:${block.references
        .map((reference) => reference.displayPath || reference.absolutePath)
        .join('\n')}`;
    case 'tool_use':
      return `tool_use:${block.toolName}:${block.input}`;
    case 'tool_result':
      return `tool_result:${block.toolUseId}:${block.toolName}:${block.output}:${String(block.isError)}${block.interruption ? `:interrupted:${block.interruption.reason}:${block.interruption.at}` : ''}`;
    case 'compaction_info':
      return `compaction_info:${block.sourceEventId ?? ''}:${block.sessionId ?? ''}:${normalizeFingerprintText(block.summary ?? block.reason ?? '')}`;
    case 'mcp_activation': {
      const record = readMcpActivationRecord(block.record);
      if (!record) break;
      return `mcp_activation:${record.activationId}:${record.attemptId}:${record.desiredGeneration}:${record.phase}:${record.admission}:${record.failureCode ?? ''}`;
    }
    case 'claude_terminal_sync_warning':
      return `claude_terminal_sync_warning:${String(block.timestamp)}:${normalizeFingerprintText(block.message ?? '')}`;
    case 'account_proxy_switch':
      return `account_proxy_switch:${block.sourceEventId ?? String(block.timestamp)}:${normalizeFingerprintText(block.account)}`;
    case 'turn_timer':
      return `turn_timer:${String(block.startedAt)}:${String(block.pausedAt)}:${String(block.resumedAt)}:${String(block.accumulatedPausedDurationMs)}:${String(block.completedAt)}`;
    case 'hook_info':
      return `hook_info:${block.triggerName}:${String(block.timestamp)}`;
    case 'automation_info':
      return `automation_info:${block.activityName ?? ''}:${String(block.timestamp)}`;
    case 'rebase_resolution_info':
      return `rebase_resolution_info:${block.kind}:${block.repoName}:${block.branchName}`;
    case 'builtin_gh_chat_info':
      return `builtin_gh_chat_info:${block.kind}:${block.repoName ?? ''}:${block.branchName ?? ''}`;
    case 'pending_setup_info':
      return `pending_setup_info:${String(block.timestamp)}`;
    case 'approval_safety_denied_info':
      return `approval_safety_denied_info:${block.receiptId}`;
    case 'approval_resolution_info':
      return `approval_resolution_info:${block.resolvedBy}:${block.mode}:${block.previousMode ?? ''}:${String(block.timestamp)}:${block.titles.join('\u0000')}`;
    case 'revert_info':
      return `revert_info:${block.revertedFromMessageId}:${String(block.revertedFromTimestamp)}`;
  }
  try {
    return JSON.stringify(block);
  } catch {
    return `unserializable_block:${String(block.type)}`;
  }
}

/**
 * Block types that carry chrome rather than conversation: timers, markers and
 * info banners. A message made only of these is layout, and the four callers
 * use that fact to exclude it from transcript comparison or to render it as a
 * single system line.
 *
 * Shared as a **set**, not a predicate, because each caller wraps it
 * differently — some additionally require `role === 'system'`, one requires
 * exactly one block — and because the renderer's call sites pass display-only
 * block types (`agent`, `workflow`, `codex_agent`) that are not layout and
 * must simply miss.
 */
export const LAYOUT_BLOCK_TYPES: ReadonlySet<string> = new Set<string>([
  'mcp_activation',
  'turn_timer',
  'hook_info',
  'automation_info',
  'claude_terminal_sync_warning',
  'account_proxy_switch',
  'rebase_resolution_info',
  'builtin_gh_chat_info',
  'pending_setup_info',
  'approval_resolution_info',
  'approval_safety_denied_info',
  'revert_info',
]);
