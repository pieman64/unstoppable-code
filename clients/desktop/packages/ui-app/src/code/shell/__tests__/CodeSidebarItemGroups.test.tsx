/** @jest-environment jsdom */
import { act, useContext, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  CodeSidebarItemGroups,
  type CodeSidebarItemGroupCommands,
} from '../sidebar/CodeSidebarItemGroups';
import { buildSidebarItemGroupBlocks } from '../sidebar/sidebar-item-groups-model';
import { WorktreeSortableStateContext } from '../sortable-state-context';
import type { WorktreeMenuItem } from '@canopy/ui-shared/components';
import type { SidebarItemGroup } from '@canopy/protocol/sidebar';
import type { SidebarSortMode } from '../sidebar/sidebar-ordering';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
function menuLeaves(menu: readonly WorktreeMenuItem[]): WorktreeMenuItem[] {
  return menu.flatMap((item) =>
    item.kind === 'submenu' ? menuLeaves(item.submenu) : [item],
  );
}
function Handle({ id }: { id: string }): JSX.Element {
  const state = useContext(WorktreeSortableStateContext);
  return (
    <button data-item={id} {...state?.attributes} {...state?.listeners}>
      Move {id}
    </button>
  );
}
describe('Code groups', () => {
  let root: Root;
  let container: HTMLDivElement;
  const group: SidebarItemGroup = {
    id: 'grp-one',
    name: 'Release',
    color: 'neutral',
    collapsed: false,
    memberIds: ['a'],
  };
  const moveItem = jest.fn();
  const moveGroup = jest.fn();
  const reorderChild = jest.fn();
  const commands: CodeSidebarItemGroupCommands = {
    create: jest.fn(),
    update: jest.fn(),
    ungroup: jest.fn(),
    moveItem,
    moveGroup,
  };
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    jest.clearAllMocks();
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });
  function render(
    mode: SidebarSortMode = 'manual',
    collapsed = false,
    canDrag = true,
    name = 'Release',
    mutable = true,
    additionalGroups: readonly SidebarItemGroup[] = [],
    labelHidden = false,
  ): void {
    const groups: SidebarItemGroup[] = [
      {
        ...group,
        collapsed,
        name,
        ...(labelHidden ? { labelHidden: true } : {}),
      },
      ...additionalGroups,
    ];
    const blocks = buildSidebarItemGroupBlocks(
      [
        { rootId: 'a', itemIds: ['a', 'child-1', 'child-2'] },
        { rootId: 'b', itemIds: ['b'] },
      ],
      groups,
      mode,
      'child-2',
    );
    act(() =>
      root.render(
        <CodeSidebarItemGroups
          blocks={blocks}
          selectedItemId="child-2"
          groups={groups}
          mode={mode}
          commands={mutable ? commands : undefined}
          renderRow={(id, menu) => (
            <div>
              <Handle id={id} />
              {menuLeaves(menu).map((item) => (
                <button key={item.key} onClick={item.onSelect}>
                  {item.label}
                </button>
              ))}
            </div>
          )}
          renderPreview={(id) => <span>{id}</span>}
          onCreate={jest.fn()}
          onError={jest.fn()}
          canDragRow={() => canDrag}
          renderStatus={() => null}
          pendingGroupId={null}
          placeholder={<span data-testid="creating">Creating</span>}
          onReorderChild={reorderChild}
        />,
      ),
    );
  }
  it('read-only groups expand locally and collapse back while retaining the selected child', () => {
    render('manual', true, true, 'Release', false);
    const toggle = container.querySelector<HTMLButtonElement>(
      '[data-testid="sidebar-item-group-toggle"]',
    );
    expect(toggle?.disabled).toBe(false);
    act(() => toggle?.click());
    expect(container.querySelector('[data-item="child-1"]')).not.toBeNull();
    act(() => toggle?.click());
    expect(container.querySelector('[data-item="child-1"]')).toBeNull();
    expect(container.querySelector('[data-item="child-2"]')).not.toBeNull();
    expect(commands.update).not.toHaveBeenCalled();
  });
  function key(id: string, value: string): void {
    const handle = container.querySelector(`[data-item="${id}"]`);
    act(() => {
      handle?.dispatchEvent(
        new KeyboardEvent('keydown', { key: value, bubbles: true }),
      );
    });
  }
  it('closes a row group editor when the host loses mutation authority', () => {
    render();
    const edit = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.startsWith('Edit group'),
    );
    expect(edit).toBeDefined();
    act(() => edit?.click());
    expect(
      document.querySelector('[data-testid="sidebar-item-group-name"]'),
    ).not.toBeNull();
    render('manual', false, true, 'Release', false);
    expect(
      document.querySelector('[data-testid="sidebar-item-group-name"]'),
    ).toBeNull();
  });
  it('expanded hidden-label groups expose a keyboard-focusable rail without a header', () => {
    render('manual', false, true, 'Group 1', true, [], true);
    expect(
      container.querySelector('[data-testid="sidebar-item-group-header"]'),
    ).toBeNull();
    const rail = container.querySelector<HTMLButtonElement>(
      '[data-testid="sidebar-item-group-rail"]',
    );
    expect(rail?.tabIndex).toBe(0);
    act((): void => {
      rail?.focus();
    });
    expect(document.activeElement).toBe(rail);
    act((): void => {
      rail?.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: ' ',
          bubbles: true,
        }),
      );
    });
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      'Moving group',
    );
  });
  it('shows a group name in the header when its label is not hidden', () => {
    render();
    expect(
      container.querySelector('[data-testid="sidebar-item-group-header"]')
        ?.textContent,
    ).toContain('Release');
  });
  it('commits a plain rename without a visibility field', () => {
    render();
    const edit = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.startsWith('Edit group'),
    );
    expect(edit).toBeDefined();
    act(() => edit?.click());
    const input = document.querySelector<HTMLInputElement>(
      '[data-testid="sidebar-item-group-name"]',
    );
    expect(input).not.toBeNull();
    act(() => {
      if (!input) return;
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set?.call(input, 'Release train');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() =>
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="sidebar-item-group-editor-close"]',
        )
        ?.click(),
    );
    expect(commands.update).toHaveBeenCalledWith('grp-one', {
      name: 'Release train',
    });
  });
  it('lists hidden default-named groups by their stored name in row menus', () => {
    const defaultGroup: SidebarItemGroup = {
      id: 'grp-default',
      name: 'Group 1',
      color: 'neutral',
      collapsed: false,
      labelHidden: true,
      memberIds: ['b'],
    };
    render('manual', false, true, 'Release', true, [defaultGroup]);
    const menuLabels = Array.from(container.querySelectorAll('button')).map(
      (button) => button.textContent,
    );
    expect(menuLabels).toContain('Move to');
    expect(menuLabels).toContain('Group 1');
  });
  it('lists row menu groups in the order the left nav shows them', () => {
    const groups: SidebarItemGroup[] = [
      { ...group, id: 'grp-later', name: 'Later', memberIds: ['c'] },
      { ...group, id: 'grp-unshown', name: 'Unshown', memberIds: ['d'] },
      { ...group, id: 'grp-first', name: 'First', memberIds: ['a'] },
    ];
    const menus = new Map<string, readonly WorktreeMenuItem[]>();
    act(() =>
      root.render(
        <CodeSidebarItemGroups
          blocks={buildSidebarItemGroupBlocks(
            [
              { rootId: 'a', itemIds: ['a'] },
              { rootId: 'b', itemIds: ['b'] },
              { rootId: 'c', itemIds: ['c'] },
            ],
            groups,
            'manual',
          )}
          groups={groups}
          mode="manual"
          commands={commands}
          renderRow={(id, menu) => {
            menus.set(id, menu);
            return <span>{id}</span>;
          }}
          renderPreview={(id) => <span>{id}</span>}
          onCreate={jest.fn()}
          onError={jest.fn()}
          canDragRow={() => true}
          renderStatus={() => null}
        />,
      ),
    );
    const destinations = menuLeaves(menus.get('b') ?? [])
      .map((item) => item.label)
      .filter((label) => label !== 'New group');
    expect(destinations).toEqual(['First', 'Later', 'Unshown']);
  });
  it('uses the next available default name as a generated group editor placeholder', () => {
    const firstDefaultGroup: SidebarItemGroup = {
      id: 'grp-default-one',
      name: 'Group 1',
      color: 'neutral',
      collapsed: false,
      labelHidden: true,
      memberIds: ['b'],
    };
    render('manual', false, true, 'Group 2', true, [firstDefaultGroup], true);
    const edit = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.startsWith('Edit group'),
    );
    act(() => edit?.click());
    expect(
      document.querySelector<HTMLInputElement>(
        '[data-testid="sidebar-item-group-name"]',
      )?.placeholder,
    ).toBe('Group 2');
  });
  it('collapsed selected children cannot commit an invisible sibling destination', () => {
    render('manual', true);
    key('child-2', ' ');
    key('child-2', 'ArrowUp');
    key('child-2', ' ');
    expect(reorderChild).not.toHaveBeenCalled();
  });
  it('child pointer edges have distinct droppable identities', () => {
    render();
    const child = container.querySelector(
      '[data-sidebar-group-drag-source="child:child-1"]',
    );
    const ids = Array.from(
      child?.querySelectorAll('[data-drop-zone]') ?? [],
    ).map((zone) => zone.getAttribute('data-drop-zone'));
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });
  it('shows the ordinary creation placeholder before the first unpinned block', () => {
    render();
    const placeholder = container.querySelector('[data-testid="creating"]');
    expect(placeholder).not.toBeNull();
    expect(
      placeholder?.compareDocumentPosition(
        container.querySelector('[data-item="a"]') ?? container,
      ) ?? 0,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });
  it('preserves the branch children boundary under its root', () => {
    render();
    const children = container.querySelector(
      '[data-testid="worktree-branch-group-children"]',
    );
    expect(children?.getAttribute('data-parent-worktree-id')).toBe('a');
    expect(children?.querySelector('[data-item="a"]')).toBeNull();
    expect(children?.querySelector('[data-item="child-1"]')).not.toBeNull();
    expect(children?.querySelector('[data-item="child-2"]')).not.toBeNull();
  });
  it('retains the selected child while its collapsed group hides other members', () => {
    render('manual', true);
    expect(container.querySelector('[data-item="a"]')).toBeNull();
    expect(container.querySelector('[data-item="child-1"]')).toBeNull();
    expect(container.querySelector('[data-item="child-2"]')).not.toBeNull();
    expect(container.textContent).toContain('Release');
  });
  it('lifting and dropping in the original slot leaves membership and order untouched', () => {
    render();
    key('b', ' ');
    key('b', ' ');
    expect(moveItem).not.toHaveBeenCalled();
    expect(moveGroup).not.toHaveBeenCalled();
  });
  it('recency keyboard movement commits only membership and permits Escape', () => {
    render('last-updated');
    key('b', ' ');
    key('b', 'ArrowUp');
    key('b', 'Escape');
    expect(moveItem).not.toHaveBeenCalled();
    key('b', ' ');
    key('b', 'ArrowUp');
    key('b', ' ');
    expect(moveItem).toHaveBeenCalledWith('b', {
      groupId: 'grp-one',
      before: undefined,
      after: undefined,
      membershipOnly: true,
    });
  });
  function renderSelection(
    mode: SidebarSortMode,
    selected: readonly string[],
  ): void {
    const groups = [group];
    const blocks = buildSidebarItemGroupBlocks(
      ['a', 'b', 'c', 'd'].map((rootId) => ({ rootId, itemIds: [rootId] })),
      groups,
      mode,
    );
    act(() =>
      root.render(
        <CodeSidebarItemGroups
          blocks={blocks}
          groups={groups}
          mode={mode}
          commands={commands}
          renderRow={(id) => <Handle id={id} />}
          renderPreview={(id) => <span>{id}</span>}
          onCreate={jest.fn()}
          onError={jest.fn()}
          canDragRow={() => true}
          isItemSelected={(id) => selected.includes(id)}
          renderStatus={() => null}
        />,
      ),
    );
  }
  it('a move of a selected row carries the rest of the selection, in rail order (CAN-3975)', () => {
    renderSelection('last-updated', ['b', 'd']);
    key('b', ' ');
    expect(document.body.textContent).toContain('Moving 2 worktrees.');
    key('b', 'ArrowUp');
    key('b', ' ');
    expect(moveItem.mock.calls).toEqual([
      ['b', { groupId: 'grp-one', membershipOnly: true }],
      ['d', { groupId: 'grp-one', membershipOnly: true }],
    ]);
  });
  it('a move of an unselected row moves only that row (CAN-3975)', () => {
    renderSelection('last-updated', ['b', 'd']);
    key('c', ' ');
    key('c', 'ArrowUp');
    key('c', ' ');
    expect(moveItem).toHaveBeenCalledTimes(1);
    expect(moveItem).toHaveBeenCalledWith('c', {
      groupId: 'grp-one',
      membershipOnly: true,
    });
  });
  it('child keyboard ordering stays provisional until drop and cancels without a write', () => {
    render();
    key('child-1', ' ');
    key('child-1', 'ArrowDown');
    key('child-1', 'Escape');
    expect(reorderChild).not.toHaveBeenCalled();
    key('child-1', ' ');
    key('child-1', 'ArrowDown');
    key('child-1', ' ');
    expect(reorderChild).toHaveBeenCalledWith('child-1', 'child-2');
    expect(moveItem).not.toHaveBeenCalled();
  });
  it('a keyboard move reports the pressed state on its handle until it ends', () => {
    render();
    const handle = (): Element | null =>
      container.querySelector('[data-item="b"]');
    expect(handle()?.getAttribute('aria-pressed')).not.toBe('true');
    key('b', ' ');
    expect(handle()?.getAttribute('aria-pressed')).toBe('true');
    expect(
      container.querySelector('[data-item="a"]')?.getAttribute('aria-pressed'),
    ).not.toBe('true');
    key('b', 'Escape');
    expect(handle()?.getAttribute('aria-pressed')).not.toBe('true');
  });

  it('a group move offers only whole-block edges, never rows inside other groups', () => {
    const groups: SidebarItemGroup[] = [
      { ...group, id: 'grp-one', memberIds: ['a'] },
      { ...group, id: 'grp-two', name: 'Later', memberIds: ['b', 'c'] },
    ];
    act(() =>
      root.render(
        <CodeSidebarItemGroups
          blocks={buildSidebarItemGroupBlocks(
            ['a', 'b', 'c', 'd'].map((id) => ({ rootId: id, itemIds: [id] })),
            groups,
            'manual',
          )}
          groups={groups}
          mode="manual"
          commands={commands}
          renderRow={(id) => <Handle id={id} />}
          renderPreview={(id) => <span>{id}</span>}
          onCreate={jest.fn()}
          onError={jest.fn()}
          canDragRow={() => true}
          renderStatus={() => null}
        />,
      ),
    );
    const press = (value: string): void => {
      act(() => {
        container
          .querySelector('[data-testid="sidebar-item-group-toggle"]')
          ?.dispatchEvent(
            new KeyboardEvent('keydown', { key: value, bubbles: true }),
          );
      });
    };
    press(' ');
    press('ArrowDown');
    const targets = Array.from(
      container.querySelectorAll('.pointer-events-auto[data-drop-zone]'),
    ).map((zone) => zone.getAttribute('data-drop-zone') ?? '');
    expect(targets.length).toBeGreaterThan(0);
    expect(targets.every((id) => id.startsWith('{"kind":"block"'))).toBe(true);
    const indicator = container.querySelector(
      '[data-testid="sidebar-item-group-drop-indicator"]',
    );
    expect(indicator?.closest('[data-sidebar-group-drag-source]')).toBeNull();
    expect(
      indicator?.closest('[data-drop-zone]')?.getAttribute('data-drop-zone'),
    ).toBe(
      JSON.stringify({ kind: 'block', blockId: 'grp-two', edge: 'after' }),
    );
    press(' ');
    expect(moveGroup).toHaveBeenCalledWith('grp-one', {
      groupId: null,
      before: undefined,
      after: 'c',
      membershipOnly: false,
    });
  });

  it('a row whose owner cannot accept commands cannot begin a keyboard mutation', () => {
    render('manual', false, false);
    key('b', ' ');
    key('b', 'ArrowUp');
    key('b', ' ');
    expect(moveItem).not.toHaveBeenCalled();
  });
});
