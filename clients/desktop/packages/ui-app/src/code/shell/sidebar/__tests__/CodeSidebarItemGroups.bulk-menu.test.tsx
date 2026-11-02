/** @jest-environment jsdom */
import { act, useEffect, type ReactNode, type RefObject } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SidebarItemGroup } from '@canopy/protocol/sidebar';
import type { WorktreeMenuItem } from '@canopy/ui-shared/components';
import {
  CodeSidebarItemGroups,
  type CodeSidebarItemGroupCommands,
} from '../CodeSidebarItemGroups';
import {
  buildSidebarItemGroupBlocks,
  type SidebarItemGroupDrop,
} from '../sidebar-item-groups-model';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// The text of the row each opened group editor anchors on.
const editorAnchors: (string | null | undefined)[] = [];
function AnchorProbe(props: {
  readonly anchorRef: RefObject<HTMLElement | null>;
}): null {
  const { anchorRef } = props;
  useEffect(() => {
    editorAnchors.push(anchorRef.current?.textContent);
  }, [anchorRef]);
  return null;
}
jest.mock('@canopy/ui-shared/components', () => ({
  ...jest.requireActual<object>('@canopy/ui-shared/components'),
  SidebarItemGroupEditor: AnchorProbe,
}));

const GROUP: SidebarItemGroup = {
  id: 'g1',
  name: 'Alpha',
  color: 'neutral',
  collapsed: false,
  memberIds: ['c'],
};

describe('CodeSidebarItemGroups bulk group menu', () => {
  let container: HTMLDivElement;
  let root: Root;
  const menus = new Map<string, WorktreeMenuItem[]>();

  function render(input: {
    selected: readonly string[];
    selectionCount: number;
    pinned?: readonly string[];
    undraggable?: readonly string[];
    groups?: readonly SidebarItemGroup[];
    commands: CodeSidebarItemGroupCommands;
  }): void {
    const groups = input.groups ?? [GROUP];
    const blocks = buildSidebarItemGroupBlocks(
      ['a', 'b', 'c'].map((id) => ({
        rootId: id,
        itemIds: [id],
        pinned: input.pinned?.includes(id) === true,
      })),
      groups,
      'manual',
    );
    act(() =>
      root.render(
        <CodeSidebarItemGroups
          blocks={blocks}
          groups={groups}
          mode="manual"
          commands={input.commands}
          dragEnabled={false}
          isItemSelected={(id) => input.selected.includes(id)}
          selectionCount={input.selectionCount}
          renderRow={(id, menu): ReactNode => {
            menus.set(id, menu);
            return <div>{id}</div>;
          }}
          renderPreview={() => null}
          onCreate={() => undefined}
          onError={() => undefined}
          canDragRow={(id) => input.undraggable?.includes(id) !== true}
          renderStatus={() => null}
        />,
      ),
    );
  }

  function commands(): CodeSidebarItemGroupCommands & {
    moveItem: jest.Mock<void, [string, SidebarItemGroupDrop]>;
    create: jest.Mock<Promise<SidebarItemGroup>, [string]>;
  } {
    return {
      create: jest.fn<Promise<SidebarItemGroup>, [string]>(() =>
        Promise.resolve({ ...GROUP, id: 'g2', name: 'New', memberIds: ['a'] }),
      ),
      update: jest.fn(),
      ungroup: jest.fn(),
      moveItem: jest.fn<void, [string, SidebarItemGroupDrop]>(),
      moveGroup: jest.fn(),
    };
  }

  beforeEach(() => {
    menus.clear();
    editorAnchors.length = 0;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('moves every selected row to the chosen group', () => {
    const cmds = commands();
    render({ selected: ['a', 'b'], selectionCount: 2, commands: cmds });
    const organize = menus.get('a')?.[0];
    expect(organize?.label).toBe('Move to group');
    organize?.submenu?.find((item) => item.label === 'Alpha')?.onSelect?.();
    expect(cmds.moveItem.mock.calls.map(([id]) => id)).toEqual(['a', 'b']);
    expect(cmds.moveItem.mock.calls[0]?.[1]).toMatchObject({ groupId: 'g1' });
  });

  it('hides Move to group for a selection across lists', () => {
    render({ selected: ['a', 'b'], selectionCount: 3, commands: commands() });
    expect(menus.get('a')).toEqual([]);
  });

  it('skips pinned rows', () => {
    const cmds = commands();
    render({
      selected: ['a', 'b'],
      selectionCount: 2,
      pinned: ['b'],
      commands: cmds,
    });
    menus
      .get('a')?.[0]
      ?.submenu?.find((item) => item.label === 'Alpha')
      ?.onSelect?.();
    expect(cmds.moveItem.mock.calls.map(([id]) => id)).toEqual(['a']);
  });

  it('offers nothing when every selected row is pinned', () => {
    render({
      selected: ['a', 'b'],
      selectionCount: 2,
      pinned: ['a', 'b'],
      commands: commands(),
    });
    expect(menus.get('a')).toEqual([]);
  });

  it('New group creates it with the first row and moves the rest in after it', async () => {
    const cmds = commands();
    render({ selected: ['a', 'b'], selectionCount: 2, commands: cmds });
    menus
      .get('b')?.[0]
      ?.submenu?.find((item) => item.label === 'New group')
      ?.onSelect?.();
    await act(async () => {
      await Promise.resolve();
    });
    expect(cmds.create).toHaveBeenCalledWith('a');
    expect(cmds.moveItem).toHaveBeenCalledWith('b', {
      groupId: 'g2',
      after: 'a',
      membershipOnly: false,
    });
  });

  it('skips rows the host holds back from drag', () => {
    const cmds = commands();
    render({
      selected: ['a', 'b'],
      selectionCount: 2,
      undraggable: ['b'],
      commands: cmds,
    });
    menus
      .get('a')?.[0]
      ?.submenu?.find((item) => item.label === 'Alpha')
      ?.onSelect?.();
    expect(cmds.moveItem.mock.calls.map(([id]) => id)).toEqual(['a']);
  });

  it('New group opens its editor on a row that joined it', async () => {
    render({
      selected: ['a', 'b'],
      selectionCount: 2,
      pinned: ['b'],
      groups: [GROUP, { ...GROUP, id: 'g2', name: 'New', memberIds: [] }],
      commands: commands(),
    });
    menus
      .get('b')?.[0]
      ?.submenu?.find((item) => item.label === 'New group')
      ?.onSelect?.();
    await act(async () => {
      await Promise.resolve();
    });
    expect(editorAnchors).toEqual(['a']);
  });

  it('Remove from group takes only the grouped selected rows out', () => {
    const cmds = commands();
    render({ selected: ['b', 'c'], selectionCount: 2, commands: cmds });
    menus
      .get('c')?.[0]
      ?.submenu?.find((item) => item.label === 'Remove from group')
      ?.onSelect?.();
    expect(cmds.moveItem.mock.calls).toEqual([
      ['c', { groupId: null, membershipOnly: false }],
    ]);
  });

  it('an unselected row keeps its single-row group menu', () => {
    render({ selected: ['a', 'b'], selectionCount: 2, commands: commands() });
    expect(menus.get('c')?.[0]?.label).toBe('Group');
  });
});
