import { lstat, readlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import type {
  PersistedChatMessage,
  SharedContainerFileScope,
  SharedContainerPreviewRequest,
  SharedContainerSharePreview,
} from '@canopy/desktop-shared/types';
import { fileScopeIsAllowlist } from '@canopy/desktop-shared/lib/shared-container-scope-mode';
import {
  MAX_SHARED_CONTAINER_ARTIFACT_BYTES,
  MAX_SHARED_CONTAINER_ARTIFACTS_PER_REVISION,
  MAX_SHARED_CONTAINER_REVISION_BYTES,
} from '@canopy/protocol/shared-containers';
import { mapWithConcurrency } from '../lib/concurrency';
import {
  WORKTREE_GIT_TIMEOUT_MS,
  classifySharedContainerSymlinkTarget,
  getChangedFilesList,
  getHeadCommitSha,
  getRemoteUrl,
  inspectRepositoryTreeEntryKinds,
  listUntrackedFiles,
  listWorkingTreeDiffAgainstCommit,
} from '../lib/git';
import { sanitizeRemoteUrl } from '../lib/plan-share-repos';
import { listTrackedPlans } from '../lib/plan-persistence';
import { readChatTabsFileForIndex } from '../lib/chat-tabs-reader';
import { isCoworkWorkspace } from '../lib/workspace-registry';
import { listNotes, listPrompts } from '../lib/standalone-workspace-files';
import {
  listWorkspaceNotes,
  listWorkspacePrompts,
} from '../lib/workspace-items';
import { readSharedContainerFileScope } from './file-scope-store';
import {
  listSharedContainerLocalRepositories,
  type SharedContainerLocalRepository,
} from './local-repositories';
import { parseGitHubRemote } from './materialize/code';
import {
  listAttachments,
  listCoworkReferencedAttachmentFiles,
  measureCoworkRevisionBaseBytes,
} from './publish/inventory';
import { isCredentialShapedSharedContainerPath } from './publish/code-inventory';
import {
  listCoworkCandidateFiles,
  selectCoworkCandidatePaths,
  selectSharedContainerCandidatePaths,
  type CoworkCandidateFiles,
} from './publish/cowork-files';
import {
  getCoworkCandidateRevisionByteCosts,
  getCoworkWithheldFileCountRevisionByteCost,
} from './publish/cowork-artifacts';
import {
  deriveSharedContainerRunConfig,
  getCodeCandidateRevisionByteCosts,
  listSharedContainerRunScriptCandidates,
  measureCodeRevisionBaseBytes,
} from './publish/code-inventory';
import { getFeatureFlagService } from '../feature-flags';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { resolveSharedContainerPushedBase } from './pushed-base';
import { buildSharedContainerCodeSnapshot } from './publish/code-snapshot';
import { isSharedContainerRunPublishingEnabled } from './run/availability';
import { resolveProjectStartPage } from '../lib/project-start-page';
import { findStartPageRepository } from './publish/start-page';

const MAX_SHARED_CONTAINER_FILE_PATHS = 200;
const SHARED_CONTAINER_REPOSITORY_CONCURRENCY = 4;

export interface SharedContainerPreviewDependencies {
  countChats: (projectId: string, worktreeId: string) => Promise<number>;
  countPlans: (projectId: string, worktreeId: string) => Promise<number>;
  countAttachments: (
    projectId: string,
    worktreeId: string,
    containerType: SharedContainerPreviewRequest['containerType'],
  ) => Promise<number>;
  resolveRepositories: (
    projectId: string,
    worktreeId: string,
  ) => Promise<SharedContainerLocalRepository[]>;
  getRemoteUrl: (path: string) => Promise<string | null>;
  getHeadCommitSha: (path: string) => Promise<string | null>;
  getChangedFiles: (
    path: string,
    baseCommitSha?: string,
  ) => Promise<Array<{ path: string; status?: string }>>;
  listUntrackedFiles: (path: string) => Promise<string[]>;
  inspectTreeEntries?: (
    path: string,
  ) => ReturnType<typeof inspectRepositoryTreeEntryKinds>;
  inspectFile?: (
    repoPath: string,
    relativePath: string,
  ) => Promise<{
    isRegularFile: boolean;
    isSymbolicLink?: boolean;
    symlinkTarget?: string;
    hardLinked: boolean;
    sizeBytes: number;
    mtimeMs?: number;
  }>;
  listReferencedPaths?: (
    projectId: string,
    worktreeId: string,
  ) => Promise<string[]>;
  readApprovedFileScope: (
    projectId: string,
    worktreeId: string,
  ) => Promise<SharedContainerFileScope>;
  listWorkspaceItems?: (
    projectId: string,
    worktreeId: string,
    containerType: SharedContainerPreviewRequest['containerType'],
  ) => Promise<{
    notes: Array<{ id: string; title: string }>;
    prompts: Array<{ id: string; title: string }>;
  }>;
  listCoworkCandidateFiles?: (
    projectId: string,
    worktreeId: string,
    requiredPaths?: readonly string[],
  ) => Promise<CoworkCandidateFiles | string[]>;
  measureCoworkRevisionBaseBytes?: (
    projectId: string,
    worktreeId: string,
    scope: SharedContainerFileScope,
  ) => Promise<number>;
  measureCodeRevisionBaseBytes?: (
    projectId: string,
    worktreeId: string,
    scope: SharedContainerFileScope,
    run: SharedContainerSharePreview['run'] | undefined,
  ) => Promise<number>;
  isRunEnabled?: () => boolean;
  resolvePushedBase?: typeof resolveSharedContainerPushedBase;
  buildSnapshot?: typeof buildSharedContainerCodeSnapshot;
  resolveStartPage?: typeof resolveProjectStartPage;
}

async function inspectPreviewFile(
  repoPath: string,
  relativePath: string,
): Promise<{
  isRegularFile: boolean;
  isSymbolicLink?: boolean;
  symlinkTarget?: string;
  hardLinked: boolean;
  sizeBytes: number;
  mtimeMs: number;
}> {
  try {
    const absolutePath = resolve(repoPath, ...relativePath.split('/'));
    const info = await lstat(absolutePath);
    const isSymbolicLink = info.isSymbolicLink();
    return {
      isRegularFile: info.isFile() && !info.isSymbolicLink(),
      isSymbolicLink,
      ...(isSymbolicLink
        ? { symlinkTarget: await readlink(absolutePath) }
        : {}),
      hardLinked: info.nlink > 1,
      sizeBytes: info.size,
      mtimeMs: info.mtimeMs,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        isRegularFile: false,
        isSymbolicLink: false,
        hardLinked: false,
        sizeBytes: 0,
        mtimeMs: 0,
      };
    }
    throw error;
  }
}

