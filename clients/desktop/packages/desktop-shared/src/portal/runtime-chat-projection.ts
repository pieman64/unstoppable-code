import type { AgentArtifactReceiptV1 } from '@canopy/protocol/agent-artifacts';
import {
  extractCanonicalAgentArtifacts,
  MAX_AGENT_ARTIFACT_METADATA_BYTES,
} from '../lib/agent-artifacts';
import { isAgentDelegationTranscript } from '@canopy/protocol/delegation';
import { isClaudeAiCreditsFallbackErrorCode } from '@canopy/protocol/llm-gateway';
import type {
  PortalChatMessage,
  PortalChatPart,
  PortalTurnTimerAutoRoutedModel,
  PortalTurnTimerEndReason,
} from '@canopy/protocol/portal';
import {
  CANOPY_ACCOUNT_PROXY_SWITCH_EVENT_TYPE,
  applyClaudeTranscriptEvent,
  createEmptyTranscriptReducerState,
  delegationTranscriptMessages,
  codexMcpToolName,
  flattenCodexDynamicToolContent,
  flattenCodexMcpToolResult,
  stripMemoryCitationTags,
} from '@canopy/agent-transcript';
import { applyAssistantPatches } from '@canopy/agent-transcript/lib/assistant-snapshot';
import type { PersistedChatMessage } from '../types';
import { isProviderUsageLimitFrame } from './provider-usage-limit';
import { getPortalChatToolFamily } from '../lib/portal-tool-family';
import { isCanopyAskUserToolName } from '../lib/canopy-injected-tools';
import {
  PORTAL_CHAT_PART_TEXT_MAX_CHARS,
  PORTAL_CHAT_TEXT_MAX_CHARS,
  deriveRuntimeChatMessageId,
  isRecord,
  persistedMessageToPortalMessage,
  summarizeUnknown,
  truncateText,
  truncateToolInput,
} from './persisted-chat-projection';

function runtimeReceiptMetadata(
  output: string,
  isError: boolean,
  budget = { remaining: MAX_AGENT_ARTIFACT_METADATA_BYTES },
): { agentArtifacts?: AgentArtifactReceiptV1[] } {
  if (isError) return {};
  const receipts = extractCanonicalAgentArtifacts(output);
  if (!receipts.length) return {};
  const bytes = new TextEncoder().encode(JSON.stringify(receipts)).byteLength;
  if (bytes > budget.remaining) return {};
  budget.remaining -= bytes;
  return { agentArtifacts: receipts };
}

function readString(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === 'string' ? field : undefined;
}

const NON_MESSAGE_RUNTIME_CHAT_EVENT_TYPES = new Set([
  'canopy_ai_credits_routing',
  // Historical one-way archive request retained for persisted transcript
  // projection; new runtime events use canopy_set_auto_archive_requested.
  'canopy_archive_chat_requested',
  // Cursor streams incremental patches against one assistant message, never
  // a self-contained message; a stateless projection of one patch is a blank
  // row. Hosts fold them through `createCursorAssistantPatchProjector`.
  'canopy_assistant_patch',
  // Cursor reported usage is composer banner state, mirrored via the chat
  // summary, not a transcript row.
  'canopy_cursor_usage',
  'canopy_opencode_usage',
  'canopy_set_auto_archive_requested',
  'canopy_usage_limit_reached',
  'canopy_user_prompt',
  'claude_terminal_transcript_sync',
  'phase',
  'system',
  'thread.started',
  'turn_diff',
  'turn.started',
]);

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      if (!isRecord(block)) return '';
      if (typeof block.text === 'string') return block.text;
      if (typeof block.content === 'string') return block.content;
      return '';
    })
    .filter(Boolean)
    .join('\n\n');
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) {
    return summarizeUnknown(content, PORTAL_CHAT_PART_TEXT_MAX_CHARS);
  }
  return content
    .map((entry) => {
      if (isRecord(entry) && typeof entry.text === 'string') return entry.text;
      return summarizeUnknown(entry, PORTAL_CHAT_PART_TEXT_MAX_CHARS);
    })
    .filter(Boolean)
    .join('\n');
}

