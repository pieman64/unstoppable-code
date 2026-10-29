/**
 * @jest-environment jsdom
 *
 * Early access: the browser's one-row address bar. History, the address
 * (only the host at rest), Pick, and a More menu holding every other tool;
 * states that must stay visible (a running recording, page errors) stay in
 * the row.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
  type BrowserSessionSnapshot,
} from '@canopy/desktop-shared/types';
import type { BrowserProfileRecord } from '@canopy/protocol/browser-profiles';
import { useBrowserStore } from '@/stores/browserStore';
import { BrowserAddressBar } from '../BrowserAddressBar';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const BROWSER_ID = 'b1';

function snapshot(
  overrides: Partial<BrowserSessionSnapshot> = {},
): BrowserSessionSnapshot {
  return {
    id: BROWSER_ID,
    projectId: 'p',
    worktreeId: 'w',
    createdAt: 1,
    updatedAt: 2,
    url: 'http://localhost:3000/settings/profile',
    title: 'Local',
    status: 'ready',
    canGoBack: true,
    canGoForward: false,
    loading: false,
    themeMode: 'light',
    pickMode: false,
    recording: false,
    ...overrides,
  };
}

let api: Record<string, jest.Mock>;
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    value: class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  });
  api = {
    navigate: jest.fn().mockResolvedValue(snapshot()),
    back: jest.fn().mockResolvedValue(snapshot()),
    setTheme: jest.fn().mockResolvedValue(snapshot({ themeMode: 'dark' })),
    setPickMode: jest.fn().mockResolvedValue(snapshot({ pickMode: true })),
    stopRecording: jest
      .fn()
      .mockResolvedValue({ browserId: BROWSER_ID, steps: [] }),
    openExternal: jest.fn().mockResolvedValue(undefined),
  };
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      browser: {
        ...api,
        profiles: {
          list: jest.fn().mockResolvedValue({ profiles: [] }),
          context: jest.fn().mockResolvedValue(undefined),
        },
      },
    },
  });
  useBrowserStore.setState({
    worktrees: {
      'p/w': {
        browserOrder: [BROWSER_ID],
        activeBrowserId: BROWSER_ID,
        browsers: { [BROWSER_ID]: snapshot() },
        live: new Set([BROWSER_ID]),
        hydrated: true,
      },
    },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
});

function render(
  overrides: Partial<BrowserSessionSnapshot> = {},
  props: { errorCount?: number; onToggleInspector?: () => void } = {},
): void {
  act(() => {
    root.render(
      <BrowserAddressBar
        browserId={BROWSER_ID}
        snapshot={snapshot(overrides)}
        inspectorOpen={false}
        errorCount={props.errorCount ?? 0}
        onToggleInspector={props.onToggleInspector ?? jest.fn()}
      />,
    );
  });
}

function q<T extends Element = HTMLElement>(selector: string): T | null {
  return document.querySelector<T>(selector);
}

function click(selector: string): void {
  const element = q(selector);
  if (!element) throw new Error(`Missing ${selector}`);
  act(() => element.click());
}

function openMenu(): void {
  click('[data-testid="browser-more"]');
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('BrowserAddressBar', () => {
  it('shows the host at rest and the full address to edit', async () => {
    render();
    const input = q<HTMLInputElement>('[data-testid="browser-url-input"]');
    expect(input?.value).toBe('localhost:3000');
    expect(input?.className).toContain('text-center');

    act(() => input?.focus());
    expect(input?.value).toBe('http://localhost:3000/settings/profile');
    expect(input?.className).not.toContain('text-center');

    act(() => {
      const descriptor = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      );
      descriptor?.set?.call(input, 'http://localhost:4000/');
      input?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => {
      input?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
    });
    await flush();
    expect(api.navigate).toHaveBeenCalledWith({
      browserId: BROWSER_ID,
      url: 'http://localhost:4000/',
    });
  });

  it('keeps history, Pick, and More in one row, in the shared button family', () => {
    render();
    for (const id of ['browser-back', 'browser-forward', 'browser-refresh']) {
      expect(q(`[data-testid="${id}"]`)?.dataset.headerActionButton).toBe(
        'true',
      );
    }
    expect(
      q<HTMLButtonElement>('[data-testid="browser-forward"]')?.disabled,
    ).toBe(true);
    click('[data-testid="browser-pick"]');
    expect(api.setPickMode).toHaveBeenCalledWith({
      browserId: BROWSER_ID,
      enabled: true,
    });
  });

  it('runs the rest of the tools from More', async () => {
    const onToggleInspector = jest.fn();
    render({}, { errorCount: 3, onToggleInspector });
    // Page errors put a dot on More; the count is in the menu.
    expect(q('[data-testid="browser-more-error-dot"]')).not.toBeNull();

    openMenu();
    const details = q('[data-testid="browser-more-details"]');
    expect(details?.textContent).toContain('3 errors');
    // The action-menu row look: small text and quiet tertiary icons.
    expect(details?.className).toContain('text-xs');
    expect(
      details?.querySelector('span[aria-hidden="true"]')?.className,
    ).toContain('fg-tertiary');
    // The page's theme sits under Appearance (System, Light, Dark), picked
    // with a checkmark, not a fill.
    click('[data-testid="browser-more-appearance"]');
    await flush();
    expect(q('[data-testid="browser-theme-system"]')?.textContent).toBe(
      'System',
    );
    expect(
      q('[data-testid="browser-theme-light"]')?.getAttribute('aria-checked'),
    ).toBe('true');
    click('[data-testid="browser-theme-dark"]');
    await flush();
    expect(api.setTheme).toHaveBeenCalledWith({
      browserId: BROWSER_ID,
      themeMode: 'dark',
    });

    openMenu();
    click('[data-testid="browser-more-details"]');
    expect(onToggleInspector).toHaveBeenCalledTimes(1);
  });

  it('lists the profiles to switch to, and Browser settings, under More', async () => {
    render();
    openMenu();
    await flush();
    expect(q('[data-testid="browser-more-profile"]')?.textContent).toContain(
      'Task',
    );
    click('[data-testid="browser-more-profile"]');
    await flush();
    const submenu = q('[data-testid="browser-profile-submenu"]');
    expect(submenu).not.toBeNull();
    // The profile in use is the checked one.
    expect(
      q('[data-testid="browser-profile-option-task"]')?.getAttribute(
        'aria-checked',
      ),
    ).toBe('true');
    expect(q('[data-testid="browser-profile-settings"]')?.textContent).toBe(
      'Browser settings',
    );
    // The picker's own chip does not render in the address bar.
    expect(q('[data-testid="browser-profile-picker"]')).toBeNull();
  });

  it('lists every page of profiles under More, not only the first', async () => {
    const named = (
      profileId: string,
      displayName: string,
    ): BrowserProfileRecord => ({
      schemaVersion: 1 as const,
      profileId,
      kind: 'named' as const,
      owner: { kind: 'user' as const, localPrincipalId: 'me' },
      displayName,
      metadataRevision: 1,
      agentPermissions: { allowEnable: true, allowClear: true },
      lifecycle: 'active' as const,
      storageGeneration: 1,
      createdAt: 1,
      updatedAt: 1,
    });
    const list = jest
      .fn()
      .mockResolvedValueOnce({ profiles: [named('a', 'Alpha')], nextOffset: 1 })
      .mockResolvedValueOnce({ profiles: [named('b', 'Beta')] });
    window.api.browser.profiles.list = list;
    render();
    openMenu();
    await flush();
    await flush();
    click('[data-testid="browser-more-profile"]');
    await flush();
    expect(q('[data-testid="browser-profile-option-a"]')).not.toBeNull();
    expect(q('[data-testid="browser-profile-option-b"]')).not.toBeNull();
    expect(list).toHaveBeenLastCalledWith({
      projectId: 'p',
      worktreeId: 'w',
      offset: 1,
    });
  });

  describe('a profile switch from More that needs attention', () => {
    const profile = {
      selection: { kind: 'task' as const },
      resolvedProfileId: 'task-profile',
      storageGeneration: 1,
      runtimeGeneration: 3,
      taskIncarnationId: 'i1',
    };
    const named = {
      schemaVersion: 1 as const,
      profileId: 'work',
      kind: 'named' as const,
      owner: { kind: 'user' as const, localPrincipalId: 'me' },
      displayName: 'Work',
      metadataRevision: 1,
      agentPermissions: { allowEnable: true, allowClear: true },
      lifecycle: 'active' as const,
      storageGeneration: 1,
      createdAt: 1,
      updatedAt: 1,
    };

    async function switchToWork(switchProfile: jest.Mock): Promise<void> {
      window.api.browser.profiles.list = jest
        .fn()
        .mockResolvedValue({ profiles: [named] });
      window.api.browser.switchProfile = switchProfile;
      render({ profile });
      openMenu();
      await flush();
      click('[data-testid="browser-more-profile"]');
      await flush();
      click('[data-testid="browser-profile-option-work"]');
      await flush();
      await flush();
      await flush();
    }

    it('shows the message main returned in the picker', async () => {
      await switchToWork(
        jest.fn().mockResolvedValue({
          status: 'failed',
          message:
            'The original profile was reloaded; unsaved page changes were lost.',
          browser: snapshot({ profile }),
        }),
      );
      expect(q('[data-testid="browser-profile-menu"]')?.textContent).toContain(
        'The original profile was reloaded; unsaved page changes were lost.',
      );
    });

    it('says a cancelled switch left the original page open', async () => {
      await switchToWork(
        jest.fn().mockResolvedValue({
          status: 'cancelled',
          browser: snapshot({ profile }),
        }),
      );
      expect(q('[data-testid="browser-profile-menu"]')?.textContent).toContain(
        'Profile switch cancelled. The original page is still open.',
      );
    });

    it('shows why a rejected switch failed', async () => {
      await switchToWork(
        jest.fn().mockRejectedValue(new Error('Runtime generation is stale.')),
      );
      expect(q('[data-testid="browser-profile-menu"]')?.textContent).toContain(
        'Runtime generation is stale.',
      );
    });
  });

  it('keeps a running recording stoppable from the row', async () => {
    render({ recording: true });
    click('[data-testid="browser-stop-recording"]');
    await flush();
    expect(api.stopRecording).toHaveBeenCalledWith({ browserId: BROWSER_ID });
  });

  describe('Open in external browser', () => {
    const FILE_URL = 'file:///Users/me/site/index.html';

    function openExternalItem(): HTMLButtonElement | null {
      openMenu();
      return q<HTMLButtonElement>('[data-testid="browser-more-open-external"]');
    }

    it('opens a local file page in the default web browser', () => {
      render({ url: FILE_URL });
      const item = openExternalItem();
      expect(item?.disabled).toBe(false);
      click('[data-testid="browser-more-open-external"]');
      expect(api.openExternal).toHaveBeenCalledWith({
        url: FILE_URL,
        browserId: BROWSER_ID,
      });
    });

    it('stays disabled on a blank tab', () => {
      render({ url: '' });
      expect(openExternalItem()?.disabled).toBe(true);
    });

    it('stays disabled on a viewer-scope file page', () => {
      render({ projectId: SHARED_CONTAINER_VIEWER_PROJECT_ID, url: FILE_URL });
      expect(openExternalItem()?.disabled).toBe(true);
    });

    it('opens an http page with the tab id', () => {
      render();
      expect(openExternalItem()?.disabled).toBe(false);
      click('[data-testid="browser-more-open-external"]');
      expect(api.openExternal).toHaveBeenCalledWith({
        url: 'http://localhost:3000/settings/profile',
        browserId: BROWSER_ID,
      });
    });
  });

  it('keeps profiles and automation tools off private sign-in pages', () => {
    render({ projectId: 'app-oauth', worktreeId: 'mcp' });
    expect(q('[data-testid="browser-pick"]')).toBeNull();
    expect(q('[data-testid="browser-files-button"]')).toBeNull();
    openMenu();
    expect(q('[data-testid="browser-more-profile"]')).toBeNull();
    expect(q('[data-testid="browser-more-record"]')).toBeNull();
    expect(q('[data-testid="browser-more-screenshot"]')).toBeNull();
    expect(q('[data-testid="browser-more-details"]')).toBeNull();
    expect(q('[data-testid="browser-more-appearance"]')).not.toBeNull();
  });
});
