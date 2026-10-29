/** @jest-environment jsdom */
import { act, useRef, useState, type JSX } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRoot, type Root } from 'react-dom/client';
import type { SidebarItemGroup as GroupData } from '@canopy/protocol/sidebar';
import {
  SidebarItemGroup,
  SidebarItemGroupEditor,
  sidebarItemGroupColor,
  SIDEBAR_ITEM_GROUP_SWATCHES,
  type SidebarItemGroupLabelCommit,
} from '../SidebarItemGroup';
import { sidebarItemGroupRowMenu } from '../sidebar-item-group-menu';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
const group: GroupData = {
  id: 'grp-one',
  name: 'Frontend',
  color: 'categorical-1',
  collapsed: false,
  memberIds: ['a', 'b'],
};
const unitLabel = { singular: 'task', plural: 'tasks' };

function setInputValue(input: HTMLInputElement, value: string): void {
  Object.defineProperty(input, 'value', {
    configurable: true,
    enumerable: true,
    writable: true,
    value,
  });
  void act(() => input.dispatchEvent(new Event('input', { bubbles: true })));
}

function renderEditor(
  root: Root,
  editorGroup: GroupData,
  groups: readonly Pick<GroupData, 'id' | 'name'>[],
  onLabelCommit: (label: SidebarItemGroupLabelCommit) => void,
  onClose: () => void,
): void {
  root.render(
    <SidebarItemGroupEditor
      group={editorGroup}
      groups={groups}
      unitLabel={unitLabel}
      anchorRef={{ current: null }}
      returnFocusRef={{ current: null }}
      onClose={onClose}
      onLabelCommit={onLabelCommit}
      onColorChange={jest.fn()}
      onKeepWhenEmptyChange={jest.fn()}
      onCreate={jest.fn()}
      onUngroup={jest.fn()}
    />,
  );
}

it('hides a hidden label while keeping the group named for assistive technology', () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    void act(() =>
      root.render(
        <SidebarItemGroup
          group={{ ...group, labelHidden: true }}
          groups={[group]}
          count={2}
          unitLabel={unitLabel}
          returnFocusRef={{ current: null }}
          actions={{
            onToggle: jest.fn(),
            onCreate: jest.fn(),
            onUngroup: jest.fn(),
            onLabelCommit: jest.fn(),
            onColorChange: jest.fn(),
            onKeepWhenEmptyChange: jest.fn(),
          }}
        >
          <button>Selected task</button>
        </SidebarItemGroup>,
      ),
    );
    expect(
      container.querySelector('[data-testid="sidebar-item-group-header"]'),
    ).toBeNull();
    expect(
      container.querySelector('[role="group"]')?.getAttribute('aria-label'),
    ).toBe('Frontend group');
  } finally {
    void act(() => root.unmount());
    container.remove();
  }
});

it('starts the editor with an empty draft for a stored default group name', () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    void act(() =>
      root.render(
        <SidebarItemGroupEditor
          group={{ ...group, name: 'Group 1', labelHidden: true }}
          groups={[group]}
          unitLabel={unitLabel}
          anchorRef={{ current: null }}
          returnFocusRef={{ current: null }}
          onClose={jest.fn()}
          onLabelCommit={jest.fn()}
          onColorChange={jest.fn()}
          onKeepWhenEmptyChange={jest.fn()}
          onCreate={jest.fn()}
          onUngroup={jest.fn()}
        />,
      ),
    );
    const input = document.querySelector<HTMLInputElement>(
      '[data-testid="sidebar-item-group-name"]',
    );
    expect(input?.value).toBe('');
    const showName = document.querySelector<HTMLButtonElement>(
      '[data-testid="sidebar-item-group-show-name"]',
    );
    expect(showName?.getAttribute('aria-checked')).toBe('false');
    expect(showName?.disabled).toBe(true);
  } finally {
    void act(() => root.unmount());
    container.remove();
  }
});

it('uses the next unused default name as the editor placeholder', () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const current: GroupData = { ...group, color: 'neutral' };
  const groups: readonly Pick<GroupData, 'id' | 'name'>[] = [
    current,
    { id: 'grp-default-one', name: 'Group 1' },
  ];
  try {
    void act(() => renderEditor(root, current, groups, jest.fn(), jest.fn()));
    expect(
      document.querySelector<HTMLInputElement>(
        '[data-testid="sidebar-item-group-name"]',
      )?.placeholder,
    ).toBe('Group 2');
  } finally {
    void act(() => root.unmount());
    container.remove();
  }
});

