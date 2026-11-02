import type {
  AppAdvisorRendererToolRequest,
  AppAdvisorRendererToolResponse,
} from '@canopy/desktop-shared/types';

const mockRequestAppAdvisorRendererTool = jest.fn<
  Promise<AppAdvisorRendererToolResponse>,
  [AppAdvisorRendererToolRequest, unknown, { signal?: AbortSignal }?]
>();

jest.mock('../ipc/app-advisor', () => ({
  get requestAppAdvisorRendererTool(): typeof mockRequestAppAdvisorRendererTool {
    return mockRequestAppAdvisorRendererTool;
  },
}));

import { setCurrentWorktreeBaseBranch } from '../canopy-tools/set-base-branch-runtime';

describe('setCurrentWorktreeBaseBranch', () => {
  beforeEach(() => {
    mockRequestAppAdvisorRendererTool.mockReset();
  });

  it('injects the current worktree target into the canonical renderer action', async () => {
    const response = {
      requestId: 'tool-call-1',
      ok: true,
      result: { baseBranch: 'release/next' },
    };
    mockRequestAppAdvisorRendererTool.mockResolvedValue(response);
    const getWindow = jest.fn(() => null);

    await expect(
      setCurrentWorktreeBaseBranch(
        { baseBranch: 'release/next', repoId: 'repo-a' },
        {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          chatId: 'chat-1',
          cwd: '/repo',
          getWindow,
        },
        { toolUseId: 'tool-call-1' },
      ),
    ).resolves.toBe(response);

    const rendererRequest =
      mockRequestAppAdvisorRendererTool.mock.calls[0]?.[0];
    expect(typeof rendererRequest?.requestId).toBe('string');
    expect(rendererRequest).toEqual({
      kind: 'dispatch_action',
      requestId: rendererRequest?.requestId,
      action: {
        type: 'worktree.set_base_branch',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        repoId: 'repo-a',
        baseBranch: 'release/next',
      },
      originWorktreeId: 'worktree-1',
      originChatTabId: 'chat-1',
    });
    expect(mockRequestAppAdvisorRendererTool).toHaveBeenCalledWith(
      rendererRequest,
      expect.objectContaining({ getMainWindow: getWindow }),
      undefined,
    );
    expect(rendererRequest?.requestId).not.toBe('tool-call-1');
  });

  it('generates a distinct renderer request id when a transport id is reused', async () => {
    mockRequestAppAdvisorRendererTool.mockResolvedValue({
      requestId: 'renderer-response',
      ok: true,
      result: { baseBranch: 'release/next' },
    });
    const runtime = {
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
      cwd: '/repo',
      getWindow: jest.fn(() => null),
    };

    await setCurrentWorktreeBaseBranch(
      { baseBranch: 'release/next' },
      runtime,
      { toolUseId: 'reused-transport-id' },
    );
    await setCurrentWorktreeBaseBranch(
      { baseBranch: 'release/next' },
      runtime,
      { toolUseId: 'reused-transport-id' },
    );

    const firstRequestId =
      mockRequestAppAdvisorRendererTool.mock.calls[0]?.[0].requestId;
    const secondRequestId =
      mockRequestAppAdvisorRendererTool.mock.calls[1]?.[0].requestId;
    expect(firstRequestId).not.toBe('reused-transport-id');
    expect(secondRequestId).not.toBe('reused-transport-id');
    expect(firstRequestId).not.toBe(secondRequestId);
  });
});
