/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ResourceContextProvider } from '@canopy/ui-app/capability';
import type { SharedByYouFacts } from '@canopy/ui-app/sharing';
import { brand } from '@/lib/brand';
import { copyTextToClipboard } from '@/lib/clipboard';
import { unshareMarketplaceResource } from '@/lib/marketplaceUnshare';
import { revokeMarketplacePublicShare } from '@/lib/revokePublicShare';
import { postShareToast } from '@/lib/share-toast';
import { SharedByYou } from '../SharedByYou';

jest.mock('@/lib/marketplaceUnshare', () => ({
  unshareMarketplaceResource: jest.fn(() => Promise.resolve()),
}));
jest.mock('@/lib/revokePublicShare', () => ({
  revokeMarketplacePublicShare: jest.fn(() => Promise.resolve()),
}));
jest.mock('@/lib/clipboard', () => ({
  copyTextToClipboard: jest.fn(() => Promise.resolve(true)),
}));
jest.mock('@/lib/share-toast', () => ({
  postShareToast: jest.fn(),
}));

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

const mockUnshare = jest.mocked(unshareMarketplaceResource);
const mockRevoke = jest.mocked(revokeMarketplacePublicShare);
const mockCopy = jest.mocked(copyTextToClipboard);
const mockToast = jest.mocked(postShareToast);

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
  jest.clearAllMocks();
});

function byTestId(id: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${id}"]`);
}

function click(id: string): void {
  const element = byTestId(id);
  if (!(element instanceof HTMLButtonElement)) throw new Error(`${id} missing`);
  act(() => element.click());
}

const ORG_WITH_LINK: SharedByYouFacts = {
  canDelete: true,
  owner: { type: 'organization', id: 'org-1', name: 'Northwind' },
  shareScope: 'organization',
  createdAt: '2026-10-12T12:00:00Z',
  publicShare: { externalId: 'pub-1', createdAt: '2026-10-14T12:00:00Z' },
};

function render(
  facts: SharedByYouFacts,
  onUnshared = jest.fn(),
  personalOrganizationId: string | null = null,
  shareId = 'plugin-ext',
): jest.Mock {
  act(() =>
    root.render(
      <ResourceContextProvider
        context={undefined}
        personalOrganizationId={personalOrganizationId}
      >
        <SharedByYou
          kind="plugin"
          shareId={shareId}
          name="Slack"
          facts={facts}
          onUnshared={onUnshared}
        />
      </ResourceContextProvider>,
    ),
  );
  return onUnshared;
}

describe('SharedByYou (CAN-4842)', () => {
  it('deletes the account share through the Marketplace Unshare transport', async () => {
    const onUnshared = render(ORG_WITH_LINK);
    expect(byTestId('shared-by-you-row-account')?.textContent).toContain(
      'Northwind',
    );
    click('shared-by-you-unshare-account');
    click('shared-by-you-unshare-account-confirm');
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockUnshare).toHaveBeenCalledWith('plugin', 'plugin-ext');
    expect(mockRevoke).not.toHaveBeenCalled();
    expect(onUnshared).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'account' }),
    );
  });

  it('removes only the public link through the revoke transport', async () => {
    const onUnshared = render(ORG_WITH_LINK);
    click('shared-by-you-unshare-public');
    click('shared-by-you-remove-public-link-confirm-action');
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockRevoke).toHaveBeenCalledWith('plugin', 'plugin-ext');
    expect(mockUnshare).not.toHaveBeenCalled();
    expect(onUnshared).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'public' }),
    );
  });

  it('names the personal organization Personal', () => {
    render(
      {
        ...ORG_WITH_LINK,
        owner: {
          type: 'organization',
          id: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
        },
      },
      jest.fn(),
      '7c9e6679-7425-40de-944b-e07fc1f90ae7',
    );
    expect(byTestId('shared-by-you-row-account')?.textContent).toContain(
      'Personal',
    );
  });

  it('renders nothing for a share the viewer cannot delete', () => {
    render({ ...ORG_WITH_LINK, canDelete: false });
    expect(byTestId('shared-by-you')).toBeNull();
  });

  // CAN-5452: the owner copies the member link with the desktop's clipboard
  // and share toast; the notice is blocked from replay.
  describe('Copy link', () => {
    const SHARE_ID = '3f2b8c1e-5d4a-4e6f-9a7b-1c2d3e4f5a6b';

    it('copies the branded member link and posts a replay-blocked notice', async () => {
      render(ORG_WITH_LINK, jest.fn(), null, SHARE_ID);
      click('shared-by-you-copy-link-account');
      await act(async () => {
        await Promise.resolve();
      });
      expect(mockCopy).toHaveBeenCalledWith(
        `${brand.internalName}://share/plugins/${SHARE_ID}?audience=ORGANIZATION`,
      );
      expect(mockToast).toHaveBeenCalledTimes(1);
      expect(mockToast).toHaveBeenCalledWith({
        tone: 'success',
        message:
          'Link copied for Northwind members. A public link is also active.',
        blockMessageFromReplay: true,
      });
      expect(mockUnshare).not.toHaveBeenCalled();
      expect(mockRevoke).not.toHaveBeenCalled();
    });

    it('warns instead of confirming when the clipboard write fails', async () => {
      mockCopy.mockResolvedValueOnce(false);
      render(ORG_WITH_LINK, jest.fn(), null, SHARE_ID);
      click('shared-by-you-copy-link-account');
      await act(async () => {
        await Promise.resolve();
      });
      expect(mockToast).toHaveBeenCalledTimes(1);
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({ tone: 'warning' }),
      );
      expect(byTestId('shared-by-you-copy-link-account')?.textContent).toBe(
        'Copy link',
      );
    });

    it('offers no Copy link for a share id that cannot form a link', () => {
      render(ORG_WITH_LINK);
      expect(byTestId('shared-by-you-row-account')).not.toBeNull();
      expect(byTestId('shared-by-you-copy-link-account')).toBeNull();
    });
  });
});
