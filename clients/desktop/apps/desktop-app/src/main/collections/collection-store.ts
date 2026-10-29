import {
  resourceContextEnabled,
  resourceContextSnapshot,
  assertResourceContextSnapshot,
} from '../lib/resource-context';
import {
  assertInstalledResourceContext,
  recordResourceInstall,
} from '../lib/resource-install-context';
import { getSharedCollection } from './canopy-server-client';
import {
  recordSharedItemInstall,
  recordSharedItemUninstall,
} from '../canopy-cloud/shared-item-subscriptions';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type {
  CollectionConfig,
  CollectionConfigFile,
  CollectionIndexEntry,
  CollectionIndexFile,
} from '@canopy/desktop-shared/types/collections';
import type {
  BundleConfig,
  BundleConfigFile,
  BundlesIndexFile,
} from '@canopy/desktop-shared/types/bundles';
import {
  getBundleConfigFilePath,
  getBundlesIndexFilePath,
  getCollectionConfigFilePath,
  getCollectionsIndexFilePath,
} from '../lib/paths';
import { isErrnoException } from '../lib/type-guards';
import { notifyDesktopInventoryChanged } from '../services/desktop-inventory-sync-signals';
import { classifyInstalledResourceOrigin } from '../lib/resource-install-context';
import {
  parseShareRemoteMetadata,
  type ShareRemoteMetadata,
} from '@canopy/protocol/sharing';

const SAFE_ID_RE = /^[a-f0-9-]+$/;

function toIndexEntry(collection: CollectionConfig): CollectionIndexEntry {
  return {
    id: collection.id,
    name: collection.name,
    description: collection.description,
    updatedAt: collection.updatedAt,
    skillCount: collection.skills.length,
    pluginCount: collection.plugins.length,
    mcpServerCount: collection.mcpServers.length,
    hasExistingShare: Boolean(collection.remote),
  };
}

function fromLegacyBundle(bundle: BundleConfig): CollectionConfig {
  return {
    id: bundle.id,
    name: bundle.name,
    description: bundle.description,
    skills: bundle.skills,
    plugins: bundle.plugins,
    mcpServers: Array.isArray(bundle.mcpServers) ? bundle.mcpServers : [],
    createdAt: bundle.createdAt,
    updatedAt: bundle.updatedAt,
  };
}