it('sends an explicit show when the switch is turned back on while a hide is queued', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const settle: Array<() => void> = [];
  // The host queues updates, so the group prop stays one step behind.
  const commit = jest.fn(
    (): Promise<void> =>
      new Promise<void>((resolve) => {
        settle.push(resolve);
      }),
  );
  try {
    void act(() => renderEditor(root, group, [group], commit, jest.fn()));
    const showName = document.querySelector<HTMLButtonElement>(
      '[data-testid="sidebar-item-group-show-name"]',
    );
    if (!showName) throw new Error('Missing show-name switch');
    void act(() => showName.click());
    expect(commit).toHaveBeenLastCalledWith({
      name: group.name,
      labelHidden: true,
    });
    void act(() => showName.click());
    expect(commit).toHaveBeenLastCalledWith({
      name: group.name,
      labelHidden: false,
    });
    expect(showName.getAttribute('aria-checked')).toBe('true');

    // The first queued commit lands while the second is still in flight: the
    // switch must not flip back to the intermediate state.
    const hidden: GroupData = { ...group, labelHidden: true };
    void act(() => renderEditor(root, hidden, [hidden], commit, jest.fn()));
    await act(async () => {
      settle[0]?.();
      await Promise.resolve();
    });
    expect(showName.getAttribute('aria-checked')).toBe('true');

    void act(() => renderEditor(root, group, [group], commit, jest.fn()));
    await act(async () => {
      settle[1]?.();
      await Promise.resolve();
    });
    expect(showName.getAttribute('aria-checked')).toBe('true');
  } finally {
    void act(() => root.unmount());
    container.remove();
  }
});

it('follows the group again after a host rolls back a rejected hide', () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const commit = jest.fn();
  try {
    void act(() => renderEditor(root, group, [group], commit, jest.fn()));
    const input = document.querySelector<HTMLInputElement>(
      '[data-testid="sidebar-item-group-name"]',
    );
    const showName = document.querySelector<HTMLButtonElement>(
      '[data-testid="sidebar-item-group-show-name"]',
    );
    if (!input || !showName) throw new Error('Missing editor controls');
    void act(() => showName.click());
    expect(commit).toHaveBeenLastCalledWith({
      name: group.name,
      labelHidden: true,
    });
    // Optimistic apply, then the host rejects and the group rolls back.
    const hidden: GroupData = { ...group, labelHidden: true };
    void act(() => renderEditor(root, hidden, [hidden], commit, jest.fn()));
    expect(showName.getAttribute('aria-checked')).toBe('false');
    void act(() => renderEditor(root, group, [group], commit, jest.fn()));
    expect(showName.getAttribute('aria-checked')).toBe('true');

    setInputValue(input, 'Renamed');
    void act(() =>
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      ),
    );
    expect(commit).toHaveBeenLastCalledWith({ name: 'Renamed' });
  } finally {
    void act(() => root.unmount());
    container.remove();
  }
});

it('follows a rename from another surface while the draft is untouched', () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const commit = jest.fn();
  const close = (): void => root.render(null);
  try {
    void act(() => renderEditor(root, group, [group], commit, close));
    const input = document.querySelector<HTMLInputElement>(
      '[data-testid="sidebar-item-group-name"]',
    );
    if (!input) throw new Error('Missing name input');
    const renamed: GroupData = { ...group, name: 'Platform' };
    void act(() => renderEditor(root, renamed, [renamed], commit, close));
    expect(input.value).toBe('Platform');
    void act(() =>
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="sidebar-item-group-editor-close"]',
        )
        ?.click(),
    );
    expect(commit).not.toHaveBeenCalled();
  } finally {
    void act(() => root.unmount());
    container.remove();
  }
});

it('keeps an edited draft when another surface renames the group', () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const commit = jest.fn();
  const close = (): void => root.render(null);
  try {
    void act(() => renderEditor(root, group, [group], commit, close));
    const input = document.querySelector<HTMLInputElement>(
      '[data-testid="sidebar-item-group-name"]',
    );
    if (!input) throw new Error('Missing name input');
    setInputValue(input, 'Mine');
    const renamed: GroupData = { ...group, name: 'Platform' };
    void act(() => renderEditor(root, renamed, [renamed], commit, close));
    expect(input.value).toBe('Mine');
    void act(() =>
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="sidebar-item-group-editor-close"]',
        )
        ?.click(),
    );
    expect(commit).toHaveBeenLastCalledWith({ name: 'Mine' });
  } finally {
    void act(() => root.unmount());
    container.remove();
  }
});

