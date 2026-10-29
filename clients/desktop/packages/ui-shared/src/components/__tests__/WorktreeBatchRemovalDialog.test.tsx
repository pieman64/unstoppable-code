/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  WorktreeBatchRemovalDialog,
  type WorktreeBatchRemovalDialogProps,
} from '../WorktreeBatchRemovalDialog';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

type DialogRow = WorktreeBatchRemovalDialogProps['rows'][number];

const clean: DialogRow = {
  key: 'w/clean',
  projectName: 'Project',
  label: 'clean',
  branchName: 'clean',
};
const dirty: DialogRow = {
  key: 'w/dirty',
  projectName: 'Project',
  label: 'dirty',
  branchName: 'feature/dirty',
  localWork: { insertions: 12, deletions: 3 },
};
const unpushed: DialogRow = {
  key: 'w/unpushed',
  projectName: 'Project',
  label: 'unpushed',
  localWork: { unpushed: true },
};
const rows: WorktreeBatchRemovalDialogProps['rows'] = [clean, dirty, unpushed];

describe('WorktreeBatchRemovalDialog (CAN-3975)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(props: Partial<WorktreeBatchRemovalDialogProps> = {}): void {
    act(() =>
      root.render(
        <WorktreeBatchRemovalDialog
          mode="archive"
          phase="confirm"
          rows={rows}
          excluded={[]}
          retentionSummary="Kept until you delete the archive."
          retentionDetail="Detail"
          branchChoice={false}
          onCancel={jest.fn()}
          onConfirm={jest.fn()}
          onStop={jest.fn()}
          onDone={jest.fn()}
          {...props}
        />,
      ),
    );
  }

  const dialog = (): HTMLElement | null =>
    document.body.querySelector(
      '[data-testid="worktree-batch-removal-dialog"]',
    );
  const byTestId = (id: string): HTMLButtonElement | null =>
    document.body.querySelector(
      `[data-testid="worktree-batch-removal-dialog-${id}"]`,
    );

  it('titles the removable count and leads with rows that have local work', () => {
    render({ warning: '2 worktrees have local work.' });
    expect(dialog()?.textContent).toContain('Archive 3 worktrees?');
    expect(dialog()?.textContent).toContain('2 worktrees have local work.');
    const order = Array.from(
      document.body.querySelectorAll<HTMLElement>(
        '[data-testid="worktree-batch-removal-dialog-row"]',
      ),
      (row) => row.getAttribute('data-row-key'),
    );
    expect(order).toEqual(['w/dirty', 'w/unpushed', 'w/clean']);
    expect(dialog()?.textContent).toContain('+12');
    expect(dialog()?.textContent).toContain('Unpushed commits');
    expect(byTestId('confirm')?.textContent).toBe('Archive 3 worktrees');
  });

  it('masks every user-authored name in a row for session replay', () => {
    render({
      rows: [{ ...dirty, projectName: 'Secret project' }],
    });
    const masked = Array.from(
      document.body.querySelectorAll('.ph-mask'),
      (node) => node.textContent,
    );
    expect(masked).toEqual(
      expect.arrayContaining(['dirty', 'Secret project', 'feature/dirty']),
    );
  });

  it('lists Not included rows with their reason, outside the count', () => {
    render({
      rows: [clean],
      excluded: [
        {
          key: 'w/busy',
          projectName: 'Project',
          label: 'busy',
          reason: 'Stop all sessions before archiving',
        },
      ],
    });
    expect(dialog()?.textContent).toContain('Archive 1 worktree?');
    const excluded = document.body.querySelector(
      '[data-testid="worktree-batch-removal-dialog-excluded"]',
    );
    expect(excluded?.textContent).toContain('Not included (1)');
    expect(excluded?.textContent).toContain(
      'Stop all sessions before archiving',
    );
  });

  it('disables confirming when nothing is removable and says why', () => {
    render({
      mode: 'delete',
      rows: [],
      excluded: [
        {
          key: 'w/busy',
          projectName: 'Project',
          label: 'busy',
          reason: 'Busy',
        },
      ],
    });
    expect(
      document.body.querySelector(
        '[data-testid="worktree-batch-removal-dialog-nothing-removable"]',
      )?.textContent,
    ).toContain('can be deleted right now');
    expect(byTestId('confirm')?.disabled).toBe(true);
  });

  it('offers Preserve local and Delete local with the branch choice', () => {
    const onConfirm = jest.fn();
    render({ branchChoice: true, onConfirm });
    expect(byTestId('confirm')).toBeNull();
    expect(dialog()?.textContent).toContain(
      'Delete local deletes it for every worktree listed.',
    );
    act(() => byTestId('delete-branch')?.click());
    expect(onConfirm).toHaveBeenCalledWith(true);
    act(() => byTestId('preserve-branch')?.click());
    expect(onConfirm).toHaveBeenLastCalledWith(false);
  });

  it('shows progress and Stop after this one while running', () => {
    const onStop = jest.fn();
    render({
      phase: 'running',
      onStop,
      rows: [
        { ...clean, status: 'done' },
        { ...dirty, status: 'running' },
        { ...unpushed, status: 'pending' },
      ],
    });
    expect(dialog()?.textContent).toContain('Archiving 3 worktrees…');
    expect(byTestId('cancel')).toBeNull();
    act(() => byTestId('stop')?.click());
    expect(onStop).toHaveBeenCalledTimes(1);
    render({ phase: 'running', stopRequested: true });
    expect(byTestId('stop')?.disabled).toBe(true);
  });

  it('summarizes results with a reason per failure or skip', () => {
    const onDone = jest.fn();
    render({
      phase: 'results',
      onDone,
      rows: [
        { ...clean, status: 'done' },
        { ...dirty, status: 'failed', reason: 'Teardown script failed.' },
        {
          ...unpushed,
          status: 'skipped',
          reason: 'Stop all sessions before archiving',
        },
      ],
    });
    expect(dialog()?.textContent).toContain('1 archived, 1 failed, 1 skipped');
    expect(dialog()?.textContent).toContain('Teardown script failed.');
    act(() => byTestId('done')?.click());
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});
