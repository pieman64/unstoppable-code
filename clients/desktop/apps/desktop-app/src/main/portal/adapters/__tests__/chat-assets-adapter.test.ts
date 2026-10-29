jest.mock('../../../codex/runtime-service', () => ({
  getCodexRuntimeService: jest.fn(),
}));
jest.mock('../../../services/standalone-chat-service', () => ({
  resolveStandaloneChatTarget: jest.fn(),
}));
jest.mock('../../../services/files-service', () => ({
  resolvePortalFileTarget: jest.fn(),
  resolvePortalChatAssetFileTarget: jest.fn(),
}));
jest.mock('../../../services/portal-asset-service', () => ({
  readPortalAssetFile: jest.fn(),
  readPortalAssetDataUrl: jest.fn(),
}));
jest.mock('../chat-state-query', () => ({
  queryPortalChatState: jest.fn(),
  queryPortalChatTranscriptPage: jest.fn(),
}));

import type {
  ChatStateCommandPort,
  ChatStateSnapshot,
  PersistedChatMessage,
  PortalCommandEnvelope,
} from '@canopy/desktop-shared/types';
import { portalChatAssetId } from '@canopy/protocol/portal';
import { resolvePortalChatAssetFileTarget } from '../../../services/files-service';
import { resolveStandaloneChatTarget } from '../../../services/standalone-chat-service';
import {
  readPortalAssetDataUrl,
  readPortalAssetFile,
} from '../../../services/portal-asset-service';
import {
  handlePortalChatAssetRead,
  handlePortalFileAssetRead,
  resolveChatAssetSource,
} from '../chat-assets-adapter';
import type { PortalAdapterContext } from '../types';
import {
  queryPortalChatState,
  queryPortalChatTranscriptPage,
} from '../chat-state-query';

const getState = jest.fn<
  ReturnType<ChatStateCommandPort['getState']>,
  Parameters<ChatStateCommandPort['getState']>
>();
const getTranscriptPage = jest.fn<
  ReturnType<ChatStateCommandPort['getTranscriptPage']>,
  Parameters<ChatStateCommandPort['getTranscriptPage']>
>();
const complete = jest.fn();
const fail = jest.fn();
const context: PortalAdapterContext = {
  canReadAssets: () => true,
  getWindow: () => null,
  enqueueEvent: jest.fn(),
  complete,
  fail,
  chatStatePort: {
    getState,
    getTranscriptPage,
    getCommandReceipt: jest.fn(),
    searchTranscript: jest.fn(),
    readToolOutput: jest.fn(),
    command: jest.fn(),
    subscribe: jest.fn(),
  },
};
const message: PersistedChatMessage = {
  id: 'message-one',
  role: 'user',
  timestamp: 1,
  blocks: [],
  attachmentPaths: ['', '/root/a.txt', '/root/a.txt', ' ', '/root/árvore.pdf'],
};
const root = {
  repoId: 'repo',
  repoName: 'Repo',
  absolutePath: '/root',
  rootKind: 'git-repo' as const,
  gitAware: true,
  excludedDescendantRoots: [],
};

function state(
  messages: PersistedChatMessage[],
  loaded = true,
): ChatStateSnapshot {
  return {
    schemaVersion: 1,
    projectId: 'workspace',
    worktreeId: 'worktree',
    revision: 1,
    tabsFile: {
      version: 1,
      activeTabId: 'chat',
      tabs: [
        {
          id: 'chat',
          title: 'Chat',
          createdAt: '2026-10-01',
          messages,
          transcriptLoaded: loaded,
        },
      ],
    },
    archives: [],
    runtimeByChatId: {},
    queue: [],
  };
}
function command(
  payload: unknown = {
    projectId: 'workspace',
    worktreeId: 'worktree',
    chatId: 'chat',
    assetId: portalChatAssetId(message.id, 'attachment', 1),
  },
): PortalCommandEnvelope<unknown> {
  return {
    id: 'command',
    sequence: 1,
    type: 'portal.chat.asset.read',
    createdAt: '2026-10-01',
    expiresAt: null,
    target: { workspaceLocalId: 'workspace', worktreeLocalId: 'worktree' },
    payload,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest
    .mocked(queryPortalChatState)
    .mockImplementation((_context, request) => getState(request));
  jest
    .mocked(queryPortalChatTranscriptPage)
    .mockImplementation((_context, request) => getTranscriptPage(request));
  getState.mockResolvedValue(state([message]));
  jest.mocked(resolvePortalChatAssetFileTarget).mockResolvedValue(root);
});

it('uses the same blank removal and duplicate ordering as attachment projection', () => {
  expect(
    resolveChatAssetSource(
      [message],
      portalChatAssetId(message.id, 'attachment', 0),
    ),
  ).toEqual({ path: '/root/a.txt', image: false });
  expect(
    resolveChatAssetSource(
      [message],
      portalChatAssetId(message.id, 'attachment', 1),
    ),
  ).toEqual({ path: '/root/árvore.pdf', image: false });
  expect(
    resolveChatAssetSource(
      [message],
      portalChatAssetId(message.id, 'attachment', 2),
    ),
  ).toBeUndefined();
});

