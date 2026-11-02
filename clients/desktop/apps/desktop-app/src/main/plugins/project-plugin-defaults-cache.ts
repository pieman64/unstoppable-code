import type {
  ChatTabPluginSelections,
  PluginSelectionTombstones,
} from '@canopy/desktop-shared/types';
import { normalizePluginSelections } from '@canopy/desktop-shared/lib/plugin-selections-normalization';
import {
  normalizePluginSelectionTombstones,
  pluginSelectionsEqual,
} from '@canopy/desktop-shared/lib/effective-plugin-selections';
import {
  bumpProjectPluginDefaultsRevision,
  getProjectPluginDefaultsRevision,
} from './plugin-defaults-revision';

/** The `workspace.json` fields a chat's inherited plugin layers read. */
export interface ProjectPluginDefaults {
  defaultPluginSelections?: ChatTabPluginSelections;
  disabledGlobalPluginSelections?: PluginSelectionTombstones;
}

export interface ProjectPluginDefaultsRead {
  defaults: ProjectPluginDefaults;
  /** False when the read proves nothing (an unreadable file): not kept. */
  cacheable: boolean;
}

/**
 * A reconcile's read of a config removed since the write it reconciles
 * landed. The remover drops the cached layer and advances the revision for
 * the removal itself.
 */
export interface ProjectPluginDefaultsRemoved {
  removed: true;
  /**
   * The default selections the write left when its own refresh may have been
   * dropped, and the revision then; null when it was not. Any advance since
   * followed the write and settled it.
   */
  owed:
    | (Pick<ProjectPluginDefaults, 'defaultPluginSelections'> & {
        revision: number;
      })
    | null;
}

/** Those fields as found in any workspace config, parsed or typed. */
export interface ProjectPluginLayerSource {
  readonly defaultPluginSelections?: unknown;
  readonly disabledGlobalPluginSelections?: unknown;
}

/**
 * The project plugin-defaults layer of each workspace config, keyed by the
 * config's path, so chat plugin resolution reads `workspace.json` once
 * instead of on every turn, discovery and preflight. A project without
 * defaults (or without a config at all) is cached too.
 *
 * Every in-process writer or remover of a workspace config calls
 * {@link projectPluginDefaultsWritten} as soon as its write lands, before
 * announcing the change, so the next resolution reads the new file and
 * sessions inheriting a changed layer are not reused. A read that was still
 * in flight at that point is dropped, never kept. Writes from another
 * process (the CLI only creates new workspaces) are not observed.
 */
const cache = new Map<string, Promise<ProjectPluginDefaults>>();

/**
 * What the reads of each config served since its revision last advanced,
 * that is what a session at the current revision may have been created
 * with: one layer, or `mixed` once two differ or a read failed. Kept when
 * the cache entry is dropped without a layer change.
 */
const served = new Map<string, ProjectPluginDefaults | 'mixed'>();

/**
 * Layer-changing advances of each config's revision. A read that loaded
 * across one records nothing: consumers stamp the revision before reading,
 * so its session has the earlier revision and is recreated anyway. Revisit
 * if a consumer stamps after its read.
 */
const advances = new Map<string, number>();

type Unsettled = Map<string, Set<Promise<void>>>;

/** Reads of each config in flight, cached or not, until they settle. */
const readsInFlight: Unsettled = new Map();

function track(
  unsettled: Unsettled,
  configPath: string,
  work: Promise<unknown>,
): void {
  const settled = work.then(
    (): void => undefined,
    (): void => undefined,
  );
  const entries = unsettled.get(configPath) ?? new Set<Promise<void>>();
  unsettled.set(configPath, entries);
  entries.add(settled);
  void settled.then((): void => {
    entries.delete(settled);
    if (entries.size === 0 && unsettled.get(configPath) === entries)
      unsettled.delete(configPath);
  });
}

function forget(configPath: string, entry: Promise<unknown>): void {
  if (cache.get(configPath) === entry) cache.delete(configPath);
}

function recordServed(
  configPath: string,
  defaults: ProjectPluginDefaults | 'mixed',
): void {
  const previous = served.get(configPath);
  served.set(
    configPath,
    previous === undefined ||
      (previous !== 'mixed' &&
        defaults !== 'mixed' &&
        !projectPluginLayerChanged(previous, defaults))
      ? defaults
      : 'mixed',
  );
}

/**
 * Configs whose layer may change with no refresh (CAN-4417), each with the
 * request for its reconcile, which must not wait on the read.
 */
const unsettled = new Map<string, () => void>();

/**
 * Until {@link projectPluginLayerSettled}, reads of the config skip the
 * cache, and one that finds a layer other than one served since the last
 * advance requests `reconcile`.
 */
export function projectPluginLayerUnsettled(
  configPath: string,
  reconcile: () => void,
): void {
  unsettled.set(configPath, reconcile);
  cache.delete(configPath);
}

export function projectPluginLayerSettled(configPath: string): void {
  unsettled.delete(configPath);
}

