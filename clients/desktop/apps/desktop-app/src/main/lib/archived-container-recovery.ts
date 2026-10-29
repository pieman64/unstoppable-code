import {
  assertNoDestructiveRecovery,
  refuseInterruptedArchiveJournal,
} from './w5-destructive-recovery';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  cp,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  readdir,
  rename,
  rm,
} from 'node:fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
  win32,
} from 'node:path';
import type {
  ArchivedContainerRecoveryManifest,
  WorktreeData,
} from '@canopy/desktop-shared/types';
import {
  getArchivedContainerGitStateStagedPath,
  getArchivedContainerRecoveryEvidenceDir,
  getWorkspaceWorktreeDir,
  getArchivedContainersRootDir,
  getArchivedContainerWorkspaceRootDir,
} from './paths';
import {
  isWorkspaceWorktreeCurrent,
  readWorkspaceConfig,
  readWorkspaceWorktrees,
} from './workspace-persistence';
import { archiveGitEnv } from './git-tree-snapshot';
import { getResolvedGitExecutableForSpawn } from './git-executable';
import { validateId } from './validation';
import { getGitCommonDir, removeWindowsWorktreeReparsePoints } from './git';
import { removeTreeWithoutAsar } from './remove-tree-without-asar';
import { isErrnoException, isRecord } from './type-guards';
import { readEffectiveWorkspaceConfig } from './workspace-source';
import {
  readArchivedGitStagedDescriptor,
  renameArchiveQuarantine,
  workspaceRootPayloadDigest,
  writeJsonDurably,
  buildArchivedContainerSnapshotRef,
  assertArchivedGitQuarantineOwned,
} from './archived-container-git';
import {
  restoreArchivedWorkspaceRootPayload,
  type ArchivedWorkspaceRepositoryRelocation,
} from './archived-workspace-root-payload';

type Recovery = ArchivedContainerRecoveryManifest['recovery'];
interface RecoveryRepository {
  referenceRepoPath: string;
  repositoryIdentity: {
    path: string;
    dev: number;
    ino: number;
    birthtimeMs: number;
  } | null;
  relativePath: string;
  worktreePaths: string[];
}
interface RecoveryJournal {
  version: 1;
  createdAt: string;
  phase: 'captured' | 'verified' | 'removed';
  recovery: Recovery;
  sourceDigest?: string;
  identity?: { dev: number; ino: number; birthtimeMs: number };
  repositories?: RecoveryRepository[] | null;
  workspaceRootPayloadDirectories?: string[];
  recoveryEvidenceDirectories?: string[];
}

function isRecovery(value: unknown): value is Recovery {
  return (
    isRecord(value) &&
    value.kind === 'files-only' &&
    (value.source === 'retained' ||
      value.source === 'partial' ||
      value.source === 'absent') &&
    typeof value.digest === 'string' &&
    /^[a-f0-9]{64}$/.test(value.digest) &&
    typeof value.payloadId === 'string' &&
    /^[a-f0-9-]{36}$/.test(value.payloadId) &&
    (value.gitCleanupPending === undefined ||
      typeof value.gitCleanupPending === 'boolean')
  );
}

function isRecoveryIdentity(
  value: unknown,
): value is { dev: number; ino: number; birthtimeMs: number } {
  return (
    isRecord(value) &&
    typeof value.dev === 'number' &&
    typeof value.ino === 'number' &&
    typeof value.birthtimeMs === 'number'
  );
}

function isRecoveryRepository(value: unknown): value is RecoveryRepository {
  const repositoryIdentity =
    value && isRecord(value) ? value.repositoryIdentity : undefined;
  return (
    isRecord(value) &&
    typeof value.referenceRepoPath === 'string' &&
    (value.repositoryIdentity === null ||
      (isRecord(repositoryIdentity) &&
        typeof repositoryIdentity.path === 'string' &&
        typeof repositoryIdentity.dev === 'number' &&
        typeof repositoryIdentity.ino === 'number' &&
        typeof repositoryIdentity.birthtimeMs === 'number')) &&
    typeof value.relativePath === 'string' &&
    Array.isArray(value.worktreePaths) &&
    value.worktreePaths.every((path) => typeof path === 'string')
  );
}

