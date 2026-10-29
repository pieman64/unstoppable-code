import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readlink, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { Readable } from 'node:stream';
import type {
  ChangedFileStatus,
  PersistedChatTab,
  SharedContainerFileScope,
  TrackedPlanData,
  WorkspaceNoteItem,
  WorkspacePromptItem,
  SingleRepoSidebarItem,
} from '@canopy/desktop-shared/types';
import { WORKSPACE_ROOT_REPO_ID } from '@canopy/desktop-shared/types';
import {
  orderRunScriptNames,
  selectDefaultRunScripts,
} from '@canopy/desktop-shared/lib/shared-container-scope-mode';
import type { WirePlanCommentThread } from '@canopy/protocol/plans';
import {
  MAX_SHARED_CONTAINER_ARTIFACT_BYTES,
  MAX_SHARED_CONTAINER_ARTIFACTS_PER_REVISION,
  MAX_SHARED_CONTAINER_COMMITTED_FILES_PER_REPOSITORY,
  MAX_SHARED_CONTAINER_MATERIALIZED_FILES,
  MAX_SHARED_CONTAINER_REVISION_BYTES,
  type SharedContainerFileStatus,
  type SharedContainerPublishedLayout,
  type SharedContainerStartPage,
  type SharedContainerPublishedPlan,
  type SharedContainerRevisionCommittedFile,
  type SharedContainerWithheldFileReason,
} from '@canopy/protocol/shared-containers';
import {
  MAX_SHARED_CONTAINER_RUN_COMMAND_LENGTH,
  MAX_SHARED_CONTAINER_RUN_COMMANDS,
  MAX_SHARED_CONTAINER_RUN_ENV_NAME_LENGTH,
  MAX_SHARED_CONTAINER_RUN_ENV_NAMES,
  SHARED_CONTAINER_RUN_COMMAND_NAME_PATTERN,
  type SharedContainerRevisionRunConfig,
} from '@canopy/protocol/shared-containers';
import { parseBulkEnvironment } from '@canopy/desktop-shared/lib/user-environment';
import { evaluateApproval } from '@canopy/desktop-shared/lib/approval-engine';
import { SCRIPT_ENV_VAR_DEFINITIONS } from '@canopy/desktop-shared/scripts';
import { mapWithConcurrency } from '../../lib/concurrency';
import {
  WORKTREE_GIT_TIMEOUT_MS,
  classifySharedContainerSymlinkTarget,
  decodeUtf8SymlinkTarget,
  getCommittedFilesBetween,
  getHeadCommitShaStrict,
  getMergeBaseForBranch,
  listUntrackedFilesStrict,
  listWorkingTreeDiffAgainstCommit,
  inspectRepositoryTreeEntryKinds,
  repositoryUsesGitLfs,
  type RawDiffEntry,
  type SharedContainerSymlinkTargetClassification,
} from '../../lib/git';
import { logMainProcessWarn } from '../../lib/main-process-logging';
import { resolveEffectiveBaseBranchForRepo } from '../../lib/worktree-base-branches';
import { listTrackedPlans } from '../../lib/plan-persistence';
import { sanitizeRemoteUrl } from '../../lib/plan-share-repos';
import { parseFrontmatterAndBody } from '../../lib/frontmatter';
import {
  listWorkspaceNotes,
  listWorkspacePrompts,
} from '../../lib/workspace-items';
import { parseGitHubRemote } from '../materialize/code';
import { validateMaterializedRelativePath } from '../materialize/path-safety';
import {
  listSharedContainerLocalRepositories,
  type SharedContainerLocalRepository,
} from '../local-repositories';
import { resolveSharedContainerPushedBase } from '../pushed-base';
import {
  collectCoworkChatAttachmentSourcePaths,
  listCoworkReferencedAttachmentFiles,
  openCoworkReferencedAttachment,
  type CoworkReferencedAttachmentFile,
  readChatTabs,
  type CoworkPublishBinaryItem,
  type CoworkPublishNote,
  type CoworkPublishPrompt,
} from './inventory';
import { SharedContainerPublishRefusalError } from './errors';
import {
  assertArtifactSize,
  assertStableFile,
  createStableFileSource,
  openVerifiedFile,
  SharedContainerPublishInventoryChangedError,
  type PublishFileSource,
} from './source-files';
import { createOutputPathDomain, redactAbsolutePaths } from './artifacts';
import {
  getResolvedScriptDefinition,
  resolveProjectScripts,
  resolveWorkspaceRepoScripts,
  resolveWorkspaceRootScripts,
  type ResolvedScriptMap,
} from '../../lib/script-resolver';
import { readAllSidebarItems } from '../../lib/sidebar-items';
import { getWorkspaceType } from '../../lib/workspace-registry';
import { isCredentialShapedSharedContainerPath } from './path-withholding';
import { selectSharedContainerCandidatePaths } from './cowork-files';
import { getCoworkRevisionBaseByteSize } from './cowork-artifacts';
import {
  buildSharedContainerCodeSnapshot,
  type SharedContainerCodeSnapshot,
} from './code-snapshot';
import { readSanitizedSharedContainerPublishedLayout } from './layout';
import { resolveProjectStartPage } from '../../lib/project-start-page';
import { mapProjectStartPageForPublication } from './start-page';

export { isCredentialShapedSharedContainerPath } from './path-withholding';

const REPOSITORY_CONCURRENCY = 4;
const FILE_SOURCE_CONCURRENCY = 4;
const MAX_NAMED_REFUSAL_PATHS = 5;
const RUN_ENV_SAMPLE_NAMES = [
  '.env.example',
  '.env.sample',
  '.env.template',
] as const;
const RUN_ENV_DENY_NAMES = new Set([
  'PATH',
  'HOME',
  'SHELL',
  'PWD',
  'USER',
  'LANG',
  'TERM',
  'NODE_ENV',
  'TMPDIR',
  ...SCRIPT_ENV_VAR_DEFINITIONS.map((definition) => definition.name),
]);

const BUDGET_ARTIFACT_ID = '00000000-0000-0000-0000-000000000000';

/**
 * Conservative cost of one optional worktree file: content plus its exact
 * repository-layout entry shape. The comma is charged to every entry so the
 * first file is overestimated by one byte, never under.
 */
export function getCodeFileRevisionByteCost(
  path: string,
  sizeBytes: number,
): number {
  const layoutEntry = {
    path,
    status: 'added' as const,
    mode: '100755',
    artifactId: BUDGET_ARTIFACT_ID,
  };
  return sizeBytes + Buffer.byteLength(JSON.stringify(layoutEntry)) + 1;
}

export function getCodeCandidateRevisionByteCosts(
  paths: readonly string[],
  sizeBytesByPath: Readonly<Record<string, number>> = {},
): Record<string, number> {
  return Object.fromEntries(
    paths.map((path) => [
      path,
      getCodeFileRevisionByteCost(path, sizeBytesByPath[path] ?? 0),
    ]),
  );
}

function getCodeRevisionBaseByteSize(input: {
  chats: PersistedChatTab[];
  attachments: CoworkPublishBinaryItem[];
  notes: CoworkPublishNote[];
  prompts: CoworkPublishPrompt[];
  plans: SharedContainerPublishedPlan[];
}): number {
  let totalBytes = getCoworkRevisionBaseByteSize({
    chats: input.chats,
    attachments: input.attachments,
    notes: input.notes,
    prompts: input.prompts,
  });
  for (const plan of input.plans) {
    totalBytes = Math.min(
      MAX_SHARED_CONTAINER_REVISION_BYTES,
      totalBytes + Buffer.byteLength(JSON.stringify(plan)),
    );
  }
  // `container.json` carries repository metadata, tracked-file entries,
  // withholding details and run configuration. It is itself bounded by the
  // per-artifact limit, so reserving that full limit is conservative and keeps
  // preview and publication from admitting an optional file that final staging
  // could reject because of serialized metadata.
  return Math.min(
    MAX_SHARED_CONTAINER_REVISION_BYTES,
    totalBytes + MAX_SHARED_CONTAINER_ARTIFACT_BYTES,
  );
}

async function readUtf8SymlinkTarget(path: string): Promise<string> {
  const bytes = await readlink(path, { encoding: 'buffer' });
  return decodeUtf8SymlinkTarget(
    bytes,
    'Repository contains a non-UTF-8 symlink target',
  );
}

function sharedContainerSymlinkWithheldReasonFromClassification(
  classification: SharedContainerSymlinkTargetClassification,
): SharedContainerWithheldFileReason | undefined {
  if (classification === 'escaping') return 'symlink-escaping';
  if (classification === 'oversized') return 'oversized';
  return undefined;
}

function sharedContainerSymlinkWithheldReason(
  path: string,
  target: string,
): SharedContainerWithheldFileReason | undefined {
  return sharedContainerSymlinkWithheldReasonFromClassification(
    classifySharedContainerSymlinkTarget(path, target),
  );
}

export interface CodePublishFile {
  path: string;
  status: SharedContainerFileStatus;
  mode: string;
  source?: PublishFileSource;
  untracked: boolean;
}

