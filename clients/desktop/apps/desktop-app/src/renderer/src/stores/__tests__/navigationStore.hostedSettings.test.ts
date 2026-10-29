/**
 * @jest-environment jsdom
 */
import {
  selectSettingsDestination,
  useNavigationStore,
} from '../navigationStore';

const ORG = 'a0000000-0000-4000-8000-000000000002';

beforeEach(() => {
  useNavigationStore.getState().closeSettings();
});

describe('navigationStore hosted settings destination (CAN-4386)', () => {
  it('keeps openSettings on local sections, including desktop Accounts', () => {
    useNavigationStore.getState().openSettings('account');
    const state = useNavigationStore.getState();
    expect(state.settingsOpen).toBe(true);
    expect(state.settingsInitialSection).toBe('account');
    expect(state.settingsHostedLocation).toBeNull();
    state.setSettingsActiveSection('account');
    expect(selectSettingsDestination(useNavigationStore.getState())).toEqual({
      kind: 'local',
      section: 'account',
    });
  });

  it("opens account Labs in the local Labs section, over main's snapshot", () => {
    const navigation = useNavigationStore.getState();
    navigation.openAccountOrganizationSettings({
      scope: 'account',
      page: 'billing',
    });
    useNavigationStore
      .getState()
      .openAccountOrganizationSettings({ scope: 'account', page: 'labs' });
    const state = useNavigationStore.getState();
    expect(state.settingsOpen).toBe(true);
    expect(state.settingsInitialSection).toBe('experiments');
    expect(state.settingsHostedLocation).toBeNull();
  });

  it('opens Settings on a hosted route with General underneath', () => {
    useNavigationStore.setState({ commandPaletteOpen: true });
    useNavigationStore
      .getState()
      .openAccountOrganizationSettings(
        { scope: 'account', page: 'billing' },
        { search: '?topUp=1', hash: '#history' },
      );
    const state = useNavigationStore.getState();
    expect(state.settingsOpen).toBe(true);
    expect(state.commandPaletteOpen).toBe(false);
    expect(state.settingsInitialSection).toBeUndefined();
    expect(state.settingsHostedLocation).toEqual({
      route: { scope: 'account', page: 'billing' },
      search: 'topUp=1',
      hash: 'history',
    });
    expect(state.settingsHostedHistory).toEqual([]);
    expect(selectSettingsDestination(state)).toEqual({
      kind: 'hosted',
      route: { scope: 'account', page: 'billing' },
    });
  });

  it('records hosted history for Back, except on replace', () => {
    const navigation = useNavigationStore.getState();
    navigation.openAccountOrganizationSettings({ scope: 'organizations' });
    navigation.openAccountOrganizationSettings({
      scope: 'organization',
      organizationId: ORG,
      page: 'feed',
    });
    navigation.openAccountOrganizationSettings(
      { scope: 'organization', organizationId: ORG, page: 'statistics' },
      { search: 'range=30d', replace: true },
    );
    expect(useNavigationStore.getState().settingsHostedHistory).toEqual([
      { route: { scope: 'organizations' }, search: '', hash: '' },
    ]);

    navigation.backAccountOrganizationSettings();
    expect(useNavigationStore.getState().settingsHostedLocation?.route).toEqual(
      { scope: 'organizations' },
    );
    expect(useNavigationStore.getState().settingsHostedHistory).toEqual([]);
  });

  it('falls back to the Organizations list when Back has no history', () => {
    useNavigationStore.getState().openAccountOrganizationSettings({
      scope: 'organization',
      organizationId: ORG,
      page: 'members',
      userId: 'user-1',
    });
    useNavigationStore.getState().backAccountOrganizationSettings();
    expect(useNavigationStore.getState().settingsHostedLocation).toEqual({
      route: { scope: 'organizations' },
      search: '',
      hash: '',
    });
  });

  it('starts a fresh history when Settings reopens', () => {
    const navigation = useNavigationStore.getState();
    navigation.openAccountOrganizationSettings({ scope: 'organizations' });
    navigation.openAccountOrganizationSettings({
      scope: 'account',
      page: 'security',
    });
    navigation.closeSettings();
    navigation.openAccountOrganizationSettings({
      scope: 'account',
      page: 'profile',
    });
    expect(useNavigationStore.getState().settingsHostedHistory).toEqual([]);
  });

  it('stores a hosted scrollTo target on cold open', () => {
    useNavigationStore
      .getState()
      .openAccountOrganizationSettings(
        { scope: 'account', page: 'integrations' },
        { scrollTo: 'settings-linear-token-input' },
      );
    const state = useNavigationStore.getState();
    expect(state.settingsHostedLocation?.route).toEqual({
      scope: 'account',
      page: 'integrations',
    });
    expect(state.settingsScrollTarget).toBe('settings-linear-token-input');
  });

  it('clears a stale scroll target on cold open without scrollTo', () => {
    useNavigationStore.setState({ settingsScrollTarget: 'stale-target' });
    useNavigationStore
      .getState()
      .openAccountOrganizationSettings({ scope: 'account', page: 'account' });
    expect(useNavigationStore.getState().settingsScrollTarget).toBeUndefined();
  });

  it('sets scrollTo on an open overlay and keeps a pending target when omitted', () => {
    const navigation = useNavigationStore.getState();
    navigation.openSettings('notifications', { scrollTo: 'pending-target' });
    navigation.openAccountOrganizationSettings(
      { scope: 'account', page: 'notifications' },
      { replace: true },
    );
    expect(useNavigationStore.getState().settingsScrollTarget).toBe(
      'pending-target',
    );

    navigation.openAccountOrganizationSettings(
      { scope: 'account', page: 'account' },
      { scrollTo: 'cloud-account-recovery-notice' },
    );
    const state = useNavigationStore.getState();
    expect(state.settingsHostedLocation?.route).toEqual({
      scope: 'account',
      page: 'account',
    });
    expect(state.settingsScrollTarget).toBe('cloud-account-recovery-notice');
  });

  it('clears the hosted destination for a local section, close, and other overlays', () => {
    const navigation = useNavigationStore.getState();
    navigation.openAccountOrganizationSettings({ scope: 'organizations' });
    navigation.showLocalSettingsSection();
    expect(useNavigationStore.getState().settingsHostedLocation).toBeNull();
    expect(useNavigationStore.getState().settingsOpen).toBe(true);

    navigation.openAccountOrganizationSettings({ scope: 'organizations' });
    navigation.openSettings('git');
    expect(useNavigationStore.getState().settingsHostedLocation).toBeNull();

    navigation.openAccountOrganizationSettings({ scope: 'organizations' });
    navigation.closeSettings();
    expect(useNavigationStore.getState().settingsHostedLocation).toBeNull();
    expect(selectSettingsDestination(useNavigationStore.getState())).toBeNull();

    navigation.openAccountOrganizationSettings({ scope: 'organizations' });
    navigation.openCommandPalette();
    expect(useNavigationStore.getState().settingsOpen).toBe(false);
    expect(useNavigationStore.getState().settingsHostedLocation).toBeNull();
  });
});
