import { isDeepStrictEqual } from 'node:util';
import {
  CoreWorkspaceRepositorySchema,
  CoreWorkspaceSchema,
  CoreWorkspaceUpdateResultSchema,
  hasHostAbsolutePath,
  type CoreWorkspace,
  type CoreWorkspaceRepository,
  type CoreWorkspaceUpdateResult,
} from '@canopy/protocol/canopy-core';
import { PROJECT_COLORS } from '@canopy/protocol/project-colors';
import { isProjectStartPage } from '@canopy/protocol/start-page';
import { CanopyOperationError } from '../../../runtime/errors';
import type {
  StoredWorkspaceIndexFields,
  StoredWorkspaceIndexRepository,
} from '../workspace-index-repository';
import type { WorkspaceManifestRead } from '../workspace-manifest-repository';
import { readW5ManifestView } from './manifest-edit';
import type { W5ManifestRepositoryView } from './ports';

/*
 * The daemon's `core.workspace.update` result (W7a-3, DM-2): the
 * `core.workspace.get` projection of the workspace as the decision left it,
 * from the daemon's own W5 reads, with the desktop projection's typed-field
 * rules (`core-workspace-adapter.ts`). It has no `revision`, timestamps or
 * source-config overlay: `repositorySources` are the stored repositories'
 * remote URLs only (debt before W15 or a daemon `core.workspace.get`).
 */

/** The reads the projection makes; inside a decision they see its staging. */
export interface W5DecidedWorkspaceReads {
  readonly index: Pick<StoredWorkspaceIndexRepository, 'readStored'>;
  readManifest(workspaceId: string): Promise<WorkspaceManifestRead>;
}

type TypedFields = Pick<
  CoreWorkspace,
  | 'color'
  | 'pinned'
  | 'collapsed'
  | 'itemSortMode'
  | 'activitySectionOrder'
  | 'alwaysShow'
  | 'startPage'
>;

const SCHEMAS = CoreWorkspaceSchema.shape;
/** The desktop's legacy repository id cap, which its read refuses past. */
const MAX_REPO_ID_LENGTH = 512;

function isScpStyleRemote(value: string): boolean {
  return !value.includes('://') && /^[^:@/\s]+@[^:/\s]+:[^?#\s]+$/.test(value);
}

/** The desktop's `sanitizeRemoteUrl` (`plan-share-repos.ts`). */
function sanitizeW5RemoteUrl(
  remoteUrl: string | undefined,
): string | undefined {
  const trimmed = remoteUrl?.trim();
  if (!trimmed || /^(?:\/|~\/|[a-zA-Z]:|\\\\)/.test(trimmed)) return undefined;
  try {
    const url = new URL(trimmed);
    if (url.protocol === 'file:' || !url.hostname) return undefined;
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return isScpStyleRemote(trimmed) && trimmed.split('@', 1)[0] === 'git'
      ? trimmed
      : undefined;
  }
}

/** A stored repository without its path; an unsanitizable URL is omitted. */
export function projectW5Repository(
  repository: Pick<
    W5ManifestRepositoryView,
    'id' | 'name' | 'source' | 'manifestUrl'
  >,
): CoreWorkspaceRepository {
  const url = sanitizeW5RemoteUrl(repository.manifestUrl);
  const manifestUrl =
    url !== undefined &&
    CoreWorkspaceRepositorySchema.shape.manifestUrl.safeParse(url).success
      ? url
      : undefined;
  return {
    id: repository.id,
    name: repository.name,
    ...(repository.source !== undefined && { source: repository.source }),
    ...(manifestUrl !== undefined && { manifestUrl }),
  };
}

interface FieldSchema<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}

/** A stored value outside its schema is omitted, never coerced. */
function storedValue<T>(schema: FieldSchema<T>, value: unknown): T | undefined {
  const parsed = schema.safeParse(value);
  return parsed.success && isDeepStrictEqual(parsed.data, value)
    ? parsed.data
    : undefined;
}

function indexTypedFields(
  entry: {
    type: string;
    color: string;
    collapsed: boolean;
    pinned?: boolean;
    activitySectionOrder?: readonly string[];
  },
  stored: StoredWorkspaceIndexFields | undefined,
): TypedFields {
  const fields: TypedFields = {};
  const source = (
    key: keyof StoredWorkspaceIndexFields,
    whenUnset?: unknown,
  ): unknown => {
    const value = stored?.[key];
    if (value !== undefined) return value;
    return entry[key] === undefined ? whenUnset : entry[key];
  };
  const color = storedValue(SCHEMAS.color, source('color'));
  if (color !== undefined && PROJECT_COLORS.some((c) => c === color))
    fields.color = color;
  const pinned = storedValue(SCHEMAS.pinned, source('pinned', false));
  if (pinned !== undefined) fields.pinned = pinned;
  const collapsed = storedValue(SCHEMAS.collapsed, source('collapsed'));
  if (collapsed !== undefined) fields.collapsed = collapsed;
  if (entry.type === 'cowork') return fields;
  const order = source('activitySectionOrder', []);
  const sections = storedValue(
    SCHEMAS.activitySectionOrder,
    Array.isArray(order) ? Array.from(new Set(order)) : order,
  );
  if (sections !== undefined) fields.activitySectionOrder = sections;
  return fields;
}

