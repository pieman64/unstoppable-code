/**
 * @jest-environment jsdom
 */
/**
 * Unit tests for the terminal-panel activation helper: making the worktree's
 * terminal panel visible for terminal-mode (`!`) sends (expand an existing
 * 'terminal' panel anywhere in the family, else dock a new one below the chat
 * group, else no-op).
 *
 * The layout store is mocked at the module boundary — the helper's contract is
 * which store operations it dispatches, not grid mechanics (covered by
 * panelLayoutStore.test.ts).
 */
import {
  ensureTerminalPanelVisible,
  findTerminalPanelSource,
  getTerminalPanelBinding,
  requestRevealedTerminalPanelSpawn,
  requestSelectedTerminalPanelFocus,
} from '../terminal-panel-activation';
import type { TerminalSpawnRequest } from '@/lib/terminalSpawnRequests';
import { usePanelWindowsStore } from '@/stores/panelWindowsStore';

const mockRequestTerminalFocus = jest.fn<
  void,
  [terminalId: string, ownerDocument?: Document]
>();

jest.mock('@/lib/terminal-focus-intent', () => ({
  requestTerminalFocus: (
    terminalId: string,
    ownerDocument?: Document,
  ): void => {
    mockRequestTerminalFocus(terminalId, ownerDocument);
  },
}));

const mockRequestTerminalSpawn = jest.fn<void, [TerminalSpawnRequest]>();

jest.mock('@/lib/terminalSpawnRequests', () => ({
  requestTerminalSpawn: (request: TerminalSpawnRequest): void => {
    mockRequestTerminalSpawn(request);
  },
}));

interface MockLayoutStore {
  layouts: Record<
    string,
    {
      activeGroupId: string | null;
      groups: Record<string, unknown>;
      maximizedGroupId?: string | null;
    }
  >;
  selectTab: jest.Mock;
  focusGroup: jest.Mock;
  splitGroup: jest.Mock;
  addTab: jest.Mock;
  ensureGroupExpanded: jest.Mock;
  maximizeGroup: jest.Mock;
}

const mockStore: MockLayoutStore = {
  layouts: {},
  selectTab: jest.fn(),
  focusGroup: jest.fn(),
  splitGroup: jest.fn(),
  addTab: jest.fn(),
  ensureGroupExpanded: jest.fn(),
  maximizeGroup: jest.fn(),
};

const mockFindPanelByInstanceKey = jest.fn();
const mockEnsureMinimalDestination = jest.fn();
const mockRemoveMinimalDestinationProbe = jest.fn();
let mockLayoutMode: 'minimal' | 'advanced' = 'advanced';
let mockCurrentStore: unknown = mockStore;
const mockGetState = jest.fn((): unknown => mockCurrentStore);

jest.mock('@/stores/panelLayoutStore', () => ({
  usePanelLayoutStore: { getState: (): unknown => mockGetState() },
  getPanelInstanceKey: (descriptor: { kind: string }): string =>
    descriptor.kind,
  getAuxPanelLayoutOwnerKey: (layoutKey: string): string | null => {
    const separator = layoutKey.indexOf('#aux:');
    return separator === -1 ? null : layoutKey.slice(0, separator);
  },
  findPanelByInstanceKey: (worktreeKey: string, instanceKey: string): unknown =>
    mockFindPanelByInstanceKey(worktreeKey, instanceKey),
}));

jest.mock('@/stores/workspaceLayoutModeStore', () => ({
  getWorkspaceLayoutMode: (): 'minimal' | 'advanced' => mockLayoutMode,
}));

jest.mock('../minimal-layout', () => ({
  ensureMinimalDestination: (...args: unknown[]): unknown =>
    mockEnsureMinimalDestination(...args),
  removeMinimalDestinationProbe: (...args: unknown[]): unknown =>
    mockRemoveMinimalDestinationProbe(...args),
}));

