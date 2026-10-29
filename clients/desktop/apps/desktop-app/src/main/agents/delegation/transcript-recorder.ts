import { type AgentDelegationTranscriptItem } from '@canopy/protocol/delegation';
import { DELEGATION_TRANSCRIPT_LIMITS } from '@canopy/desktop-shared/node/delegation/types';
import { sameDelegationItem } from './item-changes';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function record(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}
function string(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
function output(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value))
    return value
      .map((item) => {
        const data = record(item);
        return string(data?.text);
      })
      .filter(Boolean)
      .join('\n');
  return value === undefined || value === null ? '' : JSON.stringify(value);
}

type ItemContent =
  | { type: 'text' | 'thinking'; text: string }
  | {
      type: 'tool';
      toolName: string;
      input: string;
      output?: string;
      isError?: boolean;
    };

export const DELEGATION_TRANSCRIPT_RECORDER_LIMITS =
  DELEGATION_TRANSCRIPT_LIMITS;

/**
 * Streamed command output kept per command until it completes: the first
 * and the latest characters, near a Claude Bash result's size, so verbose
 * commands stay well inside the per-item and total transcript budgets.
 */
const COMMAND_OUTPUT_HEAD_CHARACTERS = 16_000;
const COMMAND_OUTPUT_TAIL_CHARACTERS = 16_000;
/** Commands buffered at once; output of any further one is not kept. */
const COMMAND_OUTPUT_BUFFERS = 64;

interface CommandOutputBuffer {
  head: string;
  tail: string;
  omitted: boolean;
}

/** Bounded cumulative items, stable native ids and first-observed chronology. No raw session/config payload escapes. */
export class DelegationTranscriptRecorder {
  private readonly items = new Map<string, AgentDelegationTranscriptItem>();
  private readonly itemBytes = new Map<string, number>();
  private readonly completed = new Set<string>();
  private streamingMessageId?: string;
  private readonly streamBlocks = new Map<number, string>();
  private readonly commandOutput = new Map<string, CommandOutputBuffer>();
  private ordinal = 0;
  private totalBytes = 0;
  private revision = 0;
  private deliveredRevision = -1;
  truncated = false;
  limitExceeded = false;

  snapshot(): readonly AgentDelegationTranscriptItem[] {
    return Array.from(this.items.values());
  }
  take(): readonly AgentDelegationTranscriptItem[] | undefined {
    if (this.deliveredRevision === this.revision) return undefined;
    this.deliveredRevision = this.revision;
    return this.snapshot();
  }
  private markLimitExceeded(): void {
    if (this.limitExceeded) return;
    this.limitExceeded = true;
    this.truncated = true;
    this.revision++;
  }
  private update(id: string, content: ItemContent, complete = false): void {
    if (
      this.limitExceeded ||
      !id ||
      id.length > 512 ||
      /[\0\r\n]/.test(id) ||
      this.completed.has(id)
    )
      return;
    const prior = this.items.get(id);
    if (
      !prior &&
      this.items.size >= DELEGATION_TRANSCRIPT_RECORDER_LIMITS.items
    ) {
      this.markLimitExceeded();
      return;
    }
    const item: AgentDelegationTranscriptItem = {
      ...content,
      id,
      sequence: prior?.sequence ?? this.ordinal + 1,
      occurredAt: prior?.occurredAt ?? Date.now(),
    };
    const bytes = Buffer.byteLength(JSON.stringify(item), 'utf8');
    const priorBytes = this.itemBytes.get(id) ?? 0;
    if (
      bytes > DELEGATION_TRANSCRIPT_RECORDER_LIMITS.itemBytes ||
      this.totalBytes - priorBytes + bytes >
        DELEGATION_TRANSCRIPT_RECORDER_LIMITS.totalBytes
    ) {
      this.markLimitExceeded();
      return;
    }
    if (!sameDelegationItem(prior, item)) {
      this.items.set(id, item);
      this.itemBytes.set(id, bytes);
      this.totalBytes += bytes - priorBytes;
      if (!prior) this.ordinal++;
      this.revision++;
    }
    if (complete) this.completed.add(id);
  }
  private delta(id: string, type: 'text' | 'thinking', text: string): void {
    const prior = this.items.get(id);
    this.update(id, {
      type,
      text: (prior && prior.type !== 'tool' ? prior.text : '') + text,
    });
  }

