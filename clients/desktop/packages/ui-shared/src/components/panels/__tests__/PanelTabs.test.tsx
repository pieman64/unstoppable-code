/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  PanelGroupModel,
  PanelIntentCallbacks,
  PanelTabModel,
} from '../../../panels/registry-types';
import { PanelBranchCollapsedBar } from '../PanelBranchCollapsedBar';
import { PanelTabBar } from '../PanelTabBar';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const TABS: PanelTabModel[] = [
  { panelId: 'panel-1', kind: 'chat', title: 'Acquisition plan' },
];

const GROUP: PanelGroupModel = {
  groupId: 'group-1',
  tabs: TABS,
  activePanelId: 'panel-1',
};

const CALLBACKS: PanelIntentCallbacks = {
  onSelectTab: jest.fn(),
  onCloseTab: jest.fn(),
  onCloseGroup: jest.fn(),
  onSplitGroup: jest.fn(),
  onMaximizeGroup: jest.fn(),
  onFocusGroup: jest.fn(),
  onMovePanel: jest.fn(),
  onCollapseGroup: jest.fn(),
  onExpandGroupToTab: jest.fn(),
};

let root: Root | null = null;

function render(node: JSX.Element): HTMLDivElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
  return container;
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('panel tab titles', () => {
  it('renders an app label renderer inside the tab label wrapper', () => {
    const container = render(
      <PanelTabBar
        groupId="group-1"
        tabs={TABS}
        activePanelId="panel-1"
        onSelectTab={jest.fn()}
        onCloseTab={jest.fn()}
        renderTabLabel={(tab): JSX.Element => <>{`live ${tab.title}`}</>}
      />,
    );
    const label = container.querySelector(
      '[data-testid="panel-tab-panel-1"] .canopy-panel-tab-title',
    );
    expect(label?.textContent).toBe('live Acquisition plan');
  });

  it('shows the title letter on a branch-collapsed tab', () => {
    const container = render(
      <PanelBranchCollapsedBar
        groups={[GROUP]}
        edge="left"
        callbacks={CALLBACKS}
      />,
    );
    const tab = container.querySelector(
      '[data-testid="panel-branch-tab-panel-1"]',
    );
    // Without an icon renderer the button shows the title's first letter.
    expect(tab?.textContent).toBe('A');
  });
});
