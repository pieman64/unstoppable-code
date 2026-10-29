/**
 * @jest-environment jsdom
 */
import type { TerminalClient } from '@canopy/app-core';
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  TERMINAL_CANOPY_MANAGED_CLEANUP_SIGNAL,
  TERMINAL_CONNECTION_LOST_SIGNAL,
  TERMINAL_SANDBOX_ASLEEP_SIGNAL,
  TERMINAL_USER_CLOSE_SIGNAL,
  TERMINAL_WORKTREE_CLEANUP_SIGNAL,
  type TerminalExitEvent,
  type TerminalRunningChangedEvent,
} from '@canopy/protocol/terminal';
import {
  useTerminalCompletionNotices,
  type TerminalCompletionNotice,
} from '../useTerminalCompletionNotices';
import {
  bindTerminalClient,
  subscribeTerminalActivityFeed,
  TOAST_THRESHOLD_MS,
} from '@canopy/app-state/terminal';
import { createFakeTerminalClient } from '../../../../../app-state/src/terminal/__tests__/fake-terminal-client';
import { useTerminalActivityStore } from '@canopy/app-state/terminal';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

const PROJECT_ID = 'project-1';
const WORKTREE_ID = 'worktree-1';

let runningListeners: Set<(event: TerminalRunningChangedEvent) => void>;
let exitListeners: Set<(event: TerminalExitEvent) => void>;
let root: Root | null = null;
let addToastMock: jest.Mock;

let fake: ReturnType<typeof createFakeTerminalClient>;
let disposeBinding: () => void;
function installTerminalApi(): void {
  fake = createFakeTerminalClient();
  disposeBinding = bindTerminalClient(fake.client);
  runningListeners = new Set([
    (event: TerminalRunningChangedEvent): void => {
      fake.emit('terminal.running-changed', {
        ...event,
        occurredAt: '2026-09-22T00:00:00.000Z',
      });
    },
  ]);
  exitListeners = new Set([
    (event: TerminalExitEvent): void => {
      fake.emit('terminal.exit', {
        ...event,
        occurredAt: '2026-09-22T00:00:00.000Z',
      });
    },
  ]);
}

function resetTerminalActivityStore(): void {
  useTerminalActivityStore.setState({
    entriesByWorktree: {},
    runningWorktreeKeys: new Set<string>(),
    unseenWorktreeKeys: new Set<string>(),
    unseenFailureWorktreeKeys: new Set<string>(),
    baselineEstablished: new Set<string>(),
    userInitiatedCloseTerminalIds: new Set<string>(),
  });
}

function exitEvent(
  overrides: Partial<TerminalExitEvent> & { terminalId: string },
): TerminalExitEvent {
  return {
    projectId: PROJECT_ID,
    worktreeId: WORKTREE_ID,
    exitCode: 0,
    signal: null,
    ...overrides,
  };
}

function runningEvent(
  overrides: Partial<TerminalRunningChangedEvent> & { terminalId: string },
): TerminalRunningChangedEvent {
  return {
    projectId: PROJECT_ID,
    worktreeId: WORKTREE_ID,
    running: true,
    processName: 'claude',
    ...overrides,
  };
}

function Harness({
  onNotice = addToastMock,
}: {
  onNotice?: (notice: TerminalCompletionNotice) => void;
}): JSX.Element {
  useTerminalCompletionNotices({
    isClaudeCodeTerminal: (event): boolean => event.kind === 'claude-code',
    onNotice,
  });
  return <div />;
}

async function renderHarness(): Promise<void> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(<Harness />);
  });
  await act(async () => {
    await Promise.resolve();
  });
}