  cursor(value: unknown): void {
    const event = record(value);
    if (
      event?.type !== 'canopy_assistant_patch' ||
      !Array.isArray(event.patches)
    )
      return;
    for (const raw of event.patches) {
      const patch = record(raw);
      if (!patch || typeof patch.index !== 'number') continue;
      const id = `${string(event.messageId)}:${patch.index}`;
      const block = record(patch.block);
      if (block?.type === 'text' || block?.type === 'thinking')
        this.update(id, {
          type: block.type,
          text: string(block.text ?? block.thinking),
        });
      else if (block?.type === 'tool_use')
        this.update(string(block.toolUseId), {
          type: 'tool',
          toolName: string(block.toolName),
          input: string(block.input),
        });
      else if (block?.type === 'tool_result') {
        const prior = this.items.get(string(block.toolUseId));
        if (prior?.type === 'tool')
          this.update(
            prior.id,
            {
              ...prior,
              output: string(block.output),
              isError: block.isError === true,
            },
            true,
          );
      }
      if (typeof patch.appendText === 'string') {
        const prior = this.items.get(id);
        if (prior && prior.type !== 'tool')
          this.delta(id, prior.type, patch.appendText);
      }
    }
  }

  claude(value: unknown): void {
    const outer = record(value);
    if (!outer) return;
    const event = outer.type === 'stream_event' ? record(outer.event) : outer;
    if (!event) return;
    const message = record(event.message);
    if (event.type === 'message_start') {
      this.streamingMessageId = string(message?.id) || undefined;
      this.streamBlocks.clear();
    }
    const index = typeof event.index === 'number' ? event.index : 0;
    if (event.type === 'content_block_start' && this.streamingMessageId) {
      const block = record(event.content_block);
      if (block) {
        const id =
          block.type === 'tool_use'
            ? string(block.id)
            : `${this.streamingMessageId}:${index}`;
        this.claudeBlock(id, block);
        if (this.items.has(id)) this.streamBlocks.set(index, id);
      }
    }
    if (event.type === 'content_block_delta') {
      const id = this.streamBlocks.get(index),
        delta = record(event.delta);
      if (id && delta?.type === 'text_delta')
        this.delta(id, 'text', string(delta.text));
      if (id && delta?.type === 'thinking_delta')
        this.delta(id, 'thinking', string(delta.thinking));
      if (id && delta?.type === 'input_json_delta') {
        const prior = this.items.get(id);
        if (prior?.type === 'tool')
          this.update(id, {
            ...prior,
            input:
              (prior.input === '{}' ? '' : prior.input) +
              string(delta.partial_json),
          });
      }
    }
    if (
      (event.type === 'assistant' || event.type === 'user') &&
      Array.isArray(message?.content)
    ) {
      message.content.forEach((raw, i) => {
        const block = record(raw);
        if (!block) return;
        const id =
          block.type === 'tool_use'
            ? string(block.id)
            : block.type === 'tool_result'
              ? string(block.tool_use_id)
              : `${string(message.id)}:${i}`;
        this.claudeBlock(id, block, true);
      });
    }
  }
  private claudeBlock(
    id: string,
    block: Record<string, unknown>,
    complete = false,
  ): void {
    if (block.type === 'text')
      this.update(id, { type: 'text', text: string(block.text) }, complete);
    if (block.type === 'thinking')
      this.update(
        id,
        { type: 'thinking', text: string(block.thinking) },
        complete,
      );
    if (block.type === 'tool_use')
      this.update(id, {
        type: 'tool',
        toolName: string(block.name),
        input: output(block.input),
      });
    if (block.type === 'tool_result') {
      const prior = this.items.get(id);
      if (prior?.type === 'tool')
        this.update(
          id,
          {
            ...prior,
            output: output(block.content),
            isError: block.is_error === true,
          },
          true,
        );
    }
  }