it('turns on the show-name switch when naming a blank group and commits on Enter', () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const defaultGroup: GroupData = {
    ...group,
    name: 'Group 1',
    color: 'neutral',
    labelHidden: true,
  };
  const commit = jest.fn();
  try {
    void act(() =>
      renderEditor(root, defaultGroup, [defaultGroup], commit, jest.fn()),
    );
    const input = document.querySelector<HTMLInputElement>(
      '[data-testid="sidebar-item-group-name"]',
    );
    const showName = document.querySelector<HTMLButtonElement>(
      '[data-testid="sidebar-item-group-show-name"]',
    );
    expect(input?.value).toBe('');
    expect(showName?.disabled).toBe(true);
    expect(showName?.getAttribute('aria-checked')).toBe('false');
    if (!input || !showName) throw new Error('Missing editor controls');
    setInputValue(input, 'Frontend');
    expect(showName.disabled).toBe(false);
    expect(showName.getAttribute('aria-checked')).toBe('true');
    void act(() =>
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      ),
    );
    // Hosts show a newly named default group on their own, so the commit
    // stays a plain rename that older hosts accept.
    expect(commit).toHaveBeenCalledWith({ name: 'Frontend' });
  } finally {
    void act(() => root.unmount());
    container.remove();
  }
});

it('keeps default-format drafts hidden and commits switch changes immediately', () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const commit = jest.fn();
  try {
    void act(() => renderEditor(root, group, [group], commit, jest.fn()));
    const input = document.querySelector<HTMLInputElement>(
      '[data-testid="sidebar-item-group-name"]',
    );
    const showName = document.querySelector<HTMLButtonElement>(
      '[data-testid="sidebar-item-group-show-name"]',
    );
    if (!input || !showName) throw new Error('Missing editor controls');
    setInputValue(input, 'Group 2');
    expect(showName.disabled).toBe(true);
    expect(showName.getAttribute('aria-checked')).toBe('false');
    setInputValue(input, 'Frontend');
    expect(showName.disabled).toBe(false);
    expect(showName.getAttribute('aria-checked')).toBe('true');
    void act(() => showName.click());
    expect(commit).toHaveBeenLastCalledWith({
      name: 'Frontend',
      labelHidden: true,
    });
  } finally {
    void act(() => root.unmount());
    container.remove();
  }
});

it('commits a blank name only when the stored name was not already the default', () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const commit = jest.fn();
  try {
    void act(() => renderEditor(root, group, [group], commit, jest.fn()));
    const input = document.querySelector<HTMLInputElement>(
      '[data-testid="sidebar-item-group-name"]',
    );
    if (!input) throw new Error('Missing group name input');
    setInputValue(input, '');
    input.focus();
    void act(() => input.blur());
    expect(commit).toHaveBeenCalledWith({ name: '' });
  } finally {
    void act(() => root.unmount());
    container.remove();
  }
});

it('does not commit an unchanged default name when the editor closes', () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const commit = jest.fn();
  const defaultGroup: GroupData = {
    ...group,
    name: 'Group 1',
    color: 'neutral',
    labelHidden: true,
  };
  try {
    void act(() =>
      renderEditor(root, defaultGroup, [defaultGroup], commit, () => {
        root.render(null);
      }),
    );
    void act(() =>
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="sidebar-item-group-editor-close"]',
        )
        ?.click(),
    );
    expect(commit).not.toHaveBeenCalled();
  } finally {
    void act(() => root.unmount());
    container.remove();
  }
});

it('commits a new-item action with the current name', () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const create = jest.fn();
  const commit = jest.fn();
  try {
    void act(() =>
      root.render(
        <SidebarItemGroupEditor
          group={group}
          groups={[group]}
          unitLabel={unitLabel}
          anchorRef={{ current: null }}
          returnFocusRef={{ current: null }}
          onClose={(): void => undefined}
          onLabelCommit={commit}
          onColorChange={jest.fn()}
          onKeepWhenEmptyChange={jest.fn()}
          onCreate={create}
          onUngroup={jest.fn()}
        />,
      ),
    );
    const input = document.querySelector<HTMLInputElement>(
      '[data-testid="sidebar-item-group-name"]',
    );
    const newItem = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    ).find((button) => button.textContent === 'New task in group');
    if (!input || !newItem) throw new Error('Missing editor menu controls');
    setInputValue(input, 'New task name');
    input.focus();
    newItem.focus();
    void act(() => newItem.click());
    expect(commit).toHaveBeenCalledWith({ name: 'New task name' });
    expect(create).toHaveBeenCalledTimes(1);
  } finally {
    void act(() => root.unmount());
    container.remove();
  }
});

