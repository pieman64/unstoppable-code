/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * CAN-3383 admin participation label: members whose chats have not reached
 * organization memory in 30 days get a neutral, metric-only note. It renders
 * only inside the admin participation list and never names a cause.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { MemoryParticipationMember } from '@canopy/protocol';
import type { OrganizationRole } from '@canopy/protocol/settings/organization';
import {
  createFakeSettingsClient,
  createTestSettingsHost,
  TestSettingsHost,
  type FakeSettingsClient,
} from '../../__tests__/helpers/test-settings-host';
import { TeamMemorySettingsSection } from '../team-memory-settings-section';

const QUIET_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ACTIVE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const MEMBERS: MemoryParticipationMember[] = [
  {
    userId: QUIET_ID,
    name: 'Quiet Member',
    email: 'quiet@example.com',
    role: 'MEMBER',
    memoryEnabled: true,
    contributingRecently: false,
  },
  {
    userId: ACTIVE_ID,
    name: 'Active Member',
    email: 'active@example.com',
    role: 'ADMIN',
    memoryEnabled: true,
    contributingRecently: true,
  },
];

describe('TeamMemorySettingsSection recent-contribution label', () => {
  let container: HTMLElement;
  let root: Root;
  let client: FakeSettingsClient;

  beforeEach(() => {
    client = createFakeSettingsClient({
      'organization.settings.memoryParticipation': () => ({
        members: MEMBERS,
      }),
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function render(
    viewerRole: OrganizationRole,
    privacy?: { blockClassName: string; maskClassName: string },
  ): Promise<void> {
    const { host } = createTestSettingsHost({ client, privacy });
    await act(async () => {
      root.render(
        <TestSettingsHost host={host}>
          <TeamMemorySettingsSection
            orgId="org-1"
            orgName="Acme Labs"
            viewerRole={viewerRole}
            memoryEnabled
          />
        </TestSettingsHost>,
      );
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  it('labels only members without recent chat contributions', async () => {
    await render('OWNER');
    const quiet = container.querySelector<HTMLElement>(
      `[data-testid="memory-participation-quiet-${QUIET_ID}"]`,
    );
    expect(quiet?.textContent).toBe('No recent chat contributions');
    expect(
      container.querySelector(
        `[data-testid="memory-participation-quiet-${ACTIVE_ID}"]`,
      ),
    ).toBeNull();
  });

  it('explains the metric, and only the metric, in a tooltip', async () => {
    await render('ADMIN');
    const quiet = container.querySelector<HTMLElement>(
      `[data-testid="memory-participation-quiet-${QUIET_ID}"]`,
    );
    const wrapper = quiet?.parentElement;
    if (!quiet || !wrapper) throw new Error('Missing quiet label');
    await act(async () => {
      wrapper.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      await Promise.resolve();
    });
    const tooltip = document.body.querySelector('[role="tooltip"]');
    expect(tooltip?.textContent).toBe(
      'No chats contributed to Acme Labs memory in 30 days.',
    );
    expect(quiet.getAttribute('aria-describedby')).toBe(tooltip?.id);
  });

  it('is never shown to non-admins', async () => {
    await render('MEMBER');
    expect(container.innerHTML).toBe('');
    expect(client.calls).toHaveLength(0);
  });

  it('reads participation through the settings client for the org', async () => {
    await render('OWNER');
    expect(client.calls).toEqual([
      {
        operation: 'organization.settings.memoryParticipation',
        input: { organizationId: 'org-1' },
      },
    ]);
  });

  it('blocks member names and emails from session replay', async () => {
    await render('OWNER', {
      blockClassName: 'replay-block',
      maskClassName: 'replay-mask',
    });
    const row = container.querySelector<HTMLElement>(
      `[data-testid="memory-participation-row-${QUIET_ID}"]`,
    );
    const identity = row?.querySelector('.replay-block');
    expect(identity?.textContent).toContain('Quiet Member');
    expect(identity?.textContent).toContain('quiet@example.com');
  });

  it('adds no class token when the host records no replay', async () => {
    await render('OWNER');
    const row = container.querySelector<HTMLElement>(
      `[data-testid="memory-participation-row-${QUIET_ID}"]`,
    );
    expect(row?.firstElementChild?.getAttribute('class')).toBe('min-w-0');
  });
});
