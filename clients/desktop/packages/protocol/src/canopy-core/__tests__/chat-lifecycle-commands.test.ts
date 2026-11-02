import {
  CoreChatArchiveParamsSchema,
  CoreChatCreateParamsSchema,
  CoreChatDeleteParamsSchema,
  CoreChatFileRefSchema,
  CoreChatForkErrorSchema,
  CoreChatForkParamsSchema,
  CoreChatLifecycleErrorSchema,
  CoreChatUpdateParamsSchema,
} from '../core/chat/commands-lifecycle';

const envelope = {
  projectId: 'project',
  worktreeId: 'worktree',
  commandId: 'command',
  _meta: { idempotencyKey: 'command' },
};

describe('chat lifecycle instruction contracts', () => {
  it.each([null, 'raw', 'preview', 'table', 'diff'])(
    'accepts an explicit file view mode or removal: %s',
    (fileViewMode) => {
      expect(
        CoreChatUpdateParamsSchema.safeParse({
          ...envelope,
          action: {
            type: 'chat.patch_tab_settings',
            tabId: 'file',
            patch: { fileViewMode },
          },
        }).success,
      ).toBe(true);
    },
  );

  it.each(['source', '', 42, false, {}, []])(
    'rejects an unsupported file view mode: %s',
    (fileViewMode) => {
      expect(
        CoreChatUpdateParamsSchema.safeParse({
          ...envelope,
          action: {
            type: 'chat.patch_tab_settings',
            tabId: 'file',
            patch: { fileViewMode },
          },
        }).success,
      ).toBe(false);
    },
  );

  it.each([null, 'My chat', 'x'.repeat(256), '😀'.repeat(128)])(
    'accepts a normalized custom title: %s',
    (customTitle) => {
      expect(
        CoreChatUpdateParamsSchema.safeParse({
          ...envelope,
          action: {
            type: 'chat.patch_tab_settings',
            tabId: 'tab',
            patch: { customTitle },
          },
        }).success,
      ).toBe(true);
    },
  );

  it.each([
    '',
    ' ',
    ' leading',
    'trailing ',
    'trailing\n',
    '\uFEFFname',
    'x'.repeat(257),
    '😀'.repeat(129),
    42,
    false,
    {},
    [],
  ])('rejects an invalid custom title: %s', (customTitle) => {
    expect(
      CoreChatUpdateParamsSchema.safeParse({
        ...envelope,
        action: {
          type: 'chat.patch_tab_settings',
          tabId: 'tab',
          patch: { customTitle },
        },
      }).success,
    ).toBe(false);
  });

  it.each([
    [CoreChatCreateParamsSchema, { type: 'chat.create_tab', tabId: 'tab' }],
    [
      CoreChatCreateParamsSchema,
      { type: 'chat.create_file_tab', tabId: 'tab' },
    ],
    [
      CoreChatCreateParamsSchema,
      { type: 'chat.create_file_tab', tabId: 'tab', activate: false },
    ],
    [
      CoreChatUpdateParamsSchema,
      {
        type: 'chat.patch_tab_settings',
        tabId: 'tab',
        patch: { unread: true },
      },
    ],
    [CoreChatUpdateParamsSchema, { type: 'chat.activate_tab', tabId: 'tab' }],
    [
      CoreChatUpdateParamsSchema,
      { type: 'chat.reorder_tabs', tabIds: ['tab'] },
    ],
    [
      CoreChatUpdateParamsSchema,
      {
        type: 'chat.set_model',
        tabId: 'tab',
        model: 'model',
        providerType: 'claude',
      },
    ],
    [CoreChatUpdateParamsSchema, { type: 'chat.mark_read', chatId: 'tab' }],
    [CoreChatUpdateParamsSchema, { type: 'chat.mark_unread', chatId: 'tab' }],
    [
      CoreChatUpdateParamsSchema,
      {
        type: 'chat.mark_archive_read',
        archiveEntryId: 'archive',
        unread: false,
      },
    ],
    [CoreChatUpdateParamsSchema, { type: 'chat.mark_all_archives_read' }],
    [
      CoreChatUpdateParamsSchema,
      { type: 'chat.dismiss_attention', chatId: 'tab' },
    ],
    [
      CoreChatArchiveParamsSchema,
      { type: 'chat.archive_tab', tabId: 'tab', unread: true },
    ],
    [
      CoreChatArchiveParamsSchema,
      {
        type: 'chat.restore_archive',
        archiveEntryId: 'archive',
        targetTabId: 'tab',
      },
    ],
    [
      CoreChatDeleteParamsSchema,
      {
        type: 'chat.close_tab',
        tabId: 'tab',
        mode: 'archive',
        replacementTab: {
          type: 'chat.create_tab',
          tabId: 'starter',
          seedFileRef: { fileRootId: 'root', relativePath: 'src/a.ts' },
        },
      },
    ],
    [
      CoreChatDeleteParamsSchema,
      {
        type: 'chat.close_tabs',
        targets: [{ tabId: 'tab', mode: 'discard_empty' }],
        replacementTabId: 'starter',
      },
    ],
    [
      CoreChatForkParamsSchema,
      {
        type: 'chat.fork_tab',
        sourceTabId: 'tab',
        targetTabId: 'fork',
        atMessageId: 'message',
        cloneMode: 'continuation',
      },
    ],
  ])('accepts a supported action', (schema, action) => {
    expect(schema.safeParse({ ...envelope, action }).success).toBe(true);
  });

  it('accepts OpenCode model selection through the core contract', () => {
    expect(
      CoreChatUpdateParamsSchema.safeParse({
        ...envelope,
        action: {
          type: 'chat.set_model',
          tabId: 'tab',
          model: 'opencode:fixture%2Fmodel',
          providerType: 'opencode',
        },
      }).success,
    ).toBe(true);
  });

  it('rejects an unknown settings patch field', () => {
    expect(
      CoreChatUpdateParamsSchema.safeParse({
        ...envelope,
        action: {
          type: 'chat.patch_tab_settings',
          tabId: 'tab',
          patch: { unknown: true },
        },
      }).success,
    ).toBe(false);
  });

  it('changes approval mode only through its dedicated action', () => {
    const parse = (action: unknown): boolean =>
      CoreChatUpdateParamsSchema.safeParse({ ...envelope, action }).success;
    expect(
      parse({
        type: 'chat.patch_tab_settings',
        tabId: 'tab',
        patch: { approvalMode: 'full-access' },
      }),
    ).toBe(false);
    for (const approvalMode of ['ask', 'auto', 'full-access']) {
      expect(
        parse({ type: 'chat.set_approval_mode', tabId: 'tab', approvalMode }),
      ).toBe(true);
    }
    expect(
      parse({ type: 'chat.set_approval_mode', tabId: 'tab', approvalMode: '' }),
    ).toBe(false);
    expect(
      parse({
        type: 'chat.set_approval_mode',
        tabId: 'tab',
        approvalMode: 'ask',
        patch: { title: 'Extra' },
      }),
    ).toBe(false);
    expect(parse({ type: 'chat.set_approval_mode', tabId: 'tab' })).toBe(false);
  });

  it('marks a chat unread manually only with a literal true flag', () => {
    const parse = (action: unknown): boolean =>
      CoreChatUpdateParamsSchema.safeParse({ ...envelope, action }).success;
    expect(
      parse({ type: 'chat.mark_unread', chatId: 'tab', manual: true }),
    ).toBe(true);
    expect(
      parse({ type: 'chat.mark_unread', chatId: 'tab', manual: false }),
    ).toBe(false);
    expect(
      parse({ type: 'chat.mark_unread', chatId: 'tab', manual: 'yes' }),
    ).toBe(false);
    expect(
      parse({ type: 'chat.mark_unread', chatId: 'tab', extra: true }),
    ).toBe(false);
    expect(parse({ type: 'chat.mark_read', chatId: 'tab', manual: true })).toBe(
      false,
    );
  });

  it.each([
    [
      CoreChatDeleteParamsSchema,
      { type: 'chat.close_tab', tabId: 'tab', mode: 'purge' },
    ],
    [CoreChatDeleteParamsSchema, { type: 'chat.close_tabs', targets: [] }],
    [
      CoreChatForkParamsSchema,
      {
        type: 'chat.fork_tab',
        sourceTabId: 'tab',
        targetTabId: 'fork',
        destinationTab: {},
      },
    ],
    [
      CoreChatArchiveParamsSchema,
      { type: 'chat.close_tab', tabId: 'tab', mode: 'archive' },
    ],
    [
      CoreChatForkParamsSchema,
      {
        type: 'chat.fork_tab',
        sourceTabId: 'tab',
        targetTabId: 'fork',
        destinationCreate: { type: 'chat.create_tab', tabId: 'fork' },
      },
    ],
    [
      CoreChatForkParamsSchema,
      {
        type: 'chat.fork_tab',
        sourceTabId: 'tab',
        targetTabId: 'fork',
        destinationCreate: {
          type: 'chat.create_tab',
          tabId: 'fork',
          seedTab: {},
          title: 'Dropped by the legacy fork',
        },
      },
    ],
  ])('rejects an action outside its operation', (schema, action) => {
    expect(schema.safeParse({ ...envelope, action }).success).toBe(false);
  });

  it('declares fork boundary errors', () => {
    expect(
      CoreChatForkErrorSchema.safeParse({
        kind: 'not_found',
        message: 'Fork boundary not found',
        code: 'core.chat.forkBoundaryNotFound',
        retry: { kind: 'never' },
      }).success,
    ).toBe(true);
  });

  it('requires the keyed command id', () => {
    expect(
      CoreChatCreateParamsSchema.safeParse({
        ...envelope,
        _meta: {},
        action: { type: 'chat.create_tab', tabId: 'tab' },
      }).success,
    ).toBe(false);
  });

  it('requires keyed retry guidance for unavailable and deadline errors', () => {
    for (const kind of ['unavailable', 'deadline_exceeded'] as const) {
      expect(
        CoreChatLifecycleErrorSchema.safeParse({
          kind,
          message: 'Retry this request',
          retry: { kind: 'same_request' },
        }).success,
      ).toBe(false);
      expect(
        CoreChatLifecycleErrorSchema.safeParse({
          kind,
          message: 'Retry this request',
          retry: { kind: 'same_idempotency_key' },
        }).success,
      ).toBe(true);
    }
  });

  it.each([
    '/absolute',
    '../escape',
    'a/../escape',
    'a/./b',
    'C:/absolute',
    'a\\b',
  ])('rejects an uncontained file reference: %s', (relativePath) => {
    expect(
      CoreChatFileRefSchema.safeParse({
        fileRootId: 'root',
        relativePath,
      }).success,
    ).toBe(false);
  });
});
