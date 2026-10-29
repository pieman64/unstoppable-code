import type { AppAdvisorRendererToolSurfaces } from '../ipc/app-advisor';
import type {
  AppAdvisorRendererToolRequest,
  AppAdvisorRendererToolResponse,
} from '@canopy/desktop-shared/types';
const mockRequest = jest.fn<
  Promise<AppAdvisorRendererToolResponse>,
  [AppAdvisorRendererToolRequest, AppAdvisorRendererToolSurfaces]
>();
jest.mock('../ipc/app-advisor', () => ({
  requestAppAdvisorRendererTool: mockRequest,
}));
import { openShareDialog } from '../canopy-tools/sharing-runtime';
const runtime = {
  projectId: 'project',
  worktreeId: 'worktree',
  chatId: 'chat',
  cwd: '/repo',
  getWindow: (): null => null,
};
beforeEach(() => {
  mockRequest.mockReset();
});
describe('share dialog agent bridge', () => {
  it('routes valid targets to the main window with originating chat ids and a truthful result', async () => {
    mockRequest.mockResolvedValue({
      requestId: 'response',
      ok: true,
      result: { ignored: true },
    });
    const action = {
      type: 'sharing.open_dialog' as const,
      target: { kind: 'skill' as const, name: 'test' },
    };
    const result = await openShareDialog(action, runtime);
    expect(result.result).toEqual({
      message: 'Share dialog requested; the user confirms in the app.',
    });
    expect(mockRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'dispatch_action',
        action,
        originWorktreeId: 'worktree',
        originChatTabId: 'chat',
      }),
      expect.objectContaining({ getMainWindow: runtime.getWindow }),
    );
    const surfaces = mockRequest.mock.calls[0]?.[1];
    expect(surfaces?.getAppAdvisorWindow()).toBeNull();
  });
  it.each([
    {
      kind: 'pipeline' as const,
      source: 'stored' as const,
      pipelineId: 'saved',
    },
    {
      kind: 'pipeline' as const,
      source: 'project' as const,
      pipelineId: 'project--ci.yaml',
      projectId: 'project',
      worktreeId: 'worktree',
      relativePath: '.canopy/pipelines/ci.yaml',
    },
  ])(
    'forwards the exact pipeline locator to the gated dialog %p',
    async (target) => {
      mockRequest.mockResolvedValue({ requestId: 'reply', ok: true });
      const result = await openShareDialog(
        { type: 'sharing.open_dialog', target },
        runtime,
      );
      expect(result.ok).toBe(true);
      expect(mockRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          action: { type: 'sharing.open_dialog', target },
        }),
        expect.anything(),
      );
      expect(result.result).toEqual({
        message: 'Share dialog requested; the user confirms in the app.',
      });
    },
  );
  it('returns invalid_target for incomplete targets and preserves renderer failures', async () => {
    expect(
      (
        await openShareDialog(
          { type: 'sharing.open_dialog', target: { kind: 'skill', name: '' } },
          runtime,
        )
      ).error?.code,
    ).toBe('invalid_target');
    expect(mockRequest).not.toHaveBeenCalled();
    mockRequest.mockResolvedValue({
      requestId: 'response',
      ok: false,
      error: { code: 'invalid_target', message: 'No installed target' },
    });
    expect(
      (
        await openShareDialog(
          {
            type: 'sharing.open_dialog',
            target: { kind: 'plugin', marketplaceId: 'm', pluginName: 'p' },
          },
          runtime,
        )
      ).error?.code,
    ).toBe('invalid_target');
    mockRequest.mockRejectedValueOnce(new Error('private info'));
    const result = await openShareDialog(
      { type: 'sharing.open_dialog', target: { kind: 'skill', name: 'test' } },
      runtime,
    );
    expect(result.error?.code).toBe('execution_failed');
    expect(result.error?.message).not.toContain('private');
  });
});