export interface CodePublishRepository {
  repoId: string;
  repoName: string;
  repoPath: string;
  remoteUrl?: string;
  owner?: string;
  repository?: string;
  source?: 'snapshot';
  snapshot?: SharedContainerCodeSnapshot;
  baseCommitSha: string;
  /** HEAD observed while the inventory was built, or null for an unborn branch. */
  headSha: string | null;
  unpushedCommitCount: number;
  fingerprint: string;
  approvedUntrackedPaths: string[];
  files: CodePublishFile[];
  /** Base branch used to compute {@link committedFiles}. Display metadata only. */
  baseBranch?: string;
  /** Merge base of the shared branch and its base branch. */
  mergeBaseSha?: string;
  /**
   * The publisher's own commits, `mergeBaseSha..baseCommitSha`. Metadata only: the
   * blobs already live in the recipient's clone of the same remote, so they are
   * never uploaded as artifacts.
   */
  committedFiles?: SharedContainerRevisionCommittedFile[];
}

export interface CodePublishInventory {
  chats: PersistedChatTab[];
  attachments: CoworkPublishBinaryItem[];
  notes: CoworkPublishNote[];
  prompts: CoworkPublishPrompt[];
  plans: SharedContainerPublishedPlan[];
  repositories: CodePublishRepository[];
  withheldFileCount: number;
  withheldFileReasons: SharedContainerWithheldFileReason[];
  run?: SharedContainerRevisionRunConfig;
  layout?: SharedContainerPublishedLayout;
  startPage?: SharedContainerStartPage;
}

export interface CodePublishInventoryDependencies {
  listRepositories: typeof listSharedContainerLocalRepositories;
  readChatTabs: typeof readChatTabs;
  listAttachmentFiles: typeof listCoworkReferencedAttachmentFiles;
  openAttachmentFile: typeof openCoworkReferencedAttachment;
  listPlans: typeof listTrackedPlans;
  listNotes: typeof listWorkspaceNotes;
  listPrompts: typeof listWorkspacePrompts;
  readWorkspaceItem: typeof readCodeWorkspaceItemForPublication;
  resolvePushedBase: typeof resolveSharedContainerPushedBase;
  getRemoteUrl: (repoPath: string) => Promise<string | null>;
  listDiff: typeof listWorkingTreeDiffAgainstCommit;
  listUntracked: typeof listUntrackedFilesStrict;
  getHead: typeof getHeadCommitShaStrict;
  resolveBaseBranch: typeof resolveEffectiveBaseBranchForRepo;
  getMergeBase: typeof getMergeBaseForBranch;
  listCommittedFiles: typeof getCommittedFilesBetween;
  usesLfs: typeof repositoryUsesGitLfs;
  inspectTreeEntries: typeof inspectRepositoryTreeEntryKinds;
  createFileSource: typeof createStableFileSource;
  resolveRunScripts: (
    projectId: string,
    repository: SharedContainerLocalRepository,
  ) => Promise<ResolvedScriptMap>;
  readRunEnvSample: (repoPath: string, name: string) => Promise<string | null>;
  buildSnapshot: typeof buildSharedContainerCodeSnapshot;
  resolveStartPage?: typeof resolveProjectStartPage;
}

export async function defaultResolveRunScripts(
  projectId: string,
  repository: SharedContainerLocalRepository,
): Promise<ResolvedScriptMap> {
  if (getWorkspaceType(projectId) === 'multi-repo') {
    if (repository.repoId === WORKSPACE_ROOT_REPO_ID) {
      return resolveWorkspaceRootScripts(projectId, {
        workspaceRootPath: repository.repoPath,
      });
    }
    return resolveWorkspaceRepoScripts(projectId, repository.repoId, {
      repoPath: repository.repoPath,
    });
  }
  const project = (await readAllSidebarItems()).items.find(
    (item): item is SingleRepoSidebarItem =>
      item.type === 'single-repo' && item.id === projectId,
  );
  if (!project) return {};
  return resolveProjectScripts(project, repository.repoPath);
}

export async function defaultReadRunEnvSample(
  repoPath: string,
  name: string,
): Promise<string | null> {
  let handle;
  try {
    handle = await open(
      join(repoPath, name),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ELOOP') return null;
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_SHARED_CONTAINER_ARTIFACT_BYTES) {
      return null;
    }
    return (await handle.readFile()).toString('utf8');
  } finally {
    await handle.close();
  }
}

/**
 * Deterministic publish order for selected script names: the lifecycle trio
 * first, then everything else alphabetically.
 *
 * The order is load-bearing only when a publisher has somehow selected more
 * than {@link MAX_SHARED_CONTAINER_RUN_COMMANDS} (the picker and the scope
 * store both cap the selection, so this is a backstop). Without a fixed order
 * the truncation would depend on object iteration order and two publishes of
 * the same scope could ship different commands.
 */
/**
 * Every script name the publisher could tick for this share, across the
 * disclosed repositories.
 *
 * This is the picker's source of truth, so it deliberately reports names whose
 * command would later be dropped (safety-denied, over-length, unredactable
 * absolute path). The picker already tells the publisher per row when a ticked
 * script produced no command, and hiding those names instead would make a
 * script the publisher can see in their own Scripts panel silently absent here.
 */
export async function listSharedContainerRunScriptCandidates(
  projectId: string,
  repositories: readonly SharedContainerLocalRepository[],
  deps: Pick<CodePublishInventoryDependencies, 'resolveRunScripts'> = {
    resolveRunScripts: defaultResolveRunScripts,
  },
): Promise<string[]> {
  const names = new Set<string>();
  for (const repository of repositories) {
    const resolved = await deps.resolveRunScripts(projectId, repository);
    for (const name of Object.keys(resolved)) {
      if (!SHARED_CONTAINER_RUN_COMMAND_NAME_PATTERN.test(name)) continue;
      if (!getResolvedScriptDefinition(resolved, name)) continue;
      names.add(name);
    }
  }
  return orderRunScriptNames(Array.from(names));
}

export async function deriveSharedContainerRunConfig(
  projectId: string,
  repositories: readonly SharedContainerLocalRepository[],
  scope: SharedContainerFileScope,
  deps: Pick<
    CodePublishInventoryDependencies,
    'resolveRunScripts' | 'readRunEnvSample'
  > = {
    resolveRunScripts: defaultResolveRunScripts,
    readRunEnvSample: defaultReadRunEnvSample,
  },
): Promise<SharedContainerRevisionRunConfig | undefined> {
  if (scope.runSharingDisabled === true) return undefined;
  const resolvedRepositories: Array<{
    repository: SharedContainerLocalRepository;
    scripts: ResolvedScriptMap;
  }> = [];
  const candidateNames = new Set<string>();
  for (const repository of repositories) {
    const scripts = await deps.resolveRunScripts(projectId, repository);
    resolvedRepositories.push({ repository, scripts });
    for (const name of Object.keys(scripts)) {
      if (!SHARED_CONTAINER_RUN_COMMAND_NAME_PATTERN.test(name)) continue;
      if (!getResolvedScriptDefinition(scripts, name)) continue;
      candidateNames.add(name);
    }
  }
  const selectedNames = selectDefaultRunScripts(
    Array.from(candidateNames),
    scope,
  );
  const commands: SharedContainerRevisionRunConfig['commands'] = [];
  const publishedNames = new Set<string>();
  const requiredEnv = new Set<string>();
  for (const { repository, scripts: resolved } of resolvedRepositories) {
    // Repositories stay the outer loop so the first repo declaring a name
    // still wins it, unchanged from when only `setup`/`launch` were eligible.
    for (const name of selectedNames) {
      if (
        publishedNames.has(name) ||
        commands.length >= MAX_SHARED_CONTAINER_RUN_COMMANDS
      ) {
        continue;
      }
      const definition = getResolvedScriptDefinition(resolved, name);
      if (!definition) continue;
      const safetyDenied =
        evaluateApproval(
          {
            kind: 'command',
            command: definition.command,
            shellPlatform: 'posix',
          },
          {
            mode: 'ask',
            rules: { session: [], project: [], global: [] },
            workspaceRoot: repository.repoPath,
          },
        ).outcome === 'deny';
      const command = redactAbsolutePaths(definition.command);
      if (
        safetyDenied ||
        command.length === 0 ||
        command.length > MAX_SHARED_CONTAINER_RUN_COMMAND_LENGTH ||
        // eslint-disable-next-line no-control-regex
        /[\r\n\u0000-\u001F\u007F]/.test(command)
      ) {
        continue;
      }
      commands.push({ name, command, repoId: repository.repoId });
      publishedNames.add(name);
      for (const match of Array.from(
        command.matchAll(
          /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g,
        ),
      )) {
        requiredEnv.add(match[1] ?? match[2] ?? '');
      }
    }
    for (const sampleName of RUN_ENV_SAMPLE_NAMES) {
      const content = await deps.readRunEnvSample(
        repository.repoPath,
        sampleName,
      );
      if (content === null) continue;
      for (const entry of parseBulkEnvironment(content)) {
        requiredEnv.add(entry.key);
      }
    }
  }
  const normalizedEnv = Array.from(requiredEnv)
    .filter(
      (name) =>
        name.length <= MAX_SHARED_CONTAINER_RUN_ENV_NAME_LENGTH &&
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) &&
        !RUN_ENV_DENY_NAMES.has(name),
    )
    .sort()
    .slice(0, MAX_SHARED_CONTAINER_RUN_ENV_NAMES);
  return { commands, requiredEnv: normalizedEnv };
}

