/** @jest-environment jsdom */

/**
 * Shared panel reveal seam, exercised against the real panel layout and
 * auxiliary-window stores. Auxiliary child windows are real (iframe-backed)
 * jsdom windows whose `focus()` is spied on.
 */
import {
  makeAuxPanelLayoutKey,
  makeWorktreePanelKey,
  usePanelLayoutStore,
  type DefaultLayoutDescriptor,
  type PanelInstanceLocation,
} from '@/stores/panelLayoutStore';
import {
  usePanelWindowsStore,
  type PanelAuxWindowStatus,
} from '@/stores/panelWindowsStore';
import {
  findAuxWindowForLayout,
  findPanelLocation,
  focusAuxWindowForLayout,
  revealPanel,
} from '../panel-reveal';

const KEY = makeWorktreePanelKey('project-1', 'worktree-1');
const AUX_KEY = makeAuxPanelLayoutKey(KEY, 'aux-1');

const MAIN_LAYOUT: DefaultLayoutDescriptor = {
  orientation: 'horizontal',
  groups: [
    { kind: 'chat', groupId: 'group-chat', panelId: 'panel-chat' },
    { kind: 'terminal', groupId: 'group-terminal', panelId: 'panel-terminal' },
  ],
  containerSize: { width: 1200, height: 800 },
};

const DIAGRAM: PanelInstanceLocation = {
  layoutKey: KEY,
  groupId: 'group-chat',
  panelId: 'panel-diagram',
};

const AUX_TERMINAL: PanelInstanceLocation = {
  layoutKey: AUX_KEY,
  groupId: 'group-aux',
  panelId: 'panel-aux-terminal-2',
};

const frames: HTMLIFrameElement[] = [];

function store(): ReturnType<typeof usePanelLayoutStore.getState> {
  return usePanelLayoutStore.getState();
}

/** Main layout with a Change Diagram behind the active chat in group-chat. */
function initMainLayout(): void {
  store().initializeLayout(KEY, MAIN_LAYOUT);
  store().addTab(KEY, 'group-chat', 'change-diagram', {
    panelId: DIAGRAM.panelId,
    title: 'Change Diagram',
  });
  store().selectTab(KEY, 'group-chat', 'panel-chat');
}

/** Aux layout with a second terminal behind the active one. */
function initAuxLayout(): void {
  store().initializeLayout(AUX_KEY, {
    orientation: 'horizontal',
    groups: [
      {
        kind: 'terminal',
        groupId: AUX_TERMINAL.groupId,
        panelId: 'panel-aux-terminal',
        instance: { terminalId: 'term-aux' },
      },
    ],
    containerSize: { width: 800, height: 600 },
  });
  store().addTab(AUX_KEY, AUX_TERMINAL.groupId, 'terminal', {
    panelId: AUX_TERMINAL.panelId,
    instance: { terminalId: 'term-aux-2' },
  });
  store().selectTab(AUX_KEY, AUX_TERMINAL.groupId, 'panel-aux-terminal');
}

function createChildWindow(): Window {
  const frame = document.createElement('iframe');
  document.body.appendChild(frame);
  frames.push(frame);
  const childWindow = frame.contentWindow;
  if (childWindow === null) {
    throw new Error('Expected the test iframe to expose a window');
  }
  return childWindow;
}

/** Registers an aux window record for AUX_KEY and spies on its focus(). */
function registerAuxWindow(status: PanelAuxWindowStatus = 'open'): {
  focus: jest.SpyInstance<void, []>;
  childWindow: Window;
} {
  const childWindow = createChildWindow();
  const focus = jest
    .spyOn(childWindow, 'focus')
    .mockImplementation((): void => undefined);
  usePanelWindowsStore.setState({
    auxWindows: {
      'aux-1': {
        auxWindowId: 'aux-1',
        worktreeKey: KEY,
        layoutKey: AUX_KEY,
        sourceGroupId: 'group-terminal',
        childWindow,
        status,
        focusOnOpen: false,
      },
    },
  });
  return { focus, childWindow };
}

afterEach(() => {
  for (const frame of frames.splice(0)) frame.remove();
  usePanelWindowsStore.setState({ auxWindows: {} });
  for (const layoutKey of Object.keys(store().layouts)) {
    store().disposeLayout(layoutKey);
  }
});

