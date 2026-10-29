/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { WorktreeRow, type WorktreeRowProps } from '../WorktreeRow';
import { WorkEntryRow } from '../WorkEntryRow';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('WorktreeRow multi-select (CAN-3975)', () => {
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

  function render(props: Partial<WorktreeRowProps> = {}): HTMLElement {
    act(() =>
      root.render(
        <WorktreeRow
          branchLabel="Feature"
          uiStatus="idle"
          displayMode="list"
          textScale="sidebar"
          dataTestId="row"
          {...props}
        />,
      ),
    );
    const row = container.querySelector<HTMLElement>('[data-testid="row"]');
    if (!row) throw new Error('Missing row');
    return row;
  }

  it('adds no checkbox or select column, so the title keeps its inset', () => {
    const row = render({ multiSelect: { selected: true } });
    expect(row.querySelector('[role="checkbox"]')).toBeNull();
    expect(
      container.querySelector('[data-testid="worktree-row-select-column"]'),
    ).toBeNull();
    // The leading slot is the row's first column again.
    expect(row.firstElementChild?.getAttribute('data-testid')).toBe(
      'worktree-row-leading-slot',
    );
  });

  it('tints a multi-selected row apart from the open row', () => {
    const open = render({ selected: true });
    expect(open.className).toContain('bg-muted');
    expect(open.className).not.toContain('bg-accent-subtle');
    expect(open.getAttribute('data-multiselected')).toBeNull();

    const multiSelected = render({ multiSelect: { selected: true } });
    expect(multiSelected.getAttribute('data-multiselected')).toBe('true');
    expect(multiSelected.className).toContain('bg-accent-subtle');
    expect(multiSelected.className).not.toMatch(/(^|\s)bg-muted(\s|$)/);
  });

  it('names the multi-selected state for assistive technology, in both layouts', () => {
    // The row is a list item, which can't carry aria-selected, and the tint
    // alone is invisible to a screen reader.
    for (const textScale of ['sidebar', 'default'] as const) {
      const selectedRow = render({
        textScale,
        multiSelect: { selected: true },
      });
      expect(selectedRow.querySelector('.sr-only')?.textContent).toBe(
        'Selected',
      );
      const restingRow = render({
        textScale,
        multiSelect: { selected: false },
      });
      expect(restingRow.querySelector('.sr-only')).toBeNull();
    }
  });

  it('keeps the resting look for a row in neither state', () => {
    const row = render({ multiSelect: { selected: false } });
    expect(row.className).not.toContain('bg-accent-subtle');
    expect(row.className).toContain('hover:bg-subtle');
  });

  it('reserves no select column on a Chats row', () => {
    act(() =>
      root.render(<WorkEntryRow title="Chat" testId="entry" entryId="e1" />),
    );
    expect(
      container.querySelector('[data-testid="entry-select-column"]'),
    ).toBeNull();
  });
});
