/**
 * @jest-environment jsdom
 */
// CAN-338 — a focused integrated terminal must own Ctrl-combos (readline
// shortcuts like Ctrl+R / Ctrl+A / Ctrl+W / Ctrl+L) instead of having them
// stolen by the global app-shortcut handler. Covers `isTerminalTarget` and
// the terminal Ctrl-combo guard in `handleGlobalShortcutKeyDown`.

import { isTerminalTarget } from '@/lib/keyboardShortcuts';
import {
  handleGlobalShortcutKeyDown,
  type GlobalShortcutKeyEvent,
} from '@/hooks/useGlobalShortcuts';

interface MockNavigationState {
  commandPaletteOpen: boolean;
  fileSearchPaletteOpen: boolean;
  prPickerOpen: boolean;
  settingsOpen: boolean;
  activePage: string;
  openSettings: jest.Mock;
  openCommandPalette: jest.Mock;
  closeCommandPalette: jest.Mock;
  openFileSearchPalette: jest.Mock;
  closeFileSearchPalette: jest.Mock;
  closePrPicker: jest.Mock;
  openAppAdvisorQuickPrompt: jest.Mock;
  navigate: jest.Mock;
}

let mockNavigationState: MockNavigationState;
let mockOpenAppAdvisorDialog: jest.Mock;

jest.mock('@/stores/navigationStore', () => ({
  useNavigationStore: { getState: (): unknown => mockNavigationState },
}));
jest.mock('@/stores/appAdvisorStore', () => ({
  useAppAdvisorStore: {
    getState: (): unknown => ({ openDialog: mockOpenAppAdvisorDialog }),
  },
}));
jest.mock('@/stores/chatStore', () => ({
  useChatStore: {
    getState: (): unknown => ({ selectedWorktree: null, worktreeChats: {} }),
  },
}));
jest.mock('@/lib/file-viewer/desktop-file-session-controller', () => ({
  desktopFileSessionController: {
    hasSession: (): boolean => false,
    saveTab: (): Promise<boolean> => Promise.resolve(false),
  },
}));
jest.mock('@/stores/projectsStore', () => ({
  useProjectsStore: { getState: (): unknown => ({}) },
}));
jest.mock('@/components/pr-picker/openCurrentPr', () => ({
  openCurrentWorktreePr: jest.fn(),
}));

function makeNavigationState(): MockNavigationState {
  return {
    commandPaletteOpen: false,
    fileSearchPaletteOpen: false,
    prPickerOpen: false,
    settingsOpen: false,
    activePage: 'main',
    openSettings: jest.fn(),
    openCommandPalette: jest.fn(),
    closeCommandPalette: jest.fn(),
    openFileSearchPalette: jest.fn(),
    closeFileSearchPalette: jest.fn(),
    closePrPicker: jest.fn(),
    openAppAdvisorQuickPrompt: jest.fn(),
    navigate: jest.fn(),
  };
}

function setPlatform(platform: string): void {
  Object.defineProperty(window.navigator, 'platform', {
    value: platform,
    configurable: true,
  });
}

function makeTerminalTargetElement(): HTMLElement {
  const host = document.createElement('div');
  host.className = 'canopy-terminal-host';
  const xterm = document.createElement('div');
  xterm.className = 'xterm';
  const helper = document.createElement('textarea');
  xterm.appendChild(helper);
  host.appendChild(xterm);
  document.body.appendChild(host);
  return helper;
}

function makePlainTargetElement(): HTMLElement {
  const div = document.createElement('div');
  document.body.appendChild(div);
  return div;
}

interface KeyEventInit {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  target?: EventTarget | null;
}

interface TestKeyEvent extends GlobalShortcutKeyEvent {
  preventDefault: jest.Mock;
}

function makeKeyEvent(init: KeyEventInit): TestKeyEvent {
  return {
    key: init.key,
    altKey: false,
    ctrlKey: init.ctrlKey ?? false,
    metaKey: init.metaKey ?? false,
    shiftKey: init.shiftKey ?? false,
    isComposing: false,
    preventDefault: jest.fn(),
    target: init.target ?? null,
  };
}

beforeEach(() => {
  document.body.innerHTML = '';
  mockNavigationState = makeNavigationState();
  mockOpenAppAdvisorDialog = jest.fn();
});

describe('isTerminalTarget', () => {
  it('matches elements inside the xterm root', () => {
    expect(isTerminalTarget(makeTerminalTargetElement())).toBe(true);
  });

  it('matches the canopy terminal host container itself', () => {
    const host = document.createElement('div');
    host.className = 'canopy-terminal-host';
    document.body.appendChild(host);
    expect(isTerminalTarget(host)).toBe(true);
  });

  it('rejects elements outside any terminal', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    expect(isTerminalTarget(input)).toBe(false);
  });

  it('rejects null targets', () => {
    expect(isTerminalTarget(null)).toBe(false);
  });
});