it('authorizes only canonical visible attachment/image membership, never a browser path', async () => {
  await handlePortalChatAssetRead(command(), context);
  expect(readPortalAssetFile).toHaveBeenCalledWith(
    expect.objectContaining({ path: '/root/árvore.pdf', root: '/root' }),
  );
  expect(fail).not.toHaveBeenCalled();
  jest.mocked(readPortalAssetFile).mockClear();
  await handlePortalChatAssetRead(
    command({
      projectId: 'workspace',
      worktreeId: 'worktree',
      chatId: 'chat',
      assetId: 'asset-/etc/passwd',
    }),
    context,
  );
  expect(readPortalAssetFile).not.toHaveBeenCalled();
  expect(fail).toHaveBeenLastCalledWith(
    expect.anything(),
    'not_found',
    expect.stringContaining('does not belong'),
    false,
  );
  expect(
    resolveChatAssetSource(
      [{ ...message, hidden: true }],
      portalChatAssetId(message.id, 'attachment', 0),
    ),
  ).toBeUndefined();
});

it('resolves canonical old transcript refs after a replacement pairing, without an active-tab dependency', async () => {
  getState.mockResolvedValue(state([], false));
  getTranscriptPage.mockResolvedValueOnce({
    messages: [],
    before: 5,
    totalMessages: 10,
    transcriptRevision: 9,
  });
  getTranscriptPage.mockResolvedValueOnce({
    messages: [message],
    totalMessages: 10,
    transcriptRevision: 9,
  });
  await handlePortalChatAssetRead(command(), context);
  expect(getTranscriptPage).toHaveBeenNthCalledWith(2, {
    projectId: 'workspace',
    worktreeId: 'worktree',
    chatId: 'chat',
    before: 5,
    transcriptRevision: 9,
  });
  expect(readPortalAssetFile).toHaveBeenCalledWith(
    expect.objectContaining({ path: '/root/árvore.pdf' }),
  );
});

it('rejects missing chats, cross-target requests, and invalid ranges before reading files', async () => {
  const missing = state([message]);
  missing.tabsFile.tabs = [];
  getState.mockResolvedValue(missing);
  await handlePortalChatAssetRead(command(), context);
  expect(fail).toHaveBeenLastCalledWith(
    expect.anything(),
    'not_found',
    expect.any(String),
    false,
  );
  await handlePortalChatAssetRead(
    command({
      projectId: 'other',
      worktreeId: 'worktree',
      chatId: 'chat',
      assetId: 'asset-one',
    }),
    context,
  );
  expect(fail).toHaveBeenLastCalledWith(
    expect.anything(),
    'invalid_target',
    expect.any(String),
    false,
  );
  await handlePortalChatAssetRead(
    command({
      projectId: 'workspace',
      worktreeId: 'worktree',
      chatId: 'chat',
      assetId: 'asset-one',
      offset: '0',
    }),
    context,
  );
  expect(fail).toHaveBeenLastCalledWith(
    expect.anything(),
    'invalid_payload',
    expect.any(String),
    false,
  );
  expect(readPortalAssetFile).not.toHaveBeenCalled();
});

it('resolves standalone chat identity before canonical membership and denies archived targets', async () => {
  jest.mocked(resolveStandaloneChatTarget).mockResolvedValue({
    workspaceId: 'workspace',
    entryId: 'worktree',
    archivedInEntryId: null,
    isArchived: false,
  });
  const request = command({
    scope: 'standalone',
    projectLocalId: 'project',
    chatId: 'chat',
    assetId: portalChatAssetId(message.id, 'attachment', 0),
  });
  request.target = { standaloneChatLocalId: 'chat' };
  await handlePortalChatAssetRead(request, context);
  expect(getState).toHaveBeenCalledWith({
    projectId: 'workspace',
    worktreeId: 'worktree',
  });
  expect(readPortalAssetFile).toHaveBeenCalled();
  jest.mocked(readPortalAssetFile).mockClear();
  jest.mocked(resolveStandaloneChatTarget).mockResolvedValue({
    workspaceId: 'workspace',
    entryId: 'worktree',
    archivedInEntryId: 'worktree',
    isArchived: true,
  });
  await handlePortalChatAssetRead(request, context);
  expect(readPortalAssetFile).not.toHaveBeenCalled();
});

