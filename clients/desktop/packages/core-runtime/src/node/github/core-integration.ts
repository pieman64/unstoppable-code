import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  GITHUB_CLI_ENVIRONMENT_VARIABLES,
  GITHUB_CLI_INTEGRATION_ID,
  GITHUB_INTEGRATION_ID,
  type CanopyQueryHandler,
  type CanopyWorkspaceScope,
  type CoreIntegration,
  type CoreIntegrationGitHubCli,
  type CoreIntegrationGitHubCredential,
  type CoreIntegrationListResult,
  type CoreIntegrationResourceListResult,
} from '@canopy/protocol/canopy-core';
import { CanopyOperationError } from '../../runtime/errors';
import type { CanopyHandlerContext } from '../../runtime/types';
import type { GitHubCliObservation } from './github-cli-status';
import { createContinuations, gitHubFailure } from './github-errors';
import {
  GITHUB_REPOSITORY_PERMISSIONS,
  type GitHubRepositorySnapshot,
  type GitHubRequestHandle,
} from './request-handle';

/**
 * Host port for `core.integration.*`. The host reads its own configuration;
 * GitHub CLI and secure-store failures arrive as observations, never throws.
 */
export interface CoreIntegrationHost {
  /** The authority and target this host serves; any other scope is refused. */
  readonly authorityId: string;
  readonly targetId?: string;
  readonly github: GitHubRequestHandle;
  /** Runs the GitHub CLI's status command without Canopy secrets. */
  observeGitHubCli(): Promise<GitHubCliObservation>;
}

export interface CoreIntegrationHandlers {
  'core.integration.get': CanopyQueryHandler<
    'core.integration.get',
    CanopyHandlerContext
  >;
  'core.integration.list': CanopyQueryHandler<
    'core.integration.list',
    CanopyHandlerContext
  >;
  'core.integration.resource.list': CanopyQueryHandler<
    'core.integration.resource.list',
    CanopyHandlerContext
  >;
}

/** Listed in this order; `core.integration.get` serves exactly these. */
const CONNECTION_IDS = [GITHUB_INTEGRATION_ID, GITHUB_CLI_INTEGRATION_ID];
const DEFAULT_PAGE_SIZE = 100;

/** A connection's state before its revision is assigned. */
interface Connection {
  readonly integrationId: string;
  readonly kind: string;
  readonly accountLabel: string;
  readonly state: CoreIntegration['state'];
  readonly capabilities: string[];
  readonly githubCredential?: CoreIntegrationGitHubCredential;
  readonly githubCli?: CoreIntegrationGitHubCli;
}

const ENVIRONMENT_VARIABLES: ReadonlySet<string> = new Set(
  GITHUB_CLI_ENVIRONMENT_VARIABLES,
);

function environmentVariable(
  tokenSource: string,
): CoreIntegrationGitHubCli['environmentVariable'] {
  return (
    GITHUB_CLI_ENVIRONMENT_VARIABLES.find((name) => name === tokenSource) ??
    null
  );
}

// `hosts.yml` (or its `oauth_token` key) is the CLI's own config file.
function tokenSourceKind(
  tokenSource: string,
): NonNullable<CoreIntegrationGitHubCli['tokenSourceKind']> {
  if (tokenSource === 'keyring') return 'keyring';
  if (ENVIRONMENT_VARIABLES.has(tokenSource)) return 'environment';
  if (
    tokenSource === 'oauth_token' ||
    /(?:^|[\\/])hosts\.yml$/.test(tokenSource)
  )
    return 'config-file';
  return 'other';
}

function hostReadFailed(error: unknown): CanopyOperationError {
  return new CanopyOperationError(
    {
      kind: 'internal',
      message: 'The host could not read its credential state.',
      retry: { kind: 'never' },
    },
    error,
  );
}

async function readGitHub(host: CoreIntegrationHost): Promise<Connection> {
  let description: Awaited<ReturnType<GitHubRequestHandle['describe']>>;
  try {
    description = await host.github.describe();
  } catch (error) {
    throw hostReadFailed(error);
  }
  const { tokenSource, storedCredential } = description;
  const connected = tokenSource !== 'none';
  return {
    integrationId: GITHUB_INTEGRATION_ID,
    kind: 'github',
    // Reading the account would call GitHub.
    accountLabel: '',
    state: connected
      ? 'connected'
      : storedCredential === 'storage-unavailable' ||
          storedCredential === 'unreadable'
        ? 'error'
        : 'disconnected',
    capabilities: connected ? ['pull-requests', 'repositories'] : [],
    githubCredential: { tokenSource, storedCredential },
  };
}

