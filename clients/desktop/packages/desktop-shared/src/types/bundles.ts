// ---------------------------------------------------------------------------
// Deprecated Bundle aliases.
//
// "Bundles" have been renamed to "Collections" in shared types. This file
// keeps the old type names alive as straight aliases so legacy consumers
// continue to compile while they migrate to `./collections.ts`.
//
// The data-shape aliases (`BundleSkillRef`, `BundleConfig`, …) are full
// structural re-exports of the new Collection types. The `BundlesAPI`
// surface is kept as a distinct interface with the historical file-envelope
// shape so the preload bridge (and any unmigrated renderer caller) still
// compiles; new code should target `CollectionsAPI` directly.
// ---------------------------------------------------------------------------

import type {
  CollectionConfig,
  CollectionIndexEntry,
  CollectionMcpRef,
  CollectionPluginRef,
  CollectionSkillRef,
} from './collections';

/** @deprecated Use {@link CollectionSkillRef}. */
export type BundleSkillRef = CollectionSkillRef;

/** @deprecated Use {@link CollectionPluginRef}. */
export type BundlePluginRef = CollectionPluginRef;

/** @deprecated Use {@link CollectionMcpRef}. */
export type BundleMcpRef = CollectionMcpRef;

/** @deprecated Use {@link CollectionIndexEntry}. */
export type BundleIndexEntry = CollectionIndexEntry;

/** @deprecated Use {@link CollectionConfig}. */
export type BundleConfig = CollectionConfig;

/**
 * @deprecated Use {@link CollectionIndexFile}. The legacy v1 envelope uses
 * `bundles` as the array key; `CollectionIndexFile` uses `collections`. The
 * historical envelope is preserved here so unmigrated callers (renderer
 * hooks, main-process readers) continue to compile during the staged rename.
 */
export interface BundlesIndexFile {
  version: 1;
  bundles: BundleIndexEntry[];
}

/**
 * @deprecated Use {@link CollectionConfigFile}. The legacy v1 envelope uses
 * `bundle` as the inner record key; the new v2 envelope uses `collection`.
 */
export interface BundleConfigFile {
  version: 1;
  bundle: BundleConfig;
}

/**
 * @deprecated Use {@link CollectionsAPI} from `./collections`. This legacy
 * shape (file-envelope methods) is preserved so unmigrated renderer paths
 * can still resolve `window.bundles.*` during the staged migration. New
 * surfaces must consume `CollectionsAPI` directly.
 */
export interface BundlesAPI {
  loadIndex(): Promise<BundlesIndexFile>;
  loadBundle(id: string): Promise<BundleConfigFile>;
  saveBundle(bundle: BundleConfig): Promise<BundleConfigFile>;
  deleteBundle(id: string): Promise<void>;
}
