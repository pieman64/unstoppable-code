import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import * as path from 'node:path';
import {
  getCodeGraphBaseVariantDir,
  readPublishedCodeGraphBase,
  type CodeGraphBaseIdentity,
  type CodeGraphSeedSource,
} from '../base-graph';

/** The repo shadow directory name for a canonical repository root (desktop `getRepoShadowDir`). */
export function codeGraphRepoShadowKey(canonicalRepoRoot: string): string {
  return createHash('sha256')
    .update(canonicalRepoRoot)
    .digest('hex')
    .slice(0, 16);
}

/** `<dataRoot>/repo-shadows/<key>`: where a repository's published bases live. */
export function codeGraphRepoShadowDir(
  dataRoot: string,
  canonicalRepoRoot: string,
): string {
  return path.join(
    dataRoot,
    'repo-shadows',
    codeGraphRepoShadowKey(canonicalRepoRoot),
  );
}

/**
 * Copies the current compatible published base for one repository into
 * `seedStagingDir`, or answers null when none is published. Validates the
 * manifest only (identity, schema, extractor, custom-languages fingerprint,
 * file present); the build host validates the copied database before it
 * fuses it. Takes no lock: Electron main holds its variant lock around this
 * call; the daemon relies on generations being immutable (CAN-5626).
 */
export async function copyPublishedCodeGraphBaseForSeed(input: {
  readonly shadowDir: string;
  readonly identity: CodeGraphBaseIdentity;
  readonly destinationRootPath: string;
  readonly seedStagingDir: string;
}): Promise<CodeGraphSeedSource | null> {
  const published = await readPublishedCodeGraphBase({
    variantDir: getCodeGraphBaseVariantDir(input.shadowDir, input.identity),
    identity: input.identity,
    validation: 'manifest-only',
  });
  if (published === null) {
    return null;
  }
  await mkdir(input.seedStagingDir, { recursive: true });
  const copiedPath = path.join(
    input.seedStagingDir,
    `${createHash('sha256').update(input.identity.repoId).digest('hex').slice(0, 16)}-${randomUUID()}.db`,
  );
  try {
    // Generations reach 1–1.6 GB; clone where the filesystem supports it.
    await copyFile(published.dbPath, copiedPath, fsConstants.COPYFILE_FICLONE);
  } catch (error) {
    await rm(copiedPath, { force: true }).catch(() => undefined);
    throw error;
  }
  return {
    dbPath: copiedPath,
    repoId: input.identity.repoId,
    canonicalRepoRoot: input.identity.canonicalRepoRoot,
    destinationRootPath: input.destinationRootPath,
    generationId: published.manifest.generationId,
    gitHead: published.manifest.gitHead,
    completedBuildAt: Date.parse(published.manifest.publishedAt),
  };
}