/**
 * SDK `TerminalReason` values that end a turn by intent rather than by failure.
 * The Claude SDK yields these on a `result` carrying `is_error: true`, so the
 * error flag alone cannot tell a real provider failure from a deliberate stop.
 *
 * `aborted_tools` is the one plan mode rides: `canUseTool` answers
 * `ExitPlanMode` with `behavior: 'deny', interrupt: true`
 * (`claude-session.ts`) so the plan routes into Canopy's own review UI.
 * `aborted_streaming` is the user pressing Stop.
 *
 * NOTE: keep in sync with the duplicates in `main/lib/chat-turn-audit.ts` and
 * the renderer's `stores/chat/turn-events.ts`. Those two already classified
 * both reasons as interrupts, which is why desktop showed the plan while the
 * portal — projecting through this module — claimed "Agent run failed"
 * (CAN-3019). They live in separate process bundles, so a shared import is not
 * appropriate here.
 */
const USER_ABORT_TERMINAL_REASONS = ['aborted_streaming', 'aborted_tools'];

function runtimeStatus(
  data: Record<string, unknown>,
): PortalChatMessage['status'] {
  const type = readString(data, 'type');
  // Check the abort reason BEFORE the error branch: a gracefully-yielded abort
  // sets `is_error: true` and would otherwise read as a failure. Abort reasons
  // only ever arrive on `result` events, so guard on the type — a future frame
  // that happens to carry a matching string must not launder a real failure.
  const terminalReason = readString(data, 'terminal_reason');
  if (
    type === 'result' &&
    terminalReason !== undefined &&
    USER_ABORT_TERMINAL_REASONS.includes(terminalReason)
  ) {
    return 'cancelled';
  }
  if (type === 'error' || data.is_error === true || type === 'turn.failed') {
    return 'failed';
  }
  if (type === 'cancelled' || type === 'turn.cancelled') return 'cancelled';
  return 'complete';
}

function runtimeMessageId(
  data: Record<string, unknown>,
  parts: PortalChatPart[],
  fallbackMessageId: string | undefined,
): string | undefined {
  const toolResult = parts.find((part) => part.kind === 'tool_result');
  const toolUseId = toolResult
    ? readString(toolResult.data, 'toolUseId')
    : undefined;
  return deriveRuntimeChatMessageId(data, toolUseId) ?? fallbackMessageId;
}

function runtimeText(data: Record<string, unknown>): string {
  const direct =
    readString(data, 'text') ??
    readString(data, 'delta') ??
    readString(data, 'result') ??
    readString(data, 'message');
  const message = data.message;
  // Truthy fallthrough: an empty-string direct field falls through to the
  // structured message/data content, matching the pre-strip semantics. The
  // bare `error` code (an SDK enum member like `billing_error`) is the LAST
  // resort: an errored frame that carries real text must show that text, not
  // have it replaced by the code (CAN-2601).
  const raw =
    direct ||
    (isRecord(message)
      ? textFromContent(message.content)
      : textFromContent(data.content)) ||
    readString(data, 'error') ||
    '';
  // Only sanitize model-authored assistant text; error and cancellation
  // surfaces pass through so literal citation syntax in them stays visible.
  const visible =
    runtimeStatus(data) === 'complete' ? stripMemoryCitationTags(raw) : raw;
  return truncateText(visible, PORTAL_CHAT_TEXT_MAX_CHARS);
}

