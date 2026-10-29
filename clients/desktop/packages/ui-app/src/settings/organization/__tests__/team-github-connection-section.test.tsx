/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import type {
  OrganizationDetail,
  OrganizationRole,
} from '@canopy/protocol/settings/organization';
import {
  createFakeSettingsClient,
  createTestSettingsHost,
  TestSettingsHost,
  type FakeSettingsClient,
  type FakeSettingsHandler,
} from '../../__tests__/helpers/test-settings-host';
import { TeamGitHubConnectionSection } from '../team-github-connection-section';
import {
  OrganizationSettingsSubtabSlotsProvider,
  type OrganizationSettingsSubtabSlots,
} from '../settings/organization-settings-subtab-slots';
import type { SettingsOperationName } from '@canopy/protocol/settings';

function render(node: ReactNode): string {
  return renderToString(<TestSettingsHost>{node}</TestSettingsHost>);
}

function buildDetail(
  overrides: Partial<OrganizationDetail> = {},
): OrganizationDetail {
  return {
    id: 'org-1',
    name: 'Acme',
    viewerRole: 'ADMIN',
    members: [],
    subTeams: [],
    usageStatsMinRole: 'ADMIN',
    canViewUsageStats: true,
    logoUrl: null,
    githubConnection: { connected: false, accountLogin: null },
    ...overrides,
  };
}

const noop = (): void => undefined;

describe('TeamGitHubConnectionSection', () => {
  it('renders a Connect button when not connected and the viewer can edit', () => {
    const html = render(
      <TeamGitHubConnectionSection
        detail={buildDetail()}
        onDetailChange={noop}
      />,
    );

    expect(html).toContain('GitHub connection');
    expect(html).toContain('team-github-connect');
    expect(html).toContain('Connect GitHub');
    expect(html).not.toContain('team-github-disconnect');
  });

  it('renders the connected state with the account login and a Disconnect control', () => {
    const html = render(
      <TeamGitHubConnectionSection
        detail={buildDetail({
          githubConnection: { connected: true, accountLogin: 'acme-org' },
        })}
        onDetailChange={noop}
      />,
    );

    expect(html).toContain('Connected');
    expect(html).toContain('acme-org');
    expect(html).toContain('team-github-disconnect');
    expect(html).not.toContain('team-github-connect"');
  });

  it.each<OrganizationRole>(['MEMBER'])(
    'returns null for %s viewers who cannot edit the org',
    (viewerRole) => {
      const html = render(
        <TeamGitHubConnectionSection
          detail={buildDetail({ viewerRole })}
          onDetailChange={noop}
        />,
      );

      expect(html).toBe('');
    },
  );
});

describe('TeamGitHubConnectionSection connect handoff', () => {
  const INSTALL_URL = 'https://github.com/apps/canopy/installations/new';
  let container: HTMLElement;
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

  function mount(options: {
    handlers: Partial<Record<SettingsOperationName, FakeSettingsHandler>>;
    slots?: OrganizationSettingsSubtabSlots;
    openExternal?: (url: string) => void;
    onDetailChange?: (detail: OrganizationDetail) => void;
  }): FakeSettingsClient {
    const client = createFakeSettingsClient(options.handlers);
    const { host } = createTestSettingsHost({
      client,
      navigation:
        options.openExternal === undefined
          ? {}
          : { openExternal: options.openExternal },
    });
    act(() => {
      root.render(
        <TestSettingsHost host={host}>
          <OrganizationSettingsSubtabSlotsProvider slots={options.slots ?? {}}>
            <TeamGitHubConnectionSection
              detail={buildDetail()}
              onDetailChange={options.onDetailChange ?? noop}
            />
          </OrganizationSettingsSubtabSlotsProvider>
        </TestSettingsHost>,
      );
    });
    return client;
  }

  function byTestId(testId: string): HTMLButtonElement {
    const element = container.querySelector<HTMLButtonElement>(
      `[data-testid="${testId}"]`,
    );
    if (element === null) throw new Error(`Missing [data-testid="${testId}"]`);
    return element;
  }

  async function press(testId: string): Promise<void> {
    const element = byTestId(testId);
    await act(async () => {
      element.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  it('follows the install URL in this tab when the host supplies the slot', async () => {
    const followGitHubInstallUrl = jest.fn();
    const openExternal = jest.fn();
    const client = mount({
      handlers: {
        'organization.github.connect': () => ({ installUrl: INSTALL_URL }),
      },
      slots: { followGitHubInstallUrl },
      openExternal,
    });

    await press('team-github-connect');

    expect(client.calls).toEqual([
      {
        operation: 'organization.github.connect',
        input: { organizationId: 'org-1' },
      },
    ]);
    expect(followGitHubInstallUrl).toHaveBeenCalledWith(INSTALL_URL);
    expect(openExternal).not.toHaveBeenCalled();
    // The page is leaving, so the button keeps its in-flight label.
    expect(byTestId('team-github-connect').textContent).toContain(
      'Connecting…',
    );
  });

  it('opens the install in the browser and offers Check again without the slot', async () => {
    const openExternal = jest.fn();
    const onDetailChange = jest.fn();
    const connected = buildDetail({
      githubConnection: { connected: true, accountLogin: 'acme-org' },
    });
    const client = mount({
      handlers: {
        'organization.github.connect': () => ({ installUrl: INSTALL_URL }),
        'organization.detail': () => connected,
      },
      openExternal,
      onDetailChange,
    });

    await press('team-github-connect');

    expect(openExternal).toHaveBeenCalledWith(INSTALL_URL);
    expect(byTestId('team-github-continue-in-browser').textContent).toContain(
      'Continue in your browser.',
    );
    expect(
      container.querySelector('[data-testid="team-github-connect"]'),
    ).toBeNull();

    await press('team-github-check-again');

    expect(client.calls.map((call) => call.operation)).toEqual([
      'organization.github.connect',
      'organization.detail',
    ]);
    expect(onDetailChange).toHaveBeenCalledWith(connected);
  });

  it('keeps the browser state and shows the reason when Check again fails', async () => {
    mount({
      handlers: {
        'organization.github.connect': () => ({ installUrl: INSTALL_URL }),
        'organization.detail': () => {
          throw new Error('SENTINEL-SERVER-BODY');
        },
      },
      openExternal: jest.fn(),
    });

    await press('team-github-connect');
    await press('team-github-check-again');

    expect(container.textContent).toContain(
      "Couldn't check the GitHub connection. Try again.",
    );
    expect(container.textContent).not.toContain('SENTINEL-SERVER-BODY');
    expect(byTestId('team-github-check-again').textContent).toBe('Check again');
  });
});