async function defaultGetRemoteUrl(repoPath: string): Promise<string | null> {
  const { getRemoteUrlStrict } = await import('../../lib/git');
  return getRemoteUrlStrict(repoPath);
}

function finalizeWorkspaceItemContent(
  content: string,
  sourceSizeBytes: bigint,
  reserveInspectionBytes: (size: bigint) => void,
): string {
  const redactedContent = redactAbsolutePaths(content);
  const contentSizeBytes = Buffer.byteLength(redactedContent);
  assertArtifactSize(contentSizeBytes);
  if (BigInt(contentSizeBytes) > sourceSizeBytes) {
    reserveInspectionBytes(BigInt(contentSizeBytes) - sourceSizeBytes);
  }
  return redactedContent;
}

export async function readCodeWorkspaceItemForPublication<
  T extends WorkspaceNoteItem | WorkspacePromptItem,
>(
  item: T,
  kind: 'note' | 'prompt',
  reserveInspectionBytes: (size: bigint) => void,
): Promise<{ meta: T; content: string; sourceSizeBytes: bigint }> {
  const canonicalPath = await realpath(item.absolutePath).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new SharedContainerPublishInventoryChangedError();
    }
    throw error;
  });
  const handle = await openVerifiedFile(item.absolutePath, canonicalPath);
  try {
    const snapshot = await handle.stat({ bigint: true });
    const size = Number(snapshot.size);
    assertArtifactSize(size);
    reserveInspectionBytes(snapshot.size);
    const bytes = Buffer.allocUnsafe(size + 1);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const { bytesRead } = await handle.read(
        bytes,
        offset,
        bytes.byteLength - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    assertStableFile(snapshot, await handle.stat({ bigint: true }));
    if (offset !== size) {
      throw new SharedContainerPublishInventoryChangedError();
    }
    const raw = bytes.subarray(0, offset).toString('utf8');
    return {
      meta: item,
      content: kind === 'prompt' ? parseFrontmatterAndBody(raw).body : raw,
      sourceSizeBytes: snapshot.size,
    };
  } finally {
    await handle.close();
  }
}

/**
 * Bytes consumed by non-repository file content in a code revision.
 *
 * Preview uses this before admitting optional untracked files. Publication
 * repeats the same reads while building its stable sources and remains the
 * authority if anything changes between the two passes.
 */
export async function measureCodeRevisionBaseBytes(
  input: {
    projectId: string;
    worktreeId: string;
    scope: SharedContainerFileScope;
    run?: SharedContainerRevisionRunConfig;
  },
  deps: Pick<
    CodePublishInventoryDependencies,
    | 'readChatTabs'
    | 'listAttachmentFiles'
    | 'listPlans'
    | 'listNotes'
    | 'listPrompts'
    | 'readWorkspaceItem'
  > = DEFAULT_DEPENDENCIES,
): Promise<number> {
  const [tabs, planItems, noteItems, promptItems] = await Promise.all([
    deps.readChatTabs(input.projectId, input.worktreeId),
    deps.listPlans(input.projectId, input.worktreeId),
    deps.listNotes(input.projectId),
    deps.listPrompts(input.projectId),
  ]);
  const chats = tabs.tabs.filter((tab) => tab.kind !== 'file');
  const attachmentFiles = await deps.listAttachmentFiles(
    input.projectId,
    input.worktreeId,
    collectCoworkChatAttachmentSourcePaths(chats),
  );
  const excludedNotes = new Set(input.scope.excludedNoteIds ?? []);
  const excludedPrompts = new Set(input.scope.excludedPromptIds ?? []);
  const selectedNoteItems = noteItems.filter(
    (note) =>
      note.origin?.worktreeId === input.worktreeId &&
      !excludedNotes.has(note.id),
  );
  const selectedPromptItems = promptItems.filter(
    (prompt) =>
      prompt.origin?.worktreeId === input.worktreeId &&
      !excludedPrompts.has(prompt.id),
  );
  let measuredBytes = 0;
  const reserveMeasuredBytes = (size: bigint): void => {
    if (size > BigInt(MAX_SHARED_CONTAINER_REVISION_BYTES - measuredBytes)) {
      throw new SharedContainerPublishRefusalError(
        'artifact-budget',
        'This revision exceeds the 500 MiB shared-content inspection limit. Commit or narrow the approved scope and try again.',
      );
    }
    measuredBytes += Number(size);
  };
  const attachments: CoworkPublishBinaryItem[] = [];
  for (const attachment of attachmentFiles) {
    assertArtifactSize(attachment.size);
    reserveMeasuredBytes(BigInt(attachment.size));
    const hash = createHash('sha256')
      .update(attachment.absolutePath)
      .digest('hex');
    attachments.push({
      displayName: attachment.displayName,
      sourcePaths: attachment.sourcePaths,
      source: {
        sizeBytes: attachment.size,
        hash: `sha256:${hash}`,
        createReadStream: () => Readable.from([]),
      },
    });
  }
  const notes: CoworkPublishNote[] = [];
  for (const note of selectedNoteItems) {
    const { meta, content, sourceSizeBytes } = await deps.readWorkspaceItem(
      note,
      'note',
      reserveMeasuredBytes,
    );
    notes.push({
      meta,
      content: finalizeWorkspaceItemContent(
        content,
        sourceSizeBytes,
        reserveMeasuredBytes,
      ),
    });
  }
  const prompts: CoworkPublishPrompt[] = [];
  for (const prompt of selectedPromptItems) {
    const { meta, content, sourceSizeBytes } = await deps.readWorkspaceItem(
      prompt,
      'prompt',
      reserveMeasuredBytes,
    );
    prompts.push({
      meta,
      content: finalizeWorkspaceItemContent(
        content,
        sourceSizeBytes,
        reserveMeasuredBytes,
      ),
    });
  }
  const disclosedRepoIds = new Set(
    planItems.flatMap((plan) =>
      plan.sourceRepoId === undefined ? [] : [plan.sourceRepoId],
    ),
  );
  return Math.max(
    measuredBytes,
    getCodeRevisionBaseByteSize({
      chats,
      attachments,
      notes,
      prompts,
      plans: planItems
        .filter((plan) => !plan.hidden)
        .map((plan) => publishPlan(plan, disclosedRepoIds)),
    }),
  );
}

const DEFAULT_DEPENDENCIES: CodePublishInventoryDependencies = {
  listRepositories: listSharedContainerLocalRepositories,
  readChatTabs,
  listAttachmentFiles: listCoworkReferencedAttachmentFiles,
  openAttachmentFile: openCoworkReferencedAttachment,
  listPlans: listTrackedPlans,
  listNotes: listWorkspaceNotes,
  listPrompts: listWorkspacePrompts,
  readWorkspaceItem: readCodeWorkspaceItemForPublication,
  resolvePushedBase: resolveSharedContainerPushedBase,
  getRemoteUrl: defaultGetRemoteUrl,
  listDiff: listWorkingTreeDiffAgainstCommit,
  listUntracked: listUntrackedFilesStrict,
  getHead: getHeadCommitShaStrict,
  resolveBaseBranch: resolveEffectiveBaseBranchForRepo,
  getMergeBase: getMergeBaseForBranch,
  listCommittedFiles: getCommittedFilesBetween,
  usesLfs: repositoryUsesGitLfs,
  inspectTreeEntries: inspectRepositoryTreeEntryKinds,
  createFileSource: createStableFileSource,
  resolveRunScripts: defaultResolveRunScripts,
  readRunEnvSample: defaultReadRunEnvSample,
  buildSnapshot: buildSharedContainerCodeSnapshot,
  resolveStartPage: resolveProjectStartPage,
};

function strictOptions(signal: AbortSignal): {
  timeoutMs: number;
  signal: AbortSignal;
} {
  return { timeoutMs: WORKTREE_GIT_TIMEOUT_MS, signal };
}

function validateRepositoryPath(path: string): string {
  const normalized = validateMaterializedRelativePath(path.normalize('NFC'));
  if (
    normalized.split('/').some((segment) => segment.toLowerCase() === '.git')
  ) {
    throw new Error('Repository path contains a protected .git segment');
  }
  return normalized;
}

function assertCanonicalRepositoryPath(
  canonicalRoot: string,
  canonicalPath: string,
): void {
  const contained = relative(canonicalRoot, canonicalPath);
  if (
    !contained ||
    contained === '..' ||
    contained.startsWith(`..${sep}`) ||
    isAbsolute(contained)
  ) {
    throw new SharedContainerPublishInventoryChangedError();
  }
}

