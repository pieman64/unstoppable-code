import type {
  ActivityChangedFilesResponse,
  ChangedFileInfo,
} from '@canopy/desktop-shared/types';
import { useActivityStore } from '@/stores/activityStore';
import { useProjectsStore } from '@/stores/projectsStore';

function file(path: string): ChangedFileInfo {
  return { path, status: 'modified', insertions: 1, deletions: 0 };
}

function response(
  uncommitted: ChangedFileInfo[],
): ActivityChangedFilesResponse {
  return { uncommitted, committed: [] };
}

describe('activityStore.setChangedFiles fast-refresh trigger', () => {
  let fastRefresh: jest.Mock;

  beforeEach(() => {
    useActivityStore.setState({ changedFiles: {} } as never);
    fastRefresh = jest.fn();
    jest
      .spyOn(useProjectsStore, 'getState')
      .mockReturnValue({ fastRefreshWorktreeDiffStats: fastRefresh } as never);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('enqueues when a previously-absent uncommitted file appears', () => {
    useActivityStore
      .getState()
      .setChangedFiles('p', 'w', response([file('a.ts')]));
    expect(fastRefresh).toHaveBeenCalledWith('p', 'w');
  });

  it('does not enqueue when the changed-files response is unchanged', () => {
    useActivityStore
      .getState()
      .setChangedFiles('p', 'w', response([file('a.ts')]));
    fastRefresh.mockClear();
    useActivityStore
      .getState()
      .setChangedFiles('p', 'w', response([file('a.ts')]));
    expect(fastRefresh).not.toHaveBeenCalled();
  });

  it('does not enqueue when files are only removed (no new uncommitted file)', () => {
    useActivityStore
      .getState()
      .setChangedFiles('p', 'w', response([file('a.ts'), file('b.ts')]));
    fastRefresh.mockClear();
    useActivityStore
      .getState()
      .setChangedFiles('p', 'w', response([file('a.ts')]));
    expect(fastRefresh).not.toHaveBeenCalled();
  });
});
