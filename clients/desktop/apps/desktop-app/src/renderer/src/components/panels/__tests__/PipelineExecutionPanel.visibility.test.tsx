/**
 * @jest-environment jsdom
 *
 * The pipeline run panel's visibility gate, end to end through the REAL
 * content root (`PanelContentRoot`), panel layout store, and registry
 * wrapper: tab visibility (selected tab, expanded group, no maximized
 * sibling) AND per-layout host visibility (main page for the main layout,
 * the aux window itself for a popped-out layout) AND the owning window's
 * document visibility, with the document listener rebinding when the panel
 * is adopted into an auxiliary window. The panel host itself is stubbed to
 * record the gate it receives; its data behavior is covered in
 * `PipelineExecutionPanel.test.tsx`.
 *
 * Also covers the host-visibility fix for the existing consumers of
 * `usePanelHostState().visible` (File Explorer) in auxiliary windows.
 */
import { act } from 'react';
import type * as ReactNamespace from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  makeAuxPanelLayoutKey,
  makeWorktreePanelKey,
  usePanelLayoutStore,
  type DefaultLayoutDescriptor,
} from '@/stores/panelLayoutStore';
import { usePanelWindowsStore } from '@/stores/panelWindowsStore';
import { useChatStore } from '@/stores/chatStore';
import {
  DEFAULT_PANEL_HOST_STATE,
  type PanelHostState,
} from '@/lib/panels/panel-host-context';
import {
  PanelContentRoot,
  resetPanelContentContainersForTests,
} from '../PanelContentRoot';

interface RecordedPanelProps {
  executionId: string;
  visible: boolean;
  ownerDocument?: Document;
}
const mockPanelProps = jest.fn<void, [RecordedPanelProps]>();
jest.mock('@/components/panels/pipeline/PipelineExecutionPanel', () => {
  const react = jest.requireActual<typeof ReactNamespace>('react');
  return {
    PipelineExecutionPanel: (props: RecordedPanelProps): unknown => {
      mockPanelProps(props);
      return react.createElement('div', {
        'data-testid': `stub-run-${props.executionId}`,
        'data-visible': String(props.visible),
      });
    },
  };
});
const mockFilesTreeProps = jest.fn();
jest.mock('@/components/activity/FilesTreeTab', () => ({
  FilesTreeTab: (props: { isVisible: boolean }): null => {
    mockFilesTreeProps(props);
    return null;
  },
}));
jest.mock('@/components/chat/WorktreeChatSurface', () => ({
  WorktreeChatSurface: (): null => null,
}));
jest.mock('@/components/chat/DesktopSharedFileViewer', () => ({
  DesktopSharedFileViewer: (): null => null,
}));
jest.mock('@/components/terminal/TerminalPanelSurface', () => ({
  TerminalPanelSurface: (): null => null,
}));
jest.mock('@/components/activity/SharedActivityPanelAdapter', () => ({
  SharedActivityPanelAdapter: (): null => null,
}));
jest.mock('@/components/browser/BrowserPanelSurface', () => ({
  BrowserPanelSurface: (): null => null,
}));
jest.mock('@/components/activity/activity-sections', () => ({
  ACTIVITY_SECTIONS: [],
  getActivitySectionDefinition: (): undefined => undefined,
  getActivitySectionsForSurface: (): never[] => [],
}));

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

const KEY = makeWorktreePanelKey('project-1', 'worktree-1');
const AUX_ID = 'aux-run';
const AUX_KEY = makeAuxPanelLayoutKey(KEY, AUX_ID);

function layout(): DefaultLayoutDescriptor {
  return {
    orientation: 'horizontal',
    groups: [
      {
        kind: 'chat',
        groupId: 'group-chat',
        panelId: 'panel-chat',
        instance: { chatTabId: 'chat-a' },
      },
      {
        kind: 'pipeline-execution',
        groupId: 'group-run',
        panelId: 'panel-pipeline-run-1',
        instance: { executionId: 'run-1' },
      },
      {
        kind: 'file-explorer',
        groupId: 'group-files',
        panelId: 'panel-file-explorer',
      },
    ],
    containerSize: { width: 1200, height: 700 },
  };
}

