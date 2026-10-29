import { BUNDLES_CHANNELS } from '@canopy/desktop-shared/constants/bundle-channels';
import type {
  BundleConfig,
  BundleConfigFile,
  BundlesIndexFile,
} from '@canopy/desktop-shared/types/bundles';
import type { CollectionConfig } from '@canopy/desktop-shared/types/collections';
import {
  deleteCollectionConfig,
  readCollectionConfig,
  readCollectionIndex,
  saveCollectionConfig,
} from '../collections/collection-store';
import { registerIpcHandler } from './register';

function toLegacyBundle(collection: CollectionConfig): BundleConfig {
  return {
    id: collection.id,
    name: collection.name,
    description: collection.description,
    skills: collection.skills,
    plugins: collection.plugins,
    mcpServers: collection.mcpServers,
    createdAt: collection.createdAt,
    updatedAt: collection.updatedAt,
  };
}

export function registerBundleHandlers(): void {
  registerIpcHandler(BUNDLES_CHANNELS.LOAD_INDEX, async () => {
    const index = await readCollectionIndex();
    return {
      version: 1,
      bundles: index.collections.map((collection) => ({
        id: collection.id,
        name: collection.name,
        description: collection.description,
        updatedAt: collection.updatedAt,
        skillCount: collection.skillCount,
        pluginCount: collection.pluginCount,
        mcpServerCount: collection.mcpServerCount,
      })),
    } satisfies BundlesIndexFile;
  });

  registerIpcHandler(
    BUNDLES_CHANNELS.LOAD_BUNDLE,
    async (_event, id: string) => {
      const file = await readCollectionConfig(id);
      if (!file) {
        throw new Error(`Invalid bundle id: ${id}`);
      }
      return {
        version: 1,
        bundle: toLegacyBundle(file.collection),
      } satisfies BundleConfigFile;
    },
  );

  registerIpcHandler(
    BUNDLES_CHANNELS.SAVE_BUNDLE,
    async (_event, bundle: BundleConfig) => {
      const collection = await saveCollectionConfig(bundle);
      return {
        version: 1,
        bundle: toLegacyBundle(collection),
      } satisfies BundleConfigFile;
    },
  );

  registerIpcHandler(
    BUNDLES_CHANNELS.DELETE_BUNDLE,
    async (_event, id: string) => deleteCollectionConfig(id),
  );
}