describe('ensureTerminalPanelVisible', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCurrentStore = mockStore;
    mockGetState.mockImplementation((): unknown => mockCurrentStore);
    mockStore.layouts = {};
    mockLayoutMode = 'advanced';
    mockEnsureMinimalDestination.mockReturnValue('group-terminal');
  });

  it('resolves a panel source from the exact layout and group in the family', () => {
    mockStore.layouts = {
      'p1/w1': {
        activeGroupId: 'group-main',
        groups: {
          'group-main': {
            tabs: [{ panelId: 'panel-main', kind: 'terminal' }],
          },
        },
      },
      'p1/w1#aux:terminal-window': {
        activeGroupId: 'group-aux',
        groups: {
          'group-aux': {
            tabs: [{ panelId: 'panel-current', kind: 'terminal' }],
          },
        },
      },
    };

    expect(findTerminalPanelSource('p1/w1', 'panel-current')).toEqual({
      layoutKey: 'p1/w1#aux:terminal-window',
      groupId: 'group-aux',
    });
  });

  it('requests caret focus when the user selects a bound terminal panel', () => {
    const ownerDocument = document.implementation.createHTMLDocument('aux');
    mockStore.layouts = {
      'p1/w1': {
        activeGroupId: 'group-terminal',
        groups: {
          'group-terminal': {
            tabs: [
              {
                panelId: 'panel-terminal-1',
                kind: 'terminal',
                instance: { terminalId: 'terminal-1' },
              },
            ],
          },
        },
      },
    };

    requestSelectedTerminalPanelFocus(
      'p1/w1',
      'group-terminal',
      'panel-terminal-1',
      ownerDocument,
    );

    expect(mockRequestTerminalFocus).toHaveBeenCalledWith(
      'terminal-1',
      ownerDocument,
    );
  });

  it('requests caret focus for an explicitly revealed bound terminal', () => {
    const ownerDocument = document.implementation.createHTMLDocument('aux');
    mockFindPanelByInstanceKey.mockReturnValue({
      layoutKey: 'p1/w1',
      groupId: 'group-terminal',
      panelId: 'panel-terminal-1',
    });

    ensureTerminalPanelVisible('p1/w1', undefined, {
      terminalId: 'terminal-1',
      focusOwnerDocument: ownerDocument,
    });

    expect(mockRequestTerminalFocus).toHaveBeenCalledWith(
      'terminal-1',
      ownerDocument,
    );
  });

  it('does not request caret focus for non-terminal or unbound panels', () => {
    const ownerDocument = document.implementation.createHTMLDocument('aux');
    mockStore.layouts = {
      'p1/w1': {
        activeGroupId: 'group-main',
        groups: {
          'group-main': {
            tabs: [
              { panelId: 'panel-chat', kind: 'chat' },
              { panelId: 'panel-terminal', kind: 'terminal' },
            ],
          },
        },
      },
    };

    requestSelectedTerminalPanelFocus(
      'p1/w1',
      'group-main',
      'panel-chat',
      ownerDocument,
    );
    requestSelectedTerminalPanelFocus(
      'p1/w1',
      'group-main',
      'panel-terminal',
      ownerDocument,
    );

    expect(mockRequestTerminalFocus).not.toHaveBeenCalled();
  });

  it('expands, selects, and focuses an already-open terminal panel (aux layouts included)', () => {
    mockFindPanelByInstanceKey.mockReturnValue({
      layoutKey: 'p1/w1#aux:aux-1',
      groupId: 'group-terminal',
      panelId: 'panel-terminal',
    });

    ensureTerminalPanelVisible('p1/w1');

    expect(mockFindPanelByInstanceKey).toHaveBeenCalledWith(
      'p1/w1',
      'terminal:',
    );
    expect(mockStore.ensureGroupExpanded).toHaveBeenCalledWith(
      'p1/w1#aux:aux-1',
      'group-terminal',
    );
    expect(mockStore.selectTab).toHaveBeenCalledWith(
      'p1/w1#aux:aux-1',
      'group-terminal',
      'panel-terminal',
    );
    expect(mockStore.focusGroup).toHaveBeenCalledWith(
      'p1/w1#aux:aux-1',
      'group-terminal',
    );
    expect(mockStore.splitGroup).not.toHaveBeenCalled();
    // Reveal-path guard: the collapsed group is expanded before it is
    // selected, so a collapsed icon-bar never flashes a hidden active tab.
    expect(
      mockStore.ensureGroupExpanded.mock.invocationCallOrder[0],
    ).toBeLessThan(mockStore.selectTab.mock.invocationCallOrder[0]);
  });

  it('prefers the active terminal tab over the first terminal in layout order', () => {
    mockFindPanelByInstanceKey.mockReturnValue(null);
    mockStore.layouts = {
      'p1/w1': {
        activeGroupId: 'group-active',
        groups: {
          'group-first': {
            activePanelId: 'panel-first',
            tabs: [{ panelId: 'panel-first', kind: 'terminal' }],
          },
          'group-active': {
            activePanelId: 'panel-active',
            tabs: [
              { panelId: 'panel-other', kind: 'chat' },
              { panelId: 'panel-active', kind: 'terminal' },
            ],
          },
        },
      },
    };

    ensureTerminalPanelVisible('p1/w1');

    expect(mockStore.selectTab).toHaveBeenCalledWith(
      'p1/w1',
      'group-active',
      'panel-active',
    );
    expect(mockStore.focusGroup).toHaveBeenCalledWith('p1/w1', 'group-active');
  });

  it('restores a different maximized group before revealing an existing terminal panel', () => {
    mockStore.layouts = {
      'p1/w1': {
        activeGroupId: 'group-chat',
        groups: { 'group-chat': {}, 'group-terminal': {} },
        maximizedGroupId: 'group-chat',
      },
    };
    mockFindPanelByInstanceKey.mockReturnValue({
      layoutKey: 'p1/w1',
      groupId: 'group-terminal',
      panelId: 'panel-terminal',
    });

    ensureTerminalPanelVisible('p1/w1');

    expect(mockStore.maximizeGroup).toHaveBeenCalledWith(
      'p1/w1',
      'group-chat',
      false,
    );
    expect(mockStore.maximizeGroup.mock.invocationCallOrder[0]).toBeLessThan(
      mockStore.ensureGroupExpanded.mock.invocationCallOrder[0],
    );
    expect(mockStore.maximizeGroup.mock.invocationCallOrder[0]).toBeLessThan(
      mockStore.selectTab.mock.invocationCallOrder[0],
    );
  });

  it('keeps an already-maximized terminal group maximized while revealing it', () => {
    mockStore.layouts = {
      'p1/w1': {
        activeGroupId: 'group-terminal',
        groups: { 'group-chat': {}, 'group-terminal': {} },
        maximizedGroupId: 'group-terminal',
      },
    };
    mockFindPanelByInstanceKey.mockReturnValue({
      layoutKey: 'p1/w1',
      groupId: 'group-terminal',
      panelId: 'panel-terminal',
    });

    ensureTerminalPanelVisible('p1/w1');

    expect(mockStore.maximizeGroup).not.toHaveBeenCalled();
    expect(mockStore.ensureGroupExpanded).toHaveBeenCalledWith(
      'p1/w1',
      'group-terminal',
    );
  });

  describe('auxiliary window focus', () => {
    const disposers: Array<() => void> = [];

    afterEach(() => {
      for (const dispose of disposers.splice(0)) dispose();
      usePanelWindowsStore.setState({ auxWindows: {} });
    });

    /** Registers an open aux window record backed by a real jsdom window. */
    function registerAuxWindow(): jest.SpyInstance<void, []> {
      const frame = document.createElement('iframe');
      document.body.appendChild(frame);
      disposers.push((): void => {
        frame.remove();
      });
      const childWindow = frame.contentWindow;
      if (childWindow === null) {
        throw new Error('Expected the test iframe to expose a window');
      }
      const focus = jest
        .spyOn(childWindow, 'focus')
        .mockImplementation((): void => undefined);
      usePanelWindowsStore.setState({
        auxWindows: {
          'aux-1': {
            auxWindowId: 'aux-1',
            worktreeKey: 'p1/w1',
            layoutKey: 'p1/w1#aux:aux-1',
            sourceGroupId: 'group-chat',
            childWindow,
            status: 'open',
            focusOnOpen: false,
          },
        },
      });
      return focus;
    }

    it('focuses the auxiliary window hosting an explicitly revealed terminal', () => {
      const focus = registerAuxWindow();
      mockFindPanelByInstanceKey.mockReturnValue({
        layoutKey: 'p1/w1#aux:aux-1',
        groupId: 'group-terminal',
        panelId: 'panel-terminal',
      });

      ensureTerminalPanelVisible('p1/w1');

      expect(focus).toHaveBeenCalledTimes(1);
      expect(mockStore.selectTab).toHaveBeenCalledWith(
        'p1/w1#aux:aux-1',
        'group-terminal',
        'panel-terminal',
      );
    });

    it('does not focus the auxiliary window for a passive hydration reveal', () => {
      const focus = registerAuxWindow();
      mockFindPanelByInstanceKey.mockReturnValue({
        layoutKey: 'p1/w1#aux:aux-1',
        groupId: 'group-terminal',
        panelId: 'panel-terminal-term-1',
      });

      ensureTerminalPanelVisible('p1/w1', undefined, {
        terminalId: 'term-1',
        focus: false,
      });

      expect(focus).not.toHaveBeenCalled();
      expect(mockStore.selectTab).not.toHaveBeenCalled();
    });

    it('does not focus any window for a terminal revealed in the main layout', () => {
      const focus = registerAuxWindow();
      mockFindPanelByInstanceKey.mockReturnValue({
        layoutKey: 'p1/w1',
        groupId: 'group-terminal',
        panelId: 'panel-terminal',
      });

      ensureTerminalPanelVisible('p1/w1');

      expect(focus).not.toHaveBeenCalled();
      expect(mockStore.focusGroup).toHaveBeenCalledWith(
        'p1/w1',
        'group-terminal',
      );
    });
  });

  it('docks a new terminal below the chat group when none is open', () => {
    mockFindPanelByInstanceKey.mockReturnValue(null);
    mockStore.layouts = {
      'p1/w1': { activeGroupId: 'group-chat', groups: { 'group-chat': {} } },
    };

    ensureTerminalPanelVisible('p1/w1');

    expect(mockStore.splitGroup).toHaveBeenCalledWith(
      'p1/w1',
      'group-chat',
      'down',
      { kind: 'terminal' },
    );
  });

  it('adds a new Minimal terminal directly to the canonical group without attempting a split', () => {
    mockLayoutMode = 'minimal';
    mockFindPanelByInstanceKey.mockReturnValue(null);
    mockStore.addTab.mockReturnValue('panel-terminal-created');
    mockStore.layouts = {
      'p1/w1': { activeGroupId: 'group-chat', groups: { 'group-chat': {} } },
    };

    expect(
      ensureTerminalPanelVisible('p1/w1', undefined, {
        terminalId: 'terminal-created',
      }),
    ).toEqual({
      layoutKey: 'p1/w1',
      groupId: 'group-terminal',
      panelId: 'panel-terminal-created',
    });

    expect(mockEnsureMinimalDestination).toHaveBeenCalledWith(
      'p1/w1',
      'terminal',
    );
    expect(mockStore.splitGroup).not.toHaveBeenCalled();
    expect(mockStore.addTab).toHaveBeenCalledWith(
      'p1/w1',
      'group-terminal',
      'terminal',
      expect.objectContaining({
        panelId: 'panel-terminal-terminal-created',
        instance: { terminalId: 'terminal-created' },
        activate: true,
      }),
    );
    expect(mockRemoveMinimalDestinationProbe).toHaveBeenCalledWith(
      'p1/w1',
      'bottom',
    );
  });

  it('routes an externally created Minimal terminal to Bottom Drawer even when the source group has a terminal', () => {
    mockLayoutMode = 'minimal';
    mockFindPanelByInstanceKey.mockReturnValue(null);
    mockStore.addTab.mockReturnValue('panel-terminal-external');
    mockStore.layouts = {
      'p1/w1': {
        activeGroupId: 'group-side',
        groups: {
          'group-side': {
            activePanelId: 'panel-terminal-existing',
            tabs: [{ kind: 'terminal', panelId: 'panel-terminal-existing' }],
          },
          'group-terminal': { activePanelId: null, tabs: [] },
        },
      },
    };

    ensureTerminalPanelVisible(
      'p1/w1',
      { layoutKey: 'p1/w1', groupId: 'group-side' },
      { terminalId: 'terminal-external' },
    );

    expect(mockEnsureMinimalDestination).toHaveBeenCalledWith(
      'p1/w1',
      'terminal',
    );
    expect(mockStore.addTab).toHaveBeenCalledWith(
      'p1/w1',
      'group-terminal',
      'terminal',
      expect.objectContaining({
        instance: { terminalId: 'terminal-external' },
      }),
    );
  });

  it('reasserts Bottom Drawer for a Minimal toggle instead of revealing a terminal in Side Panel', () => {
    mockLayoutMode = 'minimal';
    mockFindPanelByInstanceKey.mockReturnValue(null);
    mockStore.addTab.mockReturnValue('panel-terminal-bottom');
    mockStore.layouts = {
      'p1/w1': {
        activeGroupId: 'group-side',
        groups: {
          'group-side': {
            activePanelId: 'panel-terminal-side',
            tabs: [{ kind: 'terminal', panelId: 'panel-terminal-side' }],
          },
        },
      },
    };

    ensureTerminalPanelVisible('p1/w1');

    expect(mockEnsureMinimalDestination).toHaveBeenCalledWith(
      'p1/w1',
      'terminal',
    );
    expect(mockStore.addTab).toHaveBeenCalledWith(
      'p1/w1',
      'group-terminal',
      'terminal',
      expect.objectContaining({ activate: true }),
    );
    expect(mockStore.selectTab).not.toHaveBeenCalledWith(
      'p1/w1',
      'group-side',
      'panel-terminal-side',
    );
  });

  it('returns the created panel location from the post-split store snapshot', () => {
    mockFindPanelByInstanceKey.mockReturnValue(null);
    mockStore.layouts = {
      'p1/w1': { activeGroupId: 'group-chat', groups: { 'group-chat': {} } },
    };
    mockStore.splitGroup.mockImplementation(() => {
      mockCurrentStore = {
        ...mockStore,
        layouts: {
          'p1/w1': {
            activeGroupId: 'group-terminal',
            groups: {
              'group-chat': {},
              'group-terminal': { activePanelId: 'panel-terminal' },
            },
          },
        },
      };
      return 'group-terminal';
    });

    expect(ensureTerminalPanelVisible('p1/w1')).toEqual({
      layoutKey: 'p1/w1',
      groupId: 'group-terminal',
      panelId: 'panel-terminal',
    });
  });

  it('docks a new terminal in the initiating aux layout when provided', () => {
    mockFindPanelByInstanceKey.mockReturnValue(null);
    mockStore.layouts = {
      'p1/w1': { activeGroupId: 'group-main', groups: { 'group-main': {} } },
      'p1/w1#aux:aux-1': {
        activeGroupId: 'group-aux-chat',
        groups: { 'group-aux-chat': {} },
      },
    };

    ensureTerminalPanelVisible('p1/w1', {
      layoutKey: 'p1/w1#aux:aux-1',
      groupId: 'group-aux-chat',
    });

    expect(mockStore.splitGroup).toHaveBeenCalledWith(
      'p1/w1#aux:aux-1',
      'group-aux-chat',
      'down',
      { kind: 'terminal' },
    );
  });

  it('keeps an existing terminal layout and group paired when appending a session', () => {
    mockFindPanelByInstanceKey.mockReturnValue(null);
    mockStore.addTab.mockReturnValue('panel-terminal-2');
    mockStore.layouts = {
      'p1/w1': {
        activeGroupId: 'group-main',
        groups: { 'group-main': {} },
      },
      'p1/w1#aux:aux-1': {
        activeGroupId: 'group-aux-terminal',
        groups: {
          'group-aux-terminal': {
            tabs: [{ kind: 'terminal', panelId: 'panel-terminal-1' }],
          },
        },
      },
    };

    const location = ensureTerminalPanelVisible('p1/w1', undefined, {
      terminalId: 'terminal-2',
      focus: false,
    });

    expect(mockStore.addTab).toHaveBeenCalledWith(
      'p1/w1#aux:aux-1',
      'group-aux-terminal',
      'terminal',
      expect.objectContaining({
        panelId: 'panel-terminal-terminal-2',
        instance: { terminalId: 'terminal-2' },
        activate: false,
      }),
    );
    expect(location).toEqual({
      layoutKey: 'p1/w1#aux:aux-1',
      groupId: 'group-aux-terminal',
      panelId: 'panel-terminal-2',
    });
  });

  it('keeps shortcut activation in its supplied layout instead of revealing another window', () => {
    mockFindPanelByInstanceKey.mockReturnValue(null);
    mockStore.splitGroup.mockReturnValue('group-main-terminal');
    mockStore.layouts = {
      'p1/w1': {
        activeGroupId: 'group-main-chat',
        groups: { 'group-main-chat': {} },
      },
      'p1/w1#aux:aux-1': {
        activeGroupId: 'group-aux-terminal',
        groups: {
          'group-aux-terminal': {
            tabs: [{ kind: 'terminal', panelId: 'panel-aux-terminal' }],
          },
        },
      },
    };

    ensureTerminalPanelVisible('p1/w1', {
      layoutKey: 'p1/w1',
      groupId: 'group-main-chat',
    });

    expect(mockStore.splitGroup).toHaveBeenCalledWith(
      'p1/w1',
      'group-main-chat',
      'down',
      { kind: 'terminal' },
    );
    expect(mockStore.selectTab).not.toHaveBeenCalledWith(
      'p1/w1#aux:aux-1',
      'group-aux-terminal',
      'panel-aux-terminal',
    );
  });

  it('falls back to the active group when the default chat group is gone', () => {
    mockFindPanelByInstanceKey.mockReturnValue(null);
    mockStore.layouts = {
      'p1/w1': { activeGroupId: 'group-other', groups: { 'group-other': {} } },
    };

    ensureTerminalPanelVisible('p1/w1');

    expect(mockStore.splitGroup).toHaveBeenCalledWith(
      'p1/w1',
      'group-other',
      'down',
      { kind: 'terminal' },
    );
  });

  it('no-ops for worktrees whose layout has not been ensured', () => {
    mockFindPanelByInstanceKey.mockReturnValue(null);

    ensureTerminalPanelVisible('p1/w-unknown');

    expect(mockStore.splitGroup).not.toHaveBeenCalled();
    expect(mockStore.selectTab).not.toHaveBeenCalled();
    expect(mockStore.focusGroup).not.toHaveBeenCalled();
  });
});