function lastPropsFor(executionId: string): RecordedPanelProps {
  const calls = mockPanelProps.mock.calls.filter(
    ([props]) => props.executionId === executionId,
  );
  const last = calls[calls.length - 1];
  if (last === undefined) throw new Error(`No render for ${executionId}`);
  return last[0];
}

function setVisibility(target: Document, state: 'visible' | 'hidden'): void {
  act(() => {
    Object.defineProperty(target, 'visibilityState', {
      configurable: true,
      value: state,
    });
    target.dispatchEvent(new Event('visibilitychange'));
  });
}

function resetVisibility(target: Document): void {
  Reflect.deleteProperty(target, 'visibilityState');
}

describe('pipeline run panel visibility gate', () => {
  let container: HTMLDivElement;
  let root: Root;
  let iframe: HTMLIFrameElement;

  beforeEach(() => {
    jest.clearAllMocks();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    iframe = document.createElement('iframe');
    document.body.append(iframe);
    useChatStore.setState({
      selectedWorktree: { projectId: 'project-1', worktreeId: 'worktree-1' },
      worktreeChats: {},
    });
    usePanelLayoutStore.getState().initializeLayout(KEY, layout());
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    const childDocument = iframe.contentDocument;
    if (childDocument !== null) resetVisibility(childDocument);
    iframe.remove();
    resetVisibility(document);
    usePanelWindowsStore.setState({ auxWindows: {} });
    const store = usePanelLayoutStore.getState();
    for (const key of Object.keys(store.layouts)) store.disposeLayout(key);
    resetPanelContentContainersForTests();
  });

  async function renderRoot(
    hostState: PanelHostState = { ...DEFAULT_PANEL_HOST_STATE, visible: true },
  ): Promise<void> {
    await act(async () => {
      root.render(<PanelContentRoot worktreeKey={KEY} hostState={hostState} />);
      await import('@/components/panels/pipeline/PipelineExecutionPanel');
    });
  }

  function popOutRunGroup(): void {
    const childWindow = iframe.contentWindow;
    if (childWindow === null) throw new Error('iframe has no window');
    act(() => {
      expect(
        usePanelLayoutStore
          .getState()
          .extractGroupToLayout(KEY, 'group-run', AUX_KEY),
      ).toBe(true);
      usePanelWindowsStore.setState({
        auxWindows: {
          [AUX_ID]: {
            auxWindowId: AUX_ID,
            worktreeKey: KEY,
            layoutKey: AUX_KEY,
            sourceGroupId: 'group-run',
            childWindow,
            status: 'open',
            focusOnOpen: false,
          },
        },
      });
    });
  }

  it('is visible as the selected tab of an expanded, unobscured group, beside a focused chat', async () => {
    await renderRoot();
    // The chat group is the active (focused) group; the run tab is only
    // visible, and that is enough.
    expect(
      usePanelLayoutStore.getState().layouts[KEY]?.viewModel.activeGroupId,
    ).toBe('group-chat');
    expect(lastPropsFor('run-1').visible).toBe(true);
    expect(lastPropsFor('run-1').ownerDocument).toBe(document);
  });

  it('is not visible when another tab is selected in its group', async () => {
    await renderRoot();
    act(() => {
      usePanelLayoutStore
        .getState()
        .addTab(KEY, 'group-run', 'pipeline-execution', {
          panelId: 'panel-pipeline-run-2',
          instance: { executionId: 'run-2' },
        });
    });
    expect(lastPropsFor('run-1').visible).toBe(false);
    expect(lastPropsFor('run-2').visible).toBe(true);
    act(() => {
      usePanelLayoutStore
        .getState()
        .selectTab(KEY, 'group-run', 'panel-pipeline-run-1');
    });
    expect(lastPropsFor('run-1').visible).toBe(true);
    expect(lastPropsFor('run-2').visible).toBe(false);
  });

  it('is not visible while its group is collapsed', async () => {
    await renderRoot();
    act(() => {
      usePanelLayoutStore.getState().collapseGroup(KEY, 'group-run');
    });
    expect(lastPropsFor('run-1').visible).toBe(false);
    act(() => {
      usePanelLayoutStore.getState().expandGroup(KEY, 'group-run');
    });
    expect(lastPropsFor('run-1').visible).toBe(true);
  });

  it('is not visible while a sibling group is maximized over it', async () => {
    await renderRoot();
    act(() => {
      usePanelLayoutStore.getState().maximizeGroup(KEY, 'group-chat', true);
    });
    expect(lastPropsFor('run-1').visible).toBe(false);
    act(() => {
      usePanelLayoutStore.getState().maximizeGroup(KEY, 'group-chat', false);
    });
    expect(lastPropsFor('run-1').visible).toBe(true);
  });

  it('is not visible while the main page is hidden', async () => {
    await renderRoot({ ...DEFAULT_PANEL_HOST_STATE, visible: false });
    // Never shown: the host is not even mounted.
    expect(mockPanelProps).not.toHaveBeenCalled();
    await renderRoot({ ...DEFAULT_PANEL_HOST_STATE, visible: true });
    expect(lastPropsFor('run-1').visible).toBe(true);
    await renderRoot({ ...DEFAULT_PANEL_HOST_STATE, visible: false });
    expect(lastPropsFor('run-1').visible).toBe(false);
  });

  it('is not visible while its document is hidden, and a lost focus alone changes nothing', async () => {
    await renderRoot();
    act(() => {
      window.dispatchEvent(new Event('blur'));
    });
    expect(lastPropsFor('run-1').visible).toBe(true);
    setVisibility(document, 'hidden');
    expect(lastPropsFor('run-1').visible).toBe(false);
    setVisibility(document, 'visible');
    expect(lastPropsFor('run-1').visible).toBe(true);
  });

  it('stays visible in an auxiliary window while the main page is hidden, and follows that window’s document', async () => {
    await renderRoot();
    popOutRunGroup();
    const childDocument = iframe.contentDocument;
    if (childDocument === null) throw new Error('iframe has no document');
    expect(lastPropsFor('run-1').ownerDocument).toBe(childDocument);
    expect(lastPropsFor('run-1').visible).toBe(true);

    // The main page leaves the worktree view: the aux window still shows it.
    await renderRoot({ ...DEFAULT_PANEL_HOST_STATE, visible: false });
    expect(lastPropsFor('run-1').visible).toBe(true);

    // The listener moved with the panel: the main document hiding no longer
    // matters, the aux window's document does.
    setVisibility(document, 'hidden');
    expect(lastPropsFor('run-1').visible).toBe(true);
    setVisibility(childDocument, 'hidden');
    expect(lastPropsFor('run-1').visible).toBe(false);
    setVisibility(childDocument, 'visible');
    expect(lastPropsFor('run-1').visible).toBe(true);
  });

  it('rebinds to the main document on merge-back', async () => {
    await renderRoot();
    popOutRunGroup();
    const childDocument = iframe.contentDocument;
    if (childDocument === null) throw new Error('iframe has no document');
    act(() => {
      expect(usePanelLayoutStore.getState().adoptLayoutTabs(AUX_KEY, KEY)).toBe(
        true,
      );
      usePanelWindowsStore.setState({ auxWindows: {} });
    });
    expect(lastPropsFor('run-1').ownerDocument).toBe(document);
    setVisibility(childDocument, 'hidden');
    expect(lastPropsFor('run-1').visible).toBe(true);
    setVisibility(document, 'hidden');
    expect(lastPropsFor('run-1').visible).toBe(false);
  });

  it('gives an existing host-visibility consumer (File Explorer) its own window’s visibility', async () => {
    await renderRoot({ ...DEFAULT_PANEL_HOST_STATE, visible: false });
    expect(mockFilesTreeProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ isVisible: false }),
    );
    const childWindow = iframe.contentWindow;
    if (childWindow === null) throw new Error('iframe has no window');
    act(() => {
      usePanelLayoutStore
        .getState()
        .extractGroupToLayout(KEY, 'group-files', AUX_KEY);
      usePanelWindowsStore.setState({
        auxWindows: {
          [AUX_ID]: {
            auxWindowId: AUX_ID,
            worktreeKey: KEY,
            layoutKey: AUX_KEY,
            sourceGroupId: 'group-files',
            childWindow,
            status: 'open',
            focusOnOpen: false,
          },
        },
      });
    });
    expect(mockFilesTreeProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ isVisible: true }),
    );
  });
});