function runtimeParts(data: Record<string, unknown>): PortalChatPart[] {
  const receiptBudget = { remaining: MAX_AGENT_ARTIFACT_METADATA_BYTES };
  const message = isRecord(data.message) ? data.message : null;
  const content = Array.isArray(message?.content)
    ? message.content
    : Array.isArray(data.content)
      ? data.content
      : [];
  const parts: PortalChatPart[] = [];

  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === 'thinking') {
      // Thinking is model output; tool inputs/results below pass through
      // unsanitized so literal citation syntax in tool data stays intact.
      parts.push({
        kind: 'thinking',
        data: {
          text: truncateText(
            stripMemoryCitationTags(
              readString(block, 'thinking') ?? readString(block, 'text') ?? '',
            ),
            PORTAL_CHAT_PART_TEXT_MAX_CHARS,
          ),
        },
      });
      continue;
    }
    if (block.type === 'tool_use') {
      // Provider inputs are parsed JSON objects; serialize them whole so the
      // bound below can keep short fields (a title or path) valid.
      const input =
        typeof block.input === 'string'
          ? block.input
          : isRecord(block.input)
            ? JSON.stringify(block.input)
            : summarizeUnknown(
                block.input ?? {},
                PORTAL_CHAT_PART_TEXT_MAX_CHARS,
              );
      const toolName = readString(block, 'name') ?? 'unknown';
      parts.push({
        kind: 'tool_use',
        toolFamily: getPortalChatToolFamily(toolName),
        data: {
          toolUseId: readString(block, 'id') ?? '',
          toolName,
          input: truncateToolInput(input, PORTAL_CHAT_PART_TEXT_MAX_CHARS),
        },
      });
      continue;
    }
    if (block.type === 'tool_result') {
      parts.push({
        kind: 'tool_result',
        data: {
          toolUseId: readString(block, 'tool_use_id') ?? '',
          ...runtimeReceiptMetadata(
            toolResultText(block.content),
            block.is_error === true,
            receiptBudget,
          ),
          output: truncateText(
            toolResultText(block.content),
            PORTAL_CHAT_PART_TEXT_MAX_CHARS,
          ),
          isError: block.is_error === true,
        },
      });
    }
  }

  return parts.filter((part) => {
    if (part.kind !== 'thinking') return true;
    const partData = isRecord(part.data) ? part.data : {};
    return typeof partData.text === 'string' && partData.text.length > 0;
  });
}

