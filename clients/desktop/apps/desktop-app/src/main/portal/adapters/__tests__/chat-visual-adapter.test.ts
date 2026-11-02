const mockQuery = jest.fn();
const mockResolve = jest.fn();
const mockChatState = jest.fn();
const mockStart = jest.fn();
const mockSucceed = jest.fn();
const mockComplete = jest.fn();
const mockFailure = jest.fn();

jest.mock('../../../canopy-runtime/desktop-runtime', () => ({
  getActiveDesktopRuntime: (): { query: typeof mockQuery } => ({
    query: mockQuery,
  }),
}));
jest.mock('../../../services/standalone-chat-service', () => ({
  get resolveStandaloneChatTarget(): typeof mockResolve {
    return mockResolve;
  },
}));
jest.mock('../chat-state-query', () => ({
  get queryPortalChatState(): typeof mockChatState {
    return mockChatState;
  },
}));
jest.mock('@canopy/desktop-instrumentation/electron/main', () => ({
  get startDesktopOperation(): typeof mockStart {
    return mockStart;
  },
  get succeedDesktopOperation(): typeof mockSucceed {
    return mockSucceed;
  },
  failDesktopOperation: jest.fn(),
}));

import type { PortalCommandEnvelope } from '@canopy/desktop-shared/types';
import { PORTAL_CHAT_VISUAL_PAGE_BYTES } from '@canopy/protocol/portal';
import { handlePortalChatVisualRead } from '../chat-visual-adapter';
import type { PortalAdapterContext } from '../types';

const reference = {
  version: 1,
  visualId: 'vis_11111111-1111-4111-8111-111111111111',
  artifactId: 'artifact-1',
  byteLength: 4,
  sha256: 'a'.repeat(64),
  mediaType: 'text/html',
  title: 'Visual',
  maxHeight: 400,
  heights: [[100, 200]],
};
const payload = {
  scope: 'worktree',
  projectId: 'project-1',
  worktreeId: 'worktree-1',
  chatId: 'chat-1',
  messageId: 'message-1',
  toolUseId: 'tool-1',
  reference,
  offset: 0,
  limit: 4,
  read: { id: 'read-1', pageCount: 1 },
};
const command: PortalCommandEnvelope<unknown> = {
  id: 'command-1',
  sequence: 1,
  type: 'portal.chat.visual.read',
  payload,
  createdAt: '2026-10-08T00:00:00.000Z',
  expiresAt: null,
};
const context: PortalAdapterContext = {
  sessionId: 'session-1',
  getWindow: () => null,
  enqueueEvent: jest.fn(),
  complete: mockComplete,
  fail: mockFailure,
};

