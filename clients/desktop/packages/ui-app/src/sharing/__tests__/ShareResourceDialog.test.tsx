/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { PipelinePackageAnalysisSummary } from '@canopy/protocol/pipelines';
import type { PersonalOrganizationUpgradePort } from '@canopy/app-state/personal-organization-upgrade';
import {
  ShareConflictError,
  ShareResourceDialog,
  shareResourceCopy,
  type ShareResourceAccount,
  type ShareTargetSummary,
} from '../ShareResourceDialog';
import type { CapabilityPackageSharePort } from '../capability-package/useCapabilityPackageShare';
import { ShareFailureError } from '../share-errors';
import { ResourceContextProvider } from '../../capability/ResourceContext';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// The desktop Skills share modal, hoisted so the web portal renders the same
// dialog (CAN-2845). Scope selection, the team/organization pickers, account
// gating and the success/link states live here; each host injects how the
// share is actually performed.
const readyAccount: ShareResourceAccount = {
  connected: true,
  capabilities: ['skills-crud-v1', 'teams-v1', 'organizations-v1'],
};

const team: ShareTargetSummary = {
  id: 'team-1',
  name: 'Platform',
  organizationId: 'org-1',
  secondaryLabel: 'Acme',
};

const organizations: readonly ShareTargetSummary[] = [
  { id: 'org-1', name: 'Acme' },
  { id: 'org-2', name: 'Beta' },
];

function click(selector: string): void {
  document
    .querySelector(selector)
    ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

/** Opens a scope pill's tooltip the way a pointer does. */
function hover(selector: string): void {
  act(() => {
    document
      .querySelector(selector)
      ?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  });
}

function scopeOption(
  audience: string,
  prefix = 'share-skill',
): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(
    `[data-testid="${prefix}-scope-${audience}"]`,
  );
}

function successText(): string | null | undefined {
  return document.querySelector('[data-testid="share-skill-success"]')
    ?.textContent;
}

