import { visibleMessageParts } from '@canopy/agent-transcript';
import { isAgentDelegationCardData } from '@canopy/protocol/delegation';
import {
  SUBAGENT_HIDDEN_INSTRUCTIONS_LABEL,
  subagentSteeringRequestFromLabel,
} from '../components/chat/subagents/subagent-copy';

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Replace the native spawn receipt row with its canonical delegated-task card. */
export function hideDelegationTransportParts<
  T extends { parts?: unknown; text?: string; content?: string },
>(messages: readonly T[]): T[] {
  const calls = new Set<string>();
  for (const message of messages) {
    if (!Array.isArray(message.parts)) continue;
    for (const part of message.parts) {
      if (!record(part) || part.kind !== 'agent' || !record(part.data))
        continue;
      const delegation = part.data.delegation;
      if (
        isAgentDelegationCardData(delegation) &&
        record(delegation) &&
        typeof delegation.parentToolCallId === 'string'
      )
        calls.add(delegation.parentToolCallId);
    }
  }
  if (calls.size === 0) return [...messages];
  return messages.flatMap((message) => {
    if (!Array.isArray(message.parts)) return [message];
    const parts = message.parts.filter((part) => {
      if (
        !record(part) ||
        !['tool_use', 'tool_result'].includes(String(part.kind)) ||
        !record(part.data)
      )
        return true;
      return !calls.has(String(part.data.toolUseId));
    });
    if (parts.length === message.parts.length) return [message];
    const onlyResults = message.parts.every(
      (part) => record(part) && part.kind === 'tool_result',
    );
    if (!parts.length && (onlyResults || !(message.text ?? message.content)))
      return [];
    return [{ ...message, parts }];
  });
}

/**
 * A delegated task prompt as plain text, without the hidden instructions a
 * host message carries: a watcher notification reads like its main-chat
 * title, and a delegate's steering request names its sender. A host message
 * folded into a queued follow-up reads as its own paragraph.
 */
export function visibleDelegationPrompt(prompt: string): string {
  return visibleMessageParts(prompt)
    .map((part): string => {
      switch (part.kind) {
        case 'text':
          return part.text;
        case 'watcher':
          return [`${part.watcherFired.kind} watcher has fired`, part.text]
            .filter(Boolean)
            .join('\n');
        case 'steering_request':
          return part.requestedBy
            ? `${subagentSteeringRequestFromLabel(part.requestedBy)}\n${part.text}`
            : part.text;
        case 'hidden':
          return SUBAGENT_HIDDEN_INSTRUCTIONS_LABEL;
      }
    })
    .join('\n\n');
}