/** Preview scans keep one complete row at a time and leave artifact bodies
 * deferred. The native metadata index deliberately has no messages array. */
async function visitPreviewMessages(
  projectId: string,
  worktreeId: string,
  visit: (message: PersistedChatMessage) => void,
): Promise<void> {
  const metadata = await readChatTabsFileForIndex(projectId, worktreeId);
  // Defer the heavy state service until canonical preview rows are visited.
  const { getChatStateService } =
    await import('../services/chat-state-service');
  for (const tab of metadata.tabs) {
    if (tab.kind === 'file') continue;
    await getChatStateService().consumeTranscript(
      { projectId, worktreeId },
      tab.id,
      false,
      async (rows) => {
        for await (const message of rows) visit(message);
      },
      { inlineDelegationChildren: true },
    );
  }
}

async function listPreviewWorkspaceItems(
  projectId: string,
  worktreeId: string,
  containerType: SharedContainerPreviewRequest['containerType'],
): Promise<{
  notes: Array<{ id: string; title: string }>;
  prompts: Array<{ id: string; title: string }>;
}> {
  if (containerType === 'COWORK_WORK_ENTRY' || isCoworkWorkspace(projectId)) {
    const [notes, prompts] = await Promise.all([
      listNotes(projectId),
      listPrompts(projectId),
    ]);
    return {
      notes: notes.map(({ id, title }) => ({ id, title })),
      prompts: prompts.map(({ id, title }) => ({ id, title })),
    };
  }
  const [notes, prompts] = await Promise.all([
    listWorkspaceNotes(projectId),
    listWorkspacePrompts(projectId),
  ]);
  return {
    notes: notes
      .filter((item) => item.origin?.worktreeId === worktreeId)
      .map(({ id, title }) => ({ id, title })),
    prompts: prompts
      .filter((item) => item.origin?.worktreeId === worktreeId)
      .map(({ id, title }) => ({ id, title })),
  };
}

async function countChats(
  projectId: string,
  worktreeId: string,
): Promise<number> {
  const metadata = await readChatTabsFileForIndex(projectId, worktreeId);
  return metadata.tabs.filter((tab) => tab.kind !== 'file').length;
}

async function countPlans(
  projectId: string,
  worktreeId: string,
): Promise<number> {
  try {
    return (await listTrackedPlans(projectId, worktreeId)).filter(
      (plan) => !plan.hidden,
    ).length;
  } catch {
    return 0;
  }
}

