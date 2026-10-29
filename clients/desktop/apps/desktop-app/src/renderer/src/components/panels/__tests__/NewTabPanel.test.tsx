/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MAX_TABS_PER_GROUP } from '@canopy/ui-shared/panels';
import {
  makeWorktreePanelKey,
  usePanelLayoutStore,
  type DefaultLayoutDescriptor,
} from '@/stores/panelLayoutStore';
import { NewTabPanel } from '../NewTabPanel';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let browserCounter = 0;
jest.mock('@/stores/browserStore', () => ({
  useBrowserStore: {
    getState: (): Record<string, unknown> => ({
      openBrowser: (): { browserId: string } => {
        browserCounter += 1;
        return { browserId: `opened-${browserCounter}` };
      },
      setActiveBrowser: jest.fn().mockResolvedValue(undefined),
    }),
  },
}));
jest.mock('@/lib/panels/browser-panel-sync', () => ({
  discardOpenedBrowser: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('@/lib/panels/registry', () => ({
  listAddablePanels: (): unknown[] => [
    { kind: 'browser', label: 'Browser', icon: null },
  ],
}));

const KEY = makeWorktreePanelKey('project', 'new-tab-panel');
const SIDE_PANEL: DefaultLayoutDescriptor = {
  orientation: 'horizontal',
  groups: [
    {
      kind: 'chat',
      groupId: 'group-chat',
      panelId: 'panel-chat',
      instance: { chatTabId: 'chat-a' },
    },
    {
      kind: 'new-tab',
      groupId: 'group-extras',
      panelId: 'panel-new-tab',
      instance: { newTabId: 'new-tab-1' },
    },
  ],
  containerSize: { width: 900, height: 600 },
};

function extrasKinds(): string[] {
  return (
    usePanelLayoutStore
      .getState()
      .layouts[KEY]?.groups['group-extras']?.tabs.map((tab) => tab.kind) ?? []
  );
}

describe('NewTabPanel', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    const state = usePanelLayoutStore.getState();
    state.disposeLayout(KEY);
    state.setTabRowLimit(null);
  });

  it('replaces itself with the chosen surface in a full tab row', async () => {
    const store = usePanelLayoutStore.getState();
    store.initializeLayout(KEY, SIDE_PANEL);
    // Fill the row: the New tab plus browsers up to the limit.
    for (let index = 1; index < MAX_TABS_PER_GROUP; index += 1) {
      store.addTab(KEY, 'group-extras', 'browser', {
        instance: { browserId: `existing-${index}` },
      });
    }
    store.setTabRowLimit(MAX_TABS_PER_GROUP);
    expect(extrasKinds()).toHaveLength(MAX_TABS_PER_GROUP);

    await act(async () => {
      root.render(<NewTabPanel panelId="panel-new-tab" worktreeKey={KEY} />);
      await Promise.resolve();
    });
    const browserRow = container.querySelector<HTMLElement>(
      '[data-testid="side-panel-empty-item-browser"]',
    );
    expect(browserRow).not.toBeNull();
    await act(async () => {
      browserRow?.click();
      await Promise.resolve();
    });

    const kinds = extrasKinds();
    expect(kinds).toHaveLength(MAX_TABS_PER_GROUP);
    expect(kinds).not.toContain('new-tab');
  });
});