describe('handleGlobalShortcutKeyDown terminal Ctrl-combo guard (Windows/Linux)', () => {
  beforeEach(() => {
    setPlatform('Linux x86_64');
  });

  it.each(['r', 'a', 'e', 'w', 'u'])(
    'lets Ctrl+%s pass through to a focused terminal without preventDefault',
    (key) => {
      const event = makeKeyEvent({
        key,
        ctrlKey: true,
        target: makeTerminalTargetElement(),
      });
      handleGlobalShortcutKeyDown(event);
      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(mockNavigationState.navigate).not.toHaveBeenCalled();
    },
  );

  it('does not steal Ctrl+L (App Advisor) from a focused terminal', () => {
    const event = makeKeyEvent({
      key: 'l',
      ctrlKey: true,
      target: makeTerminalTargetElement(),
    });
    handleGlobalShortcutKeyDown(event);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(mockOpenAppAdvisorDialog).not.toHaveBeenCalled();
  });

  it('does not steal Ctrl+P (file search) from a focused terminal', () => {
    const event = makeKeyEvent({
      key: 'p',
      ctrlKey: true,
      target: makeTerminalTargetElement(),
    });
    handleGlobalShortcutKeyDown(event);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(mockNavigationState.openFileSearchPalette).not.toHaveBeenCalled();
  });

  it('does not steal Ctrl+, (settings) from a focused terminal', () => {
    const event = makeKeyEvent({
      key: ',',
      ctrlKey: true,
      target: makeTerminalTargetElement(),
    });
    handleGlobalShortcutKeyDown(event);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(mockNavigationState.openSettings).not.toHaveBeenCalled();
  });

  it('does not steal Ctrl+1..9 page navigation from a focused terminal', () => {
    const event = makeKeyEvent({
      key: '2',
      ctrlKey: true,
      target: makeTerminalTargetElement(),
    });
    handleGlobalShortcutKeyDown(event);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(mockNavigationState.navigate).not.toHaveBeenCalled();
  });

  it('keeps Ctrl+K (command palette) global even from a focused terminal', () => {
    const event = makeKeyEvent({
      key: 'k',
      ctrlKey: true,
      target: makeTerminalTargetElement(),
    });
    handleGlobalShortcutKeyDown(event);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(mockNavigationState.openCommandPalette).toHaveBeenCalled();
  });

  it('keeps Ctrl+Shift+K (shortcuts settings) global even from a focused terminal', () => {
    const event = makeKeyEvent({
      key: 'k',
      ctrlKey: true,
      shiftKey: true,
      target: makeTerminalTargetElement(),
    });
    handleGlobalShortcutKeyDown(event);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(mockNavigationState.openSettings).toHaveBeenCalledWith('shortcuts');
  });

  it('still handles Ctrl+L for non-terminal targets', () => {
    const event = makeKeyEvent({
      key: 'l',
      ctrlKey: true,
      target: makePlainTargetElement(),
    });
    handleGlobalShortcutKeyDown(event);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(mockOpenAppAdvisorDialog).toHaveBeenCalled();
  });

  it('still handles Ctrl+P for non-terminal targets', () => {
    const event = makeKeyEvent({
      key: 'p',
      ctrlKey: true,
      target: makePlainTargetElement(),
    });
    handleGlobalShortcutKeyDown(event);
    expect(event.preventDefault).toHaveBeenCalled();
  });
});

describe('handleGlobalShortcutKeyDown on macOS', () => {
  beforeEach(() => {
    setPlatform('MacIntel');
  });

  it('Cmd+L from a focused terminal still opens App Advisor (guard is Ctrl-only)', () => {
    const event = makeKeyEvent({
      key: 'l',
      metaKey: true,
      target: makeTerminalTargetElement(),
    });
    handleGlobalShortcutKeyDown(event);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(mockOpenAppAdvisorDialog).toHaveBeenCalled();
  });

  it('Ctrl+R from a focused terminal is never intercepted', () => {
    const event = makeKeyEvent({
      key: 'r',
      ctrlKey: true,
      target: makeTerminalTargetElement(),
    });
    handleGlobalShortcutKeyDown(event);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(mockNavigationState.navigate).not.toHaveBeenCalled();
  });

  it('Cmd+K still opens the command palette', () => {
    const event = makeKeyEvent({
      key: 'k',
      metaKey: true,
      target: makePlainTargetElement(),
    });
    handleGlobalShortcutKeyDown(event);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(mockNavigationState.openCommandPalette).toHaveBeenCalled();
  });
});
