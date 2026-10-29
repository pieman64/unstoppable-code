/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { TestSettingsHost } from '../../__tests__/helpers/test-settings-host';
import { TeamLapsedState } from '../team-lapsed-state';

describe('TeamLapsedState (CAN-2311)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(
    props: Partial<ComponentProps<typeof TeamLapsedState>> = {},
  ): void {
    act(() => {
      root.render(
        <TestSettingsHost>
          <TeamLapsedState
            orgId="org-123"
            orgName="Acme"
            trialEndedAt="2026-05-01T00:00:00.000Z"
            lapseReason="trial_ended"
            requiredPlanName="Business"
            canEdit
            {...props}
          />
        </TestSettingsHost>,
      );
    });
  }

  it('names the org in the title so a multi-org viewer knows which one is on hold', () => {
    render();
    expect(container.textContent).toContain('Acme is on hold');
  });

  it('gives an owner/admin the ended date, the plan to buy, and a billing CTA', () => {
    render({ canEdit: true });

    expect(container.textContent).toContain('Your trial ended on');
    expect(container.textContent).toContain(
      'Subscribe to Business to restore your team.',
    );

    const cta = container.querySelector<HTMLAnchorElement>(
      '[data-testid="team-lapsed-billing-cta"]',
    );
    expect(cta).not.toBeNull();
    expect(cta?.getAttribute('href')).toBe(
      '/organization/org-123/settings?tab=billing',
    );
  });

  it('points a member at an administrator and renders NO payment CTA', () => {
    render({ canEdit: false });

    expect(container.textContent).toContain(
      'Ask an organization administrator to subscribe',
    );
    // A member is 404'd from the billing page, so offering the link would
    // dead-end them.
    expect(
      container.querySelector('[data-testid="team-lapsed-billing-cta"]'),
    ).toBeNull();
  });

  it('falls back to date-free copy rather than printing a null date', () => {
    render({ trialEndedAt: null });

    expect(container.textContent).toContain('Your trial has ended.');
    expect(container.textContent).not.toContain('null');
  });

  it('falls back to plan-free copy when no seeded plan grants `teams`', () => {
    render({ requiredPlanName: null });

    expect(container.textContent).toContain('Subscribe to restore your team.');
    expect(container.textContent).not.toContain('null');
  });

  // The lapse cause drives the copy, NOT `trialEndedAt`. A paying org's trial
  // also ended — telling a past-due customer to buy the plan they already own,
  // above a date from a trial that finished before their subscription started,
  // was the failure these cover.
  describe('lapse cause drives the remedy (CAN-2311)', () => {
    it('tells a past-due org to fix the card, never to subscribe', () => {
      render({ lapseReason: 'payment_failed', canEdit: true });

      expect(container.textContent).toContain('Your last payment failed.');
      expect(container.textContent).toContain(
        'Update your payment method to restore your team.',
      );
      // The two things that were actively wrong for this customer.
      expect(container.textContent).not.toContain('trial');
      expect(container.textContent).not.toContain('Subscribe to Business');
    });

    it('does not print a stale trial date for a past-due org', () => {
      render({
        lapseReason: 'payment_failed',
        trialEndedAt: '2025-01-01T00:00:00.000Z',
      });

      expect(container.textContent).not.toContain('2025');
      expect(container.textContent).not.toContain('January');
    });

    it('routes a past-due member to the admin action that actually helps', () => {
      render({ lapseReason: 'payment_failed', canEdit: false });

      expect(container.textContent).toContain(
        'Ask an organization administrator to update the payment method',
      );
      expect(container.textContent).not.toContain('to subscribe');
    });

    it('tells a cancelled org its subscription ended, and to resubscribe', () => {
      render({ lapseReason: 'subscription_ended', canEdit: true });

      expect(container.textContent).toContain('Your subscription has ended.');
      expect(container.textContent).toContain(
        'Subscribe to Business to restore your team.',
      );
      expect(container.textContent).not.toContain('trial');
    });

    it('stays cause-free when the reason is unknown rather than inventing one', () => {
      render({ lapseReason: null, canEdit: true });

      expect(container.textContent).toContain(
        'Your plan no longer includes team features.',
      );
      expect(container.textContent).not.toContain('trial');
      expect(container.textContent).not.toContain('null');
    });
  });
});
