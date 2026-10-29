/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot } from 'react-dom/client';
import { getDefaultFeatureFlagSnapshot } from '@canopy/protocol/feature-flags';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { DesktopCreateTeamDialog } from '../DesktopCreateTeamDialog';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const TEAM = '11111111-1111-4111-8111-111111111111';

let mockHostedSettingsClient: unknown = null;
jest.mock('@/client/hosted-settings-client-registry', () => ({
  registeredHostedSettingsClient: (): unknown => mockHostedSettingsClient,
}));

jest.mock('@canopy/ui-app/sharing/InviteToOrganizationDialog', () => ({
  InviteToOrganizationDialog: ({
    onManage,
  }: {
    onManage: (organizationId: string) => void;
  }): JSX.Element => (
    <button
      type="button"
      data-testid="mock-manage"
      onClick={() => onManage(TEAM)}
    />
  ),
}));

const openAuthenticatedPortalPage = jest.fn<Promise<boolean>, [string]>();

function renderAndManage(): void {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <DesktopCreateTeamDialog
        accountId="acct_1"
        personalOrganizationId=""
        onClose={() => undefined}
      />,
    );
  });
  act(() => {
    container
      .querySelector<HTMLButtonElement>('[data-testid="mock-manage"]')
      ?.click();
  });
  act(() => root.unmount());
  container.remove();
}

describe('DesktopCreateTeamDialog Manage', () => {
  beforeEach(() => {
    openAuthenticatedPortalPage.mockReset().mockResolvedValue(true);
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { openAuthenticatedPortalPage },
    });
    useFeatureFlagsStore.setState({
      snapshot: getDefaultFeatureFlagSnapshot(),
    });
  });

  afterEach(() => {
    mockHostedSettingsClient = null;
    Reflect.deleteProperty(window, 'api');
    useNavigationStore.getState().closeSettings();
  });

  it('opens the team settings inside Settings when hosted settings are openable', () => {
    mockHostedSettingsClient = {};
    renderAndManage();
    expect(useNavigationStore.getState().settingsHostedLocation?.route).toEqual(
      { scope: 'organization', organizationId: TEAM, page: 'settings' },
    );
    expect(openAuthenticatedPortalPage).not.toHaveBeenCalled();
  });

  it('opens the team settings on the web otherwise', () => {
    renderAndManage();
    expect(useNavigationStore.getState().settingsOpen).toBe(false);
    expect(openAuthenticatedPortalPage).toHaveBeenCalledWith(
      `/organization/${TEAM}/settings`,
    );
  });
});