it('rejects mismatched binary file roots and invalid relative targets', async () => {
  await handlePortalFileAssetRead(
    command({
      projectId: 'other',
      worktreeId: 'worktree',
      relativePath: 'file.pdf',
    }),
    context,
  );
  expect(fail).toHaveBeenCalledWith(
    expect.anything(),
    'invalid_target',
    expect.any(String),
    false,
  );
  await handlePortalFileAssetRead(
    command({
      projectId: 'workspace',
      worktreeId: 'worktree',
      relativePath: 4,
    }),
    context,
  );
  expect(fail).toHaveBeenLastCalledWith(
    expect.anything(),
    'invalid_payload',
    expect.any(String),
    false,
  );
  expect(readPortalAssetFile).not.toHaveBeenCalled();
  await handlePortalFileAssetRead(
    {
      ...command({
        projectId: 'workspace',
        worktreeId: 'worktree',
        relativePath: 'file.pdf',
      }),
      target: { standaloneChatLocalId: 'chat' },
    },
    context,
  );
  expect(readPortalAssetFile).not.toHaveBeenCalled();
});

it('identifies generated and delegated raster sources by canonical block indexes', () => {
  const image: PersistedChatMessage = {
    id: 'child-message',
    parentBlockId: 'agent-call',
    role: 'assistant',
    timestamp: 1,
    blocks: [
      { type: 'text', text: 'result' },
      { type: 'image', path: '/root/chart.png', alt: 'chart' },
    ],
  };
  expect(
    resolveChatAssetSource([image], portalChatAssetId(image.id, 'image', 1)),
  ).toEqual({ path: '/root/chart.png', image: true });
  expect(
    resolveChatAssetSource(
      [
        {
          ...image,
          blocks: [
            {
              type: 'image',
              path: '',
              dataUrl: 'data:image/png;base64,AAAA',
              alt: '',
            },
          ],
        },
      ],
      portalChatAssetId(image.id, 'image', 0),
    ),
  ).toEqual({ dataUrl: 'data:image/png;base64,AAAA' });
});

it('rejects absent or revoked pairing consent before any canonical lookup or byte read', async () => {
  const missing = { ...context, canReadAssets: undefined };
  await handlePortalChatAssetRead(command(), missing);
  await handlePortalFileAssetRead(
    command({
      projectId: 'workspace',
      worktreeId: 'worktree',
      relativePath: 'secret.bin',
    }),
    missing,
  );
  await handlePortalChatAssetRead(command(), {
    ...context,
    canReadAssets: () => false,
  });
  expect(getState).not.toHaveBeenCalled();
  expect(resolvePortalChatAssetFileTarget).not.toHaveBeenCalled();
  expect(readPortalAssetFile).not.toHaveBeenCalled();
  expect(readPortalAssetDataUrl).not.toHaveBeenCalled();
  expect(complete).not.toHaveBeenCalled();
});

it('rechecks permission after lookup and after byte transfer instead of emitting stale-session bytes', async () => {
  let authorized = true;
  getState.mockImplementationOnce(() => {
    authorized = false;
    return Promise.resolve(state([message]));
  });
  const revocable = {
    ...context,
    canReadAssets: (): boolean => authorized,
  };
  await handlePortalChatAssetRead(command(), revocable);
  expect(readPortalAssetFile).not.toHaveBeenCalled();
  authorized = true;
  jest.mocked(readPortalAssetFile).mockImplementationOnce(() => {
    authorized = false;
    return Promise.resolve({
      assetId: 'asset',
      filename: 'secret.bin',
      mediaType: 'application/octet-stream',
      version: 'version',
      offset: 0,
      size: 3,
      dataBase64: 'AAAA',
      contentSha256: 'hash',
      nextOffset: null,
    });
  });
  await handlePortalChatAssetRead(command(), revocable);
  expect(complete).not.toHaveBeenCalled();
});

it('rejects assets belonging to another existing chat rather than searching sibling chats', async () => {
  const current = state([]);
  current.tabsFile.tabs.push({
    id: 'other-chat',
    title: 'Other',
    createdAt: '2026-10-01',
    messages: [message],
  });
  getState.mockResolvedValue(current);
  await handlePortalChatAssetRead(command(), context);
  expect(readPortalAssetFile).not.toHaveBeenCalled();
  expect(fail).toHaveBeenCalledWith(
    expect.anything(),
    'not_found',
    expect.stringContaining('does not belong'),
    false,
  );
});

it('reads stable canonical references under a new authorized session and refuses the revoked predecessor', async () => {
  let firstSessionActive = true;
  const previous = {
    ...context,
    canReadAssets: (): boolean => firstSessionActive,
  };
  await handlePortalChatAssetRead(command(), previous);
  firstSessionActive = false;
  jest.mocked(readPortalAssetFile).mockClear();
  await handlePortalChatAssetRead(command(), previous);
  expect(readPortalAssetFile).not.toHaveBeenCalled();
  await handlePortalChatAssetRead(command(), {
    ...context,
    canReadAssets: () => true,
  });
  expect(readPortalAssetFile).toHaveBeenCalledWith(
    expect.objectContaining({ path: '/root/árvore.pdf' }),
  );
});
