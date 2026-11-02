/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ResourceContextProvider } from '@canopy/ui-app/capability';
import type { SharedByYouFacts } from '@canopy/ui-app/sharing';
import { unshareMarketplaceResource } from '@/lib/marketplaceUnshare';
import { revokeMarketplacePublicShare } from '@/lib/revokePublicShare';
import { SharedByYou } from '../SharedByYou';

jest.mock('@/lib/marketplaceUnshare', () => ({
  unshareMarketplaceResource: jest.fn(() => Promise.resolve()),
}));
jest.mock('@/lib/revokePublicShare', () => ({
  revokeMarketplacePublicShare: jest.fn(() => Promise.resolve()),
}));

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

const mockUnshare = jest.mocked(unshareMarketplaceResource);
const mockRevoke = jest.mocked(revokeMarketplacePublicShare);

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
): jest.Mock {
  act(() =>
    root.render(
      <ResourceContextProvider
        context={undefined}
        personalOrganizationId={personalOrganizationId}
      >
        <SharedByYou
          kind="plugin"
          shareId="plugin-ext"
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
});