function githubCliConnection(
  state: CoreIntegration['state'],
  githubCli: CoreIntegrationGitHubCli,
): Connection {
  return {
    integrationId: GITHUB_CLI_INTEGRATION_ID,
    kind: 'github-cli',
    accountLabel: githubCli.login ?? '',
    state,
    capabilities: state === 'connected' ? ['token-source'] : [],
    githubCli,
  };
}

/** The CLI's account as configured state; its raw token source never crosses. */
function projectGitHubCliConnection(
  observation: GitHubCliObservation,
): Connection {
  const none: CoreIntegrationGitHubCli = {
    login: null,
    tokenSourceKind: null,
    environmentVariable: null,
    hasCredentialStoreLogin: false,
    unavailableReason: null,
  };
  if (observation.kind === 'not-installed')
    return githubCliConnection('error', {
      ...none,
      unavailableReason: 'not_installed',
    });
  if (observation.kind === 'unparseable-output')
    return githubCliConnection('error', {
      ...none,
      unavailableReason: 'unparseable_output',
    });
  // A non-zero exit, including a timeout, reads as no account.
  if (observation.kind === 'failed')
    return githubCliConnection('disconnected', none);
  const { entries } = observation;
  const hasCredentialStoreLogin = entries.some(
    (entry) => !ENVIRONMENT_VARIABLES.has(entry.tokenSource),
  );
  const active = entries.find((entry) => entry.active);
  if (!active)
    return githubCliConnection('disconnected', {
      ...none,
      hasCredentialStoreLogin,
    });
  return githubCliConnection('connected', {
    login: active.login === '' ? null : active.login,
    tokenSourceKind: tokenSourceKind(active.tokenSource),
    environmentVariable: environmentVariable(active.tokenSource),
    hasCredentialStoreLogin,
    unavailableReason: null,
  });
}

async function readGitHubCli(host: CoreIntegrationHost): Promise<Connection> {
  let observation: GitHubCliObservation;
  try {
    observation = await host.observeGitHubCli();
  } catch (error) {
    throw hostReadFailed(error);
  }
  return projectGitHubCliConnection(observation);
}

function assertServedScope(
  scope: CanopyWorkspaceScope | undefined,
  host: CoreIntegrationHost,
): void {
  if (
    (scope?.authorityId !== undefined &&
      scope.authorityId !== host.authorityId) ||
    (scope?.targetId !== undefined && scope.targetId !== host.targetId)
  )
    throw new CanopyOperationError({
      kind: 'capability_unavailable',
      message: 'The selected integration authority or target is unavailable.',
      retry: { kind: 'never' },
    });
}

/** Process-local revisions: each changes when a read observes a new state. */
function createRevisions(): (connection: Connection) => CoreIntegration {
  const last = new Map<string, { state: string; revision: number }>();
  return (connection) => {
    const state = JSON.stringify(connection);
    const previous = last.get(connection.integrationId);
    const revision =
      previous === undefined
        ? 0
        : previous.state === state
          ? previous.revision
          : previous.revision + 1;
    last.set(connection.integrationId, { state, revision });
    return { ...connection, revision };
  };
}

/** Canonical JSON of a scope, so a cursor binds to the scope it was minted for. */
function scopeKey(scope: CanopyWorkspaceScope | undefined): string {
  const entries = Object.entries(scope ?? {}).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return JSON.stringify(entries);
}

/** Opaque list cursors, authenticated with a per-process key. */
function createCursors(): {
  mint(offset: number, scope: CanopyWorkspaceScope | undefined): string;
  read(cursor: string, scope: CanopyWorkspaceScope | undefined): number;
} {
  const key = randomBytes(32);
  const sign = (
    offset: number,
    scope: CanopyWorkspaceScope | undefined,
  ): string =>
    createHmac('sha256', key)
      .update(`${offset}\n${scopeKey(scope)}`)
      .digest('base64url');
  return {
    mint: (offset, scope) => `${offset}.${sign(offset, scope)}`,
    read: (cursor, scope) => {
      const match = /^(\d{1,4})\.([\w-]{43})$/.exec(cursor);
      const offset = match ? Number(match[1]) : Number.NaN;
      const expected = match ? Buffer.from(sign(offset, scope)) : null;
      const actual = match ? Buffer.from(match[2]) : null;
      if (
        !expected ||
        !actual ||
        expected.length !== actual.length ||
        !timingSafeEqual(expected, actual) ||
        offset < 1 ||
        offset >= CONNECTION_IDS.length
      )
        throw new CanopyOperationError({
          kind: 'invalid_argument',
          code: 'core.integration.list.invalidCursor',
          message: 'The integration list cursor is not valid for this scope.',
          retry: { kind: 'never' },
        });
      return offset;
    },
  };
}

