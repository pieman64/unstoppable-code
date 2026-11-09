import { approvalSafetyDeniedInfoSchema } from '@canopy/protocol/approvals';
import type {
  PersistedChatBlock,
  PersistedChatMessage,
} from '@canopy/desktop-shared/types';
import {
  isClaudeModsSkippedBlock,
  isDelegatedAgentCallBlock,
} from '@canopy/agent-transcript';
import { isTranscriptBlocksReference } from '@canopy/agent-transcript/transcript-storage';
import { isRecord } from './type-guards';

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function isOptionalFiniteNumber(value: unknown): boolean {
  return (
    value === undefined || (typeof value === 'number' && Number.isFinite(value))
  );
}

function isNullableFiniteNumber(value: unknown): boolean {
  return (
    value === null || (typeof value === 'number' && Number.isFinite(value))
  );
}

function isFileReference(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.displayPath === 'string' &&
    typeof value.absolutePath === 'string' &&
    isOptionalString(value.repoName) &&
    isOptionalString(value.kind) &&
    isOptionalFiniteNumber(value.textStart)
  );
}

function isApprovalModeValue(value: unknown): boolean {
  return value === 'ask' || value === 'auto' || value === 'full-access';
}

function isChangedFileInfo(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const statuses = new Set([
    'added',
    'modified',
    'deleted',
    'renamed',
    'copied',
    'unmerged',
    'type-changed',
    'untracked',
    'unknown',
  ]);
  return (
    typeof value.path === 'string' &&
    typeof value.status === 'string' &&
    statuses.has(value.status) &&
    typeof value.insertions === 'number' &&
    Number.isFinite(value.insertions) &&
    typeof value.deletions === 'number' &&
    Number.isFinite(value.deletions) &&
    isOptionalString(value.previousPath) &&
    isOptionalString(value.repoId) &&
    isOptionalString(value.repoName)
  );
}

function isTurnDiffTreeRef(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.startTree === 'string' &&
    typeof value.endTree === 'string' &&
    isOptionalString(value.repoId) &&
    isOptionalString(value.startHeadCommitSha)
  );
}

function isCodexAgentState(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.status === 'string' &&
    (value.message === undefined ||
      value.message === null ||
      typeof value.message === 'string')
  );
}

function isCodexReceiverAgent(value: unknown): boolean {
  return (
    isRecord(value) &&
    isOptionalString(value.nickname) &&
    isOptionalString(value.role) &&
    isOptionalString(value.agentPath) &&
    isOptionalString(value.model) &&
    isOptionalString(value.reasoningEffort)
  );
}

function isRecordOf(
  value: unknown,
  validate: (candidate: unknown) => boolean,
): boolean {
  return isRecord(value) && Object.values(value).every(validate);
}

