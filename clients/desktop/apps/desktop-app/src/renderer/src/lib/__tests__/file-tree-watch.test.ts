/**
 * Refcounted shared file-tree watch (multi-instance explorer surfaces).
 * Main keys watches per sender+worktree without refcounting, so the renderer
 * wrapper must issue exactly one start for N consumers and one stop when the
 * last consumer releases.
 */
import {
  acquireFileTreeWatch,
  releaseFileTreeWatch,
  resetFileTreeWatchRefcountForTests,
} from '../file-tree-watch';

const startMock = jest.fn<Promise<void>, [unknown]>();
const stopMock = jest.fn<Promise<void>, [unknown]>();

beforeEach(() => {
  resetFileTreeWatchRefcountForTests();
  startMock.mockReset();
  startMock.mockResolvedValue(undefined);
  stopMock.mockReset();
  stopMock.mockResolvedValue(undefined);
  Object.defineProperty(global, 'window', {
    configurable: true,
    value: {
      api: {
        startFileTreeWatch: startMock,
        stopFileTreeWatch: stopMock,
      },
    },
  });
});

describe('acquireFileTreeWatch / releaseFileTreeWatch', () => {
  it('issues one start for concurrent consumers and stops with the last release', async () => {
    await acquireFileTreeWatch('project', 'worktree');
    await acquireFileTreeWatch('project', 'worktree');
    expect(startMock).toHaveBeenCalledTimes(1);
    expect(startMock).toHaveBeenCalledWith({
      projectId: 'project',
      worktreeId: 'worktree',
    });

    releaseFileTreeWatch('project', 'worktree');
    expect(stopMock).not.toHaveBeenCalled();

    releaseFileTreeWatch('project', 'worktree');
    expect(stopMock).toHaveBeenCalledTimes(1);
    expect(stopMock).toHaveBeenCalledWith({
      projectId: 'project',
      worktreeId: 'worktree',
    });
  });

  it('keeps distinct worktrees independent', async () => {
    await acquireFileTreeWatch('project', 'worktree-a');
    await acquireFileTreeWatch('project', 'worktree-b');
    expect(startMock).toHaveBeenCalledTimes(2);

    releaseFileTreeWatch('project', 'worktree-a');
    expect(stopMock).toHaveBeenCalledTimes(1);
    expect(stopMock).toHaveBeenCalledWith({
      projectId: 'project',
      worktreeId: 'worktree-a',
    });
  });

  it('restarts after a full release cycle', async () => {
    await acquireFileTreeWatch('project', 'worktree');
    releaseFileTreeWatch('project', 'worktree');
    await acquireFileTreeWatch('project', 'worktree');
    expect(startMock).toHaveBeenCalledTimes(2);
  });

  it('a failed start keeps acquire/release pairing balanced', async () => {
    startMock.mockRejectedValueOnce(new Error('nope'));
    await expect(acquireFileTreeWatch('project', 'worktree')).rejects.toThrow(
      'nope',
    );
    // The consumer still holds its count; releasing issues the (no-op) stop.
    releaseFileTreeWatch('project', 'worktree');
    expect(stopMock).toHaveBeenCalledTimes(1);
  });
});