it('discards an ungrouped draft rather than committing it', () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const ungroup = jest.fn();
  const commit = jest.fn();
  try {
    void act(() =>
      root.render(
        <SidebarItemGroupEditor
          group={group}
          groups={[group]}
          unitLabel={unitLabel}
          anchorRef={{ current: null }}
          returnFocusRef={{ current: null }}
          onClose={(): void => undefined}
          onLabelCommit={commit}
          onColorChange={jest.fn()}
          onKeepWhenEmptyChange={jest.fn()}
          onCreate={jest.fn()}
          onUngroup={ungroup}
        />,
      ),
    );
    const input = document.querySelector<HTMLInputElement>(
      '[data-testid="sidebar-item-group-name"]',
    );
    const ungroupAction = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    ).find((button) => button.textContent === 'Ungroup');
    if (!input || !ungroupAction)
      throw new Error('Missing group name input or ungroup action');
    setInputValue(input, 'Discard this name');
    input.focus();
    ungroupAction.focus();
    void act(() => ungroupAction.click());
    expect(commit).not.toHaveBeenCalled();
    expect(ungroup).toHaveBeenCalledTimes(1);
  } finally {
    void act(() => root.unmount());
    container.remove();
  }
});

it('keeps the placeholder when the group color prop changes', () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  function Host(): JSX.Element {
    const [current, setCurrent] = useState(group);
    return (
      <>
        <button
          data-testid="change-group-color"
          onClick={(): void =>
            setCurrent({ ...current, color: 'categorical-2' })
          }
        >
          Change color
        </button>
        <SidebarItemGroupEditor
          group={current}
          groups={[current]}
          unitLabel={unitLabel}
          anchorRef={{ current: null }}
          returnFocusRef={{ current: null }}
          onClose={jest.fn()}
          onLabelCommit={jest.fn()}
          onColorChange={jest.fn()}
          onKeepWhenEmptyChange={jest.fn()}
          onCreate={jest.fn()}
          onUngroup={jest.fn()}
        />
      </>
    );
  }
  try {
    void act(() => root.render(<Host />));
    const input = document.querySelector<HTMLInputElement>(
      '[data-testid="sidebar-item-group-name"]',
    );
    expect(input?.placeholder).toBe('Group 1');
    void act(() =>
      container
        .querySelector<HTMLButtonElement>('[data-testid="change-group-color"]')
        ?.click(),
    );
    expect(input?.placeholder).toBe('Group 1');
  } finally {
    void act(() => root.unmount());
    container.remove();
  }
});

it.each([
  { name: 'Group 1', labelHidden: true, collapsed: true },
  { name: 'Frontend', labelHidden: false, collapsed: false },
])(
  'labels the group header correctly ($name/$collapsed)',
  ({ name, labelHidden, collapsed }) => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const toggle = jest.fn();
    const actions = {
      onToggle: toggle,
      onCreate: jest.fn(),
      onUngroup: jest.fn(),
      onLabelCommit: jest.fn(),
      onColorChange: jest.fn(),
      onKeepWhenEmptyChange: jest.fn(),
    };
    try {
      void act(() =>
        root.render(
          <SidebarItemGroup
            group={{ ...group, name, labelHidden, collapsed }}
            groups={[group]}
            count={2}
            unitLabel={unitLabel}
            returnFocusRef={{ current: null }}
            actions={actions}
          >
            <button data-testid="member">Selected task</button>
          </SidebarItemGroup>,
        ),
      );
      expect(
        container.querySelector('[data-testid="sidebar-item-group-header"]') !==
          null,
      ).toBe(true);
      expect(
        container
          .querySelector('[data-testid="sidebar-item-group-menu-trigger"]')
          ?.getAttribute('aria-label'),
      ).toBe(`More actions for ${name}`);
      const groupElement = container.querySelector('[role="group"]');
      if (labelHidden) {
        expect(groupElement?.getAttribute('aria-label')).toBe(`${name} group`);
        expect(groupElement?.getAttribute('aria-labelledby')).toBeNull();
        const hiddenLabel = container.querySelector(
          '[data-testid="sidebar-item-group-toggle"] span[id]',
        );
        expect(hiddenLabel?.className).toContain('sr-only');
        expect(hiddenLabel?.textContent).toBe('Group 1, 2 tasks');
        expect(
          container
            .querySelector('[data-testid="sidebar-item-group-counter"]')
            ?.getAttribute('aria-hidden'),
        ).toBe('true');
        expect(
          container.querySelector('[data-testid="sidebar-item-group-counter"]')
            ?.textContent,
        ).toBe('2 tasks');
      } else {
        expect(groupElement?.getAttribute('aria-label')).toBeNull();
        expect(groupElement?.getAttribute('aria-labelledby')).toBe(
          container.querySelector(
            '[data-testid="sidebar-item-group-toggle"] span[id]',
          )?.id,
        );
        expect(
          container.querySelector(
            '[data-testid="sidebar-item-group-toggle"] span[id]',
          )?.textContent,
        ).toBe('Frontend');
      }
      const rail = container.querySelector<HTMLButtonElement>(
        '[data-testid="sidebar-item-group-rail"]',
      );
      expect(rail?.tabIndex).toBe(-1);
      void act(() => rail?.click());
      expect(toggle).toHaveBeenCalledTimes(1);
      if (collapsed) expect(container.textContent).toContain('2 tasks');
      expect(container.querySelector('[data-testid="member"]')).not.toBeNull();
    } finally {
      void act(() => root.unmount());
      container.remove();
    }
  },
);

