/** @jest-environment jsdom */

import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { PanelTabModel } from '@canopy/ui-shared/panels';
import { PanelTabContextMenu } from '../PanelTabContextMenu';
import {
  makeWorktreePanelKey,
  usePanelLayoutStore,
  type DefaultLayoutDescriptor,
} from '@/stores/panelLayoutStore';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

const CHAT_A_INSTANCE = { chatTabId: 'chat-a' } as const;

const ONE_GROUP: DefaultLayoutDescriptor = {
  orientation: 'horizontal',
  groups: [
    {
      kind: 'chat',
      groupId: 'group-a',
      panelId: 'panel-a',
      instance: CHAT_A_INSTANCE,
    },
  ],
  containerSize: { width: 800, height: 600 },
};

const TWO_GROUPS: DefaultLayoutDescriptor = {
  orientation: 'horizontal',
  groups: [
    {
      kind: 'chat',
      groupId: 'group-a',
      panelId: 'panel-a',
      instance: CHAT_A_INSTANCE,
    },
    { kind: 'terminal', groupId: 'group-b', panelId: 'panel-b' },
  ],
  containerSize: { width: 800, height: 600 },
};

const FILE_GROUP: DefaultLayoutDescriptor = {
  orientation: 'horizontal',
  groups: [
    {
      kind: 'file-diff',
      groupId: 'group-file',
      panelId: 'panel-file',
      instance: { fileTabId: 'file-a', filePath: '/repo/src/file.ts' },
    },
  ],
  containerSize: { width: 800, height: 600 },
};

const FILE_ID_ONLY_GROUP: DefaultLayoutDescriptor = {
  orientation: 'horizontal',
  groups: [
    {
      kind: 'file-diff',
      groupId: 'group-file',
      panelId: 'panel-file',
      instance: { fileTabId: 'file-a' },
    },
  ],
  containerSize: { width: 800, height: 600 },
};

const FILE_STALE_EMPTY_PATH_GROUP: DefaultLayoutDescriptor = {
  orientation: 'horizontal',
  groups: [
    {
      kind: 'file-diff',
      groupId: 'group-file',
      panelId: 'panel-file',
      instance: { fileTabId: 'file-a', filePath: '' },
    },
  ],
  containerSize: { width: 800, height: 600 },
};

let keyCounter = 0;

function nextKey(): string {
  keyCounter += 1;
  return makeWorktreePanelKey('project', `context-menu-${keyCounter}`);
}

function store(): ReturnType<typeof usePanelLayoutStore.getState> {
  return usePanelLayoutStore.getState();
}

function render(node: JSX.Element): { container: HTMLDivElement; root: Root } {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  return { container, root };
}

function getButton(testId: string): HTMLButtonElement {
  const element = document.body.querySelector(`[data-testid="${testId}"]`);
  if (!(element instanceof HTMLButtonElement)) {
    throw new Error(`Expected button with data-testid ${testId}`);
  }
  return element;
}

afterEach(() => {
  for (const key of Object.keys(store().layouts)) {
    store().disposeLayout(key);
  }
  document.body.replaceChildren();
  jest.clearAllMocks();
});