function isRecoveryJournal(value: unknown): value is RecoveryJournal {
  return (
    isRecord(value) &&
    value.version === 1 &&
    typeof value.createdAt === 'string' &&
    (value.phase === 'captured' ||
      value.phase === 'verified' ||
      value.phase === 'removed') &&
    isRecovery(value.recovery) &&
    (value.sourceDigest === undefined ||
      (typeof value.sourceDigest === 'string' &&
        /^[a-f0-9]{64}$/.test(value.sourceDigest))) &&
    (value.identity === undefined || isRecoveryIdentity(value.identity)) &&
    (value.repositories === undefined ||
      value.repositories === null ||
      (Array.isArray(value.repositories) &&
        value.repositories.every(isRecoveryRepository))) &&
    (value.workspaceRootPayloadDirectories === undefined ||
      (Array.isArray(value.workspaceRootPayloadDirectories) &&
        value.workspaceRootPayloadDirectories.every(
          (name) =>
            typeof name === 'string' &&
            /^\.archive-workspace-files-[a-f0-9-]{36}$/.test(name),
        ))) &&
    (value.recoveryEvidenceDirectories === undefined ||
      (Array.isArray(value.recoveryEvidenceDirectories) &&
        value.recoveryEvidenceDirectories.every(
          (name) =>
            typeof name === 'string' &&
            /^\.archive-(?:recovery-previous|git-snapshots|workspace-files)-[a-f0-9-]{36}$/.test(
              name,
            ),
        )))
  );
}

function paths(
  projectId: string,
  worktreeId: string,
): {
  root: string;
  journal: string;
  canonical: string;
  quarantine: string;
} {
  const root = dirname(
    getArchivedContainerGitStateStagedPath(projectId, worktreeId),
  );
  const canonical = resolve(getWorkspaceWorktreeDir(projectId, worktreeId));
  return {
    root,
    journal: join(root, 'recovery.staged.json'),
    canonical,
    quarantine: join(dirname(canonical), `.${worktreeId}.archive-quarantine`),
  };
}

async function statOrAbsent(
  path: string,
): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return null;
    throw error;
  }
}

async function readJournal(path: string): Promise<RecoveryJournal | null> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return null;
    throw error;
  }
  if (!isRecoveryJournal(value)) {
    throw new Error(
      'Invalid archive recovery journal; retained files were preserved.',
    );
  }
  return value;
}

async function assertPayload(
  root: string,
  recovery: Recovery,
): Promise<string> {
  const payload = join(root, 'recovery-files', recovery.payloadId);
  const stats = await lstat(payload);
  if (!stats.isDirectory() || stats.isSymbolicLink())
    throw new Error('Invalid recovery payload directory.');
  if (
    (await workspaceRootPayloadDigest({ rootPath: payload })) !==
    recovery.digest
  ) {
    throw new Error(
      'The retained recovery files failed verification; cleanup was stopped.',
    );
  }
  return payload;
}

async function syncPayload(directory: string): Promise<void> {
  // Coalesce disk flushes without retaining an unbounded number of open files.
  // Drain before descending so nested directories share the same upper bound.
  let pending: Array<Promise<void>> = [];
  const drain = async (): Promise<void> => {
    const results = await Promise.allSettled(pending);
    pending = [];
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  };
  try {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await drain();
        await syncPayload(path);
      } else if (entry.isFile()) {
        pending.push(
          (async (): Promise<void> => {
            const handle = await open(path, 'r');
            try {
              await handle.sync();
            } finally {
              await handle.close();
            }
          })(),
        );
        if (pending.length === 8) await drain();
      }
    }
    await drain();
  } finally {
    // Even a failed batch must release every owned handle before returning.
    await drain();
  }
  await syncDirectory(directory);
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function containedRecoveryPayloadIds(
  root: string,
  journal: RecoveryJournal,
): Promise<Set<string>> {
  const contained = new Set<string>();
  const payload = join(root, 'recovery-files', journal.recovery.payloadId);
  for (const directory of journal.recoveryEvidenceDirectories ?? []) {
    if (!directory.startsWith('.archive-recovery-previous-')) continue;
    for (const entry of await readdir(join(payload, directory), {
      withFileTypes: true,
    })) {
      if (entry.isDirectory() && /^[a-f0-9-]{36}$/.test(entry.name)) {
        contained.add(entry.name);
      }
    }
  }
  return contained;
}

async function removeContainedRootPayloads(
  root: string,
  journal: RecoveryJournal,
): Promise<void> {
  const recoveryFiles = join(root, 'recovery-files');
  const contained = await containedRecoveryPayloadIds(root, journal);
  if (contained.size === 0) return;
  await Promise.all(
    Array.from(contained).map((payloadId) =>
      rm(join(recoveryFiles, payloadId), { recursive: true, force: true }),
    ),
  );
  await syncDirectory(recoveryFiles);
}