function runtimeCodexMessage(input: {
  chatId: string;
  data: Record<string, unknown>;
}): PortalChatMessage | null {
  const event = isRecord(input.data.event) ? input.data.event : null;
  if (!event) return null;

  const eventType = readString(event, 'type');
  const item = isRecord(event.item) ? event.item : null;
  if (
    !item ||
    (eventType !== 'item.started' &&
      eventType !== 'item.updated' &&
      eventType !== 'item.completed')
  )
    return null;

  const itemId = readString(item, 'id');
  const itemType = readString(item, 'type');
  if (!itemId || !itemType) return null;

  const now = Date.now();
  if (itemType === 'dynamic_tool_call' || itemType === 'mcp_tool_call') {
    // Share identities and result normalization with durable Codex history so
    // hydration replaces the live row instead of introducing another call.
    const toolUseId = `codex-${itemId}`;
    const status = readString(item, 'status') ?? '';
    const dynamic = itemType === 'dynamic_tool_call';
    const toolName = dynamic
      ? (readString(item, 'tool') ?? 'unknown')
      : codexMcpToolName(
          readString(item, 'server') ?? '',
          readString(item, 'tool') ?? '',
        );
    const completed =
      eventType === 'item.completed' ||
      status === 'completed' ||
      status === 'failed';
    const parts: PortalChatPart[] = [
      {
        kind: 'tool_use',
        toolFamily: getPortalChatToolFamily(toolName),
        data: {
          toolUseId,
          toolName,
          input: truncateText(
            JSON.stringify(item.arguments ?? {}),
            PORTAL_CHAT_PART_TEXT_MAX_CHARS,
          ),
        },
      },
    ];
    if (completed) {
      const result = dynamic
        ? {
            output: flattenCodexDynamicToolContent({
              contentItems: item.content_items,
              success: typeof item.success === 'boolean' ? item.success : null,
            }),
            isError: item.success === false || status === 'failed',
          }
        : flattenCodexMcpToolResult({
            status,
            result: item.result,
            error: item.error,
          });
      parts.push({
        kind: 'tool_result',
        data: {
          toolUseId,
          ...runtimeReceiptMetadata(result.output, result.isError),
          output: truncateText(result.output, PORTAL_CHAT_PART_TEXT_MAX_CHARS),
          isError: result.isError,
        },
      });
    }
    return {
      messageId: toolUseId,
      chatId: input.chatId,
      role: 'system',
      status: completed ? 'complete' : 'streaming',
      text: '',
      parts,
      createdAtMs: now,
      updatedAtMs: now,
    };
  }

  if (eventType !== 'item.completed') return null;
  if (itemType === 'reasoning') {
    const text =
      readString(item, 'text') ?? readString(item, 'summary_text') ?? '';
    if (!text.trim()) return null;
    return {
      messageId: `codex-${itemId}`,
      chatId: input.chatId,
      role: 'assistant',
      status: 'complete',
      text: '',
      parts: [
        {
          kind: 'thinking',
          data: {
            text: truncateText(
              stripMemoryCitationTags(text),
              PORTAL_CHAT_PART_TEXT_MAX_CHARS,
            ),
          },
        },
      ],
      createdAtMs: now,
      updatedAtMs: now,
    };
  }

  if (itemType === 'agent_message' || itemType === 'plan') {
    const text = readString(item, 'text') ?? '';
    if (!text.trim()) return null;
    return {
      messageId: `codex-${itemId}`,
      chatId: input.chatId,
      role: 'assistant',
      status: 'complete',
      text: truncateText(
        stripMemoryCitationTags(text),
        PORTAL_CHAT_TEXT_MAX_CHARS,
      ),
      createdAtMs: now,
      updatedAtMs: now,
    };
  }

  if (itemType === 'command_execution') {
    const status = readString(item, 'status') ?? '';
    const exitCode =
      typeof item.exit_code === 'number' ? item.exit_code : undefined;
    const output = readString(item, 'aggregated_output') ?? '';
    const toolName = 'command';
    // Durable Codex history names the call the same way, so a live row and
    // its hydrated copy share one call identity.
    const toolUseId = `codex-${itemId}`;
    return {
      messageId: toolUseId,
      chatId: input.chatId,
      role: 'assistant',
      status: 'complete',
      text: '',
      parts: [
        {
          kind: 'tool_use',
          toolFamily: getPortalChatToolFamily(toolName),
          data: {
            toolUseId,
            toolName,
            input: truncateText(
              readString(item, 'command') ?? '',
              PORTAL_CHAT_PART_TEXT_MAX_CHARS,
            ),
          },
        },
        {
          kind: 'tool_result',
          data: {
            toolUseId,
            ...runtimeReceiptMetadata(
              output,
              status === 'failed' || (exitCode !== undefined && exitCode !== 0),
            ),
            output: truncateText(
              output.length > 0
                ? output
                : status === 'completed'
                  ? 'Done'
                  : status,
              PORTAL_CHAT_PART_TEXT_MAX_CHARS,
            ),
            isError:
              status === 'failed' || (exitCode !== undefined && exitCode !== 0),
          },
        },
      ],
      createdAtMs: now,
      updatedAtMs: now,
    };
  }

  return null;
}

/**
 * Project a raw desktop provider event into the canonical whole-message shape.
 * This browser-safe implementation is shared by Electron main and renderer so
 * the shared chat store never grows a second delta accumulator.
 */
