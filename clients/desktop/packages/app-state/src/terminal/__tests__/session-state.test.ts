import {
  TERMINAL_CANOPY_MANAGED_CLEANUP_SIGNAL,
  TERMINAL_CONNECTION_LOST_SIGNAL,
  TERMINAL_SANDBOX_ASLEEP_SIGNAL,
  TERMINAL_USER_CLOSE_SIGNAL,
  TERMINAL_WORKTREE_CLEANUP_SIGNAL,
} from '@canopy/protocol/terminal';
import {
  getTerminalListStateLabel,
  getTerminalReadOnlyMessage,
  isEnvironmentTerminalShutdown,
  isHiddenTerminalTabChipSignal,
  isTerminalRestartableSession,
  isTerminalRestorableSession,
} from '../terminal-session-state';

describe('terminal session state helpers', () => {
  it('treats app-restored terminals as read-only history', () => {
    const session = {
      live: false,
      exitCode: null,
      signal: 'app-quit',
    };

    expect(isTerminalRestorableSession(session)).toBe(true);
    expect(isTerminalRestartableSession(session)).toBe(true);
    expect(getTerminalListStateLabel(session)).toBe('history');
    expect(getTerminalReadOnlyMessage(session, 'Test App')).toBe(
      'Restored from a previous app session. Scrollback is preserved, but this shell is read-only. Restart the terminal to keep working.',
    );
  });

  it('keeps managed script terminals as history after app shutdown', () => {
    const session = {
      live: false,
      exitCode: null,
      signal: 'app-quit',
      kind: 'script' as const,
    };

    expect(isTerminalRestorableSession(session)).toBe(false);
    expect(isTerminalRestartableSession(session)).toBe(false);
  });

  it('reports exit codes for dead terminals', () => {
    const session = {
      live: false,
      exitCode: 143,
      signal: null,
    };

    expect(isTerminalRestorableSession(session)).toBe(false);
    expect(isTerminalRestartableSession(session)).toBe(true);
    expect(getTerminalListStateLabel(session)).toBe('exit 143');
    expect(getTerminalReadOnlyMessage(session, 'Test App')).toBe(
      'This terminal is read-only. The shell exited with code 143.',
    );
  });

  it('offers manual restart after a pipe failure without automatically respawning', () => {
    const session = { live: false, exitCode: null, signal: 'pipe-error' };
    expect(isTerminalRestartableSession(session)).toBe(true);
    expect(isTerminalRestorableSession(session)).toBe(false);
    expect(isTerminalRestartableSession({ ...session, kind: 'script' })).toBe(
      false,
    );
    expect(getTerminalReadOnlyMessage(session, 'Test App')).toBe(
      'The terminal connection closed unexpectedly. Restart the terminal to keep working.',
    );
  });

  it('treats signal 0 as no signal', () => {
    const session = {
      live: false,
      exitCode: 0,
      signal: '0',
    };

    expect(isTerminalRestorableSession(session)).toBe(false);
    expect(isTerminalRestartableSession(session)).toBe(true);
    expect(getTerminalListStateLabel(session)).toBe('exit 0');
    expect(getTerminalReadOnlyMessage(session, 'Test App')).toBe(
      'This terminal is read-only. The shell exited with code 0.',
    );
  });

  it('treats worktree cleanup as non-restorable history', () => {
    const session = {
      live: false,
      exitCode: 0,
      signal: TERMINAL_WORKTREE_CLEANUP_SIGNAL,
    };

    expect(isTerminalRestorableSession(session)).toBe(false);
    expect(isTerminalRestartableSession(session)).toBe(false);
    expect(getTerminalListStateLabel(session)).toBe('history');
    expect(getTerminalReadOnlyMessage(session, 'Test App')).toBe(
      'This terminal is read-only because worktree cleanup closed it.',
    );
  });

  it('treats Canopy-managed cleanup as non-restorable history', () => {
    const session = {
      live: false,
      exitCode: 0,
      signal: TERMINAL_CANOPY_MANAGED_CLEANUP_SIGNAL,
    };

    expect(isTerminalRestorableSession(session)).toBe(false);
    expect(isTerminalRestartableSession(session)).toBe(false);
    expect(getTerminalListStateLabel(session)).toBe('history');
    expect(getTerminalReadOnlyMessage(session, 'Test App')).toBe(
      'This terminal is read-only because Test App closed it.',
    );
  });

  it('returns no read-only state for live terminals', () => {
    const session = {
      live: true,
      exitCode: null,
      signal: null,
    };

    expect(isTerminalRestorableSession(session)).toBe(false);
    expect(isTerminalRestartableSession(session)).toBe(false);
    expect(getTerminalListStateLabel(session)).toBeNull();
    expect(getTerminalReadOnlyMessage(session, 'Test App')).toBeNull();
  });
});

