import { fileScopeIsAllowlist } from '@canopy/desktop-shared/lib/shared-container-scope-mode';
import {
  COWORK_WORKSPACE_FILE_ROOT_ID,
  type PersistedChatMessage,
} from '@canopy/desktop-shared/types';
import { type BigIntStats, type Stats } from 'node:fs';
import { lstat, realpath, type FileHandle } from 'node:fs/promises';
import { basename, join, relative, resolve, sep } from 'node:path';
import type {
  ChatTabsFile,
  PersistedChatTab,
  SharedContainerFileScope,
  StandaloneNoteMeta,
  StandalonePromptSnippetMeta,
} from '@canopy/desktop-shared/types';
import { isVisiblePersistedChatMessage } from '@canopy/agent-transcript';
import {
  MAX_SHARED_CONTAINER_ARTIFACTS_PER_REVISION,
  MAX_SHARED_CONTAINER_REVISION_BYTES,
  type SharedContainerPublishedLayout,
  type SharedContainerStartPage,
} from '@canopy/protocol/shared-containers';
import {
  getCoworkManagedDirCandidates,
  getCoworkManagedSubdir,
} from '@canopy/desktop-shared/node/lib/cowork-managed-dir';
import { getCoworkWorkspaceRootDir } from '../../lib/paths';
import { storedArtifactRefsOf } from '../../lib/chat-artifact-references';
import { resolveAgentAttachmentsDir } from '../../lib/agent-attachments';
import { readChatTabsFileForIndex } from '../../lib/chat-tabs-reader';
import { resolveCoworkWorkspaceId } from '../../lib/cowork-migration-map';
import {
  listNotes,
  listPrompts,
  readNote,
  readPrompt,
} from '../../lib/standalone-workspace-files';
import { validateMaterializedRelativePath } from '../materialize/path-safety';
import {
  addToRevisionSize,
  assertArtifactSize,
  assertStableFile,
  createStableFileSource,
  openVerifiedFile,
  SharedContainerPublishInventoryChangedError,
  type PublishFileSource,
} from './source-files';
import {
  listCoworkCandidateFiles,
  selectCoworkCandidatePaths,
  type CoworkCandidateFiles,
} from './cowork-files';
import {
  getCoworkCandidateRevisionByteCosts,
  getCoworkFileRevisionByteCost,
  getCoworkPublishContentSize,
  getCoworkRevisionBaseByteSize,
  getCoworkWithheldFileCountRevisionByteCost,
} from './cowork-artifacts';
import { readSanitizedSharedContainerPublishedLayout } from './layout';
import { resolveProjectStartPage } from '../../lib/project-start-page';
import { mapProjectStartPageForPublication } from './start-page';

export type CoworkPublishFileSource = PublishFileSource;

export interface CoworkPublishBinaryItem {
  displayName: string;
  sourcePath?: string;
  sourcePaths?: string[];
  bytes?: Buffer;
  source?: CoworkPublishFileSource;
}

export interface CoworkPublishFile {
  path: string;
  bytes?: Buffer;
  source?: CoworkPublishFileSource;
}

export interface CoworkPublishNote {
  meta: StandaloneNoteMeta;
  content?: string;
  source?: CoworkPublishFileSource;
}

export interface CoworkPublishPrompt {
  meta: StandalonePromptSnippetMeta;
  content?: string;
  source?: CoworkPublishFileSource;
}

export interface CoworkPublishInventory {
  chats: PersistedChatTab[];
  attachments: CoworkPublishBinaryItem[];
  notes: CoworkPublishNote[];
  prompts: CoworkPublishPrompt[];
  files: CoworkPublishFile[];
  /** Safe aggregate only; withheld paths never enter the revision. */
  withheldFileCount?: number;
  layout?: SharedContainerPublishedLayout;
  startPage?: SharedContainerStartPage;
}

