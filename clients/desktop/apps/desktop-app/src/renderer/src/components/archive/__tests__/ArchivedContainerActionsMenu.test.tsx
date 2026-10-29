/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ArchivedContainerSummary } from '@canopy/desktop-shared/types';
import { ArchivedContainerActionsMenu } from '../ArchivedContainerActionsMenu';
import { useArchivedContainersStore } from '@/stores/archivedContainersStore';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const summary: ArchivedContainerSummary = {
  version: 1,
  id: 'archive-1',
  kind: 'worktree',
  projectId: 'workspace-1',
  name: 'Archived feature',
  createdAt: '2026-08-01T00:00:00.000Z',
  archivedAt: '2026-08-10T00:00:00.000Z',
  retentionDays: 30,
  expiresAt: '2026-09-09T00:00:00.000Z',
  chatCount: 1,
  archivedChatCount: 1,
  executionCount: 2,
};

const archivedSummary: ArchivedContainerSummary = {
  ...summary,
  lockedAt: '2026-08-18T00:00:00.000Z',
};

describe('ArchivedContainerActionsMenu', () => {
  let container: HTMLDivElement;
  let root: Root;
  const setLocked = jest.fn();
  const deleteArchive = jest.fn();

  function render(target: ArchivedContainerSummary): void {
    useArchivedContainersStore.setState({
      byWorkspace: { 'workspace-1': [target] },
      loadedWorkspaces: { 'workspace-1': true },
      viewer: null,
    });
    act(() => {
      root.render(
        <ArchivedContainerActionsMenu
          summary={target}
          testIdPrefix="archive-row"
        />,
      );
    });
  }

  beforeEach(() => {
    container = document.createElement('div');
    container.className = 'group';
    document.body.appendChild(container);
    root = createRoot(container);
    setLocked.mockReset().mockResolvedValue(archivedSummary);
    deleteArchive.mockReset().mockResolvedValue(undefined);
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        archivedContainers: {
          setLocked,
          delete: deleteArchive,
          list: jest.fn().mockResolvedValue([]),
        },
      },
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document
      .querySelectorAll('[data-testid^="archive-row-"]')
      .forEach((node) => node.remove());
  });

  async function openMenu(): Promise<void> {
    await act(async () => {
      container
        .querySelector('[data-testid="archive-row-actions"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
  }

  function menuItemText(testId: string): string {
    return (
      document
        .querySelector(`[data-testid="${testId}"]`)
        ?.textContent?.trim() ?? ''
    );
  }

  it('offers Restore, Archive, and Permanent (below a divider) for a Deleted item', async () => {
    render(summary);
    await openMenu();
    expect(menuItemText('archive-row-restore')).toBe('Restore');
    expect(menuItemText('archive-row-state')).toBe('Archive');
    expect(menuItemText('archive-row-delete')).toBe('Permanent');
    expect(document.body.textContent).not.toContain('Lock');
    // The recoverable actions read neutral; only Permanent is destructive,
    // separated from them by a divider.
    expect(
      document.querySelector('[data-testid="archive-row-state"]')?.className,
    ).not.toContain('fg-destructive');
    expect(
      document.querySelector('[data-testid="archive-row-delete"]')?.className,
    ).toContain('fg-destructive');
    const menu = document.querySelector('[data-testid="archive-row-menu"]');
    const separator = menu?.querySelector('[role="separator"]');
    const permanent = document.querySelector(
      '[data-testid="archive-row-delete"]',
    );
    if (!separator || !permanent) throw new Error('Menu structure missing');
    expect(
      separator.compareDocumentPosition(permanent) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    await act(async () => {
      document
        .querySelector('[data-testid="archive-row-state"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(setLocked).toHaveBeenCalledWith({
      projectId: 'workspace-1',
      containerId: 'archive-1',
      locked: true,
    });
  });

  it('offers Restore, a neutral Delete, and Permanent for an Archived item', async () => {
    setLocked.mockResolvedValue(summary);
    render(archivedSummary);
    await openMenu();
    expect(menuItemText('archive-row-restore')).toBe('Restore');
    expect(menuItemText('archive-row-state')).toBe('Delete');
    expect(
      document.querySelector('[data-testid="archive-row-state"]')?.className,
    ).not.toContain('fg-destructive');
    expect(menuItemText('archive-row-delete')).toBe('Permanent');
    expect(document.body.textContent).not.toContain('Unlock');

    await act(async () => {
      document
        .querySelector('[data-testid="archive-row-state"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(setLocked).toHaveBeenCalledWith({
      projectId: 'workspace-1',
      containerId: 'archive-1',
      locked: false,
    });
  });

  it('requires confirmation before permanently deleting an item', async () => {
    render(summary);
    await openMenu();
    act(() => {
      document
        .querySelector('[data-testid="archive-row-delete"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(deleteArchive).not.toHaveBeenCalled();
    expect(
      document.querySelector('[data-testid="archive-row-delete-confirmation"]'),
    ).toBeTruthy();

    await act(async () => {
      document
        .querySelector('[data-testid="archive-row-delete-confirm"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(deleteArchive).toHaveBeenCalledWith({
      projectId: 'workspace-1',
      containerId: 'archive-1',
    });
  });
});
