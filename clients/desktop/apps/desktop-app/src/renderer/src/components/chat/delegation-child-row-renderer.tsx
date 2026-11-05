import { Fragment, type ReactNode } from 'react';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import type { PortableChildRow, TranscriptBlockEntry } from '@canopy/app-core';
import {
  DelegationChildRowNotice,
  repeatsCardResult,
  type DelegationChildRowDisplay,
  type DelegationChildRowEntry,
  type ToolOutputIdentity,
} from '@canopy/ui-app';
import type {
  DelegatedAgentCallBlock,
  PersistedChatBlock,
  PersistedChatMessage,
} from '@canopy/agent-transcript/types';
import { isDelegatedAgentCallBlock } from '@canopy/agent-transcript';
import { isPersistedToolOutputReference } from '@canopy/agent-transcript/transcript-storage';
import type { DelegationMessageAuthor } from '@canopy/protocol/delegation';
import { mergeToolResults } from '@canopy/desktop-shared/lib/message-transforms';
import type { DisplayBlock, ToolResult } from './types';
import { ToolCallBlock } from './ToolCallBlock';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

interface RawChildMessage {
  readonly id: string;
  readonly role: PersistedChatMessage['role'];
  readonly timestamp: number;
  readonly blocks: readonly unknown[];
  readonly delegationAuthor?: unknown;
}

/** Never treat a portable envelope as a validated desktop message. */
function isChildMessage(value: unknown): value is RawChildMessage {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    (value.role === 'user' ||
      value.role === 'assistant' ||
      value.role === 'system') &&
    typeof value.timestamp === 'number' &&
    Number.isFinite(value.timestamp) &&
    Array.isArray(value.blocks)
  );
}

function authorOf(value: unknown): DelegationMessageAuthor | undefined {
  if (!isRecord(value)) return undefined;
  if (value.kind === 'user') return { kind: 'user' };
  if (
    value.kind !== 'agent' ||
    typeof value.depth !== 'number' ||
    !Number.isFinite(value.depth)
  )
    return undefined;
  return {
    kind: 'agent',
    depth: value.depth,
    ...(typeof value.delegationId === 'string'
      ? { delegationId: value.delegationId }
      : {}),
    ...(typeof value.description === 'string'
      ? { description: value.description }
      : {}),
  };
}

/** Copy only fields this bounded desktop renderer validates and consumes. */
type DesktopChildBlock = Extract<
  PersistedChatBlock,
  {
    type:
      | 'text'
      | 'thinking'
      | 'tool_use'
      | 'tool_result'
      | 'image'
      | 'delegated_agent_call';
  }
>;
function desktopBlock(value: unknown): DesktopChildBlock | undefined {
  if (!isRecord(value)) return undefined;
  if (
    (value.type === 'text' || value.type === 'thinking') &&
    typeof value.text === 'string'
  )
    return { type: value.type, text: value.text };
  if (
    value.type === 'tool_use' &&
    typeof value.toolUseId === 'string' &&
    typeof value.toolName === 'string' &&
    typeof value.input === 'string'
  )
    return {
      type: 'tool_use',
      toolUseId: value.toolUseId,
      toolName: value.toolName,
      input: value.input,
    };
  if (
    value.type === 'tool_result' &&
    typeof value.toolUseId === 'string' &&
    typeof value.output === 'string' &&
    typeof value.isError === 'boolean'
  ) {
    if (
      value.fullOutputRef !== undefined &&
      !isPersistedToolOutputReference(value.fullOutputRef)
    )
      return undefined;
    return {
      type: 'tool_result',
      toolUseId: value.toolUseId,
      toolName: typeof value.toolName === 'string' ? value.toolName : 'Tool',
      output: value.output,
      isError: value.isError,
      ...(isPersistedToolOutputReference(value.fullOutputRef)
        ? { fullOutputRef: value.fullOutputRef }
        : {}),
      ...(value.outputTruncated === true ? { outputTruncated: true } : {}),
    };
  }
  // Portable pages drop an image's host path; an inline image keeps its dataUrl.
  if (
    value.type === 'image' &&
    typeof value.alt === 'string' &&
    (value.dataUrl === undefined || typeof value.dataUrl === 'string') &&
    (typeof value.path === 'string' || typeof value.dataUrl === 'string')
  )
    return {
      type: 'image',
      path: typeof value.path === 'string' ? value.path : '',
      alt: value.alt,
      ...(typeof value.dataUrl === 'string' ? { dataUrl: value.dataUrl } : {}),
    };
  if (isDelegatedAgentCallBlock(value)) return value;
  return undefined;
}

