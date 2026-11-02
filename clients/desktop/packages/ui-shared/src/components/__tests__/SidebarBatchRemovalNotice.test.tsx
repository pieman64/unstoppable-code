/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  SidebarBatchRemovalNotice,
  type SidebarBatchRemovalNoticeProps,
} from '../SidebarBatchRemovalNotice';

import { WORKTREE_BATCH_UNIT } from '../worktree-count-label';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('SidebarBatchRemovalNotice (CAN-3975)', () => {
  let container: HTMLDivElement;
  let root: Root;
  const onStop = jest.fn();
  const onShowDetails = jest.fn();
  const onDismiss = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(props: Partial<SidebarBatchRemovalNoticeProps> = {}): void {
    act(() =>
      root.render(
        <SidebarBatchRemovalNotice
          verb="delete"
          unitLabel={WORKTREE_BATCH_UNIT}
          running
          stopRequested={false}
          total={5}
          done={2}
          failed={0}
          skipped={0}
          notStarted={3}
          onStop={onStop}
          onShowDetails={onShowDetails}
          onDismiss={onDismiss}
          {...props}
        />,
      ),
    );
  }

  const notice = (): HTMLElement | null =>
    container.querySelector('[data-testid="worktree-batch-removal-notice"]');
  const byTestId = (id: string): HTMLButtonElement | null =>
    container.querySelector(
      `[data-testid="worktree-batch-removal-notice-${id}"]`,
    );

  it('shows progress with Stop while running', () => {
    render();
    expect(notice()?.textContent).toContain('Deleting worktrees');
    expect(notice()?.textContent).toContain('2 of 5 done.');
    act(() => byTestId('stop')?.click());
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(byTestId('details')).toBeNull();
    expect(byTestId('dismiss')).toBeNull();
  });

  it('says Stopping… once Stop was pressed and disables it', () => {
    render({ stopRequested: true });
    expect(byTestId('stop')?.disabled).toBe(true);
    expect(byTestId('stop')?.textContent).toBe('Stopping…');
  });

  it('uses Archiving for archive and Removing when batches mix archive and delete', () => {
    render({ verb: 'archive' });
    expect(notice()?.textContent).toContain('Archiving worktrees');
    render({ verb: 'remove' });
    expect(notice()?.textContent).toContain('Removing worktrees');
  });

  it('reports what did not finish, with Details and dismiss, once idle', () => {
    render({ running: false, done: 3, failed: 1, notStarted: 1 });
    expect(notice()?.textContent).toContain('Deleted 3 of 5 worktrees');
    expect(notice()?.textContent).toContain('1 failed, 1 not started.');
    expect(byTestId('stop')).toBeNull();
    act(() => byTestId('details')?.click());
    expect(onShowDetails).toHaveBeenCalledTimes(1);
    act(() => byTestId('dismiss')?.click());
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('names skipped rows and uses the singular label for one worktree', () => {
    render({
      verb: 'archive',
      running: false,
      total: 1,
      done: 0,
      skipped: 1,
      notStarted: 0,
    });
    expect(notice()?.textContent).toContain('Archived 0 of 1 worktree');
    expect(notice()?.textContent).toContain('1 skipped.');
  });

  it('names the rows by the unit label', () => {
    render({ unitLabel: { singular: 'chat', plural: 'chats' } });
    expect(notice()?.textContent).toContain('Deleting chats');
    render({
      unitLabel: { singular: 'chat', plural: 'chats' },
      running: false,
      done: 1,
      total: 2,
      failed: 1,
      notStarted: 0,
    });
    expect(notice()?.textContent).toContain('Deleted 1 of 2 chats');
  });

  it('renders nothing when idle and everything succeeded', () => {
    render({ running: false, done: 5, notStarted: 0 });
    expect(container.innerHTML).toBe('');
  });
});
