import { AsyncLocalStorage } from 'node:async_hooks';
import type { PipelineInfo } from '@canopy/execution-engine/types/pipeline';

/** A project definition discovery found inside its checkout. */
export interface ContainedProjectPipeline {
  info: PipelineInfo;
  /** The resolved file inside the checkout; reads use it, never the link. */
  canonicalPath: string;
}

type Discoveries = Map<string, Promise<ContainedProjectPipeline[]>>;

const discoveries = new AsyncLocalStorage<Discoveries>();

/**
 * Runs `run` with one checkout discovery per scope shared by every project
 * read inside it, so a caller reading many of a checkout's definitions
 * discovers it once.
 */
export function withSharedProjectDiscovery<T>(
  run: () => Promise<T>,
): Promise<T> {
  return discoveries.run(new Map(), run);
}

/** The discovery for `key` in the current shared scope, or a fresh one. */
export function sharedProjectDiscovery(
  key: string,
  discover: () => Promise<ContainedProjectPipeline[]>,
): Promise<ContainedProjectPipeline[]> {
  const shared = discoveries.getStore();
  if (!shared) return discover();
  let discovery = shared.get(key);
  if (!discovery) {
    discovery = discover();
    shared.set(key, discovery);
  }
  return discovery;
}
