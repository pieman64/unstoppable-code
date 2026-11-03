/**
 * @jest-environment jsdom
 */
import type { BrowserSessionSnapshot } from '@canopy/desktop-shared/types';
import type { BrowserProfileRecord } from '@canopy/protocol/browser-profiles';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { BrowserProfilePicker } from '@/components/browser/BrowserProfilePicker';
import { useNavigationStore } from '@/stores/navigationStore';

// jsdom does not ship ResizeObserver; the popover measures itself with one.
class StubResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
  StubResizeObserver;

/** This tab is open on the named profile `p1`, which is also its new-tab default. */
const snapshot: BrowserSessionSnapshot = {
  id: 'browser-1',
  projectId: 'proj',
  worktreeId: 'wt',
  createdAt: 1,
  updatedAt: 2,
  url: 'about:blank',
  title: 'New tab',
  status: 'ready',
  canGoBack: false,
  canGoForward: false,
  loading: false,
  themeMode: 'light',
  pickMode: false,
  recording: false,
  profile: {
    selection: { kind: 'named', profileId: 'p1' },
    resolvedProfileId: 'p1',
    storageGeneration: 1,
    runtimeGeneration: 3,
    taskIncarnationId: 'inc',
  },
  profileInfo: {
    displayName: 'Work',
    color: '#0EA5E9',
    kind: 'named',
    agentPermissions: { allowEnable: true, allowClear: true },
    metadataRevision: 1,
  },
};

const namedProfile = (
  profileId: string,
  displayName: string,
): BrowserProfileRecord => ({
  schemaVersion: 1,
  profileId,
  kind: 'named',
  owner: { kind: 'user', localPrincipalId: 'u' },
  displayName,
  metadataRevision: 1,
  agentPermissions: { allowEnable: true, allowClear: true },
  lifecycle: 'active',
  storageGeneration: 1,
  createdAt: 1,
  updatedAt: 1,
});

function stubApi(
  profiles: BrowserProfileRecord[] = [namedProfile('p1', 'Work')],
): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      browser: {
        profiles: {
          list: jest.fn().mockResolvedValue({ profiles }),
          context: jest.fn().mockResolvedValue({
            incarnationId: 'inc',
            metadataRevision: 1,
            defaultSelection: { kind: 'named', profileId: 'p1' },
          }),
        },
      },
    },
  });
}

/**
 * Drive the controlled `<select>` the way a user would.
 *
 * Plain assignment is enough here: React's change plugin treats `select` as a
 * `shouldUseChangeEvent` node and reads the target directly, so it does not go
 * through the value tracker that makes `input` need a native setter.
 */
async function choose(select: HTMLSelectElement, value: string): Promise<void> {
  await act(() => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return Promise.resolve();
  });
}

const menuEl = (): HTMLElement | null =>
  document.body.querySelector('[data-testid="browser-profile-menu"]');
const inMenu = (testId: string): HTMLElement | null =>
  menuEl()?.querySelector(`[data-testid="${testId}"]`) ?? null;

async function openMenu(container: HTMLElement): Promise<HTMLElement> {
  const trigger = container.querySelector(
    '[data-testid="browser-profile-picker"]',
  ) as HTMLButtonElement;
  await act(() => {
    trigger.click();
    return Promise.resolve();
  });
  const menu = menuEl();
  if (!menu) throw new Error('menu did not open');
  return menu;
}

/**
 * Design-conformance coverage for the browser toolbar profile control.
 *
 * These assertions pin the regressions this surface shipped with: an invented
 * `z-popover` tier that emitted no z-index, a toolbar outline no sibling
 * control has, hand-rolled square buttons, and Unicode characters standing in
 * for icons. They also pin the native `<select>`, which the Playwright suite
 * drives with `selectOption`.
 */
