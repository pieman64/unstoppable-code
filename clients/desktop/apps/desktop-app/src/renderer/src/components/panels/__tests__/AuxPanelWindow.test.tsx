/** @jest-environment jsdom */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type * as PanelPrimitives from '@canopy/ui-shared/panels';
import { AuxPanelWindow } from '../AuxPanelWindow';
import { DEFAULT_PANEL_HOST_STATE } from '@/lib/panels/panel-host-context';

jest.mock('@/components/chat/ChatTabRenameDialog', () => ({
  useChatTabRename: jest.fn(() => ({ open: jest.fn(), dialog: null })),
}));
jest.mock('@/components/panels/PanelContentRoot', () => ({}));
jest.mock('@/components/panels/PanelTabContextMenu', () => ({}));
jest.mock('@/lib/brand', () => ({ brandText: { appName: 'Canopy' } }));
jest.mock('@/lib/panels/busy-chat-panels', () => ({
  useBusyChatCanCloseTab: jest.fn(() => (): boolean => true),
}));
jest.mock('@/lib/panels/chat-panel-sync', () => ({}));
jest.mock('@/lib/panels/child-window-styles', () => ({
  mirrorHtmlAttributesInto: jest.fn(() => ({ dispose: jest.fn() })),
  mirrorStylesheetsInto: jest.fn(() => ({ dispose: jest.fn() })),
}));
jest.mock('@/lib/panels/persistence-bridge', () => ({
  createAuxWindowBoundsWatcher: jest.fn(() => ({ check: jest.fn() })),
}));
jest.mock('@/lib/panels/registry', () => ({}));
jest.mock('@/lib/panels/split-active-tab', () => ({}));
jest.mock('@/lib/panels/tab-display', () => ({}));
jest.mock('@/lib/panels/terminal-panel-activation', () => ({}));
jest.mock('@/lib/workspace-access', () => ({
  useWorkspaceIsReadOnly: (): boolean => false,
}));
jest.mock('@/stores/chatStore', () => ({}));
jest.mock('@/stores/panelLayoutStore', () => {
  const viewModel = { activeGroupId: null };
  const controller = {};
  return {
    usePanelLayoutViewModel: (): typeof viewModel => viewModel,
    usePanelGridController: (): typeof controller => controller,
    usePanelLayoutStore: { getState: jest.fn() },
  };
});
const mockMergeBack = jest.fn();
jest.mock('@/stores/panelWindowsStore', () => ({
  getAuxWindowSourceLabel: (): string => 'Project / main',
  usePanelWindowsStore: {
    getState: jest.fn(() => ({ mergeBack: mockMergeBack })),
  },
}));
jest.mock('@/stores/projectsStore', () => ({
  useProjectsStore: (): string => 'Project / main',
}));
jest.mock('@canopy/ui-shared', () => ({
  Tooltip: ({ children }: { children: ReactNode }): ReactNode => children,
}));
jest.mock('@canopy/ui-shared/components/panels', () => ({
  PanelGridHost: (): null => null,
}));
jest.mock('@canopy/ui-shared/panels', () => ({
  ...jest.requireActual<typeof PanelPrimitives>('@canopy/ui-shared/panels'),
  registerWindow: jest.fn(() => ({ dispose: jest.fn() })),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe('AuxPanelWindow titlebar', () => {
  let container: HTMLDivElement;
  let frame: HTMLIFrameElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    frame = document.createElement('iframe');
    document.body.append(container, frame);
    root = createRoot(container);
    mockMergeBack.mockClear();
  });

  afterEach(() => {
    act(() => root.unmount());
    frame.remove();
    container.remove();
    Reflect.deleteProperty(window, 'localPlatform');
    Reflect.deleteProperty(window, 'platform');
    jest.restoreAllMocks();
  });

  it.each<NodeJS.Platform>(['linux', 'darwin', 'win32'])(
    'uses local %s chrome while preserving source and merge-back',
    (platform) => {
      Object.defineProperty(window, 'localPlatform', {
        configurable: true,
        value: platform,
      });
      Object.defineProperty(window, 'platform', {
        configurable: true,
        value: platform === 'linux' ? 'darwin' : 'linux',
      });
      const childWindow = frame.contentWindow;
      if (!childWindow) throw new Error('Missing child window');
      jest.spyOn(childWindow, 'close').mockImplementation(() => {});
      const setProperty = jest.spyOn(
        CSSStyleDeclaration.prototype,
        'setProperty',
      );
      act(() => {
        root.render(
          <AuxPanelWindow
            record={{
              auxWindowId: 'aux-fixture',
              worktreeKey: 'fixture',
              layoutKey: 'aux-layout',
              sourceGroupId: 'source-group',
              childWindow,
              status: 'open',
              focusOnOpen: false,
            }}
            hostState={DEFAULT_PANEL_HOST_STATE}
          />,
        );
      });
      const header = childWindow.document.querySelector<HTMLElement>(
        '[data-testid="panel-aux-window-top-bar"]',
      );
      expect(header).not.toBeNull();
      expect(childWindow.document.body.hasAttribute('data-app-selection')).toBe(
        true,
      );
      // jsdom does not implement Electron's CSS property. Verify the real
      // portal header's inline write, not a mocked style helper.
      expect(
        setProperty.mock.calls.filter(
          ([property], index) =>
            property === '-webkit-app-region' &&
            setProperty.mock.contexts[index] === header?.style,
        ),
      ).toEqual([
        ['-webkit-app-region', platform === 'linux' ? 'no-drag' : 'drag'],
      ]);
      expect(header?.style.paddingLeft).toBe(
        platform === 'linux' ? '8px' : 'calc(78px / var(--ui-zoom, 1))',
      );
      expect(header?.textContent).toContain('Project / main');
      const merge = header?.querySelector<HTMLButtonElement>(
        '[data-testid="panel-aux-window-merge-back"]',
      );
      expect(merge).toBeTruthy();
      act(() => merge?.click());
      expect(mockMergeBack).toHaveBeenCalledWith('aux-fixture');
    },
  );
});
