import { CHAT_ATTACHMENT_PROMPT_KINDS } from '@canopy/agent-transcript/types';
import { SCHEDULED_ATTACHMENT_PROMPT_KINDS } from '../chat-send-actions';
import {
  acceptedInputReceiptSchema,
  CHAT_CREATION_ACTION_TYPES,
  chatCreationActionSchema,
  isChatCreationActionType,
  parseChatCreationAction,
  projectsCreateTaskJsonSchema,
  projectsCreateTaskChatJsonSchema,
  botsCreateTaskJsonSchema,
  botsCreateTaskChatJsonSchema,
  botsSendMessageJsonSchema,
  isChatSendActionType,
  parseProjectMessageControlAction,
  projectsScheduleMessageJsonSchema,
  projectsSteerQueuedMessageJsonSchema,
  parseChatSendAction,
  projectsSendMessageJsonSchema,
} from '../chat-send-actions';

const project = {
  type: 'projects.send_message',
  projectId: 'p1',
  taskId: 't1',
  chatId: 'c1',
  text: '  keep surrounding whitespace  ',
};

describe('agent chat send action contracts', () => {
  it('accepts project and bot sends and keeps text unchanged and unbounded', () => {
    const long = 'x'.repeat(200_000);
    const parsed = parseChatSendAction({ ...project, text: long });
    expect(parsed).toEqual({ ok: true, action: { ...project, text: long } });
    expect(parseChatSendAction(project)).toEqual({
      ok: true,
      action: project,
    });
    expect(
      parseChatSendAction({
        type: 'bots.send_message',
        botId: 'app_advisor',
        taskId: 'e1',
        chatId: 'c2',
        text: 'hi',
        watchers: [{ label: 'Reply', allowDuplicate: true }],
      }).ok,
    ).toBe(true);
  });

  it.each([
    [{ ...project, text: '   ' }],
    [{ ...project, sender: { kind: 'project' } }],
    [{ ...project, hiddenContext: { kind: 'agent-sender-context' } }],
    [{ ...project, agentSent: {} }],
    [{ ...project, watchers: [{ trigger: 'project_task_chat_completion' }] }],
    [{ ...project, watchers: [{ armForNextCompletion: true }] }],
    [{ ...project, watchers: Array.from({ length: 11 }, () => ({})) }],
    [
      {
        type: 'bots.send_message',
        botId: 'app_advisor',
        taskId: 'e1',
        chatId: 'c2',
        text: 'hi',
        queueForSetup: true,
      },
    ],
  ])('rejects blank text, spoofed fields and unsupported options %#', (raw) => {
    expect(parseChatSendAction(raw).ok).toBe(false);
  });

  it('matches exact action names only', () => {
    expect(isChatSendActionType('projects.send_message')).toBe(true);
    expect(isChatSendActionType('bots.send_message')).toBe(true);
    expect(isChatSendActionType('projects.send_message_extra')).toBe(false);
  });

  it('advertises strict JSON schemas without a text length limit', () => {
    expect(projectsSendMessageJsonSchema.additionalProperties).toBe(false);
    for (const key of ['type', 'projectId', 'taskId', 'chatId', 'text'])
      expect(projectsSendMessageJsonSchema.required).toContain(key);
    expect(
      (projectsSendMessageJsonSchema.properties as Record<string, unknown>)
        .text,
    ).not.toHaveProperty('maxLength');
    expect(botsSendMessageJsonSchema.properties).not.toHaveProperty(
      'queueForSetup',
    );
  });

  it('requires a canonical input identity on every receipt', () => {
    const base = {
      address: { projectId: 'p1', taskId: 't1', chatId: 'c1' },
      acceptedAt: '2026-10-17T00:00:00.000Z',
      watcherReceipts: [{ watcherId: 'w1', disposition: 'created' }],
    };
    expect(
      acceptedInputReceiptSchema.safeParse({
        ...base,
        disposition: 'started',
        messageId: 'm1',
      }).success,
    ).toBe(true);
    expect(
      acceptedInputReceiptSchema.safeParse({
        ...base,
        disposition: 'queued',
        queuedMessageId: 'q1',
      }).success,
    ).toBe(true);
    expect(
      acceptedInputReceiptSchema.safeParse({ ...base, disposition: 'started' })
        .success,
    ).toBe(false);
    expect(
      acceptedInputReceiptSchema.safeParse({
        ...base,
        disposition: 'queued',
        messageId: 'm1',
      }).success,
    ).toBe(false);
  });
});