describe('BrowserProfilePicker', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(async () => {
    stubApi();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(() => {
      root.render(<BrowserProfilePicker snapshot={snapshot} />);
      return Promise.resolve();
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    // The navigation store is a module singleton; the settings test would
    // otherwise leave it open for every sibling.
    act(() => useNavigationStore.getState().closeSettings());
  });

  it('renders a conformant trigger and popover, and dismisses on outside press', async () => {
    const trigger = container.querySelector(
      '[data-testid="browser-profile-picker"]',
    ) as HTMLButtonElement;
    expect(trigger.textContent).toContain('Work');
    expect(trigger.className).toContain('browser-bar-pick-button');
    expect(trigger.className).not.toContain('ring-line-base');

    const menu = await openMenu(container);
    // The shared Popover's floating layer, never an invented tier.
    expect(menu.className).toContain('canopy-floating-menu');
    expect(menu.className).not.toContain('z-popover');
    // Native select preserved for Playwright selectOption.
    expect(
      menu.querySelector('select[data-testid="browser-profile-selection"]'),
    ).toBeTruthy();
    // Close control is a real glyph button, not a text character.
    const close = menu.querySelector('button[aria-label="Close"]');
    expect(close?.querySelector('svg')).toBeTruthy();
    expect(menu.textContent).not.toContain('×');
    expect(menu.textContent).not.toContain('⌄');
    expect(menu.textContent).not.toContain('—');

    await act(() => {
      // jsdom has no PointerEvent constructor; the handler only reads
      // `event.target`, so a generic bubbling event exercises the same path.
      document.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      // Finish the press: the menu swallows the click that completes an
      // outside-dismiss press, so a later test's click is not eaten.
      document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return Promise.resolve();
    });
    expect(menuEl()).toBeNull();
  });

  it('leaves for the Browser settings page and closes behind itself', async () => {
    const menu = await openMenu(container);
    const link = menu.querySelector(
      '[data-testid="browser-profile-open-settings"]',
    ) as HTMLButtonElement;
    expect(link.textContent).toContain('Settings');
    // A real glyph, not a character standing in for one.
    expect(link.querySelector('svg')).toBeTruthy();

    await act(() => {
      link.click();
      return Promise.resolve();
    });
    const nav = useNavigationStore.getState();
    expect(nav.settingsOpen).toBe(true);
    expect(nav.settingsInitialSection).toBe('browser');
    // The popover must not survive the navigation; it is painted over the
    // native browser view and would outlive the surface it belongs to.
    expect(menuEl()).toBeNull();
  });

  it('offers no action while the selection matches what the tab already uses', async () => {
    await openMenu(container);
    // Opening resets the select to this tab's current profile, so every action
    // here would be a no-op: replacing reloads for nothing, and the profile is
    // already the new-tab default.
    expect(inMenu('browser-profile-replace')).toBeNull();
    expect(inMenu('browser-profile-new-tab')).toBeNull();
    expect(inMenu('browser-profile-set-default')).toBeNull();
  });

  it('reveals the switch and default actions once the selection differs', async () => {
    const menu = await openMenu(container);
    const select = menu.querySelector(
      'select[data-testid="browser-profile-selection"]',
    ) as HTMLSelectElement;
    expect(select.value).toBe('p1');

    await choose(select, 'task');

    const replace = inMenu('browser-profile-replace');
    expect(replace).not.toBeNull();
    expect(replace?.textContent).toBe('Replace this tab');
    // Shared pill primitive, not a hand-rolled square.
    expect(replace?.className).toContain('rounded-full');
    expect(replace?.className).toContain('bg-accent');
    expect(inMenu('browser-profile-new-tab')).not.toBeNull();
    expect(inMenu('browser-profile-set-default')).not.toBeNull();

    // Returning to the current profile withdraws them again.
    await choose(select, 'p1');
    expect(inMenu('browser-profile-replace')).toBeNull();
    expect(inMenu('browser-profile-set-default')).toBeNull();
  });
});

describe('BrowserProfilePicker while a switch is in flight', () => {
  let container: HTMLElement;
  let root: Root;

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const escape = async (): Promise<void> => {
    await act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
      return Promise.resolve();
    });
  };

  it('ignores Escape and outside presses until the switch settles', async () => {
    let settle: (() => void) | undefined;
    const switchProfile = jest.fn(
      () =>
        new Promise((resolve) => {
          settle = (): void =>
            resolve({ status: 'cancelled', browser: snapshot });
        }),
    );
    stubApi();
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        browser: { ...window.api.browser, switchProfile },
      },
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(() => {
      root.render(<BrowserProfilePicker snapshot={snapshot} />);
      return Promise.resolve();
    });
    const menu = await openMenu(container);
    await choose(
      menu.querySelector(
        'select[data-testid="browser-profile-selection"]',
      ) as HTMLSelectElement,
      'task',
    );
    await act(() => {
      inMenu('browser-profile-replace')?.click();
      return Promise.resolve();
    });
    expect(switchProfile).toHaveBeenCalledTimes(1);

    // Closing mid-switch would hide the progress and any error.
    await escape();
    expect(menuEl()).not.toBeNull();
    await act(() => {
      document.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return Promise.resolve();
    });
    expect(menuEl()).not.toBeNull();
    // An outside press must not swallow its click either: the page's
    // leave/stay prompt the notice points at has to stay answerable.
    const leave = document.createElement('button');
    const onLeave = jest.fn();
    leave.addEventListener('click', onLeave);
    document.body.appendChild(leave);
    await act(() => {
      for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click']) {
        leave.dispatchEvent(
          new MouseEvent(type, { bubbles: true, cancelable: true }),
        );
      }
      return Promise.resolve();
    });
    expect(onLeave).toHaveBeenCalledTimes(1);
    expect(menuEl()).not.toBeNull();
    leave.remove();

    await act(async () => {
      settle?.();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(menuEl()?.textContent).toContain('Profile switch cancelled');
    await escape();
    expect(menuEl()).toBeNull();
  });
});

/**
 * Nothing rejects a name a profile is already using, so two options really can
 * arrive with identical text. The name is the label; the id appears only where
 * it is the one thing telling two rows apart.
 */
describe('BrowserProfilePicker duplicate names', () => {
  let container: HTMLElement;
  let root: Root;

  const render = async (profiles: BrowserProfileRecord[]): Promise<void> => {
    stubApi(profiles);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(() => {
      root.render(<BrowserProfilePicker snapshot={snapshot} />);
      return Promise.resolve();
    });
    await openMenu(container);
  };

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const optionText = (value: string): string | undefined =>
    Array.from(menuEl()?.querySelectorAll('option') ?? []).find(
      (option) => option.value === value,
    )?.textContent ?? undefined;

  it('qualifies only the colliding names', async () => {
    await render([
      namedProfile('p1', 'Work'),
      namedProfile('p2ffffff', 'Work'),
      namedProfile('p3', 'Personal'),
    ]);
    expect(optionText('p1')).toBe('Work · p1');
    expect(optionText('p2ffffff')).toBe('Work · p2ffff');
    // Unique names stay clean — the id is not a standing suffix.
    expect(optionText('p3')).toBe('Personal');
  });

  it('treats case and surrounding space as the same name', async () => {
    await render([namedProfile('p1', 'Work'), namedProfile('p2', ' work ')]);
    expect(optionText('p1')).toBe('Work · p1');
    expect(optionText('p2')).toBe(' work  · p2');
  });

  it('leaves a lone name unqualified', async () => {
    await render([namedProfile('p1', 'Work')]);
    expect(optionText('p1')).toBe('Work');
  });
});
