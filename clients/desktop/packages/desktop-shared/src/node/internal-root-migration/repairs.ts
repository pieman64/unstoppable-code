import { execFile } from 'node:child_process';
import { coordinateInternalRootMigration } from './index';
import {
  collectInternalRootCleanupCandidates,
  saveInternalRootCleanupReport,
  type InternalRootCleanupReport,
} from './cleanup-candidates';
import { promisify, isDeepStrictEqual } from 'node:util';
import {
  chmod,
  open,
  rm,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
} from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import { observeStoragePathSync } from '@canopy/core-platform/storage-path-observation';
import {
  internalRootFilesystemHost,
  type InternalRootFilesystemHost,
} from './filesystem-host';
import {
  deriveLocalAuthorityIdentity,
  observeLocalAuthorityRelocation,
  hostLocalAuthorityObservation,
  type LocalAuthorityObservation,
} from '@canopy/core-platform';
import {
  createInternalRootRepairs,
  projectInternalRootMetadata,
  type InternalRootRepairWorker,
  type InternalRootRepairPlan,
} from '@canopy/core-runtime/node/internal-root-repairs';
import {
  InternalRootMigrationRefused,
  type InternalRootIdentity,
  type InternalRootRepairContext,
} from '@canopy/core-runtime/node/internal-root-migration';
import {
  prepareRelocationGit,
  isMissingPrunableGitWorktree,
  qualifyRelocationGit,
  projectRelocationBacklinks,
  assertRelocationOwnedPathsSafe,
  relocationWorktreeOwnedPaths,
  isWithin,
  movedOwnedPath,
  type RelocationGit,
  type RelocationGitPlan,
  type RelocationWorkspaceEvidence,
} from '@canopy/core-runtime/node/relocation';
import { createWorkspaceIndexRepository } from '@canopy/core-runtime/node/w5/workspace-index-repository';
import { createWorkspaceManifestRepository } from '@canopy/core-runtime/node/w5/workspace-manifest-repository';
import { createWorktreeListRepository } from '@canopy/core-runtime/node/w5/worktree-list-repository';
import {
  readNodeW5File,
  type W5FileStore,
} from '@canopy/core-runtime/node/w5/file-store';
import {
  W5CommitLog,
  applyW5Commit,
} from '@canopy/core-runtime/node/w5/commit-log';
import { assertRelocationW5Settled } from '@canopy/core-runtime/node/relocation';
import { fingerprintW5File } from '@canopy/core-runtime/node/w5/commit-log/fingerprint';
import type { W5DurabilityPort } from '@canopy/core-runtime/node/w5/commit-log';
import {
  freezeInternalRootJournals,
  internalRootJournalOwnedPaths,
  relocateInternalRootJournals,
} from './lifecycle-journals';
import {
  durableJson,
  privateDirectory,
  statIfPresent,
  validateExternalRootFiles,
} from './filesystem';

const execute = promisify(execFile);
function portableGitFilesystem(): boolean {
  const os = hostOperatingSystem();
  return os === 'win32' || os === 'linux';
}
function unlinkedStoragePath(path: string): boolean {
  const observation = observeStoragePathSync(path);
  return (
    observation.kind !== 'missing' &&
    observation.symbolicLinkComponents.length === 0 &&
    (hostOperatingSystem() === 'win32' || observation.canonicalPath === path)
  );
}
const git: RelocationGit = async (cwd, args) =>
  (
    await execute('git', ['--no-optional-locks', ...args], {
      cwd,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      timeout: 30_000,
      maxBuffer: 64 * 1024 * 1024,
    })
  ).stdout;