async function assertExistingDeletedPathContained(
  repositoryRoot: string,
  canonicalRoot: string,
  path: string,
): Promise<void> {
  const requestedPath = join(repositoryRoot, ...path.split('/'));
  let info;
  try {
    info = await lstat(requestedPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return;
    throw error;
  }
  // A final-component symlink is represented as a deletion and never opened.
  // A regular leaf reached through a symlinked parent is different: resolving
  // it can escape the repository, so reject the inventory before publication.
  if (info.isSymbolicLink()) return;
  assertCanonicalRepositoryPath(canonicalRoot, await realpath(requestedPath));
}

function redactPublishedValue<T>(value: T): T {
  if (typeof value === 'string') return redactAbsolutePaths(value) as T;
  if (Array.isArray(value)) {
    return (value as unknown[]).map((item) =>
      redactPublishedValue<unknown>(item),
    ) as T;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).flatMap(([key, item]) =>
        key === 'absolutePath'
          ? []
          : [[redactAbsolutePaths(key), redactPublishedValue(item)]],
      ),
    ) as T;
  }
  return value;
}

function collectReferencedStrings(value: unknown, output: Set<string>): void {
  if (typeof value === 'string') {
    output.add(value.split('\\').join('/').normalize('NFC'));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectReferencedStrings(item, output);
    return;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) {
      collectReferencedStrings(item, output);
    }
  }
}

function fingerprintRows(
  baseSha: string,
  headSha: string,
  rows: readonly RawDiffEntry[],
  untracked: readonly {
    path: string;
    size: bigint;
    ino: bigint;
    mtimeNs: bigint;
  }[],
): string {
  const canonical = [
    baseSha,
    headSha,
    ...rows
      .map(
        (row) => `${row.status}\0${row.path}\0${row.srcMode}\0${row.dstMode}`,
      )
      .sort(),
    ...untracked
      .map((row) => `?\0${row.path}\0${row.size}\0${row.ino}\0${row.mtimeNs}`)
      .sort(),
  ].join('\n');
  return createHash('sha256').update(canonical).digest('hex');
}

function fingerprintSnapshot(snapshot: SharedContainerCodeSnapshot): string {
  const canonical = [
    snapshot.baseCommitSha,
    `${snapshot.treeFileCount}`,
    `${snapshot.treeBytes}`,
    ...snapshot.chunks.map((chunk) => `${chunk.hash}\0${chunk.sizeBytes}`),
    ...Array.from(snapshot.treeFileSizes.entries())
      .map(([path, size]) => `${path}\0${size}`)
      .sort(),
    ...snapshot.withheldPaths
      .map(
        (path) =>
          `${path}\0${snapshot.withheldReasons?.[path] ?? 'credential-shaped'}`,
      )
      .sort(),
  ].join('\n');
  return createHash('sha256').update(canonical).digest('hex');
}

function approvalsForRepository(
  repository: SharedContainerLocalRepository,
  repositories: readonly SharedContainerLocalRepository[],
  scope: SharedContainerFileScope,
  ownUntracked: ReadonlySet<string>,
): string[] {
  const prefix = repository.relativePrefix.normalize('NFC');
  const childPrefixes = repositories
    .filter((candidate) => candidate.relativePrefix && candidate !== repository)
    .map((candidate) => candidate.relativePrefix.normalize('NFC'));
  const excluded = new Set(
    (scope.excludedPaths ?? []).flatMap((raw) => {
      const path = raw.normalize('NFC');
      if (prefix) {
        return path.startsWith(`${prefix}/`)
          ? [validateRepositoryPath(path.slice(prefix.length + 1))]
          : [];
      }
      if (
        childPrefixes.some(
          (child) => path === child || path.startsWith(`${child}/`),
        )
      ) {
        return [];
      }
      return [validateRepositoryPath(path)];
    }),
  );
  return Array.from(ownUntracked).filter((path) => !excluded.has(path));
}

/**
 * The publisher's own commits, as recipient-facing metadata (CAN-2551).
 *
 * Never throws: a repository with no resolvable base branch, no merge base, or
 * an unreadable history simply publishes no committed group, which the
 * recipient renders exactly like a pre-CAN-2551 revision.
 */
async function collectCommittedChanges(
  context: { projectId: string; worktreeId: string },
  repository: SharedContainerLocalRepository,
  deps: CodePublishInventoryDependencies,
  baseCommitSha: string,
): Promise<{
  baseBranch?: string;
  mergeBaseSha?: string;
  committedFiles?: SharedContainerRevisionCommittedFile[];
}> {
  // A mid-publish HEAD move does not need handling here: `fingerprintRows`
  // includes `headSha`, and `buildCodePublishInventory` re-captures every
  // repository fingerprint before emitting artifacts, so the whole publish
  // fails with `SharedContainerPublishInventoryChangedError` rather than
  // shipping a committed list that describes a different range (CAN-2551).
  try {
    const effectiveBaseBranch = await deps.resolveBaseBranch({
      projectId: context.projectId,
      worktreeId: context.worktreeId,
      repoId: repository.repoId,
      repoPath: repository.repoPath,
    });
    const baseBranch = effectiveBaseBranch.branch ?? undefined;
    const mergeBaseSha = await deps.getMergeBase(
      repository.repoPath,
      baseBranch,
    );
    if (!mergeBaseSha || !/^[a-fA-F0-9]{40}$/.test(mergeBaseSha)) return {};
    const changed = await deps.listCommittedFiles(
      repository.repoPath,
      mergeBaseSha,
      baseCommitSha,
    );
    const committedFiles: SharedContainerRevisionCommittedFile[] = [];
    for (const file of changed) {
      if (
        committedFiles.length >=
        MAX_SHARED_CONTAINER_COMMITTED_FILES_PER_REPOSITORY
      ) {
        // The cap is a wire-format bound, not a user-facing policy like the
        // withheld-file disclosure, so it is recorded rather than surfaced.
        logMainProcessWarn(
          `[shared-containers] committed file list truncated at ${MAX_SHARED_CONTAINER_COMMITTED_FILES_PER_REPOSITORY} for a shared repository`,
        );
        break;
      }
      const status = toSharedContainerFileStatus(file.status);
      if (!status) continue;
      let path: string;
      try {
        path = validateRepositoryPath(file.path);
      } catch {
        continue;
      }
      // Only send counts that describe what the recipient will render.
      // `parseDiffOutput` normalizes a binary numstat `-` to `0`, and a
      // rename/copy is published as a plain `added` while keeping the rename's
      // much smaller counts — both would surface as a chip that contradicts
      // the diff beside it (CAN-2551).
      const countsDescribeTheDiff =
        file.status !== 'renamed' &&
        file.status !== 'copied' &&
        !(file.insertions === 0 && file.deletions === 0);
      committedFiles.push({
        path,
        status,
        ...(countsDescribeTheDiff
          ? { insertions: file.insertions, deletions: file.deletions }
          : {}),
      });
    }
    return {
      ...(baseBranch ? { baseBranch } : {}),
      mergeBaseSha,
      committedFiles,
    };
  } catch {
    return {};
  }
}

/**
 * Project the live activity-panel status vocabulary onto the three states the
 * shared-container wire format carries. Renames and copies are published as
 * plain additions because the manifest has no previous-path field, and
 * unmerged/unknown rows are dropped rather than guessed at.
 */
function toSharedContainerFileStatus(
  status: ChangedFileStatus,
): SharedContainerFileStatus | null {
  switch (status) {
    case 'added':
    case 'untracked':
    case 'renamed':
    case 'copied':
      return 'added';
    case 'modified':
    case 'type-changed':
      return 'modified';
    case 'deleted':
      return 'deleted';
    default:
      return null;
  }
}

