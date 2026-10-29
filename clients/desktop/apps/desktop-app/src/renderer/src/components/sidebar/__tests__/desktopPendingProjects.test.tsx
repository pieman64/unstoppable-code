/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CloneJobSnapshot } from '@canopy/desktop-shared/types';
import type { SidebarPendingProject } from '@canopy/ui-app';
import { useCloneJobsStore } from '@/stores/cloneJobsStore';
import { useNavigationStore } from '@/stores/navigationStore';
import {
  pendingProjectsFromCloneJobs,
  useDesktopPendingProjects,
  type DesktopPendingProjectActions,
} from '../desktopPendingProjects';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

function job(overrides: Partial<CloneJobSnapshot> = {}): CloneJobSnapshot {
  return {
    id: 'job-1',
    repoName: 'website',
    remoteUrl: 'https://github.com/acme/website.git',
    destinationPath: '/Users/someone/repos/website',
    status: 'running',
    phase: 'receiving',
    phasePercent: 10,
    percent: 10,
    processedCount: null,
    totalCount: null,
    received: null,
    throughput: null,
    startedAt: 1,
    background: true,
    cancellable: true,
    workspaceId: null,
    workspaceName: null,
    error: null,
    ...overrides,
  };
}

const actions: DesktopPendingProjectActions = {
  onRetry: jest.fn(),
  onDismiss: jest.fn(),
};

describe('pendingProjectsFromCloneJobs', () => {
  it('maps a running background clone to a cloning row with no actions', () => {
    expect(pendingProjectsFromCloneJobs([job()], actions)).toEqual([
      { id: 'job-1', name: 'website', status: 'cloning' },
    ]);
  });

  it('maps a cancelling clone', () => {
    expect(
      pendingProjectsFromCloneJobs([job({ status: 'cancelling' })], actions),
    ).toEqual([{ id: 'job-1', name: 'website', status: 'cancelling' }]);
  });

  it('maps a failed clone with its message, Retry, and Dismiss', () => {
    const onRetry = jest.fn();
    const onDismiss = jest.fn();
    const failed = job({ status: 'failed', error: 'Authentication failed.' });
    const [row] = pendingProjectsFromCloneJobs([failed], {
      onRetry,
      onDismiss,
    });
    expect(row).toMatchObject({
      id: 'job-1',
      name: 'website',
      status: 'failed',
      message: 'Authentication failed.',
    });
    row?.onRetry?.();
    row?.onDismiss?.();
    expect(onRetry).toHaveBeenCalledWith(failed);
    expect(onDismiss).toHaveBeenCalledWith(failed);
  });

  it('omits an empty failure message', () => {
    const [row] = pendingProjectsFromCloneJobs(
      [job({ status: 'failed' })],
      actions,
    );
    expect(row).not.toHaveProperty('message');
  });

  it('omits foreground and succeeded jobs', () => {
    expect(
      pendingProjectsFromCloneJobs(
        [
          job({ id: 'foreground', background: false }),
          job({ id: 'done', status: 'succeeded', workspaceId: 'w1' }),
          job({ id: 'failed-foreground', background: false, status: 'failed' }),
        ],
        actions,
      ),
    ).toEqual([]);
  });

  it('prefers the project name once known', () => {
    expect(
      pendingProjectsFromCloneJobs(
        [job({ workspaceName: 'Marketing site' })],
        actions,
      )[0]?.name,
    ).toBe('Marketing site');
  });

  it('never surfaces the destination path', () => {
    expect(
      JSON.stringify(pendingProjectsFromCloneJobs([job()], actions)),
    ).not.toContain('/Users/someone');
  });
});