describe('getTerminalPanelBinding', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCurrentStore = mockStore;
    mockLayoutMode = 'advanced';
    mockStore.layouts = {};
  });

  it('returns the bound terminal id for a bound terminal panel', () => {
    mockStore.layouts = {
      'p1/w1': {
        activeGroupId: 'group-terminal',
        groups: {
          'group-terminal': {
            activePanelId: 'panel-terminal',
            tabs: [
              {
                kind: 'terminal',
                panelId: 'panel-terminal',
                instance: { terminalId: 'term-1' },
              },
            ],
          },
        },
      },
    };

    expect(getTerminalPanelBinding('p1/w1', 'panel-terminal')).toBe('term-1');
  });

  it('returns undefined for an unbound terminal placeholder', () => {
    mockStore.layouts = {
      'p1/w1': {
        activeGroupId: 'group-terminal',
        groups: {
          'group-terminal': {
            activePanelId: 'panel-terminal',
            tabs: [{ kind: 'terminal', panelId: 'panel-terminal' }],
          },
        },
      },
    };

    expect(getTerminalPanelBinding('p1/w1', 'panel-terminal')).toBeUndefined();
  });

  it('returns undefined for a non-terminal panel and for an unknown panel', () => {
    mockStore.layouts = {
      'p1/w1': {
        activeGroupId: 'group-chat',
        groups: {
          'group-chat': {
            activePanelId: 'panel-chat',
            tabs: [
              {
                kind: 'chat',
                panelId: 'panel-chat',
                instance: { terminalId: 'term-bogus' },
              },
            ],
          },
        },
      },
    };

    expect(getTerminalPanelBinding('p1/w1', 'panel-chat')).toBeUndefined();
    expect(getTerminalPanelBinding('p1/w1', 'panel-missing')).toBeUndefined();
  });

  it('resolves a panel hosted in an aux layout of the same family', () => {
    mockStore.layouts = {
      'p1/w1#aux:aux-1': {
        activeGroupId: 'group-aux-terminal',
        groups: {
          'group-aux-terminal': {
            activePanelId: 'panel-aux-terminal',
            tabs: [
              {
                kind: 'terminal',
                panelId: 'panel-aux-terminal',
                instance: { terminalId: 'term-aux' },
              },
            ],
          },
        },
      },
    };

    expect(getTerminalPanelBinding('p1/w1', 'panel-aux-terminal')).toBe(
      'term-aux',
    );
  });
});

