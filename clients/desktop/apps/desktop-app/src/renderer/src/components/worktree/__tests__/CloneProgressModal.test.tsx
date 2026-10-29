/** @jest-environment jsdom */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CloneJobSnapshot } from '@canopy/desktop-shared/types';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { useCloneJobsStore } from '@/stores/cloneJobsStore';
import { makeCloneJob } from '@/test-utils/cloneJobs';
import { resetAnnouncedCloneOutcomesForTests } from '@/lib/cloneJobOutcomes';
import { CloneProgressModal } from '../CloneProgressModal';

jest.mock('@/hooks/useCurrentUiStateReporter', () => ({
  useCurrentUiStateReporter: jest.fn(),
}));

const mockLoadProjects = jest.fn(() => Promise.resolve());
jest.mock('@/stores/projectsStore', () => ({
  useProjectsStore: {
    getState: (): { loadProjects: () => Promise<void> } => ({
      loadProjects: mockLoadProjects,
    }),
  },
}));

const mockAddToast = jest.fn<void, [string, string, ...unknown[]]>();
jest.mock('@/stores/githubStore', () => ({
  useGitHubStore: {
    getState: (): { addToast: typeof mockAddToast } => ({
      addToast: mockAddToast,
    }),
  },
}));

const reporter = jest.mocked(useCurrentUiStateReporter);