async function countAttachments(
  projectId: string,
  worktreeId: string,
  containerType: SharedContainerPreviewRequest['containerType'],
): Promise<number> {
  const paths = new Set<string>();
  await visitPreviewMessages(projectId, worktreeId, (message) => {
    for (const path of message.attachmentPaths ?? []) paths.add(path);
  });
  const sourcePaths = Array.from(paths).sort();
  if (containerType === 'COWORK_WORK_ENTRY' || isCoworkWorkspace(projectId)) {
    return (
      await listCoworkReferencedAttachmentFiles(
        projectId,
        worktreeId,
        sourcePaths,
      )
    ).length;
  }
  const attachments = await listAttachments(projectId, worktreeId, sourcePaths);
  return new Set(
    attachments.map(
      (attachment) =>
        attachment.source?.hash ??
        attachment.sourcePath ??
        attachment.displayName,
    ),
  ).size;
}

function collectPreviewReferencedStrings(
  value: unknown,
  output: Set<string>,
): void {
  if (typeof value === 'string') {
    output.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectPreviewReferencedStrings(item, output);
    return;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) {
      collectPreviewReferencedStrings(item, output);
    }
  }
}

async function listPreviewReferencedPaths(
  projectId: string,
  worktreeId: string,
): Promise<string[]> {
  const referenced = new Set<string>();
  await visitPreviewMessages(projectId, worktreeId, (message) => {
    collectPreviewReferencedStrings(message, referenced);
  });
  return Array.from(referenced);
}

const DEFAULT_DEPENDENCIES: SharedContainerPreviewDependencies = {
  countChats,
  countPlans,
  countAttachments,
  resolveRepositories: listSharedContainerLocalRepositories,
  getRemoteUrl,
  getHeadCommitSha,
  getChangedFiles: (path, baseCommitSha) =>
    baseCommitSha
      ? listWorkingTreeDiffAgainstCommit(path, baseCommitSha, {
          timeoutMs: WORKTREE_GIT_TIMEOUT_MS,
          signal: AbortSignal.timeout(WORKTREE_GIT_TIMEOUT_MS),
        })
      : getChangedFilesList(path),
  listUntrackedFiles,
  inspectTreeEntries: (path) =>
    inspectRepositoryTreeEntryKinds(path, {
      timeoutMs: WORKTREE_GIT_TIMEOUT_MS,
      signal: AbortSignal.timeout(WORKTREE_GIT_TIMEOUT_MS),
    }),
  inspectFile: inspectPreviewFile,
  listReferencedPaths: listPreviewReferencedPaths,
  readApprovedFileScope: readSharedContainerFileScope,
  listWorkspaceItems: listPreviewWorkspaceItems,
  listCoworkCandidateFiles,
  measureCoworkRevisionBaseBytes: (projectId, worktreeId, scope) =>
    measureCoworkRevisionBaseBytes({ projectId, worktreeId, scope }),
  measureCodeRevisionBaseBytes: (projectId, worktreeId, scope, run) =>
    measureCodeRevisionBaseBytes({ projectId, worktreeId, scope, run }),
  isRunEnabled: () =>
    isSharedContainerRunPublishingEnabled(
      getFeatureFlagService().isEnabled(
        CLIENT_FEATURE_FLAGS.canopyDesktopSharedContainers.key,
      ),
    ),
  resolvePushedBase: resolveSharedContainerPushedBase,
  buildSnapshot: buildSharedContainerCodeSnapshot,
  resolveStartPage: resolveProjectStartPage,
};

export async function listSharedContainerUntrackedCandidatePaths(
  projectId: string,
  worktreeId: string,
  deps: Pick<
    SharedContainerPreviewDependencies,
    'resolveRepositories' | 'listUntrackedFiles'
  > = DEFAULT_DEPENDENCIES,
): Promise<string[]> {
  const repositories = await deps.resolveRepositories(projectId, worktreeId);
  const candidatesByRepository = await mapWithConcurrency(
    repositories,
    SHARED_CONTAINER_REPOSITORY_CONCURRENCY,
    async (repository) => ({
      repository,
      paths: await deps.listUntrackedFiles(repository.repoPath),
    }),
  );
  return candidatesByRepository.flatMap(({ repository, paths }) =>
    paths.map((path) =>
      (repository.relativePrefix
        ? `${repository.relativePrefix}/${path}`
        : path
      ).normalize('NFC'),
    ),
  );
}

