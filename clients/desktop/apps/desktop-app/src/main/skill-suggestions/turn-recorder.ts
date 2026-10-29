import type { AgentAuditStatus } from '@canopy/desktop-shared/types/observability';
import { logMainProcessWarn } from '../lib/main-process-logging';
import { isSkillSuggestionsEnabled } from './feature-gate';
import {
  appendToolShape,
  leadingSkillInvocation,
  MAX_PROMPT_INPUT_CHARS,
  toolShapeEntry,
} from './normalize';

/**
 * Live-turn taps for repeat-task skill suggestions (CAN-385), called from the
 * observability service. `observe` runs on every streamed event, so it is one
 * map lookup unless a turn is open for that key. Nothing here can throw into
 * the service; completed turns are handed to an async sink off the
 * streaming path.
 */
export interface TurnRecorderBeginOptions {
  projectId: string;
  worktreeId: string;
  chatId: string;
  userMessageId?: string;
  originalUserText: string;
  skillSuggestionEligible?: boolean;
  assistantMode?: string;
  chatMode?: string;
}

export interface RecordedTurn {
  projectId: string;
  worktreeId: string;
  chatId: string;
  userMessageId: string;
  auditEntryId: string;
  /** Capped at {@link MAX_PROMPT_INPUT_CHARS}; redacted before storage. */
  promptText: string;
  startedAt: number;
  completedAt: number;
  /** Ordered, de-duplicated; subagent calls excluded. */
  tools: string[];
  status: AgentAuditStatus;
}

export type RecordedTurnSink = (turn: RecordedTurn) => void | Promise<void>;

interface OpenTurnRecord {
  projectId: string;
  worktreeId: string;
  chatId: string;
  userMessageId: string;
  auditEntryId: string;
  promptText: string;
  startedAt: number;
  tools: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function readString(
  value: Record<string, unknown>,
  key: string,
): string | null {
  const field = value[key];
  return typeof field === 'string' && field.length > 0 ? field : null;
}

/**
 * The one provider event table. Claude-shaped `assistant` events (Claude and
 * providers that reuse its shape) and Codex `item.started` events are read;
 * every other shape is ignored without parsing.
 */
export function toolEntriesFromEvent(data: Record<string, unknown>): string[] {
  if (data.type === 'assistant') {
    // Subagent turns carry the parent tool use id.
    if (readString(data, 'parent_tool_use_id')) return [];
    const message = isRecord(data.message) ? data.message : null;
    const content = Array.isArray(message?.content) ? message.content : [];
    const entries: string[] = [];
    for (const block of content) {
      if (!isRecord(block) || block.type !== 'tool_use') continue;
      const name = readString(block, 'name');
      if (!name) continue;
      const input = isRecord(block.input) ? block.input : undefined;
      const entry = toolShapeEntry(name, input);
      if (entry) entries.push(entry);
    }
    return entries;
  }
  if (data.type === 'codex' && isRecord(data.event)) {
    const event = data.event;
    if (event.type !== 'item.started' || !isRecord(event.item)) return [];
    const item = event.item;
    const itemType = readString(item, 'type');
    if (itemType === 'mcp_tool_call') {
      const server = readString(item, 'server');
      return server ? [`mcp:${server}`] : [];
    }
    if (itemType === 'collab_agent_tool_call') return [];
    if (itemType === 'dynamic_tool_call' || itemType === 'dynamicToolCall') {
      const tool = readString(item, 'tool');
      const entry = tool ? toolShapeEntry(tool) : null;
      return entry ? [entry] : [];
    }
    if (
      itemType === 'command_execution' ||
      itemType === 'file_change' ||
      itemType === 'web_search'
    ) {
      return [itemType];
    }
    return [];
  }
  return [];
}

export class SkillSuggestionTurnRecorder {
  private readonly open = new Map<string, OpenTurnRecord>();
  private sink: RecordedTurnSink | null = null;
  private loggedFailure = false;

  constructor(
    private readonly isEnabled: () => boolean = isSkillSuggestionsEnabled,
    private readonly now: () => number = Date.now,
  ) {}

  setSink(sink: RecordedTurnSink | null): void {
    this.sink = sink;
  }

  private logFailure(error: unknown): void {
    if (this.loggedFailure) return;
    this.loggedFailure = true;
    logMainProcessWarn('[skill-suggestions] turn recorder failed', error);
  }

  begin(
    key: string,
    auditEntryId: string,
    options: TurnRecorderBeginOptions,
  ): void {
    try {
      this.open.delete(key);
      if (
        options.skillSuggestionEligible !== true ||
        options.assistantMode !== undefined ||
        options.chatMode === 'terminal' ||
        !options.userMessageId ||
        !this.sink ||
        !this.isEnabled()
      )
        return;
      const promptText = options.originalUserText.slice(
        0,
        MAX_PROMPT_INPUT_CHARS,
      );
      const tools: string[] = [];
      const leading = leadingSkillInvocation(promptText);
      if (leading) appendToolShape(tools, `skill:${leading}`);
      this.open.set(key, {
        projectId: options.projectId,
        worktreeId: options.worktreeId,
        chatId: options.chatId,
        userMessageId: options.userMessageId,
        auditEntryId,
        promptText,
        startedAt: this.now(),
        tools,
      });
    } catch (error) {
      this.logFailure(error);
    }
  }

  observe(key: string, data: Record<string, unknown>): void {
    const record = this.open.get(key);
    if (!record) return;
    try {
      for (const entry of toolEntriesFromEvent(data)) {
        appendToolShape(record.tools, entry);
      }
    } catch (error) {
      this.logFailure(error);
    }
  }

  /** No-op for a key with no open record or a different audit entry. */
  complete(key: string, auditEntryId: string, status: AgentAuditStatus): void {
    const record = this.open.get(key);
    if (!record) return;
    this.open.delete(key);
    try {
      if (record.auditEntryId !== auditEntryId) return;
      const sink = this.sink;
      if (!sink || !this.isEnabled()) return;
      const turn: RecordedTurn = {
        ...record,
        tools: [...record.tools],
        completedAt: this.now(),
        status,
      };
      // Off the finalization path; the sink owns its own error handling.
      setImmediate(() => {
        Promise.resolve()
          .then(() => sink(turn))
          .catch((error: unknown) => this.logFailure(error));
      });
    } catch (error) {
      this.logFailure(error);
    }
  }

  /** The gate closed: open turn records are dropped. */
  dropOpenTurns(): void {
    this.open.clear();
  }

  hasOpenTurn(key: string): boolean {
    return this.open.has(key);
  }
}

export const skillSuggestionTurnRecorder = new SkillSuggestionTurnRecorder();