async function readCollectionIndexFile(): Promise<CollectionIndexFile | null> {
  try {
    const raw = await readFile(getCollectionsIndexFilePath(), 'utf8');
    const parsed = JSON.parse(raw) as CollectionIndexFile;
    if (parsed.version !== 2 || !Array.isArray(parsed.collections)) {
      return { version: 2, collections: [] };
    }
    return parsed;
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') {
      return null;
    }
    throw new Error(
      `Malformed collections/index.json: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function readLegacyBundleIndexFile(): Promise<BundlesIndexFile | null> {
  try {
    const raw = await readFile(getBundlesIndexFilePath(), 'utf8');
    const parsed = JSON.parse(raw) as BundlesIndexFile;
    if (parsed.version !== 1 || !Array.isArray(parsed.bundles)) {
      return { version: 1, bundles: [] };
    }
    return parsed;
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') {
      return null;
    }
    return { version: 1, bundles: [] };
  }
}

async function readLegacyBundleConfig(
  id: string,
): Promise<CollectionConfig | null> {
  try {
    const raw = await readFile(getBundleConfigFilePath(id), 'utf8');
    const parsed = JSON.parse(raw) as BundleConfigFile;
    if (parsed.version !== 1 || !parsed.bundle) {
      throw new Error(`Invalid bundle config for ${id}`);
    }
    return fromLegacyBundle(parsed.bundle);
  } catch (error) {
    process.emitWarning(
      `Skipping malformed legacy bundle config ${id}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}

async function writeCollectionIndexFile(
  collections: CollectionIndexEntry[],
): Promise<void> {
  const filePath = getCollectionsIndexFilePath();
  await mkdir(dirname(filePath), { recursive: true });
  const payload: CollectionIndexFile = { version: 2, collections };
  await writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8');
  // The index is what the portal (and the cloud inventory sync) projects.
  notifyDesktopInventoryChanged(['collections']);
}

async function writeCollectionConfigFile(
  collection: CollectionConfig,
): Promise<CollectionConfigFile> {
  const filePath = getCollectionConfigFilePath(collection.id);
  await mkdir(dirname(filePath), { recursive: true });
  const payload: CollectionConfigFile = { version: 2, collection };
  await writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8');
  return payload;
}

async function migrateLegacyBundles(): Promise<CollectionIndexFile> {
  const legacyIndex = await readLegacyBundleIndexFile();
  if (!legacyIndex) {
    return { version: 2, collections: [] };
  }

  const collections: CollectionConfig[] = [];
  for (const entry of legacyIndex.bundles) {
    const collection = await readLegacyBundleConfig(entry.id);
    if (collection) {
      collections.push(collection);
      await writeCollectionConfigFile(collection);
    }
  }

  const indexFile: CollectionIndexFile = {
    version: 2,
    collections: collections.map(toIndexEntry),
  };
  await writeCollectionIndexFile(indexFile.collections);
  return indexFile;
}

async function readCollectionIndexUnfiltered(): Promise<CollectionIndexFile> {
  const currentIndex = await readCollectionIndexFile();
  if (currentIndex) {
    const hasLegacyEntries = currentIndex.collections.some(
      (entry) => typeof entry.hasExistingShare !== 'boolean',
    );
    if (!hasLegacyEntries) return currentIndex;

    const collections = await Promise.all(
      currentIndex.collections.map(async (entry) => {
        if (typeof entry.hasExistingShare === 'boolean') return entry;
        const file = await readCollectionConfigUnfiltered(entry.id, false);
        return {
          ...entry,
          hasExistingShare: Boolean(file?.collection.remote),
        };
      }),
    );
    await writeCollectionIndexFile(collections);
    return { ...currentIndex, collections };
  }
  return migrateLegacyBundles();
}

async function readCollectionConfigUnfiltered(
  id: string,
  recoverLegacy = true,
): Promise<CollectionConfigFile | null> {
  if (!id || !SAFE_ID_RE.test(id)) {
    throw new Error(`Invalid Collection id: ${id}`);
  }

  try {
    const raw = await readFile(getCollectionConfigFilePath(id), 'utf8');
    const parsed = JSON.parse(raw) as CollectionConfigFile;
    if (parsed.version !== 2 || !parsed.collection) {
      throw new Error(`Invalid Collection config for ${id}`);
    }
    const remote = parseShareRemoteMetadata(parsed.collection.remote);
    return {
      version: 2,
      collection: {
        ...parsed.collection,
        mcpServers: Array.isArray(parsed.collection.mcpServers)
          ? parsed.collection.mcpServers
          : [],
        ...(remote ? { remote } : {}),
      },
    };
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') {
      if (!recoverLegacy) return null;
      await readCollectionIndexUnfiltered();
      try {
        const raw = await readFile(getCollectionConfigFilePath(id), 'utf8');
        const parsed = JSON.parse(raw) as CollectionConfigFile;
        return parsed.version === 2 && parsed.collection ? parsed : null;
      } catch {
        return null;
      }
    }
    throw error;
  }
}

/** Inventory for the background policy resolver, including legacy migration.
 * The caller must authorize both the collection origin and its members before use.
 */
export async function readCollectionConfigForBackgroundAuthorization(
  id: string,
): Promise<CollectionConfigFile | null> {
  return readCollectionConfigUnfiltered(id);
}

