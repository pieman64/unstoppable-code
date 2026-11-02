import {
  emptyWaitForAgentReplyOutputs,
  parseWaitForAgentReplyInputs,
  REPLY_TIMEOUT_DEFAULT_MINUTES,
} from '../host-wait-for-agent-reply';
import {
  isPipelineHostActionId,
  parseMoveToGroupInputs,
} from '../host-actions';

const base = { project_id: 'proj-1', task_id: 'task-1', chat_id: 'chat-1' };

describe('parseWaitForAgentReplyInputs', () => {
  it('parses a project chat with the default reply timeout', () => {
    expect(parseWaitForAgentReplyInputs(base)).toEqual({
      ok: true,
      value: {
        chat: {
          kind: 'project',
          projectId: 'proj-1',
          taskId: 'task-1',
          chatId: 'chat-1',
        },
        replyTimeoutMinutes: REPLY_TIMEOUT_DEFAULT_MINUTES,
      },
    });
  });

  it('parses a bot chat, a message id and an explicit timeout', () => {
    expect(
      parseWaitForAgentReplyInputs({
        bot_id: 'app_advisor',
        task_id: 'entry-1',
        chat_id: 'chat-1',
        message_id: 'msg-1',
        reply_timeout_minutes: '720',
      }),
    ).toEqual({
      ok: true,
      value: {
        chat: {
          kind: 'bot',
          botId: 'app_advisor',
          taskId: 'entry-1',
          chatId: 'chat-1',
        },
        messageId: 'msg-1',
        replyTimeoutMinutes: 720,
      },
    });
  });

  it('accepts a fractional timeout', () => {
    const parsed = parseWaitForAgentReplyInputs({
      ...base,
      reply_timeout_minutes: '0.5',
    });
    expect(parsed.ok && parsed.value.replyTimeoutMinutes).toBe(0.5);
  });

  it.each([
    [
      { ...base, bot_id: 'app_advisor' },
      'exactly one of "project_id" or "bot_id"',
    ],
    [{ project_id: 'p', chat_id: 'c' }, 'requires "task_id"'],
    [{ project_id: 'p', task_id: 't' }, 'requires "chat_id"'],
    [{ ...base, chat_id: 'has space' }, '"chat_id"'],
    [{ ...base, message_id: 'has space' }, '"message_id"'],
    [{ ...base, message_id: 'x'.repeat(513) }, '"message_id"'],
    [{ ...base, reply_timeout_minutes: '0' }, '"reply_timeout_minutes"'],
    [{ ...base, reply_timeout_minutes: '721' }, '"reply_timeout_minutes"'],
    [{ ...base, reply_timeout_minutes: 'soon' }, '"reply_timeout_minutes"'],
    [{ ...base, task_id: '../x' }, '"task_id" must be lowercase'],
    [{ bot_id: 'app_advisor', chat_id: 'c' }, 'requires "task_id"'],
  ])('refuses %j', (inputs, message) => {
    const parsed = parseWaitForAgentReplyInputs(inputs);
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? '' : parsed.message).toContain(message);
    expect(parsed.ok ? '' : parsed.message).toMatch(/^wait-for-agent-reply /);
  });
});

it('every output starts empty, reply_truncated "false"', () => {
  expect(emptyWaitForAgentReplyOutputs()).toEqual({
    reply_state: '',
    reply_message_id: '',
    turn_id: '',
    reply_text: '',
    reply_truncated: 'false',
    reply_file: '',
  });
});

it('is a known host action', () => {
  expect(isPipelineHostActionId('wait-for-agent-reply')).toBe(true);
});

it('keeps the move-to-group task messages after the parser was shared', () => {
  const parsed = parseMoveToGroupInputs({ project_id: 'p', group: 'g' });
  expect(parsed.ok ? '' : parsed.message).toBe(
    'move-to-group requires "task_id"',
  );
});