export interface CoworkPublishInventoryDependencies {
  readChatTabs: (
    projectId: string,
    worktreeId: string,
  ) => Promise<ChatTabsFile>;
  listAttachments: (
    projectId: string,
    worktreeId: string,
    sourcePaths: readonly string[],
  ) => Promise<CoworkPublishBinaryItem[]>;
  listNotes: (projectId: string) => Promise<StandaloneNoteMeta[]>;
  readNote: (projectId: string, noteId: string) => Promise<CoworkPublishNote>;
  readNoteSource?: (
    projectId: string,
    note: StandaloneNoteMeta,
  ) => Promise<CoworkPublishNote | null>;
  listPrompts: (projectId: string) => Promise<StandalonePromptSnippetMeta[]>;
  readPrompt: (
    projectId: string,
    promptId: string,
  ) => Promise<CoworkPublishPrompt>;
  readPromptSource?: (
    projectId: string,
    prompt: StandalonePromptSnippetMeta,
  ) => Promise<CoworkPublishPrompt | null>;
  readWorkspaceFile: (
    projectId: string,
    path: string,
    sourcePath?: string,
  ) => Promise<CoworkPublishFile | null>;
  listCoworkCandidateFiles?: (
    projectId: string,
    worktreeId: string,
    requiredPaths?: readonly string[],
  ) => Promise<CoworkCandidateFiles>;
  resolveStartPage?: typeof resolveProjectStartPage;
}

async function findPromptBodyOffset(
  handle: FileHandle,
  snapshot: BigIntStats,
): Promise<number> {
  const scan = async (): Promise<number> => {
    const opening: number[] = [];
    const closing = [10, 45, 45, 45];
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let readPosition = 0;
    let offset = 0;
    let openingComplete = false;
    let closingMatch = 0;
    let closingEnd: number | undefined;
    let pendingClosingCr = false;
    while (true) {
      const { bytesRead } = await handle.read(
        chunk,
        0,
        chunk.byteLength,
        readPosition,
      );
      if (bytesRead === 0) break;
      readPosition += bytesRead;
      for (let index = 0; index < bytesRead; index += 1) {
        const byte = chunk[index];
        if (!openingComplete) {
          opening.push(byte);
          offset += 1;
          if (opening.length === 4) {
            if (
              opening[0] === 45 &&
              opening[1] === 45 &&
              opening[2] === 45 &&
              opening[3] === 10
            ) {
              openingComplete = true;
            } else if (opening[3] !== 13) {
              return 0;
            }
          } else if (opening.length === 5) {
            if (
              opening[0] === 45 &&
              opening[1] === 45 &&
              opening[2] === 45 &&
              opening[3] === 13 &&
              opening[4] === 10
            ) {
              openingComplete = true;
            } else {
              return 0;
            }
          }
          continue;
        }
        if (closingEnd !== undefined) {
          if (pendingClosingCr) {
            return byte === 10 ? offset + 1 : closingEnd;
          }
          if (byte === 10) return offset + 1;
          if (byte === 13) {
            pendingClosingCr = true;
            offset += 1;
            continue;
          }
          return closingEnd;
        }
        closingMatch =
          byte === closing[closingMatch]
            ? closingMatch + 1
            : byte === 10
              ? 1
              : 0;
        offset += 1;
        if (closingMatch === closing.length) closingEnd = offset;
      }
    }
    return closingEnd ?? 0;
  };
  const offset = await scan();
  assertStableFile(snapshot, await handle.stat({ bigint: true }));
  return offset;
}

async function readManagedWorkspaceItemSource(
  projectId: string,
  kind: 'notes' | 'prompts',
  meta: StandaloneNoteMeta | StandalonePromptSnippetMeta,
): Promise<CoworkPublishFileSource | null> {
  const root = getCoworkWorkspaceRootDir(resolveCoworkWorkspaceId(projectId));
  const requestedPath = join(
    getCoworkManagedSubdir(root, kind),
    `${meta.id}.md`,
  );
  let info: Stats;
  try {
    info = await lstat(requestedPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`Selected Cowork ${kind} item is not a file: ${meta.id}`);
  }
  let canonicalPath: string;
  try {
    canonicalPath = await realpath(requestedPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new SharedContainerPublishInventoryChangedError();
    }
    throw error;
  }
  let handle: FileHandle;
  try {
    handle = await openVerifiedFile(requestedPath, canonicalPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new SharedContainerPublishInventoryChangedError();
    }
    throw error;
  }
  try {
    const snapshot = await handle.stat({ bigint: true });
    const startOffset =
      kind === 'prompts' ? await findPromptBodyOffset(handle, snapshot) : 0;
    const source = await createStableFileSource(
      requestedPath,
      canonicalPath,
      handle,
      snapshot,
      startOffset,
    );
    assertArtifactSize(source.sizeBytes);
    return source;
  } finally {
    await handle.close();
  }
}

