import fs from 'node:fs';
import { getBrandEnv } from '@canopy/execution-engine/brand/env';
import { runWithActionEnvironment } from '../_lib/action-env';
import { createLinearClient } from '../_lib/linear-client';
import { setOutput, writeOutputFile } from '../_lib/output';
import {
  fetchLinearTicketDetails,
  isLinearClientLike,
  type LinearClientLike,
  type LinearTicketDetails,
} from '../read-linear-ticket/runner';

const TICKET_ID_REGEX = /\b([A-Za-z][A-Za-z0-9]*-\d+)\b/g;
const DEFAULT_MAX_TICKETS = 3;
const TEAM_PAGE_SIZE = 250;
const MAX_TEAM_PAGES = 20;

interface LinearConnectionLike<NodeType> {
  nodes: NodeType[];
  pageInfo?: {
    hasNextPage?: boolean;
    endCursor?: string | null;
  };
}

interface LinearTeamLike {
  id: string;
  key: string;
  name: string;
}

interface LinearTeamListClientLike {
  teams(variables?: {
    first?: number;
    after?: string;
  }): Promise<LinearConnectionLike<LinearTeamLike>>;
}

interface TicketCandidate {
  id: string;
  prefix: string;
  extractionSources: string[];
}

interface InvalidTicketCandidate extends TicketCandidate {
  reason: 'invalid_prefix' | 'team_validation_unavailable';
}

interface TicketFetchError {
  ticket_id: string;
  error: string;
}

