// Activity-store dispatch for chat events and turn diffs.
import type {
  ChatTurnDiffEvent,
  TurnDiffData,
} from '@canopy/desktop-shared/types';
import {
  codexMcpToolName,
  previewCodexMcpToolResult,
} from '@canopy/agent-transcript';
import { previewCodexDynamicToolContent } from '@/lib/codex-dynamic-tool-results';
import { useActivityStore } from '../activityStore';
import type { WorktreeChatState } from './types';
import { isRecord } from './utils';

/**
 * Apply a `turn_diff` chat event to a single chat tab, returning the next
 * worktree-chat state (or `null` to signal the caller should leave state
 * unchanged). Pulled out of {@link handleChatEvent} so the event-id matching
 * and turn-diff write semantics can be tested without spinning up the store.
 */
export function applyTurnDiffEventToWorktree(
  wc: WorktreeChatState,
  chatId: string,
  rawData: ChatTurnDiffEvent,
): WorktreeChatState | null {
  const tab = wc.tabs.find((candidate) => candidate.id === chatId);
  if (!tab) return null;

  const matchingUserMessage = tab.messages.find(
    (message) =>
      message.id === rawData.userMessageId && message.role === 'user',
  );
  if (!matchingUserMessage) return null;

  const turnDiffData: TurnDiffData = {
    files: rawData.files,
    totalInsertions: rawData.totalInsertions,
    totalDeletions: rawData.totalDeletions,
    capturedAt: rawData.capturedAt,
    ...(rawData.treeRefs ? { treeRefs: rawData.treeRefs } : {}),
  };

  const updatedTabs = wc.tabs.map((candidate) =>
    candidate.id === chatId
      ? {
          ...candidate,
          turnDiffs: {
            ...candidate.turnDiffs,
            [rawData.userMessageId]: turnDiffData,
          },
        }
      : candidate,
  );
  return { ...wc, tabs: updatedTabs };
}

/**
 * Dispatches a Codex provider event onto the activity timeline. Handles the
 * four supported item shapes — `command_execution` and `file_change` (mapped
 * onto the generic `tool_use` + `tool_result` activity blocks via the
 * synthetic `codex-<itemId>` id), `mcp_tool_call` (canonical
 * `mcp__<server>__<tool>` name + shared result flattening), and
 * `dynamic_tool_call` (provider-accurate tool name + flattened content).
 * Returns true when an event was matched and dispatched, otherwise false so
 * the caller can keep walking.
 */
