import type { PersistedChatBlock, PersistedChatMessage } from '../types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A deliberately small provider-neutral streaming projection. No executable data. */
export function readAssistantSnapshot(
  value: unknown,
): PersistedChatMessage | undefined {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    (value.role !== 'assistant' && value.role !== 'system') ||
    typeof value.timestamp !== 'number' ||
    !Number.isFinite(value.timestamp) ||
    !Array.isArray(value.blocks)
  )
    return undefined;
  const blocks: PersistedChatBlock[] = [];
  for (const block of value.blocks) {
    if (!isRecord(block)) return undefined;
    if (
      (block.type === 'text' || block.type === 'thinking') &&
      typeof block.text === 'string'
    )
      blocks.push({ type: block.type, text: block.text });
    else if (
      block.type === 'tool_use' &&
      typeof block.toolUseId === 'string' &&
      typeof block.toolName === 'string' &&
      typeof block.input === 'string'
    )
      blocks.push({
        type: 'tool_use',
        toolUseId: block.toolUseId,
        toolName: block.toolName,
        input: block.input,
        ...(isRecord(block.display) &&
        typeof block.display.toolName === 'string' &&
        typeof block.display.input === 'string'
          ? {
              display: {
                toolName: block.display.toolName,
                input: block.display.input,
              },
            }
          : {}),
      });
    else if (
      block.type === 'tool_result' &&
      typeof block.toolUseId === 'string' &&
      typeof block.toolName === 'string' &&
      typeof block.output === 'string' &&
      typeof block.isError === 'boolean'
    )
      blocks.push({
        type: 'tool_result',
        toolUseId: block.toolUseId,
        toolName: block.toolName,
        output: block.output,
        isError: block.isError,
      });
    else return undefined;
  }
  return {
    id: value.id,
    role: value.role === 'system' ? 'system' : 'assistant',
    timestamp: value.timestamp,
    blocks,
  };
}

/** Validate and apply ordered block patches without trusting provider-shaped objects. */
export function applyAssistantPatches(
  previous: PersistedChatMessage | undefined,
  value: Record<string, unknown>,
): PersistedChatMessage | undefined {
  if (
    (value.role !== undefined &&
      value.role !== 'assistant' &&
      value.role !== 'system') ||
    (previous !== undefined && previous.role !== (value.role ?? 'assistant')) ||
    typeof value.messageId !== 'string' ||
    typeof value.timestamp !== 'number' ||
    !Number.isFinite(value.timestamp) ||
    !Array.isArray(value.patches)
  )
    return undefined;
  const blocks = previous ? [...previous.blocks] : [];
  for (const patch of value.patches) {
    if (
      !isRecord(patch) ||
      typeof patch.index !== 'number' ||
      !Number.isSafeInteger(patch.index) ||
      patch.index < 0 ||
      patch.index > blocks.length
    )
      return undefined;
    if (typeof patch.appendText === 'string') {
      const existing = blocks[patch.index];
      if (existing?.type !== 'text' && existing?.type !== 'thinking')
        return undefined;
      blocks[patch.index] = {
        ...existing,
        text: existing.text + patch.appendText,
      };
    } else {
      const parsed = readAssistantSnapshot({
        id: value.messageId,
        role: value.role ?? 'assistant',
        timestamp: value.timestamp,
        blocks: [patch.block],
      });
      const block = parsed?.blocks[0];
      if (!block) return undefined;
      blocks[patch.index] = block;
    }
  }
  return {
    id: value.messageId,
    role: value.role === 'system' ? 'system' : 'assistant',
    timestamp: value.timestamp,
    blocks,
  };
}

/** Validate an independent patch record before persisting it; replay also checks block ordering. */
export function isAssistantPatch(value: Record<string, unknown>): boolean {
  return (
    (value.role === undefined ||
      value.role === 'assistant' ||
      value.role === 'system') &&
    typeof value.messageId === 'string' &&
    value.messageId.length > 0 &&
    typeof value.timestamp === 'number' &&
    Number.isFinite(value.timestamp) &&
    Number.isSafeInteger(value.revision) &&
    typeof value.revision === 'number' &&
    value.revision > 0 &&
    Array.isArray(value.patches) &&
    value.patches.length > 0 &&
    value.patches.every(
      (patch) =>
        isRecord(patch) &&
        typeof patch.index === 'number' &&
        Number.isSafeInteger(patch.index) &&
        patch.index >= 0 &&
        (typeof patch.appendText === 'string'
          ? patch.block === undefined
          : patch.appendText === undefined &&
            readAssistantSnapshot({
              id: value.messageId,
              role: value.role ?? 'assistant',
              timestamp: value.timestamp,
              blocks: [patch.block],
            }) !== undefined),
    )
  );
}
