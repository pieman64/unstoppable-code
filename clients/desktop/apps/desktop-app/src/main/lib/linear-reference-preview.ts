import { createHash } from 'node:crypto';
import { LinearClient, LinearError, LinearErrorType } from '@linear/sdk';
import {
  LINEAR_ISSUE_TITLE_MAX_CODE_POINTS,
  LINEAR_TEAM_KEY_PATTERN,
  type LinearIssuePreview,
  type LinearIssuePreviewRequest,
  type LinearIssuePreviewResult,
  type LinearPreviewScope,
  type LinearTeamKeysResult,
} from '@canopy/protocol/reference-previews';
import { loadCanopyCloudAccount } from './canopy-cloud-account-store';
import { buildLinearClientOptions, resolveLinearToken } from './linear-auth';

// One exact issue and only the fields its preview card shows.
const ISSUE_PREVIEW_QUERY = `query referencePreviewIssue($id: String!) {
  issue(id: $id) {
    identifier
    title
    description
    url
    updatedAt
    state { name }
    assignee { displayName name }
    project { name }
  }
}`;

// Every accessible team's key, one page at a time.
const TEAM_KEYS_QUERY = `query referencePreviewTeams($first: Int!, $after: String) {
  teams(first: $first, after: $after) {
    nodes { key }
    pageInfo { hasNextPage endCursor }
  }
}`;

const TEAM_PAGE_SIZE = 250;
// 5,000 teams; a larger catalog fails closed rather than publishing a prefix.
const MAX_TEAM_PAGES = 20;
const TEAM_KEYS_FRESH_MS = 5 * 60 * 1000;
const TEAM_KEYS_RETRY_MS = 60 * 1000;

const MAX_DESCRIPTION_SOURCE = 4_000;
const MAX_DESCRIPTION_EXCERPT = 280;
const MAX_FIELD = 200;
const ISSUE_URL_RE = /^https:\/\/linear\.app\/([^/]+)\/issue\//i;

export interface LinearReferencePreviewDeps {
  resolveToken: () => Promise<string>;
  resolveAccountId: () => Promise<string>;
  requestIssue: (token: string, identifier: string) => Promise<unknown>;
  requestTeams: (token: string, after: string | null) => Promise<unknown>;
  now: () => number;
}

const rawRequest = async <Variables extends Record<string, unknown>>(
  token: string,
  query: string,
  variables: Variables,
): Promise<unknown> =>
  (
    await new LinearClient(buildLinearClientOptions(token)).client.rawRequest<
      unknown,
      Variables
    >(query, variables)
  ).data;

const defaultDeps: LinearReferencePreviewDeps = {
  resolveToken: resolveLinearToken,
  resolveAccountId: async () =>
    (await loadCanopyCloudAccount())?.account?.id ?? '',
  requestIssue: (token, identifier) =>
    rawRequest(token, ISSUE_PREVIEW_QUERY, { id: identifier }),
  requestTeams: (token, after) =>
    rawRequest(token, TEAM_KEYS_QUERY, { first: TEAM_PAGE_SIZE, after }),
  now: () => Date.now(),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Collapses whitespace and bounds by code point; a cut ends with `…`. */
function boundedText(value: unknown, max = MAX_FIELD): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const codePoints = Array.from(text);
  return codePoints.length > max
    ? `${codePoints
        .slice(0, max - 1)
        .join('')
        .trimEnd()}…`
    : text;
}

