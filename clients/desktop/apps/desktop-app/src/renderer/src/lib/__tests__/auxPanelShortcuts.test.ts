import type * as NewTabShortcutModule from '../newTabShortcut';
import {
  handleAuxPanelNewTabShortcut,
  type AuxPanelNewTabKeyEvent,
} from '../auxPanelShortcuts';

const runNewTabShortcutMock = jest.fn<
  NewTabShortcutModule.NewTabSurfaceKind,
  [NewTabShortcutModule.RunNewTabShortcutParams]
>(() => 'chat');

jest.mock('../newTabShortcut', () => ({
  runNewTabShortcut: (
    params: NewTabShortcutModule.RunNewTabShortcutParams,
  ): NewTabShortcutModule.NewTabSurfaceKind => runNewTabShortcutMock(params),
}));

function shortcutEvent(
  target: EventTarget | null = null,
): AuxPanelNewTabKeyEvent {
  return {
    altKey: false,
    code: 'KeyT',
    ctrlKey: true,
    isComposing: false,
    key: 't',
    metaKey: false,
    preventDefault: jest.fn(),
    shiftKey: false,
    target,
  };
}

describe('handleAuxPanelNewTabShortcut', () => {
  const originalNavigator = globalThis.navigator;

  beforeEach(() => {
    jest.clearAllMocks();
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { platform: 'Linux x86_64' },
    });
  });

  afterAll(() => {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: originalNavigator,
    });
  });

  it('routes Ctrl+T through the auxiliary layout key', () => {
    const event = shortcutEvent();
    const createChatTab = jest.fn();

    expect(
      handleAuxPanelNewTabShortcut({
        event,
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        layoutKey: 'project-1/worktree-1#aux:window-1',
        createChatTab,
      }),
    ).toBe(true);

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(runNewTabShortcutMock).toHaveBeenCalledWith({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      layoutKey: 'project-1/worktree-1#aux:window-1',
      createChatTab,
      target: null,
    });
  });

  it('leaves terminal Ctrl+T to the shell', () => {
    const terminalTarget = Object.assign(new EventTarget(), {
      closest: (selector: string): object | null =>
        selector.includes('xterm') ? {} : null,
    });
    const event = shortcutEvent(terminalTarget);

    expect(
      handleAuxPanelNewTabShortcut({
        event,
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        layoutKey: 'project-1/worktree-1#aux:window-1',
        createChatTab: jest.fn(),
      }),
    ).toBe(false);

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(runNewTabShortcutMock).not.toHaveBeenCalled();
  });
});