it('editor focuses its labelled input, applies semantic color, and cancels drafts on Escape', () => {
  const anchor = document.createElement('button');
  document.body.append(anchor);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const commit = jest.fn();
  const color = jest.fn();
  const renderEditor = (): void => {
    root.render(
      <SidebarItemGroupEditor
        group={group}
        groups={[group]}
        unitLabel={unitLabel}
        anchorRef={{ current: anchor }}
        returnFocusRef={{ current: anchor }}
        onClose={() => root.render(null)}
        onLabelCommit={commit}
        onColorChange={color}
        onKeepWhenEmptyChange={jest.fn()}
        onCreate={jest.fn()}
        onUngroup={jest.fn()}
      />,
    );
  };
  try {
    act(renderEditor);
    const input = document.querySelector<HTMLInputElement>(
      '[data-testid="sidebar-item-group-name"]',
    );
    expect(document.activeElement).toBe(input);
    expect(document.querySelector('label')?.htmlFor).toBe(input?.id);
    if (!input) throw new Error('Missing group name input');
    setInputValue(input, 'Changed draft');
    void act(() =>
      document
        .querySelector<HTMLButtonElement>('[aria-label="Color 2"]')
        ?.click(),
    );
    expect(color).toHaveBeenCalledWith('categorical-2');
    void act(() =>
      input?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      ),
    );
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(commit).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(anchor);
  } finally {
    void act(() => root.unmount());
    container.remove();
    anchor.remove();
  }
});

it.each([false, true])(
  'offers group membership only to eligible independent rows (%s)',
  (eligible) => {
    const callback = jest.fn();
    const build = (
      groups: GroupData[],
      currentGroupId?: string,
    ): ReturnType<typeof sidebarItemGroupRowMenu> =>
      sidebarItemGroupRowMenu({
        groups,
        currentGroupId,
        eligible,
        unitLabel,
        onNewGroup: callback,
        onMove: callback,
        onEdit: callback,
        onToggle: callback,
        onRemove: callback,
      });
    if (!eligible) {
      expect(build([group], group.id)).toEqual([]);
      return;
    }
    expect(build([])[0]?.label).toBe('Add to new group');
    const ungrouped = build([group])[0];
    expect(ungrouped?.kind).toBe('submenu');
    expect(ungrouped?.submenu?.map((item) => item.label)).toEqual([
      'New group',
      'Frontend',
    ]);
    const defaultGroup: GroupData = {
      ...group,
      name: 'Group 1',
      color: 'neutral',
      labelHidden: true,
      collapsed: true,
    };
    const grouped = build([defaultGroup], defaultGroup.id)[0];
    expect(grouped?.submenu?.map((item) => item.label)).toEqual([
      'Group 1',
      'Edit group…',
      'Expand group',
      'Remove from group',
      'Move to',
      'New group',
    ]);
    expect(
      build([group, defaultGroup])[0]?.submenu?.map((item) => item.label),
    ).toEqual(['New group', 'Frontend', 'Group 1']);
  },
);

it('identifies a hidden group by its stored name in the rail menu', () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const hiddenGroup: GroupData = {
    ...group,
    name: 'Group 1',
    color: 'neutral',
    labelHidden: true,
  };
  try {
    void act(() =>
      root.render(
        <SidebarItemGroup
          group={hiddenGroup}
          groups={[hiddenGroup]}
          count={2}
          unitLabel={unitLabel}
          returnFocusRef={{ current: null }}
          actions={{
            onToggle: jest.fn(),
            onCreate: jest.fn(),
            onUngroup: jest.fn(),
            onLabelCommit: jest.fn(),
            onColorChange: jest.fn(),
            onKeepWhenEmptyChange: jest.fn(),
          }}
        >
          <span>Member</span>
        </SidebarItemGroup>,
      ),
    );
    void act(() =>
      container
        .querySelector('[data-testid="sidebar-item-group-rail"]')
        ?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })),
    );
    expect(
      document.querySelector('[data-testid="sidebar-item-group-menu"]')
        ?.textContent,
    ).toContain('Group 1 · 2 tasks');
  } finally {
    void act(() => root.unmount());
    container.remove();
  }
});