export function readThroughProjectPluginDefaults(
  configPath: string,
  load: () => Promise<ProjectPluginDefaultsRead>,
): Promise<ProjectPluginDefaults> {
  const reconcile = unsettled.get(configPath);
  const cached = reconcile ? undefined : cache.get(configPath);
  if (cached) return cached;
  const startedAt = advances.get(configPath) ?? 0;
  const record = (defaults: ProjectPluginDefaults | 'mixed'): void => {
    if ((advances.get(configPath) ?? 0) === startedAt)
      recordServed(configPath, defaults);
  };
  const pending = load().then(({ defaults, cacheable }) => {
    const before = served.get(configPath);
    record(defaults);
    if (
      reconcile &&
      cacheable &&
      before !== undefined &&
      (before === 'mixed' || projectPluginLayerChanged(before, defaults))
    )
      reconcile();
    if (!cacheable) forget(configPath, pending);
    return defaults;
  });
  if (!reconcile) cache.set(configPath, pending);
  track(
    readsInFlight,
    configPath,
    pending.catch((): void => {
      // Callers fall back to no project layer.
      record('mixed');
      forget(configPath, pending);
    }),
  );
  return pending;
}

function tombstonesAsSelections(value: unknown): ChatTabPluginSelections {
  const tombstones = normalizePluginSelectionTombstones(value);
  return {
    collectionIds: tombstones?.collectionIds ?? [],
    skillRefs: tombstones?.skillRefs ?? [],
    pluginRefs: tombstones?.pluginRefs ?? [],
    mcpServerRefs: tombstones?.mcpServerRefs ?? [],
  };
}

/**
 * Whether what a workspace's chats inherit differs between two versions of
 * its config: its default plugins or the global defaults it turned off.
 * Order and duplicates don't count, so re-saving the same layer changes
 * nothing.
 */
export function projectPluginLayerChanged(
  before: ProjectPluginLayerSource,
  after: ProjectPluginLayerSource,
): boolean {
  return (
    !pluginSelectionsEqual(
      normalizePluginSelections(before.defaultPluginSelections),
      normalizePluginSelections(after.defaultPluginSelections),
    ) ||
    !pluginSelectionsEqual(
      tombstonesAsSelections(before.disabledGlobalPluginSelections),
      tombstonesAsSelections(after.disabledGlobalPluginSelections),
    )
  );
}

/**
 * Records a landed write or removal of the workspace config at `configPath`.
 * The cached layer is dropped, and when the layer changed the workspace's
 * defaults revision advances, so a running session of a chat that inherits
 * it is recreated on its next turn.
 */
export function projectPluginDefaultsWritten(write: {
  configPath: string;
  workspaceId: string;
  layerChanged: boolean;
}): void {
  cache.delete(write.configPath);
  if (!write.layerChanged) return;
  served.delete(write.configPath);
  advances.set(write.configPath, (advances.get(write.configPath) ?? 0) + 1);
  bumpProjectPluginDefaultsRevision(write.workspaceId);
}

/**
 * Records a write that may have landed without {@link projectPluginDefaultsWritten}
 * (a lost response): the cached layer is dropped, and the revision advances
 * only when a layer served since it last advanced differs from the file's,
 * so repeating it changes nothing more. A failed or unreadable read decides
 * nothing; a later reconcile still compares against every layer served.
 *
 * It reads and compares inside `serialize`, the config's write queue, where
 * every other in-process write has refreshed or not landed, after the reads
 * in flight have recorded what they served. A commit of the config still
 * running its post-commit work, or an advance during the read, starts it
 * over; each start follows a new commit or advance.
 *
 * A removed read leaves the removal to its remover. It changes nothing, the
 * cached layer included, unless the revision has not advanced since the
 * owed write and a layer served since then predates it: neither its
 * selections nor the removed config's empty layer. Then it drops the layer
 * and advances, standing in for the write's refresh.
 */
export async function reconcileProjectPluginDefaults(write: {
  configPath: string;
  workspaceId: string;
  load: () => Promise<ProjectPluginDefaultsRead | ProjectPluginDefaultsRemoved>;
  serialize: (work: () => Promise<void>) => Promise<void>;
  /** Commits that wrote the config and still refresh after leaving the queue. */
  committing: () => readonly Promise<void>[];
}): Promise<void> {
  const { configPath, workspaceId } = write;
  await Promise.all([
    ...Array.from(readsInFlight.get(configPath) ?? []),
    ...write.committing(),
  ]);
  let decided = false;
  await write.serialize(async (): Promise<void> => {
    if (write.committing().length > 0) return;
    const revision = getProjectPluginDefaultsRevision(workspaceId);
    let read: ProjectPluginDefaultsRead | ProjectPluginDefaultsRemoved;
    try {
      read = await write.load();
    } catch (error) {
      projectPluginDefaultsWritten({
        configPath,
        workspaceId,
        layerChanged: false,
      });
      throw error;
    }
    // Every session that read before an advance is already recreated.
    if (getProjectPluginDefaultsRevision(workspaceId) !== revision) return;
    decided = true;
    const lastServed = served.get(configPath);
    if ('removed' in read) {
      if (
        read.owed !== null &&
        read.owed.revision === revision &&
        lastServed !== undefined &&
        (lastServed === 'mixed' ||
          (projectPluginLayerChanged(lastServed, {}) &&
            !pluginSelectionsEqual(
              normalizePluginSelections(lastServed.defaultPluginSelections),
              normalizePluginSelections(read.owed.defaultPluginSelections),
            )))
      )
        projectPluginDefaultsWritten({
          configPath,
          workspaceId,
          layerChanged: true,
        });
      return;
    }
    projectPluginDefaultsWritten({
      configPath,
      workspaceId,
      layerChanged:
        read.cacheable &&
        lastServed !== undefined &&
        (lastServed === 'mixed' ||
          projectPluginLayerChanged(lastServed, read.defaults)),
    });
  });
  if (!decided) await reconcileProjectPluginDefaults(write);
}