/** Reuses the migration's read-only Git host, not a new execution surface. */
export async function reportInternalRootCleanup(
  identity: InternalRootIdentity,
  applied: boolean,
  host: InternalRootFilesystemHost,
  sourceBytes?: number,
): Promise<InternalRootCleanupReport> {
  // Only the exclusive holder can distinguish abandoned staging from a live writer.
  const release = await coordinateInternalRootMigration(identity, host);
  try {
    const report = await collectInternalRootCleanupCandidates(identity, {
      applied,
      git,
      sourceBytes,
    });
    await saveInternalRootCleanupReport(report, host);
    return report;
  } finally {
    await release();
  }
}
function refuse(reason: string): never {
  throw new InternalRootMigrationRefused(
    'repair-refused',
    `${reason}. Preserve both roots and the journal; obtain offline relocation recovery.`,
  );
}
const readonlyStore: W5FileStore = {
  read: readNodeW5File,
  replace: () => Promise.reject(new Error('Read-only relocation inventory')),
  remove: () => Promise.reject(new Error('Read-only relocation inventory')),
};

/** Inventory links and Git roots; W5 supplies the other exact owned path fields. */
async function inventoryTree(
  root: string,
  opaqueDirectories: ReadonlySet<string>,
): Promise<{ paths: string[]; checkouts: string[] }> {
  const paths: string[] = [root];
  const checkouts: string[] = [];
  const visit = async (path: string): Promise<void> => {
    if (opaqueDirectories.has(path)) return;
    const state = await lstat(path);
    if (state.isSymbolicLink()) {
      paths.push(path);
      return;
    }
    if (!state.isDirectory()) return;
    if (
      !isWithin(join(root, 'w5'), path) &&
      (await statIfPresent(join(path, '.git')))
    ) {
      paths.push(path);
      checkouts.push(path);
      return;
    }
    for (const name of await readdir(path)) await visit(join(path, name));
  };
  await visit(root);
  return { paths, checkouts };
}