export function dispatchCodexActivityEvent(
  projectId: string,
  worktreeId: string,
  chatId: string,
  data: Record<string, unknown>,
): boolean {
  const activity = useActivityStore.getState();
  const innerEvent = isRecord(data.event) ? data.event : null;
  const innerType =
    innerEvent && typeof innerEvent.type === 'string' ? innerEvent.type : '';
  if (innerType !== 'item.started' && innerType !== 'item.completed') {
    return true;
  }
  const item = innerEvent && isRecord(innerEvent.item) ? innerEvent.item : null;
  if (!item || typeof item.id !== 'string') {
    return true;
  }
  const itemType = typeof item.type === 'string' ? item.type : '';
  if (itemType === 'command_execution' || itemType === 'file_change') {
    const codexToolId = `codex-${item.id}`;
    if (innerType === 'item.started') {
      activity.handleToolUseBlock(
        projectId,
        worktreeId,
        chatId,
        codexToolId,
        itemType,
        item,
      );
    } else {
      activity.handleToolResultBlock(
        projectId,
        worktreeId,
        chatId,
        codexToolId,
        typeof item.aggregated_output === 'string'
          ? item.aggregated_output
          : JSON.stringify(item),
        item.status === 'failed',
      );
    }
    return true;
  }
  if (itemType === 'mcp_tool_call') {
    // Frontend plan Phase 1: mirror the shared transcript contract for Codex
    // MCP calls. `item.started` registers one pending activity entry under the
    // synthetic `codex-<itemId>` id with the canonical `mcp__<server>__<tool>`
    // name and the serialized arguments; `item.completed` resolves it through
    // the shared `previewCodexMcpToolResult()` mapping: persisted chat's error
    // semantics with a bounded preview of its output. `item.updated` is
    // filtered out above and never creates a second activity or a result.
    const codexToolId = `codex-${item.id}`;
    const server = typeof item.server === 'string' ? item.server : '';
    const tool = typeof item.tool === 'string' ? item.tool : '';
    if (innerType === 'item.started') {
      activity.handleToolUseBlock(
        projectId,
        worktreeId,
        chatId,
        codexToolId,
        codexMcpToolName(server, tool),
        JSON.stringify(item.arguments ?? {}),
      );
    } else {
      const { output, isError } = previewCodexMcpToolResult({
        status: typeof item.status === 'string' ? item.status : '',
        result: item.result,
        error: item.error,
      });
      activity.handleToolResultBlock(
        projectId,
        worktreeId,
        chatId,
        codexToolId,
        output,
        isError,
      );
    }
    return true;
  }
  if (itemType === 'dynamic_tool_call') {
    // Frontend plan §F5.1: route Codex dynamic tool calls (and the
    // synthetic `request_user_input` items) into the activity timeline
    // using the raw provider-accurate tool name, the synthetic
    // `codex-<itemId>` tool-use id, and the same flattened content
    // representation the transcript parser uses.
    const codexToolId = `codex-${item.id}`;
    const rawToolName = typeof item.tool === 'string' ? item.tool : '';
    if (innerType === 'item.started') {
      activity.handleToolUseBlock(
        projectId,
        worktreeId,
        chatId,
        codexToolId,
        rawToolName,
        item.arguments ?? {},
      );
    } else {
      const itemSuccess =
        typeof item.success === 'boolean' ? item.success : null;
      const output = previewCodexDynamicToolContent({
        contentItems: item.content_items,
        success: itemSuccess,
      });
      activity.handleToolResultBlock(
        projectId,
        worktreeId,
        chatId,
        codexToolId,
        output,
        itemSuccess === false || item.status === 'failed',
      );
    }
    return true;
  }
  return true;
}

export function dispatchActivityEvent(
  projectId: string,
  worktreeId: string,
  chatId: string,
  data: Record<string, unknown>,
): void {
  const activity = useActivityStore.getState();
  const eventType = typeof data.type === 'string' ? data.type : '';

  if (eventType === 'codex') {
    dispatchCodexActivityEvent(projectId, worktreeId, chatId, data);
    return;
  }

  if (eventType === 'system') {
    activity.handleSdkSystemEvent(projectId, worktreeId, chatId, data);
    return;
  }

  if (eventType === 'assistant') {
    const message = isRecord(data.message) ? data.message : null;
    const content = Array.isArray(message?.content) ? message.content : [];

    for (const block of content) {
      if (!isRecord(block)) continue;
      const toolBlock = block;
      if (
        toolBlock.type === 'tool_use' &&
        typeof toolBlock.id === 'string' &&
        typeof toolBlock.name === 'string'
      ) {
        activity.handleToolUseBlock(
          projectId,
          worktreeId,
          chatId,
          toolBlock.id,
          toolBlock.name,
          toolBlock.input,
        );
      }
    }

    return;
  }

  if (eventType !== 'user') {
    return;
  }

  const message = isRecord(data.message) ? data.message : null;
  const content = Array.isArray(message?.content) ? message.content : [];

  for (const block of content) {
    if (!isRecord(block)) continue;
    const resultBlock = block;
    if (resultBlock.type !== 'tool_result') continue;
    if (typeof resultBlock.tool_use_id !== 'string') continue;

    activity.handleToolResultBlock(
      projectId,
      worktreeId,
      chatId,
      resultBlock.tool_use_id,
      resultBlock.content,
      resultBlock.is_error === true,
    );
  }
}

export function shouldReconcileBackgroundProcessesAfterTurn(
  data: Record<string, unknown>,
): boolean {
  if (data.type === 'codex') {
    const event = isRecord(data.event) ? data.event : null;
    return event?.type === 'turn.completed';
  }

  return data.type === 'result' && data.canopy_session_continues !== true;
}