async function authorizeCollectionSource(
  id: string,
  source: NonNullable<CollectionConfig['sharedSource']>,
  verifyHash = false,
): Promise<void> {
  if (source.fromPublicShare) {
    const { getPublicCollectionShareSnapshot } =
      await import('../canopy-cloud/public-share-client');
    const snapshot = await getPublicCollectionShareSnapshot(source.remoteId);
    if (
      verifyHash &&
      source.contentHash &&
      snapshot.contentHash !== source.contentHash
    ) {
      throw new Error('The shared collection changed. Open the link again.');
    }
    await recordResourceInstall(
      'collections',
      {
        id: snapshot.externalId,
        contentHash: snapshot.contentHash,
        owner: { shareScope: 'private' },
        shareScope: 'private',
      },
      [id],
      'public-share',
    );
  } else {
    const detail = await getSharedCollection(source.remoteId);
    await recordResourceInstall('collections', detail, [id]);
  }
}

type CollectionSharedSource = NonNullable<CollectionConfig['sharedSource']>;

function collectionSubscriptionSourceKind(
  source: CollectionSharedSource,
): 'shared' | 'public' {
  return source.fromPublicShare === true ? 'public' : 'shared';
}

function unregisterCollectionInstall(
  id: string,
  source: CollectionSharedSource | undefined,
): void {
  if (!source) return;
  recordSharedItemUninstall({
    kind: 'collection',
    remoteId: source.remoteId,
    sourceKind: collectionSubscriptionSourceKind(source),
    localId: id,
  });
}

/**
 * Every Collection installed from a share, across all contexts, for the
 * one-time install subscription backfill. Reads provenance only.
 */
export async function listCollectionSharedSourcesForBackfill(): Promise<
  Array<{ id: string; sharedSource: CollectionSharedSource }>
> {
  const index = await readCollectionIndexUnfiltered();
  const installs: Array<{ id: string; sharedSource: CollectionSharedSource }> =
    [];
  for (const entry of index.collections) {
    // One unreadable Collection must not hide the others.
    const sharedSource = await readCollectionConfigUnfiltered(entry.id).then(
      (file) => file?.collection.sharedSource,
      () => undefined,
    );
    if (sharedSource) installs.push({ id: entry.id, sharedSource });
  }
  return installs;
}

export async function readCollectionConfig(
  id: string,
): Promise<CollectionConfigFile | null> {
  if (!resourceContextEnabled()) return readCollectionConfigUnfiltered(id);
  const snapshot = await resourceContextSnapshot();
  await assertInstalledResourceContext('collections', id, getSharedCollection);
  const file = await readCollectionConfigUnfiltered(id);
  if (file?.collection.sharedSource) {
    await authorizeCollectionSource(id, file.collection.sharedSource);
  }
  await assertResourceContextSnapshot(snapshot);
  return file;
}

export async function readCollectionIndex(): Promise<CollectionIndexFile> {
  const index = await readCollectionIndexUnfiltered();
  if (!resourceContextEnabled()) return index;
  const snapshot = await resourceContextSnapshot();
  const allowed = await Promise.all(
    index.collections.map(async (entry): Promise<boolean> => {
      try {
        return (await readCollectionConfig(entry.id)) !== null;
      } catch {
        return false;
      }
    }),
  );
  await assertResourceContextSnapshot(snapshot);
  return {
    ...index,
    collections: index.collections.filter((_entry, i) => allowed[i]),
  };
}

/** Read one Collection through the context-independent Personal sync view. */
export async function readPersonalCollectionConfig(
  id: string,
): Promise<CollectionConfigFile | null> {
  const file = await readCollectionConfigUnfiltered(id);
  if (!file) return null;
  const origin = await classifyInstalledResourceOrigin('collections', id);
  if (origin === 'excluded') return null;
  if (
    resourceContextEnabled() &&
    origin === 'local' &&
    file.collection.sharedSource
  ) {
    return null;
  }
  return file;
}

/** Read the Collection index through the Personal sync view. */
export async function readPersonalCollectionIndex(): Promise<CollectionIndexFile> {
  const index = await readCollectionIndexUnfiltered();
  const allowed = await Promise.all(
    index.collections.map(
      async (entry) => (await readPersonalCollectionConfig(entry.id)) !== null,
    ),
  );
  return {
    ...index,
    collections: index.collections.filter((_entry, index) => allowed[index]),
  };
}

