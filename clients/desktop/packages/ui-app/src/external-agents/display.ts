import {
  EXTERNAL_AGENT_TOOL_GROUPS,
  type ExternalAgentAccessSummary,
  type ExternalAgentActivityTarget,
  type ExternalAgentConfirmationClass,
  type ExternalAgentConnectionStatus,
  type ExternalAgentServer,
  type ExternalAgentServerAddress,
  type ExternalAgentToolGroup,
} from '@canopy/protocol/external-agents';

export const EXTERNAL_AGENT_SERVER_COPY: Record<
  ExternalAgentServer,
  { title: string; line: string }
> = {
  account: {
    title: 'Account and organizations',
    line: 'Your profile, digests, usage, organizations, library, work records and memory.',
  },
  tasks: {
    title: 'Tasks',
    line: 'Projects and tasks in the cloud and on your desktops.',
  },
};

const GROUP_NOUNS: Record<ExternalAgentToolGroup, string> = {
  account: 'account',
  digests: 'digests',
  usage: 'usage',
  billing: 'billing',
  org: 'organizations',
  library: 'the library',
  work: 'work records',
  memory: 'memory',
  cloud: 'cloud tasks',
  remote: 'desktop tasks',
};

function list(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function groupNouns(groups: readonly ExternalAgentToolGroup[]): string[] {
  const selected = new Set(groups);
  return EXTERNAL_AGENT_TOOL_GROUPS.flatMap((group) =>
    selected.has(group) ? [GROUP_NOUNS[group]] : [],
  );
}

function organizationLine(
  organizations: ExternalAgentAccessSummary['organizations'],
): string | null {
  if (organizations === null) return null;
  if (organizations === 'all') return 'All organizations.';
  if (organizations === 0) return 'No organizations.';
  if (organizations === 1) return '1 organization.';
  return `${organizations} organizations.`;
}

function desktopLine(
  desktops: ExternalAgentAccessSummary['desktops'],
): string | null {
  if (desktops === null) return null;
  if (desktops === 'all') return 'All desktops.';
  if (desktops === 0) return 'No desktops.';
  if (desktops === 1) return '1 desktop.';
  return `${desktops} desktops.`;
}

export function accessSummaryLine(summary: ExternalAgentAccessSummary): string {
  const lines: string[] = [];
  const reads = list(groupNouns(summary.read));
  const writes = list(groupNouns(summary.write));
  const destructive = new Set(summary.destructive);

  if (reads !== '') lines.push(`Reads ${reads}.`);
  if (writes !== '') lines.push(`Writes ${writes}.`);
  const removesMembers = destructive.has('org');
  const deletesLibraryItems = destructive.has('library');
  if (removesMembers && deletesLibraryItems) {
    lines.push('Can remove members and teams, and delete library items.');
  } else if (removesMembers) {
    lines.push('Can remove members and teams.');
  } else if (deletesLibraryItems) {
    lines.push('Can delete library items.');
  }
  const organizations = organizationLine(summary.organizations);
  if (organizations !== null) lines.push(organizations);
  const desktops = desktopLine(summary.desktops);
  if (desktops !== null) lines.push(desktops);

  return lines.length === 0 ? 'No access.' : lines.join(' ');
}

export function connectionStatusLabel(
  status: ExternalAgentConnectionStatus,
): string | null {
  if (status === 'paused') return 'Paused';
  if (status === 'expired') return 'Expired';
  return null;
}

export function cursorMcpSnippet(
  servers: readonly ExternalAgentServerAddress[],
  cursorClientId: string,
): string {
  const mcpServers: Partial<
    Record<ExternalAgentServer, { url: string; auth: { CLIENT_ID: string } }>
  > = {};

  for (const server of servers) {
    mcpServers[server.server] = {
      url: server.url,
      auth: { CLIENT_ID: cursorClientId },
    };
  }

  return JSON.stringify({ mcpServers }, null, 2);
}

function activityTargetFallback(
  kind: ExternalAgentActivityTarget['kind'],
): string {
  if (kind === 'organization') return 'an organization';
  if (kind === 'project') return 'a project';
  if (kind === 'remote') return 'a desktop';
  return 'a task';
}

export function activityTargetsLine(
  targets: readonly ExternalAgentActivityTarget[],
): string {
  return targets
    .map((target) => target.label ?? activityTargetFallback(target.kind))
    .join(', ');
}

/** The write classes a person can set to Act or Ask first on an agent's page. */
export const EXTERNAL_AGENT_CONFIRMATION_CLASS_LABELS: Record<
  ExternalAgentConfirmationClass,
  string
> = {
  profile: 'Profile changes',
  settings: 'Settings changes',
  membership: 'Membership changes',
  sharing: 'Sharing changes',
  content: 'Content changes',
  task: 'Tasks',
  pipeline: 'Pipelines',
};

const RELATIVE_UNITS: readonly {
  readonly unit: Intl.RelativeTimeFormatUnit;
  readonly ms: number;
}[] = [
  { unit: 'day', ms: 86_400_000 },
  { unit: 'hour', ms: 3_600_000 },
  { unit: 'minute', ms: 60_000 },
];

/**
 * A time relative to `now`, past or future: "2 minutes ago", "in 8 minutes".
 * Under a minute reads "just now" in the past and "in under a minute" ahead.
 */
export function relativeTimeLabel(value: string, now: number): string {
  const then = new Date(value).getTime();
  if (!Number.isFinite(then)) return 'just now';
  const diff = then - now;
  const magnitude = Math.abs(diff);
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: 'always' });
  for (const { unit, ms } of RELATIVE_UNITS) {
    if (magnitude >= ms) {
      const amount = Math.floor(magnitude / ms);
      return format.format(diff < 0 ? -amount : amount, unit);
    }
  }
  return diff < 0 ? 'just now' : 'in under a minute';
}

/** "Asked 2 minutes ago. Expires in 8 minutes." for a waiting request. */
export function waitingTimingLine(
  requestedAt: string,
  decisionExpiresAt: string,
  now: number,
): string {
  const asked = `Asked ${relativeTimeLabel(requestedAt, now)}.`;
  const expiresAt = new Date(decisionExpiresAt).getTime();
  if (Number.isFinite(expiresAt) && expiresAt <= now) {
    return `${asked} Expired.`;
  }
  return `${asked} Expires ${relativeTimeLabel(decisionExpiresAt, now)}.`;
}
