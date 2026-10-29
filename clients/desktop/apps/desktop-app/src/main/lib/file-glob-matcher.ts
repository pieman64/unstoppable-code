import {
  buildFileGlobMatcher as buildPortableFileGlobMatcher,
  buildFileExplorerGlobMatcher as buildPortableFileExplorerGlobMatcher,
  type FileGlobMatcher,
} from '@canopy/core-runtime/node';
import {
  createFileIndexingMatchPolicy,
  hostPlatformOperatingSystem,
} from '@canopy/core-platform';
import type { FileIndexingPreferences } from '@canopy/protocol/file-indexing';

export {
  hasGitPathSegment,
  type FileGlobMatcher,
} from '@canopy/core-runtime/node';

export function buildFileGlobMatcher(
  preferences: FileIndexingPreferences,
): FileGlobMatcher {
  return buildPortableFileGlobMatcher(
    preferences,
    createFileIndexingMatchPolicy(hostPlatformOperatingSystem()),
  );
}

export function buildFileExplorerGlobMatcher(): FileGlobMatcher {
  return buildPortableFileExplorerGlobMatcher(
    createFileIndexingMatchPolicy(hostPlatformOperatingSystem()),
  );
}
