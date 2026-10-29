/**
 * @jest-environment jsdom
 */
import { useNavigationStore } from '@/stores/navigationStore';
import { buildCurrentUiStateSnapshot } from '../buildCurrentUiStateSnapshot';

const ORGANIZATION_ID = 'a0000000-0000-4000-8000-000000000002';

beforeEach(() => {
  useNavigationStore.getState().closeSettings();
});

describe('buildCurrentUiStateSnapshot settings.hostedSettings', () => {
  it('reports the hosted page by scope, page and subtab without ids', () => {
    useNavigationStore.getState().openAccountOrganizationSettings(
      {
        scope: 'organization',
        organizationId: ORGANIZATION_ID,
        page: 'settings',
        subtab: 'billing',
        invoiceId: 'in_123',
      },
      { search: 'joined=1' },
    );

    const snapshot = buildCurrentUiStateSnapshot({});

    expect(snapshot.settings?.open).toBe(true);
    expect(snapshot.settings?.hostedSettings).toEqual({
      scope: 'organization',
      page: 'settings',
      subtab: 'billing',
    });
    expect(JSON.stringify(snapshot.settings)).not.toContain(ORGANIZATION_ID);
    expect(JSON.stringify(snapshot.settings)).not.toContain('in_123');
    expect(JSON.stringify(snapshot.settings)).not.toContain('joined');
  });

  it('reports account pages and the Organizations list', () => {
    useNavigationStore
      .getState()
      .openAccountOrganizationSettings({ scope: 'account', page: 'security' });
    expect(buildCurrentUiStateSnapshot({}).settings?.hostedSettings).toEqual({
      scope: 'account',
      page: 'security',
    });

    useNavigationStore
      .getState()
      .openAccountOrganizationSettings({ scope: 'organizations' });
    expect(buildCurrentUiStateSnapshot({}).settings?.hostedSettings).toEqual({
      scope: 'organizations',
    });
  });

  it('omits the field for local sections and while Settings is closed', () => {
    useNavigationStore.getState().openSettings('account');
    expect(
      buildCurrentUiStateSnapshot({}).settings?.hostedSettings,
    ).toBeUndefined();

    useNavigationStore.getState().closeSettings();
    expect(
      buildCurrentUiStateSnapshot({}).settings?.hostedSettings,
    ).toBeUndefined();
  });
});