export function isPersistedChatBlock(
  value: unknown,
): value is PersistedChatBlock {
  if (!isRecord(value) || typeof value.type !== 'string') return false;

  switch (value.type) {
    case 'mcp_activation':
      // Recovery versions must not make the enclosing transcript unreadable.
      // Keep the raw payload for stored digests; display projections validate it.
      return 'record' in value;
    case 'text':
    case 'thinking':
      return typeof value.text === 'string';
    case 'file_references':
      return (
        Array.isArray(value.references) &&
        value.references.every(isFileReference)
      );
    case 'tool_use':
      return (
        typeof value.toolUseId === 'string' &&
        typeof value.toolName === 'string' &&
        typeof value.input === 'string'
      );
    case 'tool_result':
      return (
        typeof value.toolUseId === 'string' &&
        typeof value.toolName === 'string' &&
        typeof value.output === 'string' &&
        typeof value.isError === 'boolean'
      );
    case 'image':
      return typeof value.path === 'string' && typeof value.alt === 'string';
    case 'turn_timer':
      return (
        isOptionalFiniteNumber(value.startedAt) &&
        (value.pausedAt === undefined ||
          isNullableFiniteNumber(value.pausedAt)) &&
        (value.resumedAt === undefined ||
          isNullableFiniteNumber(value.resumedAt)) &&
        isOptionalFiniteNumber(value.accumulatedPausedDurationMs) &&
        isNullableFiniteNumber(value.completedAt)
      );
    case 'hook_info':
      return (
        typeof value.triggerName === 'string' &&
        typeof value.timestamp === 'number' &&
        Number.isFinite(value.timestamp)
      );
    case 'automation_info':
      return (
        isOptionalString(value.activityName) &&
        typeof value.timestamp === 'number' &&
        Number.isFinite(value.timestamp)
      );
    case 'compaction_info':
      return (
        typeof value.timestamp === 'number' &&
        Number.isFinite(value.timestamp) &&
        (value.provider === 'claude' ||
          value.provider === 'codex' ||
          value.provider === 'ollama') &&
        (value.interfaceMode === 'canopy' ||
          value.interfaceMode === 'claude-code' ||
          value.interfaceMode === 'auto') &&
        isOptionalString(value.sessionId) &&
        isOptionalString(value.reason) &&
        isOptionalString(value.summary) &&
        isOptionalString(value.transcriptPath) &&
        isOptionalString(value.sourceEventId)
      );
    case 'claude_terminal_sync_warning':
      return (
        typeof value.timestamp === 'number' &&
        Number.isFinite(value.timestamp) &&
        isOptionalString(value.message)
      );
    case 'account_proxy_switch':
      return (
        typeof value.timestamp === 'number' &&
        Number.isFinite(value.timestamp) &&
        typeof value.account === 'string' &&
        isOptionalString(value.previousAccount) &&
        (value.previousAtLimit === undefined ||
          typeof value.previousAtLimit === 'boolean') &&
        isOptionalString(value.provider) &&
        isOptionalString(value.sourceEventId)
      );
    case 'claude_mods_skipped':
      return isClaudeModsSkippedBlock(value);
    case 'rebase_resolution_info':
      return (
        (value.kind === 'rebase_conflict' ||
          value.kind === 'stash_pop_conflict') &&
        typeof value.repoName === 'string' &&
        typeof value.branchName === 'string' &&
        typeof value.timestamp === 'number' &&
        Number.isFinite(value.timestamp)
      );
    case 'builtin_gh_chat_info':
      return (
        (value.kind === 'merge_conflict' ||
          value.kind === 'review_comment_triage' ||
          value.kind === 'ci_check_fix' ||
          value.kind === 'merge_queue') &&
        isOptionalString(value.repoName) &&
        isOptionalString(value.branchName) &&
        typeof value.timestamp === 'number' &&
        Number.isFinite(value.timestamp)
      );
    case 'pending_setup_info':
      return (
        typeof value.timestamp === 'number' && Number.isFinite(value.timestamp)
      );
    case 'approval_safety_denied_info':
      return approvalSafetyDeniedInfoSchema.safeParse(value).success;
    case 'approval_resolution_info':
      return (
        typeof value.timestamp === 'number' &&
        Number.isFinite(value.timestamp) &&
        value.resolvedBy === 'mode-change' &&
        isApprovalModeValue(value.mode) &&
        (value.previousMode === undefined ||
          isApprovalModeValue(value.previousMode)) &&
        Array.isArray(value.titles) &&
        value.titles.every((title) => typeof title === 'string')
      );
    case 'revert_info':
      return (
        typeof value.timestamp === 'number' &&
        Number.isFinite(value.timestamp) &&
        typeof value.revertedFromMessageId === 'string' &&
        typeof value.revertedFromTimestamp === 'number' &&
        Number.isFinite(value.revertedFromTimestamp) &&
        Array.isArray(value.files) &&
        value.files.every(isChangedFileInfo) &&
        typeof value.totalInsertions === 'number' &&
        Number.isFinite(value.totalInsertions) &&
        typeof value.totalDeletions === 'number' &&
        Number.isFinite(value.totalDeletions) &&
        (value.treeRefs === undefined ||
          (Array.isArray(value.treeRefs) &&
            value.treeRefs.every(isTurnDiffTreeRef))) &&
        isOptionalString(value.attachmentPath)
      );
    case 'delegated_agent_call':
      return isDelegatedAgentCallBlock(value);
    case 'codex_agent_call':
      return (
        typeof value.agentBlockId === 'string' &&
        typeof value.callId === 'string' &&
        typeof value.tool === 'string' &&
        typeof value.status === 'string' &&
        typeof value.senderThreadId === 'string' &&
        Array.isArray(value.receiverThreadIds) &&
        value.receiverThreadIds.every(
          (threadId) => typeof threadId === 'string',
        ) &&
        typeof value.prompt === 'string' &&
        isOptionalString(value.model) &&
        isOptionalString(value.reasoningEffort) &&
        isRecordOf(value.agentsStates, isCodexAgentState) &&
        (value.receiverAgents === undefined ||
          isRecordOf(value.receiverAgents, isCodexReceiverAgent))
      );
    default:
      return false;
  }
}

export function isPersistedChatMessage(
  value: unknown,
): value is PersistedChatMessage {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.id === 'string' &&
    (value.role === 'user' ||
      value.role === 'assistant' ||
      value.role === 'system') &&
    Array.isArray(value.blocks) &&
    value.blocks.every(isPersistedChatBlock) &&
    (!Object.prototype.hasOwnProperty.call(value, 'blocksRef') ||
      (value.blocks.length === 0 &&
        isTranscriptBlocksReference(value.blocksRef))) &&
    typeof value.timestamp === 'number' &&
    Number.isFinite(value.timestamp)
  );
}