describe('PanelTabContextMenu split actions', () => {
  test('offers the host start-page action for an eligible tab', () => {
    const key = nextKey();
    store().initializeLayout(key, FILE_GROUP);
    const onToggleStartPage = jest.fn<void, [PanelTabModel]>();

    const { root } = render(
      <PanelTabContextMenu
        layoutKey={key}
        target={{
          groupId: 'group-file',
          panelId: 'panel-file',
          x: 10,
          y: 10,
        }}
        onClose={jest.fn()}
        getStartPageMenuState={() => ({ isStartPage: false })}
        onToggleStartPage={onToggleStartPage}
      />,
    );

    const button = getButton('panel-tab-context-start-page');
    expect(button.textContent).toBe('Set as start page');
    act(() => button.click());
    expect(onToggleStartPage).toHaveBeenCalledTimes(1);
    expect(onToggleStartPage.mock.calls[0]?.[0]).toMatchObject({
      kind: 'file-diff',
      instance: { filePath: '/repo/src/file.ts' },
    });

    act(() => root.unmount());
  });

  test('classic tabs in a locked (Minimal) layout offer only Close', () => {
    const key = nextKey();
    store().initializeLayout(key, FILE_GROUP);

    const { root } = render(
      <PanelTabContextMenu
        layoutKey={key}
        target={{
          groupId: 'group-file',
          panelId: 'panel-file',
          x: 10,
          y: 10,
        }}
        layoutLocked
        onClose={jest.fn()}
        onOpenFileInFileManager={jest.fn()}
        onCopyFilePath={jest.fn()}
        onCopyRelativeFilePath={jest.fn()}
        getStartPageMenuState={() => ({ isStartPage: false })}
        onToggleStartPage={jest.fn()}
      />,
    );

    expect(
      document.body.querySelector(
        '[data-testid="panel-tab-context-open-in-file-manager"]',
      ),
    ).toBeNull();
    expect(
      document.body.querySelector(
        '[data-testid="panel-tab-context-copy-path"]',
      ),
    ).toBeNull();
    expect(
      document.body.querySelector(
        '[data-testid="panel-tab-context-start-page"]',
      ),
    ).toBeNull();
    expect(getButton('panel-tab-context-close').textContent).toBe('Close');

    act(() => root.unmount());
  });

  test('fill tabs in a locked (Minimal) layout keep tab actions but drop layout changes', () => {
    const key = nextKey();
    store().initializeLayout(key, FILE_GROUP);

    const { root } = render(
      <PanelTabContextMenu
        layoutKey={key}
        target={{
          groupId: 'group-file',
          panelId: 'panel-file',
          x: 10,
          y: 10,
        }}
        layoutLocked
        tabStyle="fill"
        onClose={jest.fn()}
        onNewWindow={jest.fn()}
        onFullScreen={jest.fn()}
        onOpenFileInFileManager={jest.fn()}
        onCopyFilePath={jest.fn()}
        onCopyRelativeFilePath={jest.fn()}
      />,
    );

    expect(getButton('panel-tab-context-pin').textContent).toBe('Pin tab');
    expect(getButton('panel-tab-context-close').textContent).toBe('Close');
    expect(getButton('panel-tab-context-close-others')).toBeTruthy();
    expect(getButton('panel-tab-context-copy-path')).toBeTruthy();
    expect(getButton('panel-tab-context-open-in-file-manager')).toBeTruthy();
    for (const testId of [
      'panel-tab-context-split-right',
      'panel-tab-context-new-window',
      'panel-tab-context-full-screen',
      'panel-tab-context-close-all',
    ]) {
      expect(
        document.body.querySelector(`[data-testid="${testId}"]`),
      ).toBeNull();
    }

    act(() => root.unmount());
  });

  test('adds divided copy-path and file-manager sections for file tabs', () => {
    const key = nextKey();
    store().initializeLayout(key, FILE_GROUP);
    const showInFinder = jest.fn<Promise<void>, [{ absolutePath: string }]>(
      () => Promise.resolve(),
    );
    const onCopyFilePath = jest.fn();
    const onCopyRelativeFilePath = jest.fn();
    Object.defineProperty(window, 'platform', {
      configurable: true,
      value: 'darwin',
    });

    const { root } = render(
      <PanelTabContextMenu
        layoutKey={key}
        target={{
          groupId: 'group-file',
          panelId: 'panel-file',
          x: 10,
          y: 10,
        }}
        onClose={jest.fn()}
        onOpenFileInFileManager={(absolutePath): void => {
          void showInFinder({ absolutePath });
        }}
        onCopyFilePath={onCopyFilePath}
        onCopyRelativeFilePath={onCopyRelativeFilePath}
      />,
    );

    const copyPathButton = getButton('panel-tab-context-copy-path');
    const copyRelativePathButton = getButton(
      'panel-tab-context-copy-relative-path',
    );
    const button = getButton('panel-tab-context-open-in-file-manager');
    const menu = document.body.querySelector(
      '[data-testid="panel-tab-context-menu"]',
    );
    expect(button.textContent).toBe('Open in Finder');
    expect(copyPathButton.textContent).toBe('Copy path');
    expect(copyRelativePathButton.textContent).toBe('Copy relative path');
    expect(copyPathButton.previousElementSibling?.getAttribute('role')).toBe(
      'separator',
    );
    expect(copyRelativePathButton.previousElementSibling).toBe(copyPathButton);
    // The file rows form one group; the close rows come last.
    expect(button.previousElementSibling).toBe(copyRelativePathButton);
    expect(button.nextElementSibling?.getAttribute('role')).toBe('separator');
    expect(menu?.lastElementChild?.getAttribute('data-testid')).toBe(
      'panel-tab-context-close-all',
    );
    // Similar rows share one icon: only the first row of a run shows it.
    expect(copyPathButton.querySelector('svg')).not.toBeNull();
    expect(copyRelativePathButton.querySelector('svg')).toBeNull();
    expect(button.querySelector('svg')).not.toBeNull();
    expect(
      getButton('panel-tab-context-close').querySelector('svg'),
    ).not.toBeNull();
    expect(
      getButton('panel-tab-context-close-all').querySelector('svg'),
    ).toBeNull();

    act(() => {
      copyPathButton.click();
      copyRelativePathButton.click();
    });
    expect(onCopyFilePath).toHaveBeenCalledWith('/repo/src/file.ts');
    expect(onCopyRelativeFilePath).toHaveBeenCalledWith('/repo/src/file.ts');

    act(() => {
      button.click();
    });
    expect(showInFinder).toHaveBeenCalledWith({
      absolutePath: '/repo/src/file.ts',
    });

    act(() => {
      root.unmount();
    });
  });

  test('resolves file-manager paths for panels bound only by fileTabId', () => {
    const key = nextKey();
    store().initializeLayout(key, FILE_ID_ONLY_GROUP);
    const onOpenFileInFileManager = jest.fn();
    const resolveFileTabPath = jest.fn(() => '/repo/src/legacy.ts');

    const { root } = render(
      <PanelTabContextMenu
        layoutKey={key}
        target={{
          groupId: 'group-file',
          panelId: 'panel-file',
          x: 10,
          y: 10,
        }}
        onClose={jest.fn()}
        onOpenFileInFileManager={onOpenFileInFileManager}
        resolveFileTabPath={resolveFileTabPath}
      />,
    );

    act(() => {
      getButton('panel-tab-context-open-in-file-manager').click();
    });
    expect(resolveFileTabPath).toHaveBeenCalledWith('file-a');
    expect(onOpenFileInFileManager).toHaveBeenCalledWith('/repo/src/legacy.ts');

    act(() => {
      root.unmount();
    });
  });

  test('prefers the live file-tab path over a stale empty panel path', () => {
    const key = nextKey();
    store().initializeLayout(key, FILE_STALE_EMPTY_PATH_GROUP);
    const onCopyFilePath = jest.fn();
    const resolveFileTabPath = jest.fn(() => '/repo/src/assigned.ts');

    const { root } = render(
      <PanelTabContextMenu
        layoutKey={key}
        target={{
          groupId: 'group-file',
          panelId: 'panel-file',
          x: 10,
          y: 10,
        }}
        onClose={jest.fn()}
        onCopyFilePath={onCopyFilePath}
        resolveFileTabPath={resolveFileTabPath}
      />,
    );

    act(() => {
      getButton('panel-tab-context-copy-path').click();
    });
    expect(resolveFileTabPath).toHaveBeenCalledWith('file-a');
    expect(onCopyFilePath).toHaveBeenCalledWith('/repo/src/assigned.ts');

    act(() => root.unmount());
  });

  test('offers New Window for a poppable tab', () => {
    const key = nextKey();
    store().initializeLayout(key, ONE_GROUP);
    const onNewWindow = jest.fn();

    const { root } = render(
      <PanelTabContextMenu
        layoutKey={key}
        target={{ groupId: 'group-a', panelId: 'panel-a', x: 10, y: 10 }}
        onClose={jest.fn()}
        onNewWindow={onNewWindow}
      />,
    );

    const button = getButton('panel-tab-context-new-window');
    expect(button.disabled).toBe(false);
    act(() => {
      button.click();
    });
    expect(onNewWindow).toHaveBeenCalledWith('group-a', 'panel-a');

    act(() => {
      root.unmount();
    });
  });

  test('hides New Window when the host omits pop-out semantics', () => {
    const key = nextKey();
    store().initializeLayout(key, ONE_GROUP);

    const { root } = render(
      <PanelTabContextMenu
        layoutKey={key}
        target={{ groupId: 'group-a', panelId: 'panel-a', x: 10, y: 10 }}
        onClose={jest.fn()}
      />,
    );

    expect(
      document.body.querySelector(
        '[data-testid="panel-tab-context-new-window"]',
      ),
    ).toBeNull();

    act(() => {
      root.unmount();
    });
  });

  test('offers distinct share and export actions for chat tabs', () => {
    const key = nextKey();
    store().initializeLayout(key, ONE_GROUP);
    const onShareSession = jest.fn();
    const onExportSession = jest.fn();

    const { root } = render(
      <PanelTabContextMenu
        layoutKey={key}
        target={{ groupId: 'group-a', panelId: 'panel-a', x: 10, y: 10 }}
        onClose={jest.fn()}
        onShareSession={onShareSession}
        onExportSession={onExportSession}
      />,
    );

    expect(getButton('panel-tab-context-share-run').textContent).toBe(
      'Share session',
    );
    const exportButton = getButton('panel-tab-context-export-session');
    expect(exportButton.textContent).toBe('Export session');
    act(() => exportButton.click());
    expect(onExportSession).toHaveBeenCalledWith('chat-a', undefined);
    expect(onShareSession).not.toHaveBeenCalled();

    act(() => root.unmount());
  });

  test('offers Rename after Pin for chat tabs when the host supports it', () => {
    const key = nextKey();
    store().initializeLayout(key, TWO_GROUPS);
    const onRenameChat = jest.fn();
    const auxDocument = document.implementation.createHTMLDocument('aux');

    const { root } = render(
      <PanelTabContextMenu
        layoutKey={key}
        target={{ groupId: 'group-a', panelId: 'panel-a', x: 10, y: 10 }}
        onClose={jest.fn()}
        onRenameChat={onRenameChat}
      />,
    );

    const testIds = Array.from(
      document.body.querySelectorAll('[data-testid^="panel-tab-context-"]'),
    ).map((element) => element.getAttribute('data-testid'));
    expect(testIds.slice(0, 3)).toEqual([
      'panel-tab-context-menu',
      'panel-tab-context-pin',
      'panel-tab-context-rename',
    ]);
    const rename = getButton('panel-tab-context-rename');
    expect(rename.textContent).toBe('Rename…');
    act(() => rename.click());
    expect(onRenameChat).toHaveBeenCalledWith('chat-a', undefined);
    act(() => root.unmount());

    // The owner document is forwarded for auxiliary windows.
    const aux = render(
      <PanelTabContextMenu
        layoutKey={key}
        target={{ groupId: 'group-a', panelId: 'panel-a', x: 10, y: 10 }}
        onClose={jest.fn()}
        onRenameChat={onRenameChat}
        ownerDocument={auxDocument}
      />,
    );
    const auxRename = auxDocument.body.querySelector(
      '[data-testid="panel-tab-context-rename"]',
    );
    act(() => {
      auxRename?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onRenameChat).toHaveBeenLastCalledWith('chat-a', auxDocument);
    act(() => aux.root.unmount());
  });

  test.each([
    ['an unsupported host', ONE_GROUP, 'group-a', 'panel-a', {}],
    [
      'a file panel',
      FILE_GROUP,
      'group-file',
      'panel-file',
      { onRenameChat: jest.fn() },
    ],
    [
      'a closeOnly menu',
      ONE_GROUP,
      'group-a',
      'panel-a',
      { onRenameChat: jest.fn(), layoutLocked: true },
    ],
  ] as const)(
    'hides Rename for %s',
    (_label, layout, groupId, panelId, extra) => {
      const key = nextKey();
      store().initializeLayout(key, layout);
      const { root } = render(
        <PanelTabContextMenu
          layoutKey={key}
          target={{ groupId, panelId, x: 10, y: 10 }}
          onClose={jest.fn()}
          {...extra}
        />,
      );
      expect(
        document.body.querySelector('[data-testid="panel-tab-context-rename"]'),
      ).toBeNull();
      act(() => root.unmount());
    },
  );

  test('keeps Rename in the locked fill layout', () => {
    const key = nextKey();
    store().initializeLayout(key, ONE_GROUP);
    const { root } = render(
      <PanelTabContextMenu
        layoutKey={key}
        target={{ groupId: 'group-a', panelId: 'panel-a', x: 10, y: 10 }}
        onClose={jest.fn()}
        onRenameChat={jest.fn()}
        layoutLocked
        tabStyle="fill"
      />,
    );
    expect(getButton('panel-tab-context-rename').textContent).toBe('Rename…');
    act(() => root.unmount());
  });

  test('splits and moves the clicked tab when the group has another tab', () => {
    const key = nextKey();
    store().initializeLayout(key, ONE_GROUP);
    store().addTab(key, 'group-a', 'terminal', { panelId: 'panel-b' });
    const onClose = jest.fn();

    const { root } = render(
      <PanelTabContextMenu
        layoutKey={key}
        target={{ groupId: 'group-a', panelId: 'panel-a', x: 10, y: 10 }}
        onClose={onClose}
      />,
    );

    act(() => {
      getButton('panel-tab-context-split-right').click();
    });

    const viewModel = store().layouts[key].viewModel;
    const source = viewModel.groups.find(
      (group) => group.groupId === 'group-a',
    );
    expect(source?.tabs.map((tab) => tab.panelId)).toEqual(['panel-b']);
    const movedGroup = viewModel.groups.find((group) =>
      group.tabs.some((tab) => tab.panelId === 'panel-a'),
    );
    expect(movedGroup?.groupId).not.toBe('group-a');
    expect(viewModel.activeGroupId).toBe(movedGroup?.groupId);
    expect(onClose).toHaveBeenCalledTimes(1);

    act(() => {
      root.unmount();
    });
  });

  test('keeps split actions visible but disabled for the only tab in a group', () => {
    const key = nextKey();
    store().initializeLayout(key, ONE_GROUP);

    const { root } = render(
      <PanelTabContextMenu
        layoutKey={key}
        target={{ groupId: 'group-a', panelId: 'panel-a', x: 10, y: 10 }}
        onClose={jest.fn()}
      />,
    );

    for (const direction of ['up', 'down', 'left', 'right']) {
      const button = getButton(`panel-tab-context-split-${direction}`);
      expect(button.disabled).toBe(true);
    }

    act(() => {
      getButton('panel-tab-context-split-right').click();
    });
    expect(store().layouts[key].viewModel.groups).toHaveLength(1);

    act(() => {
      root.unmount();
    });
  });

  test('groups New Window and Full screen under a divider after the splits', () => {
    const key = nextKey();
    store().initializeLayout(key, TWO_GROUPS);
    const onFullScreen = jest.fn();

    const { root } = render(
      <PanelTabContextMenu
        layoutKey={key}
        target={{ groupId: 'group-a', panelId: 'panel-a', x: 10, y: 10 }}
        onClose={jest.fn()}
        onNewWindow={jest.fn()}
        onFullScreen={onFullScreen}
      />,
    );

    const splitRight = getButton('panel-tab-context-split-right');
    const newWindow = getButton('panel-tab-context-new-window');
    const fullScreen = getButton('panel-tab-context-full-screen');
    const close = getButton('panel-tab-context-close');
    expect(fullScreen.textContent).toBe('Full screen');
    expect(fullScreen.disabled).toBe(false);
    expect(splitRight.nextElementSibling?.getAttribute('role')).toBe(
      'separator',
    );
    expect(splitRight.nextElementSibling?.nextElementSibling).toBe(newWindow);
    expect(newWindow.nextElementSibling).toBe(fullScreen);
    expect(fullScreen.nextElementSibling?.getAttribute('role')).toBe(
      'separator',
    );
    expect(fullScreen.nextElementSibling?.nextElementSibling).toBe(close);

    act(() => fullScreen.click());
    expect(onFullScreen).toHaveBeenCalledWith('group-a', 'panel-a');

    act(() => root.unmount());
  });

  test('keeps the window divider when only Full screen is offered', () => {
    const key = nextKey();
    store().initializeLayout(key, TWO_GROUPS);

    const { root } = render(
      <PanelTabContextMenu
        layoutKey={key}
        target={{ groupId: 'group-a', panelId: 'panel-a', x: 10, y: 10 }}
        onClose={jest.fn()}
        onFullScreen={jest.fn()}
      />,
    );

    const fullScreen = getButton('panel-tab-context-full-screen');
    expect(fullScreen.previousElementSibling?.getAttribute('role')).toBe(
      'separator',
    );
    expect(getButton('panel-tab-context-split-right').nextElementSibling).toBe(
      fullScreen.previousElementSibling,
    );

    act(() => root.unmount());
  });

  test('disables Full screen for a lone group and hides it while maximized', () => {
    const loneKey = nextKey();
    store().initializeLayout(loneKey, ONE_GROUP);
    const lone = render(
      <PanelTabContextMenu
        layoutKey={loneKey}
        target={{ groupId: 'group-a', panelId: 'panel-a', x: 10, y: 10 }}
        onClose={jest.fn()}
        onFullScreen={jest.fn()}
      />,
    );
    expect(getButton('panel-tab-context-full-screen').disabled).toBe(true);
    act(() => lone.root.unmount());
    document.body.replaceChildren();

    const key = nextKey();
    store().initializeLayout(key, TWO_GROUPS);
    store().maximizeGroup(key, 'group-a', true);
    const maximized = render(
      <PanelTabContextMenu
        layoutKey={key}
        target={{ groupId: 'group-a', panelId: 'panel-a', x: 10, y: 10 }}
        onClose={jest.fn()}
        onFullScreen={jest.fn()}
      />,
    );
    expect(
      document.body.querySelector(
        '[data-testid="panel-tab-context-full-screen"]',
      ),
    ).toBeNull();
    act(() => maximized.root.unmount());
  });

  test('hides Full screen when the host omits it', () => {
    const key = nextKey();
    store().initializeLayout(key, TWO_GROUPS);

    const { root } = render(
      <PanelTabContextMenu
        layoutKey={key}
        target={{ groupId: 'group-a', panelId: 'panel-a', x: 10, y: 10 }}
        onClose={jest.fn()}
      />,
    );

    expect(
      document.body.querySelector(
        '[data-testid="panel-tab-context-full-screen"]',
      ),
    ).toBeNull();
    expect(
      getButton('panel-tab-context-split-right').nextElementSibling
        ?.nextElementSibling,
    ).toBe(getButton('panel-tab-context-close'));

    act(() => root.unmount());
  });
});
