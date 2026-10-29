/** @jest-environment jsdom */

/**
 * A Browser or Terminal tab's quick add repeats the kind it shows. A surface
 * that cannot add that kind (a window showing another computer cannot host the
 * in-app browser) must not offer a quick add that does nothing.
 */
import { act, type JSX, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { PanelKind } from '@canopy/protocol';
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
const BROWSER_GROUP = 'group-browser';

let root: Root | null = null;

function noop(): void {}

function mountSurface(addMenuExcludeKinds?: readonly PanelKind[]): void {
  const key = makeWorktreePanelKey('project', 'quick-add');
  usePanelLayoutStore.getState().initializeLayout(key, {
    orientation: 'horizontal',
    groups: [
      {
        kind: 'chat',
        groupId: CHAT_GROUP,
        panelId: 'panel-chat',
        instance: { chatTabId: 'chat-a' },
      },
      { kind: 'browser', groupId: BROWSER_GROUP, panelId: 'panel-browser' },
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
    renderAddTabMenu: (): ReactNode => null,
    onQuickAddPanel: noop,
  };
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <PanelGridSurface
        projectId="project"
        worktreeId="quick-add"
        hostState={DEFAULT_PANEL_HOST_STATE}
        services={services}
        {...(addMenuExcludeKinds !== undefined ? { addMenuExcludeKinds } : {})}
      />,
    );
  });
}

function browserGroupAddTab(): PanelTabBarAddTab | undefined {
  const group = hostProps?.layout.groups.find(
    (candidate) => candidate.groupId === BROWSER_GROUP,
  );
  if (!group || !hostProps) throw new Error('Browser group was not rendered');
  return hostProps.addTabForGroup?.(group);
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  hostProps = null;
});

describe('PanelGridSurface quick add', () => {
  it('offers another Browser where Browser can be added', () => {
    mountSurface();
    expect(browserGroupAddTab()?.quickAdd?.label).toBe('Add another browser');
  });

  it('offers no Browser quick add where Browser cannot be added', () => {
    mountSurface(['browser']);
    expect(browserGroupAddTab()?.quickAdd).toBeUndefined();
  });
});
