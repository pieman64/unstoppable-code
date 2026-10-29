/** @jest-environment jsdom */
import type { TerminalPanelHost } from '../terminal-panel-host';
import { act } from 'react';
import type * as ReactNamespace from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type * as TerminalStoreModule from '@canopy/app-state/terminal';
import type { TerminalSession } from '@canopy/protocol/terminal';
import {
  ensureTerminalWorktreeHydrated,
  useTerminalStore,
} from '@canopy/app-state/terminal';
import { requestTerminalSpawn } from '../terminal-spawn-requests';
import {
  clearTerminalFocusRequest,
  requestTerminalFocus,
  consumeTerminalFocusRequest,
  __resetTerminalFocusIntentForTests,
} from '../terminal-focus-intent';
import { PanelPlacementContext } from '../../panels/panel-contexts';
import {
  bindTerminalClient,
  ensureTerminalExitSubscription,
} from '@canopy/app-state/terminal';
import { createFakeTerminalClient } from '../../../../../app-state/src/terminal/__tests__/fake-terminal-client';
import { TerminalPanelSurface } from '../TerminalPanelSurface';

const bindTerminal = jest.fn<boolean, [string, string, TerminalSession]>(
  () => true,
);
const getTerminalPanelBinding = jest.fn<string | undefined, [string, string]>(
  () => undefined,
);
const host: TerminalPanelHost = {
  getBinding: getTerminalPanelBinding,
  bindTerminal,
};
const disposeInstance = jest.fn();
// The cached xterm entry a restart reads its size from (see restartSize).
const peekInstance = jest.fn<unknown, [string]>(() => undefined);
const measureTerminalDimensions = jest.fn<
  { cols: number; rows: number } | null,
  [HTMLElement]
>(() => ({ cols: 80, rows: 24 }));
interface MockTerminalPaneProps {
  focused: boolean;
  restoreOnMount: boolean;
  readOnlyMessage: string | null;
  onRestart?: () => void;
  onRestoreFailed?: (error: unknown) => void;
  terminalId: string;
  findTitle?: string;
}
const mockTerminalPane = jest.fn((props: MockTerminalPaneProps) => {
  const react = jest.requireActual<typeof ReactNamespace>('react');
  // Mirrors the real pane's unmount contract: `TerminalPane` drops any
  // pending gesture for its terminal when it unmounts. That is load-bearing
  // for restart, where the surface remounts the pane under the SAME terminal
  // id — a request recorded before the remount is deleted here.
  react.useEffect(
    () => (): void => {
      clearTerminalFocusRequest(props.terminalId);
    },
    [props.terminalId],
  );
  return react.createElement(
    'div',
    { 'data-testid': 'mock-terminal-pane' },
    props.readOnlyMessage,
    props.onRestart
      ? react.createElement(
          'button',
          { type: 'button', onClick: props.onRestart },
          'Restart terminal',
        )
      : null,
  );
});

jest.mock('@canopy/app-state/terminal', () => {
  const actual = jest.requireActual<typeof TerminalStoreModule>(
    '@canopy/app-state/terminal',
  );
  return {
    ...actual,
    ensureTerminalWorktreeHydrated: jest.fn(() => Promise.resolve()),
    ensureTerminalExitSubscription: jest.fn(),
  };
});
jest.mock('../terminal-instances', () => ({
  disposeInstance: (...args: unknown[]): unknown => disposeInstance(...args),
  peekInstance: (id: string): unknown => peekInstance(id),
}));
jest.mock('../terminal-dimensions', () => ({
  computeColsRowsForPixels: jest.fn(() => ({ cols: 80, rows: 24 })),
  measureTerminalDimensions: (area: HTMLElement): unknown =>
    measureTerminalDimensions(area),
}));
jest.mock('../TerminalPane', () => {
  return {
    TerminalPane: (props: MockTerminalPaneProps): unknown =>
      mockTerminalPane(props),
  };
});

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

const PROJECT_ID = 'project-1';
const WORKTREE_ID = 'worktree-1';

function shellSession(id = 'terminal-1'): TerminalSession {
  return {
    id,
    projectId: PROJECT_ID,
    worktreeId: WORKTREE_ID,
    shell: '/bin/zsh',
    shellBasename: 'zsh',
    cwd: '/tmp',
    createdAt: 1,
  };
}

