import { CANOPY_QUERY_DEFINITIONS, CANOPY_STREAM_DEFINITIONS } from '..';
import {
  CORE_CHAT_TASK_QUERY_DEFINITIONS,
  CORE_CHAT_TASK_STREAM_DEFINITIONS,
  CORE_INSTRUCTION_DEFINITIONS,
  CoreWorkspaceSchema,
} from '../core';

describe('cowork task contracts (CAN-4185)', () => {
  it('reads tasks and follows them with core.chat.read only', () => {
    const list = CORE_CHAT_TASK_QUERY_DEFINITIONS['core.chat.task.list'];
    const events = CORE_CHAT_TASK_STREAM_DEFINITIONS['core.chat.task.events'];
    expect(list.requiredGrants).toEqual(['core.chat.read']);
    expect(events.requiredGrants).toEqual(['core.chat.read']);
    expect(list.idempotency).toBe('inherent');
  });

  it('stays out of the registries every core must serve', () => {
    expect(Object.keys(CANOPY_QUERY_DEFINITIONS)).not.toContain(
      'core.chat.task.list',
    );
    expect(Object.keys(CANOPY_STREAM_DEFINITIONS)).not.toContain(
      'core.chat.task.events',
    );
  });

  it('scopes a task list to one workspace and refuses other fields', () => {
    const { params } = CORE_CHAT_TASK_QUERY_DEFINITIONS['core.chat.task.list'];
    expect(params.safeParse({ scope: { workspaceId: 'ws-1' } }).success).toBe(
      true,
    );
    expect(
      params.safeParse({
        scope: { workspaceId: 'ws-1', worktreeId: 'task-1' },
      }).success,
    ).toBe(false);
    expect(params.safeParse({ scope: 'all' }).success).toBe(false);
  });

  it('streams task signals for one workspace or all of them', () => {
    const definition =
      CORE_CHAT_TASK_STREAM_DEFINITIONS['core.chat.task.events'];
    expect(definition.params.safeParse({ scope: 'all' }).success).toBe(true);
    expect(
      definition.params.safeParse({ scope: { workspaceId: 'ws-1' } }).success,
    ).toBe(true);
    expect(
      definition.item.safeParse({
        kind: 'task',
        workspaceId: 'ws-1',
        worktreeId: 'task-1',
        batchId: '42',
      }).success,
    ).toBe(true);
    expect(definition.item.safeParse({ kind: 'resync' }).success).toBe(true);
    expect(
      definition.item.safeParse({ kind: 'task', workspaceId: 'ws-1' }).success,
    ).toBe(false);
  });

  it('names a workspace owner only as an organization id or Personal', () => {
    const base = {
      workspaceId: 'ws-1',
      name: 'Notes',
      kind: 'cowork',
      repositorySources: [],
      settings: {},
    };
    expect(CoreWorkspaceSchema.safeParse(base).success).toBe(true);
    expect(
      CoreWorkspaceSchema.safeParse({ ...base, ownerOrganizationId: null })
        .success,
    ).toBe(true);
    expect(
      CoreWorkspaceSchema.safeParse({ ...base, ownerOrganizationId: 'org-1' })
        .success,
    ).toBe(true);
  });

  it('carries attachment references on a send, one to ten of them', () => {
    const { params } = CORE_INSTRUCTION_DEFINITIONS['core.chat.message.send'];
    const send = {
      scope: { workspaceId: 'ws-1', worktreeId: 'task-1' },
      commandId: 'command-1',
      chatId: 'chat-1',
      messageId: 'message-1',
      text: 'See the file.',
      _meta: { idempotencyKey: 'key-1' },
    };
    expect(params.safeParse(send).success).toBe(true);
    expect(
      params.safeParse({ ...send, attachments: [{ attachmentId: 'att-1' }] })
        .success,
    ).toBe(true);
    expect(params.safeParse({ ...send, attachments: [] }).success).toBe(false);
    expect(
      params.safeParse({
        ...send,
        attachments: [{ attachmentId: 'att-1', path: '/tmp/file' }],
      }).success,
    ).toBe(false);
  });
});
