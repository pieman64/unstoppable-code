/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SettingsOperationError } from '@canopy/protocol/settings';
import type { OrganizationDetail } from '@canopy/protocol/settings/organization';
import {
  TestSettingsHost,
  createFakeSettingsClient,
  createTestSettingsHost,
  type FakeSettingsClient,
} from '../../../__tests__/helpers/test-settings-host';
import { TeamSubscriptionPricingSection } from '../team-subscription-pricing-section';

const SENTINEL = 'SENTINEL-SERVER-BODY';

const DETAIL: OrganizationDetail = {
  id: 'org-1',
  name: 'Acme',
  viewerRole: 'OWNER',
  members: [],
  subTeams: [],
  usageStatsMinRole: 'ADMIN',
  canViewUsageStats: true,
  logoUrl: null,
  githubConnection: { connected: false, accountLogin: null },
};

describe('TeamSubscriptionPricingSection errors', () => {
  let container: HTMLElement;
  let root: Root;
  let client: FakeSettingsClient;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function render(): Promise<void> {
    const { host } = createTestSettingsHost({ client });
    await act(async () => {
      root.render(
        <TestSettingsHost host={host}>
          <TeamSubscriptionPricingSection detail={DETAIL} />
        </TestSettingsHost>,
      );
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  it('shows load copy, never the route text, and Retry loads the plans', async () => {
    let calls = 0;
    client = createFakeSettingsClient({
      'organization.settings.subscriptionPricing': () => {
        calls += 1;
        if (calls === 1)
          throw new SettingsOperationError({
            code: 'failed',
            status: 500,
            message: SENTINEL,
          });
        return { plans: [], canEdit: false };
      },
    });
    await render();

    expect(container.textContent).toContain("Couldn't load this.");
    expect(container.textContent).not.toContain(SENTINEL);
    expect(
      container.querySelector('[data-testid="subscription-pricing-empty"]'),
    ).toBeNull();

    const retry = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Try again',
    );
    await act(async () => {
      retry?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(calls).toBe(2);
    expect(container.textContent).not.toContain("Couldn't load this.");
    expect(
      container.querySelector('[data-testid="subscription-pricing-empty"]'),
    ).not.toBeNull();
  });
});
