import type {
  ChatStateCommandPort,
  ChatStateSnapshot,
} from '@canopy/desktop-shared/types';
import { createDesktopRuntime } from '../../../canopy-runtime/desktop-runtime';
import {
  createPortalReadOptions,
  queryPortalChatState,
  queryPortalChatTranscriptPage,
  queryPortalChatSendReceipt,
} from '../chat-state-query';
import type { PortalAdapterContext } from '../types';

const snapshot: ChatStateSnapshot = {
  schemaVersion: 1,
  projectId: 'project-1',
  worktreeId: 'worktree-1',
  revision: 3,
  tabsFile: { version: 1, activeTabId: '', tabs: [] },
  archives: [],
  runtimeByChatId: {},
  queue: [],
};

describe('Portal chat snapshot query', () => {
  const context: PortalAdapterContext = {
    sessionId: 'session-1',
    getWindow: () => null,
    enqueueEvent: jest.fn(),
    complete: jest.fn(),
    fail: jest.fn(),
  };

  it('builds read-only trusted options from the supplied live predicate, independently of asset policy', () => {
    const signal = new AbortController().signal;
    expect(
      createPortalReadOptions(context, () => true, undefined, signal),
    ).toEqual({
      caller: {
        principalId: 'local-desktop-user',
        clientInstanceId: 'portal-session:session-1',
        authorityId: 'local-desktop',
        interfaceKind: 'portal',
        grants: ['core.chat.read'],
      },
      signal,
    });
    expect(() => createPortalReadOptions(context, () => false)).toThrow(
      'Portal transcript authorization is unavailable.',
    );
    expect(() =>
      createPortalReadOptions({ ...context, sessionId: null }, () => true),
    ).toThrow('Portal transcript authorization is unavailable.');
  });

  it('keeps the asset wrappers authorization errors unchanged', async () => {
    const getTranscriptPage = jest.fn();
    const port: ChatStateCommandPort = {
      getState: jest.fn(),
      getTranscriptPage,
      searchTranscript: jest.fn(),
      readToolOutput: jest.fn(),
      readVisual: jest.fn(),
      command: jest.fn(),
      subscribe: jest.fn().mockReturnValue(() => undefined),
    };
    const runtime = createDesktopRuntime({
      getChatStatePort: () => port,
      chatServices: { getPort: () => port },
    });
    try {
      await expect(
        queryPortalChatTranscriptPage(context, {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          chatId: 'chat-1',
        }),
      ).rejects.toThrow('Portal asset authorization is unavailable.');
      await expect(
        queryPortalChatSendReceipt(context, {
          scope: {
            workspaceId: 'project-1',
            worktreeId: 'worktree-1',
            chatId: 'chat-1',
          },
          commandId: 'command-1',
        }),
      ).rejects.toThrow('Portal asset authorization is unavailable.');
      expect(getTranscriptPage).not.toHaveBeenCalled();
    } finally {
      await runtime.shutdown();
    }
  });

  it('keeps the asset page post-await revocation check and legacy result', async () => {
    let authorized = true;
    const page = { messages: [], totalMessages: 0, transcriptRevision: 1 };
    const getTranscriptPage = jest.fn().mockImplementation(() => {
      authorized = false;
      return Promise.resolve(page);
    });
    const port: ChatStateCommandPort = {
      getState: jest.fn(),
      getTranscriptPage,
      searchTranscript: jest.fn(),
      readToolOutput: jest.fn(),
      readVisual: jest.fn(),
      command: jest.fn(),
      subscribe: jest.fn().mockReturnValue(() => undefined),
    };
    const runtime = createDesktopRuntime({
      getChatStatePort: () => port,
      chatServices: { getPort: () => port },
    });
    try {
      await expect(
        queryPortalChatTranscriptPage(
          { ...context, canReadAssets: () => authorized },
          {
            projectId: 'project-1',
            worktreeId: 'worktree-1',
            chatId: 'chat-1',
          },
        ),
      ).rejects.toThrow('Portal asset authorization was revoked.');
      authorized = true;
      getTranscriptPage.mockResolvedValue(page);
      await expect(
        queryPortalChatTranscriptPage(
          { ...context, canReadAssets: () => authorized },
          {
            projectId: 'project-1',
            worktreeId: 'worktree-1',
            chatId: 'chat-1',
          },
        ),
      ).resolves.toBe(page);
    } finally {
      await runtime.shutdown();
    }
  });

  it('uses the active dispatcher and preserves the legacy snapshot', async () => {
    const getState = jest.fn().mockResolvedValue(snapshot);
    const port: ChatStateCommandPort = {
      getState,
      getTranscriptPage: jest.fn(),
      searchTranscript: jest.fn(),
      readToolOutput: jest.fn(),
      readVisual: jest.fn(),
      command: jest.fn(),
      subscribe: jest.fn().mockReturnValue(() => undefined),
    };
    const runtime = createDesktopRuntime({ getChatStatePort: () => port });
    const context: PortalAdapterContext = {
      sessionId: 'session-1',
      getWindow: () => null,
      enqueueEvent: jest.fn(),
      complete: jest.fn(),
      fail: jest.fn(),
    };
    await expect(
      queryPortalChatState(context, {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
      }),
    ).resolves.toBe(snapshot);
    expect(getState).toHaveBeenCalledWith({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
    });
    await runtime.shutdown();
  });
});
