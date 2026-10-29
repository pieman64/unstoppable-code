/** @jest-environment jsdom */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import {
  EveryoneHasAccessEmptyState,
  NoQueryMatchEmptyState,
  OnlyMemberEmptyState,
  SearchForMoreTeammatesEmptyState,
} from '../TeammateEmptyStates';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

const mockOpenReported = jest.fn<
  Promise<'settings' | 'web' | 'failed'>,
  [string]
>();
jest.mock('@/lib/navigation/settings-destinations', () => ({
  openSettingsPathOrWebReported: (
    path: string,
  ): Promise<'settings' | 'web' | 'failed'> => mockOpenReported(path),
}));

describe('teammate empty states', () => {
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

  it.each(['OWNER', 'ADMIN', 'MEMBER', undefined])(
    'gates the inline invitation by the selected organization role %s',
    async (role) => {
      Reflect.set(window, 'api', {
        loadCanopyCloudAccount: jest.fn().mockResolvedValue({
          account: { id: 'account-1' },
          authMode: 'oauth',
          organizations: [{ id: 'org-1', name: 'Acme', role }],
        }),
        personalOrganizationUpgrade: { invite: jest.fn() },
      });
      await act(async () => {
        root.render(
          <OnlyMemberEmptyState
            organizationId="org-1"
            organizationName="Acme"
          />,
        );
        await Promise.resolve();
      });
      const allowed = role === 'OWNER' || role === 'ADMIN';
      expect(
        container.querySelector(
          '[data-testid="shared-container-invite-modal-invite-teammate"]',
        ) !== null,
      ).toBe(allowed);
      expect(
        container.querySelector(
          '[data-testid="shared-container-invite-modal-manage-members"]',
        ) !== null,
      ).toBe(!allowed);
    },
  );

  describe('Manage members', () => {
    async function renderMember(onOpened: () => void): Promise<void> {
      Reflect.set(window, 'api', {
        loadCanopyCloudAccount: jest.fn().mockResolvedValue({
          account: { id: 'account-1' },
          authMode: 'oauth',
          organizations: [{ id: 'org-1', name: 'Acme', role: 'MEMBER' }],
        }),
      });
      await act(async () => {
        root.render(
          <OnlyMemberEmptyState
            organizationId="org-1"
            organizationName="Acme"
            onOpened={onOpened}
          />,
        );
        await Promise.resolve();
      });
      await act(async () => {
        container
          .querySelector<HTMLButtonElement>(
            '[data-testid="shared-container-invite-modal-manage-members"]',
          )
          ?.click();
        await Promise.resolve();
        await Promise.resolve();
      });
    }

    beforeEach(() => mockOpenReported.mockReset());

    it.each([
      ['settings', true, false],
      ['web', false, false],
      ['failed', false, true],
    ] as const)(
      'opens the members page; %s calls onOpened %p and shows the error %p',
      async (result, opened, failed) => {
        mockOpenReported.mockResolvedValue(result);
        const onOpened = jest.fn();
        await renderMember(onOpened);
        expect(mockOpenReported).toHaveBeenCalledWith(
          '/organization/org-1/members',
        );
        expect(onOpened).toHaveBeenCalledTimes(opened ? 1 : 0);
        expect(container.textContent?.includes('Could not open') ?? false).toBe(
          failed,
        );
      },
    );
  });

  it('keeps an open Personal flow bound through same-account promotion refresh, and closes on account replacement', async () => {
    localStorage.clear();
    const organizationId = '11111111-1111-4111-8111-111111111111';
    const load = jest.fn().mockResolvedValue({
      account: { id: 'account-1' },
      authMode: 'oauth',
      personalOrganizationId: organizationId,
      organizations: [],
    });
    Reflect.set(window, 'api', {
      loadCanopyCloudAccount: load,
      personalOrganizationUpgrade: {
        listProjects: jest.fn().mockResolvedValue({ projects: [] }),
      },
    });
    await act(async () => {
      root.render(
        <OnlyMemberEmptyState
          organizationId={organizationId}
          organizationName="Personal"
        />,
      );
      await Promise.resolve();
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="shared-container-invite-modal-invite-teammate"]',
        )
        ?.click();
      await Promise.resolve();
    });
    expect(
      document.querySelector(
        '[data-testid="invite-to-organization-team-name"]',
      ),
    ).not.toBeNull();
    load.mockResolvedValue({
      account: { id: 'account-1' },
      authMode: 'oauth',
      personalOrganizationId: '22222222-2222-4222-8222-222222222222',
      organizations: [{ id: organizationId, name: 'Acme', role: 'OWNER' }],
    });
    await act(async () => {
      window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
      await Promise.resolve();
    });
    expect(
      document.querySelector(
        '[data-testid="invite-to-organization-team-name"]',
      ),
    ).not.toBeNull();
    load.mockResolvedValue({
      account: { id: 'account-2' },
      authMode: 'oauth',
      organizations: [],
    });
    await act(async () => {
      window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
      await Promise.resolve();
    });
    expect(
      document.querySelector(
        '[data-testid="invite-to-organization-team-name"]',
      ),
    ).toBeNull();
  });

  it.each<[string, string, () => JSX.Element]>([
    [
      'everyone has access',
      'empty-everyone-has-access',
      (): JSX.Element => (
        <EveryoneHasAccessEmptyState organizationName="Acme" />
      ),
    ],
    [
      'only member',
      'empty-only-member',
      (): JSX.Element => (
        <OnlyMemberEmptyState organizationId="org-1" organizationName="Acme" />
      ),
    ],
    [
      'search for more',
      'empty-search-for-more',
      (): JSX.Element => (
        <SearchForMoreTeammatesEmptyState organizationName="Acme" />
      ),
    ],
    [
      'no query match',
      'empty-no-match',
      (): JSX.Element => <NoQueryMatchEmptyState query="Acme" />,
    ],
  ])(
    'names the organization or query in the %s state',
    (_name, testId, element) => {
      act(() => root.render(element()));
      const state = container.querySelector(
        `[data-testid="shared-container-invite-modal-${testId}"]`,
      );
      expect(state?.textContent).toContain('Acme');
    },
  );
});