export async function readArchivedContainerRecovery(
  projectId: string,
  worktreeId: string,
  worktree: WorktreeData,
): Promise<Recovery | null> {
  const location = paths(projectId, worktreeId);
  const journal = await readJournal(location.journal);
  if (!journal) {
    const git = await readArchivedGitStagedDescriptor(projectId, worktreeId, {
      recoveryOnly: true,
    });
    if (
      git?.teardown &&
      (git.status === 'capturing' ||
        (git.teardown.phase === 'quarantine-pending' &&
          !(await statOrAbsent(location.canonical)) &&
          !(await statOrAbsent(location.quarantine))))
    ) {
      return prepareArchivedContainerRecovery({
        projectId,
        worktreeId,
        worktree,
      });
    }
    return null;
  }
  if (journal.createdAt !== worktree.createdAt)
    throw new Error('Archive recovery belongs to another worktree generation.');
  return prepareArchivedContainerRecovery({ projectId, worktreeId, worktree });
}

/** Read-only legacy admission evidence; never recaptures or rewrites payloads. */
export async function readArchivedContainerRecoveryEvidence(
  projectId: string,
  worktreeId: string,
): Promise<boolean> {
  return (await readJournal(paths(projectId, worktreeId).journal)) !== null;
}

async function captureRecoveryRepositories(args: {
  projectId: string;
  worktreeId: string;
  worktree: WorktreeData;
  staged: Awaited<ReturnType<typeof readArchivedGitStagedDescriptor>>;
}): Promise<RecoveryRepository[] | null> {
  const location = paths(args.projectId, args.worktreeId);
  type RecoveryRepositoryCandidate = {
    repoId: string;
    referenceRepoPath: string;
    relativePath: string;
  };
  const configuredCandidates: RecoveryRepositoryCandidate[] = [];
  try {
    const config = await readWorkspaceConfig(args.projectId);
    if (config.type === 'single-repo') {
      if (config.repoPath) {
        configuredCandidates.push({
          repoId: '__single_repo__',
          referenceRepoPath: config.repoPath,
          relativePath: '.',
        });
      }
    } else {
      const effective = await readEffectiveWorkspaceConfig(
        args.projectId,
        config,
      );
      const includedRepoIds = args.worktree.includedRepoIds
        ? new Set(args.worktree.includedRepoIds)
        : null;
      if (effective.sourceRepoPath) {
        configuredCandidates.push({
          repoId: '__workspace_root__',
          referenceRepoPath: effective.sourceRepoPath,
          relativePath: '.',
        });
      }
      configuredCandidates.push(
        ...effective.repos
          .filter((repo) => !includedRepoIds || includedRepoIds.has(repo.id))
          .map((repo) => ({
            repoId: repo.id,
            referenceRepoPath: repo.repoPath,
            relativePath: `repos/${repo.id}`,
          })),
      );
    }
  } catch {
    // A staged descriptor still provides enough identity to finish recovery.
  }
  const candidateByRepoId = new Map(
    configuredCandidates.map((candidate) => [candidate.repoId, candidate]),
  );
  for (const repository of args.staged?.repositories ?? []) {
    candidateByRepoId.set(repository.repoId, repository);
  }
  const candidates = Array.from(candidateByRepoId.values());
  if (candidates.length === 0) return null;
  const repositories: RecoveryRepository[] = [];
  for (const candidate of candidates) {
    const capturedDeletion = args.staged?.teardown?.branchDeletionTargets?.find(
      (target) => target.repoId === candidate.repoId,
    );
    let repositoryIdentityPath: string | null = capturedDeletion
      ? resolve(capturedDeletion.repositoryIdentity)
      : null;
    if (!repositoryIdentityPath) {
      try {
        repositoryIdentityPath = resolve(
          await getGitCommonDir(candidate.referenceRepoPath),
        );
      } catch {
        repositoryIdentityPath = null;
      }
    }
    let repositoryIdentity: RecoveryRepository['repositoryIdentity'] = null;
    if (repositoryIdentityPath) {
      try {
        const identity = await lstat(repositoryIdentityPath);
        repositoryIdentity = {
          path: repositoryIdentityPath,
          dev: identity.dev,
          ino: identity.ino,
          birthtimeMs: identity.birthtimeMs,
        };
      } catch {
        repositoryIdentity = null;
      }
    }
    repositories.push({
      referenceRepoPath: resolve(candidate.referenceRepoPath),
      repositoryIdentity,
      relativePath: candidate.relativePath,
      worktreePaths: [
        resolve(location.canonical, candidate.relativePath),
        resolve(location.quarantine, candidate.relativePath),
      ],
    });
  }
  return repositories;
}