function resourceFailure(
  code:
    | 'core.integration.resource.kindUnsupported'
    | 'core.integration.resource.queryUnsupported',
  message: string,
): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'capability_unavailable',
    code,
    message,
    retry: { kind: 'never' },
  });
}

function invalidResourceCursor(): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'invalid_argument',
    code: 'core.integration.resource.invalidCursor',
    message:
      'The resource cursor is not valid for these params or this snapshot.',
    retry: { kind: 'never' },
  });
}

type Resource = CoreIntegrationResourceListResult['resources'][number];

/**
 * The repositories of one snapshot as resources. GitHub types a listed
 * repository's update time as nullable; one without it is left out rather
 * than given an invented time (recorded debt).
 */
function repositoryResources(snapshot: GitHubRepositorySnapshot): Resource[] {
  return snapshot.repositories.flatMap((repository): Resource[] =>
    repository.updatedAt === null
      ? []
      : [
          {
            integrationId: GITHUB_INTEGRATION_ID,
            resourceId: `github-repository.${Buffer.from(
              repository.fullName.toLowerCase(),
            ).toString('base64url')}`,
            kind: 'repository',
            name: repository.fullName,
            locator: repository.webUrl,
            capabilities: GITHUB_REPOSITORY_PERMISSIONS.filter((permission) =>
              repository.permissions.includes(permission),
            ),
            updatedAt: repository.updatedAt,
          },
        ],
  );
}

/**
 * `core.integration.get` and `list` for the desktop host's GitHub
 * connections (CAN-4109): configured state only, never a credential. And
 * `core.integration.resource.list`: the repositories the credential reaches,
 * paged over the host's cached snapshot.
 */
export function createCoreIntegrationHandlers(
  host: CoreIntegrationHost,
): CoreIntegrationHandlers {
  const withRevision = createRevisions();
  const cursors = createCursors();
  const resourceCursors = createContinuations();
  const read = async (integrationId: string): Promise<CoreIntegration> =>
    withRevision(
      integrationId === GITHUB_INTEGRATION_ID
        ? await readGitHub(host)
        : await readGitHubCli(host),
    );
  return {
    'core.integration.get': async ({ scope, integrationId }) => {
      assertServedScope(scope, host);
      if (!CONNECTION_IDS.includes(integrationId))
        throw new CanopyOperationError({
          kind: 'not_found',
          code: 'core.integration.notFound',
          message: 'The host serves no integration with this id.',
          retry: { kind: 'never' },
        });
      return read(integrationId);
    },
    'core.integration.list': async ({
      scope,
      pageSize,
      cursor,
    }): Promise<CoreIntegrationListResult> => {
      assertServedScope(scope, host);
      const start = cursor === undefined ? 0 : cursors.read(cursor, scope);
      const end = start + (pageSize ?? DEFAULT_PAGE_SIZE);
      const items: CoreIntegration[] = [];
      for (const integrationId of CONNECTION_IDS.slice(start, end))
        items.push(await read(integrationId));
      return {
        items,
        nextCursor:
          end < CONNECTION_IDS.length ? cursors.mint(end, scope) : null,
      };
    },
    'core.integration.resource.list': async (
      { integrationId, kinds, query, cursor, limit },
      context,
    ): Promise<CoreIntegrationResourceListResult> => {
      if (integrationId !== GITHUB_INTEGRATION_ID)
        throw new CanopyOperationError({
          kind: 'not_found',
          code: 'core.integration.notFound',
          message: 'The host serves no resources for this integration.',
          retry: { kind: 'never' },
        });
      if (kinds.length === 0 || kinds.some((kind) => kind !== 'repository'))
        throw resourceFailure(
          'core.integration.resource.kindUnsupported',
          'The host lists repositories only.',
        );
      if (query !== null)
        throw resourceFailure(
          'core.integration.resource.queryUnsupported',
          'The host does not filter repositories.',
        );
      let snapshot: GitHubRepositorySnapshot;
      try {
        snapshot = await host.github.listRepositories({
          signal: context.signal,
        });
      } catch (error) {
        throw gitHubFailure(error, {
          notAuthenticated: 'core.integration.notAuthenticated',
        });
      }
      const resources = repositoryResources(snapshot);
      // Bound to the snapshot: a replaced snapshot invalidates its cursors.
      const binding = JSON.stringify([integrationId, snapshot.snapshotId]);
      let start = 0;
      if (cursor !== null) {
        const position = resourceCursors.read(cursor, binding);
        start =
          position !== null && /^\d{1,6}$/.test(position)
            ? Number(position)
            : 0;
        if (start < 1 || start >= resources.length)
          throw invalidResourceCursor();
      }
      const end = start + limit;
      return {
        resources: resources.slice(start, end),
        nextCursor:
          end < resources.length
            ? resourceCursors.mint(String(end), binding)
            : null,
      };
    },
  };
}