/**
 * The desktop config read's defaults for the stored manifest fields. The
 * Always show default follows the manifest's own type, as the config read
 * does; Cowork's omissions follow the index entry's.
 */
function manifestTypedFields(
  type: string,
  manifest: { type: string; document: Readonly<Record<string, unknown>> },
): TypedFields {
  const { document } = manifest;
  const fields: TypedFields = {};
  // A stored value, `null` included, projects as stored.
  const stored = (key: string, whenUnset: unknown): unknown =>
    document[key] === undefined ? whenUnset : document[key];
  const sortMode = storedValue(
    SCHEMAS.itemSortMode,
    stored('itemSortMode', 'manual'),
  );
  if (sortMode !== undefined) fields.itemSortMode = sortMode;
  const alwaysShow = storedValue(
    SCHEMAS.alwaysShow,
    stored(
      'alwaysShow',
      manifest.type === 'multi-repo' && document.temporary === true
        ? undefined
        : true,
    ),
  );
  if (alwaysShow !== undefined) fields.alwaysShow = alwaysShow;
  if (type === 'cowork') return fields;
  const page = document.startPage;
  const startPage =
    page === undefined
      ? { kind: 'inherit' as const }
      : page === null || isProjectStartPage(page)
        ? storedValue(SCHEMAS.startPage, page)
        : undefined;
  if (startPage !== undefined) fields.startPage = startPage;
  return fields;
}

/** The desktop projection's refusal, `invalid_argument` as it sends it. */
function repositoryIdTooLong(): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'invalid_argument',
    message: 'Workspace repository id exceeds 512 characters.',
    retry: { kind: 'never' },
  });
}

function repositorySources(
  repos: readonly W5ManifestRepositoryView[],
): CoreWorkspace['repositorySources'] {
  if (repos.some((repo) => repo.id.length > MAX_REPO_ID_LENGTH))
    throw repositoryIdTooLong();
  return repos.flatMap((repo) => {
    const remoteUrl = sanitizeW5RemoteUrl(repo.manifestUrl);
    return remoteUrl &&
      remoteUrl.length <= 4096 &&
      !hasHostAbsolutePath(remoteUrl)
      ? [{ repoId: repo.id, remoteUrl }]
      : [];
  });
}

/*
 * Well under one transport frame: a stored value no request could send (a
 * repository name or remote above a frame) would otherwise commit a decision
 * whose result, and every replay of it, never arrives.
 */
const RESULT_BYTES_MAX = 1024 * 1024;

/** `result`, or `result-unavailable` when it could not be delivered. */
export function deliverableW5Result<T>(result: T): T {
  if (Buffer.byteLength(JSON.stringify(result)) > RESULT_BYTES_MAX)
    throw resultUnavailable();
  return result;
}

function resultUnavailable(): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'capability_unavailable',
    message:
      "This project's details can't be returned here, so nothing was changed.",
    details: { reason: 'result-unavailable' },
    retry: { kind: 'never' },
  });
}

/**
 * The workspace's #3 result as `reads` see it. A workspace the result cannot
 * carry (a stored name over 256 characters, a missing or duplicate index row,
 * a result above the delivery bound) is `capability_unavailable`
 * (`result-unavailable`); a stored repository id over 512 characters is
 * `invalid_argument`, as the desktop projection refuses it.
 */
export async function readW5DecidedWorkspace(
  reads: W5DecidedWorkspaceReads,
  workspaceId: string,
): Promise<CoreWorkspaceUpdateResult> {
  const snapshot = await reads.index.readStored();
  const rows = snapshot.entries.flatMap((entry, at) =>
    entry.id === workspaceId ? [at] : [],
  );
  const [at] = rows;
  const entry = at === undefined ? undefined : snapshot.entries[at];
  if (rows.length !== 1 || at === undefined || !entry)
    throw resultUnavailable();
  const manifest = await reads.readManifest(workspaceId);
  const document = manifest.authority === 'ok' ? manifest.document : undefined;
  const view = document ? readW5ManifestView(document).view : undefined;
  const result = CoreWorkspaceUpdateResultSchema.safeParse({
    workspaceId: entry.id,
    name: entry.name,
    kind: entry.type === 'cowork' ? 'cowork' : 'git',
    repositorySources: repositorySources(view?.repos ?? []),
    settings: {},
    ...indexTypedFields(entry, snapshot.storedFields[at]),
    ...(document && view
      ? manifestTypedFields(entry.type, { type: view.type, document })
      : {}),
  });
  if (!result.success) throw resultUnavailable();
  return deliverableW5Result(result.data);
}

/**
 * The decision's hook: a read failure refuses before the decision, so the
 * key is released and no committed change goes unanswered.
 */
export async function decideW5Workspace(
  reads: W5DecidedWorkspaceReads,
  workspaceId: string,
): Promise<CoreWorkspaceUpdateResult> {
  try {
    return await readW5DecidedWorkspace(reads, workspaceId);
  } catch (error) {
    if (error instanceof CanopyOperationError) throw error;
    throw new CanopyOperationError(
      {
        kind: 'unavailable',
        message:
          "This project's details couldn't be read, so nothing was changed. Try again.",
        retry: { kind: 'same_idempotency_key' },
      },
      error,
    );
  }
}