async function freeze(
  context: InternalRootRepairContext,
  observation: LocalAuthorityObservation,
  diagnostics?: string[],
): Promise<InternalRootRepairPlan> {
  const { identity } = context;
  const transition = await observeLocalAuthorityRelocation(
    {
      brandId: identity.brandId,
      installationId: context.transactionId,
      sourceRoot: identity.source,
      destinationRoot: identity.destination,
    },
    observation,
  );
  const workspaceRoot = join(identity.source, 'workspaces');
  const index = createWorkspaceIndexRepository({
    store: readonlyStore,
    filePath: () => join(workspaceRoot, 'index.json'),
    onCommitted: () => {},
    onRefused: () => {},
    storage: { namespace: 'workspace_index', writer: 'electron_main' },
    normalizeActivitySectionOrder: () => undefined,
  });
  const membership = await index.read();
  if (membership.authority !== 'ok' && membership.authority !== 'absent')
    refuse('Unreadable workspace membership');
  const workspaces: RelocationWorkspaceEvidence[] = [];
  const manifest = createWorkspaceManifestRepository({
    store: readonlyStore,
    filePath: (id) => join(workspaceRoot, id, 'workspace.json'),
    storage: { namespace: 'workspace_manifest', writer: 'electron_main' },
    knownFields: new Set(),
    knownRepoFields: new Set(),
  });
  const list = createWorktreeListRepository({
    store: readonlyStore,
    filePath: (id) => join(workspaceRoot, id, 'worktrees.json'),
    storage: { namespace: 'worktree_list', writer: 'electron_main' },
    knownRowFields: new Set(),
    readRow: (row) => row,
  });
  const ids = membership.entries.map((entry) => entry.id);
  if (
    new Set(ids).size !== ids.length ||
    ids.some((id) => !/^[A-Za-z0-9_-]+$/.test(id))
  )
    refuse('Ambiguous workspace membership');
  // Unindexed sidecars carry no Git/owned-path discovery grant. Lifecycle and
  // indexed records still supply their explicit owner paths below.
  const opaqueDirectories = new Set<string>();
  if (await statIfPresent(workspaceRoot)) {
    for (const entry of await readdir(workspaceRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && !ids.includes(entry.name))
        opaqueDirectories.add(join(workspaceRoot, entry.name));
    }
  }
  const inventory = await inventoryTree(identity.source, opaqueDirectories);
  const lifecycleJournals = await freezeInternalRootJournals(
    identity.source,
  ).catch((error: unknown) => {
    if (!diagnostics) throw error;
    diagnostics.push(
      error instanceof Error
        ? error.message
        : 'Unreadable lifecycle owner evidence',
    );
    return [];
  });
  inventory.paths.push(
    ...internalRootJournalOwnedPaths(identity.source, lifecycleJournals),
  );
  for (const workspaceId of ids) {
    try {
      const document = await manifest.read(workspaceId);
      const trees = await list.read(workspaceId);
      if (
        document.authority !== 'ok' ||
        trees.authority === 'unreadable' ||
        (trees.authority === 'ok' && !trees.complete)
      )
        refuse('Unreadable workspace owner evidence');
      const repoPaths: string[] = [];
      const ownerDirectories: string[] = [];
      for (const key of ['folderPath', 'externalPath'] as const) {
        const path = document.document[key];
        if (typeof path === 'string' && isWithin(identity.source, path)) {
          const state = await statIfPresent(path);
          if (!state?.isDirectory() || !unlinkedStoragePath(path))
            refuse('Unproven managed folder');
          ownerDirectories.push(path);
          inventory.paths.push(path);
        }
      }
      for (const key of ['repoPath', 'sourceRepoPath'] as const) {
        const path = document.document[key];
        if (typeof path === 'string') repoPaths.push(path);
      }
      const repos: unknown = document.document.repos;
      if (Array.isArray(repos))
        for (const entry of repos) {
          const repo: unknown = entry;
          if (
            typeof repo !== 'object' ||
            repo === null ||
            !('repoPath' in repo) ||
            typeof repo.repoPath !== 'string'
          )
            refuse('Unreadable repository owner evidence');
          repoPaths.push(repo.repoPath);
        }
      for (const path of repoPaths) {
        // External owner references are read only, never a recursive walk grant.
        if (
          (await statIfPresent(path)) &&
          (await statIfPresent(join(path, '.git')))
        )
          inventory.checkouts.push(path);
      }
      const worktreePaths = relocationWorktreeOwnedPaths(
        trees.authority === 'ok' ? trees.raw : null,
      );
      for (const path of worktreePaths) {
        if (resolve(path) !== path) refuse('Noncanonical owner path');
        inventory.paths.push(path);
        const stat = await statIfPresent(path);
        if (stat?.isSymbolicLink())
          inventory.paths.push(resolve(dirname(path), await readlink(path)));
      }
      workspaces.push({
        workspaceId,
        targetId: 'local',
        manifestRaw: document.raw,
        listRaw: trees.authority === 'ok' ? trees.raw : null,
        repositoryPaths: ownerDirectories,
        ownedPaths: worktreePaths,
      });
    } catch (error) {
      if (!diagnostics) throw error;
      diagnostics.push(
        `Workspace ${workspaceId}: ${error instanceof Error ? error.message : 'unreadable owner evidence'}`,
      );
    }
  }
  // Complete each common repository's membership, including external linked checkouts.
  const checkouts = new Set(inventory.checkouts);
  const reportedMissingPrunable = new Set<string>();
  for (const path of checkouts) {
    let listed: string;
    try {
      listed = await git(path, ['worktree', 'list', '--porcelain', '-z']);
    } catch (error) {
      if (!diagnostics) throw error;
      diagnostics.push(
        `Git ${path}: ${error instanceof Error ? error.message : 'unreadable checkout'}`,
      );
      checkouts.delete(path);
      continue;
    }
    for (const record of listed.split('\0\0')) {
      const fields = record.split('\0');
      if (
        fields.includes('bare') ||
        (await isMissingPrunableGitWorktree(fields, reportedMissingPrunable))
      )
        continue;
      const member = fields
        .find((field) => field.startsWith('worktree '))
        ?.slice(9);
      if (member) checkouts.add(member);
    }
  }
  let gitPlan: RelocationGitPlan = { checkouts: [], backlinks: [] };
  if (diagnostics) {
    const groups = new Map<string, string[]>();
    for (const path of checkouts) {
      try {
        const common = (
          await git(path, [
            'rev-parse',
            '--path-format=absolute',
            '--git-common-dir',
          ])
        ).trim();
        const members = groups.get(common) ?? [];
        members.push(path);
        groups.set(common, members);
      } catch (error) {
        diagnostics.push(
          `Git ${path}: ${error instanceof Error ? error.message : 'unreadable checkout'}`,
        );
      }
    }
    for (const [common, paths] of groups) {
      try {
        const group = await prepareRelocationGit(git, paths, {
          portableFilesystem: portableGitFilesystem(),
          reportedMissingPrunable,
        });
        gitPlan = {
          checkouts: [...gitPlan.checkouts, ...group.checkouts],
          backlinks: [...gitPlan.backlinks, ...group.backlinks],
        };
      } catch (error) {
        diagnostics.push(
          `Git ${common}: ${error instanceof Error ? error.message : 'preparation refused'}`,
        );
      }
    }
  } else
    gitPlan = await prepareRelocationGit(git, [...checkouts], {
      portableFilesystem: portableGitFilesystem(),
      reportedMissingPrunable,
    });
  const repositoryPaths = gitPlan.checkouts.map((row) => row.path);
  return {
    transition,
    lifecycleJournals,
    gitPlan,
    ownedPaths: [...new Set(inventory.paths)],
    workspaces: workspaces.map((evidence) => ({
      ...evidence,
      repositoryPaths: [...repositoryPaths, ...evidence.repositoryPaths],
    })),
  };
}

