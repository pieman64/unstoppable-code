// Linear GraphQL surface for the shared UI-automation mock server
// (WP-MOCK-LINEAR, Doc 9 §3).
//
// The shared server (see ../start.mjs) runs once for the whole Playwright suite
// (Doc 4 §0); this surface answers the `@linear/sdk` GraphQL operations Canopy
// fires WITHOUT hitting api.linear.app. The app reaches this endpoint only under
// an E2E build (Doc 11), where the gated seams in `ipc/settings.ts`,
// `read-linear-ticket/runner.ts`, and `pipeline-handlers.ts` set the SDK's
// `apiUrl` to this server and send the per-test API key.
//
// Scenario keying: keyed by the API key the SDK sends (raw, no `Bearer`
// prefix). Both the main-process IPC calls (viewer/issueSearch) and the
// pipeline subprocess (issue + nested resolvers) use the SAME per-test key, so
// UI and pipeline tests share one Linear scenario. An unregistered key gets a
// benign default (authed viewer + a small fixed issue list).
//
// Operations answered (the SDK omits `operationName`, so the leading
// `query <name>(` in the document body is parsed):
//   viewer        → `{ data: { viewer } }`
//   teams         → `{ data: { teams: { nodes } } }`
//   searchIssues  → `{ data: { searchIssues: { nodes } } }`  (field `searchIssues`)
//   issue         → `{ data: { issue } }` (nested objects returned as `{ id }`)
//   user/workflowState/team/project/cycle → lazy single-entity resolvers
//   issue_labels  → the issue's labels connection

import { getScenario, keyFromApiKey, readJsonBody } from '../control-plane.mjs';