describe('CloneProgressModal', () => {
  let container: HTMLDivElement;
  let root: Root;
  let emit: (jobs: CloneJobSnapshot[]) => void;
  let api: {
    listCloneJobs: jest.Mock;
    cancelCloneJob: jest.Mock;
    dismissCloneJob: jest.Mock;
    onCloneJobsChanged: jest.Mock;
  };

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    reporter.mockClear();
    resetAnnouncedCloneOutcomesForTests();
    mockLoadProjects.mockClear();
    mockAddToast.mockClear();
    emit = (): void => undefined;
    useCloneJobsStore.setState({ jobs: [], received: false, isOpen: false });
    api = {
      listCloneJobs: jest.fn().mockResolvedValue([]),
      cancelCloneJob: jest.fn().mockResolvedValue(undefined),
      dismissCloneJob: jest.fn().mockResolvedValue(undefined),
      onCloneJobsChanged: jest.fn((listener: typeof emit) => {
        emit = listener;
        return jest.fn();
      }),
    };
    Object.defineProperty(window, 'api', { configurable: true, value: api });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function render(): Promise<void> {
    await act(async () => {
      root.render(createElement(CloneProgressModal));
      await Promise.resolve();
    });
  }

  async function broadcast(jobs: CloneJobSnapshot[]): Promise<void> {
    await act(async () => {
      emit(jobs);
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  function byTestId(id: string): HTMLElement | null {
    return document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  }

  it('shows what the clone is doing and where it is going', async () => {
    await render();
    await broadcast([makeCloneJob()]);
    act(() => useCloneJobsStore.getState().open());

    const row = byTestId('clone-progress-job-job-1');
    expect(row?.textContent).toContain('Cloning big-repo');
    expect(row?.textContent).toContain('42%');
    expect(row?.textContent).toContain('Receiving objects');
    expect(row?.textContent).toContain('1,234 of 5,678');
    expect(row?.textContent).toContain('12.34 MiB at 3.21 MiB/s');
    expect(row?.textContent).toContain('https://github.com/org/big-repo.git');
    expect(row?.textContent).toContain('/Users/me/repos/big-repo');
    expect(document.body.textContent).toContain(
      'Cloning continues in the background.',
    );
    expect(reporter).toHaveBeenLastCalledWith('projects.cloneProgressModal', {
      open: true,
      running: 1,
      failed: 0,
      percent: 42,
    });
  });

  it('cancels a running clone', async () => {
    await render();
    await broadcast([makeCloneJob()]);
    act(() => useCloneJobsStore.getState().open());

    await act(async () => {
      byTestId('clone-progress-cancel-job-1')?.click();
      await Promise.resolve();
    });
    expect(api.cancelCloneJob).toHaveBeenCalledWith('job-1');
  });

  it('offers no cancel once the project is being added', async () => {
    await render();
    await broadcast([
      makeCloneJob({ phase: 'finishing', cancellable: false, percent: 99 }),
    ]);
    act(() => useCloneJobsStore.getState().open());

    expect(byTestId('clone-progress-cancel-job-1')).toBeNull();
    expect(byTestId('clone-progress-job-job-1')?.textContent).toContain(
      'Adding big-repo…',
    );
  });

  it('explains a failure once and lets it be dismissed', async () => {
    await render();
    const failed = makeCloneJob({
      status: 'failed',
      cancellable: false,
      error:
        'Failed to clone the repository. Check the URL and access, then try again.',
    });
    await broadcast([failed]);
    await broadcast([failed]);
    expect(mockAddToast).toHaveBeenCalledTimes(1);
    expect(mockAddToast.mock.calls[0]?.[0]).toBe("Couldn't clone big-repo.");
    expect(mockAddToast.mock.calls[0]?.[1]).toBe('error');

    act(() => useCloneJobsStore.getState().open());
    expect(
      byTestId('clone-progress-job-job-1')?.querySelectorAll('[role="alert"]'),
    ).toHaveLength(1);
    expect(byTestId('clone-progress-job-job-1')?.textContent).toContain(
      'Failed to clone the repository. Check the URL and access, then try again.',
    );
    expect(document.body.textContent).not.toContain(
      'Cloning continues in the background.',
    );
    // A failure keeps its error and recovery details until the user is done
    // with them: nothing dismisses it automatically.
    expect(api.dismissCloneJob).not.toHaveBeenCalled();
    await act(async () => {
      byTestId('clone-progress-dismiss-job-1')?.click();
      await Promise.resolve();
    });
    expect(api.dismissCloneJob).toHaveBeenCalledTimes(1);
    expect(api.dismissCloneJob).toHaveBeenCalledWith('job-1');
  });

  it.each([
    'This change was saved but did not finish and needs recovery.',
    'This request was saved but did not finish and needs recovery.',
    'An earlier attempt of this request was interrupted and needs recovery.',
  ])(
    'preserves a background publication recovery message: %s',
    async (message) => {
      await render();
      await broadcast([
        makeCloneJob({
          status: 'failed',
          phase: 'finishing',
          cancellable: false,
          error: message,
        }),
      ]);
      act(() => useCloneJobsStore.getState().open());
      const alert = byTestId('clone-progress-job-job-1')?.querySelector(
        '[role="alert"]',
      );
      expect(alert?.textContent).toBe(message);
      expect(alert?.closest(`.${POSTHOG_REPLAY_BLOCK_CLASS}`)).not.toBeNull();
      expect(api.dismissCloneJob).not.toHaveBeenCalled();
    },
  );

  it('uses safe ordinary failure copy and keeps sensitive cleanup guidance out of replay', async () => {
    await render();
    await broadcast([
      makeCloneJob({
        status: 'failed',
        cancellable: false,
        error: 'fatal: private credentials',
      }),
    ]);
    act(() => useCloneJobsStore.getState().open());
    const row = byTestId('clone-progress-job-job-1');
    expect(row?.textContent).toContain(
      'Failed to clone the repository. Check the URL and access, then try again.',
    );
    expect(row?.textContent).not.toContain('private credentials');
    const alert = row?.querySelector('[role="alert"]');
    expect(alert?.closest(`.${POSTHOG_REPLAY_BLOCK_CLASS}`)).not.toBeNull();
    expect(
      row
        ?.closest('[role="dialog"]')
        ?.closest(`.${POSTHOG_REPLAY_BLOCK_CLASS}`),
    ).toBeNull();
    expect(row?.textContent).not.toContain('Check the URL and your access');
  });

  it('shows manual removal guidance when clone cleanup fails', async () => {
    await render();
    await broadcast([
      makeCloneJob({
        status: 'failed',
        background: true,
        cancellable: false,
        error:
          "Couldn't remove the incomplete clone at /repos/big-repo: permission denied. Remove it manually.",
      }),
    ]);
    act(() => useCloneJobsStore.getState().open());
    const text = byTestId('clone-progress-job-job-1')?.textContent;
    expect(text).toContain('Remove it manually.');
    expect(text).not.toContain('Check the URL and your access');
  });

  describe('when Cancel stops the clone but its checkout cannot be removed', () => {
    const cleanupFailed = makeCloneJob({
      status: 'failed',
      cancellable: false,
      throughput: null,
      error:
        "Couldn't remove the incomplete clone at /Users/me/repos/big-repo. Remove it manually.",
    });
    const cancelling = makeCloneJob({
      status: 'cancelling',
      cancellable: false,
      throughput: null,
    });

    function deferCancel(): () => void {
      let resolveCancel: () => void = () => undefined;
      api.cancelCloneJob.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            resolveCancel = resolve;
          }),
      );
      return () => resolveCancel();
    }

    async function clickCancel(): Promise<void> {
      await act(async () => {
        byTestId('clone-progress-cancel-job-1')?.click();
        await Promise.resolve();
      });
    }

    async function settleCancel(resolveCancel: () => void): Promise<void> {
      await act(async () => {
        resolveCancel();
        await Promise.resolve();
        await Promise.resolve();
      });
    }

    function expectManualRemovalWithoutCancelError(): void {
      const row = byTestId('clone-progress-job-job-1');
      expect(row?.textContent).toContain('Remove it manually.');
      expect(row?.textContent).toContain('/Users/me/repos/big-repo');
      expect(row?.textContent).not.toContain(
        "Couldn't cancel the clone. Try again.",
      );
      const dismiss = document.querySelector<HTMLButtonElement>(
        '[data-testid="clone-progress-dismiss-job-1"]',
      );
      expect(dismiss?.disabled).toBe(false);
    }

    it('shows only the cleanup failure when its snapshot arrives before Cancel settles', async () => {
      const resolveCancel = deferCancel();
      await render();
      await broadcast([makeCloneJob()]);
      act(() => useCloneJobsStore.getState().open());

      await clickCancel();
      await broadcast([cancelling]);
      await broadcast([cleanupFailed]);
      await settleCancel(resolveCancel);

      expectManualRemovalWithoutCancelError();
    });

    it('shows only the cleanup failure when its snapshot arrives after Cancel settles', async () => {
      const resolveCancel = deferCancel();
      await render();
      await broadcast([makeCloneJob()]);
      act(() => useCloneJobsStore.getState().open());

      await clickCancel();
      await broadcast([cancelling]);
      await settleCancel(resolveCancel);
      expect(byTestId('clone-progress-job-job-1')?.textContent).not.toContain(
        "Couldn't cancel the clone. Try again.",
      );
      await broadcast([cleanupFailed]);

      expectManualRemovalWithoutCancelError();
    });
  });

  it('asks to try again when Cancel itself fails', async () => {
    api.cancelCloneJob.mockRejectedValueOnce(new Error('ipc unavailable'));
    await render();
    await broadcast([makeCloneJob()]);
    act(() => useCloneJobsStore.getState().open());

    await act(async () => {
      byTestId('clone-progress-cancel-job-1')?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    const row = byTestId('clone-progress-job-job-1');
    expect(row?.querySelector('[role="alert"]')?.textContent).toBe(
      "Couldn't cancel the clone. Try again.",
    );
    const cancel = document.querySelector<HTMLButtonElement>(
      '[data-testid="clone-progress-cancel-job-1"]',
    );
    expect(cancel?.disabled).toBe(false);
    expect(cancel?.textContent).toBe('Cancel clone');
  });

  function finishedJob(
    overrides: Partial<CloneJobSnapshot> = {},
  ): CloneJobSnapshot {
    return makeCloneJob({
      status: 'succeeded',
      percent: 100,
      cancellable: false,
      workspaceId: 'big-repo',
      workspaceName: 'big-repo',
      ...overrides,
    });
  }

  it('adds a finished background clone to the sidebar and dismisses it exactly once', async () => {
    await render();
    const done = finishedJob();
    await broadcast([done]);
    await broadcast([done]);

    expect(mockLoadProjects).toHaveBeenCalledTimes(1);
    expect(mockAddToast).toHaveBeenCalledTimes(1);
    expect(mockAddToast.mock.calls[0]?.[0]).toBe('Added big-repo.');
    expect(mockAddToast.mock.calls[0]?.[1]).toBe('success');
    expect(api.dismissCloneJob).toHaveBeenCalledTimes(1);
    expect(api.dismissCloneJob).toHaveBeenCalledWith('job-1');
    // The job leaves the sidebar only once its completion toast exists.
    expect(api.dismissCloneJob.mock.invocationCallOrder[0]).toBeGreaterThan(
      mockAddToast.mock.invocationCallOrder[0] ?? Infinity,
    );
  });

  it('keeps a finished clone dismissible by hand when automatic dismissal fails', async () => {
    api.dismissCloneJob.mockRejectedValueOnce(new Error('ipc unavailable'));
    await render();
    const done = finishedJob();
    await broadcast([done]);
    await broadcast([done]);
    // Jest fails a test whose run sees an unhandled rejection, and Node only
    // reports one after the microtask queue drains. Yielding a macrotask here
    // is what makes an uncaught automatic dismissal fail this test.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // The failed attempt neither retries nor disturbs the confirmation.
    expect(api.dismissCloneJob).toHaveBeenCalledTimes(1);
    expect(mockAddToast).toHaveBeenCalledTimes(1);
    expect(mockAddToast.mock.calls[0]?.[0]).toBe('Added big-repo.');
    expect(mockAddToast.mock.calls[0]?.[1]).toBe('success');

    act(() => useCloneJobsStore.getState().open());
    const row = byTestId('clone-progress-job-job-1');
    expect(row?.textContent).toContain('Added big-repo');
    expect(row?.textContent).toContain('Project added.');
    const dismiss = document.querySelector<HTMLButtonElement>(
      '[data-testid="clone-progress-dismiss-job-1"]',
    );
    expect(dismiss?.textContent).toBe('Dismiss');
    expect(dismiss?.disabled).toBe(false);

    await act(async () => {
      dismiss?.click();
      await Promise.resolve();
    });
    expect(api.dismissCloneJob).toHaveBeenCalledTimes(2);
    expect(api.dismissCloneJob).toHaveBeenLastCalledWith('job-1');
    expect(row?.textContent).not.toContain("Couldn't dismiss this clone.");
  });

  it.each([
    ['running', makeCloneJob({ id: 'job-2', repoName: 'other' })],
    [
      'failed',
      makeCloneJob({
        id: 'job-2',
        repoName: 'other',
        status: 'failed',
        cancellable: false,
        error: 'fatal: repository not found',
      }),
    ],
  ])(
    'keeps a %s clone in the dialog when a finished one is removed',
    async (_status, remaining) => {
      await render();
      await broadcast([finishedJob(), remaining]);
      act(() => useCloneJobsStore.getState().open());
      expect(api.dismissCloneJob).toHaveBeenCalledTimes(1);
      expect(api.dismissCloneJob).toHaveBeenCalledWith('job-1');

      // Main removes the dismissed job and broadcasts what is left.
      await broadcast([remaining]);
      expect(useCloneJobsStore.getState().jobs).toEqual([remaining]);
      expect(useCloneJobsStore.getState().isOpen).toBe(true);
      expect(byTestId('clone-progress-modal')).not.toBeNull();
      expect(byTestId('clone-progress-job-job-1')).toBeNull();
      expect(byTestId('clone-progress-job-job-2')).not.toBeNull();
      expect(api.dismissCloneJob).toHaveBeenCalledTimes(1);
    },
  );

  it('closes the open dialog when its last clone finishes and is removed', async () => {
    await render();
    await broadcast([makeCloneJob()]);
    act(() => useCloneJobsStore.getState().open());
    expect(byTestId('clone-progress-modal')).not.toBeNull();

    await broadcast([finishedJob()]);
    expect(api.dismissCloneJob).toHaveBeenCalledWith('job-1');

    await broadcast([]);
    expect(useCloneJobsStore.getState().jobs).toEqual([]);
    expect(useCloneJobsStore.getState().isOpen).toBe(false);
    expect(byTestId('clone-progress-modal')).toBeNull();
  });

  it('ignores clones the Add project dialog still owns', async () => {
    await render();
    await broadcast([
      makeCloneJob({
        background: false,
        status: 'succeeded',
        workspaceName: 'big-repo',
      }),
    ]);
    expect(mockLoadProjects).not.toHaveBeenCalled();
    expect(mockAddToast).not.toHaveBeenCalled();
  });

  it('closes itself when the last clone goes away', async () => {
    await render();
    await broadcast([makeCloneJob()]);
    act(() => useCloneJobsStore.getState().open());
    expect(byTestId('clone-progress-modal')).not.toBeNull();

    await broadcast([]);
    expect(byTestId('clone-progress-modal')).toBeNull();
    expect(useCloneJobsStore.getState().isOpen).toBe(false);
  });
});