export function runtimeChatEventToPortalMessage(input: {
  scope: 'worktree' | 'standalone' | 'app_advisor';
  workspaceLocalId?: string;
  worktreeLocalId?: string;
  chatId: string;
  data: unknown;
  fallbackMessageId?: string;
}): PortalChatMessage | null {
  if (!isRecord(input.data)) return null;
  // Usage/rate-limit frames are banner state, not transcript messages: the
  // desktop never renders them as rows (transcript-parser routes them to the
  // composer usage-limit banner), and the portal mirrors that banner via
  // `PortalChatSummaryEntity.usageLimit`. Projecting them here produced a
  // literal `rate_limit` bubble plus a failed 429 bubble (CAN-2601), and a
  // failed bubble with OpenAI's upsell text for Codex (CAN-4564).
  if (isProviderUsageLimitFrame(input.data)) return null;
  const type = readString(input.data, 'type');
  const displayErrorCode = input.data.canopy_display_error_code;
  // The canonical reducer attaches the terminal to the assistant's notice,
  // or authors a notice if the SDK emitted only a result. Do not add a second
  // live row for the same rejection ahead of that durable projection.
  if (type === 'result' && isClaudeAiCreditsFallbackErrorCode(displayErrorCode))
    return null;
  if (
    type === 'canopy_delegation' &&
    isAgentDelegationTranscript(input.data.delegation)
  ) {
    const messages = delegationTranscriptMessages(input.data.delegation);
    return persistedMessageToPortalMessage({
      ...input,
      message: messages[0],
      relatedMessages: messages,
    });
  }
  if (type === CANOPY_ACCOUNT_PROXY_SWITCH_EVENT_TYPE) {
    return runtimeAccountProxySwitchMessage({ ...input, data: input.data });
  }
  if (type === 'codex') {
    return runtimeCodexMessage({ chatId: input.chatId, data: input.data });
  }
  // The desktop chat IPC channel also carries known host control records that
  // are not transcript messages. Filter those concrete controls without
  // imposing a policy on future provider message types.
  if (type && NON_MESSAGE_RUNTIME_CHAT_EVENT_TYPES.has(type)) {
    return null;
  }
  const parts = runtimeParts(input.data);
  const isToolResultEvent =
    type === 'user' &&
    parts.some(
      (part) => part.kind === 'tool_result' || part.kind === 'tool_use',
    );
  if (type === 'user' && !isToolResultEvent) return null;

  const text = isToolResultEvent ? '' : runtimeText(input.data);
  const status = runtimeStatus(input.data);
  const isTerminalTurnEvent =
    type === 'result' ||
    type === 'turn.completed' ||
    type === 'turn.cancelled' ||
    type === 'turn.failed';
  if (isTerminalTurnEvent && status !== 'failed') return null;

  const now = Date.now();
  const messageId =
    runtimeMessageId(input.data, parts, input.fallbackMessageId) ??
    `${input.chatId}:${type ?? 'event'}`;
  return {
    messageId,
    chatId: input.chatId,
    role: 'assistant',
    status,
    text: isClaudeAiCreditsFallbackErrorCode(displayErrorCode) ? '' : text,
    ...(isClaudeAiCreditsFallbackErrorCode(displayErrorCode)
      ? {
          parts: [
            { kind: 'text', data: { text, errorCode: displayErrorCode } },
          ],
        }
      : parts.length > 0
        ? { parts }
        : {}),
    createdAtMs: now,
    updatedAtMs: now,
  };
}

/**
 * The account proxy moved the chat to another account. Every provider's
 * reducer persists the event the same way, so the live row is that persisted
 * row, projected as the owner's Portal shows it after a reload.
 */
function runtimeAccountProxySwitchMessage(input: {
  scope: 'worktree' | 'standalone' | 'app_advisor';
  workspaceLocalId?: string;
  worktreeLocalId?: string;
  chatId: string;
  data: Record<string, unknown>;
}): PortalChatMessage | null {
  const now = Date.now();
  const [message] = applyClaudeTranscriptEvent(
    createEmptyTranscriptReducerState(),
    input.data,
    {
      now,
      createMessageId: (): string =>
        `${input.chatId}:account-proxy-switch:${now}`,
    },
  ).messages;
  if (message === undefined) return null;
  return persistedMessageToPortalMessage({ ...input, message });
}

