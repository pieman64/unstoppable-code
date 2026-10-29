/**
 * @jest-environment jsdom
 */
import { shareSessionAction } from '@/lib/shareSessionAction';
import { useShareSessionStatusStore } from '@/stores/shareSessionStatusStore';

const flushScope = jest.fn().mockResolvedValue(undefined);

const target = {
  projectId: 'project-1',
  worktreeId: 'worktree-1',
  chatId: 'chat-1',
};

describe('shareSessionAction', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { chat: { flushScope } },
    });
    useShareSessionStatusStore.setState({
      target: null,
      ownerDocument: null,
      status: null,
      operationId: 0,
    });
  });

  it('shows progress immediately and retains the completed private export', async () => {
    let completeExport: (value: {
      exportId: string;
      title: string;
      sizeBytes: number;
      warnings: string[];
    }) => void = () => {};
    const exportSession = jest.fn(
      () =>
        new Promise<{
          exportId: string;
          title: string;
          sizeBytes: number;
          warnings: string[];
        }>((resolve) => {
          completeExport = resolve;
        }),
    );
    const action = shareSessionAction(target, {
      ownerDocument: document,
      exportSession,
    });
    expect(useShareSessionStatusStore.getState()).toMatchObject({
      target,
      ownerDocument: document,
      status: { phase: 'sharing' },
    });
    expect(flushScope).toHaveBeenCalledWith({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
    });
    await Promise.resolve();

    completeExport({
      exportId: 'export-1',
      title: 'Portable session',
      sizeBytes: 2048,
      warnings: [],
    });
    await action;
    expect(exportSession).toHaveBeenCalledWith(target);
    expect(useShareSessionStatusStore.getState().status).toMatchObject({
      phase: 'success',
      response: { exportId: 'export-1' },
    });
  });

  it('keeps failures visible in the status UI', async () => {
    const exportSession = jest
      .fn()
      .mockRejectedValue(new Error('Upload failed'));

    await shareSessionAction(target, { exportSession });
    expect(useShareSessionStatusStore.getState().status).toEqual({
      phase: 'error',
      message: 'Upload failed',
    });
  });
});