/** Markdown to a short plain-text excerpt; never rendered as HTML. */
function descriptionExcerpt(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return boundedText(
    value
      .slice(0, MAX_DESCRIPTION_SOURCE)
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/<[^>]*>/g, ' ')
      .replace(/[`*_~#>|]/g, ''),
    MAX_DESCRIPTION_EXCERPT,
  );
}

function nestedName(value: unknown, ...keys: string[]): string | null {
  if (!isRecord(value)) return null;
  for (const key of keys) {
    const text = boundedText(value[key]);
    if (text) return text;
  }
  return null;
}

function toPreview(
  data: unknown,
  request: LinearIssuePreviewRequest,
): LinearIssuePreview | null {
  const issue = isRecord(data) ? data.issue : null;
  if (!isRecord(issue)) return null;
  const identifier = boundedText(issue.identifier, 32);
  const title = boundedText(issue.title, LINEAR_ISSUE_TITLE_MAX_CODE_POINTS);
  const url = typeof issue.url === 'string' ? issue.url : '';
  const workspace = ISSUE_URL_RE.exec(url)?.[1]?.toLowerCase();
  // A token belongs to one workspace: a URL naming another workspace must not
  // preview this workspace's issue that shares its identifier.
  if (
    !identifier ||
    !title ||
    !workspace ||
    url.length > 2_048 ||
    (request.workspaceSlug !== undefined && workspace !== request.workspaceSlug)
  ) {
    return null;
  }
  return {
    identifier,
    title,
    url,
    description: descriptionExcerpt(issue.description),
    status: nestedName(issue.state, 'name'),
    assignee: nestedName(issue.assignee, 'displayName', 'name'),
    project: nestedName(issue.project, 'name'),
    updatedAt: typeof issue.updatedAt === 'string' ? issue.updatedAt : '',
  };
}

function retryAfterMs(error: LinearError): number | null {
  const retryAfter: unknown = Reflect.get(error, 'retryAfter');
  return typeof retryAfter === 'number' && retryAfter > 0
    ? retryAfter * 1_000
    : null;
}

interface TeamPage {
  readonly keys: string[];
  readonly next: string | null;
}

function toTeamPage(data: unknown): TeamPage | null {
  const teams = isRecord(data) ? data.teams : null;
  if (!isRecord(teams) || !Array.isArray(teams.nodes)) return null;
  const pageInfo = teams.pageInfo;
  if (!isRecord(pageInfo) || typeof pageInfo.hasNextPage !== 'boolean') {
    return null;
  }
  const next =
    pageInfo.hasNextPage && typeof pageInfo.endCursor === 'string'
      ? pageInfo.endCursor
      : null;
  if (pageInfo.hasNextPage && next === null) return null;
  const keys: string[] = [];
  for (const node of teams.nodes) {
    const key: unknown = isRecord(node) ? node.key : null;
    const normalized = typeof key === 'string' ? key.trim().toUpperCase() : '';
    if (LINEAR_TEAM_KEY_PATTERN.test(normalized)) keys.push(normalized);
  }
  return { keys, next };
}

function failureResult(
  error: unknown,
  scope: string,
): LinearIssuePreviewResult {
  if (!(error instanceof LinearError)) return { status: 'failed' };
  switch (error.type) {
    case LinearErrorType.AuthenticationError:
      return { status: 'disconnected' };
    case LinearErrorType.Forbidden:
    case LinearErrorType.FeatureNotAccessible:
    case LinearErrorType.InvalidInput:
      return { status: 'unavailable', scope };
    case LinearErrorType.Ratelimited:
      return { status: 'rate-limited', retryAfterMs: retryAfterMs(error) };
    default:
      // Linear reports a missing issue as a GraphQL "Entity not found" error.
      return error.errors?.some((graphqlError) =>
        /entity not found/i.test(graphqlError.message),
      )
        ? { status: 'unavailable', scope }
        : { status: 'failed' };
  }
}

export function createLinearReferencePreviewReader(
  deps: LinearReferencePreviewDeps = defaultDeps,
): {
  readScope: () => Promise<LinearPreviewScope>;
  readIssue: (
    request: LinearIssuePreviewRequest,
  ) => Promise<LinearIssuePreviewResult>;
  readTeamKeys: () => Promise<LinearTeamKeysResult>;
} {
  // A credential Linear rejected reads as disconnected for one freshness
  // window, so every window stops calling Linear with it until the key changes
  // (a new scope) or the window passes.
  const revokedUntil = new Map<string, number>();
  const markRevoked = (scope: string): void => {
    revokedUntil.set(scope, deps.now() + TEAM_KEYS_FRESH_MS);
    if (teamKeys?.scope === scope) teamKeys = null;
  };

  const resolveScope = async (): Promise<{
    token: string;
    scope: string;
  } | null> => {
    const token = (await deps.resolveToken()).trim();
    if (!token) return null;
    const accountId = await deps.resolveAccountId().catch(() => '');
    const scope = createHash('sha256')
      .update(`reference-preview\0${accountId}\0${token}`)
      .digest('base64url')
      .slice(0, 24);
    const until = revokedUntil.get(scope);
    if (until !== undefined) {
      if (deps.now() < until) return null;
      revokedUntil.delete(scope);
    }
    return { token, scope };
  };

  // Shared by every window: identical concurrent reads make one provider call.
  const issueReads = new Map<string, Promise<LinearIssuePreviewResult>>();
  let teamKeys: {
    scope: string;
    result: LinearTeamKeysResult | null;
    pending: Promise<LinearTeamKeysResult> | null;
    retryAt: number;
  } | null = null;

  const fetchTeamKeys = async (identity: {
    token: string;
    scope: string;
  }): Promise<LinearTeamKeysResult> => {
    const keys = new Set<string>();
    let after: string | null = null;
    try {
      for (let page = 0; page < MAX_TEAM_PAGES; page += 1) {
        const parsed = toTeamPage(
          await deps.requestTeams(identity.token, after),
        );
        if (!parsed) return { status: 'failed', scope: identity.scope };
        parsed.keys.forEach((key) => keys.add(key));
        if (parsed.next === null) {
          return {
            status: 'ok',
            scope: identity.scope,
            keys: Array.from(keys).sort(),
            fetchedAt: deps.now(),
          };
        }
        after = parsed.next;
      }
      return { status: 'failed', scope: identity.scope };
    } catch (error: unknown) {
      if (error instanceof LinearError) {
        if (error.type === LinearErrorType.AuthenticationError) {
          markRevoked(identity.scope);
          return { status: 'disconnected' };
        }
        if (error.type === LinearErrorType.Ratelimited) {
          return {
            status: 'rate-limited',
            scope: identity.scope,
            retryAfterMs: retryAfterMs(error),
          };
        }
      }
      return { status: 'failed', scope: identity.scope };
    }
  };

  return {
    readScope: async () => ({ scope: (await resolveScope())?.scope ?? null }),
    readIssue: async (request): Promise<LinearIssuePreviewResult> => {
      const identity = await resolveScope();
      if (!identity) return { status: 'disconnected' };
      const key = `${identity.scope}\0${request.workspaceSlug ?? ''}\0${request.identifier}`;
      const existing = issueReads.get(key);
      if (existing) return existing;
      const read = (async (): Promise<LinearIssuePreviewResult> => {
        try {
          const preview = toPreview(
            await deps.requestIssue(identity.token, request.identifier),
            request,
          );
          return preview
            ? { status: 'ok', scope: identity.scope, preview }
            : { status: 'unavailable', scope: identity.scope };
        } catch (error: unknown) {
          const result = failureResult(error, identity.scope);
          if (result.status === 'disconnected') markRevoked(identity.scope);
          return result;
        }
      })().finally(() => issueReads.delete(key));
      issueReads.set(key, read);
      return read;
    },
    // One catalog per credential, shared by every window: fresh for five
    // minutes, coalesced while loading, and held back during a retry cooldown.
    readTeamKeys: async (): Promise<LinearTeamKeysResult> => {
      const identity = await resolveScope();
      if (!identity) {
        teamKeys = null;
        return { status: 'disconnected' };
      }
      if (teamKeys?.scope !== identity.scope) {
        teamKeys = {
          scope: identity.scope,
          result: null,
          pending: null,
          retryAt: 0,
        };
      }
      const entry = teamKeys;
      const now = deps.now();
      if (entry.pending) return entry.pending;
      if (
        entry.result?.status === 'ok' &&
        now - entry.result.fetchedAt < TEAM_KEYS_FRESH_MS
      ) {
        return entry.result;
      }
      if (entry.result && entry.result.status !== 'ok' && now < entry.retryAt) {
        return entry.result.status === 'rate-limited'
          ? { ...entry.result, retryAfterMs: entry.retryAt - now }
          : entry.result;
      }
      const pending = fetchTeamKeys(identity).then((result) => {
        if (teamKeys !== entry) return result;
        entry.pending = null;
        entry.result = result.status === 'disconnected' ? null : result;
        entry.retryAt =
          result.status === 'rate-limited'
            ? deps.now() + (result.retryAfterMs ?? TEAM_KEYS_RETRY_MS)
            : deps.now() + TEAM_KEYS_RETRY_MS;
        return result;
      });
      entry.pending = pending;
      return pending;
    },
  };
}