it('leads every group menu row with an icon and keeps Ungroup in its own last group', () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    void act(() =>
      root.render(
        <SidebarItemGroup
          group={group}
          groups={[group]}
          count={2}
          unitLabel={unitLabel}
          returnFocusRef={{ current: null }}
          actions={{
            onToggle: jest.fn(),
            onCreate: jest.fn(),
            onUngroup: jest.fn(),
            onLabelCommit: jest.fn(),
            onColorChange: jest.fn(),
            onKeepWhenEmptyChange: jest.fn(),
          }}
        >
          <span>Member</span>
        </SidebarItemGroup>,
      ),
    );
    void act(() =>
      container
        .querySelector('[data-testid="sidebar-item-group-rail"]')
        ?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })),
    );
    const menu = document.querySelector(
      '[data-testid="sidebar-item-group-menu"]',
    );
    const rows = Array.from(menu?.querySelectorAll('[role="menuitem"]') ?? []);
    expect(rows.map((row) => row.textContent)).toEqual([
      'Edit group…',
      'Collapse group',
      'New task in group',
      'Ungroup',
    ]);
    for (const row of rows) {
      expect(row.querySelector('[aria-hidden="true"] svg')).not.toBeNull();
    }
    const ungroup = rows.at(-1);
    expect(ungroup?.getAttribute('data-testid')).toBe(
      'sidebar-item-group-ungroup',
    );
    expect(ungroup?.previousElementSibling?.getAttribute('role')).toBe(
      'separator',
    );
    expect(menu?.querySelectorAll('[role="separator"]')).toHaveLength(1);
  } finally {
    void act(() => root.unmount());
    container.remove();
  }
});

it('gives every group action a distinct glyph without early access', () => {
  const build = (
    groups: GroupData[],
    currentGroupId?: string,
  ): ReturnType<typeof sidebarItemGroupRowMenu> =>
    sidebarItemGroupRowMenu({
      groups,
      currentGroupId,
      eligible: true,
      unitLabel,
      onNewGroup: jest.fn(),
      onMove: jest.fn(),
      onEdit: jest.fn(),
      onToggle: jest.fn(),
      onRemove: jest.fn(),
    });
  for (const collapsed of [false, true]) {
    const current = { ...group, collapsed };
    const other: GroupData = { ...group, id: 'other', color: 'categorical-2' };
    for (const groups of [[], [current], [current, other]]) {
      for (const currentGroupId of [undefined, current.id]) {
        const items = build(groups, currentGroupId);
        const actions = [...items, ...(items[0]?.submenu ?? [])].filter(
          (item) => item.kind !== 'label',
        );
        for (const item of actions) expect(item.icon).not.toBeNull();
        const coloredKeys = new Set(
          groups.map((destination) => `sidebar-group-${destination.id}`),
        );
        if (groups.some((candidate) => candidate.id === currentGroupId)) {
          coloredKeys.add('sidebar-group-organize');
        }
        const glyphs = actions
          .filter((item) => !coloredKeys.has(item.key))
          .map((item) => renderToStaticMarkup(<>{item.icon}</>));
        expect(new Set(glyphs).size).toBe(glyphs.length);
        for (const destination of groups.filter(
          (candidate) => candidate.id !== currentGroupId,
        )) {
          const item = actions.find(
            (candidate) => candidate.key === `sidebar-group-${destination.id}`,
          );
          const dot = renderToStaticMarkup(<>{item?.icon}</>);
          expect(dot).toContain(
            `background-color:${sidebarItemGroupColor(destination.color)}`,
          );
          expect(dot).toContain('rounded-full');
          expect(dot).not.toContain('<svg');
        }
      }
    }
  }
});

it('exports all seven labelled token swatches without conflating stored keys with CSS', () => {
  expect(SIDEBAR_ITEM_GROUP_SWATCHES.map((option) => option.label)).toEqual([
    'Neutral',
    'Color 1',
    'Color 2',
    'Color 3',
    'Color 4',
    'Color 5',
    'Color 6',
  ]);
  expect(
    SIDEBAR_ITEM_GROUP_SWATCHES.every((option) =>
      option.color.startsWith('var(--'),
    ),
  ).toBe(true);
});

