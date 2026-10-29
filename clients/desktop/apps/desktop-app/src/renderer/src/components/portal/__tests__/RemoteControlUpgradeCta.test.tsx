/**
 * @jest-environment jsdom
 */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { REMOTE_CONTROL_LABEL } from '@canopy/protocol';
import { RemoteControlUpgradeCta } from '../RemoteControlUpgradeCta';

interface RenderOptions {
  lapsedOrgNames?: readonly string[];
  manageableLapsedOrg?: { id: string; name: string } | null;
  planDisplayName?: string | null;
}

describe('RemoteControlUpgradeCta lapsed-org copy (CAN-2311, CAN-2590)', () => {
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

  function render(options: RenderOptions = {}): void {
    act(() => {
      root.render(
        <RemoteControlUpgradeCta onUpgrade={(): void => {}} {...options} />,
      );
    });
  }

  function lapsedCopy(): HTMLElement | null {
    return container.querySelector<HTMLElement>(
      '[data-testid="canopy-portal-upgrade-cta-lapsed-copy"]',
    );
  }

  function button(): HTMLElement | null {
    return container.querySelector<HTMLElement>(
      '[data-testid="canopy-portal-upgrade-cta-button"]',
    );
  }

  it('keeps the original upsell copy when nothing has lapsed', () => {
    render();

    expect(lapsedCopy()).toBeNull();
    expect(container.textContent).toContain(
      `${REMOTE_CONTROL_LABEL} is included with the Pro and Business plans.`,
    );
    expect(button()?.textContent).toBe('Upgrade to unlock');
  });

  it('renders the CTA at the modal primary weight', () => {
    // Same reasoning as the guest CTA: this is the only action in the state it
    // appears in, so it cannot read as the account-tile `bg-secondary` fill next
    // to the modal's accent-filled Sign in / Enable buttons.
    render();

    expect(button()?.className).toContain('bg-accent');
    expect(button()?.className).toContain('fg-emphasis');
    expect(button()?.className).not.toContain('bg-secondary');
  });

  it('treats an empty list as not lapsed', () => {
    render({ lapsedOrgNames: [] });

    expect(lapsedCopy()).toBeNull();
    expect(button()?.textContent).toBe('Upgrade to unlock');
  });

  describe('owner/admin of the lapsed org', () => {
    const manageableLapsedOrg = { id: 'org_1', name: 'Unstoppable Domains' };

    it('leads with what unlocks the feature and ends on one action', () => {
      // Three beats in the order the reader needs them: what unlocks it, why
      // the org is not that route, what to do. The org status is a subordinate
      // clause rather than the opener.
      render({
        lapsedOrgNames: ['Unstoppable Domains'],
        manageableLapsedOrg,
        planDisplayName: 'Pro',
      });

      expect(lapsedCopy()?.textContent).toBe(
        'This feature requires Pro, and Unstoppable Domains has no active plan to cover it. Upgrade to unlock.',
      );
    });

    it('moves the action onto the button so the panel does not state it twice', () => {
      render({
        lapsedOrgNames: ['Unstoppable Domains'],
        manageableLapsedOrg,
        planDisplayName: 'Pro',
      });

      expect(button()?.textContent).toBe('Get Pro');
    });

    it('agrees in the plural, naming every lapsed org', () => {
      render({
        lapsedOrgNames: ['Unstoppable Domains', 'Acme'],
        manageableLapsedOrg,
        planDisplayName: 'Pro',
      });

      expect(lapsedCopy()?.textContent).toBe(
        'This feature requires Pro, and Unstoppable Domains and Acme have no active plan to cover it. Upgrade to unlock.',
      );
    });

    it('drops the plan name and keeps the generic action when no plan is on the wire', () => {
      // `billingPresentation` is optional on the wire. With no plan name there
      // is no `Get <plan>` label to move the action onto, so the copy drops its
      // trailing sentence and the button carries the action. Never
      // `Get undefined`.
      render({
        lapsedOrgNames: ['Unstoppable Domains'],
        manageableLapsedOrg,
        planDisplayName: null,
      });

      expect(lapsedCopy()?.textContent).toBe(
        'This feature requires a paid plan, and Unstoppable Domains has no active plan to cover it.',
      );
      expect(button()?.textContent).toBe('Upgrade to unlock');
      expect(button()?.textContent).not.toContain('undefined');
    });

    it('never claims Remote Control was paused, or offers to restore it', () => {
      // The renderer cannot know whether the lapsed org was ever the source of
      // this user's Remote Control coverage, so neither the causal claim nor a
      // "Restore" action is honest here (CAN-2311 review).
      render({
        lapsedOrgNames: ['Unstoppable Domains'],
        manageableLapsedOrg,
        planDisplayName: 'Pro',
      });

      expect(lapsedCopy()?.textContent).not.toContain('paused');
      expect(lapsedCopy()?.textContent).not.toContain('restore it');
      expect(button()?.textContent).not.toContain('Restore');
    });

    it('drops the undefined "on hold" jargon (CAN-2590)', () => {
      render({
        lapsedOrgNames: ['Unstoppable Domains'],
        manageableLapsedOrg,
        planDisplayName: 'Pro',
      });

      expect(lapsedCopy()?.textContent).not.toContain('on hold');
    });
  });

  describe('member of the lapsed org', () => {
    it('names the org remedy and keeps the reader own route', () => {
      // Both routes are real and the app cannot tell which one applies: the
      // reader may be a true member (org renewal is the fix) or an owner of
      // several lapsed orgs with none selected, where no org is named rather
      // than guessed (in which case they are being told to ask themselves). A
      // personal plan unlocks Remote Control either way, so the button stays.
      render({
        lapsedOrgNames: ['Unstoppable Domains'],
        manageableLapsedOrg: null,
        planDisplayName: 'Pro',
      });

      expect(lapsedCopy()?.textContent).toBe(
        'This feature requires a paid plan, and Unstoppable Domains has no active plan to cover it. Ask an organization owner to renew, or upgrade your own plan.',
      );
      expect(button()?.textContent).toBe('Upgrade to unlock');
    });

    it('names no plan, since a member cannot buy the org tier it would name', () => {
      render({
        lapsedOrgNames: ['Unstoppable Domains'],
        manageableLapsedOrg: null,
        planDisplayName: 'Business',
      });

      expect(lapsedCopy()?.textContent).not.toContain('Business');
    });

    it('defaults to the member branch when the server says nothing about admin rights', () => {
      // `billingManageableOrg` is optional on the wire and defaults to null: a
      // server that cannot say "you are an admin" must not produce a button
      // that assumes it.
      render({
        lapsedOrgNames: ['Unstoppable Domains'],
        planDisplayName: 'Pro',
      });

      expect(lapsedCopy()?.textContent).toContain(
        'Ask an organization owner to renew, or upgrade your own plan.',
      );
      // Generic, never `Get <plan>`: no plan may be named without a matching
      // manageable org.
      expect(button()?.textContent).toBe('Upgrade to unlock');
    });

    it('agrees in the plural, naming every lapsed org', () => {
      render({
        lapsedOrgNames: ['Unstoppable Domains', 'Acme'],
        manageableLapsedOrg: null,
      });

      expect(lapsedCopy()?.textContent).toBe(
        'This feature requires a paid plan, and Unstoppable Domains and Acme have no active plan to cover it. Ask an organization owner to renew, or upgrade your own plan.',
      );
    });

    it('never claims Remote Control was paused, or offers to restore it', () => {
      render({
        lapsedOrgNames: ['Unstoppable Domains'],
        manageableLapsedOrg: null,
      });

      expect(lapsedCopy()?.textContent).not.toContain('paused');
      expect(lapsedCopy()?.textContent).not.toContain('restore it');
      expect(lapsedCopy()?.textContent).not.toContain('on hold');
    });
  });
});
