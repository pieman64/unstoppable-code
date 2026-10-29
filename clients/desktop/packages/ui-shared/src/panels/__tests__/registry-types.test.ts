import { Direction } from '../grid';
import {
  splitDirectionToGridDirection,
  type PanelContentProps,
  type PanelDefinition,
  type PanelDropEdge,
  type PanelGroupModel,
  type PanelIntentCallbacks,
  type PanelLayoutViewModel,
  type PanelSplitDirection,
  type PanelTabModel,
} from '../registry-types';

describe('splitDirectionToGridDirection', () => {
  test('maps every protocol split direction onto the grid Direction enum', () => {
    expect(splitDirectionToGridDirection('up')).toBe(Direction.Up);
    expect(splitDirectionToGridDirection('down')).toBe(Direction.Down);
    expect(splitDirectionToGridDirection('left')).toBe(Direction.Left);
    expect(splitDirectionToGridDirection('right')).toBe(Direction.Right);
  });
});

describe('panel contract types (compile-time checks)', () => {
  test('the contract shapes are constructible and structurally consistent', () => {
    const contentProps: PanelContentProps = {
      panelId: 'panel-1',
      kind: 'terminal',
      isActive: true,
      isVisible: true,
    };

    // React-free generic: a non-React consumer can bind TContent to string.
    const definition: PanelDefinition<string> = {
      kind: 'terminal',
      title: 'Terminal',
      icon: 'terminal-icon',
      canPopOut: true,
      isWindowBound: false,
      render: (props: PanelContentProps): string => props.panelId,
    };
    expect(definition.render(contentProps)).toBe('panel-1');

    const tab: PanelTabModel = {
      panelId: 'panel-1',
      kind: 'terminal',
      title: 'Terminal',
    };
    const group: PanelGroupModel = {
      groupId: 'group-1',
      tabs: [tab],
      activePanelId: 'panel-1',
    };
    const viewModel: PanelLayoutViewModel = {
      groups: [group],
      activeGroupId: 'group-1',
      maximizedGroupId: null,
    };
    expect(viewModel.groups[0].tabs[0].panelId).toBe('panel-1');

    const invocations: string[] = [];
    const callbacks: PanelIntentCallbacks = {
      onSelectTab: (groupId: string, panelId: string): void => {
        invocations.push(`select:${groupId}:${panelId}`);
      },
      onCloseTab: (groupId: string, panelId: string): void => {
        invocations.push(`closeTab:${groupId}:${panelId}`);
      },
      onCloseGroup: (groupId: string): void => {
        invocations.push(`closeGroup:${groupId}`);
      },
      onSplitGroup: (groupId: string, direction: PanelSplitDirection): void => {
        invocations.push(`split:${groupId}:${direction}`);
      },
      onMaximizeGroup: (groupId: string, maximized: boolean): void => {
        invocations.push(`maximize:${groupId}:${String(maximized)}`);
      },
      onFocusGroup: (groupId: string): void => {
        invocations.push(`focus:${groupId}`);
      },
      onMovePanel: (
        panelId: string,
        targetGroupId: string,
        edge: PanelDropEdge,
        targetIndex?: number,
      ): void => {
        invocations.push(
          `move:${panelId}:${targetGroupId}:${edge}${targetIndex === undefined ? '' : `:${targetIndex}`}`,
        );
      },
      // onPopOutGroup intentionally omitted: it is optional until Phase 9.
    };

    callbacks.onSplitGroup('group-1', 'down');
    callbacks.onMovePanel('panel-1', 'group-2', 'center');
    callbacks.onMovePanel('panel-1', 'group-2', 'center', 2);
    expect(invocations).toEqual([
      'split:group-1:down',
      'move:panel-1:group-2:center',
      'move:panel-1:group-2:center:2',
    ]);
    expect(Object.keys(callbacks)).not.toContain('onPopOutGroup');
  });

  test('PanelGroupModel carries optional collapse state and affordance', () => {
    const group: PanelGroupModel = {
      groupId: 'g1',
      tabs: [],
      activePanelId: null,
      collapsed: { edge: 'left' },
      collapseAffordance: { state: 'blocked', edge: 'left' },
    };
    expect(group.collapsed?.edge).toBe('left');
    expect(group.collapseAffordance?.state).toBe('blocked');
  });
});