async function enumerateRepository(
  context: { projectId: string; worktreeId: string },
  repository: SharedContainerLocalRepository,
  repositories: readonly SharedContainerLocalRepository[],
  scope: SharedContainerFileScope,
  deps: CodePublishInventoryDependencies,
  signal: AbortSignal,
): Promise<{
  repository: CodePublishRepository;
  canonicalRepoPath?: string;
  candidates: Array<Omit<CodePublishFile, 'source'>>;
  candidateSizeBytesByPath: Map<string, number>;
  untrackedSnapshots: Array<{
    path: string;
    size: bigint;
    ino: bigint;
    mtimeNs: bigint;
  }>;
  fingerprintInput?: { baseSha: string; headSha: string; rows: RawDiffEntry[] };
  withheld: number;
  withheldReasons: SharedContainerWithheldFileReason[];
  /**
   * Unchanged tracked files the recipient's checkout already holds. Layout
   * metadata only: a publisher tab on one of these may be named in the
   * published layout, but its bytes are never uploaded.
   */
  unchangedTrackedPaths: ReadonlySet<string>;
}> {
  if (!/^[A-Za-z0-9_-]+$/.test(repository.repoId)) {
    throw new SharedContainerPublishRefusalError(
      'undisclosable-repository',
      `Repository “${repository.repoName}” cannot be shared because its local id contains unsupported characters.`,
    );
  }
  const options = strictOptions(signal);
  const headSha = await deps.getHead(repository.repoPath, options);
  const [rawRemote, untrackedPaths, usesLfs, treeEntries] = await Promise.all([
    deps.getRemoteUrl(repository.repoPath),
    deps.listUntracked(repository.repoPath, options),
    deps.usesLfs(repository.repoPath, options),
    headSha
      ? deps.inspectTreeEntries(repository.repoPath, options)
      : Promise.resolve([]),
  ]);
  const remoteUrl = rawRemote ? sanitizeRemoteUrl(rawRemote) : null;
  const coordinates = remoteUrl ? parseGitHubRemote(remoteUrl) : null;
  if (usesLfs) {
    throw new SharedContainerPublishRefusalError(
      'git-lfs',
      `Repository “${repository.repoName}” uses Git LFS, which is not supported for shared worktrees.`,
    );
  }
  const submodulePaths = treeEntries
    .filter((entry) => entry.mode === '160000')
    .map((entry) => entry.path);
  if (submodulePaths.length > 0) {
    const named = submodulePaths.slice(0, MAX_NAMED_REFUSAL_PATHS).join(', ');
    const remaining = submodulePaths.length - MAX_NAMED_REFUSAL_PATHS;
    throw new SharedContainerPublishRefusalError(
      'submodule',
      `Repository “${repository.repoName}” contains unsupported submodules: ${named}${remaining > 0 ? `, and ${remaining} more` : ''}.`,
    );
  }
  const pushedBase =
    headSha && remoteUrl && coordinates
      ? await deps.resolvePushedBase({
          projectId: context.projectId,
          worktreeId: context.worktreeId,
          repoId: repository.repoId,
          repoPath: repository.repoPath,
        })
      : null;
  const snapshot = pushedBase
    ? undefined
    : await deps.buildSnapshot({
        repoPath: repository.repoPath,
        headSha,
      });
  const baseCommitSha = pushedBase?.baseSha ?? snapshot?.baseCommitSha;
  if (!baseCommitSha) {
    throw new Error('Shared-container repository has no publishable base');
  }
  const [rows, committed] = await Promise.all([
    headSha
      ? deps.listDiff(
          repository.repoPath,
          pushedBase?.baseSha ?? headSha,
          options,
        )
      : Promise.resolve([]),
    pushedBase
      ? collectCommittedChanges(context, repository, deps, pushedBase.baseSha)
      : Promise.resolve({}),
  ]);
  const ownUntracked = new Set(untrackedPaths.map(validateRepositoryPath));
  const approved = new Set(
    !headSha && snapshot
      ? []
      : approvalsForRepository(repository, repositories, scope, ownUntracked),
  );
  const untrackedSnapshots: Array<{
    path: string;
    size: bigint;
    ino: bigint;
    mtimeNs: bigint;
  }> = [];
  const candidates: Array<Omit<CodePublishFile, 'source'>> = [];
  const candidateSizeBytesByPath = new Map<string, number>();
  const withheldPaths = new Set<string>();
  const withheldReasons = new Set<SharedContainerWithheldFileReason>();
  const recordWithheld = (
    path: string,
    reason: SharedContainerWithheldFileReason,
  ): void => {
    withheldPaths.add(path);
    withheldReasons.add(reason);
  };
  if (snapshot && snapshot.withheldPaths.length > 0) {
    for (const path of snapshot.withheldPaths) {
      recordWithheld(
        path,
        snapshot.withheldReasons?.[path] ??
          (isCredentialShapedSharedContainerPath(path)
            ? 'credential-shaped'
            : 'symlink-escaping'),
      );
    }
  }
  const changedPaths = new Set(rows.map((row) => row.path));
  for (const entry of treeEntries) {
    if (entry.mode !== '120000' || changedPaths.has(entry.path)) continue;
    const reason =
      entry.symlinkTargetClassification !== undefined
        ? sharedContainerSymlinkWithheldReasonFromClassification(
            entry.symlinkTargetClassification,
          )
        : entry.symlinkTarget === undefined
          ? entry.symlinkEscapesRepository
            ? 'symlink-escaping'
            : undefined
          : sharedContainerSymlinkWithheldReason(
              entry.path,
              entry.symlinkTarget,
            );
    if (reason) {
      recordWithheld(entry.path, reason);
    }
  }
  let canonicalRepoPath: string | undefined;
  const getCanonicalRepoPath = async (): Promise<string> => {
    canonicalRepoPath ??= await realpath(repository.repoPath);
    return canonicalRepoPath;
  };
  for (const row of rows) {
    const path = validateRepositoryPath(row.path);
    const destinationMode = row.dstMode;
    let conflictedPathAbsent = false;
    if (row.status === 'U') {
      try {
        const info = await lstat(join(repository.repoPath, ...path.split('/')));
        conflictedPathAbsent = info.isSymbolicLink() || !info.isFile();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        conflictedPathAbsent = true;
      }
    }
    const deleted =
      row.status === 'D' ||
      conflictedPathAbsent ||
      destinationMode === '160000';
    if (destinationMode === '160000' || row.srcMode === '160000') {
      throw new SharedContainerPublishRefusalError(
        'submodule',
        `Repository “${repository.repoName}” contains an unsupported submodule: ${path}.`,
      );
    }
    if (!deleted && !['100644', '100755', '120000'].includes(destinationMode)) {
      throw new Error(`Unsupported Git file mode ${destinationMode}`);
    }
    if (deleted) {
      await assertExistingDeletedPathContained(
        repository.repoPath,
        await getCanonicalRepoPath(),
        path,
      );
    }
    if (isCredentialShapedSharedContainerPath(path)) {
      recordWithheld(path, 'credential-shaped');
      continue;
    }
    if (!deleted && destinationMode === '120000') {
      const target = await readUtf8SymlinkTarget(
        join(repository.repoPath, ...path.split('/')),
      ).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new SharedContainerPublishInventoryChangedError();
        }
        throw error;
      });
      const symlinkReason = sharedContainerSymlinkWithheldReason(path, target);
      if (symlinkReason) {
        recordWithheld(path, symlinkReason);
        continue;
      }
    }
    let candidateSizeBytes = 0;
    if (!deleted) {
      const absolutePath = join(repository.repoPath, ...path.split('/'));
      const info = await lstat(absolutePath, { bigint: true }).catch(
        (error) => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            throw new SharedContainerPublishInventoryChangedError();
          }
          throw error;
        },
      );
      if (info.isFile() && !info.isSymbolicLink() && info.nlink > BigInt(1)) {
        recordWithheld(path, 'credential-shaped');
        continue;
      }
      if (
        info.isFile() &&
        !info.isSymbolicLink() &&
        info.size > BigInt(MAX_SHARED_CONTAINER_ARTIFACT_BYTES)
      ) {
        recordWithheld(path, 'oversized');
        continue;
      }
      candidateSizeBytes = Number(info.size);
    }
    const existsInSnapshot = !snapshot || snapshot.treeFileSizes.has(path);
    if (deleted && !existsInSnapshot) continue;
    let status: SharedContainerFileStatus;
    if (deleted) status = 'deleted';
    else if (row.status === 'A' || !existsInSnapshot) status = 'added';
    else status = 'modified';
    candidates.push({
      path,
      status,
      mode: deleted ? row.srcMode : destinationMode,
      untracked: false,
    });
    candidateSizeBytesByPath.set(path, candidateSizeBytes);
  }
  for (const path of Array.from(approved)) {
    if (!ownUntracked.has(path)) continue;
    const absolutePath = join(repository.repoPath, ...path.split('/'));
    const info = await lstat(absolutePath, { bigint: true }).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new SharedContainerPublishInventoryChangedError();
      }
      throw error;
    });
    untrackedSnapshots.push({
      path,
      size: info.size,
      ino: info.ino,
      mtimeNs: info.mtimeNs,
    });
    if (isCredentialShapedSharedContainerPath(path)) {
      recordWithheld(path, 'credential-shaped');
      continue;
    }
    if (info.isSymbolicLink()) {
      const target = await readUtf8SymlinkTarget(absolutePath);
      const symlinkReason = sharedContainerSymlinkWithheldReason(path, target);
      if (symlinkReason) {
        recordWithheld(path, symlinkReason);
        continue;
      }
      candidates.push({
        path,
        status: 'added',
        mode: '120000',
        untracked: true,
      });
      candidateSizeBytesByPath.set(path, Number(info.size));
      continue;
    }
    if (!info.isFile() || info.nlink > BigInt(1)) {
      recordWithheld(path, 'credential-shaped');
      continue;
    }
    if (info.size > BigInt(MAX_SHARED_CONTAINER_ARTIFACT_BYTES)) {
      recordWithheld(path, 'oversized');
      continue;
    }
    candidates.push({
      path,
      status: 'added',
      mode:
        process.platform === 'win32' ||
        (info.mode & BigInt(0o111)) === BigInt(0)
          ? '100644'
          : '100755',
      untracked: true,
    });
    candidateSizeBytesByPath.set(path, Number(info.size));
  }
  const unchangedTrackedPaths = new Set(
    treeEntries
      .filter(
        (entry) =>
          entry.type === 'blob' &&
          (entry.mode === '100644' || entry.mode === '100755') &&
          !changedPaths.has(entry.path) &&
          !withheldPaths.has(entry.path) &&
          !isCredentialShapedSharedContainerPath(entry.path),
      )
      .map((entry) => entry.path),
  );
  if (
    !canonicalRepoPath &&
    candidates.some((candidate) => candidate.status !== 'deleted')
  ) {
    canonicalRepoPath = await getCanonicalRepoPath();
  }
  return {
    repository: {
      repoId: repository.repoId,
      repoName: repository.repoName,
      repoPath: repository.repoPath,
      ...(pushedBase && remoteUrl && coordinates
        ? {
            remoteUrl,
            owner: coordinates.owner,
            repository: coordinates.repository,
          }
        : { source: 'snapshot' as const, snapshot }),
      baseCommitSha,
      headSha: pushedBase?.headSha ?? headSha,
      unpushedCommitCount: pushedBase?.unpushedCommitCount ?? 0,
      fingerprint:
        !headSha && snapshot
          ? fingerprintSnapshot(snapshot)
          : fingerprintRows(
              baseCommitSha,
              pushedBase?.headSha ?? headSha ?? baseCommitSha,
              rows,
              untrackedSnapshots,
            ),
      approvedUntrackedPaths: Array.from(approved),
      files: [],
      ...committed,
    },
    ...(canonicalRepoPath ? { canonicalRepoPath } : {}),
    candidates,
    candidateSizeBytesByPath,
    untrackedSnapshots,
    ...(!headSha
      ? {}
      : {
          fingerprintInput: {
            baseSha: baseCommitSha,
            headSha: pushedBase?.headSha ?? headSha,
            rows,
          },
        }),
    withheld: withheldPaths.size,
    withheldReasons: Array.from(withheldReasons),
    unchangedTrackedPaths,
  };
}