interface LinearContext {
  detectedTicketIds: string[];
  ticketSources: TicketCandidate[];
  candidateTicketIds: string[];
  candidateTicketSources: TicketCandidate[];
  invalidTicketCandidates: InvalidTicketCandidate[];
  validTeamPrefixes: string[];
  hasLinearToken: boolean;
  teamListFetched: boolean;
  teamListError: string | null;
  tickets: LinearTicketDetails[];
  missingTicketIds: string[];
  ticketFetchErrors: TicketFetchError[];
  truncated: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isLinearTeamListClientLike(
  value: unknown,
): value is LinearTeamListClientLike {
  return isRecord(value) && typeof value.teams === 'function';
}

function readJson(filePath: string, fallback: unknown): unknown {
  if (!filePath || !fs.existsSync(filePath)) {
    return fallback;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function normalizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeTicketId(candidate: string): string {
  const [prefix = '', number = ''] = candidate.split('-');
  return `${prefix.toUpperCase()}-${String(Number.parseInt(number, 10))}`;
}

function getTicketPrefix(ticketId: string): string {
  return ticketId.split('-')[0]?.toUpperCase() ?? '';
}

function addCandidate(
  candidates: TicketCandidate[],
  seen: Map<string, TicketCandidate>,
  sourceName: string,
  rawCandidate: string,
): void {
  const id = normalizeTicketId(rawCandidate);
  const existing = seen.get(id);
  if (existing) {
    if (!existing.extractionSources.includes(sourceName)) {
      existing.extractionSources.push(sourceName);
    }
    return;
  }

  const candidate = {
    id,
    prefix: getTicketPrefix(id),
    extractionSources: [sourceName],
  };
  seen.set(id, candidate);
  candidates.push(candidate);
}

function detectTicketCandidates(args: {
  currentBranch: string;
  prJsonFile: string;
}): TicketCandidate[] {
  const prLookup = readJson(args.prJsonFile.trim(), {});
  const pr = isRecord(prLookup) && isRecord(prLookup.pr) ? prLookup.pr : null;
  const sources = {
    branch: args.currentBranch,
    title: pr && typeof pr.title === 'string' ? pr.title : '',
    description: pr && typeof pr.body === 'string' ? pr.body : '',
  };

  const candidates: TicketCandidate[] = [];
  const seen = new Map<string, TicketCandidate>();
  for (const [sourceName, text] of Object.entries(sources)) {
    const regex = new RegExp(TICKET_ID_REGEX);
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      const rawCandidate = match[1];
      if (rawCandidate) {
        addCandidate(candidates, seen, sourceName, rawCandidate);
      }
    }
  }

  return candidates;
}

async function fetchLinearTeamPrefixes(
  client: LinearTeamListClientLike,
): Promise<string[]> {
  const prefixes = new Set<string>();
  let after: string | undefined;

  for (let page = 0; page < MAX_TEAM_PAGES; page++) {
    const payload = await client.teams({ first: TEAM_PAGE_SIZE, after });
    for (const team of payload.nodes) {
      const key = typeof team.key === 'string' ? team.key.trim() : '';
      if (key.length > 0) {
        prefixes.add(key.toUpperCase());
      }
    }

    if (!payload.pageInfo?.hasNextPage || !payload.pageInfo.endCursor) {
      break;
    }
    after = payload.pageInfo.endCursor;
  }

  return Array.from(prefixes).sort((left, right) => left.localeCompare(right));
}

function parseMaxTickets(rawValue: string | undefined): number {
  const parsed = Number.parseInt(rawValue ?? '', 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_MAX_TICKETS;
  }
  return Math.min(parsed, 10);
}

async function fetchTickets(args: {
  client: LinearClientLike;
  ticketIds: string[];
  maxTickets: number;
}): Promise<{
  tickets: LinearTicketDetails[];
  errors: TicketFetchError[];
  truncated: boolean;
}> {
  const tickets: LinearTicketDetails[] = [];
  const errors: TicketFetchError[] = [];
  const ticketIdsToFetch = args.ticketIds.slice(0, args.maxTickets);

  for (const ticketId of ticketIdsToFetch) {
    try {
      tickets.push(await fetchLinearTicketDetails(args.client, ticketId));
    } catch (error: unknown) {
      errors.push({ ticket_id: ticketId, error: normalizeError(error) });
    }
  }

  return {
    tickets,
    errors,
    truncated: args.ticketIds.length > args.maxTickets,
  };
}

function buildSummary(context: LinearContext): string {
  const summaryLines = [
    '# Linear Context',
    '',
    `- Validated Linear tickets: ${
      context.detectedTicketIds.length > 0
        ? context.detectedTicketIds.join(', ')
        : '(none)'
    }`,
    `- Fetched ticket details: ${String(context.tickets.length)}`,
  ];

  if (!context.hasLinearToken) {
    summaryLines.push(
      '- Note: Linear ticket context was skipped because no Linear token is available.',
    );
  } else if (context.teamListError) {
    summaryLines.push(
      `- Note: Linear team-prefix validation failed: ${context.teamListError}`,
    );
  }
  if (context.invalidTicketCandidates.length > 0) {
    summaryLines.push(
      `- Rejected ticket-shaped candidates: ${context.invalidTicketCandidates
        .map((candidate) => candidate.id)
        .join(', ')}`,
    );
  }
  if (context.truncated) {
    summaryLines.push(
      '- Note: only the first validated Linear tickets were fetched by this pipeline run.',
    );
  }
  if (context.missingTicketIds.length > 0) {
    summaryLines.push(
      `- Missing details: ${context.missingTicketIds.join(', ')}`,
    );
  }
  if (context.ticketFetchErrors.length > 0) {
    summaryLines.push(
      `- Ticket fetch errors: ${context.ticketFetchErrors
        .map((entry) => `${entry.ticket_id}: ${entry.error}`)
        .join('; ')}`,
    );
  }

  if (context.tickets.length > 0) {
    summaryLines.push('', '## Tickets');
    for (const ticket of context.tickets) {
      const title = ticket.title || '(untitled)';
      const status = ticket.status?.name ?? '(unknown)';
      const assignee =
        ticket.assignee?.display_name ||
        ticket.assignee?.name ||
        '(unassigned)';
      const labels = ticket.labels.map((label) => label.name);
      summaryLines.push(
        '',
        `### ${ticket.ticket_id}: ${title}`,
        '',
        `- URL: ${ticket.url}`,
        `- Status: ${status}`,
        `- Priority: ${ticket.priority_label}`,
        `- Team: ${
          ticket.team?.display_name || ticket.team?.name || '(unknown)'
        }`,
        `- Project: ${ticket.project?.name ?? '(none)'}`,
        `- Assignee: ${assignee}`,
        `- Labels: ${labels.length > 0 ? labels.join(', ') : '(none)'}`,
        `- Branch name: ${ticket.branch_name || '(none)'}`,
        '',
        '#### Description',
        '',
        ticket.description && ticket.description.trim().length > 0
          ? ticket.description
          : '(empty)',
      );
    }
  }

  return `${summaryLines.join('\n')}\n`;
}

function setCommonOutputs(context: LinearContext): void {
  setOutput(
    'detected_ticket_ids_json',
    JSON.stringify(context.detectedTicketIds),
  );
  setOutput('ticket_sources_json', JSON.stringify(context.ticketSources));
  setOutput('ticket_count', String(context.detectedTicketIds.length));
  setOutput('has_linear_token', context.hasLinearToken ? 'true' : 'false');
  setOutput('team_list_fetched', context.teamListFetched ? 'true' : 'false');
  setOutput(
    'valid_team_prefixes_json',
    JSON.stringify(context.validTeamPrefixes),
  );
  setOutput(
    'candidate_ticket_ids_json',
    JSON.stringify(context.candidateTicketIds),
  );
  setOutput(
    'invalid_ticket_candidates_json',
    JSON.stringify(context.invalidTicketCandidates),
  );
}

export async function runGatherLinearContextAction(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await runWithActionEnvironment(env, async () => {
    const apiKey = getBrandEnv(env, 'LINEAR_API_KEY')?.trim() ?? '';
    const hasLinearToken = apiKey.length > 0;
    const candidates = detectTicketCandidates({
      currentBranch: env.INPUT_CURRENT_BRANCH ?? '',
      prJsonFile: env.INPUT_PR_JSON_FILE ?? '',
    });
    const candidateTicketIds = candidates.map((candidate) => candidate.id);
    const maxTickets = parseMaxTickets(env.INPUT_MAX_TICKETS);

    let teamListFetched = false;
    let teamListError: string | null = null;
    let validTeamPrefixes: string[] = [];
    let linearClient: unknown = null;

    if (hasLinearToken) {
      try {
        linearClient = createLinearClient(apiKey);
        if (!isLinearTeamListClientLike(linearClient)) {
          throw new Error('Linear client cannot list teams');
        }
        validTeamPrefixes = await fetchLinearTeamPrefixes(linearClient);
        teamListFetched = true;
      } catch (error: unknown) {
        teamListError = normalizeError(error);
      }
    }

    const validPrefixSet = new Set(validTeamPrefixes);
    const validatedCandidates =
      teamListFetched && validPrefixSet.size > 0
        ? candidates.filter((candidate) => validPrefixSet.has(candidate.prefix))
        : [];
    const invalidTicketCandidates: InvalidTicketCandidate[] = candidates
      .filter(
        (candidate) =>
          !validatedCandidates.some((valid) => valid.id === candidate.id),
      )
      .map((candidate) => ({
        ...candidate,
        reason: teamListFetched
          ? 'invalid_prefix'
          : 'team_validation_unavailable',
      }));
    const detectedTicketIds = validatedCandidates.map(
      (candidate) => candidate.id,
    );

    let tickets: LinearTicketDetails[] = [];
    let ticketFetchErrors: TicketFetchError[] = [];
    let truncated = detectedTicketIds.length > maxTickets;
    if (detectedTicketIds.length > 0 && isLinearClientLike(linearClient)) {
      const result = await fetchTickets({
        client: linearClient,
        ticketIds: detectedTicketIds,
        maxTickets,
      });
      tickets = result.tickets;
      ticketFetchErrors = result.errors;
      truncated = result.truncated;
    }

    const fetchedIds = new Set(tickets.map((ticket) => ticket.ticket_id));
    const failedIds = new Set(
      ticketFetchErrors.map((error) => error.ticket_id),
    );
    const missingTicketIds = detectedTicketIds.filter(
      (ticketId) => !fetchedIds.has(ticketId) && !failedIds.has(ticketId),
    );

    const context: LinearContext = {
      detectedTicketIds,
      ticketSources: validatedCandidates,
      candidateTicketIds,
      candidateTicketSources: candidates,
      invalidTicketCandidates,
      validTeamPrefixes,
      hasLinearToken,
      teamListFetched,
      teamListError,
      tickets,
      missingTicketIds,
      ticketFetchErrors,
      truncated,
    };

    writeOutputFile(
      'linear_context_file',
      'linear-context.json',
      `${JSON.stringify(context, null, 2)}\n`,
    );
    writeOutputFile(
      'linear_summary_file',
      'linear-context.md',
      buildSummary(context),
    );
    setCommonOutputs(context);
  });
}
