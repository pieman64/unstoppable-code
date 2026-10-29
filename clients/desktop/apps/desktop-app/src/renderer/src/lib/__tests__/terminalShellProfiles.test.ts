/**
 * @jest-environment jsdom
 */
import {
  __resetTerminalShellProfilesForTests,
  getCachedTerminalShellProfiles,
  loadTerminalShellProfiles,
  prefetchTerminalShellProfiles,
} from '@/lib/terminalShellProfiles';

/**
 * The add-panel menu is rebuilt on every open. Fetching profiles from its own
 * effect meant the first paint listed only "Terminal" and the real profiles
 * ("Terminal (bash)", …) arrived a beat later, shifting every row below them
 * while the user was already reading. These cases pin the caching that lets a
 * warm open paint the complete list immediately.
 */
describe('terminal shell profile cache', () => {
  const PROFILES = [
    { id: 'default', label: 'zsh', isDefault: true },
    { id: 'bash', label: 'bash', isDefault: false },
  ];

  function installTerminalApi(listProfiles: jest.Mock): void {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { terminal: { listProfiles } },
    });
  }

  beforeEach(() => {
    __resetTerminalShellProfilesForTests();
  });

  afterEach(() => {
    delete (window as typeof window & { api?: unknown }).api;
  });

  it('exposes nothing synchronously until the first load resolves', async () => {
    const listProfiles = jest.fn().mockResolvedValue(PROFILES);
    installTerminalApi(listProfiles);

    expect(getCachedTerminalShellProfiles()).toBeNull();
    await loadTerminalShellProfiles();
    expect(getCachedTerminalShellProfiles()).toEqual(PROFILES);
  });

  it('fetches once and reuses the result across opens', async () => {
    const listProfiles = jest.fn().mockResolvedValue(PROFILES);
    installTerminalApi(listProfiles);

    await Promise.all([
      loadTerminalShellProfiles(),
      loadTerminalShellProfiles(),
    ]);
    await loadTerminalShellProfiles();

    expect(listProfiles).toHaveBeenCalledTimes(1);
  });

  it('lets a prefetch warm the cache before the first menu open', async () => {
    const listProfiles = jest.fn().mockResolvedValue(PROFILES);
    installTerminalApi(listProfiles);

    prefetchTerminalShellProfiles();
    await loadTerminalShellProfiles();

    // The menu can now seed its state synchronously — no post-open shift.
    expect(getCachedTerminalShellProfiles()).toEqual(PROFILES);
    expect(listProfiles).toHaveBeenCalledTimes(1);
  });

  it('does not cache a failure, so a later open retries', async () => {
    const listProfiles = jest
      .fn()
      .mockRejectedValueOnce(new Error('no terminal service'))
      .mockResolvedValue(PROFILES);
    installTerminalApi(listProfiles);

    expect(await loadTerminalShellProfiles()).toEqual([]);
    expect(getCachedTerminalShellProfiles()).toBeNull();

    expect(await loadTerminalShellProfiles()).toEqual(PROFILES);
    expect(listProfiles).toHaveBeenCalledTimes(2);
  });

  it('resolves empty when the terminal API is unavailable', async () => {
    expect(await loadTerminalShellProfiles()).toEqual([]);
  });
});
