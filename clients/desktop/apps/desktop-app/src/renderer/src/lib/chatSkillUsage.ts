import type { ChatMessage } from '@/stores/chat/types';
import {
  findInvocableMentionTarget,
  splitTextByInvocableMentions,
  type InvocableMentionIndex,
  type InvocableMentionTarget,
} from './invocableMentionIndex';

const EMPTY: readonly InvocableMentionTarget[] = [];

// The rail section and its "has content" probe ask for the same chat's usage
// in the same render pass; remember the last answer per message list.
const cache = new WeakMap<
  readonly ChatMessage[],
  { index: InvocableMentionIndex; usage: readonly InvocableMentionTarget[] }
>();

function skillNameFromToolInput(input: string): string | null {
  try {
    const parsed: unknown = JSON.parse(input);
    if (!parsed || typeof parsed !== 'object' || !('skill' in parsed)) {
      return null;
    }
    return typeof parsed.skill === 'string' && parsed.skill.trim().length > 0
      ? parsed.skill
      : null;
  } catch {
    return null;
  }
}

/**
 * The skills and commands a chat actually used, in first-use order.
 *
 * Two signals count: a `Skill` tool call, and a skill or command mention the
 * user typed. Assistant prose that merely names a skill does not, and neither
 * does a malformed tool input or a name the inventory cannot resolve. Each
 * inventory row appears once.
 */
export function collectChatSkillUsage(
  messages: readonly ChatMessage[],
  index: InvocableMentionIndex | null | undefined,
): readonly InvocableMentionTarget[] {
  if (!index || index.aliases.size === 0 || messages.length === 0) return EMPTY;
  const cached = cache.get(messages);
  if (cached && cached.index === index) return cached.usage;

  const seen = new Set<string>();
  const usage: InvocableMentionTarget[] = [];
  const add = (target: InvocableMentionTarget | null): void => {
    if (!target || seen.has(target.entry.id)) return;
    seen.add(target.entry.id);
    usage.push(target);
  };
  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.type === 'tool_use') {
        if (block.toolName !== 'Skill') continue;
        const name = skillNameFromToolInput(block.input);
        if (name) add(findInvocableMentionTarget(index, name));
        continue;
      }
      if (block.type !== 'text' || message.role !== 'user') continue;
      for (const piece of splitTextByInvocableMentions(block.text, index)) {
        if (piece.type === 'mention') add(piece.target);
      }
    }
  }
  const result = usage.length > 0 ? usage : EMPTY;
  cache.set(messages, { index, usage: result });
  return result;
}