describe('requestRevealedTerminalPanelSpawn', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCurrentStore = mockStore;
    mockLayoutMode = 'advanced';
    mockStore.layouts = {};
  });

  function seedGroup(tabs: unknown[], activePanelId?: string): void {
    mockStore.layouts = {
      'p1/w1': {
        activeGroupId: 'group-terminal',
        groups: {
          'group-terminal': {
            ...(activePanelId === undefined ? {} : { activePanelId }),
            tabs,
          },
        },
      },
    };
  }

  it('requests an ensure spawn for an unbound terminal tab', () => {
    seedGroup(
      [{ kind: 'terminal', panelId: 'panel-terminal' }],
      'panel-terminal',
    );

    requestRevealedTerminalPanelSpawn(
      'p1',
      'w1',
      'p1/w1',
      'group-terminal',
      'panel-terminal',
    );

    expect(mockRequestTerminalSpawn).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'p1',
        worktreeId: 'w1',
        layoutKey: 'p1/w1',
        panelId: 'panel-terminal',
        mode: 'ensure',
      }),
    );
    // Stamped so a reveal whose panel never activates expires instead of
    // firing on a later passive activation.
    expect(typeof mockRequestTerminalSpawn.mock.calls[0]?.[0].requestedAt).toBe(
      'number',
    );
  });

  // The request must name the panel the gesture resolved, not just the
  // layout: a bound sibling terminal surface in the same layout is also an
  // active claimant, and it would satisfy an untargeted request by
  // re-focusing itself, leaving the revealed tab unbound.
  it('targets the resolved panel even when another terminal tab is bound', () => {
    seedGroup(
      [
        {
          kind: 'terminal',
          panelId: 'panel-bound',
          instance: { terminalId: 't-1' },
        },
        { kind: 'terminal', panelId: 'panel-terminal' },
      ],
      'panel-bound',
    );

    requestRevealedTerminalPanelSpawn(
      'p1',
      'w1',
      'p1/w1',
      'group-terminal',
      'panel-terminal',
    );

    expect(mockRequestTerminalSpawn).toHaveBeenCalledWith(
      expect.objectContaining({ panelId: 'panel-terminal', mode: 'ensure' }),
    );
  });

  it('falls back to the group active panel when no panel id is given', () => {
    seedGroup(
      [
        { kind: 'chat', panelId: 'panel-chat' },
        { kind: 'terminal', panelId: 'panel-terminal' },
      ],
      'panel-terminal',
    );

    requestRevealedTerminalPanelSpawn('p1', 'w1', 'p1/w1', 'group-terminal');

    expect(mockRequestTerminalSpawn).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'p1',
        worktreeId: 'w1',
        layoutKey: 'p1/w1',
        panelId: 'panel-terminal',
        mode: 'ensure',
      }),
    );
    // Stamped so a reveal whose panel never activates expires instead of
    // firing on a later passive activation.
    expect(typeof mockRequestTerminalSpawn.mock.calls[0]?.[0].requestedAt).toBe(
      'number',
    );
  });

  it('requests nothing when the revealed active panel is not a terminal', () => {
    seedGroup(
      [
        { kind: 'chat', panelId: 'panel-chat' },
        { kind: 'terminal', panelId: 'panel-terminal' },
      ],
      'panel-chat',
    );

    requestRevealedTerminalPanelSpawn('p1', 'w1', 'p1/w1', 'group-terminal');

    expect(mockRequestTerminalSpawn).not.toHaveBeenCalled();
  });

  it('requests nothing for an already-bound terminal tab', () => {
    seedGroup(
      [
        {
          kind: 'terminal',
          panelId: 'panel-terminal',
          instance: { terminalId: 'term-1' },
        },
      ],
      'panel-terminal',
    );

    requestRevealedTerminalPanelSpawn(
      'p1',
      'w1',
      'p1/w1',
      'group-terminal',
      'panel-terminal',
    );

    expect(mockRequestTerminalSpawn).not.toHaveBeenCalled();
  });

  it('requests nothing for an unknown layout, group, or panel', () => {
    seedGroup(
      [{ kind: 'terminal', panelId: 'panel-terminal' }],
      'panel-terminal',
    );

    requestRevealedTerminalPanelSpawn(
      'p1',
      'w1',
      'p1/w-unknown',
      'group-terminal',
      'panel-terminal',
    );
    requestRevealedTerminalPanelSpawn(
      'p1',
      'w1',
      'p1/w1',
      'group-unknown',
      'panel-terminal',
    );
    requestRevealedTerminalPanelSpawn(
      'p1',
      'w1',
      'p1/w1',
      'group-terminal',
      'panel-missing',
    );

    expect(mockRequestTerminalSpawn).not.toHaveBeenCalled();
  });

  it('requests nothing for a group with no active panel and no panel id', () => {
    seedGroup([{ kind: 'terminal', panelId: 'panel-terminal' }]);

    requestRevealedTerminalPanelSpawn('p1', 'w1', 'p1/w1', 'group-terminal');

    expect(mockRequestTerminalSpawn).not.toHaveBeenCalled();
  });
});
