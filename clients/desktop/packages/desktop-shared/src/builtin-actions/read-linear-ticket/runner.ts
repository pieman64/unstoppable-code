import { brandEnvName, getBrandEnv } from '@canopy/execution-engine/brand/env';
import { setOutput, writeOutputFile } from '../_lib/output';
import { runWithActionEnvironment } from '../_lib/action-env';
import { createLinearClient } from '../_lib/linear-client';

const LINEAR_HOSTED_ISSUE_REGEX =
  /^(?:https?:\/\/)?(?:www\.)?linear\.app\/[^/\s?#]+\/issue\/([^/\s?#]+)/i;
const TICKET_ID_REGEX = /\b([A-Za-z][A-Za-z0-9]*-\d+)\b/;
const MAX_LABELS = 100;

interface LinearConnectionLike<NodeType> {
  nodes: NodeType[];
}

interface LinearUserLike {
  id: string;
  name: string;
  displayName: string;
  email: string;
  active: boolean;
  url: string;
}

interface LinearWorkflowStateLike {
  id: string;
  name: string;
  type: string;
  color: string;
  description?: string | null;
}

interface LinearProjectStatusLike {
  id: string;
  name: string;
  type: string;
  color: string;
  description?: string | null;
}

interface LinearTeamLike {
  id: string;
  key: string;
  name: string;
  displayName: string;
  description?: string | null;
  color?: string | null;
  icon?: string | null;
}

interface LinearProjectLike {
  id: string;
  name: string;
  description: string;
  url: string;
  slugId: string;
  state: string;
  progress: number;
  priority: number;
  priorityLabel: string;
  color: string;
  icon?: string | null;
  startDate?: string | null;
  targetDate?: string | null;
  startedAt?: Date | null;
  completedAt?: Date | null;
  canceledAt?: Date | null;
  updatedAt: Date;
  status?: Promise<LinearProjectStatusLike>;
}

interface LinearCycleLike {
  id: string;
  name?: string | null;
  number: number;
  startsAt: Date;
  endsAt: Date;
  completedAt?: Date | null;
  isActive: boolean;
  isFuture: boolean;
  isPast: boolean;
  progress: number;
}

interface LinearLabelLike {
  id: string;
  name: string;
  color: string;
  description?: string | null;
  isGroup: boolean;
}

interface LinearParentIssueLike {
  id: string;
  identifier: string;
  title: string;
  url: string;
}

interface LinearIssueSearchNodeLike {
  id: string;
  identifier: string;
  previousIdentifiers: string[];
}

interface LinearIssueSearchPayloadLike {
  nodes: LinearIssueSearchNodeLike[];
}

interface LinearIssueLike {
  id: string;
  identifier: string;
  number: number;
  title: string;
  description?: string | null;
  url: string;
  branchName: string;
  customerTicketCount: number;
  labelIds: string[];
  previousIdentifiers: string[];
  priority: number;
  priorityLabel: string;
  estimate?: number | null;
  dueDate?: string | null;
  createdAt: Date;
  updatedAt: Date;
  startedAt?: Date | null;
  completedAt?: Date | null;
  canceledAt?: Date | null;
  archivedAt?: Date | null;
  autoArchivedAt?: Date | null;
  autoClosedAt?: Date | null;
  assignee?: Promise<LinearUserLike>;
  creator?: Promise<LinearUserLike>;
  state?: Promise<LinearWorkflowStateLike>;
  team?: Promise<LinearTeamLike>;
  project?: Promise<LinearProjectLike>;
  cycle?: Promise<LinearCycleLike>;
  parent?: Promise<LinearParentIssueLike>;
  labels(variables?: {
    first?: number;
  }): Promise<LinearConnectionLike<LinearLabelLike>>;
}

export interface LinearClientLike {
  searchIssues(term: string): Promise<LinearIssueSearchPayloadLike>;
  issue(id: string): Promise<LinearIssueLike>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isLinearClientLike(value: unknown): value is LinearClientLike {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.searchIssues === 'function' &&
    typeof value.issue === 'function'
  );
}

export interface LinearUserSummary {
  id: string;
  name: string;
  display_name: string;
  email: string;
  active: boolean;
  url: string;
}

export interface LinearWorkflowStateSummary {
  id: string;
  name: string;
  type: string;
  color: string;
  description: string | null;
}

export interface LinearProjectStatusSummary {
  id: string;
  name: string;
  type: string;
  color: string;
  description: string | null;
}

export interface LinearTeamSummary {
  id: string;
  key: string;
  name: string;
  display_name: string;
  description: string | null;
  color: string | null;
  icon: string | null;
}

export interface LinearProjectSummary {
  id: string;
  name: string;
  description: string;
  url: string;
  slug_id: string;
  state: string;
  progress: number;
  priority: number;
  priority_label: string;
  color: string;
  icon: string | null;
  start_date: string | null;
  target_date: string | null;
  started_at: string | null;
  completed_at: string | null;
  canceled_at: string | null;
  updated_at: string;
  status: LinearProjectStatusSummary | null;
}

export interface LinearCycleSummary {
  id: string;
  name: string | null;
  number: number;
  starts_at: string;
  ends_at: string;
  completed_at: string | null;
  is_active: boolean;
  is_future: boolean;
  is_past: boolean;
  progress: number;
}

export interface LinearLabelSummary {
  id: string;
  name: string;
  color: string;
  description: string | null;
  is_group: boolean;
}

export interface LinearParentIssueSummary {
  id: string;
  ticket_id: string;
  title: string;
  url: string;
}

export interface LinearTicketDetails {
  fetched_at: string;
  ticket_id: string;
  issue_id: string;
  issue_number: number;
  title: string;
  description: string | null;
  url: string;
  status: LinearWorkflowStateSummary | null;
  priority: number;
  priority_label: string;
  assignee: LinearUserSummary | null;
  creator: LinearUserSummary | null;
  team: LinearTeamSummary | null;
  project: LinearProjectSummary | null;
  cycle: LinearCycleSummary | null;
  parent: LinearParentIssueSummary | null;
  labels: LinearLabelSummary[];
  branch_name: string;
  estimate: number | null;
  due_date: string | null;
  customer_ticket_count: number;
  label_ids: string[];
  previous_ticket_ids: string[];
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
  canceled_at: string | null;
  archived_at: string | null;
  auto_archived_at: string | null;
  auto_closed_at: string | null;
}

function normalizeOptionalString(value: string | null | undefined): string {
  return value ?? '';
}

function toSingleLine(value: string | null | undefined): string {
  return normalizeOptionalString(value).replace(/\s+/g, ' ').trim();
}

function toIsoString(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function normalizeTicketId(value: string): string {
  return value.trim().toUpperCase();
}

function matchesTicketId(candidate: string, ticketId: string): boolean {
  return normalizeTicketId(candidate) === ticketId;
}

export function extractTicketIdentifier(rawInput: string): string {
  const trimmed = rawInput.trim();
  if (!trimmed) {
    throw new Error('ticket_id is required');
  }

  const hostedMatch = trimmed.match(LINEAR_HOSTED_ISSUE_REGEX);
  if (hostedMatch?.[1]) {
    const hostedIdMatch = hostedMatch[1].match(TICKET_ID_REGEX);
    if (hostedIdMatch?.[1]) {
      return normalizeTicketId(hostedIdMatch[1]);
    }
  }

  const directMatch = trimmed.match(TICKET_ID_REGEX);
  if (directMatch?.[1]) {
    return normalizeTicketId(directMatch[1]);
  }

  throw new Error(
    'ticket_id must contain a Linear ticket identifier like TEAM-123 or a Linear issue URL',
  );
}

async function resolveOptional<T>(
  value: Promise<T> | undefined,
): Promise<T | null> {
  return value ? value : null;
}

function summarizeUser(user: LinearUserLike | null): LinearUserSummary | null {
  if (!user) {
    return null;
  }

  return {
    id: user.id,
    name: user.name,
    display_name: user.displayName,
    email: user.email,
    active: user.active,
    url: user.url,
  };
}

function summarizeWorkflowState(
  state: LinearWorkflowStateLike | null,
): LinearWorkflowStateSummary | null {
  if (!state) {
    return null;
  }

  return {
    id: state.id,
    name: state.name,
    type: state.type,
    color: state.color,
    description: state.description ?? null,
  };
}

function summarizeProjectStatus(
  status: LinearProjectStatusLike | null,
): LinearProjectStatusSummary | null {
  if (!status) {
    return null;
  }

  return {
    id: status.id,
    name: status.name,
    type: status.type,
    color: status.color,
    description: status.description ?? null,
  };
}

function summarizeTeam(team: LinearTeamLike | null): LinearTeamSummary | null {
  if (!team) {
    return null;
  }

  return {
    id: team.id,
    key: team.key,
    name: team.name,
    display_name: team.displayName,
    description: team.description ?? null,
    color: team.color ?? null,
    icon: team.icon ?? null,
  };
}

async function summarizeProject(
  project: LinearProjectLike | null,
): Promise<LinearProjectSummary | null> {
  if (!project) {
    return null;
  }

  const projectStatus = await resolveOptional(project.status);

  return {
    id: project.id,
    name: project.name,
    description: project.description,
    url: project.url,
    slug_id: project.slugId,
    state: project.state,
    progress: project.progress,
    priority: project.priority,
    priority_label: project.priorityLabel,
    color: project.color,
    icon: project.icon ?? null,
    start_date: project.startDate ?? null,
    target_date: project.targetDate ?? null,
    started_at: toIsoString(project.startedAt),
    completed_at: toIsoString(project.completedAt),
    canceled_at: toIsoString(project.canceledAt),
    updated_at: project.updatedAt.toISOString(),
    status: summarizeProjectStatus(projectStatus),
  };
}

function summarizeCycle(
  cycle: LinearCycleLike | null,
): LinearCycleSummary | null {
  if (!cycle) {
    return null;
  }

  return {
    id: cycle.id,
    name: cycle.name ?? null,
    number: cycle.number,
    starts_at: cycle.startsAt.toISOString(),
    ends_at: cycle.endsAt.toISOString(),
    completed_at: toIsoString(cycle.completedAt),
    is_active: cycle.isActive,
    is_future: cycle.isFuture,
    is_past: cycle.isPast,
    progress: cycle.progress,
  };
}

function summarizeLabels(labels: LinearLabelLike[]): LinearLabelSummary[] {
  return labels.map((label) => ({
    id: label.id,
    name: label.name,
    color: label.color,
    description: label.description ?? null,
    is_group: label.isGroup,
  }));
}

function summarizeParentIssue(
  issue: LinearParentIssueLike | null,
): LinearParentIssueSummary | null {
  if (!issue) {
    return null;
  }

  return {
    id: issue.id,
    ticket_id: issue.identifier,
    title: issue.title,
    url: issue.url,
  };
}

function findIssueMatch(
  searchResults: LinearIssueSearchNodeLike[],
  ticketId: string,
): LinearIssueSearchNodeLike | null {
  for (const result of searchResults) {
    if (matchesTicketId(result.identifier, ticketId)) {
      return result;
    }

    if (
      result.previousIdentifiers.some((identifier) =>
        matchesTicketId(identifier, ticketId),
      )
    ) {
      return result;
    }
  }

  return null;
}

export async function fetchLinearTicketDetails(
  client: LinearClientLike,
  ticketId: string,
): Promise<LinearTicketDetails> {
  const searchPayload = await client.searchIssues(ticketId);
  const match = findIssueMatch(searchPayload.nodes, ticketId);

  if (!match) {
    throw new Error(`Unable to find Linear ticket "${ticketId}"`);
  }

  const issue = await client.issue(match.id);
  const [
    assignee,
    creator,
    state,
    team,
    project,
    cycle,
    parent,
    labelsConnection,
  ] = await Promise.all([
    resolveOptional(issue.assignee),
    resolveOptional(issue.creator),
    resolveOptional(issue.state),
    resolveOptional(issue.team),
    resolveOptional(issue.project),
    resolveOptional(issue.cycle),
    resolveOptional(issue.parent),
    issue.labels({ first: MAX_LABELS }),
  ]);

  return {
    fetched_at: new Date().toISOString(),
    ticket_id: issue.identifier,
    issue_id: issue.id,
    issue_number: issue.number,
    title: issue.title,
    description: issue.description ?? null,
    url: issue.url,
    status: summarizeWorkflowState(state),
    priority: issue.priority,
    priority_label: issue.priorityLabel,
    assignee: summarizeUser(assignee),
    creator: summarizeUser(creator),
    team: summarizeTeam(team),
    project: await summarizeProject(project),
    cycle: summarizeCycle(cycle),
    parent: summarizeParentIssue(parent),
    labels: summarizeLabels(labelsConnection.nodes),
    branch_name: issue.branchName,
    estimate: issue.estimate ?? null,
    due_date: issue.dueDate ?? null,
    customer_ticket_count: issue.customerTicketCount,
    label_ids: issue.labelIds,
    previous_ticket_ids: issue.previousIdentifiers,
    created_at: issue.createdAt.toISOString(),
    updated_at: issue.updatedAt.toISOString(),
    started_at: toIsoString(issue.startedAt),
    completed_at: toIsoString(issue.completedAt),
    canceled_at: toIsoString(issue.canceledAt),
    archived_at: toIsoString(issue.archivedAt),
    auto_archived_at: toIsoString(issue.autoArchivedAt),
    auto_closed_at: toIsoString(issue.autoClosedAt),
  };
}

function renderSummary(details: LinearTicketDetails): string {
  const labelNames = details.labels.map((label) => label.name);

  return [
    '# Linear Ticket',
    '',
    `- Ticket: ${details.ticket_id}`,
    `- Title: ${details.title}`,
    `- URL: ${details.url}`,
    `- Status: ${details.status?.name ?? '(none)'}`,
    `- Status type: ${details.status?.type ?? '(none)'}`,
    `- Priority: ${details.priority_label} (${String(details.priority)})`,
    `- Assignee: ${details.assignee?.display_name ?? details.assignee?.name ?? '(unassigned)'}`,
    `- Creator: ${details.creator?.display_name ?? details.creator?.name ?? '(unknown)'}`,
    `- Team: ${details.team?.display_name ?? details.team?.name ?? '(none)'}`,
    `- Project: ${details.project?.name ?? '(none)'}`,
    `- Cycle: ${details.cycle?.name ?? (details.cycle ? `Cycle ${String(details.cycle.number)}` : '(none)')}`,
    `- Labels: ${labelNames.length > 0 ? labelNames.join(', ') : '(none)'}`,
    `- Branch name: ${details.branch_name || '(none)'}`,
    `- Estimate: ${details.estimate === null ? '(none)' : String(details.estimate)}`,
    `- Due date: ${details.due_date ?? '(none)'}`,
    `- Created at: ${details.created_at}`,
    `- Updated at: ${details.updated_at}`,
    '',
    '## Description',
    details.description && details.description.trim().length > 0
      ? details.description
      : '(empty)',
    '',
  ].join('\n');
}

function setCommonOutputs(details: LinearTicketDetails): void {
  setOutput('ticket_id', details.ticket_id);
  setOutput('issue_id', details.issue_id);
  setOutput('issue_number', String(details.issue_number));
  setOutput('title', toSingleLine(details.title));
  setOutput('description', toSingleLine(details.description));
  setOutput('url', details.url);
  setOutput('status', details.status?.name ?? '');
  setOutput('status_type', details.status?.type ?? '');
  setOutput('status_json', JSON.stringify(details.status));
  setOutput('priority', details.priority_label);
  setOutput('priority_value', String(details.priority));
  setOutput(
    'assignee',
    details.assignee?.display_name || details.assignee?.name || '',
  );
  setOutput('assignee_email', details.assignee?.email ?? '');
  setOutput('assignee_json', JSON.stringify(details.assignee));
  setOutput(
    'creator',
    details.creator?.display_name || details.creator?.name || '',
  );
  setOutput('creator_email', details.creator?.email ?? '');
  setOutput('creator_json', JSON.stringify(details.creator));
  setOutput('team', details.team?.display_name || details.team?.name || '');
  setOutput('team_key', details.team?.key ?? '');
  setOutput('team_json', JSON.stringify(details.team));
  setOutput('project', details.project?.name ?? '');
  setOutput('project_status', details.project?.status?.name ?? '');
  setOutput('project_json', JSON.stringify(details.project));
  setOutput(
    'cycle',
    details.cycle?.name ??
      (details.cycle ? `Cycle ${String(details.cycle.number)}` : ''),
  );
  setOutput('cycle_json', JSON.stringify(details.cycle));
  setOutput('parent_ticket_id', details.parent?.ticket_id ?? '');
  setOutput('parent_json', JSON.stringify(details.parent));
  setOutput('branch_name', details.branch_name);
  setOutput(
    'estimate',
    details.estimate === null ? '' : String(details.estimate),
  );
  setOutput('due_date', details.due_date ?? '');
  setOutput('created_at', details.created_at);
  setOutput('updated_at', details.updated_at);
  setOutput(
    'labels',
    JSON.stringify(details.labels.map((label) => label.name)),
  );
  setOutput('details_json', JSON.stringify(details));
}

export async function runReadLinearTicketAction(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await runWithActionEnvironment(env, async () => {
    const apiKey = getBrandEnv(env, 'LINEAR_API_KEY')?.trim();
    if (!apiKey) {
      throw new Error(
        `${brandEnvName('LINEAR_API_KEY')} is required to use builtin/read-linear-ticket`,
      );
    }

    const rawTicketId = env.INPUT_TICKET_ID ?? '';
    const ticketId = extractTicketIdentifier(rawTicketId);
    const client = createLinearClient(apiKey);
    if (!isLinearClientLike(client)) {
      throw new Error('Linear client is unavailable');
    }
    const details = await fetchLinearTicketDetails(client, ticketId);

    writeOutputFile(
      'details_json_file',
      'linear-ticket-details.json',
      `${JSON.stringify(details, null, 2)}\n`,
    );
    writeOutputFile(
      'summary_file',
      'linear-ticket-summary.md',
      renderSummary(details),
    );

    setCommonOutputs(details);
  });
}
