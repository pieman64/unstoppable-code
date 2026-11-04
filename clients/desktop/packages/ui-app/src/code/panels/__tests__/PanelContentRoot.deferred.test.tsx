/** @jest-environment jsdom */
import { act, useEffect, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DEFAULT_PANEL_HOST_STATE } from '../panel-contexts';
import {
  PanelContentRoot,
  resetPanelContentContainersForTests,
} from '../PanelContentRoot';
import {
  makeWorktreePanelKey,
  usePanelLayoutStore,
} from '../panel-layout-store';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

const GROUP = 'group-chat';
const mounts: string[] = [];

function Content({ panelId }: { panelId: string }): JSX.Element {
  useEffect(() => {
    mounts.push(panelId);
  }, [panelId]);
  return <div data-panel-content={panelId} />;
}

function seedWorktree(name: string): string {
  const key = makeWorktreePanelKey('project', name);
  const store = usePanelLayoutStore.getState();
  store.initializeLayout(key, {
    orientation: 'horizontal',
    groups: [
      {
        kind: 'chat',
        groupId: GROUP,
        panelId: `${name}-chat-a`,
        instance: { chatTabId: 'chat-a' },
      },
    ],
    containerSize: { width: 800, height: 600 },
  });
  store.addTab(key, GROUP, 'chat', {
    panelId: `${name}-chat-b`,
    instance: { chatTabId: 'chat-b' },
  });
  store.addTab(key, GROUP, 'terminal', { panelId: `${name}-terminal` });
  // The second chat is the shown tab.
  store.selectTab(key, GROUP, `${name}-chat-b`);
  return key;
}

describe('PanelContentRoot deferred hidden content', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    mounts.length = 0;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    resetPanelContentContainersForTests();
  });

  const render = (worktreeKey: string): void => {
    act(() => {
      root.render(
        <PanelContentRoot
          worktreeKey={worktreeKey}
          hostState={DEFAULT_PANEL_HOST_STATE}
          renderPanelContent={({ panelId }) => <Content panelId={panelId} />}
          deferHiddenContent={(kind) => kind === 'chat'}
          includeAuxWindows={false}
        />,
      );
    });
  };

  it('mounts a hidden chat only once it has been shown, then keeps it', () => {
    // Showing a worktree mounted every hidden chat of it: thousands of
    // elements styled on each switch for tabs no one is looking at.
    const key = seedWorktree('wt-deferred');
    render(key);
    // Only the shown chat; other kinds keep mounting while hidden.
    expect([...mounts].sort()).toEqual([
      'wt-deferred-chat-b',
      'wt-deferred-terminal',
    ]);

    act(() => {
      usePanelLayoutStore
        .getState()
        .selectTab(key, GROUP, 'wt-deferred-chat-a');
    });
    act(() => {
      usePanelLayoutStore
        .getState()
        .selectTab(key, GROUP, 'wt-deferred-chat-b');
    });
    // Each chat mounted once: a chat that has been shown stays mounted.
    expect([...mounts].sort()).toEqual([
      'wt-deferred-chat-a',
      'wt-deferred-chat-b',
      'wt-deferred-terminal',
    ]);
  });

  it('mounts every hidden tab without the opt-in', () => {
    const key = seedWorktree('wt-eager');
    act(() => {
      root.render(
        <PanelContentRoot
          worktreeKey={key}
          hostState={DEFAULT_PANEL_HOST_STATE}
          renderPanelContent={({ panelId }) => <Content panelId={panelId} />}
          includeAuxWindows={false}
        />,
      );
    });
    expect(mounts).toHaveLength(3);
  });
});
