/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ShareRunModal, type ShareRunShareRequest } from '../ShareRunModal';
import type {
  ShareRunEligibilityResponse,
  ShareRunResponse,
  SharedRunMetadata,
} from '@canopy/desktop-shared/types';
import { useCloudConnectGateStore } from '@/stores/cloudConnectGateStore';

describe('ShareRunModal', () => {
  let container: HTMLDivElement;
  let root: Root;
  const onShare = jest.fn<Promise<ShareRunResponse>, [ShareRunShareRequest]>(
    () => Promise.resolve({ externalId: 'run-1' }),
  );
  const listSharedTeams = jest.fn(() =>
    Promise.resolve({
      success: true,
      data: {
        data: [
          {
            id: 'team-1',
            name: 'Platform',
            organization: { id: 'org-1', name: 'Acme' },
          },
        ],
      },
    }),
  );
  const listSharedOrganizations = jest.fn(() =>
    Promise.resolve({
      success: true,
      data: { data: [{ id: 'org-1', name: 'Acme' }] },
    }),
  );

  beforeEach(() => {
    onShare.mockClear();
    listSharedTeams.mockClear();
    listSharedOrganizations.mockClear();
    useCloudConnectGateStore.setState({ pending: null });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    Object.assign(window, {
      api: {
        getCanopyCloudBaseUrl: jest
          .fn()
          .mockResolvedValue('https://cloud.example.test'),
        loadCanopyCloudAccount: jest.fn().mockResolvedValue({
          hasApiKey: true,
          capabilities: [
            'session-exports-v1',
            'runs-crud-v1',
            'teams-v1',
            'organizations-v1',
          ],
          storageAvailable: true,
          account: {
            id: 'account-1',
            email: 'user@example.test',
            role: 'ADMIN',
          },
        }),
      },
      pipelines: { listSharedTeams, listSharedOrganizations },
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function renderModal({
    onShared = (): void => {},
    checkEligibility,
    existingShare,
  }: {
    onShared?: () => void | Promise<void>;
    checkEligibility?: () => Promise<ShareRunEligibilityResponse>;
    existingShare?: SharedRunMetadata;
  } = {}): Promise<void> {
    await act(async () => {
      root.render(
        <ShareRunModal
          chatId="chat-1"
          runTitle="Session title"
          onClose={() => {}}
          onShare={onShare}
          onShared={onShared}
          existingShare={existingShare}
          {...(checkEligibility ? { checkEligibility } : {})}
        />,
      );
      await Promise.resolve();
    });
  }

  /**
   * A button's label with decorative content removed.
   *
   * Share target rows carry an `aria-hidden` initials avatar ahead of the
   * name, so raw `textContent` on a "Platform" team row reads "PLPlatform".
   * Screen readers and the Playwright role selectors both ignore that node;
   * matching the accessible name here keeps this helper agreeing with them
   * instead of with the markup.
   */
  function buttonLabel(button: HTMLButtonElement): string {
    const clone = button.cloneNode(true);
    if (!(clone instanceof HTMLElement)) return '';
    for (const decoration of Array.from(
      clone.querySelectorAll('[aria-hidden="true"]'),
    )) {
      decoration.remove();
    }
    return (clone.textContent ?? '').trim();
  }

  function clickButton(name: string): void {
    const button = Array.from(document.querySelectorAll('button')).find(
      (candidate) => buttonLabel(candidate).startsWith(name),
    );
    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  }

  async function selectPlatformTeam(): Promise<void> {
    await act(async () => {
      clickButton('Team');
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      clickButton('Platform');
      await Promise.resolve();
    });
  }

  it('offers only team and organization for a redacted synchronized run', async () => {
    await renderModal();

    expect(document.body.textContent).toContain('Session title');
    expect(
      document.querySelector('[data-testid="share-run-scope-private"]'),
    ).toBeNull();
    expect(
      document
        .querySelector('[data-testid="share-run-scope-team"]')
        ?.getAttribute('aria-checked'),
    ).toBe('true');
    expect(
      document.querySelector('[data-testid="share-run-disclaimer"]')
        ?.textContent,
    ).toContain('redacted');
    expect(
      document.querySelector('[data-testid="share-run-disclaimer"]')
        ?.textContent,
    ).toContain('stays synchronized');
    expect(
      document.querySelector('[data-testid="share-run-disclaimer"]')
        ?.textContent,
    ).toContain('unshared at any time');

    await selectPlatformTeam();
    await act(async () => {
      clickButton('Share');
      await Promise.resolve();
    });

    expect(onShare).toHaveBeenCalledWith({
      shareScope: 'team',
      teamId: 'team-1',
    });
  });

  it('reopens an existing team share at its current audience', async () => {
    await renderModal({
      existingShare: {
        externalId: 'run-1',
        shareScope: 'team',
        teamId: 'team-1',
        teamName: 'Platform',
        organizationId: 'org-1',
        organizationName: 'Acme',
        sharedAt: '2026-09-24T20:00:00.000Z',
      },
    });

    expect(
      document
        .querySelector('[data-testid="share-run-scope-team"]')
        ?.getAttribute('aria-checked'),
    ).toBe('true');
    const submit = document.querySelector('[data-testid="share-run-submit"]');
    if (!(submit instanceof HTMLButtonElement)) {
      throw new Error('Expected the update submit button');
    }
    expect(buttonLabel(submit)).toBe('Update');
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(
      document.querySelector('[data-testid="share-run-copy-link"]'),
    ).not.toBeNull();

    await act(async () => {
      clickButton('Update');
      await Promise.resolve();
    });
    expect(onShare).toHaveBeenCalledWith({
      shareScope: 'team',
      teamId: 'team-1',
    });
  });

  it('re-shares after local persistence fails and the remote share is revoked', async () => {
    const existingShare: SharedRunMetadata = {
      externalId: 'run-old',
      shareScope: 'team',
      teamId: 'team-1',
      teamName: 'Platform',
      organizationId: 'org-1',
      organizationName: 'Acme',
      sharedAt: '2026-09-24T20:00:00.000Z',
    };
    const rolledBack = Object.assign(
      new Error('Local share state could not be saved; the share was revoked.'),
      { shareCompletionRolledBack: true as const },
    );
    const onShared = jest
      .fn<Promise<void>, []>()
      .mockRejectedValueOnce(rolledBack)
      .mockResolvedValueOnce(undefined);
    await renderModal({ onShared, existingShare });

    await act(async () => {
      clickButton('Update');
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // The controller removes the revoked existing share from its target and
    // re-renders the still-open modal with no existing share.
    await renderModal({ onShared });

    expect(onShared).toHaveBeenCalledTimes(1);
    const retry = document.querySelector('[data-testid="share-run-submit"]');
    expect(retry).not.toBeNull();
    expect(buttonLabel(retry as HTMLButtonElement)).toBe('Share');
    expect(document.querySelector('[data-testid="share-run-done"]')).toBeNull();
    expect(
      document.querySelector('[data-testid="share-run-copy-link"]'),
    ).toBeNull();
    expect(document.body.textContent).toContain(
      'Local share state could not be saved; the share was revoked.',
    );
    expect(document.body.textContent).not.toContain('Session shared.');

    await selectPlatformTeam();
    await act(async () => {
      clickButton('Share');
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(onShare).toHaveBeenCalledTimes(2);
    expect(onShared).toHaveBeenCalledTimes(2);
  });

  it('requires guest accounts to connect before sharing', async () => {
    jest.mocked(window.api.loadCanopyCloudAccount).mockResolvedValue({
      hasApiKey: true,
      authMode: 'guest',
      credentialSource: 'guest',
      capabilities: ['runs-crud-v1'],
      storageAvailable: true,
      account: {
        id: 'guest-account-1',
        email: 'guest@example.test',
        role: 'MEMBER',
      },
    });

    await renderModal();

    expect(
      document.querySelector('[data-testid="share-run-submit"]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-testid="share-run-guest-cta"]'),
    ).not.toBeNull();
    expect(document.body.textContent).toContain('Start free trial');

    await act(async () => {
      clickButton('Start free trial');
      await Promise.resolve();
    });
    expect(
      useCloudConnectGateStore.getState().pending?.context.guestBenefits,
    ).toBe(true);
  });

  it('shares a redacted run that can be unshared with a selected team', async () => {
    await renderModal();

    await act(async () => {
      clickButton('Team');
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(listSharedTeams).toHaveBeenCalled();
    expect(
      document
        .querySelector('[data-testid="share-run-team-picker"] input')
        ?.getAttribute('placeholder'),
    ).toBe('Search teams…');
    expect(
      document.querySelector('[data-testid="share-run-disclaimer"]')
        ?.textContent,
    ).toContain('redacted');
    expect(
      document.querySelector('[data-testid="share-run-disclaimer"]')
        ?.textContent,
    ).toContain('may be truncated');
    expect(
      document.querySelector('[data-testid="share-run-disclaimer"]')
        ?.textContent,
    ).toContain('unshared at any time');

    await act(async () => {
      clickButton('Platform');
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(
      (
        document.querySelector(
          '[data-testid="share-run-submit"]',
        ) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
    await act(async () => {
      clickButton('Share');
      await Promise.resolve();
    });

    expect(onShare).toHaveBeenCalledWith({
      shareScope: 'team',
      teamId: 'team-1',
    });
  });

  // A chat whose audit entries aged out of the retention window still renders
  // its transcript, so nothing on screen hints that sharing is impossible. The
  // pre-fix behaviour let the user pick an audience, click Share, and get a
  // bare "Failed to share session." — indistinguishable from a network error.
  it('explains an aged-out session up front instead of offering an audience', async () => {
    await renderModal({
      checkEligibility: () =>
        Promise.resolve({
          shareable: false,
          reason: 'no-activity',
          auditRetentionDays: 7,
        }),
    });

    const blocked = document.querySelector(
      '[data-testid="share-run-unavailable"]',
    );
    expect(blocked).not.toBeNull();
    expect(blocked?.textContent).toContain('7-day');
    expect(
      document.querySelector('[data-testid="share-run-scope"]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-testid="share-run-submit"]'),
    ).toBeNull();
  });

  it('renders the normal picker when the session is still shareable', async () => {
    await renderModal({
      checkEligibility: () =>
        Promise.resolve({ shareable: true, auditRetentionDays: 7 }),
    });

    expect(
      document.querySelector('[data-testid="share-run-unavailable"]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-testid="share-run-submit"]'),
    ).not.toBeNull();
  });

  // Eligibility is a hint, not a gate: a probe failure must not lock the user
  // out of a session that can actually be shared.
  it('falls back to the picker when the eligibility probe fails', async () => {
    await renderModal({
      checkEligibility: () => Promise.reject(new Error('ipc down')),
    });

    expect(
      document.querySelector('[data-testid="share-run-unavailable"]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-testid="share-run-submit"]'),
    ).not.toBeNull();
  });

  // The probe can race the retention prune, and hosts may not supply one at
  // all, so the same explanation has to be reachable from the share result.
  it('explains a no-activity share result reported after submit', async () => {
    onShare.mockResolvedValueOnce({
      externalId: null,
      reason: 'no-activity',
      auditRetentionDays: 14,
    });

    await renderModal();
    await selectPlatformTeam();
    await act(async () => {
      clickButton('Share');
      await Promise.resolve();
    });

    const blocked = document.querySelector(
      '[data-testid="share-run-unavailable"]',
    );
    expect(blocked?.textContent).toContain('14-day');
    expect(
      document.querySelector('[data-testid="share-run-submit"]'),
    ).toBeNull();
  });

  // Run sharing bypasses the ambient telemetry gate, so an org that prohibits
  // transcripts (or the metadata envelope) blocks it main-side. That reason is
  // NOT a retention problem: reusing the aged-out copy would tell the user to
  // widen a window that has nothing to do with it, and would never name the org
  // that actually decided this.
  it('names the blocking organization instead of blaming retention', async () => {
    await renderModal({
      checkEligibility: () =>
        Promise.resolve({
          shareable: false,
          reason: 'blocked-by-org-policy',
          auditRetentionDays: 7,
          blockedByOrganizationNames: ['Acme'],
        }),
    });

    const blocked = document.querySelector(
      '[data-testid="share-run-unavailable"]',
    );
    expect(blocked).not.toBeNull();
    expect(blocked?.textContent).toContain('Acme');
    expect(blocked?.textContent).not.toContain('7-day');
    expect(
      document.querySelector('[data-testid="share-run-submit"]'),
    ).toBeNull();
  });

  // CAN-2590. The billing refusal's TITLE is the headline this ticket came here
  // to fix — it used to read "This organization is on hold" above a description
  // saying "does not have an active plan", one modal describing one state two
  // ways with the jargon on top. Nothing pinned it: the sibling test below
  // asserts the inline message, and the aged-out/policy tests assert their own
  // titles, so the billing title could have regressed to jargon silently.
  it('titles the billing refusal with the same words as its description', async () => {
    await renderModal({
      checkEligibility: () =>
        Promise.resolve({
          shareable: false,
          reason: 'blocked-by-org-billing',
          blockedByOrganizationNames: ['Acme'],
        }),
    });

    const blocked = document.querySelector(
      '[data-testid="share-run-unavailable"]',
    );
    expect(blocked).not.toBeNull();
    expect(blocked?.textContent).toContain(
      'This organization has no active plan',
    );
    // Title and description agree, and neither reaches for the removed jargon.
    expect(blocked?.textContent).toContain('does not have an active plan');
    expect(blocked?.textContent).not.toContain('on hold');
    expect(blocked?.textContent).toContain('Acme');
  });

  // The plural title branch is not reachable through today's callers
  // (`resolveShareOrgPolicyBlock` passes a single target for `kind: 'billing'`),
  // but the sibling description below it IS multi-org reachable, so the two are
  // written to survive a list together. Pinning it keeps them agreeing if a
  // caller ever passes more than one.
  it('agrees in number when more than one organization is named', async () => {
    await renderModal({
      checkEligibility: () =>
        Promise.resolve({
          shareable: false,
          reason: 'blocked-by-org-billing',
          blockedByOrganizationNames: ['Acme', 'Initech'],
        }),
    });

    const blocked = document.querySelector(
      '[data-testid="share-run-unavailable"]',
    );
    expect(blocked?.textContent).toContain(
      'These organizations have no active plans',
    );
    expect(blocked?.textContent).toContain('do not have active plans');
    expect(blocked?.textContent).not.toContain('on hold');
  });

  // The eligibility probe can race an admin's policy change, so the same
  // explanation has to be reachable from the share result.
  it('explains a policy-blocked share result reported after submit', async () => {
    onShare.mockResolvedValueOnce({
      externalId: null,
      reason: 'blocked-by-org-policy',
      auditRetentionDays: 14,
      blockedByOrganizationNames: ['Acme'],
    });

    await renderModal();
    await selectPlatformTeam();
    await act(async () => {
      clickButton('Share');
      await Promise.resolve();
    });

    const blocked = document.querySelector(
      '[data-testid="share-run-unavailable"]',
    );
    expect(blocked?.textContent).toContain('Acme');
    expect(blocked?.textContent).not.toContain('14-day');
    expect(document.body.textContent).not.toContain('Failed to share session.');
  });

  // A BILLING refusal names ONE org. Unlike a policy block (account-wide), the
  // user may still have a healthy org or a team inside it, so it must not
  // replace the picker with a terminal card the modal can
  // never clear.
  it('keeps the picker mounted after a billing-blocked share so another target stays reachable', async () => {
    onShare.mockResolvedValueOnce({
      externalId: null,
      reason: 'blocked-by-org-billing',
      blockedByOrganizationNames: ['Acme'],
    });

    await renderModal();
    await selectPlatformTeam();
    await act(async () => {
      clickButton('Share');
      await Promise.resolve();
    });

    // Explained inline, naming the org...
    expect(document.body.textContent).toContain('Acme');
    expect(document.body.textContent).toContain('does not have an active plan');
    expect(document.body.textContent).toContain('Failed to share session.');
    // ...and NOT promoted into the terminal, picker-replacing card.
    expect(
      document.querySelector('[data-testid="share-run-unavailable"]'),
    ).toBeNull();
    // The submit control survives, so the user can retarget without reopening.
    expect(
      document.querySelector('[data-testid="share-run-submit"]'),
    ).not.toBeNull();
  });

  // The contrast case: a POLICY block is account-wide, so it stays terminal.
  it('still ends the modal on a policy-blocked share', async () => {
    onShare.mockResolvedValueOnce({
      externalId: null,
      reason: 'blocked-by-org-policy',
      blockedByOrganizationNames: ['Acme'],
    });

    await renderModal();
    await selectPlatformTeam();
    await act(async () => {
      clickButton('Share');
      await Promise.resolve();
    });

    expect(
      document.querySelector('[data-testid="share-run-unavailable"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('[data-testid="share-run-submit"]'),
    ).toBeNull();
  });

  it('offers organization sharing with the redacted-run disclaimer', async () => {
    await renderModal();

    await act(async () => {
      clickButton('Organization');
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(listSharedOrganizations).toHaveBeenCalled();
    expect(
      document.querySelector('[data-testid="share-run-disclaimer"]')
        ?.textContent,
    ).toContain('redacted');
    expect(
      document
        .querySelector('[data-testid="share-run-scope-organization"]')
        ?.getAttribute('aria-checked'),
    ).toBe('true');
    expect(
      document
        .querySelector('[data-testid="share-run-organization-picker"] input')
        ?.getAttribute('placeholder'),
    ).toBe('Search organizations…');
    expect(
      document
        .querySelector(
          '[data-testid="share-run-organization-picker-option-org-1"]',
        )
        ?.getAttribute('aria-pressed'),
    ).toBe('false');
  });
});
