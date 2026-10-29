/** @jest-environment jsdom */
import { organizationBillingPath } from '@canopy/protocol/billing';
import { openOrganizationBillingPage } from '../organizationPlan';

const mockOpenSettingsPathOrWeb = jest.fn<'settings' | 'web', [string]>();

jest.mock('../navigation/settings-destinations', () => ({
  openSettingsPathOrWeb: (path: string): 'settings' | 'web' =>
    mockOpenSettingsPathOrWeb(path),
}));

const ORG = '33333333-3333-4333-8333-333333333333';

describe('openOrganizationBillingPage', () => {
  beforeEach(() => {
    mockOpenSettingsPathOrWeb.mockReset();
  });

  it.each(['settings', 'web'] as const)(
    "opens the organization's billing and reports %s",
    (where) => {
      mockOpenSettingsPathOrWeb.mockReturnValue(where);
      expect(openOrganizationBillingPage(ORG)).toBe(where);
      expect(mockOpenSettingsPathOrWeb).toHaveBeenCalledWith(
        organizationBillingPath(ORG),
      );
    },
  );
});