export async function saveCollectionConfig(
  input: Partial<CollectionConfig> & { name: string },
  onPrepared?: (collection: CollectionConfig) => void,
): Promise<CollectionConfig> {
  const now = new Date().toISOString();
  const id = input.id || randomUUID();
  if (!SAFE_ID_RE.test(id)) {
    throw new Error(`Invalid Collection id: ${id}`);
  }
  if (!input.name || !input.name.trim()) {
    throw new Error('Collection name is required');
  }
  const existing = input.id
    ? await readCollectionConfigUnfiltered(input.id)
    : null;

  const remote = input.remote ?? existing?.collection.remote;
  const sharedSource = input.sharedSource ?? existing?.collection.sharedSource;
  const collection: CollectionConfig = {
    id,
    name: input.name.trim(),
    description: input.description ?? '',
    skills: Array.isArray(input.skills) ? input.skills : [],
    plugins: Array.isArray(input.plugins) ? input.plugins : [],
    mcpServers: Array.isArray(input.mcpServers) ? input.mcpServers : [],
    createdAt: input.id && input.createdAt ? input.createdAt : now,
    updatedAt: now,
    ...(remote ? { remote } : {}),
    ...(sharedSource ? { sharedSource } : {}),
  };

  for (const skill of collection.skills) {
    if (
      typeof skill.sourceId !== 'string' ||
      typeof skill.skillName !== 'string'
    ) {
      throw new Error('Invalid skill reference in Collection');
    }
  }
  for (const plugin of collection.plugins) {
    if (
      typeof plugin.marketplaceId !== 'string' ||
      typeof plugin.pluginName !== 'string'
    ) {
      throw new Error('Invalid plugin reference in Collection');
    }
  }
  for (const mcpServer of collection.mcpServers) {
    if (
      typeof mcpServer.serverId !== 'string' ||
      typeof mcpServer.configId !== 'string' ||
      !SAFE_ID_RE.test(mcpServer.serverId) ||
      !SAFE_ID_RE.test(mcpServer.configId)
    ) {
      throw new Error('Invalid MCP server reference in Collection');
    }
  }

  onPrepared?.(collection);
  if (resourceContextEnabled()) {
    const snapshot = await resourceContextSnapshot();
    if (input.id) await readCollectionConfig(input.id);
    else
      await assertInstalledResourceContext(
        'collections',
        id,
        getSharedCollection,
      );
    if (sharedSource) {
      await authorizeCollectionSource(id, sharedSource, !existing);
    }
    await assertResourceContextSnapshot(snapshot);
  }

  await writeCollectionConfigFile(collection);

  const index = await readCollectionIndexUnfiltered();
  const nextEntries = index.collections.filter((entry) => entry.id !== id);
  nextEntries.push(toIndexEntry(collection));
  await writeCollectionIndexFile(nextEntries);

  // Only an install or update names its source; a local edit carries it over.
  if (input.sharedSource) {
    recordSharedItemInstall({
      kind: 'collection',
      remoteId: input.sharedSource.remoteId,
      sourceKind: collectionSubscriptionSourceKind(input.sharedSource),
      contentHash: input.sharedSource.contentHash ?? null,
      localId: id,
    });
  }

  return collection;
}

/** Persist the author-side cloud link beside a local Collection. */
export async function writeCollectionRemoteMetadata(
  id: string,
  remote: ShareRemoteMetadata,
): Promise<boolean> {
  const file = await readCollectionConfigUnfiltered(id);
  if (!file) return false;
  const collection = {
    ...file.collection,
    remote: { ...remote },
  };
  const index = await readCollectionIndexUnfiltered();
  await writeCollectionConfigFile(collection);
  try {
    await writeCollectionIndexFile(
      index.collections.map((entry) =>
        entry.id === id ? toIndexEntry(collection) : entry,
      ),
    );
  } catch (error) {
    await writeCollectionConfigFile(file.collection);
    throw error;
  }
  return true;
}