/** True for the incremental assistant patch frames the Cursor harness emits. */
export function isCursorAssistantPatchEvent(
  data: unknown,
): data is Record<string, unknown> {
  return (
    isRecord(data) &&
    data.type === 'canopy_assistant_patch' &&
    (data.provider === 'cursor' ||
      data.provider === 'copilot' ||
      data.provider === 'opencode')
  );
}

export interface CursorAssistantPatchProjector {
  /**
   * Fold one live event. Returns the complete projected message after a
   * Cursor patch applies, or `null` for any other event and for a patch the
   * folded state cannot accept (which is dropped, never shown blank).
   */
  apply(data: unknown): PortalChatMessage | null;
}

/**
 * Stateful live projection for Cursor turns (Remote Control).
 *
 * Claude and Codex emit self-contained frames, so
 * {@link runtimeChatEventToPortalMessage} can project each one on its own.
 * Cursor's `CursorEventProjection` instead streams `canopy_assistant_patch`
 * frames — `{ index, block }` and `{ index, appendText }` edits against one
 * assistant (or host-notice `system`) message — exactly the shape the state
 * service folds into the persisted transcript with `applyAssistantPatches`.
 * One projector per dispatched turn replays that same fold in memory and
 * re-projects the whole message each revision, so the browser sees the text
 * grow under the patch's own `messageId` (the persisted id) instead of a
 * blank fallback-keyed row. `updatedAtMs` is strictly monotonic per message
 * so consumers that key wire updates on it treat every revision as new.
 */
export function createCursorAssistantPatchProjector(input: {
  scope: 'worktree' | 'standalone' | 'app_advisor';
  workspaceLocalId?: string;
  worktreeLocalId?: string;
  chatId: string;
}): CursorAssistantPatchProjector {
  const folded = new Map<string, PersistedChatMessage>();
  const lastUpdatedAtMs = new Map<string, number>();
  return {
    apply(data: unknown): PortalChatMessage | null {
      if (!isCursorAssistantPatchEvent(data)) return null;
      const messageId = readString(data, 'messageId');
      if (!messageId) return null;
      const message = applyAssistantPatches(folded.get(messageId), data);
      if (!message) return null;
      folded.set(messageId, message);
      const updatedAtMs = Math.max(
        Date.now(),
        (lastUpdatedAtMs.get(messageId) ?? 0) + 1,
      );
      lastUpdatedAtMs.set(messageId, updatedAtMs);
      return {
        ...persistedMessageToPortalMessage({
          scope: input.scope,
          ...(input.workspaceLocalId !== undefined
            ? { workspaceLocalId: input.workspaceLocalId }
            : {}),
          ...(input.worktreeLocalId !== undefined
            ? { worktreeLocalId: input.worktreeLocalId }
            : {}),
          chatId: input.chatId,
          message,
        }),
        updatedAtMs,
      };
    },
  };
}

export function isTerminalRuntimeChatEvent(data: unknown): boolean {
  if (!isRecord(data)) return false;
  const type = readString(data, 'type');
  if (type === 'error') return true;
  if (type === 'result') return data.canopy_session_continues !== true;
  if (
    type === 'cancelled' ||
    type === 'turn.completed' ||
    type === 'turn.cancelled' ||
    type === 'turn.failed'
  ) {
    return true;
  }
  if (type === 'codex' && isRecord(data.event)) {
    const eventType = readString(data.event, 'type');
    return (
      eventType === 'turn.completed' ||
      eventType === 'turn.failed' ||
      eventType === 'turn.cancelled'
    );
  }
  return false;
}

