/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DEFAULT_PANEL_HOST_STATE, usePanelVisible } from '../panel-contexts';
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
const visibility = new Map<string, boolean>();

function Probe({ panelId }: { panelId: string }): null {
  visibility.set(panelId, usePanelVisible());
  return null;
}

describe('PanelContentRoot panel visibility', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    visibility.clear();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    resetPanelContentContainersForTests();
  });

  it('tells each tab whether it is the shown tab of its group', () => {
    const key = makeWorktreePanelKey('project', 'wt-visibility');
    const store = usePanelLayoutStore.getState();
    store.initializeLayout(key, {
      orientation: 'horizontal',
      groups: [
        {
          kind: 'chat',
          groupId: GROUP,
          panelId: 'panel-a',
          instance: { chatTabId: 'chat-a' },
        },
      ],
      containerSize: { width: 800, height: 600 },
    });
    store.addTab(key, GROUP, 'chat', {
      panelId: 'panel-b',
      instance: { chatTabId: 'chat-b' },
    });

    act(() => {
      root.render(
        <PanelContentRoot
          worktreeKey={key}
          hostState={DEFAULT_PANEL_HOST_STATE}
          renderPanelContent={({ panelId }) => <Probe panelId={panelId} />}
          includeAuxWindows={false}
        />,
      );
    });
    expect(visibility.get('panel-b')).toBe(true);
    expect(visibility.get('panel-a')).toBe(false);

    act(() => {
      usePanelLayoutStore.getState().selectTab(key, GROUP, 'panel-a');
    });
    expect(visibility.get('panel-a')).toBe(true);
    expect(visibility.get('panel-b')).toBe(false);
  });

  it('defaults to shown outside a panel grid', () => {
    act(() => root.render(<Probe panelId="free" />));
    expect(visibility.get('free')).toBe(true);
  });
});