it('returns a rail-invoked editor to the member even when the group has a header', () => {
  const member = document.createElement('button');
  document.body.append(member);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    void act(() =>
      root.render(
        <SidebarItemGroup
          group={group}
          groups={[group]}
          count={2}
          unitLabel={unitLabel}
          returnFocusRef={{ current: member }}
          actions={{
            onToggle: jest.fn(),
            onCreate: jest.fn(),
            onUngroup: jest.fn(),
            onLabelCommit: jest.fn(),
            onColorChange: jest.fn(),
            onKeepWhenEmptyChange: jest.fn(),
          }}
        >
          <span>Member</span>
        </SidebarItemGroup>,
      ),
    );
    void act(() =>
      container
        .querySelector('[data-testid="sidebar-item-group-rail"]')
        ?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })),
    );
    void act(() =>
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="sidebar-item-group-edit"]',
        )
        ?.click(),
    );
    void act(() =>
      document
        .querySelector('[data-testid="sidebar-item-group-name"]')
        ?.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
        ),
    );
    expect(document.activeElement).toBe(member);
  } finally {
    void act(() => root.unmount());
    container.remove();
    member.remove();
  }
});

it('leaves new-item focus with the host instead of returning to the editor invoker', () => {
  const created = document.createElement('button');
  document.body.append(created);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    void act(() =>
      root.render(
        <SidebarItemGroup
          group={group}
          groups={[group]}
          count={2}
          unitLabel={unitLabel}
          returnFocusRef={{ current: null }}
          actions={{
            onToggle: jest.fn(),
            onCreate: () => created.focus(),
            onUngroup: jest.fn(),
            onLabelCommit: jest.fn(),
            onColorChange: jest.fn(),
            onKeepWhenEmptyChange: jest.fn(),
          }}
        >
          <span>Member</span>
        </SidebarItemGroup>,
      ),
    );
    void act(() =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="sidebar-item-group-menu-trigger"]',
        )
        ?.click(),
    );
    void act(() =>
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="sidebar-item-group-edit"]',
        )
        ?.click(),
    );
    const create = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'),
    ).find((button) => button.textContent === 'New task in group');
    expect(create).toBeDefined();
    void act(() => create?.click());
    expect(document.activeElement).toBe(created);
  } finally {
    void act(() => root.unmount());
    container.remove();
    created.remove();
  }
});

it('rail-menu collapse moves focus to the visible header when the first member disappears', () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  function Host(): JSX.Element {
    const [value, setValue] = useState(group);
    const memberRef = useRef<HTMLButtonElement | null>(null);
    return (
      <SidebarItemGroup
        group={value}
        groups={[value]}
        count={2}
        unitLabel={unitLabel}
        returnFocusRef={memberRef}
        actions={{
          onToggle: () => setValue({ ...value, collapsed: !value.collapsed }),
          onCreate: jest.fn(),
          onUngroup: jest.fn(),
          onLabelCommit: jest.fn(),
          onColorChange: jest.fn(),
          onKeepWhenEmptyChange: jest.fn(),
        }}
      >
        {!value.collapsed && <button ref={memberRef}>First member</button>}
      </SidebarItemGroup>
    );
  }
  try {
    void act(() => root.render(<Host />));
    void act(() =>
      container
        .querySelector('[data-testid="sidebar-item-group-rail"]')
        ?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })),
    );
    const collapse = Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        '[data-testid="sidebar-item-group-menu"] button',
      ),
    ).find((button) => button.textContent === 'Collapse group');
    expect(collapse).toBeDefined();
    void act(() => collapse?.click());
    expect(document.activeElement).toBe(
      container.querySelector('[data-testid="sidebar-item-group-toggle"]'),
    );
  } finally {
    void act(() => root.unmount());
    container.remove();
  }
});

it('reports editor identity only while the actual editor is mounted', () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const report = jest.fn();
  void act(() =>
    root.render(
      <SidebarItemGroupEditor
        group={group}
        groups={[group]}
        unitLabel={unitLabel}
        anchorRef={{ current: null }}
        returnFocusRef={{ current: null }}
        onClose={jest.fn()}
        onLabelCommit={jest.fn()}
        onColorChange={jest.fn()}
        onKeepWhenEmptyChange={jest.fn()}
        onCreate={jest.fn()}
        onUngroup={jest.fn()}
        onEditorChange={report}
      />,
    ),
  );
  expect(report).toHaveBeenLastCalledWith('grp-one');
  void act(() => root.unmount());
  expect(report).toHaveBeenLastCalledWith(null);
  container.remove();
});

