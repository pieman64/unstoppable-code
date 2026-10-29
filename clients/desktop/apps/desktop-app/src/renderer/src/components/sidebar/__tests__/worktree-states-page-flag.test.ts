/**
 * @jest-environment jsdom
 */
import {
  WORKTREE_STATES_PAGE_STORAGE_KEY,
  isWorktreeStatesPageEnabled,
} from '../worktree-states-page-flag';

interface DevInfoWindow {
  devInfo?: { isDev: boolean };
}

const devInfoWindow: DevInfoWindow = window;

describe('isWorktreeStatesPageEnabled', () => {
  afterEach(() => {
    delete devInfoWindow.devInfo;
    window.localStorage.clear();
  });

  it('is disabled in dev builds without the opt-in flag', () => {
    devInfoWindow.devInfo = { isDev: true };
    expect(isWorktreeStatesPageEnabled()).toBe(false);
  });

  it('is enabled in dev builds when the opt-in flag is set', () => {
    devInfoWindow.devInfo = { isDev: true };
    window.localStorage.setItem(WORKTREE_STATES_PAGE_STORAGE_KEY, '1');
    expect(isWorktreeStatesPageEnabled()).toBe(true);
  });

  it('stays disabled outside dev builds even with the flag set', () => {
    window.localStorage.setItem(WORKTREE_STATES_PAGE_STORAGE_KEY, '1');
    expect(isWorktreeStatesPageEnabled()).toBe(false);
  });
});