describe('revealPanel', () => {
  test('exits a maximize held by another group, then selects and focuses the panel', () => {
    initMainLayout();
    store().maximizeGroup(KEY, 'group-terminal', true);

    revealPanel(DIAGRAM);

    const layout = store().layouts[KEY];
    expect(layout.maximizedGroupId).toBeNull();
    expect(layout.activeGroupId).toBe('group-chat');
    expect(layout.mruGroupIds[0]).toBe('group-chat');
    expect(layout.groups['group-chat'].activePanelId).toBe(DIAGRAM.panelId);
  });

  test('keeps a maximize held by the panel group', () => {
    initMainLayout();
    store().maximizeGroup(KEY, 'group-chat', true);

    revealPanel(DIAGRAM);

    const layout = store().layouts[KEY];
    expect(layout.maximizedGroupId).toBe('group-chat');
    expect(layout.groups['group-chat'].activePanelId).toBe(DIAGRAM.panelId);
  });

  test('expands a collapsed group before selecting the panel', () => {
    initMainLayout();
    expect(store().collapseGroup(KEY, 'group-chat')).toBe(true);

    revealPanel(DIAGRAM);

    const layout = store().layouts[KEY];
    expect(layout.groups['group-chat'].collapsed).toBeUndefined();
    expect(layout.groups['group-chat'].activePanelId).toBe(DIAGRAM.panelId);
  });

  test('is a no-op for a passive reveal', () => {
    initMainLayout();
    initAuxLayout();
    const { focus } = registerAuxWindow();
    store().maximizeGroup(KEY, 'group-terminal', true);
    const mainBefore = store().layouts[KEY];
    const auxBefore = store().layouts[AUX_KEY];

    revealPanel(DIAGRAM, { focus: false });
    revealPanel(AUX_TERMINAL, { focus: false });

    expect(store().layouts[KEY]).toBe(mainBefore);
    expect(store().layouts[AUX_KEY]).toBe(auxBefore);
    expect(focus).not.toHaveBeenCalled();
  });

  test('focuses the auxiliary window that hosts the panel', () => {
    initMainLayout();
    initAuxLayout();
    const { focus } = registerAuxWindow();

    revealPanel(AUX_TERMINAL);

    expect(focus).toHaveBeenCalledTimes(1);
    expect(store().layouts[AUX_KEY].groups['group-aux'].activePanelId).toBe(
      AUX_TERMINAL.panelId,
    );
  });

  test('does not focus an auxiliary window for a main-layout panel', () => {
    initMainLayout();
    initAuxLayout();
    const { focus } = registerAuxWindow();

    revealPanel(DIAGRAM);

    expect(focus).not.toHaveBeenCalled();
  });

  test('selects without focusing the window when focusWindow is false', () => {
    initMainLayout();
    initAuxLayout();
    const { focus } = registerAuxWindow();

    revealPanel(AUX_TERMINAL, { focusWindow: false });

    expect(focus).not.toHaveBeenCalled();
    expect(store().layouts[AUX_KEY].groups['group-aux'].activePanelId).toBe(
      AUX_TERMINAL.panelId,
    );
  });
});

describe('auxiliary window lookup and focus', () => {
  test('finds only the record rendering the layout', () => {
    registerAuxWindow();

    expect(findAuxWindowForLayout(AUX_KEY)?.auxWindowId).toBe('aux-1');
    expect(findAuxWindowForLayout(KEY)).toBeNull();
    expect(
      findAuxWindowForLayout(makeAuxPanelLayoutKey(KEY, 'aux-2')),
    ).toBeNull();
  });

  test('focuses an open window', () => {
    const { focus } = registerAuxWindow();

    expect(focusAuxWindowForLayout(AUX_KEY)).toBe(true);
    expect(focus).toHaveBeenCalledTimes(1);
  });

  test('skips a window that is merging back', () => {
    const { focus } = registerAuxWindow('merging');

    expect(focusAuxWindowForLayout(AUX_KEY)).toBe(false);
    expect(focus).not.toHaveBeenCalled();
  });

  test('skips a window that has closed', () => {
    const { focus, childWindow } = registerAuxWindow();
    // jsdom does not model `closed` for frame windows; stand in for a closed
    // OS window the way a browser reports it.
    Object.defineProperty(childWindow, 'closed', {
      configurable: true,
      get: (): boolean => true,
    });

    expect(focusAuxWindowForLayout(AUX_KEY)).toBe(false);
    expect(focus).not.toHaveBeenCalled();
  });

  test('swallows a focus failure from a closing window', () => {
    const { focus } = registerAuxWindow();
    focus.mockImplementation((): void => {
      throw new Error('window is closing');
    });

    expect(focusAuxWindowForLayout(AUX_KEY)).toBe(false);
  });

  test('reports no window for a layout without a record', () => {
    expect(focusAuxWindowForLayout(AUX_KEY)).toBe(false);
  });
});

describe('findPanelLocation', () => {
  test('searches the main layout before auxiliary layouts', () => {
    initMainLayout();
    store().initializeLayout(AUX_KEY, {
      orientation: 'horizontal',
      groups: [
        { kind: 'terminal', groupId: 'group-aux', panelId: 'panel-chat' },
      ],
      containerSize: { width: 800, height: 600 },
    });

    expect(findPanelLocation(KEY, 'panel-chat')).toEqual({
      layoutKey: KEY,
      groupId: 'group-chat',
      panelId: 'panel-chat',
    });
  });

  test('finds a panel in an auxiliary layout of the family', () => {
    initMainLayout();
    initAuxLayout();

    expect(findPanelLocation(KEY, AUX_TERMINAL.panelId)).toEqual(AUX_TERMINAL);
  });

  test('ignores layouts of other worktrees and unknown panels', () => {
    initMainLayout();
    const otherKey = makeWorktreePanelKey('project-2', 'worktree-2');
    store().initializeLayout(makeAuxPanelLayoutKey(otherKey, 'aux-9'), {
      orientation: 'horizontal',
      groups: [
        { kind: 'terminal', groupId: 'group-other', panelId: 'panel-other' },
      ],
      containerSize: { width: 800, height: 600 },
    });

    expect(findPanelLocation(KEY, 'panel-other')).toBeNull();
    expect(findPanelLocation(KEY, 'panel-missing')).toBeNull();
  });
});
