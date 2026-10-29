/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { OrganizationDetail } from '@canopy/protocol/settings/organization';
import { SettingsOperationError } from '@canopy/protocol/settings/errors';
import {
  createFakeSettingsClient,
  createTestSettingsHost,
  TestSettingsHost,
  type FakeSettingsClient,
} from '../../__tests__/helpers/test-settings-host';
import { TeamDangerZone } from '../team-danger-zone';

const mockDeleteOrganization = jest.fn<Promise<void>, [unknown]>();

function makeDetail(
  overrides: Partial<OrganizationDetail> = {},
): OrganizationDetail {
  return {
    id: 'org-123',
    name: 'Acme',
    viewerRole: 'OWNER',
    members: [],
    subTeams: [],
    usageStatsMinRole: 'ADMIN',
    canViewUsageStats: false,
    logoUrl: null,
    githubConnection: { connected: false, accountLogin: null },
    ...overrides,
  };
}

describe('TeamDangerZone', () => {
  let container: HTMLElement;
  let root: Root;
  let onDeleted: jest.Mock;
  let client: FakeSettingsClient;

  beforeEach(() => {
    mockDeleteOrganization.mockReset();
    client = createFakeSettingsClient({
      'organization.delete': (input) => mockDeleteOrganization(input),
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    onDeleted = jest.fn();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(detail: OrganizationDetail = makeDetail()): void {
    act(() => {
      root.render(
        <TestSettingsHost host={createTestSettingsHost({ client }).host}>
          <TeamDangerZone detail={detail} onDeleted={onDeleted} />
        </TestSettingsHost>,
      );
    });
  }

  function click(testId: string): void {
    const el = document.body.querySelector<HTMLButtonElement>(
      `[data-testid="${testId}"]`,
    );
    if (el === null) {
      throw new Error(`Missing [data-testid="${testId}"]`);
    }
    act(() => {
      el.click();
    });
  }

  async function clickAsync(testId: string): Promise<void> {
    const el = document.body.querySelector<HTMLButtonElement>(
      `[data-testid="${testId}"]`,
    );
    if (el === null) {
      throw new Error(`Missing [data-testid="${testId}"]`);
    }
    await act(async () => {
      el.click();
      // Let the component's async delete settle before assertions run.
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  function dialogIsOpen(): boolean {
    return (
      document.body.querySelector('[data-testid="team-delete-dialog"]') !== null
    );
  }

  it('renders nothing for non-owners', () => {
    render(makeDetail({ viewerRole: 'ADMIN' }));
    expect(
      container.querySelector('[data-testid="team-danger-zone"]'),
    ).toBeNull();
  });

  it('deletes the organization and notifies the page', async () => {
    mockDeleteOrganization.mockResolvedValue(undefined);
    render();
    click('team-delete');
    expect(dialogIsOpen()).toBe(true);
    await clickAsync('team-delete-confirm');

    expect(mockDeleteOrganization).toHaveBeenCalledWith({
      organizationId: 'org-123',
    });
    expect(onDeleted).toHaveBeenCalledTimes(1);
  });

  it('closes the dialog and shows the live-subscription copy, never the server text, for a 409', async () => {
    // CAN-2220: a live subscription now yields a deliberate 409 instead of the
    // old unhandled 500. The banner lives in the section behind the modal, so
    // the dialog has to close or the owner never sees why.
    const message = 'SENTINEL-SERVER-BODY live subscription refusal';
    mockDeleteOrganization.mockRejectedValue(
      new SettingsOperationError({ code: 'failed', status: 409, message }),
    );
    render();
    click('team-delete');
    await clickAsync('team-delete-confirm');

    expect(onDeleted).not.toHaveBeenCalled();
    expect(dialogIsOpen()).toBe(false);
    expect(container.textContent).toContain(
      "Couldn't delete this organization while it has a live subscription.",
    );
    expect(container.textContent).not.toContain('SENTINEL-SERVER-BODY');
  });

  it('shows the generic action copy, never the server text, for any other refusal', async () => {
    mockDeleteOrganization.mockRejectedValue(
      new SettingsOperationError({
        code: 'failed',
        status: 500,
        message: 'SENTINEL-SERVER-BODY',
      }),
    );
    render();
    click('team-delete');
    await clickAsync('team-delete-confirm');

    expect(container.textContent).toContain(
      "Couldn't delete the organization. Try again.",
    );
    expect(container.textContent).not.toContain('SENTINEL-SERVER-BODY');
  });

  it('falls back to generic copy for a non-API failure', async () => {
    mockDeleteOrganization.mockRejectedValue(new Error('network down'));
    render();
    click('team-delete');
    await clickAsync('team-delete-confirm');

    expect(dialogIsOpen()).toBe(false);
    expect(container.textContent).toContain(
      "Couldn't delete the organization. Try again.",
    );
    expect(container.textContent).not.toContain('network down');
  });

  it('does not promise that the organization is erased', () => {
    render();
    const section = container.querySelector('[data-testid="team-danger-zone"]');
    expect(section?.textContent).not.toContain('cannot be undone');
    expect(section?.textContent).toContain('Billing and usage history is kept');
  });
});