describe('cloud terminal recovery', () => {
  it.each([
    [
      'connection-lost',
      'connection lost',
      'The terminal connection was lost, so the shell and anything running in it stopped. Restart the terminal to keep working.',
    ],
    [
      'sandbox-asleep',
      'project asleep',
      'Project is sleeping, so this shell stopped. Wake the project to keep working.',
    ],
  ])(
    'allows explicit recovery after %s without auto-restoring',
    (signal, label, message) => {
      const session = { live: false, exitCode: null, signal };
      expect(isTerminalRestartableSession(session)).toBe(true);
      expect(isTerminalRestorableSession(session)).toBe(false);
      expect(getTerminalListStateLabel(session)).toBe(label);
      expect(getTerminalReadOnlyMessage(session, 'Test App')).toBe(message);
      expect(isTerminalRestartableSession({ ...session, kind: 'script' })).toBe(
        false,
      );
    },
  );
});

describe('isHiddenTerminalTabChipSignal (REG-2987 web tab-chip policy)', () => {
  it.each([
    TERMINAL_CONNECTION_LOST_SIGNAL,
    TERMINAL_SANDBOX_ASLEEP_SIGNAL,
    'pipe-error',
  ])('hides the transport/sleep chip for signal %s', (signal) => {
    expect(isHiddenTerminalTabChipSignal(signal)).toBe(true);
  });

  it.each([
    null,
    '0',
    'SIGTERM',
    'app-quit',
    TERMINAL_USER_CLOSE_SIGNAL,
    TERMINAL_WORKTREE_CLEANUP_SIGNAL,
    TERMINAL_CANOPY_MANAGED_CLEANUP_SIGNAL,
  ])('keeps the chip for signal %s (exit/history/closed policy)', (signal) => {
    expect(isHiddenTerminalTabChipSignal(signal)).toBe(false);
  });

  it('never matches on the translated label string', () => {
    // Regression guard: the policy must gate on the raw signal constant, not
    // on `getTerminalListStateLabel`'s translated copy. A copy change to
    // these labels must not silently change which chips are hidden.
    expect(isHiddenTerminalTabChipSignal('connection lost')).toBe(false);
    expect(isHiddenTerminalTabChipSignal('project asleep')).toBe(false);
  });
});

describe('isEnvironmentTerminalShutdown', () => {
  it.each([TERMINAL_CONNECTION_LOST_SIGNAL, TERMINAL_SANDBOX_ASLEEP_SIGNAL])(
    'treats %s as an environment shutdown',
    (signal) => {
      expect(isEnvironmentTerminalShutdown(signal)).toBe(true);
    },
  );

  it.each([
    null,
    '0',
    'SIGTERM',
    'pipe-error',
    'app-quit',
    TERMINAL_USER_CLOSE_SIGNAL,
    TERMINAL_WORKTREE_CLEANUP_SIGNAL,
    TERMINAL_CANOPY_MANAGED_CLEANUP_SIGNAL,
  ])('does not treat %s as an environment shutdown', (signal) => {
    expect(isEnvironmentTerminalShutdown(signal)).toBe(false);
  });
});
