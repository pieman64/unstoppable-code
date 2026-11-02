/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  CloudDigestPreferences,
  CloudDigestPreferencesState,
} from '@canopy/desktop-shared/types';
import { CloudDigestSettings } from '../CloudDigestSettings';
import {
  chooseSettingsOption,
  settingsSelectTrigger,
  settingsSelectValue,
} from '@canopy/ui-app/settings/__tests__/helpers/settings-select';

const WEEKLY_ONLY: CloudDigestPreferences = {
  daily: false,
  weekly: true,
  monthly: false,
  weeklyAnchorDay: 1,
  monthlyAnchorDay: 1,
};

function anchor(field: string): HTMLButtonElement {
  return settingsSelectTrigger(
    container,
    `[data-testid="cloud-digest-anchor-${field}"]`,
  );
}

interface ApiMocks {
  loadCloudDigestPreferences: jest.Mock<Promise<CloudDigestPreferencesState>>;
  saveCloudDigestPreferences: jest.Mock<Promise<CloudDigestPreferencesState>>;
  openAuthenticatedPortalPage: jest.Mock<Promise<boolean>>;
}

let api: ApiMocks;
let container: HTMLElement;
let root: Root;

function installApi(mocks: ApiMocks): void {
  Object.defineProperty(window, 'api', {
    value: mocks,
    configurable: true,
    writable: true,
  });
}

async function render(): Promise<void> {
  await act(async () => {
    root.render(<CloudDigestSettings />);
    // Two microtask turns: one for the load promise, one for the state commit.
    await Promise.resolve();
    await Promise.resolve();
  });
}

function section(): HTMLElement | null {
  return container.querySelector<HTMLElement>(
    '[data-testid="settings-cloud-digests"]',
  );
}

function findToggle(field: string): HTMLButtonElement | null {
  const node = container.querySelector(
    `[data-testid="cloud-digest-toggle-${field}"]`,
  );
  return node instanceof HTMLButtonElement ? node : null;
}

/** The cadence switch (`role="switch"`), which must be present. */
function toggle(field: string): HTMLButtonElement {
  const node = findToggle(field);
  if (!node || node.getAttribute('role') !== 'switch') {
    throw new Error(`Missing toggle for ${field}`);
  }
  return node;
}