export function isArchivedRecoveryPathWithinRoot(
  root: string,
  target: string,
): boolean {
  const pathApi =
    process.platform === 'win32' ? win32 : { relative, isAbsolute };
  const relativeTarget = pathApi.relative(root, target);
  return (
    relativeTarget === '' ||
    (relativeTarget !== '..' &&
      !relativeTarget.startsWith(
        `..${process.platform === 'win32' ? '\\' : '/'}`,
      ) &&
      !pathApi.isAbsolute(relativeTarget))
  );
}

async function cleanupGitRegistrations(
  manifest: ArchivedContainerRecoveryManifest,
  journal: RecoveryJournal,
): Promise<boolean> {
  const location = paths(manifest.projectId, manifest.id);
  if (!journal.repositories) return false;
  let pending = false;
  for (const repository of journal.repositories) {
    if (!repository.repositoryIdentity) {
      try {
        const repositoryIdentityPath = resolve(
          await getGitCommonDir(repository.referenceRepoPath),
        );
        const identity = await lstat(repositoryIdentityPath);
        repository.repositoryIdentity = {
          path: repositoryIdentityPath,
          dev: identity.dev,
          ino: identity.ino,
          birthtimeMs: identity.birthtimeMs,
        };
      } catch {
        pending = true;
        continue;
      }
    }
    const git = async (args: string[]): Promise<string> => {
      const { stdout } = await promisify(execFile)(
        await getResolvedGitExecutableForSpawn(),
        args,
        {
          cwd: repository.referenceRepoPath,
          env: archiveGitEnv(),
          timeout: 5_000,
          windowsHide: true,
        },
      );
      return stdout;
    };
    try {
      const currentIdentityPath = resolve(
        await getGitCommonDir(repository.referenceRepoPath),
      );
      const currentIdentity = await lstat(currentIdentityPath);
      if (
        currentIdentityPath !== resolve(repository.repositoryIdentity.path) ||
        currentIdentity.dev !== repository.repositoryIdentity.dev ||
        currentIdentity.ino !== repository.repositoryIdentity.ino ||
        currentIdentity.birthtimeMs !==
          repository.repositoryIdentity.birthtimeMs
      ) {
        pending = true;
        continue;
      }
      const canonicalizePossiblyMissingPath = async (
        pathValue: string,
      ): Promise<string> => {
        let existingAncestor = resolve(pathValue);
        const missingSegments: string[] = [];
        while (true) {
          try {
            return join(await realpath(existingAncestor), ...missingSegments);
          } catch (error) {
            if (!isErrnoException(error) || error.code !== 'ENOENT')
              throw error;
            const parent = dirname(existingAncestor);
            if (parent === existingAncestor) return resolve(pathValue);
            missingSegments.unshift(basename(existingAncestor));
            existingAncestor = parent;
          }
        }
      };
      const registrations = await Promise.all(
        (await git(['worktree', 'list', '--porcelain', '-z']))
          .split('\0')
          .filter((field) => field.startsWith('worktree '))
          .map(async (field) => {
            const path = resolve(field.slice(9));
            return {
              path,
              comparablePath: await canonicalizePossiblyMissingPath(path),
            };
          }),
      );
      for (const target of repository.worktreePaths) {
        const ownedRoot = [location.canonical, location.quarantine].find(
          (root) => {
            const expected = resolve(root, repository.relativePath);
            return (
              isArchivedRecoveryPathWithinRoot(root, expected) &&
              resolve(target) === expected
            );
          },
        );
        if (!ownedRoot) {
          pending = true;
          continue;
        }
        const comparableTarget = await canonicalizePossiblyMissingPath(target);
        const registration = registrations.find(
          (candidate) => candidate.comparablePath === comparableTarget,
        );
        if (!registration) continue;
        // A replacement canonical occupant never inherits old deletion authority.
        if (await statOrAbsent(ownedRoot)) {
          pending = true;
          continue;
        }
        await git([
          'worktree',
          'remove',
          '--force',
          '--force',
          registration.path,
        ]);
      }
    } catch {
      pending = true;
    }
  }
  return pending;
}

