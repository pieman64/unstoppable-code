import {
  ensureWorkspaceWriteDirectory,
  withWorkspaceDirectoryWrite,
} from '../../lib/cowork-folder-guard';
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  rm,
  rmdir,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { AnySharedContainerRevisionLayout } from '@canopy/protocol/shared-containers';
import { MAX_SHARED_CONTAINER_ARTIFACT_BYTES } from '@canopy/protocol/shared-containers';
import { writeChatTabsFile } from '../../lib/chat-tabs';
import { ensureUniqueDestination } from '../../lib/unique-destination';
import { prepareAgentAttachmentsDir } from '../../lib/agent-attachments';
import { getSharedContainerReader } from '../read/reader';
import type { SharedContainerReplicaStore } from '../replica/store';
import {
  resolveMaterializedPath,
  validateMaterializedRelativePath,
} from '../materialize/path-safety';
import type { SharedContainerForkRollback } from './rollback';
import { projectPublishedChatsToTabs } from '../chat-projection';

export async function resolveSafeForkDestination(
  root: string,
  relative: string,
  rollback?: SharedContainerForkRollback,
): Promise<string> {
  const safe = validateMaterializedRelativePath(relative);
  const segments = safe.split('/');
  let current = root;
  await ensureWorkspaceWriteDirectory(root, 0o700);
  for (const segment of segments.slice(0, -1)) {
    current = join(current, segment);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new Error(`Unsafe fork destination parent: ${relative}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await mkdir(current, { mode: 0o700 });
      const createdDirectory = current;
      rollback?.defer(async () => {
        try {
          await rmdir(createdDirectory);
        } catch (rollbackError) {
          if ((rollbackError as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw rollbackError;
          }
        }
      });
    }
  }
  return resolveMaterializedPath(root, safe);
}

export async function writeForkFileFromReplica(options: {
  store: SharedContainerReplicaStore;
  revisionRoot: string;
  source: string;
  destinationRoot: string;
  relativePath: string;
  executable?: boolean;
  rollback?: SharedContainerForkRollback;
}): Promise<string> {
  const target = await resolveSafeForkDestination(
    options.destinationRoot,
    options.relativePath,
    options.rollback,
  );
  try {
    await lstat(target);
    throw new Error(`Fork destination already exists: ${options.relativePath}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const bytes = await options.store.readBoundedFileForRead(
    options.revisionRoot,
    options.source,
    MAX_SHARED_CONTAINER_ARTIFACT_BYTES,
  );
  await withWorkspaceDirectoryWrite(dirname(target), () =>
    writeFile(target, bytes, {
      flag: 'wx',
      mode: options.executable ? 0o700 : 0o600,
    }),
  );
  options.rollback?.defer(() => rm(target, { force: true }));
  await chmod(target, options.executable ? 0o700 : 0o600);
  return target;
}

export async function copyForkAttachments(options: {
  store: SharedContainerReplicaStore;
  revisionRoot: string;
  layout: AnySharedContainerRevisionLayout;
  projectId: string;
  worktreeId: string;
  rollback: SharedContainerForkRollback;
}): Promise<Map<string, string>> {
  const destinationDir = await prepareAgentAttachmentsDir(
    options.projectId,
    options.worktreeId,
    0o700,
  );
  await ensureWorkspaceWriteDirectory(destinationDir, 0o700);
  const resolved = new Map<string, string>();
  for (const [reference, attachment] of Object.entries(
    options.layout.attachmentPaths,
  )) {
    if (
      basename(attachment.displayName) !== attachment.displayName ||
      validateMaterializedRelativePath(attachment.displayName).includes('/')
    ) {
      throw new Error('Shared-container attachment name is not portable');
    }
    const target = await ensureUniqueDestination(
      destinationDir,
      attachment.displayName,
    );
    const bytes = await options.store.readBoundedFileForRead(
      options.revisionRoot,
      options.store.resolvePathBelowForRead(
        options.revisionRoot,
        'content',
        'attachments',
        attachment.displayName,
      ),
      MAX_SHARED_CONTAINER_ARTIFACT_BYTES,
    );
    await withWorkspaceDirectoryWrite(destinationDir, () =>
      writeFile(target, bytes, { flag: 'wx', mode: 0o600 }),
    );
    options.rollback.defer(() => rm(target, { force: true }));
    resolved.set(reference, target);
    resolved.set(attachment.artifactId, target);
  }
  return resolved;
}

export async function rehydrateForkChats(options: {
  containerId: string;
  revisionId: string;
  projectId: string;
  worktreeId: string;
  attachments: ReadonlyMap<string, string>;
}): Promise<string[]> {
  const publishedChats = await getSharedContainerReader().readForkChats({
    containerId: options.containerId,
    revisionId: options.revisionId,
  });
  if (publishedChats.length === 0) return [];
  const { tabs, warnings } = projectPublishedChatsToTabs({
    publishedChats,
    projectId: options.projectId,
    worktreeId: options.worktreeId,
    resolveAttachment: (reference) => options.attachments.get(reference),
  });
  const activeTab = tabs[0];
  if (!activeTab) return warnings;
  await writeChatTabsFile(options.projectId, options.worktreeId, {
    version: 1,
    tabs,
    activeTabId: activeTab.id,
  });
  return warnings;
}

export async function assertNoPublishedPlans(
  store: SharedContainerReplicaStore,
  revisionRoot: string,
): Promise<void> {
  const plansDir = store.resolvePathBelowForRead(
    revisionRoot,
    'content',
    'plans',
  );
  try {
    const names = await readdir(plansDir);
    if (names.length > 0) {
      throw new Error('Cowork shared-container revisions cannot contain plans');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
