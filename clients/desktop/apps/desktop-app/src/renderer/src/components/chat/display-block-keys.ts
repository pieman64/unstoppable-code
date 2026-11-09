import type { DisplayBlock } from './types';

type KeyableDisplayBlock =
  | DisplayBlock
  | { type: 'tool_result'; toolUseId: string };

export function getDisplayBlockKey(
  block: KeyableDisplayBlock,
  index: number,
): string {
  switch (block.type) {
    case 'tool_use':
      return `tool_use:${block.toolUseId}`;
    case 'tool_result':
      return `tool_result:${block.toolUseId}`;
    case 'agent':
      return `agent:${block.toolUseId}`;
    case 'workflow':
      return `workflow:${block.toolUseId}`;
    case 'codex_agent':
      return `codex-agent:${block.agentBlockId}`;
    // Each managed run generation is its own block; keying by position would
    // hand one delegate's expanded card state to another as the list shifts.
    case 'delegated_agent_call':
      return `delegated-agent:${block.agentBlockId}`;
    case 'turn_timer':
      return `turn:${block.startedAt ?? 'unknown'}:${index}`;
    case 'hook_info':
      return `hook:${block.timestamp}:${block.triggerName}`;
    case 'automation_info':
      return `automation:${block.timestamp}:${block.activityName ?? ''}`;
    case 'claude_terminal_sync_warning':
      return `claude-terminal-sync-warning:${block.timestamp}:${index}`;
    case 'account_proxy_switch':
      return `account-proxy-switch:${block.sourceEventId ?? `${block.timestamp}:${index}`}`;
    case 'claude_mods_skipped':
      return `claude-mods-skipped:${block.sourceEventId ?? `${block.timestamp}:${index}`}`;
    case 'pending_setup_info':
      return `pending-setup:${block.timestamp}:${index}`;
    case 'rebase_resolution_info':
      return `rebase:${block.timestamp}:${block.kind}:${block.repoName}`;
    case 'builtin_gh_chat_info':
      return `builtin-gh:${block.timestamp}:${block.kind}`;
    // Main writes one receipt per denied invocation under a stable ID.
    case 'approval_safety_denied_info':
      return `approval-safety-denied:${block.receiptId}`;
    case 'approval_resolution_info':
      // Two mode changes in the same millisecond would otherwise collide, so
      // fold in the index the way the other timestamp-keyed markers do.
      return `approval-resolution:${block.timestamp}:${index}`;
    case 'revert_info':
      return `revert:${block.timestamp}`;
    case 'text':
    case 'thinking':
      return `${block.type}:${index}`;
    default:
      return `${block.type}:${index}`;
  }
}
