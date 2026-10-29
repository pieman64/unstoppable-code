/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  SettingsOperationError,
  type SettingsOperationName,
} from '@canopy/protocol/settings';
import type { PublicProfileSettings } from '@canopy/protocol/settings/account';
import { PublicProfileSection } from '../public-profile-section';
import {
  expectNoSettingsCardHeading,
  expectSettingsCardHeading,
  expectSettingsCardShell,
  expectSettingsCardSubtitle,
} from '@canopy/ui-shared/components/settings/__tests__/helpers/settings-card-assertions';
import {
  TestSettingsHost,
  createFakeSettingsClient,
  createTestSettingsHost,
  type FakeSettingsClient,
  type FakeSettingsHandler,
} from '../../__tests__/helpers/test-settings-host';

function settings(
  overrides: Partial<PublicProfileSettings> = {},
): PublicProfileSettings {
  return {
    username: 'ada',
    enabled: true,
    bio: null,
    links: [],
    showCost: true,
    showHeatmap: true,
    ...overrides,
  };
}

describe('PublicProfileSection', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useClient();
  });

  let client: FakeSettingsClient;

  // The Published work manager self-loads on mount; a benign failure keeps it
  // in its handled empty/error path without throwing.
  function useClient(
    handlers: Partial<Record<SettingsOperationName, FakeSettingsHandler>> = {},
  ): void {
    client = createFakeSettingsClient({
      'account.profile.artifacts.published': () => {
        throw new SettingsOperationError({ code: 'failed', status: 500 });
      },
      ...handlers,
    });
  }

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    jest.clearAllMocks();
  });

  async function render(initial: PublicProfileSettings | null): Promise<void> {
    const { host } = createTestSettingsHost({ client });
    act(() => {
      root.render(
        <TestSettingsHost host={host}>
          <PublicProfileSection
            initialSettings={initial}
            displayName="Ada Lovelace"
            avatarUrl={null}
          />
        </TestSettingsHost>,
      );
    });
    // Flush the manager's deferred setTimeout(0) load so its state settles.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await Promise.resolve();
    });
  }

  it('shows the empty state with a claim CTA when no username is claimed', async () => {
    await render(null);

    expect(
      container.querySelector('[data-testid="public-profile-empty-state"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="public-profile-username-claim"]')
        ?.textContent,
    ).toBe('Claim username');
    // The editor tiles must not render in the empty state.
    expect(
      container.querySelector('[data-testid="public-profile-show-cost"]'),
    ).toBeNull();
  });

  it('renders the editor with the claimed handle when a username exists', async () => {
    await render(settings({ username: 'ada' }));

    expect(
      container.querySelector('[data-testid="public-profile-empty-state"]'),
    ).toBeNull();
    // Compact header shows the handle, the publish toggle, and the view link.
    expect(container.textContent).toContain('@ada');
    expect(
      container.querySelector('[data-testid="public-profile-enabled-toggle"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="public-profile-view-link"]'),
    ).not.toBeNull();
    // Editor tiles are present.
    expect(
      container.querySelector('[data-testid="public-profile-show-cost"]'),
    ).not.toBeNull();
  });

  it('renders all three claimed-profile cards with the shared settings-card shell', async () => {
    await render(settings({ username: 'ada' }));

    for (const testId of [
      'public-profile-header-card',
      'public-profile-edit-card',
      'public-profile-featured-card',
    ]) {
      expectSettingsCardShell(container, testId);
    }

    // The card owns this heading; the manager inside it must not repeat it.
    expectSettingsCardHeading(container, 'Featured work');
  });

  it('names the cards for their contents, not for the tab they sit under', async () => {
    await render(settings({ username: 'ada' }));

    for (const title of ['Basic info', 'Shared content', 'Featured work']) {
      expectSettingsCardHeading(container, title);
    }
    // The page header above already says "Public profile"; repeating it as the
    // first card heading (or "Edit profile" as the second) says nothing.
    for (const title of ['Public profile', 'Edit profile']) {
      expectNoSettingsCardHeading(container, title);
    }
  });

  it('gives every claimed-profile card a subtitle', async () => {
    // A title alone leaves the reader to infer what the card covers, and these
    // three all hold different slices of the same profile.
    await render(settings({ username: 'ada' }));

    for (const testId of [
      'public-profile-header-card',
      'public-profile-edit-card',
      'public-profile-featured-card',
    ]) {
      expectSettingsCardSubtitle(container, testId);
    }
  });

  it('keeps the hero empty-state medallion large and free of heading-row offsets', async () => {
    await render(null);

    const medallion = container.querySelector(
      '[data-testid="public-profile-empty-state"] > span',
    );

    // A centred hero, not a card heading row: it keeps the larger 48px accent
    // disc rather than shrinking to the 36px card medallion.
    expect(medallion?.classList.contains('h-12')).toBe(true);
    expect(medallion?.classList.contains('w-12')).toBe(true);
    expect(medallion?.classList.contains('rounded-full')).toBe(true);
    expect(medallion?.classList.contains('bg-accent-subtle')).toBe(true);
    // And without the heading-row offsets, which would push it off centre
    // inside this centred column.
    expect(medallion?.classList.contains('mt-0.5')).toBe(false);
    expect(medallion?.classList.contains('shrink-0')).toBe(false);
  });

  it('hides the editor cards and view link while the profile is unpublished', async () => {
    await render(settings({ username: 'ada', enabled: false }));

    // The header card (handle + publish switch) stays; everything else goes.
    expect(
      container.querySelector('[data-testid="public-profile-enabled-toggle"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="public-profile-view-link"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="public-profile-show-cost"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="published-artifacts-manager"]'),
    ).toBeNull();
    expect(container.textContent).toContain('Your profile is hidden');
  });

  it('keeps the username claim collapsed until "Change username" is clicked', async () => {
    await render(settings({ username: 'ada' }));

    // Collapsed by default: no visible claim input.
    expect(
      container.querySelector('[data-testid="public-profile-username-input"]'),
    ).toBeNull();

    const change = container.querySelector<HTMLButtonElement>(
      '[data-testid="public-profile-change-username"]',
    );
    expect(change).not.toBeNull();
    act(() => {
      change?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(
      container.querySelector('[data-testid="public-profile-username-input"]'),
    ).not.toBeNull();
  });
  it('links the public page with a relative path the host routes', async () => {
    await render(settings({ username: 'ada' }));

    expect(
      container
        .querySelector('[data-testid="public-profile-view-link"]')
        ?.getAttribute('href'),
    ).toBe('/profile/ada');
  });

  it('saves the shared-content draft through the profile update', async () => {
    useClient({
      'account.profile.update': () => ({
        settings: settings({ username: 'ada', showCost: false }),
      }),
    });
    await render(settings({ username: 'ada' }));

    const toggle = container.querySelector<HTMLButtonElement>(
      '[data-testid="public-profile-show-cost"]',
    );
    act(() => {
      toggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="public-profile-save"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      client.calls.filter(
        (call) => call.operation === 'account.profile.update',
      ),
    ).toEqual([
      {
        operation: 'account.profile.update',
        input: { bio: null, links: [], showCost: false, showHeatmap: true },
      },
    ]);
    expect(container.textContent).toContain('Saved');
  });

  it('shows the taken-username copy when the update answers 409', async () => {
    useClient({
      'account.profile.update': () => {
        throw new SettingsOperationError({
          code: 'failed',
          status: 409,
          message: 'Conflict',
        });
      },
    });
    await render(settings({ username: 'ada' }));

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="public-profile-enabled-toggle"]',
        )
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'That username is already taken.',
    );
  });

  it('shows load copy for Featured work, never the route text, and Retry reloads it', async () => {
    let calls = 0;
    useClient({
      'account.profile.artifacts.published': () => {
        calls += 1;
        if (calls === 1)
          throw new SettingsOperationError({
            code: 'failed',
            status: 500,
            message: 'SENTINEL-SERVER-BODY',
          });
        return { items: [] };
      },
    });
    await render(settings({ username: 'ada' }));

    const manager = container.querySelector(
      '[data-testid="published-artifacts-manager"]',
    );
    expect(manager?.textContent).toContain("Couldn't load this. Try again.");
    expect(container.textContent).not.toContain('SENTINEL-SERVER-BODY');

    const retry = Array.from(manager?.querySelectorAll('button') ?? []).find(
      (button) => button.textContent === 'Retry',
    );
    await act(async () => {
      retry?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(calls).toBe(2);
    expect(manager?.textContent).not.toContain("Couldn't load this.");
    expect(
      container.querySelector('[data-testid="featured-work-empty"]'),
    ).not.toBeNull();
  });
});