describe('useTerminalCompletionNotices', () => {
  beforeEach(() => {
    installTerminalApi();
    resetTerminalActivityStore();
    addToastMock = jest.fn();
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
      root = null;
    }
    disposeBinding();
    jest.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('suppresses clean exit toasts for Claude Code terminal processes', async () => {
    await renderHarness();

    act(() => {
      exitListeners.forEach((listener) =>
        listener(exitEvent({ terminalId: 'term-claude', kind: 'claude-code' })),
      );
    });

    expect(addToastMock).not.toHaveBeenCalled();
  });

  it('suppresses Claude Code clean exit toasts when PTY reports signal 0', async () => {
    await renderHarness();

    act(() => {
      exitListeners.forEach((listener) =>
        listener(
          exitEvent({
            terminalId: 'term-claude',
            kind: 'claude-code',
            exitCode: 0,
            signal: '0',
          }),
        ),
      );
    });

    expect(addToastMock).not.toHaveBeenCalled();
  });

  it('keeps clean exit toasts for normal terminals', async () => {
    await renderHarness();

    act(() => {
      exitListeners.forEach((listener) =>
        listener(exitEvent({ terminalId: 'term-shell' })),
      );
    });

    expect(addToastMock).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Terminal exited cleanly',
        type: 'success',
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
      }),
    );
  });

  it('suppresses Canopy-managed cleanup exit toasts', async () => {
    await renderHarness();

    act(() => {
      exitListeners.forEach((listener) =>
        listener(
          exitEvent({
            terminalId: 'term-claude',
            kind: 'claude-code',
            exitCode: 0,
            signal: TERMINAL_CANOPY_MANAGED_CLEANUP_SIGNAL,
          }),
        ),
      );
    });

    expect(addToastMock).not.toHaveBeenCalled();
  });

  it('treats signal 0 as a clean exit for normal terminals', async () => {
    await renderHarness();

    act(() => {
      exitListeners.forEach((listener) =>
        listener(
          exitEvent({
            terminalId: 'term-shell',
            exitCode: 0,
            signal: '0',
          }),
        ),
      );
    });

    expect(addToastMock).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Terminal exited cleanly',
        type: 'success',
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
      }),
    );
  });

  it('still reports non-zero exits from Claude Code terminal processes', async () => {
    await renderHarness();

    act(() => {
      exitListeners.forEach((listener) =>
        listener(
          exitEvent({
            terminalId: 'term-claude',
            kind: 'claude-code',
            exitCode: 1,
            signal: null,
          }),
        ),
      );
    });

    expect(addToastMock).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Terminal exited with code 1',
        type: 'error',
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
      }),
    );
  });

  it('suppresses foreground-command completion toasts for Claude Code terminals', async () => {
    let now = 1_700_000_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    await renderHarness();

    act(() => {
      runningListeners.forEach((listener) =>
        listener(
          runningEvent({ terminalId: 'term-claude', kind: 'claude-code' }),
        ),
      );
    });
    now += 4_000;
    act(() => {
      runningListeners.forEach((listener) =>
        listener(
          runningEvent({
            terminalId: 'term-claude',
            kind: 'claude-code',
            running: false,
            processName: null,
          }),
        ),
      );
    });

    expect(addToastMock).not.toHaveBeenCalled();
  });

  it('suppresses generic completion notifications for script terminals', async () => {
    let now = 1_700_000_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    await renderHarness();

    act(() => {
      runningListeners.forEach((listener) =>
        listener(
          runningEvent({
            terminalId: 'term-script',
            kind: 'script',
            processName: 'node',
          }),
        ),
      );
    });
    now += 4_000;
    act(() => {
      runningListeners.forEach((listener) =>
        listener(
          runningEvent({
            terminalId: 'term-script',
            kind: 'script',
            running: false,
            processName: null,
          }),
        ),
      );
      exitListeners.forEach((listener) =>
        listener(
          exitEvent({
            terminalId: 'term-script',
            kind: 'script',
            exitCode: 0,
          }),
        ),
      );
    });

    expect(addToastMock).not.toHaveBeenCalled();
  });
  it('uses the shared threshold and emits command copy from its own running snapshot', async () => {
    let now = 1000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    await renderHarness();
    fake.emit('terminal.running-changed', {
      ...runningEvent({ terminalId: 'cmd', processName: 'node' }),
      occurredAt: '2026-09-22T00:00:00.000Z',
    });
    now += TOAST_THRESHOLD_MS;
    fake.emit('terminal.running-changed', {
      ...runningEvent({ terminalId: 'cmd', running: false, processName: null }),
      occurredAt: '2026-09-22T00:00:00.000Z',
    });
    expect(addToastMock).toHaveBeenCalledWith({
      terminalId: 'cmd',
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      type: 'success',
      message: 'Command "node" completed',
    });
  });

  it('reconnects after disposal without carrying previous running snapshots', async () => {
    await renderHarness();
    fake.emit('terminal.running-changed', {
      ...runningEvent({ terminalId: 'cmd', processName: 'node' }),
      occurredAt: '2026-09-22T00:00:00.000Z',
    });
    disposeBinding();
    expect(fake.listenerCount('terminal.exit')).toBe(0);
    fake = createFakeTerminalClient();
    disposeBinding = bindTerminalClient(fake.client);
    expect(fake.listenerCount('terminal.exit')).toBe(1);
    fake.emit('terminal.running-changed', {
      ...runningEvent({ terminalId: 'cmd', running: false, processName: null }),
      occurredAt: '2026-09-22T00:00:00.000Z',
    });
    expect(addToastMock).not.toHaveBeenCalled();
    fake.emit('terminal.exit', {
      ...exitEvent({ terminalId: 'cmd' }),
      occurredAt: '2026-09-22T00:00:00.000Z',
    });
    expect(addToastMock).toHaveBeenCalledTimes(1);
  });

  it('keeps independent consumers and uses the latest callback without resubscribing', async () => {
    await renderHarness();
    const other = createRoot(document.createElement('div'));
    const otherNotice = jest.fn();
    act(() => other.render(<Harness onNotice={otherNotice} />));
    expect(fake.listenerCount('terminal.exit')).toBe(2);
    fake.emit('terminal.exit', {
      ...exitEvent({ terminalId: 't' }),
      occurredAt: '2026-09-22T00:00:00.000Z',
    });
    expect(addToastMock).toHaveBeenCalledTimes(1);
    expect(otherNotice).toHaveBeenCalledTimes(1);
    const changed = jest.fn();
    act(() => other.render(<Harness onNotice={changed} />));
    expect(fake.listenerCount('terminal.exit')).toBe(2);
    fake.emit('terminal.exit', {
      ...exitEvent({ terminalId: 't' }),
      occurredAt: '2026-09-22T00:00:00.000Z',
    });
    expect(changed).toHaveBeenCalledTimes(1);
    expect(otherNotice).toHaveBeenCalledTimes(1);
    act(() => other.unmount());
    expect(fake.listenerCount('terminal.exit')).toBe(1);
  });

  it('fences old callbacks even when a transport delivers after unsubscribe', async () => {
    const old = fake;
    const transport: TerminalClient = {
      ...old.client,
      subscribe: (name, handler) => {
        old.client.subscribe(name, handler);
        return (): void => undefined;
      },
    };
    disposeBinding = bindTerminalClient(transport);
    await renderHarness();
    fake = createFakeTerminalClient();
    disposeBinding = bindTerminalClient(fake.client);
    old.emit('terminal.exit', {
      ...exitEvent({ terminalId: 'old' }),
      occurredAt: '2026-09-22T00:00:00.000Z',
    });
    expect(addToastMock).not.toHaveBeenCalled();
    fake.emit('terminal.exit', {
      ...exitEvent({ terminalId: 'new' }),
      occurredAt: '2026-09-22T00:00:00.000Z',
    });
    expect(addToastMock).toHaveBeenCalledTimes(1);
  });

  it('cleans a partial subscription failure and reconnects the registered hook later', async () => {
    await renderHarness();
    const broken = createFakeTerminalClient();
    const failure = new Error('exit subscribe failed');
    const transport: TerminalClient = {
      ...broken.client,
      subscribe: (name, handler) => {
        if (name === 'terminal.exit') throw failure;
        const release = broken.client.subscribe(name, handler);
        return (): void => {
          release();
          throw new Error('release failed');
        };
      },
    };
    expect(() => bindTerminalClient(transport)).toThrow(failure);
    expect(broken.listenerCount('terminal.running-changed')).toBe(0);
    fake = createFakeTerminalClient();
    disposeBinding = bindTerminalClient(fake.client);
    expect(fake.listenerCount('terminal.exit')).toBe(1);
  });

  describe('command exit status and environment shutdowns', () => {
    const OCCURRED_AT = '2026-09-22T00:00:00.000Z';
    let now = 0;
    let releaseFeed: (() => void) | null = null;

    beforeEach(() => {
      now = 1_700_000_000_000;
      jest.spyOn(Date, 'now').mockImplementation((): number => now);
    });

    afterEach(() => {
      releaseFeed?.();
      releaseFeed = null;
    });

    function subscribeFeed(): void {
      releaseFeed = subscribeTerminalActivityFeed();
    }

    function emitRunning(
      overrides: Partial<TerminalRunningChangedEvent> & { terminalId: string },
    ): void {
      act(() => {
        fake.emit('terminal.running-changed', {
          ...runningEvent(overrides),
          occurredAt: OCCURRED_AT,
        });
      });
    }

    function emitCommandEnd(
      terminalId: string,
      exitCode: number | null | undefined,
      overrides: Partial<TerminalRunningChangedEvent> = {},
    ): void {
      emitRunning({
        terminalId,
        running: false,
        processName: null,
        ...(exitCode === undefined ? {} : { exitCode }),
        ...overrides,
      });
    }

    function emitExit(
      overrides: Partial<TerminalExitEvent> & { terminalId: string },
    ): void {
      act(() => {
        fake.emit('terminal.exit', {
          ...exitEvent(overrides),
          occurredAt: OCCURRED_AT,
        });
      });
    }

    function noticeMessages(): string[] {
      return addToastMock.mock.calls.map(
        ([notice]: [TerminalCompletionNotice]): string => notice.message,
      );
    }

    it('reports a known non-zero command status as an error at 3000 ms', async () => {
      await renderHarness();
      emitRunning({ terminalId: 'cmd', processName: 'make' });
      now += 3_000;
      emitCommandEnd('cmd', 2);

      expect(addToastMock).toHaveBeenCalledTimes(1);
      expect(addToastMock).toHaveBeenCalledWith({
        terminalId: 'cmd',
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
        type: 'error',
        message: 'Command "make" failed (exit 2)',
      });
    });

    it('reports a zero command status as completed at 3000 ms', async () => {
      await renderHarness();
      emitRunning({ terminalId: 'cmd', processName: 'npm' });
      now += 3_000;
      emitCommandEnd('cmd', 0);

      expect(addToastMock).toHaveBeenCalledTimes(1);
      expect(addToastMock).toHaveBeenCalledWith({
        terminalId: 'cmd',
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
        type: 'success',
        message: 'Command "npm" completed',
      });
    });

    it.each([
      ['bash', 0, 'success', 'Command "bash" completed'],
      ['bash', 7, 'error', 'Command "bash" failed (exit 7)'],
      ['sh', 0, 'success', 'Command "sh" completed'],
      ['sh', 7, 'error', 'Command "sh" failed (exit 7)'],
    ])(
      'reports explicit %s command status %s',
      async (processName, exitCode, type, message) => {
        await renderHarness();
        emitRunning({ terminalId: 'cmd', processName });
        now += 3_000;
        emitCommandEnd('cmd', exitCode);

        expect(addToastMock).toHaveBeenCalledTimes(1);
        expect(addToastMock).toHaveBeenCalledWith({
          terminalId: 'cmd',
          projectId: PROJECT_ID,
          worktreeId: WORKTREE_ID,
          type,
          message,
        });
      },
    );

    it.each(['bash', 'sh', 'pwsh.exe'])(
      'suppresses legacy %s observations with no reported status',
      async (processName) => {
        await renderHarness();
        emitRunning({ terminalId: 'cmd', processName });
        now += 5_000;
        emitCommandEnd('cmd', undefined);

        expect(addToastMock).not.toHaveBeenCalled();
      },
    );

    it.each([
      ['make', 0],
      ['make', 2],
      ['bash', 0],
      ['bash', 7],
      ['sh', 0],
      ['sh', 7],
    ])(
      'stays silent at 2999 ms for %s command status %p',
      async (processName, exitCode) => {
        await renderHarness();
        emitRunning({ terminalId: 'cmd', processName });
        now += 2_999;
        emitCommandEnd('cmd', exitCode);

        expect(addToastMock).not.toHaveBeenCalled();
      },
    );

    it.each(['make', 'bash', 'sh'])(
      'does not report an explicit null (unknown) %s status as success',
      async (processName) => {
        await renderHarness();
        emitRunning({ terminalId: 'cmd', processName });
        now += 10_000;
        emitCommandEnd('cmd', null);

        expect(addToastMock).not.toHaveBeenCalled();
      },
    );

    it.each([
      [0, 'success', 'Command completed'],
      [3, 'error', 'Command failed (exit 3)'],
      [undefined, 'success', 'Command completed'],
    ])(
      'uses unnamed copy for status %p when the command has no name',
      async (exitCode, type, message) => {
        await renderHarness();
        emitRunning({ terminalId: 'cmd', processName: null });
        now += 3_000;
        emitCommandEnd('cmd', exitCode);

        expect(addToastMock).toHaveBeenCalledTimes(1);
        expect(addToastMock).toHaveBeenCalledWith(
          expect.objectContaining({ type, message }),
        );
      },
    );

    it.each([
      [TERMINAL_CONNECTION_LOST_SIGNAL, 'feed before hook'],
      [TERMINAL_CONNECTION_LOST_SIGNAL, 'hook before feed'],
      [TERMINAL_SANDBOX_ASLEEP_SIGNAL, 'feed before hook'],
      [TERMINAL_SANDBOX_ASLEEP_SIGNAL, 'hook before feed'],
    ])('never notifies for a %s exit (%s)', async (signal, order) => {
      if (order === 'feed before hook') subscribeFeed();
      await renderHarness();
      if (order === 'hook before feed') subscribeFeed();

      emitRunning({ terminalId: 'cmd', processName: 'bash' });
      now += 10_000;
      emitExit({ terminalId: 'cmd', exitCode: null, signal });
      emitCommandEnd('cmd', 7);

      expect(addToastMock).not.toHaveBeenCalled();
    });

    it.each(['feed before hook', 'hook before feed'])(
      'stays silent for a user close (%s)',
      async (order) => {
        if (order === 'feed before hook') subscribeFeed();
        await renderHarness();
        if (order === 'hook before feed') subscribeFeed();

        emitRunning({ terminalId: 'cmd', processName: 'sh' });
        now += 10_000;
        useTerminalActivityStore.getState().markUserInitiatedClose('cmd');
        emitCommandEnd('cmd', 7);
        emitExit({
          terminalId: 'cmd',
          exitCode: null,
          signal: TERMINAL_USER_CLOSE_SIGNAL,
        });

        expect(addToastMock).not.toHaveBeenCalled();
        expect(
          useTerminalActivityStore
            .getState()
            .userInitiatedCloseTerminalIds.has('cmd'),
        ).toBe(false);
      },
    );

    it.each([
      [
        'connection lost',
        { exitCode: null, signal: TERMINAL_CONNECTION_LOST_SIGNAL },
        0,
      ],
      [
        'project asleep',
        { exitCode: null, signal: TERMINAL_SANDBOX_ASLEEP_SIGNAL },
        0,
      ],
      [
        'app-managed cleanup',
        { exitCode: 0, signal: TERMINAL_CANOPY_MANAGED_CLEANUP_SIGNAL },
        0,
      ],
      [
        'worktree cleanup',
        { exitCode: 0, signal: TERMINAL_WORKTREE_CLEANUP_SIGNAL },
        0,
      ],
      ['an untracked signal', { exitCode: null, signal: 'SIGTERM' }, 0],
      ['a non-zero shell exit', { exitCode: 1, signal: null }, 1],
    ])(
      'forgets the running snapshot after %s so a restart under the same id starts a fresh timer',
      async (_label, exit, exitNotices) => {
        await renderHarness();
        emitRunning({ terminalId: 'cmd', processName: 'sleep' });
        now += 1_000;
        emitExit({ terminalId: 'cmd', ...exit });
        expect(addToastMock).toHaveBeenCalledTimes(exitNotices);

        now += 10_000;
        emitRunning({ terminalId: 'cmd', processName: 'npm' });
        now += 1_000;
        emitCommandEnd('cmd', 0);

        expect(addToastMock).toHaveBeenCalledTimes(exitNotices);
      },
    );

    it('forgets the running snapshot after a suppressed user close', async () => {
      await renderHarness();
      subscribeFeed();
      emitRunning({ terminalId: 'cmd', processName: 'sleep' });
      now += 1_000;
      useTerminalActivityStore.getState().markUserInitiatedClose('cmd');
      emitExit({
        terminalId: 'cmd',
        exitCode: null,
        signal: TERMINAL_USER_CLOSE_SIGNAL,
      });

      now += 10_000;
      emitRunning({ terminalId: 'cmd', processName: 'npm' });
      now += 1_000;
      emitCommandEnd('cmd', 0);

      expect(addToastMock).not.toHaveBeenCalled();
    });

    it.each([
      ['an unknown idle before the exit', 'before'],
      ['a late unknown idle', 'late-null'],
      ['a late legacy idle', 'late-omitted'],
    ])(
      'reports only the terminal exit for a shell exit without a status mark (%s)',
      async (_label, idle) => {
        await renderHarness();
        emitRunning({ terminalId: 'cmd', processName: 'exit' });
        now += 4_000;
        if (idle === 'before') emitCommandEnd('cmd', null);
        emitExit({ terminalId: 'cmd', exitCode: 3, signal: null });
        if (idle === 'late-null') emitCommandEnd('cmd', null);
        if (idle === 'late-omitted') emitCommandEnd('cmd', undefined);

        expect(noticeMessages()).toEqual(['Terminal exited with code 3']);
      },
    );

    it('suppresses only the interrupted command when another command follows quickly', async () => {
      await renderHarness();
      emitRunning({ terminalId: 'cmd', processName: 'bash' });
      now += 5_000;
      emitCommandEnd('cmd', 130, { interruptedByUser: true });
      now += 100;
      emitRunning({ terminalId: 'cmd', processName: 'sh' });
      now += 2_999;
      emitCommandEnd('cmd', 0);
      expect(addToastMock).not.toHaveBeenCalled();

      now += 50;
      emitRunning({ terminalId: 'cmd', processName: 'make' });
      now += 3_000;
      emitCommandEnd('cmd', 1);

      expect(noticeMessages()).toEqual(['Command "make" failed (exit 1)']);
    });

    it('keeps terminals in one worktree independent', async () => {
      subscribeFeed();
      await renderHarness();
      emitRunning({ terminalId: 't1', processName: 'npm' });
      emitRunning({ terminalId: 't2', processName: 'sleep' });
      now += 4_000;
      emitExit({
        terminalId: 't2',
        exitCode: null,
        signal: TERMINAL_CONNECTION_LOST_SIGNAL,
      });
      emitCommandEnd('t1', 1);

      now += 1_000;
      emitRunning({ terminalId: 't2', processName: 'ls' });
      now += 500;
      emitCommandEnd('t2', 0);

      expect(addToastMock).toHaveBeenCalledTimes(1);
      expect(addToastMock).toHaveBeenCalledWith({
        terminalId: 't1',
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
        type: 'error',
        message: 'Command "npm" failed (exit 1)',
      });
    });
  });
});