function assertCodeRecipientOutputPaths(
  entries: readonly {
    repository: CodePublishRepository;
    candidates: readonly Omit<CodePublishFile, 'source'>[];
  }[],
): void {
  const repositoryIds = createOutputPathDomain();
  for (const entry of entries) {
    repositoryIds.reserve(entry.repository.repoId);
    const repositoryFiles: Array<{
      file: Omit<CodePublishFile, 'source'>;
      path: string;
      key: string;
    }> = [];
    for (const file of entry.candidates) {
      const path = validateMaterializedRelativePath(file.path);
      const key = path.toLocaleLowerCase('en-US');
      for (const existing of repositoryFiles) {
        const currentIsAncestor = existing.key.startsWith(`${key}/`);
        const existingIsAncestor = key.startsWith(`${existing.key}/`);
        const allowedSymlinkTransition =
          (currentIsAncestor &&
            existing.path.startsWith(`${path}/`) &&
            file.mode === '120000' &&
            (file.status === 'deleted') !==
              (existing.file.status === 'deleted')) ||
          (existingIsAncestor &&
            path.startsWith(`${existing.path}/`) &&
            existing.file.mode === '120000' &&
            (existing.file.status === 'deleted') !==
              (file.status === 'deleted'));
        if (
          existing.key === key ||
          ((currentIsAncestor || existingIsAncestor) &&
            !allowedSymlinkTransition)
        ) {
          throw new Error(
            `Shared-container output path collision: ${file.path}`,
          );
        }
      }
      repositoryFiles.push({ file, path, key });
    }
  }
}

async function openCodeFileSource(
  repository: CodePublishRepository,
  canonicalRepoPath: string | undefined,
  file: Omit<CodePublishFile, 'source'>,
  createFileSource: typeof createStableFileSource,
  reserveInspectionBytes: (size: bigint) => void,
): Promise<
  | { file: CodePublishFile; withheldReason?: never }
  | { file?: never; withheldReason: SharedContainerWithheldFileReason }
> {
  if (file.status === 'deleted') return { file };
  if (!canonicalRepoPath) {
    throw new SharedContainerPublishInventoryChangedError();
  }
  const requestedPath = join(repository.repoPath, ...file.path.split('/'));
  if (file.mode === '120000') {
    const before = await lstat(requestedPath, { bigint: true });
    if (!before.isSymbolicLink()) {
      throw new SharedContainerPublishInventoryChangedError();
    }
    const target = await readUtf8SymlinkTarget(requestedPath);
    const after = await lstat(requestedPath, { bigint: true });
    assertStableFile(before, after);
    const symlinkReason = sharedContainerSymlinkWithheldReason(
      file.path,
      target,
    );
    if (symlinkReason) {
      return { withheldReason: symlinkReason };
    }
    const bytes = Buffer.from(target);
    assertArtifactSize(bytes.byteLength);
    reserveInspectionBytes(BigInt(bytes.byteLength));
    return {
      file: {
        ...file,
        source: {
          sizeBytes: bytes.byteLength,
          hash: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
          createReadStream: () => Readable.from(bytes),
        },
      },
    };
  }
  const canonicalPath = await realpath(requestedPath).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new SharedContainerPublishInventoryChangedError();
    }
    throw error;
  });
  assertCanonicalRepositoryPath(canonicalRepoPath, canonicalPath);
  const handle = await openVerifiedFile(requestedPath, canonicalPath);
  try {
    const snapshot = await handle.stat({ bigint: true });
    if (snapshot.nlink > BigInt(1)) {
      return { withheldReason: 'credential-shaped' };
    }
    if (snapshot.size > BigInt(MAX_SHARED_CONTAINER_ARTIFACT_BYTES)) {
      return { withheldReason: 'oversized' };
    }
    reserveInspectionBytes(snapshot.size);
    return {
      file: {
        ...file,
        source: await createFileSource(
          requestedPath,
          canonicalPath,
          handle,
          snapshot,
        ),
      },
    };
  } finally {
    await handle.close();
  }
}

async function captureRepositoryFingerprint(
  repository: CodePublishRepository,
  deps: Pick<
    CodePublishInventoryDependencies,
    'getHead' | 'listDiff' | 'listUntracked' | 'buildSnapshot'
  >,
  signal: AbortSignal,
): Promise<string> {
  const options = strictOptions(signal);
  const head = await deps.getHead(repository.repoPath, options);
  if (head !== repository.headSha) {
    throw new SharedContainerPublishInventoryChangedError();
  }
  if (!head) {
    if (repository.source !== 'snapshot') {
      throw new SharedContainerPublishInventoryChangedError();
    }
    const snapshot = await deps.buildSnapshot({
      repoPath: repository.repoPath,
      headSha: null,
      includeChunkSources: false,
    });
    return fingerprintSnapshot(snapshot);
  }
  const [rows, untrackedPaths] = await Promise.all([
    deps.listDiff(
      repository.repoPath,
      repository.source === 'snapshot' ? head : repository.baseCommitSha,
      options,
    ),
    deps.listUntracked(repository.repoPath, options),
  ]);
  const untracked = new Set(untrackedPaths.map(validateRepositoryPath));
  const selectedSnapshots = await Promise.all(
    repository.approvedUntrackedPaths
      .filter((path) => untracked.has(path))
      .map(async (path) => {
        const info = await lstat(
          join(repository.repoPath, ...path.split('/')),
          {
            bigint: true,
          },
        ).catch((error) => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            throw new SharedContainerPublishInventoryChangedError();
          }
          throw error;
        });
        return {
          path,
          size: info.size,
          ino: info.ino,
          mtimeNs: info.mtimeNs,
        };
      }),
  );
  return fingerprintRows(
    repository.baseCommitSha,
    head,
    rows,
    selectedSnapshots,
  );
}

function publishPlan(
  plan: TrackedPlanData,
  disclosedRepoIds: ReadonlySet<string>,
): SharedContainerPublishedPlan {
  const sourceIsDisclosed =
    plan.sourceRepoId !== undefined && disclosedRepoIds.has(plan.sourceRepoId);
  return redactPublishedValue({
    schemaVersion: 1,
    planId: plan.id,
    title: plan.title,
    content: plan.content,
    source: plan.source,
    reviewStatus: plan.reviewStatus,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
    latestRevisionNumber: plan.latestRevisionNumber,
    ...(plan.approvedAt ? { approvedAt: plan.approvedAt } : {}),
    ...(plan.dismissedAt ? { dismissedAt: plan.dismissedAt } : {}),
    ...(plan.lastEditSource ? { lastEditSource: plan.lastEditSource } : {}),
    ...(sourceIsDisclosed
      ? {
          sourceRepoId: plan.sourceRepoId,
          ...(plan.sourceFilePath
            ? { sourceFilePath: plan.sourceFilePath }
            : {}),
        }
      : {}),
    commentThreads: (plan.commentThreads ?? []).map(
      (thread): WirePlanCommentThread => ({
        id: thread.id,
        status: thread.status,
        createdAt: thread.createdAt,
        anchor: {
          quote: thread.anchor.quote,
          ...(thread.anchor.renderedText !== undefined
            ? { renderedText: thread.anchor.renderedText }
            : {}),
          ...(thread.anchor.lineStart !== undefined
            ? { lineStart: thread.anchor.lineStart }
            : {}),
          ...(thread.anchor.lineEnd !== undefined
            ? { lineEnd: thread.anchor.lineEnd }
            : {}),
          ...(thread.anchor.planNodeId !== undefined
            ? { planNodeId: thread.anchor.planNodeId }
            : {}),
          ...(thread.anchor.headingPath !== undefined
            ? { headingPath: thread.anchor.headingPath }
            : {}),
          ...(thread.anchor.unanchored !== undefined
            ? { unanchored: thread.anchor.unanchored }
            : {}),
          ...(thread.anchor.source !== undefined
            ? { source: thread.anchor.source }
            : {}),
          ...(thread.anchor.diagramKind !== undefined
            ? { diagramKind: thread.anchor.diagramKind }
            : {}),
        },
        anchorState: thread.anchorState,
        comments: thread.comments.map((comment) => ({
          id: comment.id,
          author: comment.author,
          ...(comment.author === 'remote' && comment.remoteAuthor
            ? { remoteAuthor: comment.remoteAuthor }
            : {}),
          body: comment.body,
          createdAt: comment.createdAt,
        })),
      }),
    ),
  });
}

