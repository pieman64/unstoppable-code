/** Captured, checkpointed child ownership. This never publishes parent rows. */
import { createHash } from 'node:crypto';
import { copyFile, mkdir, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PersistedChatMessage } from '@canopy/desktop-shared/types';
import type {
  TranscriptStreamRegistration,
  TranscriptTarget,
} from '@canopy/protocol/canopy-core';
import {
  type ChatTranscriptLog,
  TranscriptStreamStore,
} from '../chat-transcript-log';
import type { CreatedArtifacts } from '../chat-transcript-artifacts';
import {
  delegationStreamKey,
  delegationTranscriptPaths,
} from '../transcript-stream-paths';
import { isErrnoException } from '../type-guards';
import { fsyncDirectory } from '../fsync-directory';
import {
  encodeStreamCatalog,
  encodeStreamDescriptor,
  encodeStreamRegistry,
  loadStreamCatalog,
  loadStreamRegistry,
  publishStagedStreamMetadata,
  publishStreamMetadata,
  streamCatalogPath,
  streamDescriptorAnswerReferences,
  streamRegistryPaths,
  validateStreamTarget,
  UnknownTranscriptStreamError,
} from './stream-registry';

type ChildTarget = Extract<TranscriptTarget, { kind: 'delegation' }>;
export interface StreamCopyParent {
  sourceChatId: string;
  targetChatId: string;
  rows: () =>
    | AsyncIterable<PersistedChatMessage>
    | Iterable<PersistedChatMessage>;
}
export interface SelectedStreamCopy {
  parent: StreamCopyParent;
  entries: TranscriptStreamRegistration[];
}

export class StreamClosureCopyRefusalError extends Error {
  public constructor(
    public readonly code:
      | 'unsupported_destination'
      | 'indexed_destination'
      | 'stream_collision'
      | 'source_deleted',
    message: string,
  ) {
    super(message);
    this.name = 'StreamClosureCopyRefusalError';
  }
}

/** Includes cards stored in block pages; an unknown card is not a registration. */
export async function keptStreamTargets(
  log: ChatTranscriptLog,
  parent: StreamCopyParent,
): Promise<ChildTarget[]> {
  const targets = new Map<string, ChildTarget>();
  for await (const row of parent.rows()) {
    const logical = row.blocksRef
      ? await log.artifacts.expandBlocks(parent.sourceChatId, row)
      : row;
    for (const block of logical.blocks)
      if (
        block.type === 'delegated_agent_call' &&
        block.transcriptStore === 'chat-stream-v2'
      ) {
        const target: ChildTarget = {
          kind: 'delegation',
          chatId: parent.sourceChatId,
          delegationId: block.delegationId,
          runGeneration: block.runGeneration,
        };
        targets.set(delegationStreamKey(target), target);
      }
  }
  return Array.from(targets.values());
}

/** Read-only selection: unrelated parents and already-dangling cards are ignored. */
export async function selectStreamClosure(
  root: string,
  log: ChatTranscriptLog,
  parents: readonly StreamCopyParent[],
): Promise<SelectedStreamCopy[]> {
  const catalog = await loadStreamCatalog(root);
  const selected: SelectedStreamCopy[] = [];
  for (const parent of parents) {
    const targets = await keptStreamTargets(log, parent);
    if (!targets.length || !catalog.parents[parent.sourceChatId]) continue;
    const registry = await loadStreamRegistry(root, parent.sourceChatId, {
      readOnly: true,
    });
    for (const target of targets) {
      try {
        await validateStreamTarget(root, catalog, target, {
          readOnly: true,
          deep: false,
        });
      } catch (error) {
        if (!(error instanceof UnknownTranscriptStreamError)) throw error;
      }
    }
    const keys = new Set(targets.map(delegationStreamKey));
    const entries = registry.entries.filter((entry) =>
      keys.has(entry.streamKey),
    );
    if (entries.length) selected.push({ parent, entries });
  }
  return selected;
}