/**
 * How a terminal runtime event says the turn ended, when it did not end
 * normally. Stamped on the completed timer row so a consumer can tell a
 * stopped or failed turn from a clean one (the row itself stays
 * `status: 'complete'`). Covers the shapes each provider really emits:
 *
 * - Claude: a `result` with an abort `terminal_reason`, or the graceful
 *   `{ result: 'Session aborted' }` (`is_error: false`).
 * - Codex: `{ type: 'codex', event: { type: 'turn.completed', status:
 *   'interrupted' } }`, then `{ type: 'result', result: 'Turn cancelled' }`;
 *   a failed turn is `turn.failed`.
 * - Cursor: a `result` with `subtype: 'cancelled'` / `result: 'Turn cancelled'`.
 *
 * NOTE: mirrors `getChatTurnAuditStatus` in the desktop app's
 * `main/lib/chat-turn-audit.ts` (which cannot be imported here), and adds the
 * Codex interrupted status and Cursor `subtype`, which that audit reads as
 * success. Keep the two in step.
 */
export function turnTimerEndReason(
  data: unknown,
): PortalTurnTimerEndReason | undefined {
  if (!isRecord(data)) return undefined;
  const type = readString(data, 'type');
  if (type === 'codex') {
    const event = isRecord(data.event) ? data.event : null;
    const eventType = event ? readString(event, 'type') : undefined;
    if (eventType === 'turn.failed' || eventType === 'error') return 'failed';
    if (eventType === 'turn.cancelled') return 'cancelled';
    if (eventType === 'turn.completed' && event) {
      return readString(event, 'status') === 'interrupted'
        ? 'cancelled'
        : undefined;
    }
    return undefined;
  }
  if (type === 'result') {
    // Stop reads as an error on some paths, so check it before `is_error`.
    const terminalReason = readString(data, 'terminal_reason');
    if (
      (terminalReason !== undefined &&
        USER_ABORT_TERMINAL_REASONS.includes(terminalReason)) ||
      readString(data, 'subtype') === 'cancelled'
    ) {
      return 'cancelled';
    }
  }
  if (type === 'error' || data.is_error === true || type === 'turn.failed') {
    return 'failed';
  }
  if (type === 'cancelled' || type === 'turn.cancelled') return 'cancelled';
  if (type === 'result') {
    const resultText = (readString(data, 'result') ?? '').trim().toLowerCase();
    if (
      resultText === 'turn cancelled' ||
      resultText === 'session aborted' ||
      resultText === 'session ended'
    ) {
      return 'cancelled';
    }
  }
  return undefined;
}

export interface PortalTurnTimer {
  startMessage: PortalChatMessage;
  updateForEvent(data: unknown): PortalChatMessage | null;
  updateForMessage(message: PortalChatMessage): PortalChatMessage | null;
  completeForEvent(data: unknown): PortalChatMessage | null;
  finalize(): PortalChatMessage | null;
}

function isAskUserToolName(toolName: string | undefined): boolean {
  return isCanopyAskUserToolName(toolName) || toolName === 'request_user_input';
}

