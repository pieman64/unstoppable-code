import {
  TERMINAL_CANOPY_MANAGED_CLEANUP_SIGNAL,
  TERMINAL_CONNECTION_LOST_SIGNAL,
  TERMINAL_SANDBOX_ASLEEP_SIGNAL,
  TERMINAL_CUSTOM_NAME_MAX_LENGTH,
  TERMINAL_PERSISTED_SCROLLBACK_MAX_LINES,
  TERMINAL_USER_CLOSE_SIGNAL,
  TERMINAL_WORKTREE_CLEANUP_SIGNAL,
} from '../terminal';

describe('terminal protocol compatibility constants', () => {
  it('preserves cleanup signal values', () => {
    expect(TERMINAL_WORKTREE_CLEANUP_SIGNAL).toBe('worktree-cleanup');
    expect(TERMINAL_CANOPY_MANAGED_CLEANUP_SIGNAL).toBe('app-managed-cleanup');
    expect(TERMINAL_USER_CLOSE_SIGNAL).toBe('user-close');
  });

  it('preserves persisted terminal limits', () => {
    expect(TERMINAL_CUSTOM_NAME_MAX_LENGTH).toBe(64);
    expect(TERMINAL_PERSISTED_SCROLLBACK_MAX_LINES).toBe(5000);
  });
});

it('names cloud recovery signals separately from pipe failures', () => {
  expect(TERMINAL_CONNECTION_LOST_SIGNAL).toBe('connection-lost');
  expect(TERMINAL_SANDBOX_ASLEEP_SIGNAL).toBe('sandbox-asleep');
});
