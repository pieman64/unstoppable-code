import { realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { W5CommitLogFileStore } from '@canopy/core-runtime/node/w5/commit-log-file-store';
import {
  W5CommitRefusedError,
  W5FileWriteRefusedError,
} from '@canopy/core-runtime/node/w5/commit-log/errors';
import {
  isW5CaptureWorkspaceId,
  W5_CAPTURE_LIMITS,
} from '@canopy/core-runtime/node/w5/commit-log/capture-contract';
import { workspaceCreationDiagnosticsSchema } from '@canopy/core-runtime/node/w5/commit-log/reservation-diagnostics';
import { createWorkspaceIndexRepository } from '@canopy/core-runtime/node/w5/workspace-index-repository';
import { createWorkspaceManifestRepository } from '@canopy/core-runtime/node/w5/workspace-manifest-repository';
import { createWorktreeListRepository } from '@canopy/core-runtime/node/w5/worktree-list-repository';
import {
  setW5CommitOutcome,
  type W5CommitOptions,
} from '@canopy/core-runtime/node/w5/commit-scope';
import { createW5DecisionOnlyRetry } from '@canopy/core-runtime/node/w5/workspace-metadata/retry';
import { getCanopyDataDir } from '../../canopy-paths';
import { isActivitySectionId } from '../../constants/activity';
import { PROJECT_COLORS } from '../../constants/project-colors';
import type {
  ActivitySectionId,
  SidebarItem,
  WorkspaceConfigFile,
  WorkspaceIndexEntry,
  WorkspaceCliRecord,
  WorktreeData,
} from '../../types';
import { isRecord } from '@canopy/execution-engine/node/lib/type-guards';
import { isPathInside } from '@canopy/execution-engine/node/lib/path-safety';
import {
  getWorkspacesRootDir,
  toWorkspaceCliRecord,
} from '../lib/workspace-cli-reads';
import { workspaceCreationWriteFor } from '../worktree-record-decision-apply';
import { remoteUrlsMatch } from '../lib/repo-url-matcher';
import {
  workspaceRemote,
  workspacePathExists,
} from './workspace-create-effects';
import { assertNoConflictingW5Reservation } from './worktree-delete-records';

const storage = {
  index: { namespace: 'workspace_index', writer: 'desktop_cli' },
  manifest: { namespace: 'workspace_manifest', writer: 'desktop_cli' },
  list: { namespace: 'worktree_list', writer: 'desktop_cli' },
} as const;

function workspaceRecordPaths(id: string): {
  manifest: string;
  list: string;
} {
  if (!isW5CaptureWorkspaceId(id))
    throw new Error(
      'The project ID cannot be represented by the record authority.',
    );
  return {
    manifest: join(getWorkspacesRootDir(), id, 'workspace.json'),
    list: join(getWorkspacesRootDir(), id, 'worktrees.json'),
  };
}

function repositories(store: W5CommitLogFileStore): {
  index: ReturnType<typeof createWorkspaceIndexRepository<ActivitySectionId>>;
  manifest: ReturnType<
    typeof createWorkspaceManifestRepository<WorkspaceConfigFile>
  >;
  list: ReturnType<typeof createWorktreeListRepository<WorktreeData>>;
} {
  return {
    index: createWorkspaceIndexRepository({
      store,
      filePath: () => join(getWorkspacesRootDir(), 'index.json'),
      storage: storage.index,
      normalizeActivitySectionOrder: (value) =>
        Array.isArray(value)
          ? value.filter(
              (id): id is ActivitySectionId =>
                typeof id === 'string' && isActivitySectionId(id),
            )
          : undefined,
      onCommitted: () => undefined,
      onRefused: () => undefined,
    }),
    manifest: createWorkspaceManifestRepository({
      store,
      filePath: (id) => workspaceRecordPaths(id).manifest,
      storage: storage.manifest,
      knownFields: new Set(),
      knownRepoFields: new Set(),
    }),
    list: createWorktreeListRepository({
      store,
      filePath: (id) => workspaceRecordPaths(id).list,
      storage: storage.list,
      knownRowFields: new Set(),
      readRow: (row) => row,
    }),
  };
}

export interface WorkspaceBinding {
  workspaceId: string;
  path: string;
  name: string;
  workspace: boolean;
  reusable: boolean;
  remote: string | null;
}
export interface WorkspaceCreationSnapshot {
  entries: WorkspaceIndexEntry[];
  roots: string[];
  bindings: WorkspaceBinding[];
}

/** Every indexed root must be known before absence, containment or reuse can be decided. */
export async function readWorkspaceCreationSnapshot(
  store: W5CommitLogFileStore,
): Promise<WorkspaceCreationSnapshot> {
  const repo = repositories(store);
  const index = await repo.index.read();
  const backup = await createWorkspaceIndexRepository({
    store,
    filePath: () => join(getWorkspacesRootDir(), 'index.json.bak'),
    storage: storage.index,
    normalizeActivitySectionOrder: () => undefined,
    onCommitted: () => undefined,
    onRefused: () => undefined,
  }).read();
  if (backup.authority !== 'ok' && backup.authority !== 'absent')
    throw new Error('The project list backup could not be read completely.');
  if (index.authority !== 'ok' && index.authority !== 'absent')
    throw new Error('The project list could not be read completely.');
  const roots: string[] = [];
  const bindings: WorkspaceBinding[] = [];
  for (const entry of index.entries) {
    const manifest = await repo.manifest.read(entry.id);
    if (manifest.authority !== 'ok')
      throw new Error('A tracked project manifest could not be read.');
    const doc = manifest.document;
    if (
      doc.type !== entry.type ||
      (doc.repos !== undefined && !Array.isArray(doc.repos)) ||
      (entry.type === 'multi-repo' && !Array.isArray(doc.repos))
    )
      throw new Error('A tracked project manifest is incomplete.');
    if (entry.type === 'cowork') {
      const root =
        doc.externalPath ?? join(getWorkspacesRootDir(), entry.id, 'home');
      if (typeof root !== 'string')
        throw new Error('A tracked folder binding is unreadable.');
      roots.push(root);
    } else {
      const source =
        entry.type === 'single-repo' ? doc.repoPath : doc.sourceRepoPath;
      if (source !== undefined && typeof source !== 'string')
        throw new Error('A tracked repository binding is unreadable.');
      if (typeof source === 'string') {
        roots.push(source);
        bindings.push({
          workspaceId: entry.id,
          path: source,
          name: entry.name,
          workspace: true,
          reusable: entry.type === 'single-repo',
          remote: null,
        });
      } else if (entry.type === 'single-repo')
        throw new Error('A tracked repository binding is unreadable.');
      for (const member of Array.isArray(doc.repos) ? doc.repos : []) {
        if (
          !isRecord(member) ||
          typeof member.id !== 'string' ||
          typeof member.name !== 'string' ||
          typeof member.repoPath !== 'string'
        )
          throw new Error('A tracked member binding is unreadable.');
        roots.push(member.repoPath);
        bindings.push({
          workspaceId: entry.id,
          path: member.repoPath,
          name: member.name,
          workspace: false,
          reusable: true,
          remote: null,
        });
      }
    }
  }
  return { entries: index.entries, roots, bindings };
}

async function resolveTrackedRoot(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch (error) {
    if (
      isRecord(error) &&
      (error.code === 'ENOENT' || error.code === 'ENOTDIR')
    )
      return null;
    throw error;
  }
}

export async function resolveWorkspaceBindings(
  snapshot: WorkspaceCreationSnapshot,
): Promise<void> {
  for (const binding of snapshot.bindings) {
    binding.remote = null;
    if ((await resolveTrackedRoot(binding.path)) === null) continue;
    try {
      binding.remote = await workspaceRemote(binding.path);
    } catch (error) {
      // A missing Git executable is not evidence that the checkout disappeared.
      if (
        !isRecord(error) ||
        (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') ||
        (await resolveTrackedRoot(binding.path)) !== null
      )
        throw error;
    }
  }
}

export function matchingWorkspaceBinding(
  bindings: WorkspaceBinding[],
  url: string,
): WorkspaceBinding | undefined {
  return bindings.find(
    (binding) =>
      binding.reusable &&
      binding.remote !== null &&
      (binding.remote === url || remoteUrlsMatch(binding.remote, url)),
  );
}

/** A checkout can be tracked by several workspaces; each owner must be clear. */
export async function assertWorkspaceBindingAvailable(
  store: W5CommitLogFileStore,
  bindings: WorkspaceBinding[],
  path: string,
): Promise<void> {
  const target = (await resolveTrackedRoot(path)) ?? resolve(path);
  const owners = new Set<string>();
  for (const binding of bindings) {
    const tracked =
      (await resolveTrackedRoot(binding.path)) ?? resolve(binding.path);
    if (tracked === target) owners.add(binding.workspaceId);
  }
  for (const workspaceId of owners)
    await assertNoConflictingW5Reservation(
      store,
      workspaceId,
      undefined,
      'core.worktree.delete',
    );
}

export async function assertWorkspaceImportable(
  snapshot: WorkspaceCreationSnapshot,
  root: string,
  cowork: boolean,
): Promise<void> {
  const resolved = await realpath(root);
  if (cowork) {
    const data = await realpath(getCanopyDataDir());
    if (
      data === resolved ||
      isPathInside(data, resolved) ||
      isPathInside(resolved, data)
    )
      throw new Error(
        'Cannot add a folder that overlaps the app data directory.',
      );
  }
  for (const path of snapshot.roots) {
    const tracked = (await resolveTrackedRoot(path)) ?? resolve(path);
    if (tracked === resolved)
      throw new Error('This folder is already tracked as a project.');
    if (
      cowork &&
      (isPathInside(tracked, resolved) || isPathInside(resolved, tracked))
    )
      throw new Error('Cannot add a folder that overlaps an existing project.');
  }
}

export function workspaceIdBase(name: string): string {
  const id =
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'workspace';
  if (!isW5CaptureWorkspaceId(id))
    throw new Error(
      'The generated project ID is unsupported. Choose a different name.',
    );
  return id;
}

export async function allocateWorkspaceIdentity(
  store: W5CommitLogFileStore,
  name: string,
  entries: WorkspaceIndexEntry[],
  excluded: readonly string[] = [],
): Promise<string> {
  const busy = new Set(
    [...entries.map((entry) => entry.id), ...excluded].map((id) =>
      id.toLowerCase(),
    ),
  );
  for (const reservation of await store.readReservations()) {
    const parsed = workspaceCreationDiagnosticsSchema.safeParse(
      reservation.diagnostics,
    );
    if (parsed.success) busy.add(parsed.data.workspaceId.toLowerCase());
  }
  const base = workspaceIdBase(name);
  for (let suffix = 1; suffix <= 10000; suffix += 1) {
    const candidate = suffix === 1 ? base : `${base}-${suffix}`;
    workspaceRecordPaths(candidate);
    if (
      !busy.has(candidate.toLowerCase()) &&
      !(await workspacePathExists(join(getWorkspacesRootDir(), candidate)))
    )
      return candidate;
  }
  throw new Error('No available project identity.');
}

function configFor(item: SidebarItem): WorkspaceConfigFile {
  if (item.type === 'cowork')
    return {
      version: 1,
      type: item.type,
      repos: [],
      externalPath: item.externalPath,
    };
  if (item.type === 'single-repo')
    return { version: 1, type: item.type, repos: [], repoPath: item.repoPath };
  return {
    version: 1,
    type: item.type,
    repos: item.repos,
    sourceRepoPath: item.sourceRepoPath,
  };
}

/** Only this decision retries; prepared source/member repositories are immutable inputs. */
export function publishRoutedWorkspace(options: {
  store: W5CommitLogFileStore;
  binding: W5CommitOptions;
  item: SidebarItem;
  imported: boolean;
  signal: AbortSignal;
}): Promise<WorkspaceCliRecord> {
  const { store, item, signal } = options;
  const conflictedChildren = new Set<string>();
  return createW5DecisionOnlyRetry().run('cli workspace publish', async () => {
    signal.throwIfAborted();
    const discovered = await readWorkspaceCreationSnapshot(store);
    // Allocate child records afresh, but never reallocate the provisioned parent.
    const children: SidebarItem[] = [];
    const bindings = [...discovered.bindings];
    if (options.imported && item.type === 'multi-repo') {
      await resolveWorkspaceBindings(discovered);
      for (const member of item.repos) {
        if (
          bindings.some(
            (binding) =>
              binding.workspace &&
              (binding.path === member.repoPath ||
                (binding.remote !== null &&
                  member.manifestUrl !== undefined &&
                  (binding.remote === member.manifestUrl ||
                    remoteUrlsMatch(binding.remote, member.manifestUrl)))),
          )
        )
          continue;
        const child: SidebarItem = {
          type: 'single-repo',
          id: await allocateWorkspaceIdentity(
            store,
            member.name,
            discovered.entries,
            [
              item.id,
              ...children.map((child) => child.id),
              ...conflictedChildren,
            ],
          ),
          name: member.name,
          repoPath: member.repoPath,
          worktrees: [],
          color: '',
          collapsed: false,
          order: 0,
        };
        children.push(child);
        bindings.push({
          workspaceId: child.id,
          path: member.repoPath,
          remote: member.manifestUrl ?? null,
          workspace: true,
          reusable: true,
          name: member.name,
        });
      }
    }
    const childWorkspaces = children.filter(
      (child) => child.type === 'single-repo',
    );
    const write = workspaceCreationWriteFor(
      options.imported && item.type === 'multi-repo'
        ? { kind: 'workspace.import.publish', workspace: item, childWorkspaces }
        : { kind: 'workspace.create.publish', item },
    );
    const additions = write.items;
    const indexPath = join(getWorkspacesRootDir(), 'index.json');
    const lockedIds = [
      ...new Set([
        ...discovered.entries.map((entry) => entry.id),
        ...additions.map((added) => added.id),
      ]),
    ];
    const locks = [
      { kind: 'index' as const, path: indexPath },
      { kind: 'index' as const, path: `${indexPath}.bak` },
      ...lockedIds.map((id) => ({
        kind: 'manifest' as const,
        path: workspaceRecordPaths(id).manifest,
      })),
      ...additions
        .filter((added) => added.type !== 'cowork')
        .map((added) => ({
          kind: 'list' as const,
          path: workspaceRecordPaths(added.id).list,
        })),
    ];
    if (locks.length > W5_CAPTURE_LIMITS.files)
      throw new Error(
        'The atomic project publication exceeds the record limit.',
      );
    const publication = store.withCommit(
      {
        ...options.binding,
        locks,
        fenceLockedFiles: true,
        beforeDecision: () => signal.throwIfAborted(),
      },
      async () => {
        const current = await readWorkspaceCreationSnapshot(store);
        if (
          JSON.stringify(current.entries) !== JSON.stringify(discovered.entries)
        )
          throw new W5FileWriteRefusedError(indexPath);
        if (options.imported) {
          const root =
            item.type === 'cowork'
              ? item.externalPath
              : item.type === 'single-repo'
                ? item.repoPath
                : item.sourceRepoPath;
          if (!root) throw new Error('The imported project has no root.');
          await assertWorkspaceImportable(
            current,
            root,
            item.type === 'cowork',
          );
        }
        // Re-read dependencies inside the fence; never publish stale child/reuse bindings.
        if (JSON.stringify(current.roots) !== JSON.stringify(discovered.roots))
          throw new W5FileWriteRefusedError(indexPath);
        if (item.type === 'multi-repo')
          for (const member of item.repos)
            await assertWorkspaceBindingAvailable(
              store,
              current.bindings,
              member.repoPath,
            );
        const repo = repositories(store);
        const addedItems = additions.map(
          (added, offset): SidebarItem => ({
            ...added,
            order: current.entries.length + offset,
            color:
              PROJECT_COLORS[
                (current.entries.length + offset) % PROJECT_COLORS.length
              ] ?? PROJECT_COLORS[0],
          }),
        );
        for (const added of addedItems) {
          if (current.entries.some((entry) => entry.id === added.id))
            throw new Error(
              'The reserved project identity is already tracked.',
            );
          const manifest = await repo.manifest.read(added.id);
          if (manifest.authority !== 'absent')
            throw new Error(
              'The reserved project manifest is occupied or unreadable.',
            );
          await repo.manifest.replace(added.id, configFor(added), manifest);
          if (added.type !== 'cowork') {
            const list = await repo.list.read(added.id);
            if (list.authority !== 'absent')
              throw new Error(
                'The reserved project list is occupied or unreadable.',
              );
            await repo.list.replace(added.id, [], list);
          }
        }
        await repo.index.update((index) => {
          if (index.authority !== 'ok' && index.authority !== 'absent')
            throw new Error('The project list is unreadable.');
          if (JSON.stringify(index.entries) !== JSON.stringify(current.entries))
            throw new W5FileWriteRefusedError(indexPath);
          return {
            entries: [
              ...index.entries,
              ...addedItems.map(
                (added): WorkspaceIndexEntry => ({
                  id: added.id,
                  name: added.name,
                  type: added.type,
                  color: added.color,
                  collapsed: added.collapsed,
                  order: added.order,
                }),
              ),
            ],
            result: undefined,
          };
        });
        const parent = addedItems[0];
        if (!parent) throw new Error('Missing project publication.');
        const record = toWorkspaceCliRecord(parent);
        const outcome = { version: 1, record };
        if (Buffer.byteLength(JSON.stringify(outcome)) > 64 * 1024)
          throw new Error('The saved project result is too large.');
        setW5CommitOutcome(outcome);
        return record;
      },
    );
    try {
      return await publication;
    } catch (error) {
      if (
        error instanceof W5CommitRefusedError &&
        error.reason === 'identity-conflict' &&
        typeof error.details.workspaceIdentity === 'string'
      ) {
        const identity = error.details.workspaceIdentity.toLowerCase();
        if (
          identity !== item.id.toLowerCase() &&
          children.some((child) => child.id.toLowerCase() === identity)
        ) {
          // Children have no Git effects; only their record allocation retries.
          conflictedChildren.add(identity);
          throw new W5FileWriteRefusedError(
            workspaceRecordPaths(identity).manifest,
          );
        }
      }
      throw error;
    }
  });
}