async function readNoteSource(
  projectId: string,
  note: StandaloneNoteMeta,
): Promise<CoworkPublishNote | null> {
  const source = await readManagedWorkspaceItemSource(projectId, 'notes', note);
  return source ? { meta: note, source } : null;
}

async function readPromptSource(
  projectId: string,
  prompt: StandalonePromptSnippetMeta,
): Promise<CoworkPublishPrompt | null> {
  const source = await readManagedWorkspaceItemSource(
    projectId,
    'prompts',
    prompt,
  );
  return source ? { meta: prompt, source } : null;
}

export async function readChatTabs(
  projectId: string,
  worktreeId: string,
): Promise<ChatTabsFile> {
  let metadata: ChatTabsFile;
  try {
    metadata = await readChatTabsFileForIndex(projectId, worktreeId);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { version: 1, tabs: [], activeTabId: '' };
    }
    throw error;
  }
  const tabs: PersistedChatTab[] = [];
  let minimumRevisionBytes = 0;
  for (const tab of metadata.tabs) {
    if (!tab.transcript) {
      tabs.push(tab);
      continue;
    }
    if (tab.kind === 'file') {
      tabs.push({ ...tab, messages: [] });
      continue;
    }
    // Defer the heavy state service until canonical transcripts are published.
    const { getChatStateService } =
      await import('../../services/chat-state-service');
    const service = getChatStateService();
    // Refuse an impossible remote artifact before allocating its full body.
    // Publication has explicit per-file/revision budgets; refusal preserves
    // every local byte and never publishes a shortened transcript.
    await service.consumeTranscript(
      { projectId, worktreeId },
      tab.id,
      false,
      async (rows) => {
        let minimumChatBytes = 0;
        for await (const message of rows)
          for (const block of message.blocks) {
            // Visual bytes are not published.
            const minimum =
              block.type === 'tool_result'
                ? storedArtifactRefsOf(block).reduce(
                    (bytes, reference) =>
                      reference.family === 'tool-output'
                        ? bytes + reference.reference.byteLength
                        : bytes,
                    0,
                  )
                : block.type === 'text'
                  ? Buffer.byteLength(block.text)
                  : 0;
            minimumChatBytes += minimum;
            assertArtifactSize(minimumChatBytes);
            minimumRevisionBytes = addToRevisionSize(
              minimumRevisionBytes,
              minimum,
            );
          }
      },
      { inlineDelegationChildren: true },
    );
    const messages = await service.consumeTranscript(
      { projectId, worktreeId },
      tab.id,
      true,
      async (rows) => {
        const result: PersistedChatMessage[] = [];
        for await (const message of rows) result.push(message);
        return result;
      },
      { inlineDelegationChildren: true },
    );
    const copy = { ...tab, messages };
    delete copy.transcript;
    delete copy.transcriptWindow;
    delete copy.transcriptLoaded;
    tabs.push(copy);
  }
  return { ...metadata, tabs };
}

export function collectCoworkChatAttachmentSourcePaths(
  chats: readonly PersistedChatTab[],
): string[] {
  return Array.from(
    new Set(
      chats.flatMap((chat) =>
        chat.messages
          .filter(isVisiblePersistedChatMessage)
          .flatMap((message) => message.attachmentPaths ?? []),
      ),
    ),
  ).sort();
}

export interface CoworkReferencedAttachmentFile {
  displayName: string;
  requestedPath: string;
  absolutePath: string;
  sourcePaths: string[];
  size: number;
}

export interface OpenCoworkReferencedAttachmentOptions {
  createFileSource?: typeof createStableFileSource;
  reserveInspectionBytes?: (size: bigint) => void;
}

