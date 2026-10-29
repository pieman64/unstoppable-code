/**
 * @jest-environment jsdom
 */
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SidebarItem } from '@canopy/desktop-shared/types';
import { WorkspaceDropdown } from '@/components/shared/WorkspaceDropdown';

function makeWorkspace(id: string, name: string): SidebarItem {
  return {
    id,
    name,
    type: 'single-repo',
    repoPath: `/repos/${id}`,
    color: '#888888',
    collapsed: false,
    order: 0,
    worktrees: [],
  };
}

function makeMultiRepoWorkspace(id: string, name: string): SidebarItem {
  return {
    id,
    name,
    type: 'multi-repo',
    color: '#d04a00',
    collapsed: false,
    order: 0,
    repos: [],
    worktrees: [],
  };
}

const WORKSPACES: SidebarItem[] = [
  makeWorkspace('alpha', 'Alpha'),
  makeWorkspace('beta', 'Beta'),
  makeWorkspace('gamma', 'Gamma'),
];

describe('WorkspaceDropdown', () => {
  let container: HTMLDivElement;
  let root: Root;
  let onSelect: jest.Mock;
  let onAddWorkspace: jest.Mock;

  function render(onRestoreFocus?: () => void): void {
    act(() => {
      root.render(
        createElement(WorkspaceDropdown, {
          workspaces: WORKSPACES,
          selectedWorkspaceId: 'alpha',
          onSelect,
          onAddWorkspace,
          testIdPrefix: 'home-workspace',
          onRestoreFocus,
        }),
      );
    });
  }

  function renderWith(props: {
    selectedWorkspaceId: string;
    unlistedWorkspaceIds?: readonly string[];
    onClear?: () => void;
    onRestoreFocus?: () => void;
    allowUnset?: boolean;
    pendingWorkspace?: { title: string };
  }): void {
    act(() => {
      root.render(
        createElement(WorkspaceDropdown, {
          workspaces: WORKSPACES,
          onSelect,
          onAddWorkspace,
          testIdPrefix: 'home-workspace',
          ...props,
        }),
      );
    });
  }

  function query<T extends Element>(testId: string): T | null {
    return document.body.querySelector<T>(`[data-testid="${testId}"]`);
  }

  function openPicker(): void {
    const trigger = query<HTMLButtonElement>('home-workspace-select');
    act(() => {
      trigger?.click();
    });
  }

  /**
   * React installs its own `value` setter on the input node, so assigning
   * `input.value` directly leaves its change tracker thinking nothing changed
   * and `onChange` never fires. Go through the native setter instead.
   */
  function typeQuery(input: HTMLInputElement, value: string): void {
    const setValue =
      // eslint-disable-next-line @typescript-eslint/unbound-method -- always invoked with an explicit receiver below
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    act(() => {
      setValue?.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  function pressKey(input: HTMLInputElement, key: string): void {
    act(() => {
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
      );
    });
  }

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    onSelect = jest.fn();
    onAddWorkspace = jest.fn();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('focuses the search input when the picker opens', () => {
    render();
    const trigger = query<HTMLButtonElement>('home-workspace-select');
    expect(trigger?.className.split(' ')).not.toContain('transition');
    openPicker();

    const search = query<HTMLInputElement>('home-workspace-search');
    expect(search).not.toBeNull();
    expect(document.activeElement).toBe(search);
    expect(search?.className.split(' ')).not.toContain('focus-ring');
    expect(search?.className.split(' ')).toContain('outline-none');
    const listbox = document.body.querySelector('[role="listbox"]');
    // The listbox is now the OverlayScrollArea viewport; the row spacing
    // lives on the scroll-content wrapper inside it.
    expect(listbox?.className).toContain('canopy-picker-menu-list');
    expect(
      listbox?.querySelector('[data-overlay-scroll-content]')?.className,
    ).not.toContain('space-y-px');
    const popover = query<HTMLDivElement>('home-workspace-popover');
    expect(popover?.className).toContain('canopy-floating-menu');
    expect(popover?.className).toContain('canopy-picker-menu');
    expect(popover?.className).toContain('bg-quaternary');
    expect(container.contains(popover)).toBe(false);
    expect(popover?.getAttribute('data-positioned')).toBe('true');
    expect(query('home-workspace-select')?.getAttribute('aria-controls')).toBe(
      popover?.id,
    );
    expect(query('home-workspace-option-alpha')?.className.split(' ')).toEqual(
      expect.arrayContaining(['min-h-8', 'py-2', 'rounded-md', 'text-s']),
    );
    const activeOption = query<HTMLButtonElement>(
      'home-workspace-option-alpha',
    );
    expect(activeOption?.className.split(' ')).not.toContain('transition');
    // Selected rows read as the checkmark alone — PickerMenuOption withholds
    // the active background while `selected` is set.
    expect(activeOption?.className.split(' ')).not.toContain('bg-subtle');
    expect(activeOption?.className.split(' ')).not.toContain('bg-muted');
    expect(activeOption?.className.split(' ')).toEqual(
      expect.arrayContaining(['hover:bg-subtle', 'focus-visible:bg-subtle']),
    );
    expect(activeOption?.className).not.toContain('bg-fg-primary/[0.08]');
    expect(
      query<HTMLButtonElement>('home-workspace-add')?.className.split(' '),
    ).not.toContain('transition');
    expect(activeOption?.querySelector('.h-4.w-4.shrink-0')).not.toBeNull();
    expect(activeOption?.querySelector('.min-w-0.flex-1')).not.toBeNull();
    expect(
      activeOption?.querySelector('[data-picker-selected-check="true"]'),
    ).not.toBeNull();
    expect(
      popover?.style.getPropertyValue('--canopy-picker-minimum-width'),
    ).toBe('18.5rem');
    expect(
      popover?.style.getPropertyValue('--canopy-picker-maximum-width'),
    ).toBe('20.5rem');
    expect(
      query<HTMLButtonElement>('home-workspace-add')?.querySelector('svg'),
    ).not.toBeNull();
    // The add row is an accent action row: the row carries the ink and its
    // leading rail follows it through the picker-option group.
    const addRow = query<HTMLButtonElement>('home-workspace-add');
    expect(addRow?.className.split(' ')).toContain('fg-accent');
    expect(addRow?.getAttribute('data-tone')).toBe('accent');
    expect(
      addRow?.querySelector('.h-4.w-4.shrink-0')?.className.split(' '),
    ).toContain('group-data-[tone=accent]/picker-option:fg-accent');
  });

  it('uses the shared portaled semantic layer', () => {
    render();
    openPicker();

    const popover = query<HTMLDivElement>('home-workspace-popover');
    expect(popover).not.toBeNull();
    expect(popover?.classList).toContain('canopy-floating-menu');
    expect(popover?.classList).toContain('shadow-xl');
    expect(container.contains(popover)).toBe(false);
  });

  it('offers only "New project" when nothing is listed, and reports a search miss', () => {
    renderWith({
      selectedWorkspaceId: 'alpha',
      unlistedWorkspaceIds: ['alpha', 'beta', 'gamma'],
    });
    openPicker();

    expect(query('home-workspace-empty')).toBeNull();
    expect(query('home-workspace-add')).not.toBeNull();

    const search = query<HTMLInputElement>('home-workspace-search');
    if (!search) throw new Error('search input missing');
    typeQuery(search, 'zzz');
    expect(query('home-workspace-empty')?.textContent).toBe(
      'No projects match',
    );
  });

  it('filters options by the typed query', () => {
    render();
    openPicker();

    const search = query<HTMLInputElement>('home-workspace-search');
    if (!search) throw new Error('search input missing');
    typeQuery(search, 'gam');

    expect(query('home-workspace-option-gamma')).not.toBeNull();
    expect(query('home-workspace-option-alpha')).toBeNull();
    expect(query('home-workspace-option-beta')).toBeNull();
  });

  it('selects the active option with arrow keys and Enter', () => {
    render();
    openPicker();

    const search = query<HTMLInputElement>('home-workspace-search');
    if (!search) throw new Error('search input missing');

    // Starts on the selected workspace (alpha), so one ArrowDown lands on beta.
    pressKey(search, 'ArrowDown');
    pressKey(search, 'Enter');

    expect(onSelect).toHaveBeenCalledWith('beta');
  });

  describe('active row scrolling', () => {
    let scrollIntoView: jest.Mock;

    beforeEach(() => {
      scrollIntoView = jest.fn();
      Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
        configurable: true,
        value: scrollIntoView,
      });
    });

    afterEach(() => {
      Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
    });

    it('does not scroll when pointer hover changes the active row', () => {
      render();
      openPicker();
      scrollIntoView.mockClear();

      const row = query<HTMLButtonElement>('home-workspace-option-gamma');
      if (!row) throw new Error('workspace row missing');
      act(() => {
        row.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      });

      expect(scrollIntoView).not.toHaveBeenCalled();
    });

    it('scrolls when keyboard navigation changes the active row', () => {
      render();
      openPicker();
      scrollIntoView.mockClear();

      const search = query<HTMLInputElement>('home-workspace-search');
      if (!search) throw new Error('search input missing');
      pressKey(search, 'ArrowDown');

      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
    });
  });

  it('hands focus back to the caller instead of the trigger after selecting', () => {
    const onRestoreFocus = jest.fn();
    render(onRestoreFocus);
    openPicker();

    const search = query<HTMLInputElement>('home-workspace-search');
    if (!search) throw new Error('search input missing');
    pressKey(search, 'Enter');

    expect(onSelect).toHaveBeenCalledWith('alpha');
    expect(onRestoreFocus).toHaveBeenCalledTimes(1);
    expect(document.activeElement).not.toBe(
      query<HTMLButtonElement>('home-workspace-select'),
    );
  });

  it('returns focus to the trigger when dismissed with Escape', () => {
    // Escape deliberately skips onRestoreFocus (standard combobox
    // dismissal); the caller-focus hand-back is reserved for committed
    // selections.
    const onRestoreFocus = jest.fn();
    render(onRestoreFocus);
    openPicker();

    const search = query<HTMLInputElement>('home-workspace-search');
    if (!search) throw new Error('search input missing');
    pressKey(search, 'Escape');

    expect(onSelect).not.toHaveBeenCalled();
    expect(onRestoreFocus).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(
      query<HTMLButtonElement>('home-workspace-select'),
    );
  });

  it('keeps focus on the trigger when Escape is pressed on the open trigger', () => {
    const onRestoreFocus = jest.fn();
    render(onRestoreFocus);
    openPicker();

    const trigger = query<HTMLButtonElement>('home-workspace-select');
    if (!trigger) throw new Error('trigger missing');
    act(() => trigger.focus());
    act(() => {
      trigger.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        }),
      );
    });

    expect(query('home-workspace-search')).toBeNull();
    expect(onRestoreFocus).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger);
  });

  it('falls back to focusing the trigger when no caller focus target is given', () => {
    render();
    openPicker();

    const search = query<HTMLInputElement>('home-workspace-search');
    if (!search) throw new Error('search input missing');
    pressKey(search, 'Enter');

    expect(document.activeElement).toBe(
      query<HTMLButtonElement>('home-workspace-select'),
    );
  });

  it('shows an empty state and does not select on Enter with no matches', () => {
    render();
    openPicker();

    const search = query<HTMLInputElement>('home-workspace-search');
    if (!search) throw new Error('search input missing');
    typeQuery(search, 'nothing-matches');

    expect(query('home-workspace-empty')).not.toBeNull();
    pressKey(search, 'Enter');
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('keeps the add-workspace row outside the scrolling option list', () => {
    render();
    openPicker();

    const addRow = query<HTMLButtonElement>('home-workspace-add');
    expect(addRow).not.toBeNull();
    expect(addRow?.closest('ul')).toBeNull();

    act(() => {
      addRow?.click();
    });
    expect(onAddWorkspace).toHaveBeenCalledTimes(1);
  });

  it('clears the active project highlight when hovering the add row', () => {
    render();
    openPicker();

    const lastOption = query<HTMLButtonElement>('home-workspace-option-gamma');
    const addRow = query<HTMLButtonElement>('home-workspace-add');

    act(() => {
      lastOption?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    expect(lastOption?.dataset.active).toBe('true');
    expect(lastOption?.className.split(' ')).toContain('bg-subtle');

    act(() => {
      addRow?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    expect(lastOption?.dataset.active).toBeUndefined();
    expect(lastOption?.className.split(' ')).not.toContain('bg-subtle');
  });

  it('uses primary text for multi-repo project names', () => {
    const multiRepo = makeMultiRepoWorkspace('multi', 'Multi repo');
    act(() => {
      root.render(
        createElement(WorkspaceDropdown, {
          workspaces: [multiRepo],
          selectedWorkspaceId: multiRepo.id,
          onSelect,
          testIdPrefix: 'home-workspace',
        }),
      );
    });

    const triggerLabels = Array.from(
      query<HTMLElement>(
        'home-workspace-select',
      )?.querySelectorAll<HTMLSpanElement>('span') ?? [],
    ).filter((element) => element.textContent === 'Multi repo');
    const triggerLabel = triggerLabels[triggerLabels.length - 1];
    expect(triggerLabel?.className).toContain('fg-primary');
    expect(triggerLabel?.className).not.toContain('fg-info');

    openPicker();
    const option = query<HTMLButtonElement>('home-workspace-option-multi');
    expect(option?.className).toContain('fg-primary');
    expect(option?.className).not.toContain('fg-info');
    const optionLabels = Array.from(
      option?.querySelectorAll<HTMLSpanElement>('span') ?? [],
    ).filter((element) => element.textContent === 'Multi repo');
    const optionLabel = optionLabels[optionLabels.length - 1];
    // Label inherits tone from the option row (design.md: idle secondary /
    // selected primary on the row, not a hard-coded label color).
    expect(optionLabel?.className).not.toContain('fg-info');
  });

  it('uses the borderless composer capsule when requested', () => {
    act(() => {
      root.render(
        createElement(WorkspaceDropdown, {
          workspaces: WORKSPACES,
          selectedWorkspaceId: 'alpha',
          onSelect,
          testIdPrefix: 'home-workspace',
          capsule: true,
        }),
      );
    });

    const trigger = query<HTMLButtonElement>('home-workspace-select');
    expect(trigger?.className).toContain('h-8');
    expect(trigger?.className).toContain('rounded-full');
    expect(trigger?.className).toContain('gap-1');
    expect(trigger?.className).toContain('border-0');
    expect(trigger?.className).toContain('bg-transparent');
    expect(trigger?.className).toContain('hover:bg-subtle');
    expect(trigger?.querySelector('span')?.className).toContain('gap-2');
    expect(
      Array.from(trigger?.querySelectorAll('span') ?? []).some((span) =>
        span.className.includes('fg-primary'),
      ),
    ).toBe(true);
    expect(
      trigger?.querySelector<SVGElement>(
        '[data-app-icon="true"].fg-quaternary',
      ),
    ).not.toBeNull();
  });

  it('does not offer an unlisted workspace as a row', () => {
    renderWith({
      selectedWorkspaceId: 'alpha',
      unlistedWorkspaceIds: ['beta'],
    });
    openPicker();

    expect(query('home-workspace-option-alpha')).not.toBeNull();
    expect(query('home-workspace-option-gamma')).not.toBeNull();
    expect(query('home-workspace-option-beta')).toBeNull();
  });

  it('still names an unlisted workspace on the trigger when it is selected', () => {
    // Without this the label falls through to the `workspaces[0]` fallback
    // and quietly claims the chat is going somewhere it is not.
    renderWith({
      selectedWorkspaceId: 'beta',
      unlistedWorkspaceIds: ['beta'],
    });

    expect(query('home-workspace-select')?.textContent).toContain('Beta');
    expect(query('home-workspace-select')?.textContent).not.toContain('Alpha');
  });

  it('keeps an unlisted workspace out of typeahead results', () => {
    renderWith({
      selectedWorkspaceId: 'alpha',
      unlistedWorkspaceIds: ['beta'],
    });
    openPicker();
    const input = query<HTMLInputElement>('home-workspace-search');
    expect(input).not.toBeNull();
    if (input) typeQuery(input, 'bet');

    expect(query('home-workspace-option-beta')).toBeNull();
    expect(query('home-workspace-empty')).not.toBeNull();
  });

  it('draws no clear control when the caller offers none', () => {
    // The caller omits `onClear` when the current selection has nothing to
    // clear back to — the dropdown must not invent the affordance.
    renderWith({ selectedWorkspaceId: 'alpha' });

    expect(query('home-workspace-clear')).toBeNull();
  });

  it('clears the selection without opening the menu', () => {
    const onClear = jest.fn();
    renderWith({ selectedWorkspaceId: 'alpha', onClear });

    const clear = query<HTMLButtonElement>('home-workspace-clear');
    expect(clear).not.toBeNull();
    act(() => clear?.click());

    expect(onClear).toHaveBeenCalledTimes(1);
    // The control sits over the trigger, so a click must not also open it.
    expect(query('home-workspace-popover')).toBeNull();
  });

  it('does not strand focus when clearing unmounts the control', () => {
    // Clearing makes the selection unclearable, so this button unmounts while
    // focused; without an explicit restore, focus falls to document.body and
    // a keyboard user loses the composer caret.
    const onRestoreFocus = jest.fn();
    renderWith({
      selectedWorkspaceId: 'alpha',
      onClear: jest.fn(),
      onRestoreFocus,
    });

    act(() => query<HTMLButtonElement>('home-workspace-clear')?.click());

    expect(onRestoreFocus).toHaveBeenCalledTimes(1);
  });

  it('falls back to the trigger when the caller restores no focus', () => {
    renderWith({ selectedWorkspaceId: 'alpha', onClear: jest.fn() });

    act(() => query<HTMLButtonElement>('home-workspace-clear')?.click());

    expect(document.activeElement).toBe(query('home-workspace-select'));
    expect(document.activeElement).not.toBe(document.body);
  });

  it('shows a pending new project on the trigger and checks the New project row', () => {
    renderWith({
      selectedWorkspaceId: '',
      allowUnset: true,
      pendingWorkspace: { title: 'New project for acme/registrar' },
    });
    const trigger = query<HTMLButtonElement>('home-workspace-select');
    expect(trigger?.textContent).toContain('New project');
    expect(trigger?.title).toBe('New project for acme/registrar');
    expect(trigger?.getAttribute('data-pending-workspace')).toBe('true');

    openPicker();
    const addRow = query<HTMLElement>('home-workspace-add');
    // The plus icon plus the selection check, which mounts only when selected.
    expect(addRow?.querySelectorAll('svg')).toHaveLength(2);
    expect(
      Array.from(
        document.body.querySelectorAll(
          '[data-testid^="home-workspace-option-"]',
        ),
      ).some((option) => option.getAttribute('aria-selected') === 'true'),
    ).toBe(false);
    // Display only: nothing is selected on the caller's behalf.
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('ignores a pending project while a real workspace is selected', () => {
    renderWith({
      selectedWorkspaceId: 'beta',
      allowUnset: true,
      pendingWorkspace: { title: 'New project for acme/registrar' },
    });
    const trigger = query<HTMLButtonElement>('home-workspace-select');
    expect(trigger?.textContent).toContain('Beta');
    expect(trigger?.hasAttribute('data-pending-workspace')).toBe(false);
    openPicker();
    expect(
      query<HTMLElement>('home-workspace-add')?.querySelectorAll('svg'),
    ).toHaveLength(1);
  });
});