function clickText(text: string): void {
  Array.from(document.querySelectorAll('button'))
    .find((candidate) => candidate.textContent?.trim() === text)
    ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

describe('ShareResourceDialog', () => {
  let container: HTMLElement;
  let root: Root;

  function renderDialog(
    overrides: Partial<Parameters<typeof ShareResourceDialog>[0]> = {},
    personalOrganizationId: string | null = null,
  ): void {
    act(() => {
      root.render(
        <ResourceContextProvider
          context={overrides.context}
          personalOrganizationId={personalOrganizationId}
        >
          <ShareResourceDialog
            resourceNoun="skill"
            testIdPrefix="share-skill"
            requiredCapability="skills-crud-v1"
            scopes={['team', 'organization', 'public']}
            loadAccount={jest.fn().mockResolvedValue(readyAccount)}
            listTeams={jest.fn().mockResolvedValue([team])}
            listOrganizations={jest.fn().mockResolvedValue([])}
            share={jest.fn().mockResolvedValue({})}
            copyText={jest.fn().mockResolvedValue(true)}
            notify={jest.fn()}
            onClose={jest.fn()}
            {...overrides}
          />
        </ResourceContextProvider>,
      );
    });
  }

  async function settle(): Promise<void> {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  beforeEach(() => {
    jest.useFakeTimers();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    jest.useRealTimers();
  });

  it('derives its copy from the resource noun', () => {
    const copy = shareResourceCopy('pipeline');
    expect(copy.sharing).toBe('Sharing…');
    expect(copy.teamValidationError).toBe(
      'Select a team to share this pipeline.',
    );
    expect(copy.guestAction).toBe('Start free trial');
    expect(
      shareResourceCopy('pipeline', { freeAccess: true }).guestAction,
    ).toBe('Sign in');
  });

  it('stays open in its published state with the link and Copy link after a share', async () => {
    const shareUrl = 'https://cloud.test/s/skills/abc';
    const share = jest.fn().mockResolvedValue({ shareUrl });
    const copyText = jest.fn().mockResolvedValue(true);
    const onCompleted = jest.fn();
    const onClose = jest.fn();
    renderDialog({ share, copyText, onCompleted, onClose });
    await settle();

    click('[data-testid="share-skill-scope-public"]');
    await settle();
    click('[data-testid="share-skill-submit"]');
    await settle();

    expect(share).toHaveBeenCalledWith({ scope: 'public' });
    expect(onCompleted).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    const success = document.querySelector(
      '[data-testid="share-skill-success"]',
    );
    expect(success?.textContent).toContain('Skill is now public');
    expect(
      document.querySelector('[data-testid="share-skill-link"]')?.textContent,
    ).toBe(shareUrl);
    // The landed share can't be submitted again: Done closes.
    expect(
      document.querySelector('[data-testid="share-skill-submit"]'),
    ).toBeNull();
    // The link is never copied automatically, only on Copy link.
    expect(copyText).not.toHaveBeenCalled();
    // The published state's own Copy link offers the new link.
    const copy = document.querySelector<HTMLButtonElement>(
      '[data-testid="share-skill-copy-link"]',
    );
    expect(copy?.textContent).toBe('Copy link');
    expect(
      document.querySelectorAll('[data-testid="share-skill-copy-link"]'),
    ).toHaveLength(1);
    await act(async () => {
      copy?.click();
      await Promise.resolve();
    });
    expect(copyText).toHaveBeenCalledWith(shareUrl);
    expect(copy?.textContent).toBe('Copied');

    click('[data-testid="share-skill-done"]');
    await settle();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onCompleted).toHaveBeenCalledTimes(1);
  });

  it('posts no toast when a share is published or updated', async () => {
    const notify = jest.fn();
    const share = jest
      .fn()
      .mockResolvedValue({ shareUrl: 'https://cloud.test/s/skills/abc' });
    renderDialog({ notify, share });
    await settle();
    click('[data-testid="share-skill-scope-public"]');
    await settle();
    click('[data-testid="share-skill-submit"]');
    await settle();
    expect(
      document.querySelector('[data-testid="share-skill-success"]'),
    ).not.toBeNull();
    expect(notify).not.toHaveBeenCalled();

    act(() => root.unmount());
    root = createRoot(container);
    renderDialog({
      notify,
      share,
      existingShare: {
        audience: 'public',
        link: { url: 'https://cloud.test/s/skills/abc', kind: 'public' },
      },
    });
    await settle();
    click('[data-testid="share-skill-submit"]');
    await settle();
    expect(
      document.querySelector('[data-testid="share-skill-success"]')
        ?.textContent,
    ).toContain('Skill updated');
    expect(notify).not.toHaveBeenCalled();
  });

  it('stays open after a team share, offering its link only when there is one', async () => {
    const notify = jest.fn();
    const onClose = jest.fn();
    renderDialog({ notify, onClose, share: jest.fn().mockResolvedValue({}) });
    await settle();
    click('[data-testid="share-skill-scope-team"]');
    await settle();
    click('[data-testid="share-skill-team-picker-option-team-1"]');
    await settle();
    click('[data-testid="share-skill-submit"]');
    await settle();

    expect(onClose).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(
      document.querySelector('[data-testid="share-skill-success"]')
        ?.textContent,
    ).toContain('Skill shared with Platform');
    expect(document.querySelector('[data-testid="share-skill-link"]')).toBe(
      null,
    );
    expect(
      document.querySelector('[data-testid="share-skill-copy-link"]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-testid="share-skill-done"]'),
    ).not.toBeNull();
  });

  it('spins the Share button and locks the form while sharing', async () => {
    let resolveShare: ((outcome: object) => void) | undefined;
    const share = jest.fn(
      () =>
        new Promise<object>((resolve) => {
          resolveShare = resolve;
        }),
    );
    const onClose = jest.fn();
    renderDialog({ share, onClose });
    await settle();
    click('[data-testid="share-skill-scope-public"]');
    await settle();
    click('[data-testid="share-skill-submit"]');
    await settle();

    const submit = document.querySelector<HTMLButtonElement>(
      '[data-testid="share-skill-submit"]',
    );
    expect(submit?.textContent).toBe('Sharing…');
    expect(submit?.disabled).toBe(true);
    expect(
      document.querySelector('[data-testid="share-skill-submit-spinner"]'),
    ).not.toBeNull();
    expect(
      document.querySelector<HTMLFieldSetElement>(
        '[data-testid="share-skill-form"]',
      )?.disabled,
    ).toBe(true);
    expect(
      document.querySelector<HTMLButtonElement>(
        '[data-testid="share-skill-cancel"]',
      ),
    ).toBeNull();
    expect(
      document.querySelector('[data-testid="share-skill-progress"]'),
    ).toBeNull();

    await act(async () => {
      resolveShare?.({});
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(successText()).toContain('Skill is now public');
  });

  it('stays open with the error notice when completion throws', async () => {
    const shareUrl = 'https://cloud.test/s/skills/new-share';
    const share = jest.fn().mockResolvedValue({ shareUrl });
    const copyText = jest.fn().mockResolvedValue(true);
    const onCompleted = jest
      .fn()
      .mockRejectedValueOnce(new Error('Refresh failed.'))
      .mockResolvedValue(undefined);
    const onClose = jest.fn();
    const notify = jest.fn();
    renderDialog({
      share,
      onClose,
      notify,
      onCompleted,
      copyText,
    });
    await settle();
    click('[data-testid="share-skill-scope-public"]');
    await settle();
    click('[data-testid="share-skill-submit"]');
    await settle();

    expect(onClose).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    const error = document.querySelector('[data-testid="share-skill-error"]');
    expect(error?.textContent).toContain(
      'Failed to share skill. Refresh failed.',
    );
    expect(error?.getAttribute('role')).toBe('alert');

    // The remote share already landed. Recovery retries only the completion
    // hook; it must never expose Share again and repeat the mutation.
    expect(
      document.querySelector('[data-testid="share-skill-submit"]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-testid="share-skill-done"]'),
    ).not.toBeNull();
    click('[data-testid="share-skill-copy-link"]');
    await settle();
    expect(copyText).toHaveBeenCalledWith(shareUrl);
    click('[data-testid="share-skill-done"]');
    await settle();

    // Done retries completion and then closes: the author already has the
    // link, so there is no success notice or toast to stay for.
    expect(share).toHaveBeenCalledTimes(1);
    expect(onCompleted).toHaveBeenCalledTimes(2);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();
  });

  it('shows Copy link in the footer when the share already has a link', async () => {
    const copyText = jest.fn().mockResolvedValue(true);
    renderDialog({
      copyText,
      existingShare: {
        audience: 'public',
        link: { url: 'https://cloud.test/s/skills/abc', kind: 'public' },
      },
    });
    await settle();
    const copy = document.querySelector<HTMLButtonElement>(
      '[data-testid="share-skill-copy-link"]',
    );
    expect(copy?.textContent).toBe('Copy link');
    await act(async () => {
      copy?.click();
      await Promise.resolve();
    });
    expect(copyText).toHaveBeenCalledWith('https://cloud.test/s/skills/abc');
    expect(copy?.textContent).toBe('Copied');
  });

  it('reopening Share on a published item shows the published state with its link', async () => {
    const url = 'https://cloud.test/s/skills/abc';
    const onClose = jest.fn();
    renderDialog({
      onClose,
      existingShare: { audience: 'public', link: { url, kind: 'public' } },
      revokePublicLink: jest.fn().mockResolvedValue(undefined),
    });
    await settle();

    // It was already public, so the notice doesn't say "now".
    expect(successText()).toContain('Skill is public');
    expect(successText()).not.toContain('now public');
    expect(
      document.querySelector('[data-testid="share-skill-link"]')?.textContent,
    ).toBe(url);
    expect(
      document.querySelector('[data-testid="share-skill-copy-link"]')
        ?.textContent,
    ).toBe('Copy link');
    // Update stays offered, and Remove public link is the trash icon at the
    // end of the link line inside the notice, not a standalone text button.
    expect(
      document.querySelector('[data-testid="share-skill-submit"]')?.textContent,
    ).toBe('Update');
    const remove = document.querySelector<HTMLButtonElement>(
      '[data-testid="share-skill-success"] [data-testid="share-skill-remove-public-link"]',
    );
    expect(remove?.getAttribute('aria-label')).toBe('Remove public link');
    expect(remove?.textContent).toBe('');
    expect(
      document.querySelectorAll(
        '[data-testid="share-skill-remove-public-link"]',
      ),
    ).toHaveLength(1);
    expect(
      Array.from(document.querySelectorAll('button')).some(
        (button) => button.textContent?.trim() === 'Remove public link',
      ),
    ).toBe(false);
    hover('[data-testid="share-skill-remove-public-link"]');
    expect(document.body.textContent).toContain('Remove public link');

    click('[data-testid="share-skill-done"]');
    expect(onClose).toHaveBeenCalledTimes(1);

    // Choosing another audience leaves the published notice.
    click('[data-testid="share-skill-scope-team"]');
    await settle();
    expect(successText()).toBeUndefined();
  });

  it('hides Copy link without a link and in gates', async () => {
    renderDialog({ existingShare: { audience: 'public' } });
    await settle();
    expect(
      document.querySelector('[data-testid="share-skill-copy-link"]'),
    ).toBeNull();

    renderDialog({
      existingShare: {
        audience: 'public',
        link: { url: 'https://cloud.test/s/skills/abc', kind: 'public' },
      },
      preflight: jest.fn().mockResolvedValue({
        status: 'blocked',
        body: <p>Blocked.</p>,
      }),
    });
    await settle();
    expect(
      document.querySelector('[data-testid="share-skill-unavailable"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('[data-testid="share-skill-copy-link"]'),
    ).toBeNull();
  });

  it('refuses to submit a team share until a team is picked', async () => {
    const share = jest.fn().mockResolvedValue({});
    renderDialog({ share });
    await settle();

    clickText('Team');
    await act(async () => {
      jest.advanceTimersByTime(300);
      await Promise.resolve();
    });
    await settle();

    // Confirm stays disabled with no selection, so the share never fires.
    const confirm = document.querySelector<HTMLButtonElement>(
      '[data-testid="share-skill-submit"]',
    );
    expect(confirm?.disabled).toBe(true);
    expect(share).not.toHaveBeenCalled();

    click('[data-testid="share-skill-team-picker-option-team-1"]');
    await settle();
    click('[data-testid="share-skill-submit"]');
    await settle();
    expect(share).toHaveBeenCalledWith({
      scope: 'team',
      teamId: 'team-1',
      targetName: 'Platform',
    });
  });

  it('names the team it shared with and offers its link', async () => {
    const notify = jest.fn();
    renderDialog({
      notify,
      share: jest
        .fn()
        .mockResolvedValue({ shareUrl: 'https://cloud.test/t/skills/abc' }),
    });
    await settle();
    click('[data-testid="share-skill-scope-team"]');
    await settle();
    click('[data-testid="share-skill-team-picker-option-team-1"]');
    await settle();
    click('[data-testid="share-skill-submit"]');
    await settle();
    expect(notify).not.toHaveBeenCalled();
    expect(successText()).toContain('Skill shared with Platform');
    expect(
      document.querySelector('[data-testid="share-skill-link"]')?.textContent,
    ).toBe('https://cloud.test/t/skills/abc');
    expect(
      document.querySelector('[data-testid="share-skill-copy-link"]'),
    ).not.toBeNull();
  });

  it('keeps first-share wording when completion records the new remote share', async () => {
    const notify = jest.fn();
    const onClose = jest.fn();
    const share = jest.fn().mockResolvedValue({});
    const onCompleted = jest.fn(() => {
      renderDialog({
        notify,
        onClose,
        share,
        onCompleted,
        existingShare: { audience: 'team', target: team },
      });
    });
    renderDialog({ notify, onClose, share, onCompleted });
    await settle();
    click('[data-testid="share-skill-scope-team"]');
    await settle();
    click('[data-testid="share-skill-team-picker-option-team-1"]');
    await settle();
    click('[data-testid="share-skill-submit"]');
    await settle();

    expect(onCompleted).toHaveBeenCalledTimes(1);
    expect(successText()).toBe('Skill shared with Platform');
    expect(notify).not.toHaveBeenCalled();
  });

  it('turns a host outcome message into a warning notice', async () => {
    const notify = jest.fn();
    renderDialog({
      notify,
      share: jest
        .fn()
        .mockResolvedValue({ message: 'Shared, but the local copy stayed.' }),
    });
    await settle();
    click('[data-testid="share-skill-scope-public"]');
    await settle();
    click('[data-testid="share-skill-submit"]');
    await settle();
    expect(notify).not.toHaveBeenCalled();
    expect(successText()).toBe('Shared, but the local copy stayed.');
  });

  it('renders the shared scope selector and team picker rows', async () => {
    renderDialog();
    await settle();

    // The scope pills are the shared radio group every share surface uses.
    const radios = Array.from(
      document.querySelectorAll(
        '[data-testid="share-skill-scope"] [role="radio"]',
      ),
    );
    expect(radios.map((radio) => radio.textContent)).toEqual([
      'Team',
      'Organization',
      'Public',
    ]);

    click('[data-testid="share-skill-scope-team"]');
    await act(async () => {
      jest.advanceTimersByTime(300);
      await Promise.resolve();
    });
    await settle();

    const search = document.querySelector<HTMLInputElement>(
      '[data-testid="share-skill-team-picker"] input[type="search"]',
    );
    expect(search?.placeholder).toBe('Search teams…');
    const row = document.querySelector(
      '[data-testid="share-skill-team-picker-option-team-1"]',
    );
    // Initials avatar, name, owning organization and the selection indicator.
    expect(row?.querySelector('[aria-hidden="true"]')?.textContent).toBe('PL');
    expect(row?.textContent).toContain('Acme');
    expect(
      row
        ?.querySelector(
          '[data-testid="shared-target-picker-selection-indicator"]',
        )
        ?.getAttribute('data-selected'),
    ).toBe('false');

    click('[data-testid="share-skill-team-picker-option-team-1"]');
    await settle();
    expect(row?.getAttribute('aria-pressed')).toBe('true');
  });

  it('preselects Public and disables Team and Organization for a new share in Personal context', async () => {
    const listTeams = jest.fn().mockResolvedValue([team]);
    renderDialog({
      context: { kind: 'personal' },
      contextOrganizations: organizations,
      listTeams,
    });
    await settle();

    expect(scopeOption('team')?.getAttribute('aria-disabled')).toBe('true');
    expect(scopeOption('organization')?.getAttribute('aria-disabled')).toBe(
      'true',
    );
    expect(scopeOption('public')?.getAttribute('aria-checked')).toBe('true');
    expect(listTeams).not.toHaveBeenCalled();
  });

  it('keeps an existing Team audience visible in Personal context', async () => {
    renderDialog({
      context: { kind: 'personal' },
      contextOrganizations: organizations,
      existingShare: { audience: 'team', target: team },
    });
    await settle();

    expect(
      document.querySelector('[data-testid="share-skill-team-picker"]'),
    ).not.toBeNull();
  });

  it('preselects the context organization and filters teams to it', async () => {
    const listTeams = jest.fn().mockResolvedValue([
      team,
      {
        id: 'team-2',
        name: 'Beta team',
        organizationId: 'org-2',
        secondaryLabel: 'Beta',
      },
      { id: 'legacy-team', name: 'Legacy team' },
    ]);
    renderDialog({
      context: { kind: 'organization', organizationId: 'org-1' },
      contextOrganizations: organizations,
      listTeams,
      listOrganizations: jest.fn().mockResolvedValue(organizations),
    });
    await settle();

    click('[data-testid="share-skill-scope-organization"]');
    await settle();
    expect(
      document
        .querySelector(
          '[data-testid="share-skill-organization-picker-option-org-1"]',
        )
        ?.getAttribute('aria-pressed'),
    ).toBe('true');

    click('[data-testid="share-skill-scope-team"]');
    await act(async () => {
      jest.advanceTimersByTime(300);
      await Promise.resolve();
    });
    await settle();
    expect(
      document.querySelector(
        '[data-testid="share-skill-team-picker-option-team-1"]',
      ),
    ).not.toBeNull();
    expect(
      document.querySelector(
        '[data-testid="share-skill-team-picker-option-legacy-team"]',
      ),
    ).not.toBeNull();
    expect(
      document.querySelector(
        '[data-testid="share-skill-team-picker-option-team-2"]',
      ),
    ).toBeNull();
  });

  it('preserves an explicit organization across same-account membership refresh', async () => {
    const share = jest.fn().mockResolvedValue({});
    const listOrganizations = jest.fn().mockResolvedValue(organizations);
    const props = {
      context: { kind: 'organization', organizationId: 'org-1' } as const,
      contextOrganizations: organizations,
      listOrganizations,
      share,
    };
    renderDialog(props);
    await settle();

    click('[data-testid="share-skill-scope-organization"]');
    await settle();
    click('[data-testid="share-skill-organization-picker-option-org-2"]');
    await settle();
    expect(
      document
        .querySelector(
          '[data-testid="share-skill-organization-picker-option-org-2"]',
        )
        ?.getAttribute('aria-pressed'),
    ).toBe('true');

    renderDialog({
      ...props,
      contextOrganizations: organizations.map((organization) => ({
        ...organization,
      })),
    });
    await settle();

    expect(
      document
        .querySelector(
          '[data-testid="share-skill-organization-picker-option-org-2"]',
        )
        ?.getAttribute('aria-pressed'),
    ).toBe('true');
    click('[data-testid="share-skill-submit"]');
    await settle();
    expect(share).toHaveBeenCalledWith({
      scope: 'organization',
      organizationId: 'org-2',
      targetName: 'Beta',
    });
  });

  it('rebinds organization state and shows a context-change notice', async () => {
    renderDialog({
      context: { kind: 'organization', organizationId: 'org-1' },
      contextOrganizations: organizations,
      listOrganizations: jest.fn().mockResolvedValue(organizations),
    });
    await settle();
    renderDialog({
      context: { kind: 'organization', organizationId: 'org-2' },
      contextOrganizations: organizations,
      listOrganizations: jest.fn().mockResolvedValue(organizations),
    });
    await settle();

    expect(
      document.querySelector('[data-testid="share-skill-context-changed"]')
        ?.textContent,
    ).toContain('Switched to Beta.');
  });

  it('rebinds a Personal public share after changing it to Team', async () => {
    const betaTeam: ShareTargetSummary = {
      id: 'team-2',
      name: 'Beta team',
      organizationId: 'org-2',
      secondaryLabel: 'Beta',
    };
    const share = jest.fn().mockResolvedValue({});
    const listTeams = jest.fn().mockResolvedValue([team, betaTeam]);
    renderDialog({
      context: { kind: 'organization', organizationId: 'org-1' },
      contextOrganizations: organizations,
      existingShare: { audience: 'public' },
      listTeams,
      share,
    });
    await settle();
    click('[data-testid="share-skill-scope-team"]');
    await act(async () => {
      jest.advanceTimersByTime(300);
      await Promise.resolve();
    });
    await settle();
    click('[data-testid="share-skill-team-picker-option-team-1"]');
    await settle();

    renderDialog({
      context: { kind: 'organization', organizationId: 'org-2' },
      contextOrganizations: organizations,
      existingShare: { audience: 'public' },
      listTeams,
      share,
    });
    await settle();
    click('[data-testid="share-skill-submit"]');
    await settle();

    expect(
      document.querySelector('[data-testid="share-skill-context-changed"]')
        ?.textContent,
    ).toContain('Switched to Beta.');
    expect(share).not.toHaveBeenCalled();
  });

  it('applies a context change after a failed share settles', async () => {
    let rejectShare: ((reason?: unknown) => void) | undefined;
    const share = jest.fn(
      () =>
        new Promise<object>((_resolve, reject) => {
          rejectShare = reject;
        }),
    );
    const loadAccount = jest.fn().mockResolvedValue(readyAccount);
    const listOrganizations = jest.fn().mockResolvedValue(organizations);
    renderDialog({
      context: { kind: 'organization', organizationId: 'org-1' },
      contextOrganizations: organizations,
      loadAccount,
      listOrganizations,
      share,
    });
    await settle();
    click('[data-testid="share-skill-scope-public"]');
    await settle();
    click('[data-testid="share-skill-submit"]');
    await settle();

    renderDialog({
      context: { kind: 'organization', organizationId: 'org-2' },
      contextOrganizations: organizations,
      loadAccount,
      listOrganizations,
      share,
    });
    await settle();
    expect(
      document.querySelector('[data-testid="share-skill-context-changed"]'),
    ).toBeNull();

    await act(async () => {
      rejectShare?.(new Error('share failed'));
      await Promise.resolve();
      await Promise.resolve();
    });
    await settle();

    expect(
      document.querySelector('[data-testid="share-skill-context-changed"]')
        ?.textContent,
    ).toContain('Switched to Beta.');
  });

  it('disables sharing when a context switch to Personal leaves no offered audience usable', async () => {
    renderDialog({
      scopes: ['team', 'organization'],
      context: { kind: 'organization', organizationId: 'org-1' },
      contextOrganizations: organizations,
    });
    await settle();
    renderDialog({
      scopes: ['team', 'organization'],
      context: { kind: 'personal' },
      contextOrganizations: organizations,
    });
    await settle();

    expect(
      document.querySelector('[data-testid="share-skill-context-changed"]')
        ?.textContent,
    ).toContain('Switched to Personal.');
    expect(
      document.querySelector<HTMLButtonElement>(
        '[data-testid="share-skill-submit"]',
      )?.disabled,
    ).toBe(true);
    // The scopes stay visible, disabled, with the reason in their tooltip.
    expect(scopeOption('team')?.getAttribute('aria-disabled')).toBe('true');
    expect(scopeOption('organization')?.getAttribute('aria-disabled')).toBe(
      'true',
    );
    hover('[data-testid="share-skill-scope-team"]');
    expect(
      document.querySelector('[data-testid="share-skill-scope-team-reason"]')
        ?.textContent,
    ).toBe('Switch to an organization to share with a team or organization.');
  });

  it('clears the picked team, reloads and reports an audience change when the account switches', async () => {
    let notifyAccountChanged: () => void = () => {};
    const loadAccount = jest
      .fn<Promise<ShareResourceAccount>, []>()
      .mockResolvedValueOnce({ ...readyAccount, id: 'account-1' })
      .mockResolvedValue({ ...readyAccount, id: 'account-2' });
    const listTeams = jest.fn().mockResolvedValue([team]);
    const preflight = jest.fn().mockResolvedValue({ status: 'ready' });
    const onAudienceChange = jest.fn();
    renderDialog({
      loadAccount,
      listTeams,
      preflight,
      onAudienceChange,
      subscribeAccountChanged: (listener) => {
        notifyAccountChanged = listener;
        return (): void => {};
      },
    });
    await settle();
    // The first account to load is not a switch.
    expect(onAudienceChange).not.toHaveBeenCalled();
    expect(preflight).toHaveBeenCalledTimes(1);

    click('[data-testid="share-skill-scope-team"]');
    await settle();
    click('[data-testid="share-skill-team-picker-option-team-1"]');
    await settle();
    const audienceChangesBefore = onAudienceChange.mock.calls.length;
    const loadsBefore = listTeams.mock.calls.length;

    await act(async () => {
      notifyAccountChanged();
      await Promise.resolve();
    });
    await settle();

    expect(onAudienceChange.mock.calls.length).toBe(audienceChangesBefore + 1);
    expect(preflight).toHaveBeenCalledTimes(2);
    expect(listTeams.mock.calls.length).toBeGreaterThan(loadsBefore);
    expect(
      document
        .querySelector('[data-testid="share-skill-team-picker-option-team-1"]')
        ?.getAttribute('aria-pressed'),
    ).toBe('false');
    expect(
      document.querySelector<HTMLButtonElement>(
        '[data-testid="share-skill-submit"]',
      )?.disabled,
    ).toBe(true);
  });

  it('keeps its options mounted while the same account is read again', async () => {
    let notifyAccountChanged: () => void = () => {};
    let resolveReread: (account: ShareResourceAccount) => void = () => {};
    const loadAccount = jest
      .fn<Promise<ShareResourceAccount>, []>()
      .mockResolvedValueOnce({ ...readyAccount, id: 'account-1' })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveReread = resolve;
          }),
      );
    renderDialog({
      loadAccount,
      subscribeAccountChanged: (listener) => {
        notifyAccountChanged = listener;
        return (): void => {};
      },
      extraOptions: <details data-testid="share-skill-options" />,
    });
    await settle();
    const options = document.querySelector<HTMLDetailsElement>(
      '[data-testid="share-skill-options"]',
    );
    expect(options).not.toBeNull();
    if (options) options.open = true;

    // An ambient re-read, or the dialog's own access check, must not swap the
    // options for the loading line: that would close what the author opened.
    await act(async () => {
      notifyAccountChanged();
      await Promise.resolve();
    });
    expect(document.body.textContent).not.toContain('Loading account…');
    expect(document.querySelector('[data-testid="share-skill-options"]')).toBe(
      options,
    );
    // Nothing is shared against an account that is still being read.
    expect(
      document.querySelector<HTMLButtonElement>(
        '[data-testid="share-skill-submit"]',
      )?.disabled,
    ).toBe(true);

    await act(async () => {
      resolveReread({ ...readyAccount, id: 'account-1' });
      await Promise.resolve();
    });
    await settle();
    expect(document.querySelector('[data-testid="share-skill-options"]')).toBe(
      options,
    );
    expect(options?.open).toBe(true);
  });

  it('keeps the form when a re-read fails', async () => {
    let notifyAccountChanged: () => void = () => {};
    const loadAccount = jest
      .fn<Promise<ShareResourceAccount>, []>()
      .mockResolvedValueOnce({ ...readyAccount, id: 'account-1' })
      .mockRejectedValueOnce(new Error('offline'));
    renderDialog({
      loadAccount,
      subscribeAccountChanged: (listener) => {
        notifyAccountChanged = listener;
        return (): void => {};
      },
      extraOptions: <details data-testid="share-skill-options" />,
    });
    await settle();
    const options = document.querySelector(
      '[data-testid="share-skill-options"]',
    );

    await act(async () => {
      notifyAccountChanged();
      await Promise.resolve();
    });
    await settle();

    expect(loadAccount).toHaveBeenCalledTimes(2);
    expect(document.querySelector('[data-testid="share-skill-options"]')).toBe(
      options,
    );
    expect(document.body.textContent).not.toContain(
      'Connect a cloud account to share this skill.',
    );
  });

  it('applies only the latest of overlapping account reads', async () => {
    let notifyAccountChanged: () => void = () => {};
    const resolvers: Array<(account: ShareResourceAccount) => void> = [];
    const loadAccount = jest
      .fn<Promise<ShareResourceAccount>, []>()
      .mockResolvedValueOnce({ ...readyAccount, id: 'account-1' })
      .mockImplementation(
        () =>
          new Promise((resolve) => {
            resolvers.push(resolve);
          }),
      );
    renderDialog({
      loadAccount,
      subscribeAccountChanged: (listener) => {
        notifyAccountChanged = listener;
        return (): void => {};
      },
    });
    await settle();
    const submit = (): HTMLButtonElement | null =>
      document.querySelector<HTMLButtonElement>(
        '[data-testid="share-skill-submit"]',
      );
    click('[data-testid="share-skill-scope-public"]');
    await settle();
    expect(submit()?.disabled).toBe(false);

    await act(async () => {
      notifyAccountChanged();
      notifyAccountChanged();
      await Promise.resolve();
    });
    // The earlier read settling first must not end the later one's wait.
    await act(async () => {
      resolvers[0]?.({ ...readyAccount, id: 'account-1' });
      await Promise.resolve();
    });
    await settle();
    expect(submit()?.disabled).toBe(true);

    await act(async () => {
      resolvers[1]?.({ ...readyAccount, id: 'account-1' });
      await Promise.resolve();
    });
    await settle();
    expect(submit()?.disabled).toBe(false);
  });

  it('keeps the pills and explains the upgrade in a tooltip when capabilities leave only Public usable', async () => {
    renderDialog({
      loadAccount: jest.fn().mockResolvedValue({
        connected: true,
        capabilities: ['skills-crud-v1'],
      }),
    });
    await settle();

    expect(
      document.querySelector('[data-testid="share-skill-scope"]'),
    ).not.toBeNull();
    expect(scopeOption('team')?.getAttribute('aria-disabled')).toBe('true');
    expect(scopeOption('public')?.getAttribute('aria-checked')).toBe('true');
    // The upgrade reason is on the disabled pill, not under the selector.
    expect(
      document.querySelector('[data-testid="share-skill-scope-upgrade-hint"]'),
    ).toBeNull();
    expect(document.body.textContent).not.toContain('must be upgraded');
    hover('[data-testid="share-skill-scope-organization"]');
    expect(
      document.querySelector(
        '[data-testid="share-skill-scope-organization-reason"]',
      )?.textContent,
    ).toContain('must be upgraded');
  });

  it('hides the share form when the account lacks the resource capability', async () => {
    renderDialog({
      loadAccount: jest
        .fn()
        .mockResolvedValue({ connected: true, capabilities: [] }),
      copy: {
        missingCapability: 'This account does not support shared skills.',
      },
    });
    await settle();

    expect(document.body.textContent).toContain(
      'This account does not support shared skills.',
    );
    expect(
      document.querySelector('[data-testid="share-skill-submit"]'),
    ).toBeNull();
  });

  it('dismisses through the header Close rather than a footer Cancel', async () => {
    const onClose = jest.fn();
    renderDialog({ onClose });
    await settle();

    expect(
      document.querySelector('[data-testid="share-skill-cancel"]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-testid="share-skill-submit"]'),
    ).not.toBeNull();

    click('button[aria-label="Close"]');
    await settle();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders no footer actions while the account cannot share', async () => {
    renderDialog({
      loadAccount: jest
        .fn()
        .mockResolvedValue({ connected: false, capabilities: [] }),
    });
    await settle();

    const buttons = Array.from(document.querySelectorAll('button'));
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.getAttribute('aria-label')).toBe('Close');
  });

  it('reports a failed share with the resource-specific prefix', async () => {
    renderDialog({
      share: jest.fn().mockRejectedValue(new Error('Cloud rejected it.')),
    });
    await settle();

    click('[data-testid="share-skill-scope-public"]');
    await settle();
    click('[data-testid="share-skill-submit"]');
    await settle();

    expect(document.body.textContent).toContain(
      'Failed to share skill. Cloud rejected it.',
    );
  });

  it('completes and stays open on the success notice until Done', async () => {
    const onShareSucceeded = jest.fn();
    const onCompleted = jest.fn();
    const onClose = jest.fn();
    const notify = jest.fn();
    renderDialog({ onShareSucceeded, onCompleted, onClose, notify });
    await settle();

    click('[data-testid="share-skill-scope-public"]');
    await settle();
    click('[data-testid="share-skill-submit"]');
    await settle();

    expect(onShareSucceeded).toHaveBeenCalledTimes(1);
    expect(onCompleted).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(successText()).toBe('Skill is now public');
    // The landed audience is locked; Done (or the X) closes the dialog.
    expect(
      document.querySelector<HTMLFieldSetElement>(
        '[data-testid="share-skill-form"]',
      )?.disabled,
    ).toBe(false);
    expect(
      document.querySelector<HTMLButtonElement>(
        '[data-testid="share-skill-scope-team"]',
      )?.disabled,
    ).toBe(true);
    click('[data-testid="share-skill-done"]');
    await settle();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onCompleted).toHaveBeenCalledTimes(1);
  });

  it('uses the canonical sentence-case title and test ids', async () => {
    renderDialog({ subtitle: 'deploy' });
    await settle();
    expect(document.body.textContent).toContain('Share skill');
    expect(document.body.textContent).toContain('deploy');
    for (const id of [
      'share-skill-modal',
      'share-skill-scope',
      'share-skill-scope-team',
      'share-skill-submit',
    ]) {
      expect(document.querySelector(`[data-testid="${id}"]`)).not.toBeNull();
    }
    expect(
      document.querySelector('[data-testid="share-skill-confirm"]'),
    ).toBeNull();
  });

  it('hides the selector but keeps the helper when a single audience is offered', async () => {
    const share = jest.fn().mockResolvedValue({});
    renderDialog({ scopes: ['public'], share });
    await settle();
    expect(document.querySelector('[data-testid="share-skill-scope"]')).toBe(
      null,
    );
    // One audience is not a choice, but the dialog still says who can see
    // the share and where it appears.
    expect(
      document.querySelector('[data-testid="share-skill-scope-description"]')
        ?.textContent,
    ).toBe(
      'Anyone can view this skill. It may appear in public discovery and search.',
    );
    click('[data-testid="share-skill-submit"]');
    await settle();
    expect(share).toHaveBeenCalledWith({ scope: 'public' });
  });

  describe('where a share appears', () => {
    function scopeText(): string {
      return (
        document.querySelector('[data-testid="share-skill-scope"]')
          ?.textContent ?? ''
      );
    }

    it('says nothing under Team or Organization for a resource with no shared list', async () => {
      renderDialog();
      await settle();
      expect(scopeText()).not.toMatch(/Customize|Marketplace/);
      click('[data-testid="share-skill-scope-organization"]');
      await settle();
      expect(scopeText()).not.toMatch(/Customize|Marketplace/);
    });

    it('names Customize under Team, then the picked team', async () => {
      renderDialog({ landing: 'marketplace' });
      await settle();
      expect(scopeText()).toContain(
        'Team members can find this skill in Customize.',
      );
      click('[data-testid="share-skill-team-picker-option-team-1"]');
      await settle();
      expect(scopeText()).toContain(
        'Members of Platform can find this skill in Customize.',
      );
    });

    it('names Customize under Organization, then the picked organization', async () => {
      renderDialog({
        landing: 'marketplace',
        listOrganizations: jest.fn().mockResolvedValue(organizations),
      });
      await settle();
      click('[data-testid="share-skill-scope-organization"]');
      await settle();
      expect(scopeText()).toContain(
        'Everyone in the organization can find this skill in Customize.',
      );
      click('[data-testid="share-skill-organization-picker-option-org-2"]');
      await settle();
      expect(scopeText()).toContain(
        'Everyone in Beta can find this skill in Customize.',
      );
    });

    it('keeps the public disclosure under Public', async () => {
      renderDialog({ landing: 'marketplace' });
      await settle();
      click('[data-testid="share-skill-scope-public"]');
      await settle();
      expect(scopeText()).toContain(
        'Anyone can view this skill. It may appear in public discovery and search.',
      );
      expect(scopeText()).not.toMatch(/Customize|Marketplace/);
    });

    it('lets a host replace an audience helper', async () => {
      renderDialog({
        landing: 'marketplace',
        audienceDescriptions: { team: 'Only this team can run it.' },
      });
      await settle();
      expect(scopeText()).toContain('Only this team can run it.');
      expect(scopeText()).not.toMatch(/Customize|Marketplace/);
    });
  });

  it('keeps the team selected when a team share with a public link switches back to Team', async () => {
    const share = jest.fn().mockResolvedValue({});
    renderDialog({
      share,
      existingShare: {
        audience: 'public',
        target: team,
        targetAudience: 'team',
      },
    });
    await settle();
    expect(
      document
        .querySelector('[data-testid="share-skill-scope-public"]')
        ?.getAttribute('aria-checked'),
    ).toBe('true');

    click('[data-testid="share-skill-scope-team"]');
    await settle();
    // The share's own team is still the selection: no re-pick needed.
    click('[data-testid="share-skill-submit"]');
    await settle();
    expect(share).toHaveBeenCalledWith({
      scope: 'team',
      teamId: 'team-1',
      targetName: 'Platform',
    });
  });

  it('renders the connect gate for a guest account', async () => {
    const onConnect = jest.fn();
    renderDialog({
      loadAccount: jest
        .fn()
        .mockResolvedValue({ ...readyAccount, kind: 'guest' }),
      onConnect,
    });
    await settle();
    expect(
      document.querySelector('[data-testid="share-skill-guest-cta"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('[data-testid="share-skill-submit"]'),
    ).toBeNull();
    click('[data-testid="share-skill-guest-cta-button"]');
    expect(onConnect).toHaveBeenCalledTimes(1);
  });

  it('offers a trial to a guest when the host reports no free access', async () => {
    renderDialog({
      loadAccount: jest
        .fn()
        .mockResolvedValue({ ...readyAccount, kind: 'guest' }),
      onConnect: jest.fn(),
    });
    await settle();
    expect(
      document.querySelector('[data-testid="share-skill-guest-cta"]')
        ?.textContent,
    ).toContain('Create a free account to share this skill.');
    expect(
      document.querySelector('[data-testid="share-skill-guest-cta-button"]')
        ?.textContent,
    ).toBe('Start free trial');
  });

  it('asks a guest to sign in instead of starting a trial under free access', async () => {
    renderDialog({
      freeAccess: true,
      loadAccount: jest
        .fn()
        .mockResolvedValue({ ...readyAccount, kind: 'guest' }),
      onConnect: jest.fn(),
    });
    await settle();
    expect(
      document.querySelector('[data-testid="share-skill-guest-cta"]')
        ?.textContent,
    ).toContain('Create a free account to share this skill.');
    expect(
      document.querySelector('[data-testid="share-skill-guest-cta-button"]')
        ?.textContent,
    ).toBe('Sign in');
    expect(document.body.textContent).not.toContain('trial');
  });

  it('keeps a host guest-action override under free access', async () => {
    renderDialog({
      freeAccess: true,
      copy: { guestAction: 'Connect' },
      loadAccount: jest
        .fn()
        .mockResolvedValue({ ...readyAccount, kind: 'guest' }),
      onConnect: jest.fn(),
    });
    await settle();
    expect(
      document.querySelector('[data-testid="share-skill-guest-cta-button"]')
        ?.textContent,
    ).toBe('Connect');
  });

  it('shows no upgrade hint when the account has every sharing capability', async () => {
    // Free access grants every capability, and the server advertises the
    // team and organization capabilities to every signed-in account, so the
    // "must be upgraded" hint has nothing to explain.
    renderDialog({
      freeAccess: true,
      loadAccount: jest.fn().mockResolvedValue({
        ...readyAccount,
        hasOrganization: true,
        hasTeam: true,
      }),
      listOrganizations: jest.fn().mockResolvedValue(organizations),
    });
    await settle();
    expect(
      document.querySelector('[data-testid="share-skill-scope"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('[data-testid="share-skill-scope-upgrade-hint"]'),
    ).toBeNull();
    expect(document.body.textContent).not.toContain('must be upgraded');
  });

  it('preselects an existing share and updates it in place', async () => {
    const share = jest.fn().mockResolvedValue({});
    const notify = jest.fn();
    renderDialog({
      share,
      notify,
      existingShare: { audience: 'team', target: team },
    });
    await settle();

    expect(
      document
        .querySelector('[data-testid="share-skill-scope-team"]')
        ?.getAttribute('aria-checked'),
    ).toBe('true');
    const submit = document.querySelector<HTMLButtonElement>(
      '[data-testid="share-skill-submit"]',
    );
    expect(submit?.textContent).toBe('Update');
    expect(submit?.disabled).toBe(false);

    click('[data-testid="share-skill-submit"]');
    await settle();
    expect(share).toHaveBeenCalledWith({
      scope: 'team',
      teamId: 'team-1',
      targetName: 'Platform',
    });
    expect(notify).not.toHaveBeenCalled();
    expect(successText()).toBe('Skill updated');
  });

  it('preserves a solo account Personal share audience and organization UUID on update', async () => {
    const personalId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const share = jest.fn().mockResolvedValue({});
    const listOrganizations = jest.fn().mockResolvedValue([]);
    renderDialog(
      {
        context: { kind: 'personal' },
        loadAccount: jest.fn().mockResolvedValue({
          connected: true,
          capabilities: ['skills-crud-v1'],
          hasOrganization: false,
          hasTeam: false,
        }),
        existingShare: {
          audience: 'organization',
          targetAudience: 'organization',
          target: { id: personalId, name: 'Stored owner name' },
        },
        share,
        listOrganizations,
      },
      personalId,
    );
    await settle();

    click('[data-testid="share-skill-submit"]');
    await settle();
    expect(share).toHaveBeenCalledWith({
      scope: 'organization',
      organizationId: personalId,
      targetName: 'Personal',
    });
    expect(listOrganizations).not.toHaveBeenCalled();
  });

  it('maps a conflict to the standard conflict copy', async () => {
    renderDialog({
      share: jest.fn().mockRejectedValue(new ShareConflictError()),
      existingShare: { audience: 'public' },
    });
    await settle();
    click('[data-testid="share-skill-submit"]');
    await settle();
    expect(
      document.querySelector('[data-testid="share-skill-error"]')?.textContent,
    ).toBe(shareResourceCopy('skill').conflict);
  });

  it('replaces the body with the unavailable card when preflight blocks', async () => {
    const onClick = jest.fn();
    renderDialog({
      preflight: jest.fn().mockResolvedValue({
        status: 'blocked',
        body: <p>This run is still going.</p>,
        action: { label: 'Upgrade', onClick },
      }),
    });
    await settle();
    expect(
      document.querySelector('[data-testid="share-skill-unavailable"]')
        ?.textContent,
    ).toContain('This run is still going.');
    expect(
      document.querySelector('[data-testid="share-skill-scope"]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-testid="share-skill-submit"]'),
    ).toBeNull();
    click('[data-testid="share-skill-unavailable-action"]');
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('reruns a blocked preflight when its standard Retry action is selected', async () => {
    const preflight = jest
      .fn()
      .mockResolvedValueOnce({
        status: 'blocked',
        body: <p>The existing share could not be loaded.</p>,
        action: { label: 'Retry', retry: true },
      })
      .mockResolvedValueOnce({ status: 'ready' });
    renderDialog({
      preflight: preflight as NonNullable<
        React.ComponentProps<typeof ShareResourceDialog>['preflight']
      >,
    });
    await settle();

    click('[data-testid="share-skill-unavailable-action"]');
    await settle();

    expect(preflight).toHaveBeenCalledTimes(2);
    expect(
      document.querySelector('[data-testid="share-skill-scope"]'),
    ).not.toBeNull();
  });

  it('keeps a partial share open and shows the public link after the retry', async () => {
    const retryPublicLink = jest
      .fn()
      .mockResolvedValue({ shareUrl: 'https://cloud.test/s/skills/abc' });
    const onClose = jest.fn();
    const onCompleted = jest.fn();
    const notify = jest.fn();
    renderDialog({
      share: jest.fn().mockResolvedValue({ publicLinkFailed: true }),
      retryPublicLink,
      onClose,
      onCompleted,
      notify,
    });
    await settle();
    click('[data-testid="share-skill-scope-public"]');
    await settle();
    click('[data-testid="share-skill-submit"]');
    await settle();
    expect(onClose).not.toHaveBeenCalled();
    expect(
      document.querySelector('[data-testid="share-skill-partial"]')
        ?.textContent,
    ).toContain("Skill saved, but the public link couldn't be created.");
    // The share landed: Cancel reads Done, the primary retries the link.
    expect(
      document.querySelector('[data-testid="share-skill-done"]')?.textContent,
    ).toBe('Done');
    expect(
      document.querySelector('[data-testid="share-skill-retry-public"]')
        ?.textContent,
    ).toBe('Retry public link');

    click('[data-testid="share-skill-retry-public"]');
    await settle();
    expect(retryPublicLink).toHaveBeenCalledTimes(1);
    expect(onCompleted).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(
      document.querySelector('[data-testid="share-skill-partial"]'),
    ).toBeNull();
    expect(successText()).toContain('Skill is now public');
    expect(
      document.querySelector('[data-testid="share-skill-link"]')?.textContent,
    ).toBe('https://cloud.test/s/skills/abc');
  });

  it('keeps Retry available and shows the reason when public-link retry fails', async () => {
    const retryPublicLink = jest
      .fn()
      .mockRejectedValue(new Error('The publishing service is unavailable.'));
    renderDialog({
      share: jest.fn().mockResolvedValue({ publicLinkFailed: true }),
      retryPublicLink,
    });
    await settle();
    click('[data-testid="share-skill-scope-public"]');
    await settle();
    click('[data-testid="share-skill-submit"]');
    await settle();

    click('[data-testid="share-skill-retry-public"]');
    await settle();

    expect(
      document.querySelector('[data-testid="share-skill-partial"]')
        ?.textContent,
    ).toContain('The publishing service is unavailable.');
    expect(
      document.querySelector('[data-testid="share-skill-retry-public"]'),
    ).not.toBeNull();
  });

  it('runs completion when Done dismisses a partial share', async () => {
    const onClose = jest.fn();
    const onCompleted = jest.fn();
    const notify = jest.fn();
    renderDialog({
      share: jest.fn().mockResolvedValue({ publicLinkFailed: true }),
      onClose,
      onCompleted,
      notify,
    });
    await settle();
    click('[data-testid="share-skill-scope-public"]');
    await settle();
    click('[data-testid="share-skill-submit"]');
    await settle();
    click('[data-testid="share-skill-done"]');
    await settle();
    expect(onCompleted).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();
  });

  it('blocks dismissal while a public-link retry is pending', async () => {
    let resolveRetry: ((outcome: { shareUrl: string }) => void) | undefined;
    const retryPublicLink = jest.fn(
      () =>
        new Promise<{ shareUrl: string }>((resolve) => {
          resolveRetry = resolve;
        }),
    );
    const onCompleted = jest.fn();
    const onClose = jest.fn();
    renderDialog({
      share: jest.fn().mockResolvedValue({ publicLinkFailed: true }),
      retryPublicLink,
      onCompleted,
      onClose,
    });
    await settle();
    click('[data-testid="share-skill-scope-public"]');
    await settle();
    click('[data-testid="share-skill-submit"]');
    await settle();

    click('[data-testid="share-skill-retry-public"]');
    await settle();
    const done = document.querySelector<HTMLButtonElement>(
      '[data-testid="share-skill-done"]',
    );
    expect(done?.disabled).toBe(true);
    click('[data-testid="share-skill-done"]');
    await settle();
    expect(onCompleted).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => {
      resolveRetry?.({ shareUrl: 'https://cloud.test/s/skills/retried' });
      await Promise.resolve();
      await Promise.resolve();
    });
    // A successful retry completes the share and shows its success notice.
    expect(onCompleted).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(successText()).toContain('Skill is now public');
  });

  it('preselects Public when it is the only usable audience', async () => {
    const share = jest.fn().mockResolvedValue({});
    renderDialog({
      share,
      loadAccount: jest.fn().mockResolvedValue({
        connected: true,
        capabilities: ['skills-crud-v1'],
      }),
    });
    await settle();

    // Team and Organization are unavailable, so the one usable scope is
    // picked for the author instead of leaving Share disabled for a reason
    // the dialog never states. The disabled pills stay, so the choice shows.
    expect(scopeOption('public')?.getAttribute('aria-checked')).toBe('true');
    expect(scopeOption('team')?.getAttribute('aria-disabled')).toBe('true');
    const submit = (): HTMLButtonElement | null =>
      document.querySelector<HTMLButtonElement>(
        '[data-testid="share-skill-submit"]',
      );
    expect(submit()?.disabled).toBe(false);
    click('[data-testid="share-skill-submit"]');
    await settle();
    expect(share).toHaveBeenCalledWith({ scope: 'public' });
  });

  it('ignores a Private existing share and opens as a first share', async () => {
    renderDialog({ existingShare: { audience: 'private' } });
    await settle();
    expect(
      document
        .querySelector('[data-testid="share-skill-scope-team"]')
        ?.getAttribute('aria-checked'),
    ).toBe('true');
  });

  describe('for an account with no organization', () => {
    it('returns to the original resource with the promoted team selected and clears completed recovery after context refresh', async () => {
      localStorage.clear();
      const personal = '11111111-1111-4111-8111-111111111111';
      const replacement = '22222222-2222-4222-8222-222222222222';
      const share = jest.fn().mockResolvedValue({});
      const loadAccount = jest.fn().mockResolvedValue({
        ...readyAccount,
        id: 'account-1',
        personalOrganizationId: personal,
        hasOrganization: false,
      });
      const port: PersonalOrganizationUpgradePort = {
        canPromote: true,
        canInvite: false,
        canBringProjects: false,
        promote: jest.fn((request) =>
          Promise.resolve({
            promotion: {
              organizationId: personal,
              personalOrganizationId: replacement,
              operationId: request.operationId,
              name: 'Acme',
              alreadyUpgraded: false,
              warnings: [],
            },
            contextSwitched: false,
            warnings: [],
          }),
        ),
        invite: jest.fn(),
        listProjects: jest.fn(),
        convert: jest.fn(),
        status: jest.fn(),
      };
      const props = {
        loadAccount,
        share,
        personalOrganizationUpgradePort: port,
        listOrganizations: jest
          .fn()
          .mockResolvedValue([{ id: personal, name: 'Acme' }]),
      };
      renderDialog({ ...props, context: { kind: 'personal' } }, personal);
      await settle();
      hover('[data-testid="share-skill-scope-team"]');
      act(() => click('[data-testid="share-skill-set-up-organization"]'));
      await settle();
      const input = document.querySelector<HTMLInputElement>(
        '[data-testid="invite-to-organization-team-name"]',
      );
      act(() => {
        Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          'value',
        )?.set?.call(input, 'Acme');
        input?.dispatchEvent(new Event('input', { bubbles: true }));
        click('[data-testid="invite-to-organization-consent"] input');
      });
      act(() => click('[data-testid="invite-to-organization-submit"]'));
      await settle();
      expect(
        document.querySelector(
          '[data-testid="invite-to-organization-team-created"]',
        ),
      ).not.toBeNull();
      loadAccount.mockResolvedValue({
        ...readyAccount,
        id: 'account-1',
        personalOrganizationId: replacement,
        hasOrganization: true,
      });
      renderDialog(
        {
          ...props,
          context: { kind: 'organization', organizationId: personal },
        },
        replacement,
      );
      await settle();
      act(() => {
        document.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
        );
      });
      await settle();
      expect(
        localStorage.getItem(
          'canopy.personal-organization-upgrade.v1:account-1',
        ),
      ).toBeNull();
      act(() => click('[data-testid="share-skill-submit"]'));
      await settle();
      expect(share).toHaveBeenCalledWith({
        scope: 'organization',
        organizationId: personal,
        targetName: 'Acme',
      });
      expect(port.promote).toHaveBeenCalledTimes(1);
    });

    it('opens inline team setup and keeps the resource dialog mounted for returning', async () => {
      const personal = '11111111-1111-4111-8111-111111111111';
      const fallback = jest.fn().mockResolvedValue(true);
      renderDialog(
        {
          context: { kind: 'personal' },
          loadAccount: jest.fn().mockResolvedValue({
            ...readyAccount,
            id: 'account-1',
            personalOrganizationId: personal,
            hasOrganization: false,
            hasTeam: false,
          }),
          onSetUpOrganization: fallback,
          personalOrganizationUpgradePort: {
            canPromote: true,
            canInvite: true,
            canBringProjects: false,
            promote: jest.fn(),
            invite: jest.fn(),
            listProjects: jest.fn(),
            convert: jest.fn(),
            status: jest.fn(),
          },
        },
        personal,
      );
      await settle();
      hover('[data-testid="share-skill-scope-team"]');
      expect(
        document.querySelector(
          '[data-testid="share-skill-set-up-organization"]',
        )?.textContent,
      ).toBe('Create a team');
      act(() => click('[data-testid="share-skill-set-up-organization"]'));
      await settle();
      expect(
        document.querySelector(
          '[data-testid="invite-to-organization-team-name"]',
        ),
      ).not.toBeNull();
      expect(fallback).not.toHaveBeenCalled();
      act((): void => {
        document.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
        );
      });
      await settle();
      hover('[data-testid="share-skill-scope-team"]');
      expect(
        document.querySelector(
          '[data-testid="share-skill-set-up-organization"]',
        ),
      ).not.toBeNull();
    });

    it('no team: pills shown, Team/Org disabled with tooltip, Public preselected', async () => {
      const personal = '11111111-1111-4111-8111-111111111111';
      renderDialog(
        {
          context: { kind: 'personal' },
          loadAccount: jest.fn().mockResolvedValue({
            ...readyAccount,
            id: 'account-1',
            personalOrganizationId: personal,
            hasOrganization: false,
            hasTeam: false,
          }),
          personalOrganizationUpgradePort: {
            canPromote: true,
            canInvite: true,
            canBringProjects: false,
            promote: jest.fn(),
            invite: jest.fn(),
            listProjects: jest.fn(),
            convert: jest.fn(),
            status: jest.fn(),
          },
        },
        personal,
      );
      await settle();

      // Every scope stays visible; the ineligible ones are disabled.
      expect(
        document.querySelector('[data-testid="share-skill-scope"]'),
      ).not.toBeNull();
      expect(scopeOption('team')?.getAttribute('aria-disabled')).toBe('true');
      expect(scopeOption('organization')?.getAttribute('aria-disabled')).toBe(
        'true',
      );
      expect(scopeOption('public')?.getAttribute('aria-checked')).toBe('true');
      // No inline team block: the explanation lives on the Team pill.
      expect(document.body.textContent).not.toContain('Create a team to share');
      expect(
        document.querySelector(
          '[data-testid="share-skill-set-up-organization"]',
        ),
      ).toBeNull();

      hover('[data-testid="share-skill-scope-team"]');
      expect(
        document.querySelector('[data-testid="share-skill-scope-team-reason"]')
          ?.textContent,
      ).toBe('Create a team to share this skill with teammates.');
      expect(
        document.querySelector(
          '[data-testid="share-skill-set-up-organization"]',
        )?.textContent,
      ).toBe('Create a team');
      expect(
        document.querySelector<HTMLButtonElement>(
          '[data-testid="share-skill-submit"]',
        )?.disabled,
      ).toBe(false);

      // Activating the disabled pill never selects it; it opens the team
      // setup, so keyboard and touch users reach the step without the tooltip.
      click('[data-testid="share-skill-scope-team"]');
      await settle();
      expect(
        document.querySelector(
          '[data-testid="invite-to-organization-team-name"]',
        ),
      ).not.toBeNull();
    });
    const soloAccount: ShareResourceAccount = {
      ...readyAccount,
      hasOrganization: false,
      hasTeam: false,
    };

    it('replaces the selector with the organization setup statement when nothing is usable', async () => {
      const onSetUpOrganization = jest.fn().mockResolvedValue(true);
      renderDialog({
        resourceNoun: 'plan',
        testIdPrefix: 'share-plan',
        scopes: ['team', 'organization'],
        loadAccount: jest.fn().mockResolvedValue(soloAccount),
        onSetUpOrganization,
      });
      await settle();

      expect(
        document.querySelector(
          '[data-testid="share-plan-organization-required"]',
        )?.textContent,
      ).toContain(
        'Plans are shared with a team or organization. Set one up to start sharing.',
      );
      expect(document.querySelector('[data-testid="share-plan-scope"]')).toBe(
        null,
      );
      expect(document.querySelector('[data-testid="share-plan-submit"]')).toBe(
        null,
      );

      click('[data-testid="share-plan-set-up-organization"]');
      await settle();
      expect(onSetUpOrganization).toHaveBeenCalledTimes(1);
      expect(
        document.querySelector(
          '[data-testid="share-plan-set-up-organization-error"]',
        ),
      ).toBeNull();
    });

    it('keeps the setup button and explains a failed handoff', async () => {
      const onSetUpOrganization = jest
        .fn()
        .mockResolvedValueOnce(false)
        .mockRejectedValueOnce(new Error('offline'));
      renderDialog({
        scopes: ['team', 'organization'],
        loadAccount: jest.fn().mockResolvedValue(soloAccount),
        onSetUpOrganization,
      });
      await settle();

      click('[data-testid="share-skill-set-up-organization"]');
      await settle();
      expect(
        document.querySelector(
          '[data-testid="share-skill-set-up-organization-error"]',
        )?.textContent,
      ).toBe('Could not open that page. Try again.');
      expect(
        document.querySelector(
          '[data-testid="share-skill-set-up-organization"]',
        ),
      ).not.toBeNull();

      click('[data-testid="share-skill-set-up-organization"]');
      await settle();
      expect(onSetUpOrganization).toHaveBeenCalledTimes(2);
      expect(
        document.querySelector(
          '[data-testid="share-skill-set-up-organization-error"]',
        ),
      ).not.toBeNull();
    });

    it('keeps the pills, disables Team and Organization with a tooltip, and preselects Public', async () => {
      const onSetUpOrganization = jest.fn().mockResolvedValue(true);
      renderDialog({
        loadAccount: jest.fn().mockResolvedValue(soloAccount),
        onSetUpOrganization,
      });
      await settle();

      expect(
        document.querySelector('[data-testid="share-skill-scope"]'),
      ).not.toBeNull();
      expect(scopeOption('team')?.getAttribute('aria-disabled')).toBe('true');
      expect(scopeOption('organization')?.getAttribute('aria-disabled')).toBe(
        'true',
      );
      expect(scopeOption('public')?.getAttribute('aria-checked')).toBe('true');
      // The setup hint moved into the pills' tooltip.
      expect(
        document.querySelector('[data-testid="share-skill-organization-hint"]'),
      ).toBeNull();
      expect(
        document.querySelector(
          '[data-testid="share-skill-set-up-organization"]',
        ),
      ).toBeNull();
      expect(document.body.textContent).not.toContain('must be upgraded');

      hover('[data-testid="share-skill-scope-organization"]');
      expect(
        document.querySelector(
          '[data-testid="share-skill-scope-organization-reason"]',
        )?.textContent,
      ).toBe('Team and organization sharing start with an organization.');
      click('[data-testid="share-skill-set-up-organization"]');
      await settle();
      expect(onSetUpOrganization).toHaveBeenCalledTimes(1);
      // Public is ready to share without an extra click.
      expect(
        document.querySelector<HTMLButtonElement>(
          '[data-testid="share-skill-submit"]',
        )?.disabled,
      ).toBe(false);
    });
  });

  it('disables only Team for an organization member with no teams', async () => {
    renderDialog({
      loadAccount: jest.fn().mockResolvedValue({
        ...readyAccount,
        hasOrganization: true,
        hasTeam: false,
      }),
      onSetUpOrganization: jest.fn().mockResolvedValue(true),
    });
    await settle();

    expect(scopeOption('team')?.getAttribute('aria-disabled')).toBe('true');
    expect(scopeOption('organization')?.disabled).toBe(false);
    expect(scopeOption('organization')?.hasAttribute('aria-disabled')).toBe(
      false,
    );
    expect(scopeOption('organization')?.getAttribute('aria-checked')).toBe(
      'true',
    );
    expect(
      document.querySelector('[data-testid="share-skill-organization-hint"]'),
    ).toBeNull();
    // The disabled Team option says why, in its tooltip.
    hover('[data-testid="share-skill-scope-team"]');
    expect(
      document.querySelector('[data-testid="share-skill-scope-team-reason"]')
        ?.textContent,
    ).toBe('Team sharing starts with a team in your organization.');
    expect(document.body.textContent).not.toContain('must be upgraded');
  });

  describe('Remove public link', () => {
    const link = {
      url: 'https://cloud.test/s/skills/abc',
      kind: 'public',
    } as const;

    it('is offered only for an existing public share with a revoke port', async () => {
      renderDialog({
        existingShare: { audience: 'team', target: team },
        revokePublicLink: jest.fn().mockResolvedValue(undefined),
      });
      await settle();
      expect(
        document.querySelector(
          '[data-testid="share-skill-remove-public-link"]',
        ),
      ).toBeNull();

      renderDialog({ existingShare: { audience: 'public', link } });
      await settle();
      expect(
        document.querySelector(
          '[data-testid="share-skill-remove-public-link"]',
        ),
      ).toBeNull();
    });

    const confirmText = async (): Promise<string | null | undefined> => {
      click('[data-testid="share-skill-remove-public-link"]');
      await settle();
      return document.querySelector(
        '[data-testid="share-skill-remove-public-link-confirm"]',
      )?.textContent;
    };

    it('names the team that keeps access for a team-owned public share', async () => {
      renderDialog({
        existingShare: { audience: 'public', target: team, link },
        revokePublicLink: jest.fn().mockResolvedValue(undefined),
      });
      await settle();

      const text = await confirmText();
      expect(text).toContain(
        'People outside Platform who have the link will lose access. Platform members keep access, including through links they already have.',
      );
      expect(text).not.toContain('shared lists');
    });

    it('names the organization that keeps access, literally', async () => {
      const name = 'Acme & <Sons>, Inc.';
      renderDialog({
        existingShare: {
          audience: 'public',
          targetAudience: 'organization',
          target: { id: 'org-1', name },
          link,
        },
        revokePublicLink: jest.fn().mockResolvedValue(undefined),
      });
      await settle();

      expect(await confirmText()).toContain(
        `People outside ${name} who have the link will lose access. ${name} members keep access, including through links they already have.`,
      );
    });

    const personalId = '33333333-3333-4333-8333-333333333333';

    it('keeps the Personal context without naming it as a member group', async () => {
      renderDialog(
        {
          existingShare: {
            audience: 'public',
            targetAudience: 'organization',
            target: { id: personalId, name: 'Aaron’s organization' },
            link,
          },
          revokePublicLink: jest.fn().mockResolvedValue(undefined),
        },
        personalId,
      );
      await settle();

      const text = await confirmText();
      expect(text).toContain(
        'Anyone else with the link will lose access. It stays in your Personal context.',
      );
      expect(text).not.toContain('Aaron’s organization');
      expect(text).not.toContain('members');
    });

    it('names the current share, not the one it was first opened with', async () => {
      const revokePublicLink = jest.fn().mockResolvedValue(undefined);
      renderDialog(
        {
          existingShare: {
            audience: 'public',
            targetAudience: 'organization',
            target: { id: personalId, name: 'Aaron’s organization' },
            link,
          },
          revokePublicLink,
        },
        personalId,
      );
      await settle();
      expect(await confirmText()).toContain('Personal context');
      click('[data-testid="share-skill-remove-public-link-cancel"]');
      await settle();

      renderDialog(
        {
          existingShare: { audience: 'public', target: team, link },
          revokePublicLink,
        },
        personalId,
      );
      await settle();
      const text = await confirmText();
      expect(text).toContain('Platform members keep access');
      expect(text).not.toContain('Personal');
    });

    it('refreshes a named audience and clears it when reopened private-only', async () => {
      const revokePublicLink = jest.fn().mockResolvedValue(undefined);
      renderDialog({
        existingShare: { audience: 'public', target: team, link },
        revokePublicLink,
      });
      await settle();
      expect(await confirmText()).toContain('Platform members keep access');
      click('[data-testid="share-skill-remove-public-link-cancel"]');
      await settle();

      renderDialog({
        existingShare: {
          audience: 'public',
          targetAudience: 'organization',
          target: { id: 'org-2', name: 'Beta 研究 & Partners' },
          link,
        },
        revokePublicLink,
      });
      await settle();
      const updated = await confirmText();
      expect(updated).toContain('Beta 研究 & Partners members keep access');
      expect(updated).not.toContain('Platform');
      click('[data-testid="share-skill-remove-public-link-cancel"]');
      await settle();

      act(() => root.unmount());
      root = createRoot(container);
      renderDialog({
        existingShare: { audience: 'public', link },
        revokePublicLink,
      });
      await settle();
      const reopened = await confirmText();
      expect(reopened).toContain(
        "Anyone with the link will lose access, and it won't show up in shared lists anymore. You can share it again later.",
      );
      expect(reopened).not.toContain('Beta');
      expect(revokePublicLink).not.toHaveBeenCalled();
    });

    it('confirms, revokes, toasts and stays open on the unshared state', async () => {
      const onCompleted = jest.fn();
      const onClose = jest.fn();
      const notify = jest.fn();
      // Hosts clear their public share once the revoke lands.
      const revokePublicLink = jest.fn((): Promise<void> => {
        renderDialog({
          revokePublicLink,
          onCompleted,
          onClose,
          notify,
        });
        return Promise.resolve();
      });
      renderDialog({
        existingShare: { audience: 'public', link },
        revokePublicLink,
        onCompleted,
        onClose,
        notify,
      });
      await settle();

      click('[data-testid="share-skill-remove-public-link"]');
      await settle();
      expect(
        document.querySelector(
          '[data-testid="share-skill-remove-public-link-confirm"]',
        )?.textContent,
      ).toContain(
        "Anyone with the link will lose access, and it won't show up in shared lists anymore. You can share it again later.",
      );
      expect(revokePublicLink).not.toHaveBeenCalled();

      click('[data-testid="share-skill-remove-public-link-cancel"]');
      await settle();
      expect(
        document.querySelector(
          '[data-testid="share-skill-remove-public-link-confirm"]',
        ),
      ).toBeNull();
      expect(revokePublicLink).not.toHaveBeenCalled();

      click('[data-testid="share-skill-remove-public-link"]');
      await settle();
      click('[data-testid="share-skill-remove-public-link-confirm-action"]');
      await settle();
      expect(revokePublicLink).toHaveBeenCalledTimes(1);
      expect(onClose).not.toHaveBeenCalled();
      expect(onCompleted).not.toHaveBeenCalled();
      expect(notify).toHaveBeenCalledWith({
        tone: 'success',
        message: 'Public link removed',
      });
      // The dialog stays open on the unshared state: no published notice,
      // no remove control, and Share instead of Update.
      expect(
        document.querySelector('[data-testid="share-skill-modal"]'),
      ).not.toBeNull();
      expect(successText()).toBeUndefined();
      expect(
        document.querySelector(
          '[data-testid="share-skill-remove-public-link"]',
        ),
      ).toBeNull();
      expect(
        document.querySelector('[data-testid="share-skill-submit"]')
          ?.textContent,
      ).toBe('Share');
    });

    it('publish -> remove link -> close -> reopen -> publish again shows the remove-link control immediately', async () => {
      const url = 'https://cloud.test/s/skills/abc';
      const revokePublicLink = jest.fn().mockResolvedValue(undefined);
      const share = jest.fn().mockResolvedValue({ shareUrl: url });
      const onClose = jest.fn();
      const removeLink = (): Element | null =>
        document.querySelector(
          '[data-testid="share-skill-remove-public-link"]',
        );
      const publishPublicly = async (): Promise<void> => {
        click('[data-testid="share-skill-scope-public"]');
        await settle();
        click('[data-testid="share-skill-submit"]');
        await settle();
        expect(successText()).toContain('Skill is now public');
        expect(
          document.querySelector('[data-testid="share-skill-link"]')
            ?.textContent,
        ).toBe(url);
      };

      // First publish: the success notice already offers removal.
      renderDialog({ share, revokePublicLink, onClose });
      await settle();
      await publishPublicly();
      expect(removeLink()).not.toBeNull();

      click('[data-testid="share-skill-remove-public-link"]');
      await settle();
      click('[data-testid="share-skill-remove-public-link-confirm-action"]');
      await settle();
      expect(revokePublicLink).toHaveBeenCalledTimes(1);
      // The dialog stays open on the unshared state.
      expect(onClose).not.toHaveBeenCalled();
      expect(successText()).toBeUndefined();
      expect(removeLink()).toBeNull();

      // Reopen on the now-unpublished skill and publish it again.
      act(() => root.unmount());
      root = createRoot(container);
      renderDialog({ share, revokePublicLink, onClose });
      await settle();
      expect(removeLink()).toBeNull();
      await publishPublicly();
      expect(removeLink()).not.toBeNull();

      click('[data-testid="share-skill-remove-public-link"]');
      await settle();
      click('[data-testid="share-skill-remove-public-link-confirm-action"]');
      await settle();
      expect(revokePublicLink).toHaveBeenCalledTimes(2);
    });

    it('is not offered after a share whose public link failed', async () => {
      renderDialog({
        share: jest.fn().mockResolvedValue({ publicLinkFailed: true }),
        revokePublicLink: jest.fn().mockResolvedValue(undefined),
      });
      await settle();
      click('[data-testid="share-skill-scope-public"]');
      await settle();
      click('[data-testid="share-skill-submit"]');
      await settle();
      expect(
        document.querySelector(
          '[data-testid="share-skill-remove-public-link"]',
        ),
      ).toBeNull();
    });

    it('reports a failed removal and keeps the dialog open', async () => {
      renderDialog({
        existingShare: { audience: 'public', link },
        revokePublicLink: jest
          .fn()
          .mockRejectedValue(new Error('Cloud is down.')),
      });
      await settle();
      click('[data-testid="share-skill-remove-public-link"]');
      await settle();
      click('[data-testid="share-skill-remove-public-link-confirm-action"]');
      await settle();
      expect(
        document.querySelector('[data-testid="share-skill-error"]')
          ?.textContent,
      ).toBe('Could not remove the public link. Cloud is down.');
      expect(
        document.querySelector(
          '[data-testid="share-skill-remove-public-link"]',
        ),
      ).not.toBeNull();
    });

    it('drops a failed removal error once the author shares again', async () => {
      const errorText = (): string | null | undefined =>
        document.querySelector('[data-testid="share-skill-error"]')
          ?.textContent;
      renderDialog({
        existingShare: { audience: 'public', link },
        share: jest.fn().mockResolvedValue({ shareUrl: link.url }),
        revokePublicLink: jest
          .fn()
          .mockRejectedValue(new Error('Cloud is down.')),
      });
      await settle();
      click('[data-testid="share-skill-remove-public-link"]');
      await settle();
      click('[data-testid="share-skill-remove-public-link-confirm-action"]');
      await settle();
      expect(errorText()).toBe(
        'Could not remove the public link. Cloud is down.',
      );

      click('[data-testid="share-skill-submit"]');
      await settle();
      expect(successText()).toContain('Skill updated');
      expect(
        document.querySelector(
          '[data-testid="share-skill-remove-public-link"]',
        ),
      ).not.toBeNull();
      expect(errorText()).toBeUndefined();
    });
  });

  it('renders the dependencies note when the host has no package port', async () => {
    renderDialog({ packageUnavailableNote: true });
    await settle();
    expect(
      document.querySelector(
        '[data-testid="share-skill-dependencies-unavailable"]',
      )?.textContent,
    ).toBe(shareResourceCopy('skill').packageUnavailable);
  });

  describe('for an organization-owned share', () => {
    const personalId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const acmeId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const acme: ShareTargetSummary = { id: acmeId, name: 'Acme' };
    const acmeTeam: ShareTargetSummary = {
      id: 'team-1',
      name: 'Platform',
      organizationId: acmeId,
      secondaryLabel: 'Acme',
    };
    const organizationContext = {
      kind: 'organization',
      organizationId: acmeId,
    } as const;
    const organizationShare = {
      audience: 'organization',
      target: acme,
      targetAudience: 'organization',
    } as const;

    function renderOwned(
      overrides: Partial<Parameters<typeof ShareResourceDialog>[0]> = {},
      policy: {
        context?:
          | { kind: 'organization'; organizationId: string }
          | { kind: 'personal' };
        ready?: boolean;
        personalOrganizationId?: string | null;
      } = { context: organizationContext },
    ): void {
      act(() => {
        root.render(
          <ResourceContextProvider
            context={policy.context}
            personalOrganizationId={policy.personalOrganizationId ?? personalId}
            {...(policy.ready !== undefined ? { ready: policy.ready } : {})}
          >
            <ShareResourceDialog
              resourceNoun="skill"
              testIdPrefix="share-skill"
              requiredCapability="skills-crud-v1"
              scopes={['team', 'organization', 'public']}
              keepsOrganizationOwnership
              existingShare={organizationShare}
              loadAccount={jest.fn().mockResolvedValue(readyAccount)}
              listTeams={jest.fn().mockResolvedValue([acmeTeam])}
              listOrganizations={jest.fn().mockResolvedValue([acme])}
              share={jest.fn().mockResolvedValue({})}
              copyText={jest.fn().mockResolvedValue(true)}
              notify={jest.fn()}
              onClose={jest.fn()}
              {...overrides}
            />
          </ResourceContextProvider>,
        );
      });
    }

    function option(audience: string): HTMLButtonElement | null {
      return document.querySelector<HTMLButtonElement>(
        `[data-testid="share-skill-scope-${audience}"]`,
      );
    }

    function lockedHint(): Element | null {
      return document.querySelector(
        '[data-testid="share-skill-public-locked-hint"]',
      );
    }

    it('disables Public with an explanation and keeps the supported update', async () => {
      const share = jest.fn().mockResolvedValue({});
      renderOwned({ share });
      await settle();

      expect(option('public')?.disabled).toBe(true);
      expect(option('team')?.disabled).toBe(false);
      expect(option('organization')?.disabled).toBe(false);
      expect(option('organization')?.getAttribute('aria-checked')).toBe('true');
      expect(lockedHint()?.textContent).toBe(
        "Organization shares can't be made public yet.",
      );
      expect(option('public')?.getAttribute('aria-describedby')).toBe(
        lockedHint()?.id,
      );

      click('[data-testid="share-skill-submit"]');
      await settle();
      expect(share).toHaveBeenCalledWith({
        scope: 'organization',
        organizationId: acmeId,
        targetName: 'Acme',
      });
    });

    it('updates a team-owned share to its team without a targetAudience', async () => {
      const share = jest.fn().mockResolvedValue({});
      renderOwned({
        share,
        existingShare: { audience: 'team', target: acmeTeam },
      });
      await settle();

      expect(option('public')?.disabled).toBe(true);
      expect(lockedHint()).not.toBeNull();
      expect(option('team')?.getAttribute('aria-checked')).toBe('true');
      click('[data-testid="share-skill-submit"]');
      await settle();
      expect(share).toHaveBeenCalledWith({
        scope: 'team',
        teamId: 'team-1',
        targetName: 'Platform',
      });
    });

    it('selects a legacy public team owner from its parent without targetAudience', async () => {
      const share = jest.fn().mockResolvedValue({});
      renderOwned({
        share,
        existingShare: { audience: 'public', target: acmeTeam },
      });
      await settle();
      expect(option('public')?.disabled).toBe(true);
      expect(option('team')?.getAttribute('aria-checked')).toBe('true');
      click('[data-testid="share-skill-submit"]');
      await settle();
      expect(share).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: 'team',
          teamId: acmeTeam.id,
          preservePublicLink: true,
        }),
      );
    });

    it('keeps disabled Public and its explanation when only one audience is usable', async () => {
      renderOwned({
        loadAccount: jest.fn().mockResolvedValue({
          connected: true,
          capabilities: ['skills-crud-v1', 'organizations-v1'],
        }),
      });
      await settle();

      // Team needs an upgrade, explained in its tooltip; Public's reason is
      // the locked hint under the selector.
      expect(option('team')?.getAttribute('aria-disabled')).toBe('true');
      expect(option('organization')?.disabled).toBe(false);
      expect(option('public')?.disabled).toBe(true);
      expect(lockedHint()).not.toBeNull();
    });

    it('opens a legacy public link on its owner and keeps Remove public link', async () => {
      const revokePublicLink = jest.fn().mockResolvedValue(undefined);
      const share = jest.fn().mockResolvedValue({});
      renderOwned({
        share,
        revokePublicLink,
        existingShare: {
          ...organizationShare,
          audience: 'public',
          publicLinkStale: true,
        },
      });
      await settle();

      expect(option('organization')?.getAttribute('aria-checked')).toBe('true');
      expect(option('public')?.getAttribute('aria-checked')).toBe('false');
      expect(
        document.querySelector('[data-testid="share-skill-public-link-stale"]'),
      ).toBeNull();
      expect(revokePublicLink).not.toHaveBeenCalled();

      click('[data-testid="share-skill-remove-public-link"]');
      await settle();
      click('[data-testid="share-skill-remove-public-link-confirm-action"]');
      await settle();
      expect(revokePublicLink).toHaveBeenCalledTimes(1);
      expect(share).not.toHaveBeenCalled();
    });

    it('keeps a legacy owning scope offered while the navigation context is Personal', async () => {
      renderOwned(
        {
          context: { kind: 'personal' },
          existingShare: { ...organizationShare, audience: 'public' },
        },
        { context: { kind: 'personal' } },
      );
      await settle();
      expect(option('organization')?.getAttribute('aria-checked')).toBe('true');
      expect(option('public')?.disabled).toBe(true);
      expect(lockedHint()).not.toBeNull();
    });

    it('preserves the legacy public link on a supported owner update', async () => {
      const share = jest.fn().mockResolvedValue({});
      renderOwned({
        share,
        existingShare: { ...organizationShare, audience: 'public' },
      });
      await settle();
      click('[data-testid="share-skill-submit"]');
      await settle();
      expect(share).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: 'organization',
          organizationId: acmeId,
          preservePublicLink: true,
        }),
      );
    });

    it('moves a selected Public off once context policy arrives', async () => {
      const share = jest.fn().mockResolvedValue({});
      const legacy = { ...organizationShare, audience: 'public' } as const;
      renderOwned({ share, existingShare: legacy }, { context: undefined });
      await settle();
      expect(option('public')?.getAttribute('aria-checked')).toBe('true');
      expect(lockedHint()).toBeNull();

      renderOwned({ share, existingShare: legacy });
      await settle();
      expect(option('public')?.disabled).toBe(true);
      expect(option('organization')?.getAttribute('aria-checked')).toBe('true');

      click('[data-testid="share-skill-submit"]');
      await settle();
      expect(share).toHaveBeenCalledTimes(1);
      expect(share).toHaveBeenCalledWith(
        expect.objectContaining({ scope: 'organization' }),
      );
    });

    it('requires a destination choice for an ambiguous legacy owner', async () => {
      const share = jest.fn().mockResolvedValue({});
      renderOwned({
        share,
        context: organizationContext,
        contextOrganizations: [acme],
        existingShare: { audience: 'public', target: acme },
        loadAccount: jest.fn().mockResolvedValue({
          ...readyAccount,
          capabilities: ['skills-crud-v1', 'organizations-v1'],
        }),
      });
      await settle();
      expect(option('public')?.disabled).toBe(true);
      expect(
        document.querySelector<HTMLButtonElement>(
          '[data-testid="share-skill-submit"]',
        )?.disabled,
      ).toBe(true);
      click('[data-testid="share-skill-submit"]');
      await settle();
      expect(share).not.toHaveBeenCalled();
    });

    it('requires an explicit destination when the owning audience is unavailable', async () => {
      const share = jest.fn().mockResolvedValue({});
      renderOwned({
        share,
        context: organizationContext,
        contextOrganizations: [acme],
        existingShare: {
          audience: 'public',
          target: acmeTeam,
          targetAudience: 'team',
        },
        audienceAvailability: { team: false },
      });
      await settle();
      expect(option('public')?.disabled).toBe(true);
      expect(
        document.querySelector<HTMLButtonElement>(
          '[data-testid="share-skill-submit"]',
        )?.disabled,
      ).toBe(true);
      expect(share).not.toHaveBeenCalled();
    });

    it.each(['team', 'organization'] as const)(
      'keeps the %s owner selected while clearing a filtered search',
      async (audience) => {
        const list = jest.fn((query?: string) =>
          Promise.resolve(query ? [] : [audience === 'team' ? acmeTeam : acme]),
        );
        renderOwned({
          existingShare: {
            audience,
            targetAudience: audience,
            target: audience === 'team' ? acmeTeam : acme,
          },
          ...(audience === 'team'
            ? { listTeams: list }
            : { listOrganizations: list }),
        });
        await settle();
        const search = document.querySelector<HTMLInputElement>(
          `[data-testid="share-skill-${audience}-picker"] input[type="search"]`,
        );
        expect(search).not.toBeNull();
        const changeSearch = (value: string): void => {
          act(() => {
            Object.getOwnPropertyDescriptor(
              HTMLInputElement.prototype,
              'value',
            )?.set?.call(search, value);
            search?.dispatchEvent(new Event('input', { bubbles: true }));
          });
        };
        changeSearch('unrelated');
        await act(async () => {
          jest.advanceTimersByTime(300);
          await Promise.resolve();
        });
        await settle();
        expect(list).toHaveBeenLastCalledWith('unrelated');
        changeSearch('');
        await settle();
        expect(
          document.querySelector<HTMLButtonElement>(
            '[data-testid="share-skill-submit"]',
          )?.disabled,
        ).toBe(false);
        await act(async () => {
          jest.advanceTimersByTime(300);
          await Promise.resolve();
        });
        await settle();
        expect(
          document.querySelector<HTMLButtonElement>(
            '[data-testid="share-skill-submit"]',
          )?.disabled,
        ).toBe(false);
      },
    );

    it('drops an owner target removed from the available destinations', async () => {
      const share = jest.fn().mockResolvedValue({});
      const listOrganizations = jest.fn().mockResolvedValue([acme]);
      renderOwned({ share, listOrganizations });
      await settle();
      expect(
        document.querySelector<HTMLButtonElement>(
          '[data-testid="share-skill-submit"]',
        )?.disabled,
      ).toBe(false);

      renderOwned({
        share,
        listOrganizations: jest.fn().mockResolvedValue([]),
      });
      await settle();
      expect(
        document.querySelector<HTMLButtonElement>(
          '[data-testid="share-skill-submit"]',
        )?.disabled,
      ).toBe(true);
      click('[data-testid="share-skill-submit"]');
      await settle();
      expect(share).not.toHaveBeenCalled();
    });

    it('reconciles details that arrive after the account and resets on reopen', async () => {
      const share = jest.fn().mockResolvedValue({});
      renderOwned({ share, existingShare: undefined });
      await settle();
      click('[data-testid="share-skill-scope-public"]');
      await settle();
      expect(option('public')?.getAttribute('aria-checked')).toBe('true');

      renderOwned({ share });
      await settle();
      expect(option('public')?.disabled).toBe(true);
      expect(option('organization')?.getAttribute('aria-checked')).toBe('true');
      click('[data-testid="share-skill-submit"]');
      await settle();
      expect(share).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: 'organization',
          organizationId: acmeId,
        }),
      );

      act(() => root.unmount());
      root = createRoot(container);
      renderOwned({
        share,
        existingShare: { ...organizationShare, audience: 'public' },
      });
      await settle();
      expect(option('public')?.disabled).toBe(true);
      expect(option('organization')?.getAttribute('aria-checked')).toBe('true');
    });

    it('holds Public while the host is still loading context policy', async () => {
      renderOwned({}, { context: undefined, ready: false });
      await settle();
      expect(option('public')?.disabled).toBe(true);

      renderOwned({}, { context: undefined, ready: true });
      await settle();
      expect(option('public')?.disabled).toBe(false);
      expect(lockedHint()).toBeNull();
    });

    it('rechecks Public after asynchronous host preparation before mutation', async () => {
      let finishPreparation: (() => void) | undefined;
      const preparation = new Promise<void>((resolve) => {
        finishPreparation = resolve;
      });
      const mutate = jest.fn();
      const share = jest.fn(
        async (
          input: Parameters<
            NonNullable<Parameters<typeof ShareResourceDialog>[0]['share']>
          >[0],
        ) => {
          await preparation;
          input.assertAllowed?.();
          mutate();
          return {};
        },
      );
      const existingShare = {
        ...organizationShare,
        audience: 'public',
      } as const;
      renderOwned({ share, existingShare }, { context: undefined });
      await settle();
      click('[data-testid="share-skill-submit"]');
      await settle();
      expect(share).toHaveBeenCalledTimes(1);
      renderOwned({ share, existingShare });
      await settle();
      await act(async () => {
        finishPreparation?.();
        await preparation;
      });
      await settle();
      expect(mutate).not.toHaveBeenCalled();
      expect(
        document.querySelector('[data-testid="share-skill-error"]')
          ?.textContent,
      ).toContain("Organization shares can't be made public yet.");
    });

    it.each([
      ['context policy is off', {}, { context: undefined }],
      [
        'the host does not keep organization ownership',
        { keepsOrganizationOwnership: false },
        { context: organizationContext },
      ],
      [
        'the Personal organization owns the share',
        {
          existingShare: {
            audience: 'organization',
            target: { id: personalId, name: 'Stored' },
            targetAudience: 'organization',
          },
        },
        { context: organizationContext },
      ],
      [
        'the share is personal',
        { existingShare: { audience: 'public' } },
        { context: organizationContext },
      ],
      [
        'the resource was never shared',
        { existingShare: undefined },
        {
          context: organizationContext,
        },
      ],
    ] as const)('keeps Public when %s', async (_label, overrides, policy) => {
      const share = jest.fn().mockResolvedValue({});
      renderOwned({ share, ...overrides }, policy);
      await settle();

      expect(option('public')?.disabled).toBe(false);
      expect(lockedHint()).toBeNull();
      click('[data-testid="share-skill-scope-public"]');
      await settle();
      click('[data-testid="share-skill-submit"]');
      await settle();
      expect(share).toHaveBeenCalledWith(
        expect.objectContaining({ scope: 'public' }),
      );
    });

    it('does not explain an ownership lock when Public is disabled for another reason', async () => {
      renderOwned({ audienceAvailability: { public: false } });
      await settle();
      expect(option('public')?.disabled).toBe(true);
      expect(lockedHint()).toBeNull();

      renderOwned({ scopes: ['team', 'organization'] });
      await settle();
      expect(option('public')).toBeNull();
      expect(lockedHint()).toBeNull();
    });

    it('shows a plain sentence for a resource-context refusal', async () => {
      const share = jest
        .fn()
        .mockRejectedValue(
          new Error(
            "Error invoking remote method 'skills:shared:update': ResourceContextUnavailableError: Resource unavailable (unsupported-target)",
          ),
        );
      renderOwned({ share });
      await settle();
      click('[data-testid="share-skill-submit"]');
      await settle();
      expect(
        document.querySelector('[data-testid="share-skill-error"]')
          ?.textContent,
      ).toBe(
        "Failed to share skill. This share can't be moved to that destination.",
      );
    });

    it('keeps conflict copy ahead of refusal copy', async () => {
      renderOwned({
        share: jest.fn().mockRejectedValue(new ShareConflictError()),
      });
      await settle();
      click('[data-testid="share-skill-submit"]');
      await settle();
      expect(
        document.querySelector('[data-testid="share-skill-error"]')
          ?.textContent,
      ).toBe(shareResourceCopy('skill').conflict);
    });

    it('shows a plain sentence when preflight or completion is refused', async () => {
      const refusal = new Error(
        "Error invoking remote method 'skills:shared:get': Error: Resource unavailable (access-removed)",
      );
      renderOwned({ preflight: jest.fn().mockRejectedValue(refusal) });
      await settle();
      expect(document.body.textContent).toContain(
        'Failed to share skill. You no longer have access to this share.',
      );
      expect(document.body.textContent).not.toContain('invoking remote');

      act(() => root.unmount());
      root = createRoot(container);
      renderOwned({ onCompleted: jest.fn().mockRejectedValue(refusal) });
      await settle();
      click('[data-testid="share-skill-submit"]');
      await settle();
      expect(
        document.querySelector('[data-testid="share-skill-error"]')
          ?.textContent,
      ).toBe('Failed to share skill. You no longer have access to this share.');
    });
  });

  describe('with a capability package port', () => {
    const analysis: PipelinePackageAnalysisSummary = {
      analysisId: 'analysis-1',
      state: 'ready',
      pipelineContentHash: 'a'.repeat(64),
      blockers: [],
      expiresAt: '2099-01-01T00:00:00.000Z',
      manifest: {
        version: 1,
        pipelineContentHash: 'a'.repeat(64),
        resources: [
          {
            id: 'helper',
            kind: 'standalone_skill',
            displayName: 'Helper',
            sourceLabel: 'local',
            sourceVisibility: 'local',
            invocationKeys: ['/helper'],
            dependencyResourceIds: [],
            trees: [],
          },
        ],
        bindings: [
          {
            jobId: 'job',
            stepId: 'step',
            resourceIds: ['helper'],
          },
        ],
        environmentRequirements: [],
        totalFiles: 0,
        totalBytes: 0,
      },
    };

    function packagePort(
      overrides: Partial<CapabilityPackageSharePort> = {},
    ): CapabilityPackageSharePort {
      return {
        analyze: jest.fn().mockResolvedValue(analysis),
        cancel: jest.fn().mockResolvedValue(undefined),
        ...overrides,
      };
    }

    describe('Fix it with AI', () => {
      const blocked: PipelinePackageAnalysisSummary = {
        ...analysis,
        analysisId: 'analysis-blocked',
        state: 'blocked',
        blockers: [
          {
            code: 'UNRESOLVED_INVOCATION',
            subject: '/missing',
            message: 'No skill named /missing in /Users/alice/private/x.md',
            occurrences: [{ jobId: 'job', stepId: 'step' }],
          },
        ],
        dismissedInvocations: [{ provider: 'claude', token: '/not-cmd' }],
      };
      type RepairOpen = NonNullable<
        NonNullable<
          Parameters<typeof ShareResourceDialog>[0]['capabilityPackage']
        >['repair']
      >['open'];
      function mockRepairOpen(
        implementation?: RepairOpen,
      ): jest.Mock<ReturnType<RepairOpen>, Parameters<RepairOpen>> {
        return jest.fn<ReturnType<RepairOpen>, Parameters<RepairOpen>>(
          implementation,
        );
      }
      const fixButton = (): HTMLButtonElement | null =>
        document.querySelector<HTMLButtonElement>(
          '[data-testid="share-skill-dependency-problems-fix-with-ai"]',
        );
      const repairBinding = (
        open: RepairOpen,
      ): NonNullable<
        NonNullable<
          Parameters<typeof ShareResourceDialog>[0]['capabilityPackage']
        >['repair']
      > => ({
        subject: { kind: 'skill', sourceId: 'custom:app', skillName: 'mine' },
        displayName: 'Mine',
        open,
      });

      it('disables repair for an analysis that arrives expired, without looping', async () => {
        const analyze = jest.fn().mockResolvedValue({
          ...blocked,
          expiresAt: '2000-01-01T00:00:00.000Z',
        });
        const open = mockRepairOpen().mockResolvedValue(undefined);
        renderDialog({
          capabilityPackage: {
            port: packagePort({ analyze }),
            repair: repairBinding(open),
          },
        });
        await settle();
        await settle();
        expect(fixButton()?.disabled).toBe(true);
        expect(open).not.toHaveBeenCalled();
        expect(analyze).toHaveBeenCalledTimes(1);
      });

      it('rechecks a blocked analysis on its own when it expires', async () => {
        const analyze = jest
          .fn()
          .mockResolvedValueOnce({
            ...blocked,
            expiresAt: new Date(Date.now() + 30).toISOString(),
          })
          .mockResolvedValue(analysis);
        renderDialog({
          capabilityPackage: {
            port: packagePort({ analyze }),
            repair: repairBinding(mockRepairOpen()),
          },
        });
        await settle();
        expect(fixButton()).not.toBeNull();
        act(() => {
          jest.advanceTimersByTime(60);
        });
        await settle();
        expect(analyze).toHaveBeenCalledTimes(2);
        expect(fixButton()).toBeNull();
      });

      it('rechecks a blocked analysis when the window regains focus', async () => {
        const analyze = jest
          .fn()
          .mockResolvedValueOnce(blocked)
          .mockResolvedValue(analysis);
        renderDialog({
          capabilityPackage: {
            port: packagePort({ analyze }),
          },
        });
        await settle();
        expect(
          document.querySelector(
            '[data-testid="share-skill-dependency-problems"]',
          ),
        ).not.toBeNull();
        expect(
          document.querySelector(
            '[data-testid="share-skill-dependency-problems-recheck"]',
          ),
        ).toBeNull();

        await act(async () => {
          window.dispatchEvent(new Event('focus'));
          await Promise.resolve();
        });
        await settle();
        expect(analyze).toHaveBeenCalledTimes(2);
        expect(
          document.querySelector(
            '[data-testid="share-skill-dependency-problems"]',
          ),
        ).toBeNull();

        // A ready review has nothing to recheck.
        await act(async () => {
          window.dispatchEvent(new Event('focus'));
          await Promise.resolve();
        });
        await settle();
        expect(analyze).toHaveBeenCalledTimes(2);
      });
      it('ignores a failed launch after the audience changes', async () => {
        let rejectOpen: (error: Error) => void = () => {};
        const open = mockRepairOpen(
          () =>
            new Promise<void>((_resolve, reject) => {
              rejectOpen = reject;
            }),
        );
        renderDialog({
          capabilityPackage: {
            port: packagePort({
              analyze: jest.fn().mockResolvedValue(blocked),
            }),
            repair: repairBinding(open),
          },
        });
        await settle();
        click('[data-testid="share-skill-scope-public"]');
        await settle();
        click('[data-testid="share-skill-dependency-problems-fix-with-ai"]');
        await settle();
        click('[data-testid="share-skill-scope-team"]');
        await settle();
        await act(async () => {
          rejectOpen(new Error('old launch'));
          await Promise.resolve();
        });
        expect(
          document.querySelector(
            '[data-testid="share-skill-dependency-problems-fix-with-ai-error"]',
          ),
        ).toBeNull();
      });
      it('renders nothing without a host handler', async () => {
        renderDialog({
          capabilityPackage: {
            port: packagePort({
              analyze: jest.fn().mockResolvedValue(blocked),
            }),
          },
        });
        await settle();
        expect(
          document.querySelector(
            '[data-testid="share-skill-dependency-problems"]',
          ),
        ).not.toBeNull();
        expect(fixButton()).toBeNull();
      });

      it('renders nothing when nothing blocks the share', async () => {
        renderDialog({
          capabilityPackage: {
            port: packagePort(),
            repair: repairBinding(mockRepairOpen()),
          },
        });
        await settle();
        expect(fixButton()).toBeNull();
      });

      it('opens one chat with the click-time context, then closes', async () => {
        let resolveOpen: () => void = () => {};
        const open = mockRepairOpen(
          () =>
            new Promise<void>((resolve) => {
              resolveOpen = resolve;
            }),
        );
        const onClose = jest.fn();
        renderDialog({
          onClose,
          capabilityPackage: {
            port: packagePort({
              analyze: jest.fn().mockResolvedValue(blocked),
            }),
            repair: repairBinding(open),
          },
        });
        await settle();
        click('[data-testid="share-skill-scope-public"]');
        await settle();
        const actions = Array.from(
          document.querySelectorAll(
            '[data-testid="share-skill-dependency-problems-notice"] button',
          ),
        ).map((button) => button.getAttribute('data-testid'));
        expect(actions).toEqual([fixButton()?.dataset.testid]);
        expect(fixButton()?.textContent).toBe('Fix it with AI');

        click('[data-testid="share-skill-dependency-problems-fix-with-ai"]');
        click('[data-testid="share-skill-dependency-problems-fix-with-ai"]');
        await settle();
        expect(open).toHaveBeenCalledTimes(1);
        expect(fixButton()?.textContent).toBe('Opening chat…');
        expect(fixButton()?.disabled).toBe(true);

        const launch = open.mock.calls[0]?.[0];
        if (!launch) throw new Error('Expected the repair chat to open');
        expect(launch.request).toMatchObject({
          subject: { kind: 'skill', skillName: 'mine' },
          displayName: 'Mine',
          audience: { scope: 'public', selected: null },
          context: {
            dismissedInvocations: [{ provider: 'claude', token: '/not-cmd' }],
          },
          analysis: { state: 'blocked' },
        });
        expect(launch.prompt).toContain('capability_package.analyze');
        expect(launch.prompt).not.toContain('/Users/alice');
        expect(onClose).not.toHaveBeenCalled();

        await act(async () => {
          resolveOpen();
          await Promise.resolve();
        });
        expect(onClose).toHaveBeenCalledTimes(1);
      });

      it('stays open and usable when the chat cannot start', async () => {
        const open = mockRepairOpen().mockRejectedValue(new Error('no chat'));
        const onClose = jest.fn();
        renderDialog({
          onClose,
          capabilityPackage: {
            port: packagePort({
              analyze: jest.fn().mockResolvedValue(blocked),
            }),
            repair: repairBinding(open),
          },
        });
        await settle();
        click('[data-testid="share-skill-dependency-problems-fix-with-ai"]');
        await settle();
        expect(onClose).not.toHaveBeenCalled();
        expect(
          document.querySelector(
            '[data-testid="share-skill-dependency-problems-fix-with-ai-error"]',
          )?.textContent,
        ).toBe("Couldn't start the chat. Try again.");
        expect(fixButton()?.disabled).toBe(false);
        click('[data-testid="share-skill-dependency-problems-fix-with-ai"]');
        await settle();
        expect(open).toHaveBeenCalledTimes(2);
      });

      it('does not close for a launch whose audience has since changed', async () => {
        let resolveOpen: () => void = () => {};
        const open = mockRepairOpen(
          () =>
            new Promise<void>((resolve) => {
              resolveOpen = resolve;
            }),
        );
        const onClose = jest.fn();
        renderDialog({
          onClose,
          capabilityPackage: {
            port: packagePort({
              analyze: jest.fn().mockResolvedValue(blocked),
            }),
            repair: repairBinding(open),
          },
        });
        await settle();
        click('[data-testid="share-skill-scope-public"]');
        await settle();
        click('[data-testid="share-skill-dependency-problems-fix-with-ai"]');
        await settle();
        click('[data-testid="share-skill-scope-team"]');
        await settle();
        await act(async () => {
          resolveOpen();
          await Promise.resolve();
        });
        expect(onClose).not.toHaveBeenCalled();
      });
    });

    it('shares local dependencies without another acknowledgment', async () => {
      const share = jest.fn().mockResolvedValue({});
      const port = packagePort();
      renderDialog({
        share,
        capabilityPackage: { port },
      });
      await settle();
      click('[data-testid="share-skill-scope-public"]');
      await settle();

      expect(
        document.querySelector('[data-testid="share-skill-dependencies"]'),
      ).not.toBeNull();
      // The details sit behind a help icon; reading them is optional.
      expect(
        document
          .querySelector('[data-testid="share-skill-dependencies-help"]')
          ?.getAttribute('aria-label'),
      ).toBe('About included files');
      expect(
        document.querySelector('[data-testid="share-skill-consent"]'),
      ).toBeNull();
      expect(document.body.textContent).not.toContain('I understand');
      expect(document.body.textContent).not.toContain('Delete local copy');
      expect(submitButton()?.disabled).toBe(false);

      click('[data-testid="share-skill-submit"]');
      await settle();
      expect(share).toHaveBeenCalledWith({
        scope: 'public',
        packageSelection: {
          analysisId: 'analysis-1',
          selectedOptionalResourceIds: [],
          analysis,
        },
      });
    });

    describe('host placement', () => {
      const placedReview = (): Element | null =>
        document.querySelector(
          '[data-testid="host-slot"] [data-testid="share-skill-dependencies"]',
        );
      const anyReview = (): Element | null =>
        document.querySelector('[data-testid="share-skill-dependencies"]');
      const renderPlaced = (port: CapabilityPackageSharePort): void =>
        renderDialog({
          capabilityPackage: { port, placement: 'host' },
          extraOptions: ({ packageReview }) => (
            <div data-testid="host-slot">{packageReview}</div>
          ),
        });

      it('hands a clean review to extraOptions instead of rendering it inline', async () => {
        renderPlaced(packagePort());
        await settle();

        expect(placedReview()).not.toBeNull();
        expect(
          document.querySelectorAll('[data-testid="share-skill-dependencies"]'),
        ).toHaveLength(1);
      });

      it('keeps a review with blockers inline', async () => {
        renderPlaced(
          packagePort({
            analyze: jest.fn().mockResolvedValue({
              ...analysis,
              state: 'blocked',
              blockers: [
                {
                  code: 'UNRESOLVED_INVOCATION',
                  subject: '/missing',
                  message: 'No skill named /missing',
                  occurrences: [{ jobId: 'job', stepId: 'step' }],
                },
              ],
            }),
          }),
        );
        await settle();

        expect(anyReview()).not.toBeNull();
        expect(placedReview()).toBeNull();
      });

      it('keeps a review holding dismissed tokens inline', async () => {
        renderPlaced(
          packagePort({
            analyze: jest.fn().mockResolvedValue({
              ...analysis,
              dismissedInvocations: [{ provider: 'claude', token: '/not-cmd' }],
            }),
          }),
        );
        await settle();

        expect(anyReview()).not.toBeNull();
        expect(placedReview()).toBeNull();
      });

      if (!analysis.manifest) throw new Error('fixture has a manifest');
      const emptyManifest = {
        ...analysis.manifest,
        resources: [],
        bindings: [],
        environmentRequirements: [],
      };

      it('omits a placed review with nothing to copy, set up, or leave out', async () => {
        renderPlaced(
          packagePort({
            analyze: jest
              .fn()
              .mockResolvedValue({ ...analysis, manifest: emptyManifest }),
          }),
        );
        await settle();

        expect(anyReview()).toBeNull();
        expect(document.body.textContent).not.toContain('Included files');
      });

      it('keeps a placed review that lists left-out selections', async () => {
        renderPlaced(
          packagePort({
            analyze: jest.fn().mockResolvedValue({
              ...analysis,
              manifest: emptyManifest,
              unpackageableSelectionLabels: ['collection-server'],
            }),
          }),
        );
        await settle();

        expect(placedReview()).not.toBeNull();
      });

      it('keeps an empty review inline without host placement', async () => {
        renderDialog({
          capabilityPackage: {
            port: packagePort({
              analyze: jest
                .fn()
                .mockResolvedValue({ ...analysis, manifest: emptyManifest }),
            }),
          },
        });
        await settle();

        expect(anyReview()).not.toBeNull();
      });

      it('passes no review to extraOptions by default', async () => {
        const extraOptions = jest.fn(() => null);
        renderDialog({
          capabilityPackage: { port: packagePort() },
          extraOptions,
        });
        await settle();

        expect(anyReview()).not.toBeNull();
        expect(extraOptions).toHaveBeenCalledWith(
          expect.objectContaining({ packageReview: null }),
        );
      });
    });

    it('uses the lg width with a package review', async () => {
      renderDialog({ capabilityPackage: { port: packagePort() } });
      await settle();
      const modal = document.querySelector('[data-testid="share-skill-modal"]');
      expect(modal?.outerHTML).toContain('max-w-lg');
      expect(modal?.outerHTML).not.toContain('max-w-2xl');
    });

    it('reports an audience change when capability loss falls back to another audience', async () => {
      let notifyAccountChanged: () => void = () => {};
      const loadAccount = jest
        .fn<Promise<ShareResourceAccount>, []>()
        .mockResolvedValueOnce({ ...readyAccount, id: 'account-1' })
        .mockResolvedValue({
          connected: true,
          id: 'account-1',
          capabilities: ['skills-crud-v1'],
        });
      const onAudienceChange = jest.fn();
      renderDialog({
        loadAccount,
        onAudienceChange,
        subscribeAccountChanged: (listener) => {
          notifyAccountChanged = listener;
          return (): void => {};
        },
        capabilityPackage: {
          port: packagePort(),
        },
      });
      await settle();
      click('[data-testid="share-skill-scope-team"]');
      await settle();
      const changesBefore = onAudienceChange.mock.calls.length;

      await act(async () => {
        notifyAccountChanged();
        await Promise.resolve();
      });
      await settle();

      // Public is the only usable audience left, so the fallback lands on it.
      expect(scopeOption('public')?.getAttribute('aria-checked')).toBe('true');
      expect(onAudienceChange.mock.calls.length).toBe(changesBefore + 1);
    });

    function submitButton(): HTMLButtonElement | null {
      return document.querySelector<HTMLButtonElement>(
        '[data-testid="share-skill-submit"]',
      );
    }

    it('re-analyzes instead of sharing an expired analysis', async () => {
      const share = jest.fn().mockResolvedValue({});
      const analyze = jest.fn().mockResolvedValue({
        ...analysis,
        expiresAt: '2000-01-01T00:00:00.000Z',
      });
      renderDialog({
        share,
        capabilityPackage: { port: packagePort({ analyze }) },
      });
      await settle();
      click('[data-testid="share-skill-scope-public"]');
      await settle();
      click('[data-testid="share-skill-submit"]');
      await settle();

      expect(share).not.toHaveBeenCalled();
      expect(analyze).toHaveBeenCalledTimes(2);
      expect(
        document.querySelector('[data-testid="share-skill-validation-error"]')
          ?.textContent,
      ).toBe('Review the updated dependencies, then share again.');
    });

    it('re-analyzes after a share fails', async () => {
      const share = jest.fn().mockRejectedValue(new Error('Cloud is down.'));
      const analyze = jest.fn().mockResolvedValue(analysis);
      renderDialog({
        share,
        capabilityPackage: { port: packagePort({ analyze }) },
      });
      await settle();
      click('[data-testid="share-skill-scope-public"]');
      await settle();
      click('[data-testid="share-skill-submit"]');
      await settle();

      expect(share).toHaveBeenCalledTimes(1);
      expect(analyze).toHaveBeenCalledTimes(2);
    });

    it('keeps the reviewed selection after a connection failure', async () => {
      const share = jest.fn().mockRejectedValue(
        new ShareFailureError({
          version: 1,
          kind: 'connection',
          stage: 'upload',
          message: 'Network error',
          commitState: 'not-committed',
          retryable: true,
        }),
      );
      const analyze = jest.fn().mockResolvedValue(analysis);
      renderDialog({
        share,
        capabilityPackage: { port: packagePort({ analyze }) },
      });
      await settle();
      click('[data-testid="share-skill-scope-public"]');
      await settle();
      click('[data-testid="share-skill-submit"]');
      await settle();

      expect(analyze).toHaveBeenCalledTimes(1);
      expect(
        document.querySelector('[data-testid="share-skill-error"]')
          ?.textContent,
      ).toContain(
        "Couldn't upload the included files. Check your connection and try again.",
      );
      expect(submitButton()?.disabled).toBe(false);
    });

    it('keeps the analysis after a share conflict', async () => {
      const share = jest.fn().mockRejectedValue(new ShareConflictError());
      const analyze = jest.fn().mockResolvedValue(analysis);
      renderDialog({
        share,
        capabilityPackage: { port: packagePort({ analyze }) },
      });
      await settle();
      click('[data-testid="share-skill-scope-public"]');
      await settle();
      click('[data-testid="share-skill-submit"]');
      await settle();

      expect(share).toHaveBeenCalledTimes(1);
      expect(analyze).toHaveBeenCalledTimes(1);
    });

    it('shares with a null selection when there is nothing to package', async () => {
      const share = jest.fn().mockResolvedValue({});
      renderDialog({
        share,
        capabilityPackage: {
          port: packagePort({
            analyze: jest.fn().mockResolvedValue({
              ...analysis,
              manifest: { ...analysis.manifest, resources: [], bindings: [] },
            }),
          }),
        },
      });
      await settle();
      click('[data-testid="share-skill-scope-public"]');
      await settle();
      click('[data-testid="share-skill-submit"]');
      await settle();

      expect(share).toHaveBeenCalledWith({
        scope: 'public',
        packageSelection: null,
      });
    });

    it('keeps Share disabled with retry copy when analysis fails', async () => {
      renderDialog({
        capabilityPackage: {
          port: packagePort({
            analyze: jest.fn().mockRejectedValue(new Error('Lookup failed.')),
          }),
        },
      });
      await settle();

      expect(document.body.textContent).toContain(
        "Couldn't check the included files. Try again.",
      );
      expect(submitButton()?.disabled).toBe(true);
      expect(
        document.querySelector('[data-testid="share-skill-definition-only"]'),
      ).toBeNull();
    });

    it('blocks Share while an analysis has blockers', async () => {
      renderDialog({
        capabilityPackage: {
          port: packagePort({
            analyze: jest.fn().mockResolvedValue({
              ...analysis,
              state: 'blocked',
              blockers: [
                {
                  code: 'SUSPECTED_SECRET',
                  subject: '.env',
                  message: 'A dependency looks like a secret.',
                  occurrences: [],
                },
              ],
            }),
          }),
        },
      });
      await settle();
      expect(
        document.querySelector(
          '[data-testid="share-skill-dependency-problems"]',
        ),
      ).not.toBeNull();
      expect(submitButton()?.disabled).toBe(true);
      expect(
        document.querySelector('[data-testid="share-skill-definition-only"]'),
      ).toBeNull();
    });
  });

  describe('destination access and failures', () => {
    function press(selector: string): void {
      act(() => {
        click(selector);
      });
    }

    const lapsedAccount = (
      canChoosePlan: boolean | undefined,
      extra: Partial<ShareResourceAccount> = {},
    ): ShareResourceAccount => ({
      ...readyAccount,
      id: 'account-1',
      organizationAccess: [
        {
          organizationId: 'org-1',
          organizationName: 'Acme',
          teamsEntitled: false,
          ...(canChoosePlan !== undefined ? { canChoosePlan } : {}),
        },
        {
          organizationId: 'org-2',
          organizationName: 'Beta',
          teamsEntitled: true,
        },
      ],
      ...extra,
    });

    async function pickOrganization(id: string): Promise<void> {
      press('[data-testid="share-skill-scope-organization"]');
      await settle();
      press(`[data-testid="share-skill-organization-picker-option-${id}"]`);
      await settle();
    }

    function submit(): HTMLButtonElement | null {
      return document.querySelector<HTMLButtonElement>(
        '[data-testid="share-skill-submit"]',
      );
    }

    it('names a lapsed organization and offers an owner Choose a plan before any upload', async () => {
      const share = jest.fn().mockResolvedValue({});
      const onChooseOrganizationPlan = jest.fn();
      renderDialog({
        share,
        onChooseOrganizationPlan,
        loadAccount: jest.fn().mockResolvedValue(lapsedAccount(true)),
        listOrganizations: jest.fn().mockResolvedValue(organizations),
      });
      await settle();
      await pickOrganization('org-1');

      const notice = document.querySelector(
        '[data-testid="share-skill-destination-access"]',
      );
      expect(notice?.textContent).toContain('Acme has no active plan');
      expect(notice?.textContent).toContain(
        'Choose a plan to share with Acme.',
      );
      expect(submit()?.disabled).toBe(true);
      press('[data-testid="share-skill-choose-plan"]');
      expect(onChooseOrganizationPlan).toHaveBeenCalledWith('org-1');
      press('[data-testid="share-skill-submit"]');
      await settle();
      expect(share).not.toHaveBeenCalled();
    });

    it('asks a member to contact an owner and offers no purchase action', async () => {
      renderDialog({
        onChooseOrganizationPlan: jest.fn(),
        loadAccount: jest.fn().mockResolvedValue(lapsedAccount(false)),
        listOrganizations: jest.fn().mockResolvedValue(organizations),
      });
      await settle();
      await pickOrganization('org-1');

      expect(
        document.querySelector('[data-testid="share-skill-destination-access"]')
          ?.textContent,
      ).toContain('Ask an owner of Acme to choose a plan.');
      expect(
        document.querySelector('[data-testid="share-skill-choose-plan"]'),
      ).toBeNull();
    });

    it('re-checks access from the notice so a plan chosen elsewhere unlocks Share', async () => {
      const entitled: ShareResourceAccount = {
        ...readyAccount,
        id: 'account-1',
        organizationAccess: [
          {
            organizationId: 'org-1',
            organizationName: 'Acme',
            teamsEntitled: true,
          },
        ],
      };
      renderDialog({
        loadAccount: jest
          .fn()
          .mockResolvedValueOnce(lapsedAccount(false))
          .mockResolvedValue(entitled),
        listOrganizations: jest.fn().mockResolvedValue(organizations),
      });
      await settle();
      await pickOrganization('org-1');
      expect(submit()?.disabled).toBe(true);

      press('[data-testid="share-skill-destination-access-check"]');
      await settle();

      expect(
        document.querySelector(
          '[data-testid="share-skill-destination-access"]',
        ),
      ).toBeNull();
      expect(submit()?.disabled).toBe(false);
    });

    it('follows the selected organization, not other memberships', async () => {
      renderDialog({
        loadAccount: jest.fn().mockResolvedValue(lapsedAccount(true)),
        listOrganizations: jest.fn().mockResolvedValue(organizations),
      });
      await settle();
      await pickOrganization('org-2');

      expect(
        document.querySelector(
          '[data-testid="share-skill-destination-access"]',
        ),
      ).toBeNull();
      expect(submit()?.disabled).toBe(false);
    });

    it('shows no plan gate with free access or without access facts', async () => {
      renderDialog({
        loadAccount: jest
          .fn()
          .mockResolvedValue(lapsedAccount(true, { freeAccess: true })),
        listOrganizations: jest.fn().mockResolvedValue(organizations),
      });
      await settle();
      await pickOrganization('org-1');
      expect(
        document.querySelector(
          '[data-testid="share-skill-destination-access"]',
        ),
      ).toBeNull();
      expect(submit()?.disabled).toBe(false);

      act(() => root.unmount());
      root = createRoot(container);
      renderDialog({
        listOrganizations: jest.fn().mockResolvedValue(organizations),
      });
      await settle();
      await pickOrganization('org-1');
      expect(
        document.querySelector(
          '[data-testid="share-skill-destination-access"]',
        ),
      ).toBeNull();
      expect(submit()?.disabled).toBe(false);
    });

    it('treats a team whose organization the facts omit as unknown', async () => {
      const refreshAccount = jest.fn().mockRejectedValue(new Error('offline'));
      renderDialog({
        refreshAccount,
        loadAccount: jest.fn().mockResolvedValue({
          ...readyAccount,
          id: 'account-1',
          organizationAccess: [
            { organizationId: 'org-9', teamsEntitled: false },
          ],
        }),
      });
      await settle();
      press('[data-testid="share-skill-scope-team"]');
      await settle();
      press('[data-testid="share-skill-team-picker-option-team-1"]');
      await settle();

      expect(refreshAccount).toHaveBeenCalled();
      expect(
        document.querySelector(
          '[data-testid="share-skill-destination-access"]',
        ),
      ).toBeNull();
      // A failed check informs; it never blocks the share.
      expect(
        document.querySelector(
          '[data-testid="share-skill-destination-access-error"]',
        )?.textContent,
      ).toContain(
        "Couldn't check access. Check your connection and try again.",
      );
      expect(submit()?.disabled).toBe(false);
    });

    it('presents a server plan refusal on the destination, not as permission', async () => {
      const share = jest.fn().mockRejectedValue(
        new ShareFailureError({
          version: 1,
          kind: 'organization-plan',
          stage: 'publish',
          message: 'Organization lapsed',
          commitState: 'not-committed',
          retryable: false,
          httpStatus: 403,
          organizationId: 'org-1',
        }),
      );
      renderDialog({
        share,
        listOrganizations: jest.fn().mockResolvedValue(organizations),
      });
      await settle();
      await pickOrganization('org-1');
      press('[data-testid="share-skill-submit"]');
      await settle();

      expect(
        document.querySelector('[data-testid="share-skill-destination-access"]')
          ?.textContent,
      ).toContain('Acme has no active plan');
      expect(document.body.textContent).not.toContain("don't have permission");
      expect(submit()?.disabled).toBe(true);
    });

    it('keeps a plan refusal for another organization as an error', async () => {
      renderDialog({
        share: jest.fn().mockRejectedValue(
          new ShareFailureError({
            version: 1,
            kind: 'organization-plan',
            stage: 'publish',
            message: 'Organization lapsed',
            commitState: 'not-committed',
            retryable: false,
            httpStatus: 403,
            organizationId: 'org-9',
          }),
        ),
      });
      await settle();
      press('[data-testid="share-skill-scope-public"]');
      await settle();
      press('[data-testid="share-skill-submit"]');
      await settle();

      expect(
        document.querySelector('[data-testid="share-skill-error"]')
          ?.textContent,
      ).toContain('no active plan');
    });

    it('offers Sign in after an authentication failure', async () => {
      const onOpenAccountSettings = jest.fn();
      renderDialog({
        onOpenAccountSettings,
        share: jest.fn().mockRejectedValue(
          new ShareFailureError({
            version: 1,
            kind: 'authentication',
            stage: 'publish',
            message: 'Unauthorized',
            commitState: 'not-committed',
            retryable: false,
            httpStatus: 401,
          }),
        ),
      });
      await settle();
      press('[data-testid="share-skill-scope-public"]');
      await settle();
      press('[data-testid="share-skill-submit"]');
      await settle();

      expect(
        document.querySelector('[data-testid="share-skill-error"]')
          ?.textContent,
      ).toContain('Sign in again to share this skill.');
      press('[data-testid="share-skill-sign-in"]');
      expect(onOpenAccountSettings).toHaveBeenCalledTimes(1);
    });

    it('never offers a repeat of an uncertain publication', async () => {
      const share = jest.fn().mockRejectedValue(
        new ShareFailureError({
          version: 1,
          kind: 'connection',
          stage: 'publish',
          message: 'Network error',
          commitState: 'unknown',
          retryable: false,
        }),
      );
      renderDialog({ share });
      await settle();
      press('[data-testid="share-skill-scope-public"]');
      await settle();
      press('[data-testid="share-skill-submit"]');
      await settle();

      expect(
        document.querySelector('[data-testid="share-skill-error"]')
          ?.textContent,
      ).toContain("Couldn't confirm whether this skill was shared.");
      expect(submit()?.disabled).toBe(true);
    });

    it('never offers a repeat of a share that landed', async () => {
      const share = jest.fn().mockRejectedValue(
        new ShareFailureError({
          version: 1,
          kind: 'unknown',
          stage: 'finish',
          message: "Couldn't share. Try again.",
          commitState: 'committed',
          retryable: false,
        }),
      );
      renderDialog({ share });
      await settle();
      press('[data-testid="share-skill-scope-public"]');
      await settle();
      press('[data-testid="share-skill-submit"]');
      await settle();

      expect(
        document.querySelector('[data-testid="share-skill-error"]')
          ?.textContent,
      ).toContain('Skill shared, but finishing up failed.');
      expect(submit()?.disabled).toBe(true);
    });

    it('closes a pending delivery with a warning and skips completion', async () => {
      const onCompleted = jest.fn();
      const onClose = jest.fn();
      const notify = jest.fn();
      renderDialog({
        onCompleted,
        onClose,
        notify,
        share: jest.fn().mockResolvedValue({
          delivery: 'pending',
          message: 'Still sharing.',
        }),
      });
      await settle();
      press('[data-testid="share-skill-scope-public"]');
      await settle();
      press('[data-testid="share-skill-submit"]');
      await settle();

      expect(onCompleted).not.toHaveBeenCalled();
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(notify).toHaveBeenCalledWith({
        tone: 'warning',
        message: 'Still sharing.',
      });
    });
  });
});
