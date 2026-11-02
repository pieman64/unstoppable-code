import type { ConfiguredPromptReference } from '@canopy/protocol/configured-prompt-references';
import { THINKING_LEVELS } from '@canopy/protocol/thinking';
import { APPROVAL_MODES } from '../../types/approvals';
import {
  checkSendAgentMessageReferences,
  emptySendAgentMessageOutputs,
  parsePipelineChatSendRecord,
  parseSendAgentMessageInputs,
  SEND_AGENT_MESSAGE_INTERFACE_MODES,
  SEND_AGENT_MESSAGE_OUTPUTS,
} from '../host-send-agent-message';

const SECRET_TEXT = 'SENTINEL-TEXT-7f3a';
const SECRET_PATH = 'SENTINEL-PATH-91bc/notes.md';

const base = {
  project_id: 'proj-1',
  task_id: 'task-1',
  text: `hello ${SECRET_TEXT}`,
};

function message(inputs: Record<string, string | undefined>): string {
  const parsed = parseSendAgentMessageInputs(inputs);
  if (parsed.ok) throw new Error('expected a parse failure');
  return parsed.message;
}

const PLUGIN_REF = {
  type: 'skill',
  source: { type: 'builtin', id: 'app' },
  skill_name: 'review',
};

describe('parseSendAgentMessageInputs', () => {
  it('parses a project send with defaults', () => {
    expect(parseSendAgentMessageInputs(base)).toEqual({
      ok: true,
      value: {
        target: { kind: 'project', projectId: 'proj-1', taskId: 'task-1' },
        text: { kind: 'inline', text: `hello ${SECRET_TEXT}` },
        mode: 'queue',
        settings: {},
      },
    });
  });

  it('keeps text untrimmed', () => {
    const parsed = parseSendAgentMessageInputs({ ...base, text: '  hi  ' });
    expect(parsed.ok && parsed.value.text).toEqual({
      kind: 'inline',
      text: '  hi  ',
    });
  });

  it('parses a bot target with a chat', () => {
    const parsed = parseSendAgentMessageInputs({
      bot_id: 'app_advisor',
      task_id: 'task-1',
      chat_id: 'chat_abc',
      text: 'hi',
    });
    expect(parsed.ok && parsed.value.target).toEqual({
      kind: 'bot',
      botId: 'app_advisor',
      taskId: 'task-1',
      chatId: 'chat_abc',
    });
  });

  it('requires exactly one of project_id or bot_id', () => {
    expect(message({ task_id: 't', text: 'x' })).toBe(
      'send-agent-message requires exactly one of "project_id" or "bot_id"',
    );
    expect(
      message({ project_id: 'p', bot_id: 'b', task_id: 't', text: 'x' }),
    ).toBe(
      'send-agent-message requires exactly one of "project_id" or "bot_id"',
    );
  });

  it('requires task_id', () => {
    expect(message({ project_id: 'p', text: 'x' })).toBe(
      'send-agent-message requires "task_id"',
    );
  });

  it('rejects unsafe ids', () => {
    expect(message({ ...base, project_id: 'Bad Id' })).toContain('project_id');
    expect(message({ ...base, task_id: 'Bad Id' })).toContain('task_id');
    expect(message({ bot_id: 'Bad Bot', task_id: 't', text: 'x' })).toContain(
      'bot_id',
    );
  });

  it('rejects a chat_id with whitespace or over 512 characters', () => {
    expect(message({ ...base, chat_id: 'a b' })).toContain('"chat_id"');
    expect(message({ ...base, chat_id: 'a'.repeat(513) })).toContain(
      '"chat_id"',
    );
    expect(
      parseSendAgentMessageInputs({ ...base, chat_id: 'a'.repeat(512) }).ok,
    ).toBe(true);
  });

  it('requires exactly one of text or text_file', () => {
    const noText = { project_id: base.project_id, task_id: base.task_id };
    expect(message(noText)).toBe(
      'send-agent-message requires exactly one of "text" or "text_file"',
    );
    expect(message({ ...base, text_file: SECRET_PATH })).toBe(
      'send-agent-message requires exactly one of "text" or "text_file"',
    );
  });

  it('accepts text_file as a trimmed path', () => {
    const noText = { project_id: base.project_id, task_id: base.task_id };
    const parsed = parseSendAgentMessageInputs({
      ...noText,
      text_file: `  ${SECRET_PATH} `,
    });
    expect(parsed.ok && parsed.value.text).toEqual({
      kind: 'file',
      path: SECRET_PATH,
    });
  });

  it('refuses whitespace-only text', () => {
    expect(message({ ...base, text: ' \n\t ' })).toBe(
      'send-agent-message "text" must contain a non-space character',
    );
  });

  it('defaults mode to queue and accepts steer case-insensitively', () => {
    expect(
      parseSendAgentMessageInputs({ ...base, chat_id: 'c', mode: ' STEER ' }),
    ).toMatchObject({ ok: true, value: { mode: 'steer' } });
    expect(
      parseSendAgentMessageInputs({ ...base, mode: 'Queue' }),
    ).toMatchObject({ ok: true, value: { mode: 'queue' } });
  });

  it('refuses steer without chat_id and unknown modes', () => {
    expect(message({ ...base, mode: 'steer' })).toBe(
      'send-agent-message "mode: steer" requires "chat_id"',
    );
    expect(message({ ...base, mode: 'interrupt' })).toBe(
      'send-agent-message "mode" must be "queue" or "steer"',
    );
  });

  it('parses bot_id with steer; the host refuses it after the owner check', () => {
    expect(
      parseSendAgentMessageInputs({
        bot_id: 'app_advisor',
        task_id: 't',
        chat_id: 'c',
        text: 'x',
        mode: 'steer',
      }).ok,
    ).toBe(true);
  });

  it('refuses interface_mode with chat_id and attachments without it', () => {
    expect(
      message({ ...base, chat_id: 'c', interface_mode: 'canopy' }),
    ).toContain('"interface_mode"');
    expect(message({ ...base, attachments: '["a.txt"]' })).toBe(
      'send-agent-message "attachments" requires "chat_id"',
    );
  });

  // CAN-4551: a converted automation's send into an existing worktree
  // always opens its own chat, as the native action's did.
  it('parses new_chat for a new chat, and refuses it with chat_id', () => {
    const parsed = parseSendAgentMessageInputs({ ...base, new_chat: 'true' });
    expect(parsed).toMatchObject({ ok: true, value: { newChat: true } });
    expect(message({ ...base, chat_id: 'c', new_chat: 'true' })).toBe(
      'send-agent-message "new_chat" applies only to a new chat; remove "chat_id" or "new_chat"',
    );
  });

  it('accepts exactly the thinking levels', () => {
    for (const level of THINKING_LEVELS) {
      expect(
        parseSendAgentMessageInputs({ ...base, thinking_effort: level }),
      ).toMatchObject({
        ok: true,
        value: { settings: { thinkingEffort: level } },
      });
    }
    expect(message({ ...base, thinking_effort: 'extreme' })).toContain(
      '"thinking_effort"',
    );
  });

  it('accepts exactly the approval modes', () => {
    for (const mode of APPROVAL_MODES) {
      expect(
        parseSendAgentMessageInputs({ ...base, approval_mode: mode }),
      ).toMatchObject({
        ok: true,
        value: { settings: { approvalMode: mode } },
      });
    }
    expect(message({ ...base, approval_mode: 'yolo' })).toContain(
      '"approval_mode"',
    );
  });

  it('accepts only booleans for fast_mode and plan_mode', () => {
    expect(
      parseSendAgentMessageInputs({
        ...base,
        fast_mode: ' TRUE ',
        plan_mode: 'false',
      }),
    ).toMatchObject({
      ok: true,
      value: { settings: { fastMode: true, planMode: false } },
    });
    expect(message({ ...base, fast_mode: 'yes' })).toBe(
      'send-agent-message "fast_mode" must be "true" or "false"',
    );
    expect(message({ ...base, plan_mode: '1' })).toBe(
      'send-agent-message "plan_mode" must be "true" or "false"',
    );
  });

  it('accepts exactly the interface modes for a new chat', () => {
    for (const mode of SEND_AGENT_MESSAGE_INTERFACE_MODES) {
      expect(
        parseSendAgentMessageInputs({ ...base, interface_mode: mode }),
      ).toMatchObject({
        ok: true,
        value: { settings: { interfaceMode: mode } },
      });
    }
    expect(message({ ...base, interface_mode: 'terminal' })).toContain(
      '"interface_mode"',
    );
  });

  it('keeps model as authored', () => {
    expect(
      parseSendAgentMessageInputs({ ...base, model: ' $cheap ' }),
    ).toMatchObject({ ok: true, value: { settings: { model: '$cheap' } } });
  });

  it('parses plugins and refuses malformed ones', () => {
    expect(
      parseSendAgentMessageInputs({
        ...base,
        plugins: JSON.stringify([PLUGIN_REF]),
      }),
    ).toMatchObject({
      ok: true,
      value: { settings: { plugins: [PLUGIN_REF] } },
    });
    expect(message({ ...base, plugins: '[not json' })).toBe(
      'send-agent-message "plugins" must be a JSON array',
    );
    expect(message({ ...base, plugins: '{}' })).toBe(
      'send-agent-message "plugins" must be a JSON array',
    );
    expect(message({ ...base, plugins: '[{"type":"nope"}]' })).toBe(
      'send-agent-message "plugins" holds an invalid plugin reference',
    );
  });

  describe('text_references', () => {
    const text = 'Read @notes.md now';
    const fileRef: ConfiguredPromptReference = {
      kind: 'file',
      textStart: 5,
      displayText: '@notes.md',
      root: { kind: 'workspace' },
      relativePath: 'notes.md',
    };

    it('accepts references that match inline text', () => {
      expect(
        parseSendAgentMessageInputs({
          ...base,
          text,
          text_references: JSON.stringify([fileRef]),
        }),
      ).toMatchObject({ ok: true, value: { textReferences: [fileRef] } });
    });

    it('refuses references that do not match inline text', () => {
      const error = message({
        ...base,
        text: `Other ${SECRET_TEXT}`,
        text_references: JSON.stringify([fileRef]),
      });
      expect(error).toContain('"text_references"');
      expect(error).not.toContain(SECRET_TEXT);
    });

    it('refuses malformed JSON and malformed entries', () => {
      expect(message({ ...base, text_references: '[' })).toBe(
        'send-agent-message "text_references" must be a JSON array',
      );
      expect(
        message({
          ...base,
          text,
          text_references: JSON.stringify([{ ...fileRef, kind: 'other' }]),
        }),
      ).toContain('"text_references"');
    });

    it('checks only the shape with text_file', () => {
      const noText = { project_id: base.project_id, task_id: base.task_id };
      expect(
        parseSendAgentMessageInputs({
          ...noText,
          text_file: 'notes.txt',
          text_references: JSON.stringify([fileRef]),
        }),
      ).toMatchObject({ ok: true, value: { textReferences: [fileRef] } });
      expect(
        message({
          ...noText,
          text_file: 'notes.txt',
          text_references: JSON.stringify([
            { ...fileRef, relativePath: '../x' },
          ]),
        }),
      ).toContain('"text_references"');
      expect(
        message({
          ...noText,
          text_file: 'notes.txt',
          text_references: JSON.stringify([fileRef, fileRef]),
        }),
      ).toContain('"text_references"');
    });

    it('checks references against text read later', () => {
      expect(checkSendAgentMessageReferences(text, [fileRef])).toBeNull();
      expect(
        checkSendAgentMessageReferences(`x ${SECRET_TEXT}`, [fileRef]),
      ).toMatch(/^send-agent-message "text_references" is invalid/);
      expect(
        checkSendAgentMessageReferences(`x ${SECRET_TEXT}`, [fileRef]),
      ).not.toContain(SECRET_TEXT);
      expect(checkSendAgentMessageReferences('anything', undefined)).toBeNull();
    });
  });

  it('parses attachments and refuses malformed ones', () => {
    expect(
      parseSendAgentMessageInputs({
        ...base,
        chat_id: 'c',
        attachments: JSON.stringify([SECRET_PATH]),
      }),
    ).toMatchObject({ ok: true, value: { attachments: [SECRET_PATH] } });
    for (const attachments of ['[', '"a"', '[""]', '[1]']) {
      const error = message({ ...base, chat_id: 'c', attachments });
      expect(error).toContain('"attachments"');
    }
  });

  it('never echoes text or paths in failures', () => {
    const failures = [
      message({ ...base, text_file: SECRET_PATH }),
      message({ ...base, mode: SECRET_TEXT }),
      message({ ...base, plugins: SECRET_TEXT }),
      message({ ...base, chat_id: 'c', attachments: `["${SECRET_PATH}", 3]` }),
      message({ ...base, thinking_effort: SECRET_TEXT }),
    ];
    for (const error of failures) {
      expect(error).not.toContain(SECRET_TEXT);
      expect(error).not.toContain(SECRET_PATH);
    }
  });
});

