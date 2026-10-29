/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { BROWSER_NATIVE_VIEW_OVERLAY_ATTRIBUTE } from '@/lib/browserNativeOverlay';
import { OpenDropdown } from '../OpenDropdown';

const mockOpenSettings = jest.fn();
const mockCopyTextToClipboard = jest.fn();
const detectApps = jest.fn();
const loadPreferences = jest.fn();
const openInApp = jest.fn();
const savePreferences = jest.fn();
const getWorktreePath = jest.fn();

jest.mock('@/stores/navigationStore', () => ({
  useNavigationStore: (
    selector: (state: { openSettings: typeof mockOpenSettings }) => unknown,
  ): unknown => selector({ openSettings: mockOpenSettings }),
}));

jest.mock('@/lib/clipboard', () => ({
  copyTextToClipboard: (text: string): void => {
    mockCopyTextToClipboard(text);
  },
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('OpenDropdown', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(async () => {
    Object.defineProperty(window, 'platform', {
      configurable: true,
      value: 'darwin',
    });
    detectApps.mockResolvedValue([
      { id: 'finder', name: 'Finder', icon: 'data:image/png;base64,AA==' },
      { id: 'cursor', name: 'Cursor', icon: null },
      { id: 'terminal', name: 'Terminal', icon: null },
    ]);
    loadPreferences.mockResolvedValue({
      lastOpenApp: 'finder',
      disabledOpenApps: ['cursor'],
    });
    openInApp.mockResolvedValue(undefined);
    savePreferences.mockResolvedValue(undefined);
    getWorktreePath.mockResolvedValue('/repo/worktree');
    (window as unknown as { api: unknown }).api = {
      detectApps,
      loadPreferences,
      openInApp,
      savePreferences,
      getWorktreePath,
    };
    container = document.createElement('div');
    document.body.appendChild(container);
    await act(async () => {
      root = createRoot(container);
      root.render(<OpenDropdown projectId="project" worktreeId="worktree" />);
      await Promise.resolve();
      await Promise.resolve();
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body
      .querySelectorAll('[data-testid="worktree-open-menu"]')
      .forEach((menu) => menu.remove());
    jest.clearAllMocks();
  });

  function trigger(): HTMLButtonElement {
    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="worktree-open-trigger"]',
    );
    if (!button) throw new Error('Open trigger not found');
    return button;
  }

  function openMenu(): HTMLElement {
    act(() => trigger().click());
    const menu = document.body.querySelector<HTMLElement>(
      '[data-testid="worktree-open-menu"]',
    );
    if (!menu) throw new Error('Open menu not found');
    return menu;
  }

  it('marks the open menu as blocking native browser content', () => {
    openMenu();

    expect(
      document.body.querySelector(
        `[${BROWSER_NATIVE_VIEW_OVERLAY_ATTRIBUTE}="true"]`,
      ),
    ).not.toBeNull();
  });

  it('filters unavailable apps and uses canonical fixed icon/text rails', () => {
    const menu = openMenu();
    expect(
      menu.querySelector('[data-testid="worktree-open-app-finder"]'),
    ).not.toBeNull();
    expect(
      menu.querySelector('[data-testid="worktree-open-app-terminal"]'),
    ).not.toBeNull();
    expect(
      menu.querySelector('[data-testid="worktree-open-app-cursor"]'),
    ).toBeNull();

    expect(menu.className).toContain('bg-quaternary');
    expect(menu.className).toContain('shadow-xl');
    // 136px: the measured natural width of the longest row plus insets —
    // the menu deliberately hugs its content instead of the old w-56.
    expect(menu.className).toContain('w-34');
    expect(menu.className).toContain('max-w-[calc(100vw-16px)]');
    const rows: HTMLElement[] = Array.from(
      menu.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    );
    for (const row of rows) {
      const icon = row.querySelector<HTMLElement>(':scope > span');
      // The label is no longer the last child — rows now end with the
      // selected-app checkmark slot — so find it by its truncation classes.
      const label = row.querySelector<HTMLElement>('.truncate');
      expect(row.className).toContain('h-8');
      expect(row.className).toContain('rounded-md');
      expect(row.className).toContain('text-xs');
      expect(icon?.className).toContain('h-4');
      expect(label?.className).toContain('whitespace-nowrap');
      expect(label?.className).toContain('truncate');
    }
  });

  it('invokes app, Copy path, and Settings actions through their existing APIs', async () => {
    openMenu();
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="worktree-open-app-terminal"]',
        )
        ?.click();
      await Promise.resolve();
    });
    expect(openInApp).toHaveBeenCalledWith({
      projectId: 'project',
      worktreeId: 'worktree',
      appId: 'terminal',
    });
    expect(savePreferences).toHaveBeenCalledWith({
      lastOpenApp: 'terminal',
    });
    expect(document.activeElement).toBe(trigger());

    openMenu();
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="worktree-open-copy-path"]',
        )
        ?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(getWorktreePath).toHaveBeenCalledWith({
      projectId: 'project',
      worktreeId: 'worktree',
    });
    expect(mockCopyTextToClipboard).toHaveBeenCalledWith('/repo/worktree');

    openMenu();
    act(() => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="worktree-open-settings"]',
        )
        ?.click();
    });
    expect(mockOpenSettings).toHaveBeenCalledWith('applications');
  });

  it('skips the divider during keyboard navigation and returns focus on Escape', () => {
    const menu = openMenu();
    act(() => {
      menu.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'End', bubbles: true }),
      );
    });
    expect(document.activeElement).toBe(
      document.querySelector('[data-testid="worktree-open-settings"]'),
    );

    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(
      document.querySelector('[data-testid="worktree-open-menu"]'),
    ).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });
});
