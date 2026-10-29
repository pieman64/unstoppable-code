/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CoworkWorkEntryMeta } from '@canopy/desktop-shared/types';
import { WorkEntryListItem } from '@/components/standalone-chat/WorkEntryListItem';
import { setNativeInputValue } from '@/test-utils/dom';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function entry(
  overrides: Partial<CoworkWorkEntryMeta> = {},
): CoworkWorkEntryMeta {
  return {
    id: 'entry-1',
    title: 'My entry',
    createdAt: '2026-01-01T00:00:00.000Z',
    lastMessageAt: null,
    providerType: 'claude',
    chatCount: 1,
    ...overrides,
  } as CoworkWorkEntryMeta;
}

function click(element: Element): void {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function byTestId(container: HTMLElement, testId: string): HTMLElement {
  const found =
    container.querySelector<HTMLElement>(`[data-testid="${testId}"]`) ??
    document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  if (!found) {
    throw new Error(`Element not found: ${testId}`);
  }
  return found;
}

describe('WorkEntryListItem', () => {
  let container: HTMLDivElement;
  let root: Root;
  let onSelect: jest.Mock;
  let onRename: jest.Mock;
  let onDelete: jest.Mock;
  let onToggleAutoArchiveLock: jest.Mock;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    onSelect = jest.fn();
    onRename = jest.fn();
    onDelete = jest.fn();
    onToggleAutoArchiveLock = jest.fn();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    jest.clearAllMocks();
  });

  function render(
    props: Partial<Parameters<typeof WorkEntryListItem>[0]> = {},
  ): void {
    act(() => {
      root.render(
        <WorkEntryListItem
          entry={entry()}
          selected={false}
          onSelect={onSelect}
          onRename={onRename}
          onDelete={onDelete}
          deleting={false}
          {...props}
        />,
      );
    });
  }

  it('keeps the default sidebar-work-entry test-id contract', () => {
    render();
    const row = byTestId(container, 'sidebar-work-entry-entry-1');
    expect(row.textContent).toContain('My entry');
    expect(row.className).toContain('fg-secondary');
    expect(row.querySelector('p')?.className).not.toContain('fg-primary');
    click(row);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('keeps selected chat text primary', () => {
    render({ selected: true });
    const row = byTestId(container, 'sidebar-work-entry-entry-1');
    expect(row.className).toContain('bg-muted');
    expect(row.className).toContain('fg-primary');
    expect(row.querySelector('p')?.className).not.toContain('fg-secondary');
  });

  it('applies a custom testIdPrefix to the row and its controls', () => {
    render({ testIdPrefix: 'app-advisor-nav-entry' });
    const row = byTestId(container, 'app-advisor-nav-entry-entry-1');
    expect(row).toBeTruthy();
    expect(
      container.querySelector('[data-testid="sidebar-work-entry-entry-1"]'),
    ).toBeNull();
    expect(
      byTestId(container, 'app-advisor-nav-entry-entry-1-menu'),
    ).toBeTruthy();
  });

  it('selects with keyboard Enter', () => {
    render();
    const row = byTestId(container, 'sidebar-work-entry-entry-1');
    act(() => {
      row.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
    });
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('renames via the menu with Enter committing the trimmed value', () => {
    render();
    click(byTestId(container, 'sidebar-work-entry-entry-1-menu'));
    click(byTestId(container, 'sidebar-work-entry-entry-1-rename'));

    const input = byTestId(
      container,
      'sidebar-work-entry-entry-1-rename-input',
    ) as HTMLInputElement;
    act(() => {
      setNativeInputValue(input, '  Renamed title  ');
    });
    act(() => {
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
    });
    expect(onRename).toHaveBeenCalledWith('Renamed title');
  });

  it('clears the rename override when the title is emptied', () => {
    render();
    click(byTestId(container, 'sidebar-work-entry-entry-1-menu'));
    click(byTestId(container, 'sidebar-work-entry-entry-1-rename'));
    const input = byTestId(
      container,
      'sidebar-work-entry-entry-1-rename-input',
    ) as HTMLInputElement;
    act(() => {
      setNativeInputValue(input, '   ');
    });
    act(() => {
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
    });
    expect(onRename).toHaveBeenCalledWith(null);
  });

  it('requires a two-step confirm before deleting and reports delete mode', () => {
    render();
    click(byTestId(container, 'sidebar-work-entry-entry-1-menu'));
    click(byTestId(container, 'sidebar-work-entry-entry-1-delete'));
    // First step arms the inline confirm; nothing deleted yet.
    expect(onDelete).not.toHaveBeenCalled();

    const confirm = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Delete?',
    );
    if (!confirm) throw new Error('Inline delete confirm not found');
    click(confirm);
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledWith({ mode: 'delete' });
  });

  it('offers Delete (destructive, retention tooltip) and Archive (kept until deleted)', () => {
    render({ effectiveRetentionDays: 7 });
    click(byTestId(container, 'sidebar-work-entry-entry-1-menu'));
    const deleteItem = byTestId(container, 'sidebar-work-entry-entry-1-delete');
    expect(deleteItem.textContent?.trim()).toBe('Delete');
    expect(deleteItem.getAttribute('title')).toBe(
      'Kept for 7 days, then removed',
    );
    // Delete is recoverable (kept for the retention window), so it reads
    // neutral like Archive; only permanent deletion is destructive.
    expect(deleteItem.className).not.toContain('fg-destructive');
    expect(deleteItem.querySelector('svg')).not.toBeNull();
    const archiveItem = byTestId(
      container,
      'sidebar-work-entry-entry-1-archive',
    );
    expect(archiveItem.textContent?.trim()).toBe('Archive');
    expect(archiveItem.getAttribute('title')).toBe('Kept until you delete it');
    expect(archiveItem.className).not.toContain('fg-destructive');
    expect(archiveItem.querySelector('svg')).not.toBeNull();
  });

  it('leads every menu row with an icon and ends with Archive and Delete in their own group', () => {
    render({ onSetPinned: jest.fn() });
    click(byTestId(container, 'sidebar-work-entry-entry-1-menu'));
    const popover = byTestId(
      container,
      'sidebar-work-entry-entry-1-menu-popover',
    );
    const rows = Array.from(popover.querySelectorAll('[role="menuitem"]'));
    expect(rows.map((row) => row.getAttribute('data-testid'))).toEqual([
      'sidebar-work-entry-entry-1-toggle-pin',
      'sidebar-work-entry-entry-1-rename',
      'sidebar-work-entry-entry-1-archive',
      'sidebar-work-entry-entry-1-delete',
    ]);
    for (const row of rows) {
      expect(row.querySelector('[aria-hidden="true"] svg')).not.toBeNull();
    }
    expect(popover.querySelectorAll('[role="separator"]')).toHaveLength(1);
    expect(
      byTestId(
        container,
        'sidebar-work-entry-entry-1-archive',
      ).previousElementSibling?.getAttribute('role'),
    ).toBe('separator');
  });

  it('runs a menu row without selecting the row', () => {
    const onSetPinned = jest.fn();
    render({ onSetPinned });
    click(byTestId(container, 'sidebar-work-entry-entry-1-menu'));
    click(byTestId(container, 'sidebar-work-entry-entry-1-toggle-pin'));
    expect(onSetPinned).toHaveBeenCalledWith(true);
    expect(onSelect).not.toHaveBeenCalled();
    expect(
      document.querySelector(
        '[data-testid="sidebar-work-entry-entry-1-menu-popover"]',
      ),
    ).toBeNull();
  });

  it('archives through its own two-step confirm and reports archive mode', () => {
    render({ effectiveRetentionDays: 7 });
    click(byTestId(container, 'sidebar-work-entry-entry-1-menu'));
    click(byTestId(container, 'sidebar-work-entry-entry-1-archive'));
    const confirm = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Archive?',
    );
    if (!confirm) throw new Error('Inline archive confirm not found');
    expect(
      Array.from(container.querySelectorAll('button')).find(
        (button) => button.textContent?.trim() === 'Delete?',
      ),
    ).toBeUndefined();
    click(confirm);
    expect(onDelete).toHaveBeenCalledWith({ mode: 'archive' });
  });

  it('uses singular tooltip copy for a one-day retention window', () => {
    render({ effectiveRetentionDays: 1 });
    click(byTestId(container, 'sidebar-work-entry-entry-1-menu'));
    expect(
      byTestId(container, 'sidebar-work-entry-entry-1-delete').getAttribute(
        'title',
      ),
    ).toBe('Kept for 1 day, then removed');
  });

  it('does not expose legacy Auto Archive Lock or Unlock actions', () => {
    render({
      autoArchiveEnabled: true,
      onToggleAutoArchiveLock,
    });
    click(byTestId(container, 'sidebar-work-entry-entry-1-menu'));
    expect(
      document.querySelector(
        '[data-testid="sidebar-work-entry-entry-1-auto-archive-lock"]',
      ),
    ).toBeNull();
    expect(container.textContent).not.toContain('Unlock');
  });
});
