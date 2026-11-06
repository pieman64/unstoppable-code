import { APP_ADVISOR_PROJECT_ID } from '@canopy/desktop-shared/types';
import {
  CoreChatLocateResultSchema,
  type CanopyCallerDescriptor,
} from '@canopy/protocol/canopy-core';
import {
  readWorkEntriesFileStrict,
  resolveWorkEntryForChat,
} from '../../lib/cowork-work-entries';
import {
  createDesktopChatLocateHost,
  type CoreChatLocateHost,
} from '../core-chat-locate-adapter';
import { createDesktopRuntime } from '../desktop-runtime';

jest.mock('../../lib/cowork-work-entries', () => ({
  readWorkEntriesFileStrict: jest.fn(),
  resolveWorkEntryForChat: jest.fn(),
}));

const reader: CanopyCallerDescriptor = {
  principalId: 'local-desktop-user',
  clientInstanceId: 'test-client',
  authorityId: 'local-desktop',
  interfaceKind: 'test',
  grants: ['core.chat.read'],
};

function makeRuntime(): {
  locate: jest.MockedFunction<CoreChatLocateHost['locate']>;
  runtime: ReturnType<typeof createDesktopRuntime>;
} {
  const locate = jest.fn<
    ReturnType<CoreChatLocateHost['locate']>,
    Parameters<CoreChatLocateHost['locate']>
  >();
  const host: CoreChatLocateHost = {
    workEntryWorkspace: (workspaceId) =>
      workspaceId === 'cowork-ws' || workspaceId === APP_ADVISOR_PROJECT_ID
        ? workspaceId
        : null,
    locate,
  };
  return { locate, runtime: createDesktopRuntime({ chatLocateHost: host }) };
}

describe('core.chat.locate (CAN-4110)', () => {
  it('locates a live Work Entry chat', async () => {
    const { locate, runtime } = makeRuntime();
    locate.mockResolvedValue({ entryId: 'entry-1', archivedInEntryId: null });
    try {
      const result = await runtime.query(
        'core.chat.locate',
        { scope: { workspaceId: 'cowork-ws' }, chatId: 'chat-1' },
        { caller: reader },
      );
      expect(result).toEqual({
        worktreeId: 'entry-1',
        archivedInWorktreeId: null,
      });
      expect(CoreChatLocateResultSchema.parse(result)).toEqual(result);
      expect(locate).toHaveBeenCalledWith('cowork-ws', 'chat-1');
    } finally {
      await runtime.shutdown();
    }
  });

  it('locates an archived chat', async () => {
    const { locate, runtime } = makeRuntime();
    locate.mockResolvedValue({ entryId: null, archivedInEntryId: 'entry-2' });
    try {
      await expect(
        runtime.query(
          'core.chat.locate',
          {
            scope: { workspaceId: APP_ADVISOR_PROJECT_ID },
            chatId: 'chat-2',
          },
          { caller: reader },
        ),
      ).resolves.toEqual({
        worktreeId: null,
        archivedInWorktreeId: 'entry-2',
      });
    } finally {
      await runtime.shutdown();
    }
  });

  it('refuses a workspace without Work Entries', async () => {
    const { locate, runtime } = makeRuntime();
    try {
      await expect(
        runtime.query(
          'core.chat.locate',
          { scope: { workspaceId: 'workspace-1' }, chatId: 'chat-1' },
          { caller: reader },
        ),
      ).rejects.toMatchObject({
        payload: { kind: 'capability_unavailable' },
      });
      expect(locate).not.toHaveBeenCalled();
    } finally {
      await runtime.shutdown();
    }
  });

  it('reports an unreadable registry as unavailable, never as not found', async () => {
    const { locate, runtime } = makeRuntime();
    locate.mockRejectedValue(new Error('EACCES: work-entries.json'));
    try {
      await expect(
        runtime.query(
          'core.chat.locate',
          { scope: { workspaceId: 'cowork-ws' }, chatId: 'chat-1' },
          { caller: reader },
        ),
      ).rejects.toMatchObject({
        payload: {
          kind: 'unavailable',
          code: 'core.chat.locate.unavailable',
          retry: { kind: 'same_request', delayMs: 1000 },
        },
      });
    } finally {
      await runtime.shutdown();
    }
  });

  it('refuses a remote target and a caller without core.chat.read', async () => {
    const { locate, runtime } = makeRuntime();
    try {
      await expect(
        runtime.query(
          'core.chat.locate',
          {
            scope: { workspaceId: 'cowork-ws', targetId: 't' },
            chatId: 'chat-1',
          },
          { caller: reader },
        ),
      ).rejects.toMatchObject({
        payload: { kind: 'capability_unavailable' },
      });
      await expect(
        runtime.query(
          'core.chat.locate',
          { scope: { workspaceId: 'cowork-ws' }, chatId: 'chat-1' },
          { caller: { ...reader, grants: ['core.chat.write'] } },
        ),
      ).rejects.toMatchObject({ payload: { kind: 'permission_denied' } });
      expect(locate).not.toHaveBeenCalled();
    } finally {
      await runtime.shutdown();
    }
  });

  it('fails an unreadable registry in the desktop host instead of reading it as empty', async () => {
    jest
      .mocked(readWorkEntriesFileStrict)
      .mockRejectedValue(new Error('EACCES: work-entries.json'));
    jest
      .mocked(resolveWorkEntryForChat)
      .mockResolvedValue({ entryId: null, archivedInEntryId: null });
    const runtime = createDesktopRuntime({
      chatLocateHost: createDesktopChatLocateHost(),
    });
    try {
      await expect(
        runtime.query(
          'core.chat.locate',
          {
            scope: { workspaceId: APP_ADVISOR_PROJECT_ID },
            chatId: 'chat-1',
          },
          { caller: reader },
        ),
      ).rejects.toMatchObject({
        payload: {
          kind: 'unavailable',
          code: 'core.chat.locate.unavailable',
        },
      });
      expect(resolveWorkEntryForChat).not.toHaveBeenCalled();
    } finally {
      await runtime.shutdown();
    }
  });
});