interface BuildCodePublishInventoryInput {
  projectId: string;
  worktreeId: string;
  scope: SharedContainerFileScope;
  runEnabled?: boolean;
}

function repositoryProjectionUsage(
  repository: CodePublishRepository,
  files: readonly Pick<CodePublishFile, 'path' | 'status'>[],
): { files: number; retainedSnapshotBytes: bigint } {
  if (!repository.snapshot) {
    return { files: files.length, retainedSnapshotBytes: BigInt(0) };
  }
  let projectedFiles = repository.snapshot.treeFileCount;
  let retainedSnapshotBytes = repository.snapshot.treeBytes;
  for (const file of files) {
    if (file.status === 'added') projectedFiles += 1;
    if (file.status === 'deleted') projectedFiles -= 1;
    if (file.status !== 'modified' && file.status !== 'deleted') continue;
    const replacedSize = repository.snapshot.treeFileSizes.get(file.path);
    if (replacedSize === undefined) {
      throw new SharedContainerPublishInventoryChangedError();
    }
    retainedSnapshotBytes -= replacedSize;
  }
  if (projectedFiles < 0 || retainedSnapshotBytes < BigInt(0)) {
    throw new SharedContainerPublishInventoryChangedError();
  }
  return { files: projectedFiles, retainedSnapshotBytes };
}

async function buildCodePublishInventoryInternal(
  input: BuildCodePublishInventoryInput,
  deps: CodePublishInventoryDependencies,
): Promise<CodePublishInventory> {
  const controller = new AbortController();
  const repositories = await deps.listRepositories(
    input.projectId,
    input.worktreeId,
  );
  const run = input.runEnabled
    ? await deriveSharedContainerRunConfig(
        input.projectId,
        repositories,
        input.scope,
        deps,
      )
    : undefined;
  const enumerationResults = await mapWithConcurrency(
    repositories,
    REPOSITORY_CONCURRENCY,
    async (
      repository,
    ): Promise<
      | {
          ok: true;
          value: Awaited<ReturnType<typeof enumerateRepository>>;
        }
      | { ok: false; error: unknown }
    > => {
      try {
        return {
          ok: true,
          value: await enumerateRepository(
            { projectId: input.projectId, worktreeId: input.worktreeId },
            repository,
            repositories,
            input.scope,
            deps,
            controller.signal,
          ),
        };
      } catch (error) {
        controller.abort();
        return { ok: false, error };
      }
    },
  );
  const failedEnumeration = enumerationResults.find((result) => !result.ok);
  if (failedEnumeration && !failedEnumeration.ok) {
    throw failedEnumeration.error;
  }
  const enumerated = enumerationResults.map((result) => {
    if (!result.ok) throw result.error;
    return result.value;
  });
  assertCodeRecipientOutputPaths(enumerated);
  const [tabs, planItems, noteItems, promptItems] = await Promise.all([
    deps.readChatTabs(input.projectId, input.worktreeId),
    deps.listPlans(input.projectId, input.worktreeId),
    deps.listNotes(input.projectId),
    deps.listPrompts(input.projectId),
  ]);
  const chats = tabs.tabs.filter((tab) => tab.kind !== 'file');
  const attachmentFiles = await deps.listAttachmentFiles(
    input.projectId,
    input.worktreeId,
    collectCoworkChatAttachmentSourcePaths(chats),
  );
  const excludedNotes = new Set(input.scope.excludedNoteIds ?? []);
  const selectedNoteItems = noteItems.filter(
    (note) =>
      note.origin?.worktreeId === input.worktreeId &&
      !excludedNotes.has(note.id),
  );
  const excludedPrompts = new Set(input.scope.excludedPromptIds ?? []);
  const selectedPromptItems = promptItems.filter(
    (prompt) =>
      prompt.origin?.worktreeId === input.worktreeId &&
      !excludedPrompts.has(prompt.id),
  );
  const disclosedRepoIds = new Set(
    enumerated.map((entry) => entry.repository.repoId),
  );
  const plans = planItems
    .filter((plan) => !plan.hidden)
    .map((plan) => publishPlan(plan, disclosedRepoIds));
  const referencedValues = new Set<string>();
  for (const chat of chats) collectReferencedStrings(chat, referencedValues);
  const untrackedCandidates = enumerated.flatMap((entry) => {
    const prefix = repositories
      .find((repository) => repository.repoId === entry.repository.repoId)
      ?.relativePrefix.normalize('NFC');
    const safePaths = new Set(
      entry.candidates
        .filter((candidate) => candidate.untracked)
        .map((candidate) => candidate.path),
    );
    return entry.untrackedSnapshots.flatMap((snapshot) => {
      if (!safePaths.has(snapshot.path)) return [];
      const scopedPath = prefix ? `${prefix}/${snapshot.path}` : snapshot.path;
      return [
        {
          entry,
          path: scopedPath,
          repositoryPath: snapshot.path,
          sizeBytes: Number(snapshot.size),
          mtimeNs: snapshot.mtimeNs,
        },
      ];
    });
  });
  const isReferenced = (path: string): boolean =>
    Array.from(referencedValues).some(
      (value) => value === path || value.endsWith(`/${path}`),
    );
  untrackedCandidates.sort(
    (left, right) =>
      Number(isReferenced(right.path)) - Number(isReferenced(left.path)) ||
      (right.mtimeNs > left.mtimeNs
        ? 1
        : right.mtimeNs < left.mtimeNs
          ? -1
          : 0) ||
      left.path.localeCompare(right.path),
  );
  let inspectionBytes = 0;
  const reserveInspectionBytes = (size: bigint): void => {
    if (size > BigInt(MAX_SHARED_CONTAINER_REVISION_BYTES - inspectionBytes)) {
      throw new SharedContainerPublishRefusalError(
        'artifact-budget',
        'This revision exceeds the 500 MiB shared-content inspection limit. Commit or narrow the approved scope and try again.',
      );
    }
    inspectionBytes += Number(size);
  };
  const attachments = await mapWithConcurrency(
    attachmentFiles,
    FILE_SOURCE_CONCURRENCY,
    (file: CoworkReferencedAttachmentFile) =>
      deps.openAttachmentFile(file, {
        createFileSource: deps.createFileSource,
        reserveInspectionBytes,
      }),
  );
  const notes = await mapWithConcurrency(
    selectedNoteItems,
    FILE_SOURCE_CONCURRENCY,
    async (note) => {
      const { meta, content, sourceSizeBytes } = await deps.readWorkspaceItem(
        note,
        'note',
        reserveInspectionBytes,
      );
      return {
        meta,
        content: finalizeWorkspaceItemContent(
          content,
          sourceSizeBytes,
          reserveInspectionBytes,
        ),
      };
    },
  );
  const prompts = await mapWithConcurrency(
    selectedPromptItems,
    FILE_SOURCE_CONCURRENCY,
    async (prompt) => {
      const { meta, content, sourceSizeBytes } = await deps.readWorkspaceItem(
        prompt,
        'prompt',
        reserveInspectionBytes,
      );
      return {
        meta,
        content: finalizeWorkspaceItemContent(
          content,
          sourceSizeBytes,
          reserveInspectionBytes,
        ),
      };
    },
  );
  const nonDroppableRevisionBytes = enumerated.reduce(
    (total, entry) => {
      let next = total;
      for (const chunk of entry.repository.snapshot?.chunks ?? []) {
        next = Math.min(
          MAX_SHARED_CONTAINER_REVISION_BYTES,
          next + chunk.sizeBytes,
        );
      }
      for (const candidate of entry.candidates) {
        if (candidate.untracked || candidate.status === 'deleted') continue;
        next = Math.min(
          MAX_SHARED_CONTAINER_REVISION_BYTES,
          next + (entry.candidateSizeBytesByPath.get(candidate.path) ?? 0),
        );
      }
      return next;
    },
    Math.max(
      inspectionBytes,
      getCodeRevisionBaseByteSize({
        chats,
        attachments,
        notes,
        prompts,
        plans,
      }),
    ),
  );
  const nonDroppableArtifactCount =
    1 +
    chats.length +
    attachmentFiles.length +
    selectedNoteItems.length +
    selectedPromptItems.length +
    plans.length +
    enumerated.reduce(
      (count, entry) =>
        count +
        (entry.repository.snapshot?.chunks.length ?? 0) +
        entry.candidates.filter(
          (candidate) => !candidate.untracked && candidate.status !== 'deleted',
        ).length,
      0,
    );
  const remainingUntrackedFiles = Math.max(
    0,
    MAX_SHARED_CONTAINER_ARTIFACTS_PER_REVISION - nonDroppableArtifactCount,
  );
  const selectedUntrackedPaths = new Set(
    selectSharedContainerCandidatePaths(
      'CODE_WORKTREE',
      untrackedCandidates.map((candidate) => candidate.path),
      input.scope,
      remainingUntrackedFiles,
      getCodeCandidateRevisionByteCosts(
        untrackedCandidates.map(({ path }) => path),
        Object.fromEntries(
          untrackedCandidates.map(({ path, sizeBytes }) => [path, sizeBytes]),
        ),
      ),
      Math.max(
        0,
        MAX_SHARED_CONTAINER_REVISION_BYTES - nonDroppableRevisionBytes,
      ),
    ),
  );
  for (const entry of enumerated) {
    const selectedRepositoryPaths = new Set(
      untrackedCandidates
        .filter(
          (candidate) =>
            candidate.entry === entry &&
            selectedUntrackedPaths.has(candidate.path),
        )
        .map((candidate) => candidate.repositoryPath),
    );
    entry.candidates = entry.candidates.filter(
      (candidate) =>
        !candidate.untracked || selectedRepositoryPaths.has(candidate.path),
    );
    entry.repository.approvedUntrackedPaths = Array.from(
      selectedRepositoryPaths,
    );
    if (entry.fingerprintInput) {
      entry.repository.fingerprint = fingerprintRows(
        entry.fingerprintInput.baseSha,
        entry.fingerprintInput.headSha,
        entry.fingerprintInput.rows,
        entry.untrackedSnapshots.filter((snapshot) =>
          selectedRepositoryPaths.has(snapshot.path),
        ),
      );
    }
  }
  const candidateRepositoryUsage = enumerated.reduce(
    (total, entry) => {
      const usage = repositoryProjectionUsage(
        entry.repository,
        entry.candidates,
      );
      return {
        files: total.files + usage.files,
        retainedSnapshotBytes:
          total.retainedSnapshotBytes + usage.retainedSnapshotBytes,
      };
    },
    { files: 0, retainedSnapshotBytes: BigInt(0) },
  );
  const projectedCandidateCount =
    chats.length +
    attachmentFiles.length +
    selectedNoteItems.length +
    selectedPromptItems.length +
    plans.length +
    candidateRepositoryUsage.files;
  if (projectedCandidateCount > MAX_SHARED_CONTAINER_MATERIALIZED_FILES) {
    throw new SharedContainerPublishRefusalError(
      'artifact-budget',
      'This revision exceeds the 1,000-file shared-content limit. Commit or narrow the approved scope and try again.',
    );
  }
  if (
    candidateRepositoryUsage.retainedSnapshotBytes >
    BigInt(MAX_SHARED_CONTAINER_REVISION_BYTES)
  ) {
    throw new SharedContainerPublishRefusalError(
      'artifact-budget',
      'This revision exceeds the 500 MiB shared-content inspection limit. Commit or narrow the approved scope and try again.',
    );
  }
  const materializedEntries = await mapWithConcurrency(
    enumerated,
    REPOSITORY_CONCURRENCY,
    async (entry) => {
      const results = await mapWithConcurrency(
        entry.candidates,
        FILE_SOURCE_CONCURRENCY,
        (file) =>
          openCodeFileSource(
            entry.repository,
            entry.canonicalRepoPath,
            file,
            deps.createFileSource,
            reserveInspectionBytes,
          ),
      );
      return {
        repository: {
          ...entry.repository,
          files: results.flatMap((result) =>
            result.file ? [result.file] : [],
          ),
        },
        withheldReasons: results.flatMap((result) =>
          result.withheldReason ? [result.withheldReason] : [],
        ),
      };
    },
  );
  const materialized = materializedEntries.map((entry) => entry.repository);
  const materializedRepositoryUsage = materialized.reduce(
    (total, repository) => {
      const usage = repositoryProjectionUsage(repository, repository.files);
      return {
        files: total.files + usage.files,
        retainedSnapshotBytes:
          total.retainedSnapshotBytes + usage.retainedSnapshotBytes,
      };
    },
    { files: 0, retainedSnapshotBytes: BigInt(0) },
  );
  const projectedFileCount =
    chats.length +
    attachments.length +
    notes.length +
    prompts.length +
    plans.length +
    materializedRepositoryUsage.files;
  if (projectedFileCount > MAX_SHARED_CONTAINER_MATERIALIZED_FILES) {
    throw new SharedContainerPublishRefusalError(
      'artifact-budget',
      'This revision exceeds the 1,000-file shared-content limit. Commit or narrow the approved scope and try again.',
    );
  }
  if (
    materializedRepositoryUsage.retainedSnapshotBytes +
      BigInt(inspectionBytes) >
    BigInt(MAX_SHARED_CONTAINER_REVISION_BYTES)
  ) {
    throw new SharedContainerPublishRefusalError(
      'artifact-budget',
      'This revision exceeds the 500 MiB shared-content inspection limit. Commit or narrow the approved scope and try again.',
    );
  }
  await Promise.all(
    materialized.map(async (repository) => {
      const fingerprint = await captureRepositoryFingerprint(
        repository,
        deps,
        controller.signal,
      );
      if (fingerprint !== repository.fingerprint) {
        throw new SharedContainerPublishInventoryChangedError();
      }
    }),
  );
  const withheldFileCount = enumerated.reduce(
    (count, entry) => count + entry.withheld,
    materializedEntries.reduce(
      (count, entry) => count + entry.withheldReasons.length,
      0,
    ),
  );
  const withheldFileReasons = Array.from(
    new Set([
      ...enumerated.flatMap((entry) => entry.withheldReasons),
      ...materializedEntries.flatMap((entry) => entry.withheldReasons),
    ]),
  );
  const unchangedTrackedPathsByRepo = new Map(
    enumerated.map((entry) => [
      entry.repository.repoId,
      entry.unchangedTrackedPaths,
    ]),
  );
  const roots = materialized.map((repository) => ({
    repoId: repository.repoId,
    absolutePath: repository.repoPath,
    publishedPaths: new Set([
      ...Array.from(unchangedTrackedPathsByRepo.get(repository.repoId) ?? []),
      ...repository.files
        .filter((file) => file.status !== 'deleted')
        .map((file) => file.path),
      ...(repository.committedFiles ?? []).map((file) => file.path),
    ]),
  }));
  const layout = await readSanitizedSharedContainerPublishedLayout({
    projectId: input.projectId,
    worktreeId: input.worktreeId,
    tabs: tabs.tabs,
    publishedChatIds: new Set(chats.map((chat) => chat.id)),
    // The recipient's checkout holds every tracked file, so a publisher tab
    // on an unchanged file is as reachable as one on a changed file.
    roots,
  });
  const resolvedStartPage = await (
    deps.resolveStartPage ?? resolveProjectStartPage
  )({ projectId: input.projectId, worktreeId: input.worktreeId });
  const startPage = resolvedStartPage
    ? mapProjectStartPageForPublication(resolvedStartPage.startPage, roots)
    : null;
  return {
    chats,
    attachments,
    notes,
    prompts,
    plans,
    repositories: materialized,
    withheldFileCount,
    withheldFileReasons,
    ...(run ? { run } : {}),
    ...(layout ? { layout } : {}),
    ...(startPage ? { startPage } : {}),
  };
}