export async function listCoworkReferencedAttachmentFiles(
  projectId: string,
  worktreeId: string,
  sourcePaths: readonly string[],
): Promise<CoworkReferencedAttachmentFile[]> {
  const configuredDirectory = resolveAgentAttachmentsDir(projectId, worktreeId);
  let directory: string;
  try {
    directory = await realpath(configuredDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const filesByCanonicalPath = new Map<
    string,
    CoworkReferencedAttachmentFile
  >();
  for (const sourcePath of sourcePaths) {
    const candidatePath = resolve(configuredDirectory, sourcePath);
    const candidateRelative = relative(configuredDirectory, candidatePath);
    if (
      !candidateRelative ||
      candidateRelative.startsWith(`..${sep}`) ||
      candidateRelative.includes(sep)
    ) {
      continue;
    }
    try {
      const candidateInfo = await lstat(candidatePath);
      if (!candidateInfo.isFile() || candidateInfo.isSymbolicLink()) continue;
      const canonicalPath = await realpath(candidatePath);
      const canonicalRelative = relative(directory, canonicalPath);
      if (
        !canonicalRelative ||
        canonicalRelative.startsWith(`..${sep}`) ||
        canonicalRelative.includes(sep)
      ) {
        continue;
      }
      const existing = filesByCanonicalPath.get(canonicalPath);
      if (existing) {
        existing.sourcePaths.push(sourcePath);
      } else {
        filesByCanonicalPath.set(canonicalPath, {
          displayName: basename(canonicalPath),
          requestedPath: candidatePath,
          absolutePath: canonicalPath,
          sourcePaths: [sourcePath],
          size: candidateInfo.size,
        });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return Array.from(filesByCanonicalPath.values()).sort((left, right) =>
    left.displayName.localeCompare(right.displayName),
  );
}

export async function listAttachments(
  projectId: string,
  worktreeId: string,
  sourcePaths: readonly string[],
): Promise<CoworkPublishBinaryItem[]> {
  const files = await listCoworkReferencedAttachmentFiles(
    projectId,
    worktreeId,
    sourcePaths,
  );
  const attachments: CoworkPublishBinaryItem[] = [];
  let totalBytes = 0;
  for (const file of files) {
    const attachment = await openCoworkReferencedAttachment(file);
    totalBytes = addToRevisionSize(
      totalBytes,
      getCoworkPublishContentSize(attachment),
    );
    attachments.push(attachment);
  }
  return attachments;
}

export async function openCoworkReferencedAttachment(
  file: CoworkReferencedAttachmentFile,
  options: OpenCoworkReferencedAttachmentOptions = {},
): Promise<CoworkPublishBinaryItem> {
  const handle = await openVerifiedFile(file.requestedPath, file.absolutePath);
  try {
    const info = await handle.stat({ bigint: true });
    const size = Number(info.size);
    assertArtifactSize(size);
    options.reserveInspectionBytes?.(info.size);
    return {
      displayName: file.displayName,
      sourcePath: file.sourcePaths[0],
      sourcePaths: file.sourcePaths,
      source: await (options.createFileSource ?? createStableFileSource)(
        file.requestedPath,
        file.absolutePath,
        handle,
        info,
      ),
    };
  } finally {
    await handle.close();
  }
}

async function readWorkspaceFile(
  projectId: string,
  path: string,
  sourcePath = path,
): Promise<CoworkPublishFile | null> {
  const safePath = validateMaterializedRelativePath(path);
  if (validateMaterializedRelativePath(sourcePath) !== safePath) {
    throw new Error(
      `Cowork source path does not match its output path: ${path}`,
    );
  }
  const root = await realpath(
    resolve(getCoworkWorkspaceRootDir(resolveCoworkWorkspaceId(projectId))),
  );
  const absolutePath = resolve(root, ...sourcePath.split('/'));
  if (!absolutePath.startsWith(`${root}${sep}`)) {
    throw new Error(`Approved Cowork file escaped its project: ${path}`);
  }
  if (
    getCoworkManagedDirCandidates(root).some(
      (managedDir) =>
        absolutePath === managedDir ||
        absolutePath.startsWith(`${managedDir}${sep}`),
    )
  ) {
    throw new Error(
      `Managed Cowork metadata cannot be shared as a file: ${path}`,
    );
  }
  let info: Stats;
  try {
    info = await lstat(absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`Approved Cowork path is not a file: ${path}`);
  }
  let canonicalPath: string;
  try {
    canonicalPath = await realpath(absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new SharedContainerPublishInventoryChangedError();
    }
    throw error;
  }
  if (!canonicalPath.startsWith(`${root}${sep}`)) {
    throw new Error(`Approved Cowork file escaped its project: ${path}`);
  }
  const canonicalManagedDirs = await Promise.all(
    getCoworkManagedDirCandidates(root).map(async (managedDir) => {
      try {
        return await realpath(managedDir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return managedDir;
        }
        throw error;
      }
    }),
  );
  if (
    canonicalManagedDirs.some(
      (managedDir) =>
        canonicalPath === managedDir ||
        canonicalPath.startsWith(`${managedDir}${sep}`),
    )
  ) {
    throw new Error(
      `Managed Cowork metadata cannot be shared as a file: ${path}`,
    );
  }
  let handle: FileHandle;
  try {
    handle = await openVerifiedFile(absolutePath, canonicalPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new SharedContainerPublishInventoryChangedError();
    }
    throw error;
  }
  try {
    const canonicalInfo = await handle.stat({ bigint: true });
    if (!canonicalInfo.isFile()) {
      throw new Error(`Approved Cowork path is not a file: ${path}`);
    }
    if (canonicalInfo.nlink > BigInt(1)) {
      throw new SharedContainerPublishInventoryChangedError();
    }
    assertArtifactSize(Number(canonicalInfo.size));
    return {
      path: safePath,
      source: await createStableFileSource(
        absolutePath,
        canonicalPath,
        handle,
        canonicalInfo,
      ),
    };
  } finally {
    await handle.close();
  }
}

const DEFAULT_DEPENDENCIES: CoworkPublishInventoryDependencies = {
  readChatTabs,
  listAttachments,
  listNotes,
  readNote,
  readNoteSource,
  listPrompts,
  readPrompt,
  readPromptSource,
  readWorkspaceFile,
  listCoworkCandidateFiles,
  resolveStartPage: resolveProjectStartPage,
};

type CoworkPublishBaseInventory = Omit<
  CoworkPublishInventory,
  'files' | 'layout'
> & { layoutTabs: PersistedChatTab[] };

async function buildCoworkPublishBaseInventory(
  input: {
    projectId: string;
    worktreeId: string;
    scope: SharedContainerFileScope;
  },
  deps: CoworkPublishInventoryDependencies,
): Promise<CoworkPublishBaseInventory> {
  const [chatTabs, noteMetas, promptMetas] = await Promise.all([
    deps.readChatTabs(input.projectId, input.worktreeId),
    deps.listNotes(input.projectId),
    deps.listPrompts(input.projectId),
  ]);
  const chats = chatTabs.tabs.filter((tab) => tab.kind !== 'file');
  const attachments = await deps.listAttachments(
    input.projectId,
    input.worktreeId,
    collectCoworkChatAttachmentSourcePaths(chats),
  );
  let selectedContentBytes = 0;
  for (const attachment of attachments) {
    const size = getCoworkPublishContentSize(attachment);
    assertArtifactSize(size);
    selectedContentBytes = addToRevisionSize(selectedContentBytes, size);
  }
  const excludedNotes = new Set(input.scope.excludedNoteIds ?? []);
  const notes: CoworkPublishNote[] = [];
  for (const noteMeta of noteMetas) {
    if (excludedNotes.has(noteMeta.id)) continue;
    const item = deps.readNoteSource
      ? await deps.readNoteSource(input.projectId, noteMeta)
      : await deps.readNote(input.projectId, noteMeta.id);
    if (!item) continue;
    const size =
      item.source?.sizeBytes ?? Buffer.byteLength(item.content ?? '');
    assertArtifactSize(size);
    selectedContentBytes = addToRevisionSize(selectedContentBytes, size);
    notes.push(item);
  }
  const excludedPrompts = new Set(input.scope.excludedPromptIds ?? []);
  const prompts: CoworkPublishPrompt[] = [];
  for (const promptMeta of promptMetas) {
    if (excludedPrompts.has(promptMeta.id)) continue;
    const item = deps.readPromptSource
      ? await deps.readPromptSource(input.projectId, promptMeta)
      : await deps.readPrompt(input.projectId, promptMeta.id);
    if (!item) continue;
    const size =
      item.source?.sizeBytes ?? Buffer.byteLength(item.content ?? '');
    assertArtifactSize(size);
    selectedContentBytes = addToRevisionSize(selectedContentBytes, size);
    prompts.push(item);
  }
  return { chats, attachments, notes, prompts, layoutTabs: chatTabs.tabs };
}

export async function measureCoworkRevisionBaseBytes(
  input: {
    projectId: string;
    worktreeId: string;
    scope: SharedContainerFileScope;
  },
  deps: CoworkPublishInventoryDependencies = DEFAULT_DEPENDENCIES,
): Promise<number> {
  return getCoworkRevisionBaseByteSize(
    await buildCoworkPublishBaseInventory(input, deps),
  );
}

export async function buildCoworkPublishInventory(
  input: {
    projectId: string;
    worktreeId: string;
    scope: SharedContainerFileScope;
  },
  deps: CoworkPublishInventoryDependencies = DEFAULT_DEPENDENCIES,
): Promise<CoworkPublishInventory> {
  const { chats, attachments, notes, prompts, layoutTabs } =
    await buildCoworkPublishBaseInventory(input, deps);
  const files: CoworkPublishFile[] = [];
  const legacyAllowlist = fileScopeIsAllowlist(
    'COWORK_WORK_ENTRY',
    input.scope,
  );
  const candidateResult = deps.listCoworkCandidateFiles
    ? await deps.listCoworkCandidateFiles(
        input.projectId,
        input.worktreeId,
        legacyAllowlist ? input.scope.includedPaths : [],
      )
    : {
        paths: legacyAllowlist ? input.scope.includedPaths : [],
        withheldFileCount: 0,
      };
  let totalBytes = addToRevisionSize(
    getCoworkRevisionBaseByteSize({ chats, attachments, notes, prompts }),
    getCoworkWithheldFileCountRevisionByteCost(
      candidateResult.withheldFileCount,
    ),
  );
  const remainingArtifactBudget = Math.max(
    0,
    MAX_SHARED_CONTAINER_ARTIFACTS_PER_REVISION -
      (1 + chats.length + attachments.length + notes.length + prompts.length),
  );
  const selectedFilePaths = selectCoworkCandidatePaths(
    candidateResult.paths,
    input.scope,
    remainingArtifactBudget,
    getCoworkCandidateRevisionByteCosts(
      candidateResult.paths,
      candidateResult.sizeBytesByPath,
    ),
    Math.max(0, MAX_SHARED_CONTAINER_REVISION_BYTES - totalBytes),
  );
  for (const path of selectedFilePaths) {
    const file = await deps.readWorkspaceFile(
      input.projectId,
      path,
      candidateResult.sourcePathByPath?.[path],
    );
    if (!file) continue;
    const size = getCoworkPublishContentSize(file);
    assertArtifactSize(size);
    const revisionByteCost = getCoworkFileRevisionByteCost(path, size);
    if (
      !legacyAllowlist &&
      totalBytes + revisionByteCost > MAX_SHARED_CONTAINER_REVISION_BYTES
    ) {
      break;
    }
    totalBytes = addToRevisionSize(totalBytes, revisionByteCost);
    files.push(file);
  }
  const roots = [
    {
      repoId: COWORK_WORKSPACE_FILE_ROOT_ID,
      absolutePath: getCoworkWorkspaceRootDir(
        resolveCoworkWorkspaceId(input.projectId),
      ),
      publishedPaths: new Set(files.map((file) => file.path)),
    },
  ];
  const layout = await readSanitizedSharedContainerPublishedLayout({
    projectId: input.projectId,
    worktreeId: input.worktreeId,
    tabs: layoutTabs,
    publishedChatIds: new Set(chats.map((chat) => chat.id)),
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
    files,
    ...(layout ? { layout } : {}),
    ...(startPage ? { startPage } : {}),
    ...(candidateResult.withheldFileCount > 0
      ? { withheldFileCount: candidateResult.withheldFileCount }
      : {}),
  };
}
