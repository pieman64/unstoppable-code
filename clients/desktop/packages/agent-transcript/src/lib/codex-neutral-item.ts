import type {
  PersistedChatBlock,
  PersistedToolOutputReference,
} from '../types';
import { stripMemoryCitationTags } from './memory-citation';
import {
  codexDynamicToolOutput,
  previewCodexDynamicToolContent,
  previewCodexDynamicToolOutput,
} from './codex-dynamic-tool-results';
import {
  codexAsyncQuestionText,
  codexToolImageBlocks,
  readCodexAsyncQuestions,
  withCodexImagePreviewNotices,
} from './codex-tool-images';
import {
  codexMcpToolName,
  codexMcpToolResult,
  codexMcpToolResultIsError,
  previewCodexMcpToolResult,
} from './codex-mcp-tool-results';

export type CodexNeutralItemEventType =
  | 'item.started'
  | 'item.updated'
  | 'item.completed';

export interface CodexNeutralItem {
  role: 'assistant' | 'system' | 'user';
  blocks: PersistedChatBlock[];
}

export type CodexNeutralPreparedOutput =
  | {
      field: 'text';
      text: string;
      textRef?: PersistedToolOutputReference;
    }
  | {
      field: 'output';
      output: string;
      fullOutputRef?: PersistedToolOutputReference;
    };