describe('canCreate', () => {
  function renderGroup(canCreate?: boolean): {
    readonly container: HTMLDivElement;
    readonly onCreate: jest.Mock;
    readonly cleanup: () => void;
  } {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const onCreate = jest.fn();
    void act(() =>
      root.render(
        <SidebarItemGroup
          group={group}
          groups={[group]}
          count={2}
          unitLabel={unitLabel}
          returnFocusRef={{ current: null }}
          {...(canCreate === undefined ? {} : { canCreate })}
          actions={{
            onToggle: jest.fn(),
            onCreate,
            onUngroup: jest.fn(),
            onLabelCommit: jest.fn(),
            onColorChange: jest.fn(),
            onKeepWhenEmptyChange: jest.fn(),
          }}
        >
          <span>Member</span>
        </SidebarItemGroup>,
      ),
    );
    return {
      container,
      onCreate,
      cleanup: (): void => {
        void act(() => root.unmount());
        container.remove();
      },
    };
  }
  const click = (selector: string, within: ParentNode = document): void =>
    void act(() => within.querySelector<HTMLElement>(selector)?.click());
  const createItems = (): HTMLElement[] =>
    Array.from(
      document.querySelectorAll<HTMLElement>(
        '[role="menuitem"], [role="dialog"] [role="menuitem"]',
      ),
    ).filter((item) => item.textContent === 'New task in group');

  it('offers the header +, the menu item and the editor item by default', () => {
    const { container, onCreate, cleanup } = renderGroup();
    try {
      expect(
        container.querySelector('[data-testid="sidebar-item-group-create"]'),
      ).not.toBeNull();
      click('[data-testid="sidebar-item-group-create"]', container);
      expect(onCreate).toHaveBeenCalledTimes(1);

      click('[data-testid="sidebar-item-group-menu-trigger"]', container);
      expect(createItems()).toHaveLength(1);
      click('[data-testid="sidebar-item-group-edit"]');
      expect(createItems()).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  it('withholds the header +, the menu item and the editor item when false', () => {
    const { container, onCreate, cleanup } = renderGroup(false);
    try {
      // The menu trigger is still there: only creation is withheld.
      expect(
        container.querySelector(
          '[data-testid="sidebar-item-group-menu-trigger"]',
        ),
      ).not.toBeNull();
      expect(
        container.querySelector('[data-testid="sidebar-item-group-create"]'),
      ).toBeNull();

      click('[data-testid="sidebar-item-group-menu-trigger"]', container);
      expect(createItems()).toHaveLength(0);
      expect(
        document.querySelector('[data-testid="sidebar-item-group-ungroup"]'),
      ).not.toBeNull();

      click('[data-testid="sidebar-item-group-edit"]');
      expect(
        document.querySelector('[data-testid="sidebar-item-group-editor"]'),
      ).not.toBeNull();
      expect(createItems()).toHaveLength(0);
      expect(
        Array.from(
          document.querySelectorAll('[role="dialog"] [role="menuitem"]'),
        ).map((item) => item.textContent),
      ).toEqual(['Ungroup']);
      expect(onCreate).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });
});

it('shows an empty group named, and toggles whether it is removed when empty', () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const onKeepWhenEmptyChange = jest.fn();
  const empty: GroupData = {
    ...group,
    labelHidden: true,
    keepWhenEmpty: true,
    memberIds: [],
  };
  try {
    void act(() =>
      root.render(
        <SidebarItemGroup
          group={empty}
          groups={[empty]}
          count={0}
          unitLabel={unitLabel}
          returnFocusRef={{ current: null }}
          actions={{
            onToggle: jest.fn(),
            onCreate: jest.fn(),
            onUngroup: jest.fn(),
            onLabelCommit: jest.fn(),
            onColorChange: jest.fn(),
            onKeepWhenEmptyChange,
          }}
        >
          {null}
        </SidebarItemGroup>,
      ),
    );
    expect(
      container.querySelector('[data-testid="sidebar-item-group-toggle"]')
        ?.textContent,
    ).toBe('Frontend');
    void act(() =>
      root.render(
        <SidebarItemGroupEditor
          group={empty}
          groups={[empty]}
          unitLabel={unitLabel}
          anchorRef={{ current: null }}
          returnFocusRef={{ current: null }}
          onClose={jest.fn()}
          onLabelCommit={jest.fn()}
          onColorChange={jest.fn()}
          onKeepWhenEmptyChange={onKeepWhenEmptyChange}
          onCreate={jest.fn()}
          onUngroup={jest.fn()}
        />,
      ),
    );
    const toggle = document.querySelector<HTMLButtonElement>(
      '[data-testid="sidebar-item-group-remove-when-empty"]',
    );
    expect(toggle?.getAttribute('aria-checked')).toBe('false');
    void act(() => toggle?.click());
    expect(onKeepWhenEmptyChange).toHaveBeenCalledWith(false);
  } finally {
    void act(() => root.unmount());
    container.remove();
  }
});