function jsonResponse(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function graphqlErrors(message) {
  return { errors: [{ message }] };
}

const DEFAULT_VIEWER = {
  id: 'mock-viewer',
  name: 'Mock User',
  displayName: 'Mock User',
  email: 'mock@example.com',
};

const DEFAULT_ISSUES = [
  {
    id: 'iss_default_1',
    identifier: 'CAN-1',
    title: 'Default mock issue',
    description: 'A default issue returned for unregistered Linear keys.',
  },
];

const DEFAULT_TEAMS = [{ id: 'team_can', key: 'CAN', name: 'Canopy' }];

const ISO_EPOCH = '1970-01-01T00:00:00.000Z';

/**
 * Read the Linear scenario slice for a request's API key.
 *
 * @param {import('node:http').IncomingMessage} request
 * @returns {{ viewer?: object | false, teams?: object[], issues?: object[] }}
 */
export function resolveLinearScenario(request) {
  const key = keyFromApiKey(request, { header: 'authorization' });
  const scenario = getScenario(key);
  const slice = scenario?.linear;
  if (slice && typeof slice === 'object') {
    return slice;
  }
  return {
    viewer: DEFAULT_VIEWER,
    teams: DEFAULT_TEAMS,
    issues: DEFAULT_ISSUES,
  };
}

/**
 * Parse the leading operation name from a GraphQL document body. The SDK does
 * not send `operationName`, so the `query <name>(` prefix is the only reliable
 * discriminator.
 *
 * @param {string} [query]
 * @returns {string | undefined}
 */
export function parseOperationName(query) {
  if (typeof query !== 'string') {
    return undefined;
  }
  const match = /\b(?:query|mutation)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(query);
  return match ? match[1] : undefined;
}

// ── Field builders (return shapes the @linear/sdk models parse) ────────────

function buildViewer(viewer) {
  return {
    __typename: 'User',
    id: viewer.id ?? 'mock-viewer',
    name: viewer.name ?? viewer.displayName ?? 'Mock User',
    displayName: viewer.displayName ?? viewer.name ?? 'Mock User',
    email: viewer.email ?? 'mock@example.com',
    active: true,
    admin: false,
    guest: false,
    createdAt: ISO_EPOCH,
    updatedAt: ISO_EPOCH,
    url: `https://linear.app/mock/profiles/${viewer.id ?? 'mock-viewer'}`,
  };
}

function buildUser(user) {
  if (!user || typeof user !== 'object') {
    return null;
  }
  return {
    __typename: 'User',
    id: user.id ?? 'usr_mock',
    name: user.name ?? user.display_name ?? user.displayName ?? 'Mock User',
    displayName:
      user.displayName ?? user.display_name ?? user.name ?? 'Mock User',
    email: user.email ?? 'mock@example.com',
    active: user.active ?? true,
    createdAt: ISO_EPOCH,
    updatedAt: ISO_EPOCH,
    url: `https://linear.app/mock/profiles/${user.id ?? 'usr_mock'}`,
  };
}

function buildWorkflowState(state) {
  if (!state || typeof state !== 'object') {
    return null;
  }
  return {
    __typename: 'WorkflowState',
    id: state.id ?? 'state_mock',
    name: state.name ?? 'Backlog',
    type: state.type ?? 'backlog',
    color: state.color ?? '#000000',
    position: state.position ?? 0,
    createdAt: ISO_EPOCH,
    updatedAt: ISO_EPOCH,
  };
}

function buildTeam(team) {
  if (!team || typeof team !== 'object') {
    return null;
  }
  const name = team.name ?? 'Canopy';
  return {
    __typename: 'Team',
    id: team.id ?? 'team_mock',
    key: team.key ?? 'CAN',
    name,
    displayName: team.displayName ?? name,
    description: team.description ?? null,
    color: team.color ?? '#000000',
    icon: team.icon ?? null,
    archivedAt: team.archivedAt ?? null,
    retiredAt: team.retiredAt ?? null,
    timezone: team.timezone ?? 'UTC',
    inviteHash: team.inviteHash ?? null,
    issueCount: team.issueCount ?? 0,
    createdAt: ISO_EPOCH,
    updatedAt: ISO_EPOCH,
  };
}

function buildProject(project) {
  if (!project || typeof project !== 'object') {
    return null;
  }
  return {
    __typename: 'Project',
    id: project.id ?? 'proj_mock',
    name: project.name ?? 'Project',
    slugId: project.slugId ?? 'proj-mock',
    color: project.color ?? '#000000',
    priority: project.priority ?? 0,
    progress: project.progress ?? 0,
    state: project.state ?? 'started',
    status: project.status ? { id: project.status.id ?? 'pst_mock' } : null,
    createdAt: ISO_EPOCH,
    updatedAt: ISO_EPOCH,
  };
}

function buildCycle(cycle) {
  if (!cycle || typeof cycle !== 'object') {
    return null;
  }
  return {
    __typename: 'Cycle',
    id: cycle.id ?? 'cycle_mock',
    number: cycle.number ?? 1,
    name: cycle.name ?? null,
    createdAt: ISO_EPOCH,
    updatedAt: ISO_EPOCH,
    startsAt: ISO_EPOCH,
    endsAt: ISO_EPOCH,
  };
}

function buildLabelNode(label, index) {
  return {
    __typename: 'IssueLabel',
    id: label.id ?? `lbl_${index}`,
    name: label.name ?? `label-${index}`,
    color: label.color ?? '#000000',
    createdAt: ISO_EPOCH,
    updatedAt: ISO_EPOCH,
  };
}

// The @linear/sdk `Issue`/`IssueSearchResult` models eagerly construct a few
// nested objects in their constructors (`sharedAccess`, `reactions`), so those
// fields must always be present even when the scenario omits them. Other nested
// entity fields (assignee/state/…) are wrapped lazily, so `{ id }` suffices.
const EMPTY_SHARED_ACCESS = {
  __typename: 'IssueSharedAccess',
  isShared: false,
  sharedWithCount: 0,
  viewerHasOnlySharedAccess: false,
  disallowedIssueFields: [],
  sharedWithUsers: [],
};

function commonIssueFields(issue) {
  const nested = (entity, key) =>
    entity && typeof entity === 'object'
      ? { id: entity.id ?? `${key}_${issue.id}` }
      : null;
  return {
    id: issue.id,
    identifier: issue.identifier,
    number: issue.number ?? 1,
    title: issue.title,
    description: issue.description ?? null,
    url: issue.url ?? `https://linear.app/mock/issue/${issue.identifier}`,
    priority: issue.priority ?? 0,
    priorityLabel: issue.priorityLabel ?? 'No priority',
    branchName: issue.branchName ?? `mock/${issue.identifier.toLowerCase()}`,
    estimate: issue.estimate ?? null,
    dueDate: issue.dueDate ?? null,
    customerTicketCount: issue.customerTicketCount ?? 0,
    labelIds: (issue.labels ?? []).map(
      (label, index) => label.id ?? `lbl_${index}`,
    ),
    previousIdentifiers: issue.previousIdentifiers ?? [],
    reactionData: {},
    integrationSourceType: null,
    trashed: null,
    metadata: {},
    sharedAccess: EMPTY_SHARED_ACCESS,
    reactions: [],
    createdAt: ISO_EPOCH,
    updatedAt: ISO_EPOCH,
    startedAt: null,
    completedAt: null,
    canceledAt: null,
    archivedAt: null,
    autoArchivedAt: null,
    autoClosedAt: null,
    assignee: nested(issue.assignee, 'assignee'),
    creator: nested(issue.creator, 'creator'),
    state: nested(issue.state, 'state'),
    team: nested(issue.team, 'team'),
    project: nested(issue.project, 'project'),
    cycle: nested(issue.cycle, 'cycle'),
    parent: nested(issue.parent, 'parent'),
  };
}

function buildSearchResultNode(issue) {
  return { __typename: 'IssueSearchResult', ...commonIssueFields(issue) };
}

function buildIssueNode(issue) {
  return { __typename: 'Issue', ...commonIssueFields(issue) };
}

function findIssueById(issues, id) {
  return issues.find((issue) => (issue.id ?? `${issue.identifier}`) === id);
}

function findIssueByNestedId(issues, field, id) {
  for (const issue of issues) {
    const nested = issue[field];
    if (
      nested &&
      typeof nested === 'object' &&
      (nested.id ?? `${field}_${issue.id}`) === id
    ) {
      return nested;
    }
  }
  return undefined;
}

function teamFromIssueIdentifier(issue) {
  const identifier =
    typeof issue.identifier === 'string' ? issue.identifier : '';
  const [key] = identifier.split('-');
  if (!key) {
    return null;
  }
  return {
    id: `team_${key.toLowerCase()}`,
    key,
    name: key,
  };
}

function collectScenarioTeams(scenario, issues) {
  const candidates = [];
  if (Array.isArray(scenario.teams)) {
    candidates.push(...scenario.teams);
  }
  for (const issue of issues) {
    if (issue.team && typeof issue.team === 'object') {
      candidates.push(issue.team);
    } else {
      const team = teamFromIssueIdentifier(issue);
      if (team) {
        candidates.push(team);
      }
    }
  }
  if (candidates.length === 0) {
    candidates.push(...DEFAULT_TEAMS);
  }

  const teamsByKey = new Map();
  for (const team of candidates) {
    if (!team || typeof team !== 'object') {
      continue;
    }
    const key =
      typeof team.key === 'string' ? team.key.trim().toUpperCase() : '';
    if (key && !teamsByKey.has(key)) {
      teamsByKey.set(key, { ...team, key });
    }
  }
  return Array.from(teamsByKey.values());
}

function buildPageInfo(start, end, total) {
  return {
    __typename: 'PageInfo',
    hasNextPage: end < total,
    hasPreviousPage: start > 0,
    startCursor: start < end ? String(start) : null,
    endCursor: start < end ? String(end - 1) : null,
  };
}

function buildTeamConnection(teams, variables) {
  const vars = variables ?? {};
  const after =
    typeof vars.after === 'string' ? Number.parseInt(vars.after, 10) : NaN;
  const start = Number.isFinite(after) ? after + 1 : 0;
  const requestedFirst = Number.parseInt(String(vars.first ?? ''), 10);
  const first =
    Number.isFinite(requestedFirst) && requestedFirst > 0
      ? requestedFirst
      : teams.length;
  const end = Math.min(start + first, teams.length);
  const nodes = teams.slice(start, end).map((team) => buildTeam(team));
  return {
    __typename: 'TeamConnection',
    nodes,
    pageInfo: buildPageInfo(start, end, teams.length),
  };
}

/**
 * Resolve a GraphQL operation against a Linear scenario. Returns the response
 * body the SDK expects (`{ data }` or `{ errors }`). Pure; unit-tested
 * directly.
 *
 * @param {string | undefined} operation
 * @param {object} variables
 * @param {{ viewer?: object | false, teams?: object[], issues?: object[] }} scenario
 * @returns {object}
 */
export function resolveLinearOperation(operation, variables, scenario) {
  const issues = Array.isArray(scenario.issues) ? scenario.issues : [];
  const vars = variables ?? {};

  switch (operation) {
    case 'viewer': {
      if (scenario.viewer === false || scenario.viewer === null) {
        return graphqlErrors('Authentication required, not authenticated');
      }
      return {
        data: { viewer: buildViewer(scenario.viewer ?? DEFAULT_VIEWER) },
      };
    }

    case 'teams': {
      const teams = collectScenarioTeams(scenario, issues);
      return { data: { teams: buildTeamConnection(teams, vars) } };
    }

    case 'searchIssues': {
      const term = typeof vars.term === 'string' ? vars.term.toLowerCase() : '';
      const matched = term
        ? issues.filter(
            (issue) =>
              issue.identifier.toLowerCase().includes(term) ||
              issue.title.toLowerCase().includes(term),
          )
        : issues;
      const nodes = matched.map((issue) => buildSearchResultNode(issue));
      return {
        data: {
          searchIssues: {
            __typename: 'IssueSearchPayload',
            archivePayload: {
              __typename: 'ArchiveResponse',
              archive: '',
              totalCount: 0,
              databaseVersion: 0,
              includesDependencies: false,
            },
            totalCount: nodes.length,
            nodes,
            pageInfo: {
              __typename: 'PageInfo',
              hasNextPage: false,
              hasPreviousPage: false,
              startCursor: null,
              endCursor: null,
            },
          },
        },
      };
    }

    case 'issue': {
      const issue = findIssueById(issues, vars.id);
      if (!issue) {
        return graphqlErrors(`Entity not found: Issue - ${vars.id}`);
      }
      return { data: { issue: buildIssueNode(issue) } };
    }

    // Transcript reference previews: the accessible team-key catalog.
    // `previewTeams` overrides the derived team list and `teamPageSize`
    // forces pagination; an unknown cursor fails like a provider error.
    case 'referencePreviewTeams': {
      const teams = Array.isArray(scenario.previewTeams)
        ? scenario.previewTeams
        : collectScenarioTeams(scenario, issues);
      if (scenario.previewTeamsError) {
        return graphqlErrors(String(scenario.previewTeamsError));
      }
      const connection = buildTeamConnection(teams, {
        after: vars.after ?? undefined,
        first: scenario.teamPageSize ?? vars.first,
      });
      return {
        data: {
          teams: {
            nodes: connection.nodes.map((team) => ({ key: team.key })),
            pageInfo: {
              hasNextPage: connection.pageInfo.hasNextPage,
              endCursor: connection.pageInfo.endCursor,
            },
          },
        },
      };
    }

    // Transcript reference previews: one exact issue by identifier.
    case 'referencePreviewIssue': {
      const issue = issues.find(
        (candidate) => candidate.identifier === vars.id,
      );
      if (!issue) return graphqlErrors(`Entity not found: Issue - ${vars.id}`);
      return {
        data: {
          issue: {
            identifier: issue.identifier,
            title: issue.title,
            description: issue.description ?? null,
            url:
              issue.url ?? `https://linear.app/mock/issue/${issue.identifier}`,
            updatedAt: issue.updatedAt ?? ISO_EPOCH,
            state: issue.state ? { name: issue.state.name ?? 'Backlog' } : null,
            assignee: issue.assignee
              ? {
                  displayName:
                    issue.assignee.displayName ?? issue.assignee.name ?? null,
                  name: issue.assignee.name ?? null,
                }
              : null,
            project: issue.project
              ? { name: issue.project.name ?? null }
              : null,
          },
        },
      };
    }

    case 'issue_attachments': {
      const issue = findIssueById(issues, vars.id);
      if (!issue) return graphqlErrors(`Entity not found: Issue - ${vars.id}`);
      const attachments = Array.isArray(issue.attachments)
        ? issue.attachments
        : [];
      const first = Number.isInteger(vars.first) ? Math.max(0, vars.first) : 50;
      const nodes = attachments.slice(0, first).map((attachment, index) => ({
        __typename: 'Attachment',
        id: attachment.id ?? `attachment-${index}`,
        createdAt: ISO_EPOCH,
        updatedAt: ISO_EPOCH,
        ...attachment,
      }));
      return {
        data: {
          issue: {
            id: vars.id,
            attachments: {
              nodes,
              pageInfo: {
                ...buildPageInfo(0, nodes.length, attachments.length),
                hasNextPage:
                  issue.attachmentsComplete === false ||
                  attachments.length > nodes.length,
              },
            },
          },
        },
      };
    }

    case 'issue_labels': {
      const issue = findIssueById(issues, vars.id);
      const labels = issue && Array.isArray(issue.labels) ? issue.labels : [];
      return {
        data: {
          issue: {
            id: vars.id,
            labels: {
              nodes: labels.map((label, index) => buildLabelNode(label, index)),
              pageInfo: {
                hasNextPage: false,
                hasPreviousPage: false,
                startCursor: null,
                endCursor: null,
              },
            },
          },
        },
      };
    }

    case 'user': {
      const user =
        findIssueByNestedId(issues, 'assignee', vars.id) ??
        findIssueByNestedId(issues, 'creator', vars.id);
      return { data: { user: buildUser(user) } };
    }

    case 'workflowState': {
      const state = findIssueByNestedId(issues, 'state', vars.id);
      return { data: { workflowState: buildWorkflowState(state) } };
    }

    case 'team': {
      const team = findIssueByNestedId(issues, 'team', vars.id);
      return { data: { team: buildTeam(team) } };
    }

    case 'project': {
      const project = findIssueByNestedId(issues, 'project', vars.id);
      return { data: { project: buildProject(project) } };
    }

    case 'cycle': {
      const cycle = findIssueByNestedId(issues, 'cycle', vars.id);
      return { data: { cycle: buildCycle(cycle) } };
    }

    default:
      return { data: {} };
  }
}

/**
 * Handle a Linear GraphQL request. Returns `true` if the request matched the
 * `/graphql` route (and a response was written), `false` otherwise.
 *
 * @param {import('node:http').IncomingMessage} request
 * @param {import('node:http').ServerResponse} response
 * @param {URL} url
 * @returns {Promise<boolean>}
 */
export async function handleLinearRequest(request, response, url) {
  if (url.pathname !== '/graphql' || request.method !== 'POST') {
    return false;
  }

  const body = await readJsonBody(request);
  const operation = parseOperationName(body?.query);
  const scenario = resolveLinearScenario(request);
  const result = resolveLinearOperation(operation, body?.variables, scenario);
  jsonResponse(response, 200, result);
  return true;
}