/** Capture all bytes, including ignored files, without traversing directory links. */
export async function prepareArchivedContainerRecovery(args: {
  projectId: string;
  worktreeId: string;
  worktree: WorktreeData;
}): Promise<Recovery> {
  const location = paths(args.projectId, args.worktreeId);
  const existing = await readJournal(location.journal);
  if (existing) {
    if (existing.createdAt !== args.worktree.createdAt)
      throw new Error(
        'Archive recovery belongs to another worktree generation.',
      );
    await assertPayload(location.root, existing.recovery);
    await removeContainedRootPayloads(location.root, existing);
    const source = await statOrAbsent(location.canonical);
    if (
      existing.phase !== 'captured' ||
      !source ||
      (await statOrAbsent(location.quarantine))
    )
      return existing.recovery;
    if (
      !existing.identity ||
      source.dev !== existing.identity.dev ||
      source.ino !== existing.identity.ino ||
      source.birthtimeMs !== existing.identity.birthtimeMs
    )
      throw new Error('The recovery source changed identity.');
    if (
      (await workspaceRootPayloadDigest({ rootPath: location.canonical })) ===
      (existing.sourceDigest ?? existing.recovery.digest)
    )
      return existing.recovery;
    // The still-owned checkout changed after a failed move. Capture it afresh,
    // retaining the previous receipt's files as evidence in the new payload.
  }
  // Reuse only the exact journal-owned quarantine. A newer canonical occupant
  // must never inherit deletion authority from an interrupted Git teardown.
  const staged = await readArchivedGitStagedDescriptor(
    args.projectId,
    args.worktreeId,
    { recoveryOnly: true },
  );
  const repositories = await captureRecoveryRepositories({
    projectId: args.projectId,
    worktreeId: args.worktreeId,
    worktree: args.worktree,
    staged,
  });
  const quarantine = await statOrAbsent(location.quarantine);
  let sourcePath = location.canonical;
  if (staged?.teardown) {
    if (
      resolve(staged.teardown.canonicalPath) !== location.canonical ||
      resolve(staged.teardown.quarantinePath) !== location.quarantine ||
      Date.parse(staged.teardown.enteredAt) <
        Date.parse(args.worktree.createdAt)
    ) {
      throw new Error(
        'The interrupted archive belongs to another worktree identity.',
      );
    }
    const canonical = await statOrAbsent(location.canonical);
    if (canonical && (quarantine || staged.teardown.phase === 'verified')) {
      throw new Error(
        'A canonical worktree occupant conflicts with interrupted archive recovery.',
      );
    }
    if (quarantine) {
      await assertArchivedGitQuarantineOwned({
        descriptor: staged,
        quarantinePath: location.quarantine,
      });
    }
    if (quarantine || staged.teardown.phase === 'verified')
      sourcePath = location.quarantine;
  } else if (quarantine) {
    throw new Error('An unowned archive quarantine requires recovery.');
  }
  const source = await statOrAbsent(sourcePath);
  if (source && (!source.isDirectory() || source.isSymbolicLink())) {
    throw new Error('Archive recovery requires the owned worktree directory.');
  }
  if (
    !(await isWorkspaceWorktreeCurrent(
      args.projectId,
      args.worktreeId,
      args.worktree.createdAt,
    ))
  ) {
    throw new Error('The worktree changed before recovery capture.');
  }
  const payloadId = randomUUID();
  const payload = join(location.root, 'recovery-files', payloadId);
  await mkdir(dirname(payload), { recursive: true });
  const previous = (
    await readdir(dirname(payload), { withFileTypes: true })
  ).filter(
    (entry) => entry.isDirectory() && /^[a-f0-9-]{36}$/.test(entry.name),
  );
  const containedPreviousPayloadIds = existing
    ? await containedRecoveryPayloadIds(location.root, existing)
    : new Set<string>();
  const recoveryEvidenceDirectories: string[] = [];
  if (source) {
    await cp(sourcePath, payload, {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
      errorOnExist: true,
      force: false,
    });
  } else await mkdir(payload);
  const sourceDigest = await workspaceRootPayloadDigest({ rootPath: payload });
  if (
    !sourceDigest ||
    (source &&
      sourceDigest !==
        (await workspaceRootPayloadDigest({ rootPath: sourcePath })))
  ) {
    throw new Error(
      'The worktree changed during recovery capture; its files were preserved.',
    );
  }
  // A crash during an earlier copy may leave the only surviving bytes here.
  // Fold those incomplete copies into this receipt instead of orphaning them.
  if (previous.length > 0) {
    const evidenceDirectory = `.archive-recovery-previous-${randomUUID()}`;
    const evidence = join(payload, evidenceDirectory);
    recoveryEvidenceDirectories.push(evidenceDirectory);
    await mkdir(evidence);
    for (const entry of previous) {
      const from = join(dirname(payload), entry.name);
      const to = join(evidence, entry.name);
      if (
        entry.name !== existing?.recovery.payloadId &&
        containedPreviousPayloadIds.has(entry.name)
      ) {
        continue;
      }
      if (entry.name === existing?.recovery.payloadId) {
        await cp(from, to, {
          recursive: true,
          dereference: false,
          verbatimSymlinks: true,
          errorOnExist: true,
          force: false,
        });
      } else await rename(from, to);
    }
  }
  const previousRoot = getArchivedContainerWorkspaceRootDir(
    args.projectId,
    args.worktreeId,
  );
  const previousRootStats = await statOrAbsent(previousRoot);
  const workspaceRootPayloadDirectories: string[] = [];
  if (previousRootStats) {
    if (!previousRootStats.isDirectory() || previousRootStats.isSymbolicLink())
      throw new Error('Invalid retained workspace files.');
    const workspaceRootPayloadDirectory = `.archive-workspace-files-${randomUUID()}`;
    await cp(previousRoot, join(payload, workspaceRootPayloadDirectory), {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
      errorOnExist: true,
      force: false,
    });
    if (source) {
      // A complete source is the newest coherent capture. Keep an earlier
      // root payload as archive evidence instead of merging it back over the
      // restored checkout or duplicating repositories under collision names.
      recoveryEvidenceDirectories.push(workspaceRootPayloadDirectory);
    } else {
      workspaceRootPayloadDirectories.push(workspaceRootPayloadDirectory);
    }
  }
  if (staged?.repositories.length) {
    const evidenceDirectory = `.archive-git-snapshots-${randomUUID()}`;
    const evidence = join(payload, evidenceDirectory);
    recoveryEvidenceDirectories.push(evidenceDirectory);
    await mkdir(evidence);
    const bundles: Array<{ repoId: string; file: string }> = [];
    for (const repository of staged.repositories) {
      if (
        repository.snapshotRef !==
        buildArchivedContainerSnapshotRef(
          args.projectId,
          args.worktreeId,
          repository.repoId,
        )
      ) {
        throw new Error(
          'The retained Git snapshot does not belong to this archive.',
        );
      }
      const file = `${randomUUID()}.bundle`;
      const git = async (args: string[]): Promise<string> => {
        const { stdout } = await promisify(execFile)(
          await getResolvedGitExecutableForSpawn(),
          args,
          {
            cwd: repository.referenceRepoPath,
            env: archiveGitEnv(),
            timeout: 30_000,
            windowsHide: true,
          },
        );
        return stdout.trim();
      };
      try {
        if (
          (await git(['rev-parse', '--verify', repository.snapshotRef])) !==
          repository.worktreeSnapshotCommit
        ) {
          continue;
        }
        await git([
          'bundle',
          'create',
          join(evidence, file),
          repository.snapshotRef,
        ]);
        const retainedHead = await git([
          'bundle',
          'list-heads',
          join(evidence, file),
          repository.snapshotRef,
        ]);
        if (
          retainedHead !==
          `${repository.worktreeSnapshotCommit} ${repository.snapshotRef}`
        ) {
          await rm(join(evidence, file), { force: true });
          continue;
        }
        bundles.push({ repoId: repository.repoId, file });
      } catch {
        // Files-only recovery remains valid when its optional Git evidence is
        // unavailable; the staged descriptor retains cleanup ownership.
        await rm(join(evidence, file), { force: true }).catch(() => undefined);
      }
    }
    await writeJsonDurably(join(evidence, 'snapshots.json'), {
      version: 1,
      descriptor: staged,
      bundles,
    });
  }
  const digest = await workspaceRootPayloadDigest({ rootPath: payload });
  if (!digest)
    throw new Error('Recovery payload disappeared before publication.');
  const recovery: Recovery = {
    kind: 'files-only',
    source:
      staged?.teardown || (!source && (previous.length || previousRootStats))
        ? 'partial'
        : source
          ? 'retained'
          : 'absent',
    digest,
    payloadId,
  };
  await syncPayload(payload);
  await syncDirectory(dirname(payload));
  await writeJsonDurably(location.journal, {
    version: 1,
    createdAt: args.worktree.createdAt,
    phase: 'captured',
    recovery,
    sourceDigest,
    repositories,
    workspaceRootPayloadDirectories,
    recoveryEvidenceDirectories,
    ...(source
      ? {
          identity: {
            dev: source.dev,
            ino: source.ino,
            birthtimeMs: source.birthtimeMs,
          },
        }
      : {}),
  });
  await Promise.all(
    previous.map((entry) =>
      rm(join(dirname(payload), entry.name), { recursive: true, force: true }),
    ),
  );
  await syncDirectory(dirname(payload));
  return recovery;
}

