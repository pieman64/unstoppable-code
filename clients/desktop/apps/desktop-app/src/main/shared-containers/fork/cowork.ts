import { createHash } from 'node:crypto';
import type { W5CommitOptions } from '../../lib/w5-commit-scope';
import type { W5KeyedAttempt } from '../../lib/w5-keyed-operation';
import { withWorkspaceCreationCommit } from '../../lib/w5-workspace-creation-commit';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { getCoworkManagedSubdir } from '@canopy/desktop-shared/node/lib/cowork-managed-dir';
import type {
  SharedContainerForkProvenance,
  SharedContainerForkRequest,
  SharedContainerForkResponse,
  SharedContainerRevisionLayout,
  SharedContainerRevisionLayoutV3,
  SharedContainerRevisionLayoutV4,
  SharedContainerStartPage,
  SharedContainerRevisionLayoutV5,
} from '@canopy/protocol/shared-containers';
import type { ProjectStartPage } from '@canopy/protocol/start-page';
import { MAX_SHARED_CONTAINER_ARTIFACT_BYTES } from '@canopy/protocol/shared-containers';
import {
  createCoworkWorkspace,
  updateCoworkWorkspace,
} from '../../lib/cowork-workspace-crud';
import {
  createWorkEntry,
  removeWorkEntryRow,
} from '../../lib/cowork-work-entries';
import { getCoworkWorkspaceRootDir } from '../../lib/paths';
import { readAllSidebarItems } from '../../lib/sidebar-items';
import { deleteWorkspaceById } from '../../lib/workspace-deletion';
import { cleanupPersistedWorktreeData } from '../../lib/worktree-data-cleanup';
import { ensureAgentsMdSymlinkOrCopy } from '../../lib/instruction-files';
import {
  readNote,
  readPrompt,
  saveNote,
  savePrompt,
} from '../../lib/standalone-workspace-files';
import type { SharedContainerReplicaStore } from '../replica/store';
import {
  assertNoPublishedPlans,
  copyForkAttachments,
  rehydrateForkChats,
  writeForkFileFromReplica,
} from './finalize';
import {
  deleteForkWorkspaceOrHide,
  runWithSharedContainerForkRollback,
} from './rollback';
import { writeForkProvenanceForDestination } from './provenance';

export function mapCoworkForkStartPage(
  startPage: SharedContainerStartPage,
): ProjectStartPage {
  return startPage.kind === 'url'
    ? startPage
    : { kind: 'file', path: startPage.relativePath };
}

function sourceScopedWorkspaceItemId(
  kind: 'notes' | 'prompts',
  sourceContainerId: string,
  sourceRevisionId: string,
  itemId: string,
): string {
  const suffix = createHash('sha256')
    .update(`${kind}\0${sourceContainerId}\0${sourceRevisionId}\0${itemId}`)
    .digest('hex')
    .slice(0, 12);
  return `${itemId.slice(0, 200)}-${suffix}`;
}

async function resolveCoworkWorkspace(
  request: SharedContainerForkRequest,
  title: string,
  commit?: W5CommitOptions,
  attempt?: W5KeyedAttempt,
): Promise<{ workspaceId: string; created: boolean }> {
  if (request.destination.kind === 'new-workspace') {
    const workspace = await (commit
      ? withWorkspaceCreationCommit(
          commit,
          () => createCoworkWorkspace(title),
          attempt?.beforeEffects,
        )
      : createCoworkWorkspace(title));
    return { workspaceId: workspace.id, created: true };
  }
  const workspaceId = request.destination.workspaceId;
  const workspace = (
    await readAllSidebarItems(
      commit?.expectedRevisions || attempt
        ? { persistRemovalCleanup: false }
        : undefined,
    )
  ).items.find((item) => item.id === workspaceId);
  if (!workspace || workspace.type !== 'cowork') {
    throw new Error('Fork destination must be a Cowork workspace');
  }
  return { workspaceId: workspace.id, created: false };
}

