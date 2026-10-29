/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  ActivityChangedFilesResponse,
  ChangedFileInfo,
} from '@canopy/desktop-shared/types';
import { useActivityStore } from '@/stores/activityStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { useOpenFileDiffTarget } from '../useOpenFileDiffTarget';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function file(path: string): ChangedFileInfo {
  return {
    path,
    status: 'modified',
    insertions: 1,
    deletions: 0,
  };
}

function response(path?: string): ActivityChangedFilesResponse {
  return {
    uncommitted: path ? [file(path)] : [],
    committed: [],
  };
}

function HookHarness(): null {
  useOpenFileDiffTarget('project-1', 'worktree-1', '/work/tree/src/app.ts');
  return null;
}

describe('useOpenFileDiffTarget changed-file refresh', () => {
  let containerA: HTMLDivElement;
  let containerB: HTMLDivElement;
  let rootA: Root;
  let rootB: Root;
  let getChangedFiles: jest.Mock;
  let originalApi: Window['api'] | undefined;

  beforeEach(() => {
    originalApi = window.api;
    getChangedFiles = jest.fn();
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        activity: { getChangedFiles },
        getWorktreePath: jest.fn().mockResolvedValue('/work/tree'),
      } as unknown as Window['api'],
    });
    useActivityStore.setState({ changedFiles: {} });
    useProjectsStore.setState({
      diffStats: {},
      uncommittedChanges: {},
      commitsAhead: {},
    });

    containerA = document.createElement('div');
    containerB = document.createElement('div');
    document.body.appendChild(containerA);
    document.body.appendChild(containerB);
    rootA = createRoot(containerA);
    rootB = createRoot(containerB);
  });

  afterEach(() => {
    act(() => {
      rootA.unmount();
      rootB.unmount();
    });
    containerA.remove();
    containerB.remove();
    jest.useRealTimers();
    if (originalApi === undefined) {
      Reflect.deleteProperty(window, 'api');
    } else {
      Object.defineProperty(window, 'api', {
        configurable: true,
        value: originalApi,
      });
    }
  });

  it('revalidates and replaces a stale cached entry on mount', async () => {
    useActivityStore.setState({
      changedFiles: {
        'project-1/worktree-1': response('src/app.ts'),
      },
    });
    getChangedFiles.mockResolvedValue(response());

    await act(async () => {
      rootA.render(<HookHarness />);
      await Promise.resolve();
    });

    expect(getChangedFiles).toHaveBeenCalledTimes(1);
    expect(
      useActivityStore.getState().changedFiles['project-1/worktree-1'],
    ).toEqual(response());
  });

  it('deduplicates concurrent refreshes for the same worktree', async () => {
    let resolveRequest!: (files: ActivityChangedFilesResponse) => void;
    getChangedFiles.mockReturnValue(
      new Promise<ActivityChangedFilesResponse>((resolve) => {
        resolveRequest = resolve;
      }),
    );

    act(() => {
      rootA.render(<HookHarness />);
      rootB.render(<HookHarness />);
    });

    expect(getChangedFiles).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveRequest(response('src/app.ts'));
      await Promise.resolve();
    });

    expect(
      useActivityStore.getState().changedFiles['project-1/worktree-1'],
    ).toEqual(response('src/app.ts'));
  });

  it('retries a failed refresh while retaining the cached entry', async () => {
    jest.useFakeTimers();
    const cached = response('src/app.ts');
    useActivityStore.setState({
      changedFiles: { 'project-1/worktree-1': cached },
    });
    getChangedFiles
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce(response());

    await act(async () => {
      rootA.render(<HookHarness />);
      await Promise.resolve();
    });

    expect(
      useActivityStore.getState().changedFiles['project-1/worktree-1'],
    ).toBe(cached);

    await act(async () => {
      await jest.advanceTimersByTimeAsync(1_000);
    });

    expect(getChangedFiles).toHaveBeenCalledTimes(2);
    expect(
      useActivityStore.getState().changedFiles['project-1/worktree-1'],
    ).toEqual(response());
  });
});