/** Legacy inventory included external payload targets, which confer no owner authority. */
function ownedPathsForProof(plan: InternalRootRepairPlan): readonly string[] {
  return [
    ...plan.ownedPaths.filter((path) =>
      isWithin(plan.transition.from.canonicalDataRoot, path),
    ),
    ...plan.workspaces.flatMap((row) => [
      ...(row.ownedPaths ?? relocationWorktreeOwnedPaths(row.listRaw)),
      ...row.repositoryPaths,
    ]),
    ...internalRootJournalOwnedPaths(
      plan.transition.from.canonicalDataRoot,
      plan.lifecycleJournals ?? [],
    ),
    ...plan.gitPlan.checkouts.flatMap((row) => [row.path, row.commonDirectory]),
    ...plan.gitPlan.backlinks.map((row) => row.path),
  ];
}

function checkedPlan(
  context: InternalRootRepairContext,
  plan: InternalRootRepairPlan,
): void {
  const { transition } = plan;
  if (
    transition.installationId !== context.transactionId ||
    transition.brandId !== context.identity.brandId ||
    transition.from.canonicalDataRoot !== context.identity.source ||
    transition.to.canonicalDataRoot !== context.identity.destination
  )
    refuse('Frozen authority mapping does not match this transaction');
  const external = plan.gitPlan.backlinks
    .filter((image) => !isWithin(context.identity.source, image.path))
    .map((image) => image.path);
  if (!isDeepStrictEqual(external, context.externalFiles))
    refuse('External repair membership changed');
}

