import type {
  ExternalAgentAccessSummary,
  ExternalAgentActivityTarget,
  ExternalAgentServerAddress,
} from '@canopy/protocol/external-agents';
import {
  accessSummaryLine,
  activityTargetsLine,
  connectionStatusLabel,
  cursorMcpSnippet,
  EXTERNAL_AGENT_CONFIRMATION_CLASS_LABELS,
  EXTERNAL_AGENT_SERVER_COPY,
  relativeTimeLabel,
  waitingTimingLine,
} from '../display';

function summary(
  overrides: Partial<ExternalAgentAccessSummary> = {},
): ExternalAgentAccessSummary {
  return {
    read: [],
    write: [],
    destructive: [],
    organizations: null,
    desktops: null,
    ...overrides,
  };
}

describe('external-agent display helpers', () => {
  it('shares the consent server copy', () => {
    expect(EXTERNAL_AGENT_SERVER_COPY).toEqual({
      account: {
        title: 'Account and organizations',
        line: 'Your profile, digests, usage, organizations, library, work records and memory.',
      },
      tasks: {
        title: 'Tasks',
        line: 'Projects and tasks in the cloud and on your desktops.',
      },
    });
  });

  it('summarizes groups in catalog order with plain sentences', () => {
    expect(
      accessSummaryLine(
        summary({
          read: ['digests', 'account'],
          write: ['cloud'],
          organizations: 1,
          desktops: null,
        }),
      ),
    ).toBe('Reads account and digests. Writes cloud tasks. 1 organization.');
    expect(
      accessSummaryLine(
        summary({
          read: ['billing', 'usage', 'digests'],
          write: ['work', 'org'],
        }),
      ),
    ).toBe(
      'Reads digests, usage and billing. Writes organizations and work records.',
    );
    expect(
      accessSummaryLine(summary({ read: ['remote', 'memory', 'library'] })),
    ).toBe('Reads the library, memory and desktop tasks.');
    expect(accessSummaryLine(summary({ destructive: ['org'] }))).toBe(
      'Can remove members and teams.',
    );
    expect(accessSummaryLine(summary({ destructive: ['library'] }))).toBe(
      'Can delete library items.',
    );
    expect(
      accessSummaryLine(summary({ destructive: ['org', 'library'] })),
    ).toBe('Can remove members and teams, and delete library items.');
    expect(
      accessSummaryLine(
        summary({
          write: ['org', 'library'],
          destructive: ['org', 'library'],
        }),
      ),
    ).toBe(
      'Writes organizations and the library. Can remove members and teams, and delete library items.',
    );
  });

  it('summarizes all, zero and counted organization and desktop access', () => {
    expect(accessSummaryLine(summary({ organizations: 'all' }))).toBe(
      'All organizations.',
    );
    expect(accessSummaryLine(summary({ organizations: 0 }))).toBe(
      'No organizations.',
    );
    expect(accessSummaryLine(summary({ organizations: 4 }))).toBe(
      '4 organizations.',
    );
    expect(
      accessSummaryLine(summary({ organizations: null, desktops: 'all' })),
    ).toBe('All desktops.');
    expect(accessSummaryLine(summary({ desktops: 0 }))).toBe('No desktops.');
    expect(accessSummaryLine(summary({ desktops: 1 }))).toBe('1 desktop.');
    expect(accessSummaryLine(summary({ desktops: 3 }))).toBe('3 desktops.');
  });

  it('reports no access when the summary has no enabled scope', () => {
    expect(accessSummaryLine(summary())).toBe('No access.');
  });

  it('labels paused and expired connections but not active ones', () => {
    expect(connectionStatusLabel('active')).toBeNull();
    expect(connectionStatusLabel('paused')).toBe('Paused');
    expect(connectionStatusLabel('expired')).toBe('Expired');
  });

  it('builds the Cursor snippet in server order', () => {
    const servers: ExternalAgentServerAddress[] = [
      { server: 'tasks', url: 'https://mcp.example.com/tasks' },
      { server: 'account', url: 'https://mcp.example.com/account' },
    ];

    expect(cursorMcpSnippet(servers, 'cursor-client')).toBe(`{
  "mcpServers": {
    "tasks": {
      "url": "https://mcp.example.com/tasks",
      "auth": {
        "CLIENT_ID": "cursor-client"
      }
    },
    "account": {
      "url": "https://mcp.example.com/account",
      "auth": {
        "CLIENT_ID": "cursor-client"
      }
    }
  }
}`);
  });

  it('lists activity targets by label or a clear fallback', () => {
    const targets: ExternalAgentActivityTarget[] = [
      { kind: 'organization', id: 'org-id', label: 'Northwind' },
      { kind: 'project', id: 'project-id', label: null },
      { kind: 'remote', id: 'remote-id', label: null },
      { kind: 'task', id: 'task-id', label: 'Review issue' },
    ];

    expect(activityTargetsLine(targets)).toBe(
      'Northwind, a project, a desktop, Review issue',
    );
    expect(activityTargetsLine([])).toBe('');
  });

  it('labels each confirmation class in display order', () => {
    expect(EXTERNAL_AGENT_CONFIRMATION_CLASS_LABELS).toEqual({
      profile: 'Profile changes',
      settings: 'Settings changes',
      membership: 'Membership changes',
      sharing: 'Sharing changes',
      content: 'Content changes',
      task: 'Tasks',
      pipeline: 'Pipelines',
    });
  });

  it('formats relative past and future times', () => {
    const now = Date.parse('2026-10-15T12:10:00.000Z');

    expect(relativeTimeLabel('2026-10-15T12:08:00.000Z', now)).toBe(
      '2 minutes ago',
    );
    expect(relativeTimeLabel('2026-10-15T12:18:00.000Z', now)).toBe(
      'in 8 minutes',
    );
    expect(relativeTimeLabel('not a date', now)).toBe('just now');
  });

  it('shows when a request was made and when it expires', () => {
    const now = Date.parse('2026-10-15T12:10:00.000Z');

    expect(
      waitingTimingLine(
        '2026-10-15T12:08:00.000Z',
        '2026-10-15T12:18:00.000Z',
        now,
      ),
    ).toBe('Asked 2 minutes ago. Expires in 8 minutes.');
    expect(
      waitingTimingLine(
        '2026-10-15T12:08:00.000Z',
        '2026-10-15T12:09:00.000Z',
        now,
      ),
    ).toBe('Asked 2 minutes ago. Expired.');
  });
});