interface ChildMessage {
  readonly message: PersistedChatMessage;
  readonly omitted: boolean;
  readonly rawOrdinals: readonly number[];
}
function desktopMessage(row: PortableChildRow): ChildMessage {
  const raw = row.row;
  if (!isChildMessage(raw) || raw.id !== row.id)
    return {
      message: {
        id: row.id,
        role: row.role,
        timestamp: row.timestamp,
        blocks: [],
      },
      omitted: true,
      rawOrdinals: [],
    };
  const author = authorOf(raw.delegationAuthor);
  const rawOrdinals: number[] = [];
  const blocks = raw.blocks.flatMap((block, ordinal) => {
    const parsed = desktopBlock(block);
    if (parsed) rawOrdinals.push(ordinal);
    return parsed ? [parsed] : [];
  });
  return {
    message: {
      id: raw.id,
      role: raw.role,
      timestamp: raw.timestamp,
      blocks,
      ...(author ? { delegationAuthor: author } : {}),
    },
    omitted: blocks.length !== raw.blocks.length,
    rawOrdinals,
  };
}

interface ResultLocator {
  readonly messageId: string;
  readonly toolUseId: string;
  readonly outputIdentity?: ToolOutputIdentity;
}
interface PreparedWindow {
  readonly messages: PersistedChatMessage[];
  readonly paired: ReadonlySet<string>;
  readonly originalResults: ReadonlyMap<string, ResultLocator>;
}

/** The legacy merger keys by tool id; namespace occurrences only in its input. */
function prepareWindow(rows: readonly ChildMessage[]): PreparedWindow {
  const open = new Map<string, string[]>();
  const paired = new Set<string>();
  const originalResults = new Map<string, ResultLocator>();
  const prepared = rows.map(({ message, rawOrdinals }) => {
    const author = message.delegationAuthor;
    const owner =
      author?.kind === 'agent'
        ? `agent:${author.delegationId ?? author.depth}`
        : (author?.kind ?? 'child');
    const blocks = message.blocks.map((block, ordinal): PersistedChatBlock => {
      if (block.type !== 'tool_use' && block.type !== 'tool_result')
        return block;
      const key = JSON.stringify([owner, block.toolUseId]);
      const occurrence = JSON.stringify([message.id, ordinal]);
      if (block.type === 'tool_use') {
        const stack = open.get(key) ?? [];
        stack.push(occurrence);
        open.set(key, stack);
        return { ...block, toolUseId: occurrence };
      }
      const use = open.get(key)?.pop();
      const identity = use ?? occurrence;
      if (use) paired.add(occurrence);
      originalResults.set(identity, {
        messageId: message.id,
        toolUseId: block.toolUseId,
        ...(block.fullOutputRef
          ? {
              outputIdentity: {
                kind: 'row' as const,
                messageId: message.id,
                blockOrdinal: rawOrdinals[ordinal],
                field: 'output' as const,
              },
            }
          : {}),
      });
      return { ...block, toolUseId: identity };
    });
    // Promote only this run's validated rows so the merger preserves row keys.
    return { ...message, blocks };
  });
  return { messages: prepared, paired, originalResults };
}