describe('project message control schemas', () => {
  const steer = {
    type: 'projects.steer_queued_message',
    projectId: 'p',
    taskId: 't',
    chatId: 'c',
    queuedMessageId: 'q',
  };
  const schedule = {
    type: 'projects.schedule_message',
    projectId: 'p',
    taskId: 't',
    chatId: 'c',
    text: ' unchanged ',
    runAt: '2099-06-01T15:00:00+02:00',
  };
  it('accepts explicit offsets and preserves text, but rejects local or invalid dates', () => {
    expect(parseProjectMessageControlAction(schedule)).toEqual({
      ok: true,
      action: schedule,
    });
    for (const runAt of [
      '2099-06-01T15:00:00',
      'tomorrow',
      '2099-13-01T15:00:00Z',
    ])
      expect(parseProjectMessageControlAction({ ...schedule, runAt }).ok).toBe(
        false,
      );
    expect(
      parseProjectMessageControlAction({
        ...schedule,
        runAt: '2099-06-01T15:00:00Z',
      }).ok,
    ).toBe(true);
  });
  it.each([steer, schedule])(
    'rejects unknown identity and action fields: $type',
    (action) => {
      expect(parseProjectMessageControlAction(action).ok).toBe(true);
      for (const extra of [
        { agentSent: {} },
        { agentSteeringActor: {} },
        { agentScheduledSend: {} },
        { worktreeId: 'other' },
        { watchers: [] },
      ])
        expect(
          parseProjectMessageControlAction({ ...action, ...extra }).ok,
        ).toBe(false);
    },
  );
  it('validates typed attachments strictly at every level', () => {
    const attachments = {
      fileReferences: [
        { displayPath: 'file', absolutePath: '/repo/file', repoName: 'repo' },
      ],
      attachmentPaths: ['/attachments/file'],
      attachmentPromptContexts: [
        {
          attachmentPath: '/attachments/file',
          promptKind: 'in-app-browser-resource',
        },
      ],
    };
    expect(
      parseProjectMessageControlAction({ ...schedule, attachments }).ok,
    ).toBe(true);
    for (const bad of [
      { ...attachments, extra: true },
      {
        ...attachments,
        fileReferences: [{ ...attachments.fileReferences[0], extra: true }],
      },
      {
        ...attachments,
        attachmentPromptContexts: [
          { ...attachments.attachmentPromptContexts[0], extra: true },
        ],
      },
      { fileReferences: [{ displayPath: 'file' }] },
      {
        attachmentPromptContexts: [
          { attachmentPath: 'file', promptKind: 'unknown' },
        ],
      },
    ])
      expect(
        parseProjectMessageControlAction({ ...schedule, attachments: bad }).ok,
      ).toBe(false);
  });
  it('publishes strict JSON schema branches', () => {
    expect(projectsScheduleMessageJsonSchema.additionalProperties).toBe(false);
    expect(projectsSteerQueuedMessageJsonSchema.additionalProperties).toBe(
      false,
    );
  });
});

describe('phase 11 creation action contracts', () => {
  it.each(CHAT_CREATION_ACTION_TYPES)(
    'validates only the public fields of %s',
    (type) => {
      const action = {
        type,
        ...(type.startsWith('projects.')
          ? { projectId: 'p' }
          : { botId: 'app_advisor' }),
        ...(type.endsWith('_chat') ? { taskId: 't' } : { title: '  Title  ' }),
        initialMessage: '  message  ',
      };
      expect(parseChatCreationAction(action)).toEqual({ ok: true, action });
      expect(isChatCreationActionType(type)).toBe(true);
      expect(isChatCreationActionType(type + '_extra')).toBe(false);
      expect(
        parseChatCreationAction({ ...action, type: type + '_extra' }).ok,
      ).toBe(false);
      for (const field of [
        'chatId',
        'worktreeId',
        'sender',
        'source',
        'agentSent',
        'hiddenContext',
        'watchers',
        'queueForSetup',
        'expectedUiRevision',
      ]) {
        expect(
          parseChatCreationAction({ ...action, [field]: 'spoof' }).ok,
        ).toBe(false);
      }
      expect(
        parseChatCreationAction({ ...action, initialMessage: '  ' }).ok,
      ).toBe(false);
      expect(
        parseChatCreationAction({
          ...action,
          initialMessage: 'x'.repeat(200_000),
        }).ok,
      ).toBe(true);
      const { initialMessage, ...empty } = action;
      expect(initialMessage).toBe('  message  ');
      expect(parseChatCreationAction(empty).ok).toBe(
        type.startsWith('projects.') || type === 'bots.create_task',
      );
      if (type.endsWith('_chat')) {
        expect(parseChatCreationAction({ ...action, title: 'No' }).ok).toBe(
          false,
        );
        expect(parseChatCreationAction({ ...action, taskId: ' ' }).ok).toBe(
          false,
        );
      } else {
        expect(
          parseChatCreationAction({ ...action, title: 'x'.repeat(200) }).ok,
        ).toBe(true);
        expect(
          parseChatCreationAction({ ...action, title: 'x'.repeat(201) }).ok,
        ).toBe(false);
        expect(parseChatCreationAction({ ...action, title: ' ' }).ok).toBe(
          true,
        );
      }
      expect(
        chatCreationActionSchema.safeParse({
          ...action,
          [type.startsWith('projects.') ? 'projectId' : 'botId']: ' ',
        }).success,
      ).toBe(false);
    },
  );
  it.each([
    projectsCreateTaskJsonSchema,
    projectsCreateTaskChatJsonSchema,
    botsCreateTaskJsonSchema,
    botsCreateTaskChatJsonSchema,
  ])('publishes strict provider schemas %#', (schema) => {
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties?.initialMessage).not.toHaveProperty('maxLength');
    expect(schema.properties).not.toHaveProperty('sender');
    expect(schema.properties).not.toHaveProperty('watchers');
    expect(schema.properties).not.toHaveProperty('chatId');
  });
});

it('keeps the shared schedule prompt kinds equal to the transcript kinds', () => {
  expect([...SCHEDULED_ATTACHMENT_PROMPT_KINDS]).toEqual([
    ...CHAT_ATTACHMENT_PROMPT_KINDS,
  ]);
});
