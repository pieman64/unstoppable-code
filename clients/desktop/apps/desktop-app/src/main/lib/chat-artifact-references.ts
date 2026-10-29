import { join } from 'node:path';
import {
  artifactRefsOf,
  type PersistedArtifactReference,
} from '@canopy/agent-transcript/lib/visual-ref';
import type { PersistedChatBlock } from '@canopy/agent-transcript/types';

export type StoredArtifactFamily = PersistedArtifactReference['family'];

export interface StoredArtifactLocation {
  family: StoredArtifactFamily;
  directory: string;
  extension: string;
}

/**
 * Artifact families this build stores, copies, verifies, and captures. A
 * reference of any other family on a block is carried through untouched, as
 * an unknown field was before families existed.
 */
const STORED_ARTIFACT_FAMILIES: ReadonlySet<StoredArtifactFamily> =
  new Set<StoredArtifactFamily>(['tool-output', 'visual']);

/** References on `block` whose artifacts this build stores. */
export function storedArtifactRefsOf(
  block: PersistedChatBlock,
): PersistedArtifactReference[] {
  return artifactRefsOf(block).filter((ref) =>
    STORED_ARTIFACT_FAMILIES.has(ref.family),
  );
}

/**
 * Artifact ids of one family on `block`. Reachability scans use this because
 * each family is reclaimed from its own directory.
 */
export function artifactIdsOf(
  block: PersistedChatBlock,
  family: StoredArtifactFamily,
): string[] {
  return storedArtifactRefsOf(block).flatMap((ref) =>
    ref.family === family ? [ref.reference.artifactId] : [],
  );
}

/** Bytes the stored artifacts on `block` occupy on disk. */
export function storedArtifactBytesOf(block: PersistedChatBlock): number {
  let bytes = 0;
  for (const ref of storedArtifactRefsOf(block))
    bytes += ref.reference.byteLength;
  return bytes;
}

/** Where each family keeps its files, relative to the transcripts root. */
const ARTIFACT_LOCATIONS: Readonly<
  Record<StoredArtifactFamily, { directory: string; extension: string }>
> = {
  'tool-output': { directory: 'tool-output', extension: '.txt' },
  visual: { directory: 'visuals', extension: '.html' },
};

/** Locations for the stored families, for maintenance and deletion scans. */
export function storedArtifactLocations(): StoredArtifactLocation[] {
  return Array.from(STORED_ARTIFACT_FAMILIES, (family) => ({
    family,
    ...ARTIFACT_LOCATIONS[family],
  }));
}

/**
 * Directories, relative to the transcripts root, that hold stored artifacts.
 * Each contains one subdirectory per chat.
 */
export function storedArtifactDirectories(): string[] {
  return storedArtifactLocations().map((location) => location.directory);
}

/** Path of a stored artifact relative to its scope's storage directory. */
export function artifactRelativePath(
  chatId: string,
  ref: PersistedArtifactReference,
): string {
  const location = ARTIFACT_LOCATIONS[ref.family];
  return join(
    'transcripts',
    location.directory,
    chatId,
    `${ref.reference.artifactId}${location.extension}`,
  );
}