export async function buildCodePublishInventory(
  input: BuildCodePublishInventoryInput,
  deps: CodePublishInventoryDependencies = DEFAULT_DEPENDENCIES,
): Promise<CodePublishInventory> {
  const snapshots = new Set<SharedContainerCodeSnapshot>();
  try {
    return await buildCodePublishInventoryInternal(input, {
      ...deps,
      buildSnapshot: async (snapshotInput) => {
        const snapshot = await deps.buildSnapshot(snapshotInput);
        snapshots.add(snapshot);
        return snapshot;
      },
    });
  } catch (error) {
    const sources = new Set(
      Array.from(snapshots).flatMap((snapshot) =>
        snapshot.chunks.flatMap((chunk) =>
          chunk.source?.dispose ? [chunk.source] : [],
        ),
      ),
    );
    await Promise.allSettled(
      Array.from(sources, (source) =>
        source.dispose ? source.dispose() : Promise.resolve(),
      ),
    );
    throw error;
  }
}

export async function assertCodePublishInventoryHeadsStable(
  inventory: CodePublishInventory,
  deps: Pick<
    CodePublishInventoryDependencies,
    'getHead' | 'buildSnapshot'
  > = DEFAULT_DEPENDENCIES,
): Promise<void> {
  const controller = new AbortController();
  await Promise.all(
    inventory.repositories.map(async (repository) => {
      const current = await deps.getHead(
        repository.repoPath,
        strictOptions(controller.signal),
      );
      if (current !== repository.headSha) {
        throw new SharedContainerPublishInventoryChangedError();
      }
      if (!current && repository.source === 'snapshot') {
        const snapshot = await deps.buildSnapshot({
          repoPath: repository.repoPath,
          headSha: null,
          includeChunkSources: false,
        });
        if (fingerprintSnapshot(snapshot) !== repository.fingerprint) {
          throw new SharedContainerPublishInventoryChangedError();
        }
      }
    }),
  );
}