function standaloneResult(
  block: Extract<PersistedChatBlock, { type: 'tool_result' }>,
  messageId: string,
  blockOrdinal: number,
): ToolResult & { readonly outputIdentity?: ToolOutputIdentity } {
  return {
    output: block.output,
    isError: block.isError,
    messageId,
    toolUseId: block.toolUseId,
    ...(block.fullOutputRef
      ? {
          fullOutputRef: block.fullOutputRef,
          outputTruncated: true,
          outputIdentity: {
            kind: 'row',
            messageId,
            blockOrdinal,
            field: 'output',
          },
        }
      : {}),
  };
}

/** One fragment per shared row; notices never enter the lossy result merger. */
export function renderDelegationChildRows(
  entries: readonly DelegationChildRowEntry[],
  card: DelegatedAgentCallBlock,
  renderSubBlock: (block: DisplayBlock, index: number) => ReactNode,
  shown?: DelegationChildRowDisplay,
): ReactNode {
  const validated = entries.map((entry) => desktopMessage(entry.row));
  const prepared = prepareWindow(validated);
  const [synthetic, ...display] = mergeToolResults([
    {
      id: card.agentBlockId,
      role: 'assistant',
      timestamp: card.createdAt,
      blocks: [card],
    },
    ...prepared.messages,
  ]);
  void synthetic;
  const byId = new Map(display.map((message) => [message.id, message.blocks]));
  return entries.map((entry, index) => {
    const validatedRow = validated[index];
    const message = validatedRow.message;
    const author = message.delegationAuthor;
    const blocks = (byId.get(entry.key) ?? [])
      .filter(
        (block) =>
          !(block.type === 'text' && repeatsCardResult(block.text, shown)),
      )
      .map((block): DisplayBlock => {
        if (block.type !== 'tool_use') return block;
        const locator = prepared.originalResults.get(block.toolUseId);
        return {
          ...block,
          ...(block.result && locator
            ? { result: { ...block.result, ...locator } }
            : {}),
        };
      });
    const standalone = message.blocks.flatMap((block, ordinal) =>
      block.type === 'tool_result' &&
      !prepared.paired.has(JSON.stringify([message.id, ordinal]))
        ? [
            <ToolCallBlock
              key={`result:${ordinal}`}
              toolName={block.toolName}
              input=""
              result={standaloneResult(
                block,
                message.id,
                validatedRow.rawOrdinals[ordinal],
              )}
            />,
          ]
        : [],
    );
    return (
      <Fragment key={entry.key}>
        {author && (
          <p className="px-2.5 py-1 text-xs fg-secondary">
            {author.kind === 'user'
              ? 'You'
              : (author.description ?? card.description)}
          </p>
        )}
        {blocks.map((block, blockIndex) => renderSubBlock(block, blockIndex))}
        {standalone}
        {validatedRow.omitted && <DelegationChildRowNotice />}
      </Fragment>
    );
  });
}

/** Bounded entries are independent blocks, never paired again by tool-use id. */
export function renderDelegationChildBlock(
  entry: TranscriptBlockEntry,
  row: PortableChildRow,
  renderSubBlock: (block: DisplayBlock, ordinal: number) => ReactNode,
): ReactNode {
  if (entry.kind === 'notice') return <DelegationChildRowNotice />;
  const block = desktopBlock(entry.block);
  if (!block) return <DelegationChildRowNotice />;
  return (
    <div className={REPLAY_BLOCK_CLASS}>
      {block.type === 'tool_result' ? (
        <ToolCallBlock
          toolName={block.toolName}
          input=""
          result={{
            output: block.output,
            isError: block.isError,
            messageId: row.id,
            toolUseId: block.toolUseId,
          }}
        />
      ) : (
        renderSubBlock(
          block.type === 'delegated_agent_call'
            ? { ...block, subBlocks: [] }
            : block,
          entry.ordinal,
        )
      )}
    </div>
  );
}
