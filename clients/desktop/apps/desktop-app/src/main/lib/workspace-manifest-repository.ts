import { readWorkspaceManifest } from '@canopy/core-runtime/node';
import { withW5RepositoryLock } from './w5-repository-locks';
import type { WorkspaceConfigFile } from '@canopy/desktop-shared/types';
import type { AtomicFileStorage } from './atomic-file';
import { equalW5Contents } from './w5-revision-diff';
import {
  isJsonObject,
  withUnknownFields,
  type W5FileStore,
} from './w5-file-store';

/** One read of a workspace's `workspace.json`. */
export type WorkspaceManifestRead =
  | { authority: 'absent' }
  | { authority: 'unreadable'; error?: Error }
  | { authority: 'ok'; document: Record<string, unknown>; raw: string };

/**
 * The single reader and writer of `<data>/workspaces/{id}/workspace.json` in
 * desktop main (CAN-3800). It owns the file, not its meaning: callers
 * normalize what {@link read} returns and build the config to write.
 *
 * {@link replace} keeps every field of the manifest it replaces that this
 * version does not know, at the top level and in each repository it keeps
 * (matched by id), and never replaces a manifest that could not be read.
 */
export interface WorkspaceManifestRepository {
  read(workspaceId: string): Promise<WorkspaceManifestRead>;
  /**
   * Runs `work` after every earlier queued task for this workspace settles,
   * so a read-modify-write inside it cannot interleave with another.
   */
  serialize<T>(workspaceId: string, work: () => Promise<T>): Promise<T>;
  /**
   * Replaces the manifest with `config`. `previous` is the read `config` was
   * built from, made inside the same {@link serialize} task.
   */
  replace(
    workspaceId: string,
    config: WorkspaceConfigFile,
    previous: WorkspaceManifestRead,
  ): Promise<void>; /**
   * Replaces the manifest with `document`, a raw manifest derived from
   * `previous` (made inside the same {@link serialize} task). For callers that
   * edit the raw JSON, such as marketplace plugin reference pruning.
   */
  replaceDocument(
    workspaceId: string,
    document: Record<string, unknown>,
    previous: WorkspaceManifestRead,
  ): Promise<void>;
}

export interface WorkspaceManifestRepositoryDeps {
  store: W5FileStore;
  filePath: (workspaceId: string) => string;
  storage: AtomicFileStorage;
  /** Top-level manifest fields this version reads. */
  knownFields: ReadonlySet<string>;
  /** Fields of a `repos[]` entry this version reads. */
  knownRepoFields: ReadonlySet<string>;
}

export class WorkspaceConfigUnreadableError extends Error {
  readonly cause?: unknown;
  constructor(cause?: unknown) {
    super(
      "This project's settings could not be read, so they were not changed. Try again.",
    );
    this.name = 'WorkspaceConfigUnreadableError';
    if (cause !== undefined)
      Object.defineProperty(this, 'cause', {
        value: cause,
        writable: true,
        configurable: true,
      });
  }
}

function repositoriesById(
  document: Record<string, unknown> | undefined,
): Map<string, Record<string, unknown>> {
  const byId = new Map<string, Record<string, unknown>>();
  const repos = document?.repos;
  if (!Array.isArray(repos)) return byId;
  for (const repo of repos) {
    if (isJsonObject(repo) && typeof repo.id === 'string' && !byId.has(repo.id))
      byId.set(repo.id, repo);
  }
  return byId;
}

export function createWorkspaceManifestRepository(
  deps: WorkspaceManifestRepositoryDeps,
): WorkspaceManifestRepository {
  async function writeDocument(
    workspaceId: string,
    document: Record<string, unknown>,
    previous: WorkspaceManifestRead,
  ): Promise<void> {
    if (previous.authority === 'unreadable')
      throw new WorkspaceConfigUnreadableError(previous.error);
    const contents = JSON.stringify(document, null, 2);
    const previousRaw = previous.authority === 'ok' ? previous.raw : null;
    if (equalW5Contents(previousRaw, contents)) return;
    await deps.store.replace(
      deps.filePath(workspaceId),
      contents,
      deps.storage,
      {
        operation: 'w5.workspace_manifest.write',
        advance: [{ kind: 'workspace', workspaceId }],
        previousRaw,
      },
    );
  }

  return {
    async read(workspaceId: string): Promise<WorkspaceManifestRead> {
      const read = await deps.store.read(deps.filePath(workspaceId));
      if (read.state === 'present') {
        const parsed = readWorkspaceManifest(read);
        return parsed.authority === 'ok'
          ? { ...parsed, raw: read.raw }
          : parsed;
      }
      return read.state === 'unreadable'
        ? {
            authority: read.state,
            ...(read.error ? { error: read.error } : {}),
          }
        : { authority: read.state };
    },
    async serialize<T>(
      workspaceId: string,
      work: () => Promise<T>,
    ): Promise<T> {
      return withW5RepositoryLock(
        { kind: 'manifest', path: deps.filePath(workspaceId) },
        work,
      );
    },
    async replace(
      workspaceId: string,
      config: WorkspaceConfigFile,
      previous: WorkspaceManifestRead,
    ): Promise<void> {
      // An atomic replace needs no read permission, so nothing else stops a
      // write over a file this process cannot read; whatever the caller
      // built, it was not built from that file (CAN-3563).
      if (previous.authority === 'unreadable') {
        throw new WorkspaceConfigUnreadableError(previous.error);
      }
      const document =
        previous.authority === 'ok' ? previous.document : undefined;
      const previousRepos = repositoriesById(document);
      const next = withUnknownFields(
        {
          ...config,
          repos: config.repos.map((repo) =>
            withUnknownFields(
              repo,
              previousRepos.get(repo.id),
              deps.knownRepoFields,
            ),
          ),
        },
        document,
        deps.knownFields,
      );
      await writeDocument(workspaceId, next, previous);
    },
    async replaceDocument(
      workspaceId: string,
      document: Record<string, unknown>,
      previous: WorkspaceManifestRead,
    ): Promise<void> {
      if (previous.authority === 'unreadable') {
        throw new WorkspaceConfigUnreadableError(previous.error);
      }
      await writeDocument(workspaceId, document, previous);
    },
  };
}
