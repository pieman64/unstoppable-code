/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  WorkEntryRow,
  WorkEntryRowMenuItems,
  type WorkEntryRowMultiSelect,
  type WorkEntryRowProps,
} from '../WorkEntryRow';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('WorkEntryRow multi-select (CAN-3975)', () => {
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

  function render(props: Partial<WorkEntryRowProps> = {}): HTMLElement {
    act(() =>
      root.render(
        <WorkEntryRow title="Chat" testId="entry" entryId="e1" {...props} />,
      ),
    );
    const testId =
      props.pinnedSurface === undefined
        ? 'entry'
        : `entry-${props.pinnedSurface}`;
    const row = container.querySelector<HTMLElement>(
      `[data-testid="${testId}"]`,
    );
    if (!row) throw new Error('Missing row');
    return row;
  }

  const ms = (
    over: Partial<WorkEntryRowMultiSelect> = {},
  ): WorkEntryRowMultiSelect => ({
    selected: false,
    selectable: true,
    active: false,
    escapeClears: true,
    onToggle: jest.fn(),
    onSelectRange: jest.fn(),
    onSelectAll: jest.fn(),
    onClear: jest.fn(),
    ...over,
  });

  function click(row: HTMLElement, init: MouseEventInit = {}): void {
    act(() => {
      row.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, ...init }),
      );
    });
  }

  function key(row: HTMLElement, init: KeyboardEventInit): void {
    act(() => {
      row.dispatchEvent(
        new KeyboardEvent('keydown', {
          bubbles: true,
          cancelable: true,
          ...init,
        }),
      );
    });
  }

  it('tints a multi-selected row apart from the open row and names it for AT', () => {
    const row = render({ selected: true, multiSelect: ms({ selected: true }) });
    expect(row.className).toContain('bg-accent-subtle');
    expect(row.className).not.toMatch(/(^|\s)bg-muted(\s|$)/);
    expect(row.getAttribute('data-multiselected')).toBe('true');
    expect(row.querySelector('.sr-only')?.textContent).toBe('Selected');
    expect(row.hasAttribute('data-worktree-selection-row')).toBe(true);
  });

  it('keeps the resting look and no selection marks without a selection', () => {
    const row = render({ multiSelect: ms() });
    expect(row.className).not.toContain('bg-accent-subtle');
    expect(row.hasAttribute('data-multiselected')).toBe(false);
    expect(render().hasAttribute('data-worktree-selection-row')).toBe(false);
  });

  it('command-click toggles, shift-click ranges, and neither opens', () => {
    const multi = ms();
    const onOpen = jest.fn();
    const row = render({ onOpen, multiSelect: multi });
    click(row, { metaKey: true, ctrlKey: true });
    click(row, { shiftKey: true });
    expect(multi.onToggle).toHaveBeenCalledTimes(1);
    expect(multi.onSelectRange).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('a plain click opens and clears an active selection', () => {
    const calls: string[] = [];
    const multi = ms({ active: true, onClear: () => calls.push('clear') });
    const row = render({
      onOpen: () => calls.push('open'),
      multiSelect: multi,
    });
    click(row);
    expect(calls).toEqual(['clear', 'open']);
  });

  it('an unselectable row opens on a modified click and never toggles', () => {
    const multi = ms({ selectable: false });
    const onOpen = jest.fn();
    const row = render({ onOpen, multiSelect: multi });
    click(row, { metaKey: true, ctrlKey: true });
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(multi.onToggle).not.toHaveBeenCalled();
  });

  it('a removing row ignores selection gestures', () => {
    const multi = ms();
    const row = render({ removing: true, multiSelect: multi });
    click(row, { metaKey: true, ctrlKey: true });
    key(row, { key: 'x' });
    expect(multi.onToggle).not.toHaveBeenCalled();
  });

  it('x toggles, Cmd/Ctrl+A selects all, Escape clears when allowed, and a pinned copy ignores selection', () => {
    const multi = ms({ active: true });
    const row = render({ multiSelect: multi });
    key(row, { key: 'x' });
    expect(multi.onToggle).toHaveBeenCalledTimes(1);
    key(row, { key: 'a', metaKey: true, ctrlKey: true });
    expect(multi.onSelectAll).toHaveBeenCalledTimes(1);
    key(row, { key: 'Escape' });
    expect(multi.onClear).toHaveBeenCalledTimes(1);

    const blocked = ms({ active: true, escapeClears: false });
    key(render({ multiSelect: blocked }), { key: 'Escape' });
    expect(blocked.onClear).not.toHaveBeenCalled();

    const pinned = ms({ selected: true });
    const copy = render({ pinnedSurface: 'pin-top', multiSelect: pinned });
    expect(copy.hasAttribute('data-worktree-selection-row')).toBe(false);
    expect(copy.hasAttribute('data-multiselected')).toBe(false);
    key(copy, { key: 'x' });
    expect(pinned.onToggle).not.toHaveBeenCalled();
  });

  it('reserves no select column on a Chats row', () => {
    render({ multiSelect: ms() });
    expect(
      container.querySelector('[data-testid="entry-select-column"]'),
    ).toBeNull();
    expect(container.querySelector('[role="checkbox"]')).toBeNull();
  });

  it('renders beforeRemoval between the action rows and the removal group', () => {
    act(() =>
      root.render(
        <WorkEntryRowMenuItems
          menu={{ close: jest.fn(), testIdFor: (suffix) => `m${suffix}` }}
          onRename={jest.fn()}
          beforeRemoval={<div data-testid="sel" />}
          onDelete={jest.fn()}
        />,
      ),
    );
    const order = Array.from(
      container.querySelectorAll('[data-testid], [role="separator"], hr'),
    ).map(
      (element) =>
        element.getAttribute('data-testid') ?? element.tagName.toLowerCase(),
    );
    const rename = order.indexOf('m-rename');
    const sel = order.indexOf('sel');
    const del = order.indexOf('m-delete');
    expect(rename).toBeGreaterThanOrEqual(0);
    expect(sel).toBeGreaterThan(rename);
    expect(del).toBeGreaterThan(sel + 1);
  });
});