/** Live B/C composition. It has no dependency on ordinary routing or destination startup. */
export function createInternalRootRelocationRepairs(options: {
  readonly durability: W5DurabilityPort;
  /** Host-selected TokenUser observer; Windows refuses when it is absent. */
  readonly windowsPrincipal?: () => Promise<string>;
  readonly ownedChildPath?: string;
  readonly filesystemHost?: InternalRootFilesystemHost;
}): ReturnType<typeof createInternalRootRepairs> {
  const observation = hostLocalAuthorityObservation(options.windowsPrincipal);
  const host =
    options.filesystemHost ??
    internalRootFilesystemHost(options.ownedChildPath);
  const worker: InternalRootRepairWorker = {
    ownedPathsForProof,
    ...(host.windows
      ? {
          replaceBacklink: async (image: {
            readonly path: string;
            readonly contents: string;
          }): Promise<void> => {
            const windows = host.windows;
            if (!windows) refuse('Windows filesystem custody unavailable');
            const before = windows.inspect(image.path);
            const temp = join(
              dirname(image.path),
              `.${basename(image.path)}.relocation-${randomUUID()}.tmp`,
            );
            let owned = false;
            try {
              windows.copy(image.path, temp);
              owned = true;
              // Only the private copy becomes writable; the preimage stays untouched.
              await chmod(temp, 0o600);
              const handle = await open(temp, 'r+');
              try {
                await handle.writeFile(image.contents);
                await handle.truncate(Buffer.byteLength(image.contents));
                await handle.sync();
              } finally {
                await handle.close();
              }
              windows.finish(image.path, temp);
              const current = windows.inspect(image.path);
              if (!isDeepStrictEqual(current, before))
                refuse('Git backlink changed during private replacement');
              windows.replace(temp, image.path);
              owned = false;
              const after = windows.inspect(image.path);
              if (
                after.attributes !== before.attributes ||
                after.security !== before.security ||
                windows.read(image.path).toString('utf8') !== image.contents
              )
                refuse(
                  'Git backlink attributes or contents changed during replacement',
                );
            } finally {
              if (owned) await rm(temp, { force: true });
            }
          },
        }
      : {}),
    freeze: (context) => freeze(context, observation),
    admit: async (context, plan) => {
      checkedPlan(context, plan);
      const observed = await observeLocalAuthorityRelocation(
        {
          brandId: context.identity.brandId,
          installationId: context.transactionId,
          sourceRoot: context.identity.source,
          destinationRoot: context.identity.destination,
        },
        observation,
      );
      if (!isDeepStrictEqual(observed, plan.transition))
        refuse('Authority observation changed');
      await validateExternalRootFiles(
        context.identity,
        context.externalFiles,
        host,
      );
    },
    recordAuthority: async (context, plan) => {
      const path = join(context.workingRoot, 'internal-root-authority.json');
      if (await statIfPresent(path)) {
        if (
          !isDeepStrictEqual(
            JSON.parse(await readFile(path, 'utf8')),
            plan.transition,
          )
        )
          refuse('Conflicting recorded authority');
      } else await durableJson(path, plan.transition, host);
    },
    repairMetadata: async (context, plan, images) => {
      await relocateInternalRootJournals(
        plan.transition,
        context.workingRoot,
        host,
        plan.lifecycleJournals ?? [],
      );
      if (!images.length) return;
      const root = context.workingRoot;
      await mkdir(join(root, 'w5'), { recursive: true, mode: 0o700 });
      const log = W5CommitLog.open(join(root, 'w5', 'commit-log.sqlite'));
      try {
        assertRelocationW5Settled(log);
        const files = [];
        for (const image of images) {
          const original = plan.workspaces.find(
            (row) => row.workspaceId === image.workspaceId,
          );
          if (!original) refuse('Missing frozen workspace evidence');
          for (const [name, contents, previous] of [
            ['workspace.json', image.manifestRaw, original.manifestRaw],
            ['worktrees.json', image.listRaw, original.listRaw],
          ] as const) {
            if (contents === previous) continue;
            const finalPath = join(
              context.identity.destination,
              'workspaces',
              image.workspaceId,
              name,
            );
            const path = join(root, 'workspaces', image.workspaceId, name);
            const current = await readNodeW5File(path);
            if ((current.state === 'present' ? current.raw : null) !== previous)
              refuse('Staging owner image differs from frozen evidence');
            files.push({
              path: finalPath,
              contents,
              previousFingerprint:
                previous === null ? null : fingerprintW5File(previous),
            });
          }
        }
        if (!files.length) return;
        const decision = log.commit({
          operation: 'core.internalRoot.relocate',
          files,
          advance: images.flatMap((image) => image.advance),
          outcome: { kind: 'relocated', transactionId: context.transactionId },
        });
        if (decision.status !== 'committed')
          refuse('Unexpected relocation replay');
        const pending = log
          .listPendingCommits()
          .find((entry) => entry.commitId === decision.commitId);
        if (!pending) refuse('Missing relocation decision');
        // Historical/new log paths are final identities; only the execution projection
        // points at private staging. No daemon/ordinary writer runs here.
        const result = await applyW5Commit(
          log,
          {
            ...pending,
            files: pending.files.map((file) => ({
              ...file,
              path: join(
                root,
                relative(context.identity.destination, file.path),
              ),
            })),
          },
          {
            root: join(root, 'workspaces'),
            durability: options.durability,
          },
        );
        if (result.status !== 'applied')
          refuse('Relocation W5 decision requires recovery');
      } finally {
        log.close();
      }
    },
    verify: async (context, plan, images, published) => {
      checkedPlan(context, plan);
      const root = context.workingRoot;
      await privateDirectory(root, host);
      if (published) {
        const observed = await deriveLocalAuthorityIdentity(
          {
            brandId: context.identity.brandId,
            dataRoot: root,
          },
          observation,
        );
        if (!isDeepStrictEqual(observed, plan.transition.to))
          refuse('Published authority differs from frozen mapping');
      } else await worker.admit(context, plan);
      if (
        !isDeepStrictEqual(
          JSON.parse(
            await readFile(join(root, 'internal-root-authority.json'), 'utf8'),
          ),
          plan.transition,
        )
      )
        refuse('Recorded authority differs');
      await assertRelocationOwnedPathsSafe(
        plan.transition,
        [
          ...ownedPathsForProof(plan),
          ...plan.gitPlan.checkouts.flatMap((row) => [
            row.path,
            row.commonDirectory,
          ]),
        ],
        root,
        published,
        {
          preserveSourceTargetsWithin: plan.gitPlan.checkouts.map((row) =>
            movedOwnedPath(plan.transition, row.path),
          ),
        },
      );
      for (const image of await projectRelocationBacklinks(
        plan.transition,
        plan.gitPlan,
      )) {
        const path = isWithin(context.identity.destination, image.path)
          ? join(root, relative(context.identity.destination, image.path))
          : image.path;
        if (
          !unlinkedStoragePath(path) ||
          (await readFile(path, 'utf8')) !== image.contents
        )
          refuse('Git backlink verification failed');
      }
      for (const image of images) {
        for (const [name, expected] of [
          ['workspace.json', image.manifestRaw],
          ['worktrees.json', image.listRaw],
        ] as const) {
          const current = await readNodeW5File(
            join(root, 'workspaces', image.workspaceId, name),
          );
          if ((current.state === 'present' ? current.raw : null) !== expected)
            refuse('Owner projection verification failed');
        }
      }
      await relocateInternalRootJournals(
        plan.transition,
        root,
        host,
        plan.lifecycleJournals ?? [],
        true,
        published,
      );
      if (published)
        await qualifyRelocationGit(git, plan.transition, plan.gitPlan, {
          portableFilesystem: portableGitFilesystem(),
        });
    },
  };
  return {
    ...createInternalRootRepairs(worker),
    inspect: async (
      context: InternalRootRepairContext,
    ): Promise<readonly string[]> => {
      const diagnostics: string[] = [];
      try {
        const plan = await freeze(context, observation, diagnostics);
        await assertRelocationOwnedPathsSafe(
          plan.transition,
          [
            ...ownedPathsForProof(plan),
            ...plan.gitPlan.checkouts.flatMap((row) => [
              row.path,
              row.commonDirectory,
            ]),
          ],
          context.identity.source,
          false,
          { source: true },
        );
        await projectInternalRootMetadata(plan);
      } catch (error) {
        diagnostics.push(
          error instanceof Error
            ? error.message
            : 'Git/owner inspection failed',
        );
      }
      return diagnostics;
    },
  };
}
