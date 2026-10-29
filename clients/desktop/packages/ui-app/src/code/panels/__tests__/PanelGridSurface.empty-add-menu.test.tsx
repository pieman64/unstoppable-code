/** @jest-environment jsdom */

/**
 * An empty group's own content (the early-access Side Panel's "More…") opens
 * the group's add menu. The menu anchors to the element it renders in, so it
 * must render beside that trigger, not in the tab bar's `+`, where it opened
 * at the top of the panel, away from what the user clicked.
 */
import { act, type JSX, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { PanelTabModel } from '@canopy/ui-shared/panels';
import type {
  PanelGridHostProps,
  PanelTabBarAddTab,
} from '@canopy/ui-shared/components/panels';

let hostProps: PanelGridHostProps | null = null;

jest.mock('@canopy/ui-shared/components/panels', () => ({
  ...jest.requireActual<object>('@canopy/ui-shared/components/panels'),
  PanelGridHost: (props: PanelGridHostProps): JSX.Element => {
    hostProps = props;
    return <div data-testid="mock-panel-grid-host" />;
  },
}));

import {
  PanelGridSurface,
  type PanelEmptyGroupActions,
  type PanelGridSurfaceServices,
} from '../PanelGridSurface';
import { DEFAULT_PANEL_HOST_STATE } from '../panel-contexts';
import {
  makeWorktreePanelKey,
  usePanelLayoutStore,
} from '../panel-layout-store';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

const CHAT_GROUP = 'group-chat';
const SIDE_GROUP = 'group-side';
const MENU = 'add-menu';

let root: Root | null = null;
let emptyActions: PanelEmptyGroupActions | null = null;

function noop(): void {}

function mountSurface(): void {
  const key = makeWorktreePanelKey('project', 'empty-add-menu');
  usePanelLayoutStore.getState().initializeLayout(key, {
    orientation: 'horizontal',
    groups: [
      {
        kind: 'chat',
        groupId: CHAT_GROUP,
        panelId: 'panel-chat',
        instance: { chatTabId: 'chat-a' },
      },
      { kind: 'terminal', groupId: SIDE_GROUP, panelId: 'panel-terminal' },
    ],
    containerSize: { width: 800, height: 600 },
  });
  const services: PanelGridSurfaceServices = {
    renderPanelContent: (): null => null,
    renderTabIcon: (): null => null,
    renderCollapsedTabIcon: (): null => null,
    renderTabLabel: (tab: PanelTabModel): string => tab.panelId,
    getTabTitle: (tab: PanelTabModel): string => tab.panelId,
    renderTabTooltip: (): null => null,
    renderTabTrailing: (): null => null,
    ensureLayout: (): Promise<void> => Promise.resolve(),
    activateBoundBrowserPanel: noop,
    onBrowserViewBoundsInvalidated: noop,
    onPopOutGroup: noop,
    onCloseTab: noop,
    onCloseTabs: noop,
    renderAddTabMenu: (): ReactNode => <div data-testid={MENU} />,
    emptyContentForGroup: (_group, actions): ReactNode => {
      emptyActions = actions;
      return null;
    },
  };
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <PanelGridSurface
        projectId="project"
        worktreeId="empty-add-menu"
        hostState={DEFAULT_PANEL_HOST_STATE}
        services={services}
      />,
    );
  });
}

/** The tab bar's add affordance and the empty content's actions, as now. */
function sideGroup(): {
  addTab: PanelTabBarAddTab | undefined;
  actions: PanelEmptyGroupActions;
} {
  const group = hostProps?.layout.groups.find(
    (candidate) => candidate.groupId === SIDE_GROUP,
  );
  if (!group || !hostProps) throw new Error('Side group was not rendered');
  const addTab = hostProps.addTabForGroup?.(group);
  void hostProps.emptyContentForGroup?.(group);
  if (!emptyActions) throw new Error('Empty content was not requested');
  return { addTab, actions: emptyActions };
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  hostProps = null;
  emptyActions = null;
});

describe('PanelGridSurface empty-group add menu', () => {
  it('opens beside the empty content that asked for it, not at the + button', () => {
    mountSurface();
    act(() => sideGroup().actions.openAddMenu());

    const { addTab, actions } = sideGroup();
    expect(actions.addMenu).toBeDefined();
    expect(addTab?.menu).toBeUndefined();
    expect(addTab?.addPanel?.menu).toBeUndefined();

    // The same trigger closes it again.
    act(() => actions.openAddMenu());
    expect(sideGroup().actions.addMenu).toBeUndefined();
  });

  it('still opens at the + button when the + button asks for it', () => {
    mountSurface();
    act(() => sideGroup().addTab?.onAddTab(SIDE_GROUP));

    const { addTab, actions } = sideGroup();
    expect(addTab?.menu ?? addTab?.addPanel?.menu).toBeDefined();
    expect(actions.addMenu).toBeUndefined();
  });
});