describe('send-agent-message outputs', () => {
  it('declares the documented outputs', () => {
    expect(SEND_AGENT_MESSAGE_OUTPUTS).toEqual([
      'chat_id',
      'state',
      'project_id',
      'bot_id',
      'task_id',
      'chat_created',
      'message_id',
      'queued_message_id',
      'turn_id',
      'accepted_at',
      'steer_unavailable_reason',
    ]);
  });

  it('empties every output except chat_created', () => {
    const outputs = emptySendAgentMessageOutputs();
    expect(Object.keys(outputs)).toEqual([...SEND_AGENT_MESSAGE_OUTPUTS]);
    for (const [name, value] of Object.entries(outputs)) {
      expect(value).toBe(name === 'chat_created' ? 'false' : '');
    }
  });
});

describe('parsePipelineChatSendRecord', () => {
  const record = {
    version: 1,
    address: {
      kind: 'project',
      projectId: 'p',
      taskId: 't',
      chatId: 'c',
    },
    userMessageId: 'u-1',
    queuedMessageId: 'q-1',
    state: 'queued',
    chatCreated: false,
    acceptedAt: '2026-10-28T00:00:00.000Z',
    turnId: 'turn-1',
  };

  it('accepts a valid record', () => {
    expect(parsePipelineChatSendRecord(record)).toEqual(record);
    expect(
      parsePipelineChatSendRecord({
        ...record,
        address: {
          kind: 'bot',
          botId: 'app_advisor',
          taskId: 't',
          chatId: 'c',
        },
      }),
    ).toBeDefined();
  });

  it.each([
    ['a wrong version', { ...record, version: 2 }],
    ['an unknown state', { ...record, state: 'delivered' }],
    [
      'a mixed address',
      {
        ...record,
        address: { ...record.address, botId: 'app_advisor' },
      },
    ],
    [
      'a missing userMessageId',
      Object.fromEntries(
        Object.entries(record).filter(([key]) => key !== 'userMessageId'),
      ),
    ],
    ['extra keys', { ...record, text: 'hello' }],
  ])('rejects %s', (_label, value) => {
    expect(parsePipelineChatSendRecord(value)).toBeUndefined();
  });
});