export async function copyForkWorkspaceItems(options: {
  store: SharedContainerReplicaStore;
  revisionRoot: string;
  layout:
    | SharedContainerRevisionLayout
    | SharedContainerRevisionLayoutV3
    | SharedContainerRevisionLayoutV4
    | SharedContainerRevisionLayoutV5;
  workspaceId: string;
  sourceContainerId: string;
  sourceRevisionId: string;
  rollback: { defer(action: () => Promise<unknown>): void };
}): Promise<void> {
  const root = getCoworkWorkspaceRootDir(options.workspaceId);
  for (const [kind, items] of [
    ['notes', options.layout.notes],
    ['prompts', options.layout.prompts],
  ] as const) {
    for (const item of items) {
      const destinationItemId = sourceScopedWorkspaceItemId(
        kind,
        options.sourceContainerId,
        options.sourceRevisionId,
        item.itemId,
      );
      const content = (
        await options.store.readBoundedFileForRead(
          options.revisionRoot,
          options.store.resolvePathBelowForRead(
            options.revisionRoot,
            'content',
            kind,
            `${item.itemId}.md`,
          ),
          MAX_SHARED_CONTAINER_ARTIFACT_BYTES,
        )
      ).toString('utf8');
      try {
        const existing =
          kind === 'notes'
            ? await readNote(options.workspaceId, destinationItemId)
            : await readPrompt(options.workspaceId, destinationItemId);
        if (existing.content !== content) {
          throw new Error(
            `Fork ${kind} item collides with local item ${destinationItemId}`,
          );
        }
        continue;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (kind === 'notes') {
        await saveNote(
          options.workspaceId,
          item.title,
          content,
          destinationItemId,
          { preserveId: true },
        );
      } else {
        await savePrompt(
          options.workspaceId,
          item.title,
          content,
          destinationItemId,
          { preserveId: true },
        );
      }
      const target = join(
        getCoworkManagedSubdir(root, kind),
        `${destinationItemId}.md`,
      );
      options.rollback.defer(() => rm(target, { force: true }));
    }
  }
}

export async function forkSharedCoworkContainer(options: {
  request: SharedContainerForkRequest;
  provenance: SharedContainerForkProvenance;
  revisionRoot: string;
  layout:
    | SharedContainerRevisionLayout
    | SharedContainerRevisionLayoutV3
    | SharedContainerRevisionLayoutV4
    | SharedContainerRevisionLayoutV5;
  store: SharedContainerReplicaStore;
  commit?: W5CommitOptions;
  attempt?: W5KeyedAttempt;
}): Promise<SharedContainerForkResponse> {
  if (options.layout.containerType !== 'COWORK_WORK_ENTRY') {
    throw new Error('Shared-container fork type mismatch');
  }
  await assertNoPublishedPlans(options.store, options.revisionRoot);
  return runWithSharedContainerForkRollback(async (rollback) => {
    const workspace = await resolveCoworkWorkspace(
      options.request,
      options.layout.title,
      options.commit,
      options.attempt,
    );
    if (workspace.created) {
      rollback.defer(() =>
        deleteForkWorkspaceOrHide(
          { source: 'cowork_fork', workspaceId: workspace.workspaceId },
          () =>
            deleteWorkspaceById(workspace.workspaceId, 'shared_container_fork'),
        ),
      );
      if ('startPage' in options.layout && options.layout.startPage) {
        const startPage = mapCoworkForkStartPage(options.layout.startPage);
        await updateCoworkWorkspace(
          {
            projectId: workspace.workspaceId,
            startPage,
          },
          options.commit,
        );
      }
    }
    options.attempt?.beforeEffects();
    const created = await createWorkEntry(workspace.workspaceId, {
      title: options.layout.title,
    });
    if (!workspace.created) {
      // Finalize commits the rehydrated chats into canonical v2 storage
      // (`chat-storage-v2/{entryId}/` + its manifest) through the chat state
      // service, so the rollback must reclaim the same closure the Work Entry
      // deletion path does: dispose the loaded scope, drop its search docs,
      // and remove worktree-data — not just the legacy file paths.
      rollback.defer(() =>
        cleanupPersistedWorktreeData(workspace.workspaceId, created.entry.id),
      );
      rollback.defer(() =>
        removeWorkEntryRow(workspace.workspaceId, created.entry.id),
      );
    }
    const destinationRoot = getCoworkWorkspaceRootDir(workspace.workspaceId);
    const publishedRootFiles = new Set(
      options.layout.files.map((file) => file.path),
    );
    if (workspace.created) {
      for (const scaffoldName of ['CLAUDE.md', 'AGENTS.md'] as const) {
        if (publishedRootFiles.has(scaffoldName)) {
          await rm(join(destinationRoot, scaffoldName), {
            recursive: true,
            force: true,
          });
        }
      }
    }
    for (const file of options.layout.files) {
      if (file.status === 'deleted') {
        throw new Error('Cowork fork cannot contain deleted files');
      }
      await writeForkFileFromReplica({
        store: options.store,
        revisionRoot: options.revisionRoot,
        source: options.store.resolvePathBelowForRead(
          options.revisionRoot,
          'content',
          file.path,
        ),
        destinationRoot,
        relativePath: file.path,
        rollback,
      });
    }
    if (
      workspace.created &&
      publishedRootFiles.has('CLAUDE.md') &&
      !publishedRootFiles.has('AGENTS.md')
    ) {
      await ensureAgentsMdSymlinkOrCopy(destinationRoot);
    }
    await copyForkWorkspaceItems({
      store: options.store,
      revisionRoot: options.revisionRoot,
      layout: options.layout,
      workspaceId: workspace.workspaceId,
      sourceContainerId: options.provenance.sourceContainerId,
      sourceRevisionId: options.provenance.sourceRevisionId,
      rollback,
    });
    const attachments = await copyForkAttachments({
      store: options.store,
      revisionRoot: options.revisionRoot,
      layout: options.layout,
      projectId: workspace.workspaceId,
      worktreeId: created.entry.id,
      rollback,
    });
    const warnings = await rehydrateForkChats({
      containerId: options.request.containerId,
      revisionId: options.request.revisionId,
      projectId: workspace.workspaceId,
      worktreeId: created.entry.id,
      attachments,
    });
    await writeForkProvenanceForDestination(
      workspace.workspaceId,
      created.entry.id,
      options.provenance,
    );
    return {
      containerType: 'COWORK_WORK_ENTRY',
      projectId: workspace.workspaceId,
      worktreeId: created.entry.id,
      warnings,
      provenance: options.provenance,
    };
  });
}