export async function buildSharedContainerSharePreview(
  request: SharedContainerPreviewRequest,
  deps: SharedContainerPreviewDependencies = DEFAULT_DEPENDENCIES,
): Promise<SharedContainerSharePreview> {
  const [
    chatCount,
    planCount,
    attachmentCount,
    approvedFileScope,
    workspaceItems,
    resolvedStartPage,
  ] = await Promise.all([
    deps.countChats(request.projectId, request.worktreeId),
    deps.countPlans(request.projectId, request.worktreeId),
    deps.countAttachments(
      request.projectId,
      request.worktreeId,
      request.containerType,
    ),
    deps.readApprovedFileScope(request.projectId, request.worktreeId),
    deps.listWorkspaceItems?.(
      request.projectId,
      request.worktreeId,
      request.containerType,
    ) ?? Promise.resolve({ notes: [], prompts: [] }),
    deps.resolveStartPage?.({
      projectId: request.projectId,
      worktreeId: request.worktreeId,
    }) ?? Promise.resolve(null),
  ]);
  // Notes and prompts are included unless the owner excluded them, so the
  // budget counts the resolved set rather than every row offered in the picker.
  // `noteCount`/`promptCount` keep their picker semantics.
  const excludedNoteIds = new Set(approvedFileScope.excludedNoteIds ?? []);
  const excludedPromptIds = new Set(approvedFileScope.excludedPromptIds ?? []);
  const selectedNoteCount = workspaceItems.notes.filter(
    (note) => !excludedNoteIds.has(note.id),
  ).length;
  const selectedPromptCount = workspaceItems.prompts.filter(
    (prompt) => !excludedPromptIds.has(prompt.id),
  ).length;
  const base = {
    containerType: request.containerType,
    chatCount,
    planCount,
    attachmentCount,
    noteCount: workspaceItems.notes.length,
    promptCount: workspaceItems.prompts.length,
    notes: workspaceItems.notes,
    prompts: workspaceItems.prompts,
    startPage: null,
    dirtyFileCount: 0,
    untrackedCandidates: [] as string[],
    untrackedCandidateCount: 0,
    approvedFileScope,
    artifactBudget: {
      used:
        1 +
        chatCount +
        planCount +
        attachmentCount +
        selectedNoteCount +
        selectedPromptCount,
      limit: MAX_SHARED_CONTAINER_ARTIFACTS_PER_REVISION,
    },
  };
  if (request.containerType !== 'CODE_WORKTREE') {
    let candidateResult: CoworkCandidateFiles = {
      paths: [],
      withheldFileCount: 0,
    };
    // Custom preview dependencies used by focused tests may omit the byte
    // measurement seam. Reserve one maximum-sized manifest in that case; the
    // production dependency measures the real serialized non-file revision.
    let baseRevisionBytes = MAX_SHARED_CONTAINER_ARTIFACT_BYTES;
    try {
      baseRevisionBytes =
        (await deps.measureCoworkRevisionBaseBytes?.(
          request.projectId,
          request.worktreeId,
          approvedFileScope,
        )) ?? baseRevisionBytes;
    } catch {
      // Byte measurement is a preview hint. Publication repeats it from the
      // opened sources and remains authoritative if the workspace changes.
    }
    try {
      const legacyAllowlist = fileScopeIsAllowlist(
        request.containerType,
        approvedFileScope,
      );
      const listed = await deps.listCoworkCandidateFiles?.(
        request.projectId,
        request.worktreeId,
        legacyAllowlist ? approvedFileScope.includedPaths : [],
      );
      if (Array.isArray(listed)) candidateResult.paths = listed;
      else if (listed) candidateResult = listed;
    } catch {
      // File discovery is a non-gating preview hint. The remaining share
      // summary must still render if the workspace changes or becomes unreadable.
    }
    const baseArtifactCount = base.artifactBudget.used - planCount;
    const remainingArtifactBudget = Math.max(
      0,
      MAX_SHARED_CONTAINER_ARTIFACTS_PER_REVISION - baseArtifactCount,
    );
    const defaultIncludedFilePaths = selectCoworkCandidatePaths(
      candidateResult.paths,
      approvedFileScope,
      remainingArtifactBudget,
      getCoworkCandidateRevisionByteCosts(
        candidateResult.paths,
        candidateResult.sizeBytesByPath,
      ),
      Math.max(
        0,
        MAX_SHARED_CONTAINER_REVISION_BYTES -
          baseRevisionBytes -
          getCoworkWithheldFileCountRevisionByteCost(
            candidateResult.withheldFileCount,
          ),
      ),
    );
    // The renderer re-derives the selection from this bounded list so a tick
    // lands without a round trip, but the selection itself is drawn from the
    // unbounded one. Leading with the paths already selected keeps the two
    // derivations identical: the cap is below the list bound, so every
    // selected path survives truncation, and the ranked remainder follows so
    // an untick promotes the same next file main would.
    const defaultIncludedFileSet = new Set(defaultIncludedFilePaths);
    const rankedCandidates = [
      ...defaultIncludedFilePaths,
      ...candidateResult.paths.filter(
        (path) => !defaultIncludedFileSet.has(path),
      ),
    ];
    return {
      ...base,
      startPage: resolvedStartPage
        ? resolvedStartPage.startPage.kind === 'url'
          ? { label: resolvedStartPage.startPage.url, status: 'url' }
          : {
              label: resolvedStartPage.startPage.path,
              status: defaultIncludedFileSet.has(
                resolvedStartPage.startPage.path,
              )
                ? 'included'
                : 'withheld',
            }
        : null,
      planCount: 0,
      artifactBudget: {
        ...base.artifactBudget,
        used: baseArtifactCount + defaultIncludedFilePaths.length,
      },
      untrackedCandidates: rankedCandidates.slice(
        0,
        MAX_SHARED_CONTAINER_FILE_PATHS,
      ),
      untrackedCandidateCount: candidateResult.paths.length,
      defaultIncludedFilePaths,
      ...(candidateResult.withheldFileCount > 0
        ? { withheldFileCount: candidateResult.withheldFileCount }
        : {}),
    };
  }

  const repositories = await deps.resolveRepositories(
    request.projectId,
    request.worktreeId,
  );
  const repositoryPreviews = await mapWithConcurrency(
    repositories,
    SHARED_CONTAINER_REPOSITORY_CONCURRENCY,
    async (repository) => {
      const [rawRemoteUrl, headSha, untrackedCandidates] = await Promise.all([
        deps.getRemoteUrl(repository.repoPath),
        deps.getHeadCommitSha(repository.repoPath),
        deps.listUntrackedFiles(repository.repoPath),
      ]);
      const remoteUrl = sanitizeRemoteUrl(rawRemoteUrl);
      const pushedBase =
        remoteUrl && parseGitHubRemote(remoteUrl) && headSha
          ? await (deps.resolvePushedBase?.({
              projectId: request.projectId,
              worktreeId: request.worktreeId,
              repoId: repository.repoId,
              repoPath: repository.repoPath,
              // A preview must not wait on `ls-remote`, which can sit on a
              // credential helper for 30 s per repository. Publication
              // resolves the base again with the remote and stays authoritative.
              allowRemoteLookup: false,
            }) ??
              Promise.resolve({
                baseSha: headSha,
                headSha,
                unpushedCommitCount: 0,
              }))
          : null;
      const snapshot = pushedBase
        ? undefined
        : await deps.buildSnapshot?.({
            repoPath: repository.repoPath,
            headSha,
            includeChunkSources: false,
          });
      const changedFiles = await deps.getChangedFiles(
        repository.repoPath,
        pushedBase?.baseSha,
      );
      const treeEntries = pushedBase
        ? await (deps.inspectTreeEntries?.(repository.repoPath) ??
            Promise.resolve([]))
        : [];
      return {
        repository,
        remoteUrl,
        headSha,
        baseCommitSha: pushedBase?.baseSha,
        unpushedCommitCount: pushedBase?.unpushedCommitCount ?? 0,
        snapshot: pushedBase
          ? undefined
          : (snapshot ?? {
              baseCommitSha: headSha ?? '',
              chunks: [],
              treeFileCount: 0,
              treeBytes: BigInt(0),
              treeFileSizes: new Map<string, bigint>(),
              withheldPaths: [],
              withheldReasons: {},
            }),
        changedFiles,
        untrackedCandidates,
        treeEntries,
      };
    },
  );
  const disclosedRepositories = repositoryPreviews.flatMap((entry) =>
    entry.remoteUrl && parseGitHubRemote(entry.remoteUrl) && entry.baseCommitSha
      ? [
          {
            repoId: entry.repository.repoId,
            repoName: entry.repository.repoName,
            remoteUrl: entry.remoteUrl,
            baseCommitSha: entry.baseCommitSha,
          },
        ]
      : [],
  );
  const disclosedIds = new Set(
    repositoryPreviews.map((entry) => entry.repository.repoId),
  );
  const disclosedPreviews = repositoryPreviews.filter((entry) =>
    disclosedIds.has(entry.repository.repoId),
  );
  const runEnabled = deps.isRunEnabled?.() === true;
  const run = runEnabled
    ? await deriveSharedContainerRunConfig(
        request.projectId,
        disclosedPreviews.map((entry) => entry.repository),
        approvedFileScope,
      )
    : undefined;
  const availableRunScripts = runEnabled
    ? await listSharedContainerRunScriptCandidates(
        request.projectId,
        disclosedPreviews.map((entry) => entry.repository),
      )
    : undefined;
  // Same NFC normalization the approval path applies, so an NFD-named file
  // stays matchable against the persisted (NFC) scope. Without it the modal
  // renders an approved file as unapproved and the budget undercounts it.
  const untrackedCandidateOwners = new Map<
    string,
    {
      entry: (typeof disclosedPreviews)[number];
      repoPath: string;
      relativePath: string;
      prefixLength: number;
    }
  >();
  for (const entry of disclosedPreviews) {
    // With no HEAD, Phase 2b intentionally places every non-ignored file in
    // the parentless snapshot. Those files are already disclosed by the
    // snapshot notice and are not optional approval-scope additions.
    if (entry.headSha === null && entry.snapshot) continue;
    const prefix = entry.repository.relativePrefix.normalize('NFC');
    for (const rawPath of entry.untrackedCandidates) {
      const relativePath = rawPath.normalize('NFC');
      const scopedPath = (
        prefix ? `${prefix}/${relativePath}` : relativePath
      ).normalize('NFC');
      const current = untrackedCandidateOwners.get(scopedPath);
      if (!current || prefix.length > current.prefixLength) {
        untrackedCandidateOwners.set(scopedPath, {
          entry,
          repoPath: entry.repository.repoPath,
          relativePath,
          prefixLength: prefix.length,
        });
      }
    }
  }
  const deletedFilePaths = new Set(
    disclosedPreviews.flatMap((entry) => {
      const prefix = entry.repository.relativePrefix.normalize('NFC');
      return entry.changedFiles
        .filter((file) => file.status === 'deleted')
        .map((file) => {
          const path = file.path.normalize('NFC');
          return prefix ? `${prefix}/${path}` : path;
        });
    }),
  );
  const visibleApprovedFileScope = {
    ...approvedFileScope,
    includedPaths: approvedFileScope.includedPaths.filter((rawPath) => {
      const scopedPath = rawPath.normalize('NFC');
      let owner: (typeof disclosedPreviews)[number] | undefined;
      let ownerPrefixLength = -1;
      for (const entry of disclosedPreviews) {
        const prefix = entry.repository.relativePrefix.normalize('NFC');
        if (
          prefix.length <= ownerPrefixLength ||
          (prefix &&
            scopedPath !== prefix &&
            !scopedPath.startsWith(`${prefix}/`))
        ) {
          continue;
        }
        owner = entry;
        ownerPrefixLength = prefix.length;
      }
      return !(owner?.headSha === null && owner.snapshot);
    }),
  };
  let sharedDirtyFileCount = 0;
  let trackedArtifactCount = 0;
  let trackedArtifactBytes = 0;
  let withheldFileCount = 0;
  const withheldFilePaths: string[] = [];
  const withheldSymlinkPaths: string[] = [];
  const snapshotPreviews = repositoryPreviews.filter(
    (entry) => entry.snapshot !== undefined,
  );
  const snapshotArtifactCount = snapshotPreviews.reduce(
    (count, entry) => count + (entry.snapshot?.chunks.length ?? 0),
    0,
  );
  const snapshotBytes = snapshotPreviews.reduce(
    (bytes, entry) =>
      bytes +
      (entry.snapshot?.chunks.reduce(
        (total, chunk) => total + chunk.sizeBytes,
        0,
      ) ?? 0),
    0,
  );
  const unpushedCommitCount = repositoryPreviews.reduce(
    (count, entry) => count + entry.unpushedCommitCount,
    0,
  );
  const recordWithheldSymlinkPath = (
    entry: (typeof disclosedPreviews)[number],
    path: string,
  ): void => {
    if (withheldSymlinkPaths.length >= MAX_SHARED_CONTAINER_FILE_PATHS) return;
    const prefix = entry.repository.relativePrefix.normalize('NFC');
    withheldSymlinkPaths.push(prefix ? `${prefix}/${path}` : path);
  };
  const recordWithheldFilePath = (
    entry: (typeof disclosedPreviews)[number],
    path: string,
  ): void => {
    if (withheldFilePaths.length >= MAX_SHARED_CONTAINER_FILE_PATHS) return;
    const prefix = entry.repository.relativePrefix.normalize('NFC');
    withheldFilePaths.push(prefix ? `${prefix}/${path}` : path);
  };
  for (const entry of disclosedPreviews) {
    if (entry.snapshot) {
      withheldFileCount += entry.snapshot.withheldPaths.length;
      for (const path of entry.snapshot.withheldPaths) {
        recordWithheldFilePath(entry, path);
        if (entry.snapshot.withheldReasons?.[path] === 'symlink-escaping') {
          recordWithheldSymlinkPath(entry, path);
        }
      }
    }
    const changedPaths = new Set(
      entry.changedFiles
        .filter((file) => file.status !== 'untracked')
        .map((file) => file.path.normalize('NFC')),
    );
    for (const treeEntry of entry.treeEntries) {
      const path = treeEntry.path.normalize('NFC');
      if (treeEntry.mode !== '120000' || changedPaths.has(path)) continue;
      const classification =
        treeEntry.symlinkTargetClassification ??
        (treeEntry.symlinkTarget === undefined
          ? treeEntry.symlinkEscapesRepository
            ? 'escaping'
            : 'in-repository'
          : classifySharedContainerSymlinkTarget(
              path,
              treeEntry.symlinkTarget,
            ));
      if (classification === 'in-repository') continue;
      withheldFileCount += 1;
      recordWithheldFilePath(entry, path);
      if (classification === 'escaping') {
        recordWithheldSymlinkPath(entry, path);
      }
    }
    for (const file of entry.changedFiles) {
      if (file.status === 'untracked') continue;
      const path = file.path.normalize('NFC');
      if (isCredentialShapedSharedContainerPath(path)) {
        withheldFileCount += 1;
        recordWithheldFilePath(entry, path);
        continue;
      }
      if (file.status === 'deleted') {
        sharedDirtyFileCount += 1;
        continue;
      }
      const inspection = deps.inspectFile
        ? await deps.inspectFile(entry.repository.repoPath, path)
        : { isRegularFile: true, hardLinked: false, sizeBytes: 0 };
      if (inspection.isSymbolicLink && inspection.symlinkTarget !== undefined) {
        const classification = classifySharedContainerSymlinkTarget(
          path,
          inspection.symlinkTarget,
        );
        if (classification !== 'in-repository') {
          withheldFileCount += 1;
          recordWithheldFilePath(entry, path);
          if (classification === 'escaping') {
            recordWithheldSymlinkPath(entry, path);
          }
          continue;
        }
        sharedDirtyFileCount += 1;
        trackedArtifactCount += 1;
        trackedArtifactBytes += inspection.sizeBytes;
        continue;
      }
      if (inspection.hardLinked) {
        withheldFileCount += 1;
        recordWithheldFilePath(entry, path);
        continue;
      }
      if (!inspection.isRegularFile) {
        // A tracked path that became a symlink or disappeared is published as
        // a deletion, so it remains a shared change but has no artifact bytes.
        sharedDirtyFileCount += 1;
        continue;
      }
      if (inspection.sizeBytes > MAX_SHARED_CONTAINER_ARTIFACT_BYTES) {
        withheldFileCount += 1;
        recordWithheldFilePath(entry, path);
        continue;
      }
      sharedDirtyFileCount += 1;
      trackedArtifactCount += 1;
      trackedArtifactBytes += inspection.sizeBytes;
    }
  }
  let referencedValues: string[] = [];
  try {
    referencedValues =
      (await deps.listReferencedPaths?.(
        request.projectId,
        request.worktreeId,
      )) ?? [];
  } catch {
    // Candidate ranking remains deterministic by mtime and path without chat hints.
  }
  const normalizedReferences = referencedValues.map((value) =>
    value.split('\\').join('/').normalize('NFC'),
  );
  const safeUntrackedCandidates: Array<{
    path: string;
    sizeBytes: number;
    mtimeMs: number;
  }> = [];
  for (const [scopedPath, owner] of Array.from(
    untrackedCandidateOwners.entries(),
  )) {
    if (isCredentialShapedSharedContainerPath(owner.relativePath)) {
      withheldFileCount += 1;
      recordWithheldFilePath(owner.entry, owner.relativePath);
      continue;
    }
    const inspection = deps.inspectFile
      ? await deps.inspectFile(owner.repoPath, owner.relativePath)
      : { isRegularFile: true, hardLinked: false, sizeBytes: 0 };
    if (inspection.isSymbolicLink && inspection.symlinkTarget !== undefined) {
      const classification = classifySharedContainerSymlinkTarget(
        owner.relativePath,
        inspection.symlinkTarget,
      );
      if (classification !== 'in-repository') {
        withheldFileCount += 1;
        recordWithheldFilePath(owner.entry, owner.relativePath);
        if (classification === 'escaping') {
          recordWithheldSymlinkPath(owner.entry, owner.relativePath);
        }
      } else {
        safeUntrackedCandidates.push({
          path: scopedPath,
          sizeBytes: inspection.sizeBytes,
          mtimeMs: inspection.mtimeMs ?? 0,
        });
      }
    } else if (!inspection.isRegularFile || inspection.hardLinked) {
      withheldFileCount += 1;
      recordWithheldFilePath(owner.entry, owner.relativePath);
    } else if (inspection.sizeBytes > MAX_SHARED_CONTAINER_ARTIFACT_BYTES) {
      withheldFileCount += 1;
      recordWithheldFilePath(owner.entry, owner.relativePath);
    } else {
      safeUntrackedCandidates.push({
        path: scopedPath,
        sizeBytes: inspection.sizeBytes,
        mtimeMs: inspection.mtimeMs ?? 0,
      });
    }
  }
  const isReferenced = (path: string): boolean =>
    normalizedReferences.some(
      (value) => value === path || value.endsWith(`/${path}`),
    );
  safeUntrackedCandidates.sort(
    (left, right) =>
      Number(isReferenced(right.path)) - Number(isReferenced(left.path)) ||
      right.mtimeMs - left.mtimeMs ||
      left.path.localeCompare(right.path),
  );
  const rankedUntrackedCandidates = safeUntrackedCandidates.map(
    (candidate) => candidate.path,
  );
  const remainingArtifactBudget = Math.max(
    0,
    MAX_SHARED_CONTAINER_ARTIFACTS_PER_REVISION -
      (base.artifactBudget.used + snapshotArtifactCount + trackedArtifactCount),
  );
  let codeBaseRevisionBytes = MAX_SHARED_CONTAINER_ARTIFACT_BYTES;
  try {
    codeBaseRevisionBytes =
      (await deps.measureCodeRevisionBaseBytes?.(
        request.projectId,
        request.worktreeId,
        approvedFileScope,
        run,
      )) ?? codeBaseRevisionBytes;
  } catch {
    // Byte measurement is a preview hint. Publication repeats it from stable
    // sources and remains authoritative if the workspace moves.
    codeBaseRevisionBytes = MAX_SHARED_CONTAINER_REVISION_BYTES;
  }
  const defaultIncludedFilePaths = selectSharedContainerCandidatePaths(
    'CODE_WORKTREE',
    rankedUntrackedCandidates,
    approvedFileScope,
    remainingArtifactBudget,
    getCodeCandidateRevisionByteCosts(
      rankedUntrackedCandidates,
      Object.fromEntries(
        safeUntrackedCandidates.map(({ path, sizeBytes }) => [path, sizeBytes]),
      ),
    ),
    Math.max(
      0,
      MAX_SHARED_CONTAINER_REVISION_BYTES -
        codeBaseRevisionBytes -
        snapshotBytes -
        trackedArtifactBytes,
    ),
  );
  const defaultIncludedFileSet = new Set(defaultIncludedFilePaths);
  const offeredUntrackedCandidates = [
    ...defaultIncludedFilePaths,
    ...rankedUntrackedCandidates.filter(
      (path) => !defaultIncludedFileSet.has(path),
    ),
  ];
  let startPage: SharedContainerSharePreview['startPage'] = null;
  if (resolvedStartPage?.startPage.kind === 'url') {
    startPage = { label: resolvedStartPage.startPage.url, status: 'url' };
  } else if (resolvedStartPage?.startPage.kind === 'file') {
    const fileStartPage = resolvedStartPage.startPage;
    const startPageRepository = findStartPageRepository(
      fileStartPage,
      repositories,
    );
    const scopedPath = startPageRepository
      ? (startPageRepository.relativePrefix
          ? `${startPageRepository.relativePrefix}/${fileStartPage.path}`
          : fileStartPage.path
        ).normalize('NFC')
      : null;
    const isWithheld =
      scopedPath === null ||
      deletedFilePaths.has(scopedPath) ||
      withheldFilePaths.includes(scopedPath) ||
      (untrackedCandidateOwners.has(scopedPath) &&
        !defaultIncludedFileSet.has(scopedPath));
    startPage = {
      label: fileStartPage.path,
      status: isWithheld ? 'withheld' : 'included',
    };
  }
  return {
    ...base,
    startPage,
    approvedFileScope: visibleApprovedFileScope,
    ...(disclosedRepositories.length > 1
      ? { repositories: disclosedRepositories }
      : {}),
    ...(disclosedRepositories.length === 1
      ? {
          repository: {
            remoteUrl: disclosedRepositories[0].remoteUrl,
            baseCommitSha: disclosedRepositories[0].baseCommitSha,
          },
        }
      : {}),
    dirtyFileCount: sharedDirtyFileCount,
    untrackedCandidates: offeredUntrackedCandidates.slice(
      0,
      MAX_SHARED_CONTAINER_FILE_PATHS,
    ),
    untrackedCandidateCount: rankedUntrackedCandidates.length,
    defaultIncludedFilePaths,
    undisclosedRepositoryCount: 0,
    ...(unpushedCommitCount > 0 ? { unpushedCommitCount } : {}),
    ...(snapshotPreviews.length > 0
      ? {
          snapshotRepositoryCount: snapshotPreviews.length,
          snapshotBytes,
          snapshotRepositoryNames: snapshotPreviews.map(
            (entry) => entry.repository.repoName,
          ),
        }
      : {}),
    ...(withheldFileCount > 0 ? { withheldFileCount } : {}),
    ...(withheldFilePaths.length > 0 ? { withheldFilePaths } : {}),
    ...(withheldSymlinkPaths.length > 0 ? { withheldSymlinkPaths } : {}),
    ...(availableRunScripts && availableRunScripts.length > 0
      ? { availableRunScripts }
      : {}),
    ...(run ? { run } : {}),
    artifactBudget: {
      used:
        1 +
        chatCount +
        planCount +
        attachmentCount +
        selectedNoteCount +
        selectedPromptCount +
        snapshotArtifactCount +
        trackedArtifactCount +
        defaultIncludedFilePaths.length,
      limit: MAX_SHARED_CONTAINER_ARTIFACTS_PER_REVISION,
    },
  };
}