interface CodexNeutralItemOptions {
  previewToolResults?: boolean;
  losslessFunctionOutput?: boolean;
  preparedOutput?: CodexNeutralPreparedOutput;
  asyncQuestionRequestId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function preparedToolResult(
  prepared: Extract<CodexNeutralPreparedOutput, { field: 'output' }>,
  toolUseId: string,
  toolName: string,
  isError: boolean,
): PersistedChatBlock {
  return {
    type: 'tool_result',
    toolUseId,
    toolName,
    output: prepared.output,
    isError,
    ...(prepared.fullOutputRef
      ? { outputTruncated: true, fullOutputRef: prepared.fullOutputRef }
      : {}),
  };
}

function functionCallOutputName(item: Record<string, unknown>): string {
  return [asString(item.namespace), asString(item.name, 'unknown')]
    .filter(Boolean)
    .join('.');
}

function asyncQuestionRequestId(itemId: string): string {
  const identity = JSON.stringify(['', '', itemId]);
  let hashA = 2_166_136_261;
  let hashB = 3_335_557_771;
  let hashC = 2_654_435_761;
  let hashD = 1_013_904_223;
  for (let index = 0; index < identity.length; index += 1) {
    const code = identity.charCodeAt(index);
    hashA = Math.imul(hashA ^ code, 16_777_619);
    hashB = Math.imul(hashB ^ code, 2_246_822_519);
    hashC = Math.imul(hashC ^ code, 3_266_489_917);
    hashD = Math.imul(hashD ^ code, 668_265_263);
  }
  const hex = [hashA, hashB, hashC, hashD]
    .map((hash) => (hash >>> 0).toString(16).padStart(8, '0'))
    .join('');
  return `codex-async-${hex}`;
}

/**
 * Canonical provider-neutral projection of one Codex thread item. Host-only
 * prepared bodies and preview policy are applied by the primary reducer via
 * the internal options-bearing variant below.
 */
export function codexNeutralItemBlocks(
  item: Record<string, unknown>,
  eventType: CodexNeutralItemEventType,
): CodexNeutralItem | undefined {
  return normalizeCodexNeutralItem(item, eventType, {
    losslessFunctionOutput: true,
  });
}

/** Shared conversion core used by both the primary reducer and neutral API. */
export function normalizeCodexNeutralItem(
  item: Record<string, unknown>,
  eventType: CodexNeutralItemEventType,
  options: CodexNeutralItemOptions,
): CodexNeutralItem | undefined {
  const itemId = asString(item.id);
  const itemType = asString(item.type);
  if (!itemId || !itemType) return undefined;

  // These items are handled as structured orchestration state by the primary
  // reducer, not as transcript rows.
  if (
    itemType === 'collab_agent_tool_call' ||
    itemType === 'subagent_activity' ||
    itemType === 'sub_agent_activity'
  )
    return undefined;

  const codexToolId = `codex-${itemId}`;
  let blocks: PersistedChatBlock[];
  let role: 'assistant' | 'system' = 'assistant';

  switch (itemType) {
    case 'agent_message':
    case 'plan': {
      const text = stripMemoryCitationTags(
        asString(item.text) || codexAsyncQuestionText(item.questions),
      );
      if (text.trim().length === 0) return undefined;
      const questions =
        item.delivery === 'async'
          ? readCodexAsyncQuestions(item.questions)
          : undefined;
      blocks = [
        {
          type: 'text',
          text,
          ...(questions
            ? {
                asyncQuestion: {
                  requestId:
                    options.asyncQuestionRequestId ??
                    asyncQuestionRequestId(itemId),
                  questions,
                },
              }
            : {}),
        },
      ];
      break;
    }
    case 'reasoning': {
      const text = stripMemoryCitationTags(asString(item.text));
      if (text.trim().length === 0) return undefined;
      blocks = [{ type: 'thinking', text }];
      break;
    }
    case 'command_execution': {
      const status = asString(item.status);
      const exitCode =
        typeof item.exit_code === 'number' ? item.exit_code : undefined;
      const isError =
        status === 'failed' ||
        status === 'declined' ||
        (exitCode !== undefined && exitCode !== 0);
      const isTerminal =
        eventType === 'item.completed' ||
        status === 'completed' ||
        status === 'failed' ||
        status === 'declined';
      blocks = [
        {
          type: 'tool_use',
          toolUseId: codexToolId,
          toolName: 'command',
          input: asString(item.command),
        },
      ];
      if (isTerminal) {
        blocks.push({
          type: 'tool_result',
          toolUseId: codexToolId,
          toolName: 'command',
          output:
            asString(item.aggregated_output).length > 0
              ? asString(item.aggregated_output)
              : status === 'completed'
                ? 'Done'
                : status,
          isError,
        });
      }
      role = 'system';
      break;
    }
    case 'file_change': {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      const summary = changes
        .map((change) => {
          if (!isRecord(change)) return '';
          return `${asString(change.kind)}: ${asString(change.path)}`;
        })
        .filter((value) => value.length > 0)
        .join('\n');
      const status = asString(item.status);
      const isTerminal =
        eventType === 'item.completed' ||
        status === 'completed' ||
        status === 'failed' ||
        status === 'declined';
      blocks = [
        {
          type: 'tool_use',
          toolUseId: codexToolId,
          toolName: 'file_change',
          input: summary,
        },
      ];
      if (isTerminal) {
        blocks.push({
          type: 'tool_result',
          toolUseId: codexToolId,
          toolName: 'file_change',
          output: status,
          isError: status === 'failed' || status === 'declined',
        });
      }
      role = 'system';
      break;
    }
    case 'web_search': {
      const action = isRecord(item.action) ? item.action : null;
      const actionText =
        action?.type === 'open_page' || action?.type === 'openPage'
          ? `Open ${asString(action.url)}`
          : action?.type === 'find_in_page' || action?.type === 'findInPage'
            ? `Find ${asString(action.pattern)} in ${asString(action.url)}`
            : action?.type === 'search'
              ? asString(action.query) ||
                (Array.isArray(action.queries)
                  ? action.queries
                      .filter((value) => typeof value === 'string')
                      .join('\n')
                  : '')
              : '';
      blocks = [
        {
          type: 'tool_use',
          toolUseId: codexToolId,
          toolName: 'web_search',
          input: actionText || asString(item.query),
        },
      ];
      if (eventType === 'item.completed' || item.status === 'completed') {
        blocks.push({
          type: 'tool_result',
          toolUseId: codexToolId,
          toolName: 'web_search',
          output: 'Done',
          isError: false,
        });
      }
      role = 'system';
      break;
    }
    case 'image_generation': {
      const path = asString(item.saved_path);
      if (
        item.status === 'failed' ||
        (eventType === 'item.completed' && item.status === 'completed' && !path)
      ) {
        blocks = [
          {
            type: 'text',
            text:
              item.status === 'failed'
                ? 'Image generation failed.'
                : 'Generated image unavailable.',
          },
        ];
        role = 'system';
        break;
      }
      if (path.length === 0 || item.status !== 'completed') return undefined;
      blocks = [
        {
          type: 'image',
          path,
          alt: asString(item.revised_prompt, 'Generated image'),
        },
      ];
      break;
    }
    case 'function_call_output': {
      const name = functionCallOutputName(item);
      const prepared =
        options.preparedOutput?.field === 'text'
          ? options.preparedOutput
          : undefined;
      if (prepared) {
        blocks = [
          {
            type: 'text',
            text: prepared.text,
            verbatim: true,
            ...(prepared.textRef ? { textRef: prepared.textRef } : {}),
          },
          ...codexToolImageBlocks(item.output),
        ];
        role = 'system';
        break;
      }
      const output =
        options.losslessFunctionOutput === true
          ? typeof item.output === 'string'
            ? item.output
            : codexDynamicToolOutput({
                contentItems: withCodexImagePreviewNotices(item.output),
                success: null,
              })
          : typeof item.output === 'string'
            ? previewCodexDynamicToolOutput(item.output)
            : previewCodexDynamicToolContent({
                contentItems: withCodexImagePreviewNotices(item.output),
                success: null,
              });
      blocks = [
        {
          type: 'text',
          text: `Tool output (${name})\n\n${output}`,
          verbatim: true,
        },
        ...codexToolImageBlocks(item.output),
      ];
      role = 'system';
      break;
    }
    case 'entered_review_mode':
    case 'exited_review_mode': {
      blocks = [
        {
          type: 'text',
          text: `${itemType === 'entered_review_mode' ? 'Review started' : 'Review completed'}: ${asString(item.review)}`,
        },
      ];
      role = 'system';
      break;
    }
    case 'dynamic_tool_call': {
      const rawToolName = asString(item.tool, 'unknown');
      const inputSerialized = JSON.stringify(
        item.arguments === undefined ? {} : (item.arguments ?? {}),
      );
      const itemStatus = asString(item.status);
      const itemSuccess =
        typeof item.success === 'boolean' ? item.success : null;
      const isCompleted =
        eventType === 'item.completed' ||
        itemStatus === 'completed' ||
        itemStatus === 'failed';
      blocks = [
        {
          type: 'tool_use',
          toolUseId: codexToolId,
          toolName: rawToolName,
          input: inputSerialized,
        },
      ];
      const preparedDynamic =
        options.preparedOutput?.field === 'output'
          ? options.preparedOutput
          : undefined;
      if (isCompleted && preparedDynamic) {
        blocks.push(
          preparedToolResult(
            preparedDynamic,
            codexToolId,
            rawToolName,
            itemSuccess === false || itemStatus === 'failed',
          ),
        );
        blocks.push(...codexToolImageBlocks(item.content_items));
      } else if (isCompleted) {
        const output = (
          options.previewToolResults
            ? previewCodexDynamicToolContent
            : codexDynamicToolOutput
        )({
          contentItems: withCodexImagePreviewNotices(item.content_items),
          success: itemSuccess,
        });
        blocks.push({
          type: 'tool_result',
          toolUseId: codexToolId,
          toolName: rawToolName,
          output,
          isError: itemSuccess === false || itemStatus === 'failed',
        });
        blocks.push(...codexToolImageBlocks(item.content_items));
      }
      role = 'system';
      break;
    }
    case 'mcp_tool_call': {
      const status = asString(item.status);
      const toolName = codexMcpToolName(
        asString(item.server),
        asString(item.tool),
      );
      const terminal = eventType === 'item.completed';
      blocks = [
        {
          type: 'tool_use',
          toolUseId: codexToolId,
          toolName,
          input: JSON.stringify(item.arguments ?? {}),
        },
      ];
      const preparedMcp =
        options.preparedOutput?.field === 'output'
          ? options.preparedOutput
          : undefined;
      if (terminal && preparedMcp) {
        blocks.push(
          preparedToolResult(
            preparedMcp,
            codexToolId,
            toolName,
            codexMcpToolResultIsError({
              status,
              result: item.result,
              error: item.error,
            }),
          ),
        );
        blocks.push(
          ...codexToolImageBlocks(
            isRecord(item.result) ? item.result.content : null,
          ),
        );
      } else if (terminal) {
        const flattened = (
          options.previewToolResults
            ? previewCodexMcpToolResult
            : codexMcpToolResult
        )({
          status,
          result: isRecord(item.result)
            ? {
                ...item.result,
                content: withCodexImagePreviewNotices(item.result.content),
              }
            : item.result,
          error: item.error,
        });
        blocks.push({
          type: 'tool_result',
          toolUseId: codexToolId,
          toolName,
          output: flattened.output,
          isError: flattened.isError,
        });
        blocks.push(
          ...codexToolImageBlocks(
            isRecord(item.result) ? item.result.content : null,
          ),
        );
      }
      role = 'system';
      break;
    }
    case 'todo_list': {
      const items = Array.isArray(item.items) ? item.items : [];
      const text = items
        .map((todo) => {
          if (!isRecord(todo)) return '';
          return `${todo.completed === true ? '[x]' : '[ ]'} ${asString(todo.text)}`;
        })
        .filter((value) => value.length > 0)
        .join('\n');
      blocks = [{ type: 'text', text: `Todo:\n${text}` }];
      role = 'system';
      break;
    }
    case 'error':
      blocks = [
        {
          type: 'text',
          text: `Error: ${asString(item.message, 'Unknown error')}`,
        },
      ];
      role = 'system';
      break;
    default:
      return undefined;
  }

  return { role, blocks };
}
