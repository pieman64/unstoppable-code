import {
  observeStoragePathSync as observe,
  type StoragePathObservation,
} from '@canopy/core-runtime/node/storage-path-observation';
import { hostOperatingSystem } from './host-platform';

export type { StoragePathObservation };

/** Supported-host projection of the shared filesystem observation. */
export function observeStoragePathSync(path: string): StoragePathObservation {
  if (hostOperatingSystem() === null)
    throw new TypeError('Storage paths must be fully qualified.');
  return observe(path);
}
