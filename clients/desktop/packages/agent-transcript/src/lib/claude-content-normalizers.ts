import type { PersistedChatBlock } from '../types';
import { stripMemoryCitationTags } from './memory-citation';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

export function parseClaudeAssistantBlocks(
  content: unknown[],
  onToolSlot?: (sourceIndex: number, blockOrdinal: number) => void,
): PersistedChatBlock[] {
  const blocks: PersistedChatBlock[] = [];

  for (let sourceIndex = 0; sourceIndex < content.length; sourceIndex += 1) {
    const block = content[sourceIndex];
    if (!isRecord(block)) {
      continue;
    }

    switch (block.type) {
      case 'text': {
        const text = stripMemoryCitationTags(asString(block.text));
        if (text.length > 0) {
          blocks.push({ type: 'text', text });
        }
        break;
      }
      case 'thinking': {
        const text = stripMemoryCitationTags(asString(block.thinking));
        if (text.length > 0) {
          blocks.push({ type: 'thinking', text });
        }
        break;
      }
      case 'tool_use':
        blocks.push({
          type: 'tool_use',
          toolUseId: asString(block.id),
          toolName: asString(block.name, 'unknown'),
          input:
            typeof block.input === 'string'
              ? block.input
              : JSON.stringify(block.input ?? {}),
        });
        onToolSlot?.(sourceIndex, blocks.length - 1);
        break;
    }
  }

  return blocks;
}

export function parseClaudeToolResults(
  content: unknown[],
  onToolSlot?: (sourceIndex: number, blockOrdinal: number) => void,
): PersistedChatBlock[] {
  const blocks: PersistedChatBlock[] = [];

  for (let sourceIndex = 0; sourceIndex < content.length; sourceIndex += 1) {
    const block = content[sourceIndex];
    if (!isRecord(block) || block.type !== 'tool_result') {
      continue;
    }

    let output = '';
    if (typeof block.content === 'string') {
      output = block.content;
    } else if (Array.isArray(block.content)) {
      output = block.content
        .map((entry) => {
          if (isRecord(entry) && typeof entry.text === 'string') {
            return entry.text;
          }
          return JSON.stringify(entry, null, 2);
        })
        .join('\n');
    }

    blocks.push({
      type: 'tool_result',
      toolUseId: asString(block.tool_use_id),
      toolName: '',
      output,
      isError: block.is_error === true,
    });
    onToolSlot?.(sourceIndex, blocks.length - 1);
  }

  return blocks;
}
