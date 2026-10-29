import type { PlatformOperatingSystem } from '@canopy/core-runtime';
import type { FileIndexingMatchPolicy } from '@canopy/core-runtime/node';

export function createFileIndexingMatchPolicy(
  os: PlatformOperatingSystem,
): FileIndexingMatchPolicy {
  return { caseSensitive: os === 'linux' };
}
