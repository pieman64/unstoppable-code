import type { ActivityChangedFilesResponse } from '@canopy/desktop-shared/types';

import {
  registerLoadedChangedFilesRefresh,
  requestChangedFilesRefresh,
  requestLoadedChangedFilesRefresh,
} from '../changedFilesRefreshRuntime';

function deferred(): {
  promise: Promise<ActivityChangedFilesResponse | undefined>;
  resolve: () => void;
} {
  let resolvePromise:
    | ((value: ActivityChangedFilesResponse | undefined) => void)
    | undefined;
  const promise = new Promise<ActivityChangedFilesResponse | undefined>(
    (resolve) => {
      resolvePromise = resolve;
    },
  );
  if (!resolvePromise) {
    throw new Error('Failed to create deferred promise');
  }
  return { promise, resolve: () => resolvePromise(undefined) };
}

describe('changedFilesRefreshRuntime', () => {
  afterEach(() => {
    registerLoadedChangedFilesRefresh(() => Promise.resolve(undefined));
  });

  it('serializes a slow worktree refresh and runs one trailing refresh', async () => {
    const firstRefresh = deferred();
    const refresh = jest
      .fn<
        Promise<ActivityChangedFilesResponse | undefined>,
        [string, string, { onlyIfLoaded: boolean }]
      >()
      .mockReturnValueOnce(firstRefresh.promise)
      .mockResolvedValue(undefined);
    registerLoadedChangedFilesRefresh(refresh);

    const firstRequest = requestLoadedChangedFilesRefresh('project-1', 'wt-1');
    const secondRequest = requestLoadedChangedFilesRefresh('project-1', 'wt-1');
    const thirdRequest = requestLoadedChangedFilesRefresh('project-1', 'wt-1');

    expect(refresh).toHaveBeenCalledTimes(1);

    firstRefresh.resolve();
    await Promise.all([firstRequest, secondRequest, thirdRequest]);

    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('allows different worktrees to refresh concurrently', async () => {
    const refresh = jest.fn().mockResolvedValue(undefined);
    registerLoadedChangedFilesRefresh(refresh);

    await Promise.all([
      requestLoadedChangedFilesRefresh('project-1', 'wt-1'),
      requestLoadedChangedFilesRefresh('project-1', 'wt-2'),
    ]);

    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('upgrades a trailing loaded-only refresh when hydration is required', async () => {
    const firstRefresh = deferred();
    const refresh = jest
      .fn()
      .mockReturnValueOnce(firstRefresh.promise)
      .mockResolvedValue(undefined);
    registerLoadedChangedFilesRefresh(refresh);

    const loadedRequest = requestLoadedChangedFilesRefresh('project-1', 'wt-1');
    const hydrationRequest = requestChangedFilesRefresh('project-1', 'wt-1');

    expect(refresh).toHaveBeenNthCalledWith(1, 'project-1', 'wt-1', {
      onlyIfLoaded: true,
    });
    firstRefresh.resolve();
    await Promise.all([loadedRequest, hydrationRequest]);

    expect(refresh).toHaveBeenNthCalledWith(2, 'project-1', 'wt-1', {
      onlyIfLoaded: false,
    });
  });
});