describe('TerminalPanelSurface', () => {
  let container: HTMLDivElement;
  let root: Root;
  let fake: ReturnType<typeof createFakeTerminalClient>;
  let disposeClient: () => void;
  let spawn: ReturnType<
    typeof createFakeTerminalClient
  >['calls']['commands']['terminal.spawn'];
  let restore: ReturnType<
    typeof createFakeTerminalClient
  >['calls']['commands']['terminal.restore'];

  beforeEach(() => {
    bindTerminal.mockReset();
    bindTerminal.mockReturnValue(true);
    getTerminalPanelBinding.mockReset();
    getTerminalPanelBinding.mockReturnValue(undefined);
    disposeInstance.mockClear();
    peekInstance.mockReset();
    peekInstance.mockReturnValue(undefined);
    measureTerminalDimensions.mockReset();
    measureTerminalDimensions.mockReturnValue({ cols: 80, rows: 24 });
    mockTerminalPane.mockClear();
    jest.mocked(ensureTerminalExitSubscription).mockClear();
    // Reset the implementation, not just the calls: tests that stage a
    // slow/failing hydration would otherwise leak it into their successors.
    jest.mocked(ensureTerminalWorktreeHydrated).mockReset();
    jest.mocked(ensureTerminalWorktreeHydrated).mockResolvedValue(undefined);
    __resetTerminalFocusIntentForTests();
    fake = createFakeTerminalClient();
    disposeClient = bindTerminalClient(fake.client);
    spawn = fake.calls.commands['terminal.spawn'];
    restore = fake.calls.commands['terminal.restore'];
    spawn.mockResolvedValue(shellSession());
    restore.mockResolvedValue(shellSession());
    useTerminalStore.setState({
      worktrees: {},
      terminalCustomNames: {},
      groupCustomNames: {},
    });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    disposeClient();
  });

  it('rehydrates a mounted persisted panel through the replacement host', async () => {
    const actual = jest.requireActual<typeof TerminalStoreModule>(
      '@canopy/app-state/terminal',
    );
    jest
      .mocked(ensureTerminalWorktreeHydrated)
      .mockImplementation(actual.ensureTerminalWorktreeHydrated);
    const firstSession = shellSession('persisted-terminal');
    const initialState = {
      drawerCollapsed: false,
      groups: [],
      activeGroupId: null,
      nextGroupOrdinal: 1,
      groupOrdinals: {},
      terminalCustomNames: {},
      groupCustomNames: {},
      terminals: [
        {
          session: firstSession,
          scrollbackLines: [],
          exitCode: null,
          signal: null,
        },
      ],
      liveTerminalIds: [firstSession.id],
    };
    fake.calls.queries['terminal.worktreeState.get'].mockResolvedValue(
      initialState,
    );
    await act(async () => {
      await Promise.resolve();
      root.render(
        <TerminalPanelSurface
          host={host}
          appName="Canopy"
          projectId={PROJECT_ID}
          worktreeId={WORKTREE_ID}
          panelId="panel-terminal"
          terminalId={firstSession.id}
        />,
      );
    });
    expect(
      useTerminalStore.getState().worktrees['project-1/worktree-1'].sessions[
        firstSession.id
      ].title,
    ).toBeUndefined();
    const replacement = createFakeTerminalClient();
    replacement.calls.queries['terminal.worktreeState.get'].mockResolvedValue({
      ...initialState,
      terminals: [
        {
          ...initialState.terminals[0],
          session: { ...firstSession, title: 'Current host' },
        },
      ],
    });
    await act(async () => {
      await Promise.resolve();
      disposeClient = bindTerminalClient(replacement.client);
    });
    expect(
      useTerminalStore.getState().worktrees['project-1/worktree-1']?.sessions[
        firstSession.id
      ]?.title,
    ).toBe('Current host');
    expect(replacement.calls.commands['terminal.spawn']).not.toHaveBeenCalled();
  });

  it.each(['replace', 'dispose', 'same-client'] as const)(
    'discards a delayed spawn after host %s and cleans up through its originating client',
    async (change) => {
      let resolveSpawn: ((session: TerminalSession) => void) | undefined;
      spawn.mockReturnValue(
        new Promise<TerminalSession>((resolve) => {
          resolveSpawn = resolve;
        }),
      );
      await act(async () => {
        root.render(
          <TerminalPanelSurface
            host={host}
            appName="Canopy"
            projectId={PROJECT_ID}
            worktreeId={WORKTREE_ID}
            panelId="panel-terminal"
          />,
        );
        await Promise.resolve();
      });
      await act(async () => {
        container
          .querySelector<HTMLButtonElement>(
            '[data-testid="terminal-start-button"]',
          )
          ?.click();
        await Promise.resolve();
      });
      expect(spawn).toHaveBeenCalledTimes(1);
      const replacement = createFakeTerminalClient();
      await act(async () => {
        if (change === 'dispose') disposeClient();
        else
          disposeClient = bindTerminalClient(
            change === 'same-client' ? fake.client : replacement.client,
          );
        resolveSpawn?.(shellSession('late-spawn'));
        await Promise.resolve();
      });
      expect(useTerminalStore.getState().worktrees).toEqual({});
      expect(bindTerminal).not.toHaveBeenCalled();
      expect(fake.calls.commands['terminal.kill']).toHaveBeenCalledWith({
        terminalId: 'late-spawn',
      });
      expect(
        replacement.calls.commands['terminal.kill'],
      ).not.toHaveBeenCalled();
      expect(consumeTerminalFocusRequest('late-spawn', document)).toBe(false);
    },
  );

  it.each(['replace', 'dispose', 'same-client'] as const)(
    'discards a delayed restart after host %s without replacing cached output or publishing a live session',
    async (change) => {
      useTerminalStore.getState().addGroupWithTerminal(shellSession());
      useTerminalStore.getState().applyExit({
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
        terminalId: 'terminal-1',
        exitCode: 0,
        signal: null,
      });
      let resolveRestore: ((session: TerminalSession) => void) | undefined;
      restore.mockReturnValue(
        new Promise<TerminalSession>((resolve) => {
          resolveRestore = resolve;
        }),
      );
      await act(async () => {
        root.render(
          <TerminalPanelSurface
            host={host}
            appName="Canopy"
            projectId={PROJECT_ID}
            worktreeId={WORKTREE_ID}
            panelId="panel-terminal"
            terminalId="terminal-1"
          />,
        );
        await Promise.resolve();
      });
      await act(async () => {
        container.querySelector<HTMLButtonElement>('button')?.click();
        await Promise.resolve();
      });
      expect(restore).toHaveBeenCalledTimes(1);
      const replacement = createFakeTerminalClient();
      let replacementState = useTerminalStore.getState().worktrees;
      await act(async () => {
        if (change === 'dispose') disposeClient();
        else {
          disposeClient = bindTerminalClient(
            change === 'same-client' ? fake.client : replacement.client,
          );
          useTerminalStore.getState().addGroupWithTerminal(shellSession());
          useTerminalStore.getState().applyExit({
            projectId: PROJECT_ID,
            worktreeId: WORKTREE_ID,
            terminalId: 'terminal-1',
            exitCode: 7,
            signal: null,
          });
        }
        replacementState = useTerminalStore.getState().worktrees;
        resolveRestore?.(shellSession());
        await Promise.resolve();
      });
      expect(useTerminalStore.getState().worktrees).toBe(replacementState);
      expect(disposeInstance).not.toHaveBeenCalled();
      expect(bindTerminal).not.toHaveBeenCalled();
      expect(fake.calls.commands['terminal.kill']).toHaveBeenCalledWith({
        terminalId: 'terminal-1',
      });
      expect(
        replacement.calls.commands['terminal.kill'],
      ).not.toHaveBeenCalled();
      expect(consumeTerminalFocusRequest('terminal-1', document)).toBe(false);
    },
  );

  it.each([
    { bound: false, replacementGesture: false },
    { bound: true, replacementGesture: false },
    { bound: false, replacementGesture: true },
    { bound: true, replacementGesture: true },
  ])(
    'preserves focus ownership after synchronous host replacement: %j',
    async ({ bound, replacementGesture }) => {
      const replacement = createFakeTerminalClient();
      const replacementDocument = document.implementation.createHTMLDocument();
      let replacementState = useTerminalStore.getState().worktrees;
      bindTerminal.mockImplementationOnce(() => {
        disposeClient = bindTerminalClient(replacement.client);
        useTerminalStore.getState().addGroupWithTerminal(shellSession());
        replacementState = useTerminalStore.getState().worktrees;
        if (replacementGesture)
          requestTerminalFocus('terminal-1', replacementDocument);
        return bound;
      });
      await act(async () => {
        root.render(
          <TerminalPanelSurface
            host={host}
            appName="Canopy"
            projectId={PROJECT_ID}
            worktreeId={WORKTREE_ID}
            panelId="panel-terminal"
          />,
        );
        await Promise.resolve();
      });
      await act(async () => {
        container
          .querySelector<HTMLButtonElement>(
            '[data-testid="terminal-start-button"]',
          )
          ?.click();
        await Promise.resolve();
      });
      expect(consumeTerminalFocusRequest('terminal-1', document)).toBe(false);
      expect(
        consumeTerminalFocusRequest('terminal-1', replacementDocument),
      ).toBe(replacementGesture);
      expect(fake.calls.commands['terminal.kill']).toHaveBeenCalledWith({
        terminalId: 'terminal-1',
      });
      expect(
        replacement.calls.commands['terminal.kill'],
      ).not.toHaveBeenCalled();
      expect(useTerminalStore.getState().worktrees).toBe(replacementState);
    },
  );

  it('does not move a queued spawn gesture to a new binding while hydration is pending', async () => {
    await act(async () => {
      root.render(
        <TerminalPanelSurface
          host={host}
          appName="Canopy"
          projectId={PROJECT_ID}
          worktreeId={WORKTREE_ID}
          panelId="panel-terminal"
          active
        />,
      );
      await Promise.resolve();
    });
    let finishHydration: (() => void) | undefined;
    jest.mocked(ensureTerminalWorktreeHydrated).mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishHydration = resolve;
      }),
    );
    act(() => {
      requestTerminalSpawn({
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
        layoutKey: `${PROJECT_ID}/${WORKTREE_ID}`,
        panelId: 'panel-terminal',
        mode: 'new-tab',
      });
    });
    const replacement = createFakeTerminalClient();
    replacement.calls.commands['terminal.spawn'].mockResolvedValue(
      shellSession(),
    );
    await act(async () => {
      disposeClient = bindTerminalClient(replacement.client);
      finishHydration?.();
      await Promise.resolve();
    });
    expect(spawn).not.toHaveBeenCalled();
    expect(replacement.calls.commands['terminal.spawn']).not.toHaveBeenCalled();
    expect(bindTerminal).not.toHaveBeenCalled();
  });

  it('renders only a Start terminal button for an empty panel', async () => {
    await act(async () => {
      root.render(
        <TerminalPanelSurface
          host={host}
          appName="Canopy"
          projectId={PROJECT_ID}
          worktreeId={WORKTREE_ID}
          panelId="panel-terminal"
        />,
      );
      await Promise.resolve();
    });

    expect(container.textContent).toBe('Start terminal');
    expect(container.querySelector('[aria-label="New terminal"]')).toBeNull();
    expect(container.querySelector('[aria-label="Split terminal"]')).toBeNull();
    expect(container.textContent).not.toContain('No terminals');
  });

  it('does not offer to start a duplicate while a bound terminal hydrates', async () => {
    await act(async () => {
      root.render(
        <TerminalPanelSurface
          host={host}
          appName="Canopy"
          projectId={PROJECT_ID}
          worktreeId={WORKTREE_ID}
          panelId="panel-terminal"
          terminalId="terminal-1"
        />,
      );
      await Promise.resolve();
    });

    expect(container.textContent).toBe('Loading terminal…');
    // Secondary ink: `fg-muted` was never a role the stylesheet generates.
    expect(
      container
        .querySelector('[data-testid="terminal-panel-loading"]')
        ?.className.split(/\s+/),
    ).toContain('fg-secondary');
    expect(
      container.querySelector('[data-testid="terminal-start-button"]'),
    ).toBeNull();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('retries hydration for a bound terminal after a transient failure', async () => {
    jest.useFakeTimers();
    const initialHydrationCalls = jest.mocked(ensureTerminalWorktreeHydrated)
      .mock.calls.length;
    jest
      .mocked(ensureTerminalWorktreeHydrated)
      .mockRejectedValueOnce(new Error('hydrate failed'))
      .mockImplementationOnce(() => {
        useTerminalStore.getState().addGroupWithTerminal(shellSession());
        return Promise.resolve();
      });

    try {
      await act(async () => {
        root.render(
          <TerminalPanelSurface
            host={host}
            appName="Canopy"
            projectId={PROJECT_ID}
            worktreeId={WORKTREE_ID}
            panelId="panel-terminal"
            terminalId="terminal-1"
          />,
        );
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(container.textContent).toBe('Loading terminal…');

      await act(async () => {
        jest.advanceTimersByTime(1_000);
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(
        container.querySelector('[data-testid="mock-terminal-pane"]'),
      ).not.toBeNull();
      expect(ensureTerminalWorktreeHydrated).toHaveBeenCalledTimes(
        initialHydrationCalls + 2,
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not spawn over an unresolved binding from the reveal shortcut', async () => {
    await act(async () => {
      root.render(
        <TerminalPanelSurface
          host={host}
          appName="Canopy"
          projectId={PROJECT_ID}
          worktreeId={WORKTREE_ID}
          panelId="panel-terminal"
          terminalId="terminal-1"
          active
        />,
      );
      await Promise.resolve();
    });

    await act(async () => {
      requestTerminalSpawn({
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
        mode: 'ensure',
      });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(spawn).not.toHaveBeenCalled();
  });

  it('does not spawn a duplicate when a binding appears during hydration', async () => {
    // The panel mounts UNBOUND, so the captured `terminalId` prop is
    // undefined for the whole spawn closure. A restored session binds it
    // while `ensureTerminalWorktreeHydrated` is still in flight — exactly
    // what a reveal gesture landing mid-restore produces. Reading the
    // binding live is the only way to see it.
    // Hydration is what materializes a restored session onto the panel, so
    // binding the panel from inside the mock is the faithful ordering.
    jest
      .mocked(ensureTerminalWorktreeHydrated)
      .mockImplementation(async (): Promise<void> => {
        await Promise.resolve();
        getTerminalPanelBinding.mockReturnValue('terminal-restored');
      });

    await act(async () => {
      root.render(
        <TerminalPanelSurface
          host={host}
          appName="Canopy"
          projectId={PROJECT_ID}
          worktreeId={WORKTREE_ID}
          panelId="panel-terminal"
          active
        />,
      );
      await Promise.resolve();
    });

    await act(async () => {
      requestTerminalSpawn({
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
        mode: 'ensure',
      });
      await Promise.resolve();
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getTerminalPanelBinding).toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  // The sibling half of the race above. The duplicate-PTY guard lives inside
  // `spawn`, so a stale captured `terminalId` in the CLAIM closure routed a
  // just-bound panel into `spawn`, which correctly declined to create a
  // second PTY — and then nobody requested the caret for the terminal that
  // had just appeared, so the reveal landed without moving it.
  it('focuses a terminal that binds during the reveal hydration', async () => {
    jest
      .mocked(ensureTerminalWorktreeHydrated)
      .mockImplementation(async (): Promise<void> => {
        await Promise.resolve();
        useTerminalStore
          .getState()
          .addGroupWithTerminal(shellSession('terminal-restored'));
        getTerminalPanelBinding.mockReturnValue('terminal-restored');
      });

    await act(async () => {
      root.render(
        <TerminalPanelSurface
          host={host}
          appName="Canopy"
          projectId={PROJECT_ID}
          worktreeId={WORKTREE_ID}
          panelId="panel-terminal"
          active
        />,
      );
      await Promise.resolve();
    });

    await act(async () => {
      requestTerminalSpawn({
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
        panelId: 'panel-terminal',
        mode: 'ensure',
      });
      await Promise.resolve();
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(spawn).not.toHaveBeenCalled();
    expect(consumeTerminalFocusRequest('terminal-restored')).toBe(true);
  });

  // A reveal names the panel it resolved. A different, already-bound terminal
  // surface in the same layout must not be able to claim it and satisfy it by
  // re-focusing itself — that left the revealed tab unbound and moved the
  // caret to an unrelated terminal, non-deterministically by mount order.
  it('lets only the targeted panel claim a panel-scoped reveal request', async () => {
    const layoutKey = `${PROJECT_ID}/${WORKTREE_ID}`;
    useTerminalStore
      .getState()
      .addGroupWithTerminal(shellSession('terminal-1'));

    await act(async () => {
      root.render(
        <PanelPlacementContext.Provider
          value={{ layoutKey, groupId: 'group-main' }}
        >
          <TerminalPanelSurface
            host={host}
            appName="Canopy"
            projectId={PROJECT_ID}
            worktreeId={WORKTREE_ID}
            panelId="panel-bound"
            terminalId="terminal-1"
            active
          />
        </PanelPlacementContext.Provider>,
      );
      await Promise.resolve();
    });
    clearTerminalFocusRequest('terminal-1');

    await act(async () => {
      requestTerminalSpawn({
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
        layoutKey,
        panelId: 'panel-unbound',
        mode: 'ensure',
      });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(spawn).not.toHaveBeenCalled();
    expect(consumeTerminalFocusRequest('terminal-1')).toBe(false);
  });

  it('installs the exit subscription even when initial hydration fails', async () => {
    jest
      .mocked(ensureTerminalWorktreeHydrated)
      .mockRejectedValueOnce(new Error('hydrate failed'));

    await act(async () => {
      root.render(
        <TerminalPanelSurface
          host={host}
          appName="Canopy"
          projectId={PROJECT_ID}
          worktreeId={WORKTREE_ID}
          panelId="panel-terminal"
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(ensureTerminalExitSubscription).toHaveBeenCalledTimes(1);
  });

  it('starts and binds the panel immediately from the empty state', async () => {
    await act(async () => {
      root.render(
        <TerminalPanelSurface
          host={host}
          appName="Canopy"
          projectId={PROJECT_ID}
          worktreeId={WORKTREE_ID}
          panelId="panel-terminal"
        />,
      );
      await Promise.resolve();
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="terminal-start-button"]',
        )
        ?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(spawn).toHaveBeenCalled();
    expect(bindTerminal).toHaveBeenCalledWith(
      `${PROJECT_ID}/${WORKTREE_ID}`,
      'panel-terminal',
      shellSession(),
    );
  });

  it('offers Restart terminal for readonly shells and restores their history id', async () => {
    useTerminalStore.getState().addGroupWithTerminal(shellSession());
    useTerminalStore.getState().applyExit({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      terminalId: 'terminal-1',
      exitCode: 0,
      signal: null,
    });
    await act(async () => {
      root.render(
        <TerminalPanelSurface
          host={{ ...host, restoreOnReveal: false }}
          appName="Canopy"
          projectId={PROJECT_ID}
          worktreeId={WORKTREE_ID}
          panelId="panel-terminal"
          terminalId="terminal-1"
        />,
      );
      await Promise.resolve();
    });

    expect(container.textContent).toContain('Restart terminal');
    await act(async () => {
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === 'Restart terminal')
        ?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(restore).toHaveBeenCalledWith(
      expect.objectContaining({ terminalId: 'terminal-1' }),
    );
    expect(disposeInstance).toHaveBeenCalledWith('terminal-1');
    expect(
      useTerminalStore.getState().worktrees[`${PROJECT_ID}/${WORKTREE_ID}`]
        ?.sessions['terminal-1']?.live,
    ).toBe(true);
  });

  it('focuses only the active terminal panel', async () => {
    useTerminalStore.getState().addGroupWithTerminal(shellSession());
    await act(async () => {
      root.render(
        <TerminalPanelSurface
          host={host}
          appName="Canopy"
          projectId={PROJECT_ID}
          worktreeId={WORKTREE_ID}
          panelId="panel-terminal"
          terminalId="terminal-1"
          active={false}
        />,
      );
      await Promise.resolve();
    });

    expect(mockTerminalPane).toHaveBeenLastCalledWith(
      expect.objectContaining({ focused: false }),
    );

    await act(async () => {
      root.render(
        <TerminalPanelSurface
          host={host}
          appName="Canopy"
          projectId={PROJECT_ID}
          worktreeId={WORKTREE_ID}
          panelId="panel-terminal"
          terminalId="terminal-1"
          active
        />,
      );
      await Promise.resolve();
    });

    expect(mockTerminalPane).toHaveBeenLastCalledWith(
      expect.objectContaining({ focused: true }),
    );
  });

  it('restores historical shells only after their panel becomes active', async () => {
    useTerminalStore.getState().addGroupWithTerminal(shellSession());
    useTerminalStore.getState().applyExit({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      terminalId: 'terminal-1',
      exitCode: null,
      signal: 'app-quit',
    });
    await act(async () => {
      root.render(
        <TerminalPanelSurface
          host={host}
          appName="Canopy"
          projectId={PROJECT_ID}
          worktreeId={WORKTREE_ID}
          panelId="panel-terminal"
          terminalId="terminal-1"
          active={false}
        />,
      );
      await Promise.resolve();
    });
    expect(mockTerminalPane).toHaveBeenLastCalledWith(
      expect.objectContaining({ restoreOnMount: false }),
    );

    await act(async () => {
      root.render(
        <TerminalPanelSurface
          host={host}
          appName="Canopy"
          projectId={PROJECT_ID}
          worktreeId={WORKTREE_ID}
          panelId="panel-terminal"
          terminalId="terminal-1"
          active
        />,
      );
      await Promise.resolve();
    });
    expect(mockTerminalPane).toHaveBeenLastCalledWith(
      expect.objectContaining({ restoreOnMount: true }),
    );
  });

  it('keeps automatic restore disabled on reveal and forwards pane callbacks', () => {
    useTerminalStore.getState().addGroupWithTerminal(shellSession());
    useTerminalStore.getState().applyExit({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      terminalId: 'terminal-1',
      exitCode: 0,
      signal: 'app-quit',
    });
    const onSendToChat = jest.fn();
    const getPathsForFiles = jest.fn(() => Promise.resolve(['/tmp/file']));
    const cloudHost = { ...host, restoreOnReveal: false };
    for (const active of [false, true]) {
      act(() => {
        root.render(
          <TerminalPanelSurface
            host={cloudHost}
            appName="Example"
            projectId={PROJECT_ID}
            worktreeId={WORKTREE_ID}
            panelId="panel-terminal"
            terminalId="terminal-1"
            active={active}
            onSendToChat={onSendToChat}
            getPathsForFiles={getPathsForFiles}
          />,
        );
      });
      expect(mockTerminalPane).toHaveBeenLastCalledWith(
        expect.objectContaining({
          restoreOnMount: false,
          onSendToChat,
          getPathsForFiles,
        }),
      );
    }
    expect(spawn).not.toHaveBeenCalled();
    expect(restore).not.toHaveBeenCalled();
  });

  it('opts the pane into terminal find under its session title, also once exited', () => {
    useTerminalStore
      .getState()
      .addGroupWithTerminal({ ...shellSession(), title: '  build  ' });
    useTerminalStore
      .getState()
      .addGroupWithTerminal(shellSession('terminal-2'));
    const render = (terminalId: string): void => {
      act(() => {
        root.render(
          <TerminalPanelSurface
            host={host}
            appName="Canopy"
            projectId={PROJECT_ID}
            worktreeId={WORKTREE_ID}
            panelId="panel-terminal"
            terminalId={terminalId}
          />,
        );
      });
    };

    render('terminal-1');
    expect(mockTerminalPane).toHaveBeenLastCalledWith(
      expect.objectContaining({ terminalId: 'terminal-1', findTitle: 'build' }),
    );
    render('terminal-2');
    expect(mockTerminalPane).toHaveBeenLastCalledWith(
      expect.objectContaining({
        terminalId: 'terminal-2',
        findTitle: 'Terminal',
      }),
    );

    useTerminalStore.getState().applyExit({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      terminalId: 'terminal-1',
      exitCode: 0,
      signal: null,
    });
    render('terminal-1');
    expect(mockTerminalPane).toHaveBeenLastCalledWith(
      expect.objectContaining({ terminalId: 'terminal-1', findTitle: 'build' }),
    );
  });

  it('forwards the native context menu opt-out to the pane, off by default', async () => {
    useTerminalStore.getState().addGroupWithTerminal(shellSession());
    for (const suppressNativeContextMenu of [undefined, true]) {
      await act(async () => {
        root.render(
          <TerminalPanelSurface
            host={host}
            appName="Canopy"
            projectId={PROJECT_ID}
            worktreeId={WORKTREE_ID}
            panelId="panel-terminal"
            terminalId="terminal-1"
            suppressNativeContextMenu={suppressNativeContextMenu}
          />,
        );
        await Promise.resolve();
      });

      expect(mockTerminalPane).toHaveBeenLastCalledWith(
        expect.objectContaining({ suppressNativeContextMenu }),
      );
    }
  });

  it('serializes rapid shortcut spawn requests without dropping one', async () => {
    let resolveFirst: ((session: TerminalSession) => void) | undefined;
    spawn
      .mockReturnValueOnce(
        new Promise<TerminalSession>((resolve) => {
          resolveFirst = resolve;
        }),
      )
      .mockResolvedValueOnce(shellSession('terminal-2'));
    await act(async () => {
      root.render(
        <TerminalPanelSurface
          host={host}
          appName="Canopy"
          projectId={PROJECT_ID}
          worktreeId={WORKTREE_ID}
          panelId="panel-terminal"
          active
        />,
      );
      await Promise.resolve();
    });

    await act(async () => {
      requestTerminalSpawn({
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
        mode: 'new-tab',
      });
      requestTerminalSpawn({
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
        mode: 'new-tab',
      });
      await Promise.resolve();
    });
    expect(spawn).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFirst?.(shellSession('terminal-1'));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it('lets only the terminal panel in the originating layout claim a shortcut', async () => {
    const mainLayoutKey = `${PROJECT_ID}/${WORKTREE_ID}`;
    const auxLayoutKey = `${mainLayoutKey}#aux:terminal-window`;

    await act(async () => {
      root.render(
        <>
          <PanelPlacementContext.Provider
            value={{ layoutKey: mainLayoutKey, groupId: 'group-main' }}
          >
            <TerminalPanelSurface
              host={host}
              appName="Canopy"
              projectId={PROJECT_ID}
              worktreeId={WORKTREE_ID}
              panelId="panel-main"
              active
            />
          </PanelPlacementContext.Provider>
          <PanelPlacementContext.Provider
            value={{ layoutKey: auxLayoutKey, groupId: 'group-aux' }}
          >
            <TerminalPanelSurface
              host={host}
              appName="Canopy"
              projectId={PROJECT_ID}
              worktreeId={WORKTREE_ID}
              panelId="panel-aux"
              active
            />
          </PanelPlacementContext.Provider>
        </>,
      );
      await Promise.resolve();
    });

    await act(async () => {
      requestTerminalSpawn({
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
        layoutKey: auxLayoutKey,
        mode: 'new-tab',
      });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(bindTerminal).toHaveBeenCalledWith(
      `${PROJECT_ID}/${WORKTREE_ID}`,
      'panel-aux',
      expect.any(Object),
    );
    expect(bindTerminal).not.toHaveBeenCalledWith(
      `${PROJECT_ID}/${WORKTREE_ID}`,
      'panel-main',
      expect.any(Object),
    );
  });

  describe('start and restart size', () => {
    const rect = (width: number, height: number): DOMRect => ({
      width,
      height,
      top: 0,
      left: 0,
      bottom: height,
      right: width,
      x: 0,
      y: 0,
      toJSON: (): Record<string, never> => ({}),
    });
    const paneHosts: HTMLElement[] = [];
    afterEach(() => {
      for (const paneHost of paneHosts.splice(0)) paneHost.remove();
    });
    /** A cached xterm entry whose container sits in a pane host of `size`. */
    function cachedEntry(options: {
      size?: { width: number; height: number };
      attached?: boolean;
      term?: { cols: number; rows: number };
      propose?: () => { cols: number; rows: number } | undefined;
    }): { container: HTMLDivElement } {
      const paneHost = document.createElement('div');
      const entryContainer = document.createElement('div');
      if (options.attached ?? true) {
        paneHost.append(entryContainer);
        // Outside the React root, which owns its container's children.
        document.body.append(paneHost);
        paneHosts.push(paneHost);
      }
      const size = options.size ?? { width: 1200, height: 800 };
      jest
        .spyOn(paneHost, 'getBoundingClientRect')
        .mockReturnValue(rect(size.width, size.height));
      const entry = {
        container: entryContainer,
        fit: {
          proposeDimensions: options.propose ?? ((): undefined => undefined),
        },
        ...(options.term ? { term: options.term } : {}),
      };
      peekInstance.mockImplementation((id) =>
        id === 'terminal-1' ? entry : undefined,
      );
      return entry;
    }
    async function restartEndedTerminal(): Promise<void> {
      useTerminalStore.getState().addGroupWithTerminal(shellSession());
      useTerminalStore.getState().applyExit({
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
        terminalId: 'terminal-1',
        exitCode: 0,
        signal: null,
      });
      await act(async () => {
        root.render(
          <TerminalPanelSurface
            host={{ ...host, restoreOnReveal: false }}
            appName="Canopy"
            projectId={PROJECT_ID}
            worktreeId={WORKTREE_ID}
            panelId="panel-terminal"
            terminalId="terminal-1"
          />,
        );
        await Promise.resolve();
      });
      await act(async () => {
        Array.from(container.querySelectorAll('button'))
          .find((button) => button.textContent === 'Restart terminal')
          ?.click();
        await Promise.resolve();
        await Promise.resolve();
      });
    }

    it('restarts at the size its attached pane fits to, read before disposal', async () => {
      cachedEntry({
        term: { cols: 80, rows: 24 },
        propose: (): { cols: number; rows: number } => ({
          cols: 151,
          rows: 53,
        }),
      });
      restore.mockImplementation((args): Promise<TerminalSession> => {
        // The pane's xterm is still cached when the size is sent.
        expect(disposeInstance).not.toHaveBeenCalled();
        expect(args).toMatchObject({ cols: 151, rows: 53 });
        return Promise.resolve(shellSession());
      });
      await restartEndedTerminal();

      expect(restore).toHaveBeenCalledWith({
        terminalId: 'terminal-1',
        cols: 151,
        rows: 53,
      });
      expect(measureTerminalDimensions).not.toHaveBeenCalled();
    });

    it.each([
      [
        'a detached pane',
        {
          attached: false,
          propose: (): { cols: number; rows: number } => ({
            cols: 151,
            rows: 53,
          }),
        },
      ],
      [
        'a hidden pane',
        {
          size: { width: 0, height: 0 },
          propose: (): { cols: number; rows: number } => ({ cols: 2, rows: 1 }),
        },
      ],
      ['a fit with no proposal', { propose: (): undefined => undefined }],
      [
        'a non-finite proposal',
        {
          propose: (): { cols: number; rows: number } => ({
            cols: Number.NaN,
            rows: 53,
          }),
        },
      ],
      [
        'a fit that throws',
        {
          propose: (): { cols: number; rows: number } => {
            throw new Error('xterm is not open');
          },
        },
      ],
    ])(
      "falls back to the terminal's last fitted size for %s",
      async (_label, options) => {
        cachedEntry({ ...options, term: { cols: 132, rows: 41 } });
        await restartEndedTerminal();

        expect(restore).toHaveBeenCalledWith({
          terminalId: 'terminal-1',
          cols: 132,
          rows: 41,
        });
      },
    );

    it('falls back to 80x24 without a cached terminal or its size', async () => {
      await restartEndedTerminal();
      expect(restore).toHaveBeenLastCalledWith({
        terminalId: 'terminal-1',
        cols: 80,
        rows: 24,
      });

      act(() => root.unmount());
      root = createRoot(container);
      restore.mockClear();
      // An entry without a usable fit or xterm size must not be dereferenced.
      cachedEntry({ attached: false });
      await restartEndedTerminal();
      expect(restore).toHaveBeenLastCalledWith({
        terminalId: 'terminal-1',
        cols: 80,
        rows: 24,
      });
    });

    it('starts at the size measured for the panel content area', async () => {
      measureTerminalDimensions.mockReturnValue({ cols: 151, rows: 50 });
      await act(async () => {
        root.render(
          <TerminalPanelSurface
            host={host}
            appName="Canopy"
            projectId={PROJECT_ID}
            worktreeId={WORKTREE_ID}
            panelId="panel-terminal"
          />,
        );
        await Promise.resolve();
      });
      await act(async () => {
        container
          .querySelector<HTMLButtonElement>(
            '[data-testid="terminal-start-button"]',
          )
          ?.click();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(measureTerminalDimensions).toHaveBeenCalledWith(
        container.querySelector('[data-testid="terminal-panel-surface"]'),
      );
      expect(spawn).toHaveBeenCalledWith(
        expect.objectContaining({ cols: 151, rows: 50 }),
      );
    });

    it('starts at 80x24 when the content area cannot be measured', async () => {
      measureTerminalDimensions.mockReturnValue(null);
      await act(async () => {
        root.render(
          <TerminalPanelSurface
            host={host}
            appName="Canopy"
            projectId={PROJECT_ID}
            worktreeId={WORKTREE_ID}
            panelId="panel-terminal"
          />,
        );
        await Promise.resolve();
      });
      await act(async () => {
        container
          .querySelector<HTMLButtonElement>(
            '[data-testid="terminal-start-button"]',
          )
          ?.click();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(spawn).toHaveBeenCalledWith(
        expect.objectContaining({ cols: 80, rows: 24 }),
      );
    });
  });

  it('shows restart failures beside a bound terminal', async () => {
    restore.mockRejectedValueOnce(new Error('restore failed'));
    useTerminalStore.getState().addGroupWithTerminal(shellSession());
    useTerminalStore.getState().applyExit({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      terminalId: 'terminal-1',
      exitCode: 0,
      signal: null,
    });
    await act(async () => {
      root.render(
        <TerminalPanelSurface
          host={host}
          appName="Canopy"
          projectId={PROJECT_ID}
          worktreeId={WORKTREE_ID}
          panelId="panel-terminal"
          terminalId="terminal-1"
        />,
      );
      await Promise.resolve();
    });

    await act(async () => {
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === 'Restart terminal')
        ?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain('Unable to restart terminal');
  });

  // CAN-2309 — starting/revealing a terminal is a user gesture that entitles
  // the pane to the caret; merely being the active visible panel is not.
  describe('caret focus intent', () => {
    it('discards the focus gesture when a started terminal cannot be bound', async () => {
      bindTerminal.mockReturnValueOnce(false);
      await act(async () => {
        root.render(
          <TerminalPanelSurface
            host={host}
            appName="Canopy"
            projectId={PROJECT_ID}
            worktreeId={WORKTREE_ID}
            panelId="panel-terminal"
            active
          />,
        );
        await Promise.resolve();
      });

      await act(async () => {
        container
          .querySelector<HTMLButtonElement>(
            '[data-testid="terminal-start-button"]',
          )
          ?.click();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(consumeTerminalFocusRequest('terminal-1')).toBe(false);
    });

    it('records a focus gesture when the user starts a terminal', async () => {
      await act(async () => {
        root.render(
          <TerminalPanelSurface
            host={host}
            appName="Canopy"
            projectId={PROJECT_ID}
            worktreeId={WORKTREE_ID}
            panelId="panel-terminal"
            active
          />,
        );
        await Promise.resolve();
      });

      await act(async () => {
        container
          .querySelector<HTMLButtonElement>(
            '[data-testid="terminal-start-button"]',
          )
          ?.click();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(consumeTerminalFocusRequest('terminal-1')).toBe(true);
    });

    // Restart is an explicit gesture. The intent has to be recorded AFTER the
    // pane remount it triggers: the pane is keyed on `paneRevision` and
    // `restore` reuses the terminal id, so a request recorded before the bump
    // is deleted by the outgoing pane's unmount cleanup and the replacement
    // pane consumes nothing.
    it('records a focus gesture when the user restarts a terminal', async () => {
      useTerminalStore.getState().addGroupWithTerminal(shellSession());
      useTerminalStore.getState().applyExit({
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
        terminalId: 'terminal-1',
        exitCode: 0,
        signal: null,
      });

      await act(async () => {
        root.render(
          <TerminalPanelSurface
            host={host}
            appName="Canopy"
            projectId={PROJECT_ID}
            worktreeId={WORKTREE_ID}
            panelId="panel-terminal"
            terminalId="terminal-1"
            active
          />,
        );
        await Promise.resolve();
      });

      // Any gesture recorded by mount/reveal is not what this asserts.
      clearTerminalFocusRequest('terminal-1');

      const restartButton = Array.from(
        container.querySelectorAll<HTMLButtonElement>('button'),
      ).find((button) => button.textContent === 'Restart terminal');
      if (restartButton === undefined) {
        throw new Error('Expected the restart affordance');
      }
      await act(async () => {
        restartButton.click();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(consumeTerminalFocusRequest('terminal-1')).toBe(true);
    });

    it('records a focus gesture for an explicit reveal of an existing terminal', async () => {
      useTerminalStore
        .getState()
        .addGroupWithTerminal(shellSession('terminal-1'));

      await act(async () => {
        root.render(
          <TerminalPanelSurface
            host={host}
            appName="Canopy"
            projectId={PROJECT_ID}
            worktreeId={WORKTREE_ID}
            panelId="panel-terminal"
            terminalId="terminal-1"
            active
          />,
        );
        await Promise.resolve();
        await Promise.resolve();
      });
      __resetTerminalFocusIntentForTests();

      await act(async () => {
        requestTerminalSpawn({
          projectId: PROJECT_ID,
          worktreeId: WORKTREE_ID,
          mode: 'ensure',
        });
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(consumeTerminalFocusRequest('terminal-1')).toBe(true);
    });

    it('records no focus gesture for a panel that simply becomes active', async () => {
      useTerminalStore
        .getState()
        .addGroupWithTerminal(shellSession('terminal-1'));

      await act(async () => {
        root.render(
          <TerminalPanelSurface
            host={host}
            appName="Canopy"
            projectId={PROJECT_ID}
            worktreeId={WORKTREE_ID}
            panelId="panel-terminal"
            terminalId="terminal-1"
          />,
        );
        await Promise.resolve();
      });
      await act(async () => {
        root.render(
          <TerminalPanelSurface
            host={host}
            appName="Canopy"
            projectId={PROJECT_ID}
            worktreeId={WORKTREE_ID}
            panelId="panel-terminal"
            terminalId="terminal-1"
            active
          />,
        );
        await Promise.resolve();
      });

      expect(consumeTerminalFocusRequest('terminal-1')).toBe(false);
    });
  });

  // REG-2987 C1 — a host that owns recovery UI renders the one recovery
  // notice itself, so it needs awaitable start/restart actions that reject
  // with the original error, and the surface must stay out of its way.
  describe('host-owned recovery UI', () => {
    class ProviderUnavailableError extends Error {
      constructor() {
        super('Project is sleeping');
        this.name = 'ProviderUnavailableError';
      }
    }

    interface RecoveryHostHarness {
      host: TerminalPanelHost;
      onRecoveryError: jest.Mock<void, [unknown]>;
      unregisterStart: jest.Mock<void, []>;
      /** Calls the currently registered start, like the web recovery hook. */
      start: () => Promise<void>;
      /** Calls the currently registered restart, like the web recovery hook. */
      restart: () => Promise<void>;
    }

    function createRecoveryHost(ownsRecoveryUi = true): RecoveryHostHarness {
      const registered: {
        start?: () => Promise<void>;
        restart?: () => Promise<void>;
      } = {};
      const onRecoveryError = jest.fn<void, [unknown]>();
      const unregisterStart = jest.fn<void, []>();
      return {
        host: {
          ...host,
          restoreOnReveal: false,
          ownsRecoveryUi,
          onRecoveryError,
          registerStart: (_panelId, start): (() => void) => {
            registered.start = start;
            return (): void => {
              if (registered.start === start) registered.start = undefined;
              unregisterStart();
            };
          },
          registerRestart: (_panelId, restart): (() => void) => {
            registered.restart = restart;
            return (): void => {
              if (registered.restart === restart)
                registered.restart = undefined;
            };
          },
        },
        onRecoveryError,
        unregisterStart,
        start: (): Promise<void> =>
          registered.start
            ? registered.start()
            : Promise.reject(new Error('Start is not registered')),
        restart: (): Promise<void> =>
          registered.restart
            ? registered.restart()
            : Promise.reject(new Error('Restart is not registered')),
      };
    }

    async function renderSurface(
      surfaceHost: TerminalPanelHost,
      props: { terminalId?: string; active?: boolean } = {},
    ): Promise<void> {
      await act(async () => {
        root.render(
          <TerminalPanelSurface
            host={surfaceHost}
            appName="Canopy"
            projectId={PROJECT_ID}
            worktreeId={WORKTREE_ID}
            panelId="panel-terminal"
            {...props}
          />,
        );
        await Promise.resolve();
      });
    }

    function seedEndedTerminal(): void {
      useTerminalStore.getState().addGroupWithTerminal(shellSession());
      useTerminalStore.getState().applyExit({
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
        terminalId: 'terminal-1',
        exitCode: 0,
        signal: null,
      });
    }

    async function flushMicrotasks(): Promise<void> {
      for (let index = 0; index < 6; index += 1) await Promise.resolve();
    }

    /** Runs `interact`, lets a macrotask pass, and returns unhandled rejections. */
    async function collectUnhandledRejections(
      interact: () => Promise<void>,
    ): Promise<unknown[]> {
      const unhandled: unknown[] = [];
      const listener = (reason: unknown): void => {
        unhandled.push(reason);
      };
      process.on('unhandledRejection', listener);
      try {
        await interact();
        await act(async () => {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 0);
          });
        });
      } finally {
        process.off('unhandledRejection', listener);
      }
      return unhandled;
    }

    it('awaits the registered start until the empty panel is spawned and bound', async () => {
      const recovery = createRecoveryHost();
      let resolveSpawn: ((session: TerminalSession) => void) | undefined;
      spawn.mockReturnValue(
        new Promise<TerminalSession>((resolve) => {
          resolveSpawn = resolve;
        }),
      );
      await renderSurface(recovery.host, { active: true });

      let settled = false;
      let started: Promise<void> | undefined;
      await act(async () => {
        started = recovery.start().then(() => {
          settled = true;
        });
        await flushMicrotasks();
      });
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(settled).toBe(false);
      expect(bindTerminal).not.toHaveBeenCalled();

      await act(async () => {
        resolveSpawn?.(shellSession());
        await started;
      });
      expect(settled).toBe(true);
      expect(bindTerminal).toHaveBeenCalledWith(
        `${PROJECT_ID}/${WORKTREE_ID}`,
        'panel-terminal',
        shellSession(),
      );
      expect(consumeTerminalFocusRequest('terminal-1')).toBe(true);
      expect(recovery.onRecoveryError).not.toHaveBeenCalled();

      // Removing the surface withdraws its start action from the host.
      await act(async () => {
        root.render(<></>);
        await Promise.resolve();
      });
      expect(recovery.unregisterStart).toHaveBeenCalled();
      await expect(recovery.start()).rejects.toThrow('Start is not registered');
    });

    it('rejects the registered start with the original spawn error', async () => {
      const recovery = createRecoveryHost();
      const failure = new ProviderUnavailableError();
      spawn.mockRejectedValue(failure);
      await renderSurface(recovery.host);

      let rejection: unknown;
      await act(async () => {
        await recovery.start().catch((error: unknown) => {
          rejection = error;
        });
      });

      expect(rejection).toBe(failure);
      // The host awaited the failure itself; the surface does not echo it.
      expect(recovery.onRecoveryError).not.toHaveBeenCalled();
      expect(container.textContent).toBe('');
    });

    it('rejects the registered restart with the original restore error', async () => {
      const recovery = createRecoveryHost();
      const failure = new ProviderUnavailableError();
      restore.mockRejectedValue(failure);
      seedEndedTerminal();
      await renderSurface(recovery.host, { terminalId: 'terminal-1' });

      let rejection: unknown;
      await act(async () => {
        await recovery.restart().catch((error: unknown) => {
          rejection = error;
        });
      });

      expect(rejection).toBe(failure);
      expect(recovery.onRecoveryError).not.toHaveBeenCalled();
      expect(
        container.querySelector('[data-testid="terminal-panel-error"]'),
      ).toBeNull();
      expect(container.textContent).not.toContain('Unable to restart terminal');
    });

    it('resolves the registered restart once the terminal is live and joins a duplicate call', async () => {
      const recovery = createRecoveryHost();
      let resolveRestore: ((session: TerminalSession) => void) | undefined;
      restore.mockReturnValue(
        new Promise<TerminalSession>((resolve) => {
          resolveRestore = resolve;
        }),
      );
      seedEndedTerminal();
      await renderSurface(recovery.host, {
        terminalId: 'terminal-1',
        active: true,
      });
      clearTerminalFocusRequest('terminal-1');

      let first: Promise<void> | undefined;
      let second: Promise<void> | undefined;
      await act(async () => {
        first = recovery.restart();
        second = recovery.restart();
        await flushMicrotasks();
      });
      expect(restore).toHaveBeenCalledTimes(1);

      await act(async () => {
        resolveRestore?.(shellSession());
        await Promise.all([first, second]);
      });
      expect(disposeInstance).toHaveBeenCalledWith('terminal-1');
      expect(
        useTerminalStore.getState().worktrees[`${PROJECT_ID}/${WORKTREE_ID}`]
          ?.sessions['terminal-1']?.live,
      ).toBe(true);
      expect(consumeTerminalFocusRequest('terminal-1')).toBe(true);
    });

    it.each(['replace', 'dispose'] as const)(
      'rejects the registered start when the terminal client is %sd mid-start',
      async (change) => {
        const recovery = createRecoveryHost();
        let resolveSpawn: ((session: TerminalSession) => void) | undefined;
        spawn.mockReturnValue(
          new Promise<TerminalSession>((resolve) => {
            resolveSpawn = resolve;
          }),
        );
        await renderSurface(recovery.host);

        let rejection: unknown;
        let started: Promise<void> | undefined;
        await act(async () => {
          started = recovery.start().catch((error: unknown) => {
            rejection = error;
          });
          await flushMicrotasks();
        });
        expect(spawn).toHaveBeenCalledTimes(1);

        await act(async () => {
          if (change === 'dispose') disposeClient();
          else
            disposeClient = bindTerminalClient(
              createFakeTerminalClient().client,
            );
          resolveSpawn?.(shellSession('late-spawn'));
          await started;
        });

        // Resolution means "started in this client"; a stale spawn is not.
        expect(rejection).toBeInstanceOf(Error);
        expect(fake.calls.commands['terminal.kill']).toHaveBeenCalledWith({
          terminalId: 'late-spawn',
        });
        expect(bindTerminal).not.toHaveBeenCalled();
        expect(recovery.onRecoveryError).not.toHaveBeenCalled();
      },
    );

    it('renders no Start button or error for an empty panel', async () => {
      const recovery = createRecoveryHost();
      await renderSurface(recovery.host);

      expect(
        container.querySelector('[data-testid="terminal-start-button"]'),
      ).toBeNull();
      expect(container.textContent).toBe('');
      // Registering the start action is not a gesture.
      expect(spawn).not.toHaveBeenCalled();
    });

    it('renders no bottom Restart bar for an ended terminal', async () => {
      const recovery = createRecoveryHost();
      seedEndedTerminal();
      await renderSurface(recovery.host, {
        terminalId: 'terminal-1',
        active: true,
      });

      expect(mockTerminalPane).toHaveBeenLastCalledWith(
        expect.objectContaining({
          readOnlyMessage: null,
          onRestart: undefined,
        }),
      );
      expect(container.textContent).not.toContain('Restart terminal');
      expect(restore).not.toHaveBeenCalled();
    });

    it.each(['ensure', 'new-tab'] as const)(
      'reports a failed queued %s spawn through onRecoveryError without an unhandled rejection',
      async (mode) => {
        const recovery = createRecoveryHost();
        const failure = new ProviderUnavailableError();
        spawn.mockRejectedValue(failure);
        await renderSurface(recovery.host, { active: true });

        const unhandled = await collectUnhandledRejections(async () => {
          await act(async () => {
            requestTerminalSpawn({
              projectId: PROJECT_ID,
              worktreeId: WORKTREE_ID,
              panelId: 'panel-terminal',
              mode,
            });
            await flushMicrotasks();
          });
        });

        expect(spawn).toHaveBeenCalledTimes(1);
        expect(recovery.onRecoveryError).toHaveBeenCalledTimes(1);
        expect(recovery.onRecoveryError).toHaveBeenCalledWith(failure);
        expect(unhandled).toEqual([]);
        expect(container.textContent).toBe('');
      },
    );

    it('joins a queued Add panel spawn when the host starts the same panel', async () => {
      const recovery = createRecoveryHost();
      let resolveSpawn: ((session: TerminalSession) => void) | undefined;
      spawn.mockReturnValue(
        new Promise<TerminalSession>((resolve) => {
          resolveSpawn = resolve;
        }),
      );
      await renderSurface(recovery.host, { active: true });

      await act(async () => {
        requestTerminalSpawn({
          projectId: PROJECT_ID,
          worktreeId: WORKTREE_ID,
          panelId: 'panel-terminal',
          mode: 'new-tab',
        });
        await flushMicrotasks();
      });
      expect(spawn).toHaveBeenCalledTimes(1);

      let started: Promise<void> | undefined;
      await act(async () => {
        started = recovery.start();
        await flushMicrotasks();
      });
      expect(spawn).toHaveBeenCalledTimes(1);

      await act(async () => {
        resolveSpawn?.(shellSession());
        await started;
      });
      expect(bindTerminal).toHaveBeenCalledTimes(1);
      expect(recovery.onRecoveryError).not.toHaveBeenCalled();
    });

    it('tells the host while a queued Add panel start is in flight', async () => {
      const recovery = createRecoveryHost();
      const onStartingChange = jest.fn<void, [boolean]>();
      const surfaceHost: TerminalPanelHost = {
        ...recovery.host,
        onStartingChange,
      };
      let resolveSpawn: ((session: TerminalSession) => void) | undefined;
      spawn.mockReturnValue(
        new Promise<TerminalSession>((resolve) => {
          resolveSpawn = resolve;
        }),
      );
      await renderSurface(surfaceHost, { active: true });
      expect(onStartingChange).not.toHaveBeenCalled();

      await act(async () => {
        requestTerminalSpawn({
          projectId: PROJECT_ID,
          worktreeId: WORKTREE_ID,
          panelId: 'panel-terminal',
          mode: 'new-tab',
        });
        await flushMicrotasks();
      });
      expect(onStartingChange.mock.calls).toEqual([[true]]);

      await act(async () => {
        resolveSpawn?.(shellSession());
        await flushMicrotasks();
      });
      expect(onStartingChange.mock.calls).toEqual([[true], [false]]);
    });

    it('reports a failed start in flight as ended before the host hears the failure', async () => {
      const recovery = createRecoveryHost();
      const events: string[] = [];
      const surfaceHost: TerminalPanelHost = {
        ...recovery.host,
        onStartingChange: (starting): void => {
          events.push(starting ? 'starting' : 'settled');
        },
      };
      spawn.mockRejectedValue(new ProviderUnavailableError());
      await renderSurface(surfaceHost);

      await act(async () => {
        await recovery.start().catch((): void => {
          events.push('rejected');
        });
      });

      expect(events).toEqual(['starting', 'settled', 'rejected']);
    });

    it('reports a failed start once, through the host start that joined it', async () => {
      const recovery = createRecoveryHost();
      const failure = new ProviderUnavailableError();
      let rejectSpawn: ((error: Error) => void) | undefined;
      spawn.mockReturnValue(
        new Promise<TerminalSession>((_resolve, reject) => {
          rejectSpawn = reject;
        }),
      );
      await renderSurface(recovery.host, { active: true });

      const unhandled = await collectUnhandledRejections(async () => {
        await act(async () => {
          requestTerminalSpawn({
            projectId: PROJECT_ID,
            worktreeId: WORKTREE_ID,
            panelId: 'panel-terminal',
            mode: 'new-tab',
          });
          await flushMicrotasks();
        });
        let rejection: unknown;
        await act(async () => {
          const joined = recovery.start().catch((error: unknown) => {
            rejection = error;
          });
          await flushMicrotasks();
          rejectSpawn?.(failure);
          await joined;
        });
        expect(rejection).toBe(failure);
      });

      expect(spawn).toHaveBeenCalledTimes(1);
      // The host awaits the joined attempt, so the failure reaches it once.
      expect(recovery.onRecoveryError).not.toHaveBeenCalled();
      expect(unhandled).toEqual([]);
    });

    describe('default host', () => {
      it('keeps the Start failure message and reports nothing to the host', async () => {
        const recovery = createRecoveryHost(false);
        spawn.mockRejectedValue(new ProviderUnavailableError());
        await renderSurface(recovery.host);

        const unhandled = await collectUnhandledRejections(async () => {
          await act(async () => {
            container
              .querySelector<HTMLButtonElement>(
                '[data-testid="terminal-start-button"]',
              )
              ?.click();
            await flushMicrotasks();
          });
        });

        expect(container.textContent).toContain('Unable to start terminal');
        expect(recovery.onRecoveryError).not.toHaveBeenCalled();
        expect(unhandled).toEqual([]);
      });

      it('keeps the restart error overlay and rejects a registered restart with the original error', async () => {
        const recovery = createRecoveryHost(false);
        const failure = new ProviderUnavailableError();
        restore.mockRejectedValue(failure);
        seedEndedTerminal();
        await renderSurface(recovery.host, { terminalId: 'terminal-1' });

        expect(container.textContent).toContain('Restart terminal');
        let rejection: unknown;
        await act(async () => {
          await recovery.restart().catch((error: unknown) => {
            rejection = error;
          });
        });

        expect(rejection).toBe(failure);
        expect(
          container.querySelector('[data-testid="terminal-panel-error"]')
            ?.textContent,
        ).toBe('Unable to restart terminal');
        expect(recovery.onRecoveryError).not.toHaveBeenCalled();
      });

      describe('Linux shell unavailable', () => {
        const REASON =
          "zsh can't start: it isn't installed on this computer. Choose another shell and try again.";
        const shellUnavailable = (): Error =>
          new Error(
            `Error invoking remote method 'terminal:restore': Error: Terminal shell unavailable: ${REASON}`,
          );
        const panelError = (): string | undefined =>
          container.querySelector('[data-testid="terminal-panel-error"]')
            ?.textContent ?? undefined;

        it('shows the reason when Start fails', async () => {
          const recovery = createRecoveryHost(false);
          spawn.mockRejectedValue(shellUnavailable());
          await renderSurface(recovery.host);

          await act(async () => {
            container
              .querySelector<HTMLButtonElement>(
                '[data-testid="terminal-start-button"]',
              )
              ?.click();
            await flushMicrotasks();
          });

          expect(container.textContent).toContain(REASON);
          expect(container.textContent).not.toContain(
            'Unable to start terminal',
          );
        });

        it('shows the reason when a registered restart fails', async () => {
          const recovery = createRecoveryHost(false);
          restore.mockRejectedValue(shellUnavailable());
          seedEndedTerminal();
          await renderSurface(recovery.host, { terminalId: 'terminal-1' });

          await act(async () => {
            await recovery.restart().catch(() => undefined);
          });

          expect(panelError()).toBe(REASON);
        });

        it('shows the reason when automatic restore on mount fails, and ignores other failures', async () => {
          const recovery = createRecoveryHost(false);
          seedEndedTerminal();
          await renderSurface(recovery.host, { terminalId: 'terminal-1' });
          const failRestore = (error: unknown): void => {
            act(() => {
              mockTerminalPane.mock.lastCall?.[0].onRestoreFailed?.(error);
            });
          };

          failRestore(new Error('restore failed'));
          expect(panelError()).toBeUndefined();

          failRestore(shellUnavailable());
          expect(panelError()).toBe(REASON);
        });

        it('clears an automatic restore failure once a later retry makes the session live', async () => {
          const recovery = createRecoveryHost(false);
          seedEndedTerminal();
          await renderSurface(recovery.host, {
            terminalId: 'terminal-1',
            active: true,
          });

          act(() => {
            mockTerminalPane.mock.lastCall?.[0].onRestoreFailed?.(
              shellUnavailable(),
            );
          });
          expect(panelError()).toBe(REASON);

          // Automatic restore publishes success through the terminal store,
          // without running the surface's explicit Restart action.
          act(() => {
            useTerminalStore.getState().markTerminalLive(shellSession());
          });
          expect(panelError()).toBeUndefined();

          // A later normal exit must not bring back the previous failure.
          act(() => {
            useTerminalStore.getState().applyExit({
              projectId: PROJECT_ID,
              worktreeId: WORKTREE_ID,
              terminalId: 'terminal-1',
              exitCode: 0,
              signal: null,
            });
          });
          expect(panelError()).toBeUndefined();

          // An unresolved failure from a new restore still needs its reason.
          act(() => {
            mockTerminalPane.mock.lastCall?.[0].onRestoreFailed?.(
              shellUnavailable(),
            );
          });
          expect(panelError()).toBe(REASON);
        });

        it('leaves a host that owns recovery UI to its own handling', async () => {
          const recovery = createRecoveryHost(true);
          seedEndedTerminal();
          await renderSurface(recovery.host, { terminalId: 'terminal-1' });

          act(() => {
            mockTerminalPane.mock.lastCall?.[0].onRestoreFailed?.(
              shellUnavailable(),
            );
          });

          expect(panelError()).toBeUndefined();
          expect(container.textContent).not.toContain(REASON);
        });
      });
    });
  });
});