async function optionalSnapshot(path: string): Promise<Buffer | undefined> {
  try {
    return await readFile(path);
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

/** copyChats hashes captured stream coordinates, never scope-local replay authority. */
export async function capturedStreamIdentity(
  root: string,
  log: ChatTranscriptLog,
  parents: readonly StreamCopyParent[],
): Promise<unknown[]> {
  const catalog = await loadStreamCatalog(root);
  const identities: unknown[] = [];
  for (const { parent, entries } of await selectStreamClosure(
    root,
    log,
    parents,
  ))
    for (const entry of entries
      .slice()
      .sort((a, b) => a.streamKey.localeCompare(b.streamKey))) {
      const descriptor = await validateStreamTarget(
        root,
        catalog,
        entry.target,
        { readOnly: true },
      );
      const paths = delegationTranscriptPaths(root, entry.target);
      const snapshot = await optionalSnapshot(
        paths.file(entry.streamKey, 'active.json'),
      );
      identities.push([
        parent.targetChatId,
        entry.target,
        descriptor.streamRevision,
        descriptor.committedSha256,
        descriptor.committedRowCount,
        descriptor.committedByteLength,
        snapshot ? createHash('sha256').update(snapshot).digest('hex') : null,
        descriptor.cardState,
      ]);
    }
  return identities;
}

/** File bytes are unchanged; only metadata passes through the existing codecs. */
async function copyStreamFile(
  source: string,
  destination: string,
): Promise<void> {
  const staged = `${destination}.checkpoint`;
  await copyFile(source, staged);
  const handle = await open(staged, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await publishStagedStreamMetadata(staged, destination);
}

/**
 * Pin -> validate -> every artifact -> files -> registry -> catalog -> release.
 * The returned synchronous check must be chained into the row WAL's beforePublish.
 * Failure deliberately leaves stream orphans for recovered-index pruning, never
 * attempts cleanup against a possibly published row transaction.
 */
export async function copyStreamClosure(options: {
  sourceRoot: string;
  destinationRoot: string;
  source: ChatTranscriptLog;
  destination: ChatTranscriptLog;
  selected: readonly SelectedStreamCopy[];
  created: CreatedArtifacts;
  copyPrimary: (
    parent: StreamCopyParent,
    row: PersistedChatMessage,
  ) => Promise<void>;
}): Promise<() => void> {
  const {
    sourceRoot,
    destinationRoot,
    source,
    destination,
    selected,
    created,
  } = options;
  if (!selected.length) return (): void => {};
  const leases = new Map<string, { generation: number; release: () => void }>();
  const check = (): void => {
    for (const [chatId, lease] of Array.from(leases))
      if (source.childDeleteFence.isDeleted(chatId, lease.generation))
        throw new StreamClosureCopyRefusalError(
          'source_deleted',
          'Child stream source parent was deleted',
        );
  };
  try {
    for (const { parent } of selected) {
      if (leases.has(parent.sourceChatId)) continue;
      const lease = source.childDeleteFence.acquire(parent.sourceChatId);
      if (!lease)
        throw new StreamClosureCopyRefusalError(
          'source_deleted',
          'Child stream source parent was deleted',
        );
      leases.set(parent.sourceChatId, lease);
    }
    const sourceCatalog = await loadStreamCatalog(sourceRoot);
    const catalog = await loadStreamCatalog(destinationRoot);
    const streams = [];
    for (const selection of selected) {
      for (const entry of selection.entries) {
        const descriptor = await validateStreamTarget(
          sourceRoot,
          sourceCatalog,
          entry.target,
          { readOnly: true },
        );
        const child = new TranscriptStreamStore(
          delegationTranscriptPaths(sourceRoot, entry.target),
          source.artifacts,
          undefined,
          { readOnly: true, childMode: true },
        );
        // Validate the open snapshot as well as the committed log before staging.
        await child.activeMessages(entry.streamKey);
        streams.push({ selection, entry, descriptor, child });
      }
    }
    const visit = async (
      parent: StreamCopyParent,
      row: PersistedChatMessage,
      copy: boolean,
    ): Promise<void> => {
      for await (const reference of source.artifacts.referenceClosure(
        parent.sourceChatId,
        row,
      )) {
        if (copy)
          await source.artifacts.copyToChat(
            parent.sourceChatId,
            parent.targetChatId,
            reference,
            destination.artifacts,
            created,
          );
        else await source.artifacts.verify(parent.sourceChatId, reference);
      }
    };
    // First prove known closure, then copy it; no metadata before every artifact.
    for (const copy of [false, true]) {
      for (const { parent } of selected)
        for await (const row of parent.rows()) {
          await visit(parent, row, copy);
          if (copy) await options.copyPrimary(parent, row);
        }
      for (const {
        selection: { parent },
        entry,
        descriptor,
        child,
      } of streams) {
        for await (const row of child.iterate(entry.streamKey))
          await visit(parent, row, copy);
        for (const row of await child.activeMessages(entry.streamKey))
          await visit(parent, row, copy);
        // Both canonical card reference fields are enumerated by the shared helper.
        for (const reference of streamDescriptorAnswerReferences(descriptor)) {
          if (copy)
            await source.artifacts.copyToChat(
              parent.sourceChatId,
              parent.targetChatId,
              reference,
              destination.artifacts,
              created,
            );
          else await source.artifacts.verify(parent.sourceChatId, reference);
        }
      }
    }
    for (const { parent, entries } of selected) {
      destination.childDeleteFence.restore(parent.targetChatId);
      const registrations: TranscriptStreamRegistration[] = [];
      for (const entry of entries) {
        const target = { ...entry.target, chatId: parent.targetChatId };
        const streamKey = delegationStreamKey(target);
        const old = streamRegistryPaths(
          sourceRoot,
          parent.sourceChatId,
          entry.streamKey,
        );
        const paths = streamRegistryPaths(
          destinationRoot,
          parent.targetChatId,
          streamKey,
        );
        const descriptor = await validateStreamTarget(
          sourceRoot,
          sourceCatalog,
          entry.target,
          { readOnly: true },
        );
        await mkdir(paths.streamDirectory, { recursive: true });
        await copyStreamFile(old.log, paths.log);
        const sourcePaths = delegationTranscriptPaths(sourceRoot, entry.target);
        const snapshot = await optionalSnapshot(
          sourcePaths.file(entry.streamKey, 'active.json'),
        );
        if (snapshot)
          await publishStreamMetadata(
            delegationTranscriptPaths(destinationRoot, target).file(
              streamKey,
              'active.json',
            ),
            snapshot,
          );
        await publishStreamMetadata(
          paths.descriptor,
          encodeStreamDescriptor({
            ...descriptor,
            target,
            streamKey,
            checkpointRevision: catalog.checkpointRevision,
          }),
        );
        await fsyncDirectory(paths.streamDirectory);
        registrations.push({
          ...entry,
          target,
          streamKey,
          registeredAtRevision: catalog.checkpointRevision,
        });
      }
      const bytes = encodeStreamRegistry(
        parent.targetChatId,
        catalog.checkpointRevision,
        registrations,
      );
      const paths = streamRegistryPaths(
        destinationRoot,
        parent.targetChatId,
        registrations[0].streamKey,
      );
      await publishStreamMetadata(paths.registry, bytes);
      await fsyncDirectory(paths.parentDirectory);
      await fsyncDirectory(
        join(destinationRoot, 'delegations', parent.targetChatId),
      );
      catalog.parents[parent.targetChatId] = {
        entryCount: registrations.length,
        registryBytes: bytes.length,
        registrySha256: createHash('sha256').update(bytes).digest('hex'),
      };
    }
    // Persist every new owner/stream directory entry before the catalog can
    // name it. A crash at catalog publication must leave a complete orphan.
    await fsyncDirectory(join(destinationRoot, 'delegations'));
    await fsyncDirectory(destinationRoot);
    check();
    await publishStreamMetadata(
      streamCatalogPath(destinationRoot),
      encodeStreamCatalog(catalog),
    );
    await fsyncDirectory(join(destinationRoot, 'delegations'));
    await fsyncDirectory(destinationRoot);
    return check;
  } finally {
    for (const lease of Array.from(leases.values())) lease.release();
  }
}
