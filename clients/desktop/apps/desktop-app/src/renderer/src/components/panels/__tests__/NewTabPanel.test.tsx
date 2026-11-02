/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  makeWorktreePanelKey,
  usePanelLayoutStore,
  type DefaultLayoutDescriptor,
} from '@/stores/panelLayoutStore';
import { NewTabPanel } from '../NewTabPanel';
import type * as AppIconsModule from '@canopy/ui-shared/icons/AppIcons';

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
  listAddablePanels: (): unknown[] => {
    const { AutomationsIcon } = jest.requireActual<typeof AppIconsModule>(
      '@canopy/ui-shared/icons/AppIcons',
    );
    return [
      { kind: 'browser', label: 'Browser', icon: null },
      {
        kind: 'automations',
        label: 'Automations',
        group: 'automations',
        instance: { variant: 'full' },
        icon: <AutomationsIcon />,
      },
    ];
  },
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
  });

  it('matches the Automations icon to the compact new-tab catalog icons', () => {
    usePanelLayoutStore.getState().initializeLayout(KEY, SIDE_PANEL);
    act(() =>
      root.render(<NewTabPanel panelId="panel-new-tab" worktreeKey={KEY} />),
    );
    const icon = container.querySelector(
      '[data-testid="side-panel-empty-item-automations"] svg',
    );
    expect(icon?.getAttribute('width')).toBe('14px');
    expect(icon?.getAttribute('height')).toBe('14px');
  });

  it('replaces itself with the chosen surface in a crowded tab row', async () => {
    const store = usePanelLayoutStore.getState();
    store.initializeLayout(KEY, SIDE_PANEL);
    // A crowded row: the New tab plus 20 browsers.
    for (let index = 1; index <= 20; index += 1) {
      store.addTab(KEY, 'group-extras', 'browser', {
        instance: { browserId: `existing-${index}` },
      });
    }
    expect(extrasKinds()).toHaveLength(21);

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
    expect(kinds).toHaveLength(21);
    expect(kinds).not.toContain('new-tab');
  });
});