/** The live row remains the cleanup owner until the quarantine is actually gone. */
export async function finishArchivedContainerRecovery(
  manifest: ArchivedContainerRecoveryManifest,
): Promise<string[]> {
  const location = paths(manifest.projectId, manifest.id);
  let journal = await readJournal(location.journal);
  if (
    !journal ||
    journal.createdAt !== manifest.createdAt ||
    journal.recovery.payloadId !== manifest.recovery.payloadId
  )
    throw new Error('Archive recovery identity changed.');
  await assertPayload(location.root, journal.recovery);
  if (journal.phase === 'captured') {
    const source = await statOrAbsent(location.canonical);
    const quarantine = await statOrAbsent(location.quarantine);
    if (source && quarantine)
      throw new Error('Archive recovery quarantine is occupied.');
    if (journal.identity) {
      const current = source ?? quarantine;
      if (
        current &&
        (!journal.identity ||
          current.dev !== journal.identity.dev ||
          current.ino !== journal.identity.ino ||
          current.birthtimeMs !== journal.identity.birthtimeMs ||
          current.isSymbolicLink())
      )
        throw new Error('The worktree changed identity during recovery.');
      if (
        current &&
        (await workspaceRootPayloadDigest({
          rootPath: source ? location.canonical : location.quarantine,
        })) !== (journal.sourceDigest ?? journal.recovery.digest)
      ) {
        throw new Error(
          'The worktree changed after recovery capture; its files were preserved.',
        );
      }
      if (source)
        await renameArchiveQuarantine(location.canonical, location.quarantine);
      if (
        current &&
        (await workspaceRootPayloadDigest({
          rootPath: location.quarantine,
        })) !== (journal.sourceDigest ?? journal.recovery.digest)
      ) {
        throw new Error(
          'The quarantined recovery files changed; cleanup was stopped.',
        );
      }
    } else if (source || quarantine)
      throw new Error(
        'A new occupant appeared after the absent-worktree capture.',
      );
    journal = { ...journal, phase: 'verified' };
    await writeJsonDurably(location.journal, journal);
  }
  // Never remove the canonical path here: a retry may find a new occupant there.
  if (journal.phase !== 'removed') {
    const remaining = await statOrAbsent(location.quarantine);
    if (
      remaining &&
      (!journal.identity ||
        remaining.dev !== journal.identity.dev ||
        remaining.ino !== journal.identity.ino ||
        remaining.birthtimeMs !== journal.identity.birthtimeMs ||
        remaining.isSymbolicLink())
    ) {
      throw new Error(
        'Archive recovery quarantine changed identity; cleanup was stopped.',
      );
    }
    await removeWindowsWorktreeReparsePoints(location.quarantine);
    await removeTreeWithoutAsar(location.quarantine, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
    journal = { ...journal, phase: 'removed' };
    await writeJsonDurably(location.journal, journal);
  }
  const gitCleanupPending = await cleanupGitRegistrations(manifest, journal);
  manifest.recovery = { ...manifest.recovery, gitCleanupPending };
  await writeJsonDurably(location.journal, {
    ...journal,
    recovery: manifest.recovery,
  });
  return [
    'Recovered remaining files without Git history or staging. Branches were preserved.',
    ...(gitCleanupPending
      ? [
          'Git registration cleanup remains pending and will be retried when the source repository is available.',
        ]
      : []),
  ];
}

export async function recoverArchivedFileTeardownsForWorkspace(
  projectId: string,
): Promise<void> {
  let entries;
  try {
    entries = await readdir(getArchivedContainersRootDir(projectId), {
      withFileTypes: true,
    });
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      validateId(entry.name, 'containerId');
      await assertNoDestructiveRecovery(projectId, entry.name, true);
      const journal = await readJournal(paths(projectId, entry.name).journal);
      if (!journal) continue;
      await refuseInterruptedArchiveJournal(
        projectId,
        entry.name,
        'legacy-journal',
      );
      const current = (await readWorkspaceWorktrees(projectId)).find(
        (worktree) => worktree.id === entry.name,
      );
      if (current?.createdAt === journal.createdAt) {
        // Enter through the normal chat/activity/workspace lock order. Never
        // acquire the workspace lock before asking the chat lifecycle to drain.
        const config = await readWorkspaceConfig(projectId);
        // Intentional local import breaks the recovery/service initialization
        // cycle; build:e2e verifies this module resolves in packaged bytecode.
        const service = await import('./worktree-service');
        const options = {
          workspaceId: projectId,
          worktreeId: entry.name,
          expectedCreatedAt: current.createdAt,
          deleteBranch: false,
          observabilityMode: 'live-service' as const,
          liveServices: {
            cleanupLiveState: async (
              workspaceId: string,
              worktreeId: string,
              onDestroyed?: () => void,
            ): Promise<void> =>
              // Intentional local import avoids loading live cleanup while the
              // recovery graph initializes; build:e2e verifies packaged resolution.
              (
                await import('./worktree-live-cleanup')
              ).cleanupLiveWorktreeState(workspaceId, worktreeId, onDestroyed),
            purgeObservabilityData: async (
              workspaceId: string,
              worktreeId: string,
            ): Promise<void> =>
              // See the paired cleanup import above; keep this boundary local.
              (
                await import('./worktree-live-cleanup')
              ).purgeLiveWorktreeObservabilityData(workspaceId, worktreeId),
          },
        };
        if (config.type === 'single-repo')
          await service.archiveSingleRepoWorktree(options);
        else if (config.type === 'multi-repo')
          await service.archiveMultiRepoWorktree(options);
      } else {
        // Intentional local import breaks the archive/recovery initialization
        // cycle; build:e2e verifies this module resolves in packaged bytecode.
        const archives = await import('./archived-containers');
        await archives.withArchivedContainerOperationLock(
          projectId,
          entry.name,
          async () => {
            const manifest = await archives.readArchivedContainerManifest(
              projectId,
              entry.name,
            );
            if (manifest.version === 3 && manifest.recovery.gitCleanupPending) {
              await finishArchivedContainerRecovery(manifest);
              await archives.commitArchivedContainer(manifest);
            }
          },
        );
      }
    } catch {
      // The journal and live/archived row keep ownership for a later retry.
    }
  }
}

