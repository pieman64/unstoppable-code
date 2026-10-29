import { browserHandoffs } from '../browser/browser-handoffs';
import {
  recordPresentationTurn,
  clearPresentationTurn,
} from '../canopy-tools/presentation-state';
const mockRequestRendererTool = jest.fn();

jest.mock('../ipc/app-advisor', () => ({
  requestAppAdvisorRendererTool: mockRequestRendererTool,
}));

import {
  mainWindowOnlyToolSurfaces,
  requestShowFiles,
} from '../canopy-tools/show-files-runtime';

const surfaces = mainWindowOnlyToolSurfaces(() => null);

describe('requestShowFiles', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    recordPresentationTurn('project-1/worktree-1/chat-1', 'turn-1', 'user');
  });

  afterEach(() => {
    clearPresentationTurn('project-1/worktree-1/chat-1');
    browserHandoffs.releaseWorktree('project-1', 'worktree-1');
  });

  const input = {
    files: [{ path: 'report.md' }],
    target: { projectId: 'project-1', worktreeId: 'worktree-1' },
    origin: {
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      chatTabId: 'chat-1',
    },
  };

  it('lets explicit user opens bypass automation and handoff restrictions without relying on focusReturnId', async () => {
    recordPresentationTurn(
      'project-1/worktree-1/chat-1',
      'scheduled',
      'automation',
    );
    browserHandoffs.request(
      { ...input.target, browserId: 'browser', origin: input.origin },
      jest.fn(),
    );
    mockRequestRendererTool.mockResolvedValue({
      result: {
        opened: 1,
        failed: 0,
        activated: true,
        files: [{ path: 'report.md', ok: true, opened: true, activated: true }],
      },
    });
    expect(
      await requestShowFiles({ ...input, intent: 'user' }, surfaces),
    ).toMatchObject({ presentation: 'foreground', opened: 1, activated: true });
    expect(mockRequestRendererTool).toHaveBeenCalledTimes(1);
  });

  it('captures policy before asynchronous work and preserves acknowledged background outcomes', async () => {
    const handoff = browserHandoffs.request(
      { ...input.target, browserId: 'browser', origin: input.origin },
      jest.fn(),
    );
    mockRequestRendererTool.mockImplementationOnce(async () => {
      recordPresentationTurn(
        'project-1/worktree-1/chat-1',
        'scheduled-next',
        'automation',
      );
      await Promise.resolve();
      return {
        result: {
          opened: 1,
          failed: 0,
          activated: false,
          presentation: 'background',
          files: [
            { path: 'report.md', ok: true, opened: true, activated: false },
          ],
        },
      };
    });
    expect(await requestShowFiles(input, surfaces)).toMatchObject({
      presentation: 'background',
      reason: 'browser_handoff',
      opened: 1,
      activated: false,
    });
    const payload: unknown = expect.objectContaining({
      presentation: 'background',
      handoffId: handoff.handoffId,
    });
    expect(mockRequestRendererTool).toHaveBeenCalledWith(
      expect.objectContaining({ payload }),
      surfaces,
    );
    expect(await requestShowFiles(input, surfaces)).toMatchObject({
      presentation: 'deferred',
      reason: 'automation_turn',
      opened: 0,
    });
    expect(mockRequestRendererTool).toHaveBeenCalledTimes(1);
  });

  it('does not treat focus-return metadata as user intent', async () => {
    recordPresentationTurn(
      'project-1/worktree-1/chat-1',
      'scheduled',
      'automation',
    );
    expect(
      await requestShowFiles({ ...input, focusReturnId: 'forged' }, surfaces),
    ).toMatchObject({ presentation: 'deferred', opened: 0 });
    expect(mockRequestRendererTool).not.toHaveBeenCalled();
  });

  it.each(['automation', 'hook'] as const)(
    'defers %s files and HTML without a renderer request',
    async (source) => {
      recordPresentationTurn(
        'project-1/worktree-1/chat-1',
        'scheduled-turn',
        source,
      );
      const result = await requestShowFiles(
        {
          files: [{ path: 'state.json' }, { path: 'index.html' }],
          target: { projectId: 'project-1', worktreeId: 'worktree-1' },
          origin: {
            projectId: 'project-1',
            worktreeId: 'worktree-1',
            chatTabId: 'chat-1',
          },
        },
        surfaces,
      );
      expect(result).toMatchObject({
        presentation: 'deferred',
        reason: 'automation_turn',
        opened: 0,
        deferred: 2,
        activated: false,
      });
      expect(mockRequestRendererTool).not.toHaveBeenCalled();
    },
  );

  it('defers an agent request with unavailable turn provenance before contacting the renderer', async () => {
    mockRequestRendererTool.mockResolvedValue({
      result: {
        opened: 1,
        failed: 0,
        files: [{ path: '/workspace/state.json', ok: true }],
      },
    });
    const result = await requestShowFiles(
      {
        files: [{ path: 'state.json' }, { path: 'index.html' }],
        cwd: '/workspace',
        target: {
          projectId: 'unknown-project',
          worktreeId: 'unknown-worktree',
        },
        origin: {
          projectId: 'unknown-project',
          worktreeId: 'unknown-worktree',
          chatTabId: 'unknown-chat',
        },
      },
      surfaces,
    );
    expect(result).toMatchObject({
      opened: 0,
      failed: 0,
      activated: false,
      presentation: 'deferred',
      reason: 'unknown_turn',
    });
    expect(mockRequestRendererTool).not.toHaveBeenCalled();
  });

  it('resolves relative paths from the agent cwd and preserves partial results', async () => {
    mockRequestRendererTool.mockResolvedValue({
      requestId: 'renderer-request',
      ok: true,
      result: {
        opened: 1,
        failed: 1,
        files: [
          { path: '/workspace/README.md', ok: true, tabId: 'file-1' },
          {
            path: '/workspace/archive.zip',
            ok: false,
            error: 'Unsupported file type.',
          },
        ],
      },
    });

    await expect(
      requestShowFiles(
        {
          files: [{ path: 'README.md' }, { path: 'archive.zip' }],
          target: { projectId: 'project-1', worktreeId: 'worktree-1' },
          origin: {
            projectId: 'project-1',
            worktreeId: 'worktree-1',
            chatTabId: 'chat-1',
          },
          cwd: '/workspace',
        },
        surfaces,
      ),
    ).resolves.toMatchObject({ opened: 1, failed: 1 });

    expect(mockRequestRendererTool).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'show_files',
        payload: {
          intent: 'agent',
          presentation: 'foreground',
          files: [
            { path: '/workspace/README.md' },
            { path: '/workspace/archive.zip' },
          ],
          target: { projectId: 'project-1', worktreeId: 'worktree-1' },
          origin: {
            projectId: 'project-1',
            worktreeId: 'worktree-1',
            chatTabId: 'chat-1',
          },
        },
      }),
      surfaces,
    );
  });

  it('reports an HTML page that opened in the browser', async () => {
    mockRequestRendererTool.mockResolvedValue({
      requestId: 'renderer-request',
      ok: true,
      result: {
        opened: 1,
        failed: 0,
        files: [
          {
            path: '/workspace/index.html',
            ok: true,
            absolutePath: '/workspace/index.html',
            openedIn: 'browser',
            browserId: 'browser-page',
          },
        ],
      },
    });

    await expect(
      requestShowFiles(
        {
          files: [{ path: '/workspace/index.html' }],
          target: { projectId: 'project-1', worktreeId: 'worktree-1' },
          origin: {
            projectId: 'project-1',
            worktreeId: 'worktree-1',
            chatTabId: 'chat-1',
          },
        },
        surfaces,
      ),
    ).resolves.toEqual({
      presentation: 'foreground',
      opened: 1,
      failed: 0,
      files: [
        {
          path: '/workspace/index.html',
          ok: true,
          absolutePath: '/workspace/index.html',
          openedIn: 'browser',
          browserId: 'browser-page',
        },
      ],
    });
  });

  it('normalizes absolute paths before dispatching them', async () => {
    mockRequestRendererTool.mockResolvedValue({
      requestId: 'renderer-request',
      ok: true,
      result: {
        opened: 1,
        failed: 0,
        files: [{ path: '/workspace/README.md', ok: true, tabId: 'file-1' }],
      },
    });

    await requestShowFiles(
      {
        files: [{ path: '/workspace/docs/../README.md' }],
        target: { projectId: 'project-1', worktreeId: 'worktree-1' },
        origin: {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          chatTabId: 'chat-1',
        },
      },
      surfaces,
    );

    expect(mockRequestRendererTool).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: {
          intent: 'agent',
          presentation: 'foreground',
          files: [{ path: '/workspace/README.md' }],
          target: { projectId: 'project-1', worktreeId: 'worktree-1' },
          origin: {
            projectId: 'project-1',
            worktreeId: 'worktree-1',
            chatTabId: 'chat-1',
          },
        },
      }),
      surfaces,
    );
  });

  it('keeps per-file rejection details when every file is invalid', async () => {
    mockRequestRendererTool.mockResolvedValue({
      requestId: 'renderer-request',
      ok: false,
      error: { code: 'invalid_target', message: 'No files opened.' },
      result: {
        opened: 0,
        failed: 1,
        files: [
          {
            path: '/workspace/archive.zip',
            ok: false,
            error: 'This file type is not supported by the app for opening.',
          },
        ],
      },
    });

    await expect(
      requestShowFiles(
        {
          files: [{ path: 'archive.zip' }],
          target: { projectId: 'project-1', worktreeId: 'worktree-1' },
          origin: {
            projectId: 'project-1',
            worktreeId: 'worktree-1',
            chatTabId: 'chat-1',
          },
          cwd: '/workspace',
        },
        surfaces,
      ),
    ).resolves.toMatchObject({
      opened: 0,
      files: [
        expect.objectContaining({
          error: 'This file type is not supported by the app for opening.',
        }),
      ],
    });
  });

  it('rejects malformed renderer file results instead of casting them', async () => {
    mockRequestRendererTool.mockResolvedValue({
      requestId: 'renderer-request',
      ok: true,
      result: {
        opened: 1,
        failed: 0,
        files: [{ path: '/workspace/README.md', ok: 'yes' }],
      },
    });

    await expect(
      requestShowFiles(
        {
          files: [{ path: 'README.md' }],
          target: { projectId: 'project-1', worktreeId: 'worktree-1' },
          origin: {
            projectId: 'project-1',
            worktreeId: 'worktree-1',
            chatTabId: 'chat-1',
          },
          cwd: '/workspace',
        },
        surfaces,
      ),
    ).rejects.toThrow('invalid ShowFiles response');
  });
});