describe('portal chat visual read adapter', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockChatState.mockResolvedValue({
      archives: [],
      tabsFile: { tabs: [{ id: 'chat-1' }] },
    });
    mockQuery.mockResolvedValue({
      data: '8J+Msg==',
      offset: 0,
      length: 4,
      byteLength: 4,
      sha256: reference.sha256,
    });
  });

  it('queries only the core dispatcher with Portal read authority and completes an inline page', async () => {
    await handlePortalChatVisualRead(command, context);
    expect(mockQuery).toHaveBeenCalledWith(
      'core.chat.visual.read',
      expect.objectContaining({
        scope: {
          workspaceId: 'project-1',
          worktreeId: 'worktree-1',
          chatId: 'chat-1',
        },
        offset: 0,
        limit: 4,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        reference: expect.objectContaining({ heights: [[100, 200]] }),
      }),
      expect.objectContaining({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        caller: expect.objectContaining({
          interfaceKind: 'portal',
          clientInstanceId: 'portal-session:session-1',
          grants: ['core.chat.read'],
        }),
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        signal: expect.any(AbortSignal),
      }),
    );
    expect(mockComplete).toHaveBeenCalledWith(command, {
      kind: 'inline-page',
      data: '8J+Msg==',
      offset: 0,
      length: 4,
      byteLength: 4,
      sha256: reference.sha256,
    });
    expect(mockStart).toHaveBeenCalledTimes(1);
    expect(mockSucceed).toHaveBeenCalledWith(
      'canopy.portal_chat_visual_read',
      expect.objectContaining({
        context: {
          page_count: 1,
          size_bytes: 4,
          transport_type: 'portal_inline',
        },
      }),
    );
  });

  it.each([
    ['oversized limit', { limit: PORTAL_CHAT_VISUAL_PAGE_BYTES + 1 }],
    ['negative offset', { offset: -1 }],
    ['unsafe offset', { offset: Number.MAX_SAFE_INTEGER + 1 }],
    ['past-end offset', { offset: 4 }],
    [
      'invalid visual reference',
      { reference: { ...reference, sha256: 'secret' } },
    ],
    ['invalid read identity', { read: { id: '', pageCount: 1 } }],
    ['invalid page count', { read: { id: 'read-1', pageCount: 0 } }],
    ['App Advisor scope', { projectId: 'app-advisor' }],
    ['Pipeline Editor scope', { projectId: 'pipeline-editor' }],
  ])('rejects %s before core', async (_label, override) => {
    const request = { ...command, payload: { ...payload, ...override } };
    await handlePortalChatVisualRead(request, context);
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockFailure).toHaveBeenCalledWith(
      request,
      'invalid_payload',
      expect.any(String),
    );
  });

  it('reads a chat archived on its own in a live worktree from that worktree', async () => {
    // Its transcript stays in the worktree's own archive file; the archived
    // container store is only for a whole archived worktree.
    mockChatState.mockResolvedValue({
      archives: [{ chatId: 'chat-1' }],
      tabsFile: { tabs: [] },
    });
    await handlePortalChatVisualRead(command, context);
    expect(mockQuery).toHaveBeenCalledWith(
      'core.chat.visual.read',
      expect.objectContaining({
        scope: {
          workspaceId: 'project-1',
          worktreeId: 'worktree-1',
          chatId: 'chat-1',
        },
      }),
      expect.anything(),
    );
    expect(mockQuery).not.toHaveBeenCalledWith(
      'core.chat.visual.read',
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      expect.objectContaining({ archivedContainerId: expect.anything() }),
      expect.anything(),
    );
  });

  it('reads a Cowork chat archived on its own from its live entry', async () => {
    mockResolve.mockResolvedValue({
      workspaceId: 'project-2',
      entryId: null,
      archivedInEntryId: 'entry-2',
      isArchived: true,
    });
    await handlePortalChatVisualRead(
      {
        ...command,
        payload: {
          scope: 'standalone',
          projectLocalId: 'project-2',
          chatId: payload.chatId,
          messageId: payload.messageId,
          toolUseId: payload.toolUseId,
          reference,
          offset: 0,
          limit: 4,
          read: payload.read,
        },
      },
      context,
    );
    expect(mockQuery).toHaveBeenCalledWith(
      'core.chat.visual.read',
      expect.objectContaining({
        scope: {
          workspaceId: 'project-2',
          worktreeId: 'entry-2',
          chatId: 'chat-1',
        },
      }),
      expect.anything(),
    );
    expect(mockQuery).not.toHaveBeenCalledWith(
      'core.chat.visual.read',
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      expect.objectContaining({ archivedContainerId: expect.anything() }),
      expect.anything(),
    );
  });

  it('returns fixed errors instead of forwarding storage paths', async () => {
    mockQuery.mockRejectedValueOnce(new Error('EIO /Users/private/chart.html'));
    await handlePortalChatVisualRead(command, context);
    expect(mockFailure).toHaveBeenCalledWith(
      command,
      'execution_failed',
      'The visual could not be read.',
    );
  });

  it('allows the sole empty visual page with limit one', async () => {
    mockQuery.mockResolvedValueOnce({
      data: '',
      offset: 0,
      length: 0,
      byteLength: 0,
      sha256: reference.sha256,
    });
    const request = {
      ...command,
      payload: {
        ...payload,
        reference: { ...reference, byteLength: 0 },
        limit: 1,
      },
    };
    await handlePortalChatVisualRead(request, context);
    expect(mockComplete).toHaveBeenCalledWith(
      request,
      expect.objectContaining({ length: 0 }),
    );
  });
});
