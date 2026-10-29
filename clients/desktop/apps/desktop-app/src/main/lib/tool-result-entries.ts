/**
 * Pure readers for the tool results a streamed provider event carries.
 *
 * Shared by the authentication-failure pairing (`auth-failure-event.ts`) and
 * the chat turn's commit overlap (`session-event-commit-pipeline.ts`), which
 * must agree on which events carry an errored tool result: those are the
 * events a paired `canopy_auth_failure` follows.
 */
import { isRecord } from './type-guards';

export interface ToolResultEntry {
  toolUseId: string;
  isError: boolean;
}

/**
 * `Array.isArray` narrows an `unknown` to `any[]`, not `unknown[]`, which
 * would reintroduce unsafe-argument errors on every element read below.
 * This predicate keeps elements typed as `unknown`.
 */
function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

/**
 * Read a streamed provider event's `message.content` array, if present.
 *
 * Verified against the Claude Agent SDK's streamed `SDKMessage` shape only:
 * `claude-session.ts` clones each SDK message and forwards it as-is
 * (`apps/desktop-app/src/main/agents/claude-session.ts:1696-1713`), so
 * `data` for a tool_use/tool_result-bearing event is the raw Anthropic
 * Messages shape — `{ type: 'user' | 'assistant', message: { content: [
 * { type: 'tool_use', id, name, ... } | { type: 'tool_result',
 * tool_use_id, is_error, content } ] } }`.
 *
 * Codex does NOT use this shape; see {@link readCodexDynamicToolItem} for the
 * app-server item envelope read instead.
 */
export function readMessageContent(event: unknown): unknown[] | null {
  if (!isRecord(event)) return null;
  const message = event.message;
  if (!isRecord(message)) return null;
  const content = message.content;
  return isUnknownArray(content) ? content : null;
}

/** A Codex `dynamic_tool_call` thread item, read from the forwarded envelope. */
export interface CodexDynamicToolItem {
  phase: 'item.started' | 'item.completed';
  /** The transcript's block id for this item (`transcript-parser.ts`). */
  toolUseId: string;
  /** Provider-accurate dynamic tool name, e.g. `<brand>_watch_github_items`. */
  tool: string;
  status: string;
  success: boolean | null;
}

/**
 * Read a Codex dynamic tool call from the envelope `codex-session.ts`
 * forwards: `{ type: 'codex', event: { type: 'item.started' |
 * 'item.completed', item } }`, where `item` is the projected
 * `dynamic_tool_call` shape from `thread-item-projection.ts` (`id`, `tool`,
 * `status`, `success`). Canopy's injected tools reach Codex ONLY as dynamic
 * tools, so this is the complete surface the injected-tool family of
 * authentication failures needs.
 *
 * Failure is signalled by `success: false` or `status: 'failed'`, never by an
 * `is_error` flag, and the correlation key is the item's own `id`. The
 * transcript reducer names the resulting `tool_use`/`tool_result` blocks
 * `codex-<id>`, so that is the id returned here and later placed on the
 * `canopy_auth_failure` event — anything else would attach to no block.
 *
 * `mcp_tool_call` items are deliberately NOT read: the MCP-proxy family of
 * authentication failures stays Claude-only because Codex records those
 * failures under a per-client route owner id the pairing is never handed (see
 * `pairPendingAuthFailuresWithTool`).
 */
export function readCodexDynamicToolItem(
  event: unknown,
): CodexDynamicToolItem | null {
  if (!isRecord(event) || event.type !== 'codex') return null;
  const inner = event.event;
  if (!isRecord(inner)) return null;
  const phase = inner.type;
  if (phase !== 'item.started' && phase !== 'item.completed') return null;
  const item = inner.item;
  if (!isRecord(item) || item.type !== 'dynamic_tool_call') return null;
  const { id, tool, status, success } = item;
  if (typeof id !== 'string' || id.length === 0) return null;
  if (typeof tool !== 'string' || tool.length === 0) return null;
  return {
    phase,
    toolUseId: `codex-${id}`,
    tool,
    status: typeof status === 'string' ? status : '',
    success: typeof success === 'boolean' ? success : null,
  };
}

/** The tool results an event carries: Claude `tool_result` blocks, or a completed Codex dynamic tool call. */
export function readToolResultEntries(event: unknown): ToolResultEntry[] {
  const codexItem = readCodexDynamicToolItem(event);
  if (codexItem) {
    if (codexItem.phase !== 'item.completed') return [];
    return [
      {
        toolUseId: codexItem.toolUseId,
        isError: codexItem.success === false || codexItem.status === 'failed',
      },
    ];
  }

  const content = readMessageContent(event);
  if (!content) return [];

  const out: ToolResultEntry[] = [];
  for (const entry of content) {
    if (!isRecord(entry)) continue;
    if (entry.type !== 'tool_result') continue;
    const toolUseId = entry.tool_use_id;
    if (typeof toolUseId !== 'string') continue;
    out.push({ toolUseId, isError: entry.is_error === true });
  }
  return out;
}

/**
 * Whether the event carries at least one errored tool result: the only kind
 * of event `pairPendingAuthFailuresWithTool` can pair an authentication
 * failure with.
 */
export function hasErroredToolResult(event: unknown): boolean {
  return readToolResultEntries(event).some((entry) => entry.isError);
}
