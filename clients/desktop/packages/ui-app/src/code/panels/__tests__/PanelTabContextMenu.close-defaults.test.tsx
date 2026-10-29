/** @jest-environment jsdom */

/**
 * Locks the shared PanelTabContextMenu close-handler seam: when a host does
 * not inject `onCloseTab`/`onCloseTabs`, the menu must dispatch the raw
 * layout-store `closeTab`/`closeTabs` actions (the contract web hosts rely
 * on); when a host DOES inject them, the store must not be touched.
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PanelTabContextMenu } from '../PanelTabContextMenu';
import {
  makeWorktreePanelKey,
  usePanelLayoutStore,
  type DefaultLayoutDescriptor,
} from '../panel-layout-store';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

const ONE_GROUP: DefaultLayoutDescriptor = {
  orientation: 'horizontal',
  groups: [
    {
      kind: 'chat',
      groupId: 'group-a',
      panelId: 'panel-a',
      instance: { chatTabId: 'chat-a' },
    },
  ],
  containerSize: { width: 800, height: 600 },
};

let keyCounter = 0;

function nextKey(): string {
  keyCounter += 1;
  return makeWorktreePanelKey('project', `close-defaults-${keyCounter}`);
}

function store(): ReturnType<typeof usePanelLayoutStore.getState> {
  return usePanelLayoutStore.getState();
}

function render(node: JSX.Element): Root {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  return root;
}

function clickButton(testId: string): void {
  const element = document.body.querySelector(`[data-testid="${testId}"]`);
  if (!(element instanceof HTMLButtonElement)) {
    throw new Error(`Expected button with data-testid ${testId}`);
  }
  act(() => {
    element.click();
  });
}

function tabIdsOf(key: string, groupId: string): readonly string[] {
  const layout = store().layouts[key];
  return layout.groups[groupId].tabs.map((tab) => tab.panelId);
}

function seedTwoTabs(key: string): void {
  store().initializeLayout(key, ONE_GROUP);
  store().addTab(key, 'group-a', 'chat', {
    panelId: 'panel-b',
    instance: { chatTabId: 'chat-b' },
  });
}

afterEach(() => {
  for (const key of Object.keys(store().layouts)) {
    store().disposeLayout(key);
  }
  document.body.replaceChildren();
  jest.clearAllMocks();
});

describe('PanelTabContextMenu close-handler defaults', () => {
  test('without onCloseTab, Close dispatches the raw store closeTab', () => {
    const key = nextKey();
    seedTwoTabs(key);

    const root = render(
      <PanelTabContextMenu
        layoutKey={key}
        target={{ groupId: 'group-a', panelId: 'panel-a', x: 10, y: 10 }}
        onClose={jest.fn()}
      />,
    );

    clickButton('panel-tab-context-close');
    expect(tabIdsOf(key, 'group-a')).toEqual(['panel-b']);

    act(() => {
      root.unmount();
    });
  });

  test('without onCloseTabs, Close Others dispatches the raw store closeTabs', () => {
    const key = nextKey();
    seedTwoTabs(key);

    const root = render(
      <PanelTabContextMenu
        layoutKey={key}
        target={{ groupId: 'group-a', panelId: 'panel-a', x: 10, y: 10 }}
        onClose={jest.fn()}
      />,
    );

    clickButton('panel-tab-context-close-others');
    expect(tabIdsOf(key, 'group-a')).toEqual(['panel-a']);

    act(() => {
      root.unmount();
    });
  });

  test('an injected onCloseTab wins: callback receives args, store untouched', () => {
    const key = nextKey();
    seedTwoTabs(key);
    const onCloseTab = jest.fn();

    const root = render(
      <PanelTabContextMenu
        layoutKey={key}
        target={{ groupId: 'group-a', panelId: 'panel-a', x: 10, y: 10 }}
        onClose={jest.fn()}
        onCloseTab={onCloseTab}
      />,
    );

    clickButton('panel-tab-context-close');
    expect(onCloseTab).toHaveBeenCalledWith(key, 'group-a', 'panel-a');
    expect(tabIdsOf(key, 'group-a')).toEqual(['panel-a', 'panel-b']);

    act(() => {
      root.unmount();
    });
  });
});

describe('PanelTabContextMenu close eligibility', () => {
  test('disables Close for a tab the host protects', () => {
    // The predicate reached the tab strip but not this menu, so a protected
    // chat still offered a Close that the host immediately refused.
    const key = nextKey();
    seedTwoTabs(key);

    const root = render(
      <PanelTabContextMenu
        layoutKey={key}
        target={{ groupId: 'group-a', panelId: 'panel-a', x: 10, y: 10 }}
        onClose={jest.fn()}
        canCloseTab={(tab): boolean => tab.panelId !== 'panel-a'}
      />,
    );

    const item = document.querySelector<HTMLButtonElement>(
      '[data-testid="panel-tab-context-close"]',
    );
    expect(item?.disabled).toBe(true);

    act(() => {
      root.unmount();
    });
  });

  test('bulk closes skip protected tabs, as they already skip pinned ones', () => {
    const key = nextKey();
    seedTwoTabs(key);

    const root = render(
      <PanelTabContextMenu
        layoutKey={key}
        target={{ groupId: 'group-a', panelId: 'panel-a', x: 10, y: 10 }}
        onClose={jest.fn()}
        canCloseTab={(tab): boolean => tab.panelId !== 'panel-b'}
      />,
    );

    clickButton('panel-tab-context-close-others');
    // panel-b was protected, so "Close others" left it alone.
    expect(tabIdsOf(key, 'group-a')).toEqual(['panel-a', 'panel-b']);

    act(() => {
      root.unmount();
    });
  });
});

test('Close to the Left also skips protected tabs', () => {
  // Every bulk action must honour the guard; this one was missed while the
  // others were converted, so it still closed a chat the host refuses.
  const key = nextKey();
  seedTwoTabs(key);

  const root = render(
    <PanelTabContextMenu
      layoutKey={key}
      target={{ groupId: 'group-a', panelId: 'panel-b', x: 10, y: 10 }}
      onClose={jest.fn()}
      canCloseTab={(tab): boolean => tab.panelId !== 'panel-a'}
    />,
  );

  clickButton('panel-tab-context-close-left');
  // panel-a sits to the left and is protected, so it survives.
  expect(tabIdsOf(key, 'group-a')).toEqual(['panel-a', 'panel-b']);

  act(() => {
    root.unmount();
  });
});
