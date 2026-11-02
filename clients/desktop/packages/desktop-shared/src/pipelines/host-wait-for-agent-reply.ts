/**
 * Browser-safe contract for `builtin/wait-for-agent-reply`: waits for the
 * turn a chat message runs in (or the chat's running or latest turn) to
 * settle and exposes its final assistant message. Desktop only.
 */
import {
  parseHostTaskAddress,
  presentInput,
  type HostInputParse,
} from './host-actions';

export const REPLY_TIMEOUT_DEFAULT_MINUTES = 60;
export const REPLY_TIMEOUT_MAX_MINUTES = 720;

export const REPLY_STATES = [
  'completed',
  'failed',
  'cancelled',
  'interrupted',
  'none',
  'timed_out',
] as const;
export type ReplyState = (typeof REPLY_STATES)[number];

export type HostChatAddress =
  | { kind: 'project'; projectId: string; taskId: string; chatId: string }
  | { kind: 'bot'; botId: string; taskId: string; chatId: string };

export interface WaitForAgentReplyInputs {
  chat: HostChatAddress;
  /** `message_id` from send-agent-message (a still-queued `queued_message_id` also resolves). */
  messageId?: string;
  replyTimeoutMinutes: number;
}

export const WAIT_FOR_AGENT_REPLY_OUTPUTS = [
  'reply_state',
  'reply_message_id',
  'turn_id',
  'reply_text',
  'reply_truncated',
  'reply_file',
] as const;

/** Every output `''` except `reply_truncated: 'false'`; the shape every typed failure carries. */
export function emptyWaitForAgentReplyOutputs(): Record<string, string> {
  const outputs: Record<string, string> = {};
  for (const name of WAIT_FOR_AGENT_REPLY_OUTPUTS) {
    outputs[name] = '';
  }
  outputs.reply_truncated = 'false';
  return outputs;
}

const ACTION = 'wait-for-agent-reply';
// #5721's opaque public ID rule: chat and message IDs are compared, never
// joined into a path.
const MAX_OPAQUE_ID_LENGTH = 512;

function opaqueId(
  inputs: Record<string, string | undefined>,
  name: string,
): HostInputParse<string | undefined> {
  const value = presentInput(inputs, name);
  if (value === undefined) {
    return { ok: true, value: undefined };
  }
  return value.length <= MAX_OPAQUE_ID_LENGTH && !/\s/.test(value)
    ? { ok: true, value }
    : {
        ok: false,
        message: `${ACTION} "${name}" must be an ID without spaces`,
      };
}

function parseReplyTimeout(raw: string | undefined): HostInputParse<number> {
  if (raw === undefined) {
    return { ok: true, value: REPLY_TIMEOUT_DEFAULT_MINUTES };
  }
  const minutes = Number(raw);
  return Number.isFinite(minutes) &&
    minutes > 0 &&
    minutes <= REPLY_TIMEOUT_MAX_MINUTES
    ? { ok: true, value: minutes }
    : {
        ok: false,
        message: `${ACTION} "reply_timeout_minutes" must be more than 0 and at most ${REPLY_TIMEOUT_MAX_MINUTES}`,
      };
}

export function parseWaitForAgentReplyInputs(
  inputs: Record<string, string | undefined>,
): HostInputParse<WaitForAgentReplyInputs> {
  const task = parseHostTaskAddress(inputs, ACTION);
  if (!task.ok) {
    return task;
  }
  const chatId = opaqueId(inputs, 'chat_id');
  if (!chatId.ok) {
    return chatId;
  }
  if (chatId.value === undefined) {
    return { ok: false, message: `${ACTION} requires "chat_id"` };
  }
  const messageId = opaqueId(inputs, 'message_id');
  if (!messageId.ok) {
    return messageId;
  }
  const timeout = parseReplyTimeout(
    presentInput(inputs, 'reply_timeout_minutes'),
  );
  if (!timeout.ok) {
    return timeout;
  }
  const chat: HostChatAddress =
    task.value.kind === 'project'
      ? {
          kind: 'project',
          projectId: task.value.projectId,
          taskId: task.value.taskId,
          chatId: chatId.value,
        }
      : {
          kind: 'bot',
          botId: task.value.botId,
          taskId: task.value.taskId,
          chatId: chatId.value,
        };
  return {
    ok: true,
    value: {
      chat,
      ...(messageId.value !== undefined ? { messageId: messageId.value } : {}),
      replyTimeoutMinutes: timeout.value,
    },
  };
}