export function createPortalTurnTimer(input: {
  chatId: string;
  userMessageId: string;
  /** The model Auto picked for this turn, when Auto routed it. */
  autoRoutedModel?: PortalTurnTimerAutoRoutedModel;
}): PortalTurnTimer {
  const startedAt = Date.now();
  const messageId = `${input.userMessageId}:turn-timer`;
  let completed = false;
  let pausedAt: number | null = null;
  let resumedAt: number | null = null;
  let accumulatedPausedDurationMs = 0;
  const pendingAskUserToolIds = new Set<string>();
  const timerMessage = (
    status: PortalChatMessage['status'],
    completedAt: number | null,
    updatedAtMs: number,
    endReason?: PortalTurnTimerEndReason,
  ): PortalChatMessage => ({
    messageId,
    chatId: input.chatId,
    role: 'system',
    status,
    text: '',
    parts: [
      {
        kind: 'turn_timer',
        data: {
          startedAt,
          pausedAt,
          resumedAt,
          accumulatedPausedDurationMs,
          completedAt,
          ...(endReason === undefined ? {} : { endReason }),
          ...input.autoRoutedModel,
        },
      },
    ],
    createdAtMs: updatedAtMs,
    updatedAtMs,
  });
  const completedMessage = (
    endReason?: PortalTurnTimerEndReason,
  ): PortalChatMessage => {
    completed = true;
    const now = Date.now();
    const completedAt =
      pausedAt !== null && resumedAt === null ? pausedAt : now;
    return timerMessage('complete', completedAt, now, endReason);
  };
  const pauseForTool = (toolUseId: string): PortalChatMessage | null => {
    pendingAskUserToolIds.add(toolUseId);
    if (pausedAt !== null && resumedAt === null) return null;
    pausedAt = Date.now();
    resumedAt = null;
    return timerMessage('streaming', null, pausedAt);
  };
  const resumeForTool = (toolUseId: string): PortalChatMessage | null => {
    if (!pendingAskUserToolIds.delete(toolUseId)) return null;
    if (
      pendingAskUserToolIds.size > 0 ||
      pausedAt === null ||
      resumedAt !== null
    ) {
      return null;
    }
    resumedAt = Date.now();
    accumulatedPausedDurationMs += Math.max(0, resumedAt - pausedAt);
    return timerMessage('streaming', null, resumedAt);
  };
  return {
    startMessage: timerMessage('streaming', null, startedAt),
    updateForEvent(data: unknown): PortalChatMessage | null {
      if (
        completed ||
        !isRecord(data) ||
        readString(data, 'type') !== 'codex'
      ) {
        return null;
      }
      const event = isRecord(data.event) ? data.event : null;
      const item = event && isRecord(event.item) ? event.item : null;
      if (!event || !item || readString(item, 'type') !== 'dynamic_tool_call') {
        return null;
      }
      const toolName = readString(item, 'tool');
      const toolUseId = readString(item, 'id');
      if (!isAskUserToolName(toolName) || !toolUseId) return null;
      const eventType = readString(event, 'type');
      if (eventType === 'item.started')
        return pauseForTool(`codex-${toolUseId}`);
      if (eventType === 'item.completed')
        return resumeForTool(`codex-${toolUseId}`);
      return null;
    },
    updateForMessage(message: PortalChatMessage): PortalChatMessage | null {
      if (completed) return null;
      const completedToolIds = new Set(
        (message.parts ?? [])
          .filter((part) => part.kind === 'tool_result')
          .map((part) => readString(part.data, 'toolUseId')),
      );
      for (const part of message.parts ?? []) {
        const data = isRecord(part.data) ? part.data : {};
        if (part.kind === 'tool_use') {
          const toolName = readString(data, 'toolName');
          const toolUseId = readString(data, 'toolUseId');
          if (
            isAskUserToolName(toolName) &&
            toolUseId &&
            !completedToolIds.has(toolUseId)
          ) {
            return pauseForTool(toolUseId);
          }
        } else if (part.kind === 'tool_result') {
          const toolUseId = readString(data, 'toolUseId');
          if (toolUseId) {
            const resumed = resumeForTool(toolUseId);
            if (resumed) return resumed;
          }
        }
      }
      return null;
    },
    completeForEvent(data: unknown): PortalChatMessage | null {
      if (!isTerminalRuntimeChatEvent(data)) return null;
      // Deliberately NOT gated on `completed`: a loop wakeup continues the
      // same turn (no new user row) and ends it again later, and the desktop
      // renderer extends its timer to that later completion. Re-emitting the
      // completed row with the newer `completedAt` keeps the portal's
      // "Completed in M:SS" in step; the browser's timer merge replaces a
      // completed frame with a later completed one (only a reopen is refused).
      return completedMessage(turnTimerEndReason(data));
    },
    finalize(): PortalChatMessage | null {
      if (completed) return null;
      return completedMessage();
    },
  };
}
