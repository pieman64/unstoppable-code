/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  MarketplaceUnshareError,
  marketplaceUnshareErrorMessage,
  marketplaceUnshareMessage,
} from '@canopy/ui-shared/lib/marketplace-unshare';
import {
  REPLAY_BLOCK_CLASS,
  REPLAY_MASK_CLASS,
} from '@canopy/ui-shared/lib/replay-privacy';
import { SHARED_BY_YOU_REMOVE_LINK_ERROR } from '@canopy/ui-shared/lib/shared-by-you';
import {
  sharedByYouAudiences,
  type SharedByYouAudience,
  type SharedByYouFacts,
} from '../../sharing/sharedByYouAudiences';
import { SharedByYouSection } from '../SharedByYouSection';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

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
  document.body.innerHTML = '';
});

function byTestId(id: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${id}"]`);
}

function click(id: string): void {
  const element = byTestId(id);
  if (!(element instanceof HTMLButtonElement)) throw new Error(`${id} missing`);
  act(() => element.click());
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function account(
  overrides: Partial<Extract<SharedByYouAudience, { id: 'account' }>> = {},
): SharedByYouAudience {
  return {
    id: 'account',
    audience: 'organization',
    name: 'Acme',
    sinceIso: '2026-10-12T12:00:00Z',
    action: { available: true, run: jest.fn(() => Promise.resolve()) },
    alsoRevokesPublicLink: false,
    ...overrides,
  };
}

function publicLink(
  overrides: Partial<Extract<SharedByYouAudience, { id: 'public' }>> = {},
): SharedByYouAudience {
  return {
    id: 'public',
    audience: 'public',
    name: 'Public link',
    sinceIso: '2026-10-14T12:00:00Z',
    action: { available: true, run: jest.fn(() => Promise.resolve()) },
    remainingAudience: { name: 'Acme' },
    ...overrides,
  };
}

function render(
  audiences: readonly SharedByYouAudience[],
  onUnshared = jest.fn(),
): jest.Mock {
  act(() =>
    root.render(
      <SharedByYouSection
        kind="plugin"
        name="Slack"
        audiences={audiences}
        onUnshared={onUnshared}
      />,
    ),
  );
  return onUnshared;
}

describe('SharedByYouSection (CAN-4842)', () => {
  it('renders nothing without audiences', () => {
    render([]);
    expect(container.innerHTML).toBe('');
  });

  it('lists each audience with its label, since date and Unshare', () => {
    render([account(), publicLink({ sinceIso: undefined })]);
    const section = byTestId('shared-by-you');
    expect(section?.textContent).toContain('Shared by you');
    const accountRow = byTestId('shared-by-you-row-account');
    const name = accountRow?.querySelector(`.${REPLAY_MASK_CLASS}`);
    expect(name?.textContent).toBe('Acme');
    expect(
      accountRow?.querySelector('[data-share-audience="organization"]')
        ?.textContent,
    ).toBe('Organization');
    expect(byTestId('shared-by-you-since-account')?.textContent).toMatch(
      /^Since Oct 1[23]$/,
    );
    expect(byTestId('shared-by-you-row-public')?.textContent).toContain(
      'Public link',
    );
    expect(byTestId('shared-by-you-since-public')).toBeNull();
    expect(byTestId('shared-by-you-unshare-account')?.textContent).toBe(
      'Unshare',
    );
    expect(
      byTestId('shared-by-you-unshare-account')?.getAttribute('aria-label'),
    ).toBe('Unshare Slack with Acme');
    expect(byTestId('shared-by-you-unshare-public')?.textContent).toBe(
      'Unshare',
    );
    expect(
      byTestId('shared-by-you-unshare-public')?.getAttribute('aria-label'),
    ).toBe('Remove the public link for Slack');
  });

  it('names a personal organization share Personal', () => {
    render([account({ personal: true, name: 'Ada' })]);
    const row = byTestId('shared-by-you-row-account');
    expect(row?.querySelector(`.${REPLAY_MASK_CLASS}`)?.textContent).toBe(
      'Personal',
    );
    expect(row?.querySelector('[data-share-audience]')?.textContent).toBe(
      'Organization',
    );
  });

  it('deletes the account share after confirmation, then reports it', async () => {
    const run = jest.fn(() => Promise.resolve());
    const audience = account({ action: { available: true, run } });
    const onUnshared = render([audience]);
    click('shared-by-you-unshare-account');
    const dialog = byTestId('shared-by-you-unshare-account-dialog');
    expect(dialog?.textContent).toContain('Unshare “Slack”?');
    expect(dialog?.textContent).toContain(
      marketplaceUnshareMessage('plugin', 'Acme'),
    );
    click('shared-by-you-unshare-account-confirm');
    await flush();
    expect(run).toHaveBeenCalledTimes(1);
    expect(onUnshared).toHaveBeenCalledWith(audience);
    expect(byTestId('shared-by-you-unshare-account-dialog')).toBeNull();
  });

  it('keeps the account dialog open with the refusal copy', async () => {
    const run = jest.fn(() =>
      Promise.reject(new MarketplaceUnshareError('forbidden')),
    );
    const onUnshared = render([account({ action: { available: true, run } })]);
    click('shared-by-you-unshare-account');
    click('shared-by-you-unshare-account-confirm');
    await flush();
    expect(
      byTestId('shared-by-you-unshare-account-dialog')?.textContent,
    ).toContain(marketplaceUnshareErrorMessage('plugin', 'forbidden'));
    expect(onUnshared).not.toHaveBeenCalled();
  });

  it.each([
    [undefined, "won't show up in shared lists"],
    [{ name: 'Acme' }, 'Acme members keep access'],
  ])(
    'removes the public link once after confirmation (remaining: %p)',
    async (remainingAudience, body) => {
      let finish: () => void = () => undefined;
      const run = jest.fn(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      );
      const audience = publicLink({
        remainingAudience,
        action: { available: true, run },
      });
      const onUnshared = render([audience]);
      click('shared-by-you-unshare-public');
      expect(
        byTestId('shared-by-you-remove-public-link-confirm')?.textContent,
      ).toContain(body);
      click('shared-by-you-remove-public-link-confirm-action');
      click('shared-by-you-remove-public-link-confirm-action');
      expect(run).toHaveBeenCalledTimes(1);
      await act(async () => {
        finish();
        await Promise.resolve();
      });
      expect(onUnshared).toHaveBeenCalledWith(audience);
      expect(byTestId('shared-by-you-remove-public-link-confirm')).toBeNull();
    },
  );

  describe('remove public link confirmation from real rows', () => {
    const ports = {
      deleteShare: { available: true, run: jest.fn(() => Promise.resolve()) },
      revokePublicLink: {
        available: true,
        run: jest.fn(() => Promise.resolve()),
      },
    } as const;
    const link = { externalId: 'pub-1', createdAt: '2026-10-14T12:00:00Z' };

    function confirmText(
      facts: SharedByYouFacts,
      personalOrganizationId: string | null = null,
    ): string | null | undefined {
      render(sharedByYouAudiences(facts, personalOrganizationId, ports));
      click('shared-by-you-unshare-public');
      return byTestId('shared-by-you-remove-public-link-confirm')?.textContent;
    }

    it('names the organization that keeps access', () => {
      expect(
        confirmText({
          canDelete: true,
          shareScope: 'organization',
          owner: { type: 'organization', id: 'org-1', name: 'Acme Robotics' },
          publicShare: link,
        }),
      ).toContain(
        'People outside Acme Robotics who have the link will lose access. Acme Robotics members keep access, including through links they already have.',
      );
    });

    it('never names the raw personal organization', () => {
      const text = confirmText(
        {
          canDelete: true,
          shareScope: 'organization',
          owner: {
            type: 'organization',
            id: 'org-personal',
            name: 'Aaron’s organization',
          },
          publicShare: link,
        },
        'org-personal',
      );
      expect(text).toContain(
        'Anyone else with the link will lose access. It stays in your Personal context.',
      );
      expect(text).not.toContain('Aaron’s organization');
    });

    it('keeps the private-only body for a link-only share', () => {
      expect(
        confirmText({
          canDelete: true,
          shareScope: 'private',
          owner: { type: 'user', id: 'user-1', name: 'Aaron' },
          publicShare: link,
        }),
      ).toContain(
        "Anyone with the link will lose access, and it won't show up in shared lists anymore. You can share it again later.",
      );
    });
  });

  it('re-enables the public link row for a re-published link', async () => {
    // A link with no creation time is still told apart by its id.
    render([publicLink({ linkId: 'pub-1', sinceIso: undefined })]);
    click('shared-by-you-unshare-public');
    click('shared-by-you-remove-public-link-confirm-action');
    await flush();
    // The removed link stays disabled until the facts change.
    render([publicLink({ linkId: 'pub-1', sinceIso: undefined })]);
    expect(
      byTestId('shared-by-you-unshare-public')?.hasAttribute('disabled'),
    ).toBe(true);
    render([publicLink({ linkId: 'pub-2', sinceIso: undefined })]);
    expect(
      byTestId('shared-by-you-unshare-public')?.hasAttribute('disabled'),
    ).toBe(false);
  });

  it('moves focus into the public link dialog and back to Unshare on cancel', async () => {
    render([publicLink()]);
    const trigger = byTestId('shared-by-you-unshare-public');
    act(() => trigger?.focus());
    click('shared-by-you-unshare-public');
    await flush();
    const dialog = byTestId('shared-by-you-remove-public-link-confirm');
    expect(dialog?.contains(document.activeElement)).toBe(true);
    click('shared-by-you-remove-public-link-cancel');
    await flush();
    expect(document.activeElement).toBe(trigger);
  });

  it('keeps the public link dialog open with an error when removal fails', async () => {
    const run = jest.fn(() => Promise.reject(new Error('nope')));
    const onUnshared = render([
      publicLink({ action: { available: true, run } }),
    ]);
    click('shared-by-you-unshare-public');
    click('shared-by-you-remove-public-link-confirm-action');
    await flush();
    const alert = document.querySelector(
      '[data-testid="shared-by-you-remove-public-link-confirm"] [role="alert"]',
    );
    expect(alert?.textContent).toBe(SHARED_BY_YOU_REMOVE_LINK_ERROR);
    expect(byTestId('shared-by-you-remove-public-link-confirm')).not.toBeNull();
    expect(onUnshared).not.toHaveBeenCalled();
  });

  it('disables an unavailable action and explains why', () => {
    render([
      account({
        action: {
          available: false,
          reason: 'Unshare this plugin from the desktop app.',
        },
      }),
      publicLink({
        action: {
          available: false,
          reason: 'Remove the public link from the desktop app.',
        },
      }),
    ]);
    for (const id of ['account', 'public'] as const) {
      const button = byTestId(`shared-by-you-unshare-${id}`);
      const reason = byTestId(`shared-by-you-reason-${id}`);
      expect(button?.hasAttribute('disabled')).toBe(true);
      expect(reason).not.toBeNull();
      expect(button?.getAttribute('aria-describedby')).toBe(reason?.id);
      act(() => button?.click());
    }
    expect(byTestId('shared-by-you-reason-public')?.textContent).toBe(
      'Remove the public link from the desktop app.',
    );
    expect(byTestId('shared-by-you-unshare-account-dialog')).toBeNull();
    expect(byTestId('shared-by-you-remove-public-link-confirm')).toBeNull();
  });
});

// CAN-5452: the account row's Copy link sits before Unshare and copies the
// member link through the host's port; the public-link row has none.
describe('SharedByYouSection Copy link (CAN-5452)', () => {
  const LINK = {
    url: 'canopy://share/plugins/3f2b8c1e-5d4a-4e6f-9a7b-1c2d3e4f5a6b?audience=ORGANIZATION',
    audience: 'organization',
    audienceName: 'Acme',
    personal: false,
    hasPublicLink: true,
  } as const;

  function withCopy(
    write: (text: string) => Promise<boolean>,
    notify = jest.fn(),
  ): { audiences: SharedByYouAudience[]; notify: jest.Mock } {
    return {
      audiences: [
        account({
          alsoRevokesPublicLink: true,
          copyLink: { link: LINK, port: { write, notify } },
        }),
        publicLink(),
      ],
      notify,
    };
  }

  it('places a named Copy link before the account Unshare only', () => {
    const { audiences } = withCopy(() => Promise.resolve(true));
    render(audiences);
    const copy = byTestId('shared-by-you-copy-link-account');
    const unshare = byTestId('shared-by-you-unshare-account');
    expect(copy?.textContent).toBe('Copy link');
    expect(copy?.getAttribute('aria-label') ?? '').not.toContain('Acme');
    const label = document.getElementById(
      copy?.getAttribute('aria-labelledby') ?? '',
    );
    expect(label?.classList.contains(REPLAY_BLOCK_CLASS)).toBe(true);
    expect(label?.textContent).toBe('Copy the Acme link for Slack');
    expect(
      (copy?.compareDocumentPosition(unshare as Node) ?? 0) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      byTestId('shared-by-you-row-public')?.querySelector(
        '[data-testid^="shared-by-you-copy-link"]',
      ),
    ).toBeNull();
  });

  it('confirms with Copied and one notice after a successful write', async () => {
    const write = jest.fn(() => Promise.resolve(true));
    const { audiences, notify } = withCopy(write);
    const onUnshared = render(audiences);
    click('shared-by-you-copy-link-account');
    await flush();
    expect(write).toHaveBeenCalledWith(LINK.url);
    expect(byTestId('shared-by-you-copy-link-account')?.textContent).toBe(
      'Copied',
    );
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith({
      tone: 'success',
      message: 'Link copied for Acme members. A public link is also active.',
      blockMessageFromReplay: true,
    });
    expect(onUnshared).not.toHaveBeenCalled();
    const [accountRow] = audiences;
    if (accountRow?.id !== 'account' || !accountRow.action.available)
      throw new Error('account row missing');
    expect(accountRow.action.run).not.toHaveBeenCalled();
  });

  it('warns without Copied when the clipboard rejects', async () => {
    const { audiences, notify } = withCopy(() =>
      Promise.reject(new Error('denied')),
    );
    render(audiences);
    click('shared-by-you-copy-link-account');
    await flush();
    expect(byTestId('shared-by-you-copy-link-account')?.textContent).toBe(
      'Copy link',
    );
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ tone: 'warning' }),
    );
  });

  it('shows no Copy link when the row carries none', () => {
    render([account()]);
    expect(byTestId('shared-by-you-copy-link-account')).toBeNull();
  });

  it.each([true, false])(
    'drops a pending copy result after resource navigation (success=%s)',
    async (ok) => {
      let finish: (value: boolean) => void = () => {
        throw new Error('copy not started');
      };
      const write = jest.fn(
        () =>
          new Promise<boolean>((resolve) => {
            finish = resolve;
          }),
      );
      const { audiences, notify } = withCopy(write);
      render(audiences);
      click('shared-by-you-copy-link-account');
      render([
        account({
          copyLink: {
            link: {
              ...LINK,
              url: LINK.url.replace('3f2b8c1e', '4f2b8c1e'),
              audienceName: 'Other',
            },
            port: { write, notify },
          },
        }),
      ]);
      await act(async () => {
        finish(ok);
        await Promise.resolve();
      });
      expect(notify).not.toHaveBeenCalled();
      expect(byTestId('shared-by-you-copy-link-account')?.textContent).toBe(
        'Copy link',
      );
    },
  );

  it('clears Copied when the account link changes', async () => {
    const { audiences, notify } = withCopy(() => Promise.resolve(true));
    render(audiences);
    click('shared-by-you-copy-link-account');
    await flush();
    expect(byTestId('shared-by-you-copy-link-account')?.textContent).toBe(
      'Copied',
    );
    render([
      account({
        copyLink: {
          link: { ...LINK, url: LINK.url.replace('3f2b8c1e', '4f2b8c1e') },
          port: { write: jest.fn(), notify },
        },
      }),
    ]);
    expect(byTestId('shared-by-you-copy-link-account')?.textContent).toBe(
      'Copy link',
    );
  });
});