/** Clear every local Collection linked to the deleted cloud share. */
export async function clearCollectionRemoteMetadataByRemoteId(
  remoteId: string,
): Promise<number> {
  const index = await readCollectionIndexUnfiltered();
  const nextEntries = [...index.collections];
  const changedCollections: CollectionConfig[] = [];
  let count = 0;
  try {
    for (
      let entryIndex = 0;
      entryIndex < index.collections.length;
      entryIndex += 1
    ) {
      const entry = index.collections[entryIndex];
      if (!entry) continue;
      const file = await readCollectionConfigUnfiltered(entry.id);
      if (file?.collection.remote?.remoteId !== remoteId) continue;
      const collection = { ...file.collection };
      delete collection.remote;
      await writeCollectionConfigFile(collection);
      changedCollections.push(file.collection);
      nextEntries[entryIndex] = toIndexEntry(collection);
      count += 1;
    }
    if (count > 0) await writeCollectionIndexFile(nextEntries);
  } catch (error) {
    for (const collection of changedCollections) {
      await writeCollectionConfigFile(collection);
    }
    throw error;
  }
  return count;
}

export async function deleteCollectionConfig(id: string): Promise<void> {
  if (!id || !SAFE_ID_RE.test(id)) {
    throw new Error(`Invalid Collection id: ${id}`);
  }

  if (resourceContextEnabled()) await readCollectionConfig(id);
  // Read before the file goes: it is the only record of the install source.
  // An unreadable file never blocks the delete.
  const sharedSource = await readCollectionConfigUnfiltered(id, false).then(
    (file) => file?.collection.sharedSource,
    () => undefined,
  );

  try {
    await unlink(getCollectionConfigFilePath(id));
  } catch {
    // Missing files are fine; index cleanup remains authoritative.
  }

  const index = await readCollectionIndexUnfiltered();
  await writeCollectionIndexFile(
    index.collections.filter((entry) => entry.id !== id),
  );
  unregisterCollectionInstall(id, sharedSource);
}

/** Only a main-owned aborted install may remove its exact local write. No cloud grant is needed. */
export async function rollbackNewCollectionInstall(
  expected: CollectionConfig,
  initial?: CollectionConfig,
): Promise<void> {
  const assertOwnWrite = async (): Promise<void> => {
    const file = await readCollectionConfigUnfiltered(expected.id);
    if (
      file &&
      JSON.stringify(file.collection) !== JSON.stringify(expected) &&
      (!initial ||
        initial.id !== expected.id ||
        JSON.stringify(file.collection) !== JSON.stringify(initial))
    ) {
      throw new Error(
        'Collection changed during installation; cleanup was not applied.',
      );
    }
  };
  await assertOwnWrite();
  const { createResourceInstallReceiptsStore } =
    await import('../lib/resource-install-receipts');
  const binding = await createResourceInstallReceiptsStore(
    'collection-install-rollback',
  ).findLocal('collections', expected.id);
  if (binding) {
    await createResourceInstallReceiptsStore(binding.accountId).rollbackInstall(
      { ...binding.receipt, localResourceIds: [expected.id] },
      undefined,
    );
  }
  // The collection is already indexed, so an edit can land during the awaits
  // above. Check again right before removing the file; a foreground read
  // restores the receipt alias of a collection that is kept.
  await assertOwnWrite();
  try {
    await unlink(getCollectionConfigFilePath(expected.id));
  } catch (error) {
    if (!isErrnoException(error) || error.code !== 'ENOENT') throw error;
  }
  const index = await readCollectionIndexUnfiltered();
  await writeCollectionIndexFile(
    index.collections.filter((entry) => entry.id !== expected.id),
  );
  unregisterCollectionInstall(expected.id, expected.sharedSource);
}