function isOn(field: string): boolean {
  return toggle(field).getAttribute('aria-checked') === 'true';
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  api = {
    loadCloudDigestPreferences: jest.fn(() =>
      Promise.resolve({
        available: true,
        resolved: true,
        preferences: WEEKLY_ONLY,
      }),
    ),
    saveCloudDigestPreferences: jest.fn(() =>
      Promise.resolve({
        available: true,
        resolved: true,
        preferences: WEEKLY_ONLY,
      }),
    ),
    openAuthenticatedPortalPage: jest.fn(() => Promise.resolve(true)),
  };
  installApi(api);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('CloudDigestSettings', () => {
  it('renders the account cadences the server reported', async () => {
    await render();

    expect(section()).not.toBeNull();
    expect(isOn('daily')).toBe(false);
    expect(isOn('weekly')).toBe(true);
    expect(isOn('monthly')).toBe(false);
  });

  it('renders nothing when the surface is unavailable', async () => {
    // `available: false` is how the main process reports "no cloud account" AND
    // "digests flag is off" AND "server predates this route". All three must
    // hide the section rather than showing dead toggles.
    api.loadCloudDigestPreferences.mockResolvedValue({
      available: false,
      resolved: true,
      preferences: WEEKLY_ONLY,
    });

    await render();

    expect(section()).toBeNull();
  });

  it('sends the complete cadence object on a toggle', async () => {
    // The v1 route requires all three booleans; a diff-style payload 400s.
    api.saveCloudDigestPreferences.mockResolvedValue({
      available: true,
      resolved: true,
      preferences: {
        daily: true,
        weekly: true,
        monthly: false,
        weeklyAnchorDay: 1,
        monthlyAnchorDay: 1,
      },
    });

    await render();
    await act(async () => {
      toggle('daily').click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(api.saveCloudDigestPreferences).toHaveBeenCalledWith({
      daily: true,
      weekly: true,
      monthly: false,
      weeklyAnchorDay: 1,
      monthlyAnchorDay: 1,
    });
    expect(isOn('daily')).toBe(true);
  });

  it('adopts the server projection over the optimistic value', async () => {
    api.saveCloudDigestPreferences.mockResolvedValue({
      available: true,
      resolved: true,
      preferences: {
        daily: false,
        weekly: false,
        monthly: false,
        weeklyAnchorDay: 1,
        monthlyAnchorDay: 1,
      },
    });

    await render();
    await act(async () => {
      toggle('daily').click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(isOn('daily')).toBe(false);
    expect(isOn('weekly')).toBe(false);
  });

  it('reverts and surfaces an error when the save does not resolve', async () => {
    api.saveCloudDigestPreferences.mockResolvedValue({
      available: true,
      resolved: false,
      preferences: WEEKLY_ONLY,
    });

    await render();
    await act(async () => {
      toggle('monthly').click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(isOn('monthly')).toBe(false);
    expect(
      container.querySelector('[data-testid="cloud-digests-error"]')
        ?.textContent,
    ).toContain('Could not save digest settings.');
  });

  it('never writes placeholder defaults back when the load did not resolve', async () => {
    // `resolved: false` means the main process could not read the account's
    // real cadences (offline, 5xx, malformed body) and the `preferences` it
    // carries are placeholders. Toggling from those would PATCH weekly-on back
    // as if the user had chosen it, destroying whatever they actually had set.
    api.loadCloudDigestPreferences.mockResolvedValue({
      available: true,
      resolved: false,
      preferences: WEEKLY_ONLY,
    });

    await render();

    // The section stays visible with an error -- unresolved is not "unavailable".
    expect(section()).not.toBeNull();
    expect(
      container.querySelector('[data-testid="cloud-digests-error"]')
        ?.textContent,
    ).toContain('Could not load digest settings.');

    // No switch is offered at all, so there is nothing to flip.
    expect(findToggle('daily')).toBeNull();
    expect(api.saveCloudDigestPreferences).not.toHaveBeenCalled();
  });

  it('hides the section when a save reports the surface is gone', async () => {
    // `available: false` has one meaning by contract -- the surface does not
    // exist for this account. A save can produce it too (flag flipped off, or
    // the API key revoked mid-session), and it must hide the section rather
    // than strand toggles that can never succeed again.
    api.saveCloudDigestPreferences.mockResolvedValue({
      available: false,
      resolved: true,
      preferences: WEEKLY_ONLY,
    });

    await render();
    expect(section()).not.toBeNull();
    await act(async () => {
      toggle('monthly').click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(section()).toBeNull();
  });

  it('opens the web digest archive through the authenticated portal', async () => {
    await render();
    const link = container.querySelector(
      '[data-testid="cloud-digests-view-link"]',
    );
    if (!(link instanceof HTMLButtonElement)) {
      throw new Error('Missing view-digests control');
    }
    await act(async () => {
      link.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(api.openAuthenticatedPortalPage).toHaveBeenCalledWith(
      '/account/digests',
    );
  });

  // `openAuthenticatedPortalPage` returns false rather than throwing on every
  // realistic failure (it degrades to openUnauthenticated, which swallows its
  // own error and returns false when the base URL is unconfigured). Ignoring
  // the boolean made the button silently do nothing.
  it('surfaces a failure to open the browser instead of doing nothing', async () => {
    api.openAuthenticatedPortalPage.mockResolvedValue(false);

    await render();
    const link = container.querySelector(
      '[data-testid="cloud-digests-view-link"]',
    );
    if (!(link instanceof HTMLButtonElement)) {
      throw new Error('Missing view-digests control');
    }
    await act(async () => {
      link.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      container.querySelector('[data-testid="cloud-digests-error"]')
        ?.textContent,
    ).toContain('Could not open digests in your browser.');
  });

  it('does not leave an unhandled rejection when the IPC bridge is missing', async () => {
    api.openAuthenticatedPortalPage.mockRejectedValue(new Error('no bridge'));

    await render();
    const link = container.querySelector(
      '[data-testid="cloud-digests-view-link"]',
    );
    if (!(link instanceof HTMLButtonElement)) {
      throw new Error('Missing view-digests control');
    }
    await act(async () => {
      link.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      container.querySelector('[data-testid="cloud-digests-error"]')
        ?.textContent,
    ).toContain('Could not open digests in your browser.');
  });

  // The main process returns `resolved: false` specifically so that "every
  // cadence off" is never asserted. The renderer must not undo that by painting
  // the placeholder defaults as if they were the account's real setting: a user
  // whose account has weekly OFF would otherwise see "Weekly" checked directly
  // above "Could not load digest settings."
  // A switch can only say on or off, so an unresolved cadence shows no switch
  // at all rather than an on/off claim about a value that was never read.
  it('shows no cadence value rather than placeholder values when unresolved', async () => {
    api.loadCloudDigestPreferences.mockResolvedValue({
      available: true,
      resolved: false,
      preferences: WEEKLY_ONLY,
    });

    await render();

    for (const field of ['daily', 'weekly', 'monthly']) {
      expect(findToggle(field)).toBeNull();
    }
    // A bar holds each cadence's description. The load failed, so nothing
    // claims to be loading and no loading copy shows.
    expect(section()?.querySelectorAll('.canopy-inline-skeleton')).toHaveLength(
      3,
    );
    expect(section()?.querySelector('[role="status"]')).toBeNull();
    expect(section()?.textContent).not.toContain('Loading');
  });

  it('marks the cadences as loading only while a retry is in flight', async () => {
    api.loadCloudDigestPreferences.mockResolvedValueOnce({
      available: true,
      resolved: false,
      preferences: WEEKLY_ONLY,
    });

    await render();
    const retry = container.querySelector(
      '[data-testid="cloud-digests-retry"]',
    );
    if (!(retry instanceof HTMLButtonElement)) {
      throw new Error('Missing retry control');
    }

    api.loadCloudDigestPreferences.mockReturnValue(
      new Promise<never>(() => undefined),
    );
    await act(async () => {
      retry.click();
      await Promise.resolve();
    });

    expect(section()?.querySelectorAll('[role="status"]')).toHaveLength(3);
    expect(findToggle('daily')).toBeNull();
  });

  it('offers a retry that recovers from an unresolved load', async () => {
    api.loadCloudDigestPreferences.mockResolvedValueOnce({
      available: true,
      resolved: false,
      preferences: WEEKLY_ONLY,
    });

    await render();
    const retry = container.querySelector(
      '[data-testid="cloud-digests-retry"]',
    );
    if (!(retry instanceof HTMLButtonElement)) {
      throw new Error('Missing retry control');
    }

    // Second read succeeds with the account's real cadences.
    api.loadCloudDigestPreferences.mockResolvedValue({
      available: true,
      resolved: true,
      preferences: {
        daily: true,
        weekly: false,
        monthly: false,
        weeklyAnchorDay: 1,
        monthlyAnchorDay: 1,
      },
    });
    await act(async () => {
      retry.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(isOn('daily')).toBe(true);
    expect(isOn('weekly')).toBe(false);
    expect(
      container.querySelector('[data-testid="cloud-digests-error"]'),
    ).toBeNull();
  });

  it('describes each cadence from the account anchors, not a hardcoded Monday', async () => {
    api.loadCloudDigestPreferences.mockResolvedValue({
      available: true,
      resolved: true,
      preferences: {
        daily: false,
        weekly: true,
        monthly: true,
        weeklyAnchorDay: 4,
        monthlyAnchorDay: 12,
      },
    });

    await render();

    expect(settingsSelectValue(anchor('weekly'))).toBe('4');
    expect(settingsSelectValue(anchor('monthly'))).toBe('12');
    const text = section()?.textContent ?? '';
    expect(text).toContain('Every Thursday, covering the previous week.');
    expect(text).toContain(
      'On the 12th, covering the previous calendar month.',
    );
  });

  it('saves the complete object when an anchor changes', async () => {
    await render();

    await chooseSettingsOption(anchor('weekly'), '5');
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // Anchors ride with the cadences: the route rejects a partial body, and an
    // omitted anchor would be persisted as the default.
    expect(api.saveCloudDigestPreferences).toHaveBeenCalledWith({
      daily: false,
      weekly: true,
      monthly: false,
      weeklyAnchorDay: 5,
      monthlyAnchorDay: 1,
    });
  });

  // The day picker sits inside its cadence's row, so it stays visible while
  // that cadence is off but cannot be changed until the cadence is on.
  it('disables a day picker while its cadence is off', async () => {
    await render();

    expect(anchor('weekly').disabled).toBe(false);
    expect(anchor('monthly').disabled).toBe(true);

    api.saveCloudDigestPreferences.mockResolvedValue({
      available: true,
      resolved: true,
      preferences: { ...WEEKLY_ONLY, monthly: true },
    });
    await act(async () => {
      toggle('monthly').click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(anchor('monthly').disabled).toBe(false);
  });

  it('never writes an anchor from an unresolved read', async () => {
    // The placeholder anchors are not the account's; persisting them would
    // silently rewrite a schedule we failed to load.
    api.loadCloudDigestPreferences.mockResolvedValue({
      available: true,
      resolved: false,
      preferences: WEEKLY_ONLY,
    });

    await render();

    expect(anchor('weekly').disabled).toBe(true);
    expect(section()?.textContent).not.toContain('Loading');
    expect(api.saveCloudDigestPreferences).not.toHaveBeenCalled();
  });
});