describe('useDesktopPendingProjects', () => {
  let container: HTMLDivElement;
  let root: Root;
  let rows: readonly SidebarPendingProject[] = [];
  const dismissCloneJob = jest.fn<Promise<void>, [string]>();

  function Probe({
    organization = false,
  }: {
    readonly organization?: boolean;
  }): JSX.Element {
    rows = useDesktopPendingProjects(
      organization
        ? { kind: 'organization', organizationId: 'org-a' }
        : { kind: 'personal' },
    );
    return <></>;
  }

  beforeEach(() => {
    dismissCloneJob.mockReset();
    dismissCloneJob.mockResolvedValue(undefined);
    Reflect.set(window, 'api', { dismissCloneJob });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useCloneJobsStore.setState({ jobs: [], received: false, isOpen: false });
    useNavigationStore.getState().closeAddWorkspaceModal();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    Reflect.deleteProperty(window, 'api');
  });

  it('follows the clone job broadcasts', () => {
    act(() => root.render(<Probe />));
    expect(rows).toEqual([]);
    act(() => useCloneJobsStore.getState().apply([job()]));
    expect(rows).toEqual([{ id: 'job-1', name: 'website', status: 'cloning' }]);
    // Main removes a succeeded job once its outcome is announced.
    act(() =>
      useCloneJobsStore.getState().apply([job({ status: 'succeeded' })]),
    );
    expect(rows).toEqual([]);
    act(() => useCloneJobsStore.getState().apply([]));
    expect(rows).toEqual([]);
  });

  it('keeps a failed row until the user dismisses it', async () => {
    act(() => root.render(<Probe />));
    act(() =>
      useCloneJobsStore
        .getState()
        .apply([job({ status: 'failed', error: 'Authentication failed.' })]),
    );
    expect(rows[0]?.status).toBe('failed');
    act(() => rows[0]?.onDismiss?.());
    await act(async () => {
      await Promise.resolve();
    });
    expect(dismissCloneJob).toHaveBeenCalledWith('job-1');
    // The row leaves only when main broadcasts the removal.
    expect(rows).toHaveLength(1);
    act(() => useCloneJobsStore.getState().apply([]));
    expect(rows).toEqual([]);
  });

  it('keeps the failed row when dismissal is rejected', async () => {
    dismissCloneJob.mockRejectedValue(new Error('gone'));
    act(() => root.render(<Probe />));
    act(() => useCloneJobsStore.getState().apply([job({ status: 'failed' })]));
    act(() => rows[0]?.onDismiss?.());
    await act(async () => {
      await Promise.resolve();
    });
    expect(rows).toHaveLength(1);
  });

  it('reopens Add project with the credential-free URL and keeps the row', () => {
    act(() => root.render(<Probe />));
    act(() => useCloneJobsStore.getState().apply([job({ status: 'failed' })]));
    act(() => rows[0]?.onRetry?.());
    const navigation = useNavigationStore.getState();
    expect(navigation.addWorkspaceModalOpen).toBe(true);
    expect(navigation.addWorkspaceInitialRepoUrl).toBe(
      'https://github.com/acme/website.git',
    );
    expect(rows).toHaveLength(1);
    expect(dismissCloneJob).not.toHaveBeenCalled();
  });

  it('retains the failed row if opening Add project throws', () => {
    act(() => root.render(<Probe />));
    act(() =>
      useCloneJobsStore
        .getState()
        .apply([job({ status: 'failed', error: 'Authentication failed.' })]),
    );
    const open = jest
      .spyOn(useNavigationStore.getState(), 'openAddWorkspaceModal')
      .mockImplementationOnce(() => {
        throw new Error('dialog unavailable');
      });
    try {
      expect(() => rows[0]?.onRetry?.()).toThrow('dialog unavailable');
      expect(rows[0]).toMatchObject({ id: 'job-1', status: 'failed' });
      expect(dismissCloneJob).not.toHaveBeenCalled();
    } finally {
      open.mockRestore();
    }
  });

  it('does not reseed an Add project dialog that is already open', () => {
    act(() => root.render(<Probe />));
    act(() => useCloneJobsStore.getState().apply([job({ status: 'failed' })]));
    act(() =>
      useNavigationStore
        .getState()
        .openAddWorkspaceModal({ initialRepoUrl: 'https://example.com/a.git' }),
    );
    act(() => rows[0]?.onRetry?.());
    expect(useNavigationStore.getState().addWorkspaceInitialRepoUrl).toBe(
      'https://example.com/a.git',
    );
  });

  it('shows no Personal clone rows in an organization', () => {
    act(() => useCloneJobsStore.getState().apply([job()]));
    act(() => root.render(<Probe organization />));
    expect(rows).toEqual([]);
    act(() => root.render(<Probe />));
    expect(rows).toHaveLength(1);
  });
});
