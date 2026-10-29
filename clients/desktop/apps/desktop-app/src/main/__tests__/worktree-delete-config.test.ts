import { brandEnvName } from '@canopy/desktop-shared/brand/env';
import {
  DEFAULT_WORKTREE_DELETE_TIMEOUT_MS,
  getWorktreeDeleteTimeoutMs,
} from '../lib/worktree-delete-config';

describe('worktree delete timeout config', () => {
  const timeoutEnvName = brandEnvName('WORKTREE_DELETE_TIMEOUT_MS');

  it('defaults worktree deletion to five minutes', () => {
    expect(getWorktreeDeleteTimeoutMs({})).toBe(5 * 60_000);
    expect(DEFAULT_WORKTREE_DELETE_TIMEOUT_MS).toBe(5 * 60_000);
  });

  it('accepts a branded millisecond override', () => {
    expect(getWorktreeDeleteTimeoutMs({ [timeoutEnvName]: '420000' })).toBe(
      420_000,
    );
  });

  it.each(['', '999', '1.5', 'not-a-number', '3600001'])(
    'falls back for invalid override %p',
    (value) => {
      expect(getWorktreeDeleteTimeoutMs({ [timeoutEnvName]: value })).toBe(
        DEFAULT_WORKTREE_DELETE_TIMEOUT_MS,
      );
    },
  );
});