export async function restoreArchivedRecoveryFiles(
  manifest: ArchivedContainerRecoveryManifest,
  destination: string,
): Promise<void> {
  const location = paths(manifest.projectId, manifest.id);
  const payload = await assertPayload(location.root, manifest.recovery);
  const journal = await readJournal(location.journal);
  if (
    !journal ||
    journal.createdAt !== manifest.createdAt ||
    journal.recovery.payloadId !== manifest.recovery.payloadId
  ) {
    throw new Error('Archive recovery identity changed.');
  }
  const restoredWorktreeId = basename(resolve(destination));
  const evidenceRoot = getArchivedContainerRecoveryEvidenceDir(
    manifest.projectId,
    restoredWorktreeId,
    manifest.id,
  );
  // A staged restore retry reuses the same destination generation. Remove
  // evidence left by an interrupted attempt before installing it again.
  await rm(evidenceRoot, { recursive: true, force: true });
  const recoveryEvidence = join(evidenceRoot, 'restored-recovery-evidence');
  for (const name of journal.recoveryEvidenceDirectories ?? []) {
    const source = join(payload, name);
    const stats = await lstat(source);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error('Invalid retained recovery evidence.');
    }
    await mkdir(recoveryEvidence, { recursive: true });
    await cp(source, join(recoveryEvidence, name), {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
      errorOnExist: true,
      force: false,
    });
  }
  const recoveryEvidenceDirectories = journal.recoveryEvidenceDirectories ?? [];
  await cp(payload, destination, {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
    errorOnExist: true,
    force: false,
    filter: (source): boolean => {
      const relativeSource = relative(payload, source);
      if (relativeSource === '') return true;
      for (const name of recoveryEvidenceDirectories) {
        if (
          relativeSource === name ||
          relativeSource.startsWith(`${name}${sep}`)
        ) {
          return false;
        }
      }
      return true;
    },
  });
  // Linked .git pointers are host-specific evidence, not a portable repository.
  // Retain their exact bytes in worktree-owned metadata, never in the restored
  // checkout where internal recovery state could appear in Git status. Normal
  // worktree metadata cleanup removes this evidence with the destination.
  const evidence = join(evidenceRoot, 'restored-git-evidence');
  const walk = async (
    directory: string,
    relativeDirectory: string,
  ): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.name === '.git') {
        const saved = join(evidence, relativeDirectory, '.git');
        await mkdir(dirname(saved), { recursive: true });
        await rename(path, saved);
      } else if (entry.isDirectory()) {
        await walk(path, join(relativeDirectory, entry.name));
      }
    }
  };
  await walk(destination, '');
}

export async function restoreArchivedRecoveryWorkspaceRootFiles(
  manifest: ArchivedContainerRecoveryManifest,
  destination: string,
): Promise<ArchivedWorkspaceRepositoryRelocation[]> {
  const location = paths(manifest.projectId, manifest.id);
  const journal = await readJournal(location.journal);
  if (
    !journal ||
    journal.createdAt !== manifest.createdAt ||
    journal.recovery.payloadId !== manifest.recovery.payloadId
  ) {
    throw new Error('Archive recovery identity changed.');
  }
  const relocations: ArchivedWorkspaceRepositoryRelocation[] = [];
  for (const name of journal.workspaceRootPayloadDirectories ?? []) {
    const source = join(destination, name);
    const stats = await lstat(source);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error('Invalid retained workspace files.');
    }
    relocations.push(
      ...(await restoreArchivedWorkspaceRootPayload({ source, destination })),
    );
    await rm(source, { recursive: true, force: false });
  }
  return relocations;
}