  /** Buffers a command's streamed output; the completed item may omit it. */
  private commandDelta(id: string, text: string): void {
    if (!id || !text || this.limitExceeded || this.completed.has(id)) return;
    let buffer = this.commandOutput.get(id);
    if (!buffer) {
      if (this.commandOutput.size >= COMMAND_OUTPUT_BUFFERS) return;
      buffer = { head: '', tail: '', omitted: false };
      this.commandOutput.set(id, buffer);
    }
    let rest = text;
    if (!buffer.tail && buffer.head.length < COMMAND_OUTPUT_HEAD_CHARACTERS) {
      const room = COMMAND_OUTPUT_HEAD_CHARACTERS - buffer.head.length;
      buffer.head += rest.slice(0, room);
      rest = rest.slice(room);
    }
    if (!rest) return;
    const tail = buffer.tail + rest;
    if (tail.length > COMMAND_OUTPUT_TAIL_CHARACTERS) {
      buffer.omitted = true;
      buffer.tail = tail.slice(tail.length - COMMAND_OUTPUT_TAIL_CHARACTERS);
    } else buffer.tail = tail;
  }
  private takeCommandOutput(id: string): string {
    const buffer = this.commandOutput.get(id);
    this.commandOutput.delete(id);
    if (!buffer) return '';
    return buffer.omitted
      ? `${buffer.head}\n… output truncated …\n${buffer.tail}`
      : buffer.head + buffer.tail;
  }

  codex(value: { method: string; params: Record<string, unknown> }): void {
    const { method, params } = value;
    const id = string(params.itemId);
    if (method === 'item/commandExecution/outputDelta')
      this.commandDelta(id, string(params.delta));
    if (method === 'item/agentMessage/delta')
      this.delta(id, 'text', string(params.delta));
    if (
      method === 'item/reasoning/summaryTextDelta' ||
      method === 'item/reasoning/textDelta'
    )
      this.delta(id, 'thinking', string(params.delta));
    const item = record(params.item);
    if (
      !item ||
      !['item/started', 'item/completed', 'item/updated'].includes(method)
    )
      return;
    const itemId = string(item.id),
      complete = method === 'item/completed';
    if (item.type === 'agentMessage')
      this.update(itemId, { type: 'text', text: string(item.text) }, complete);
    if (item.type === 'reasoning')
      this.update(
        itemId,
        {
          type: 'thinking',
          text: (Array.isArray(item.content) && item.content.length
            ? item.content
            : Array.isArray(item.summary)
              ? item.summary
              : []
          )
            .filter((v) => typeof v === 'string')
            .join('\n'),
        },
        complete,
      );
    if (item.type === 'commandExecution') {
      // The completed item can omit output that only streamed as deltas.
      const streamed = complete ? this.takeCommandOutput(itemId) : '';
      this.update(
        itemId,
        {
          type: 'tool',
          toolName: 'Bash',
          input: JSON.stringify({ command: item.command, cwd: item.cwd }),
          ...(complete
            ? {
                output:
                  string(item.aggregatedOutput) ||
                  streamed ||
                  (item.status === 'completed' ? 'Done' : string(item.status)),
                isError:
                  item.status === 'failed' ||
                  item.status === 'declined' ||
                  (typeof item.exitCode === 'number' && item.exitCode !== 0),
              }
            : {}),
        },
        complete,
      );
    }
    if (item.type === 'fileChange')
      this.update(
        itemId,
        {
          type: 'tool',
          toolName: 'file_change',
          // Match the native Codex transcript's file-edit summary. These are
          // structured changes, not Claude text content blocks.
          input: (Array.isArray(item.changes) ? item.changes : [])
            .flatMap((value) => {
              const change = record(value);
              const kind = string(record(change?.kind)?.type);
              const filePath = string(change?.path);
              return kind && filePath ? [`${kind}: ${filePath}`] : [];
            })
            .join('\n'),
          ...(complete
            ? {
                output: string(item.status),
                isError: item.status === 'failed' || item.status === 'declined',
              }
            : {}),
        },
        complete,
      );
    if (item.type === 'dynamicToolCall')
      this.update(
        itemId,
        {
          type: 'tool',
          toolName: string(item.tool),
          input: output(item.arguments),
          ...(complete
            ? {
                output: output(item.contentItems),
                isError: item.success === false,
              }
            : {}),
        },
        complete,
      );
    if (item.type === 'mcpToolCall')
      this.update(
        itemId,
        {
          type: 'tool',
          toolName: `mcp__${string(item.server)}__${string(item.tool)}`,
          input: output(item.arguments),
          ...(complete
            ? {
                output: output(record(item.result)?.content ?? item.error),
                isError: !!item.error,
              }
            : {}),
        },
        complete,
      );
  }
}
