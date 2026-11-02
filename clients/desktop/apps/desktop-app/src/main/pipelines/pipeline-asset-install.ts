import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import * as path from 'node:path';
import { isSafeCapabilityRelativePath } from '@canopy/protocol/capability-files';
import type { PipelinePackageResource } from '@canopy/protocol/pipelines';
import { PIPELINE_ASSET_ID_PATTERN } from '@canopy/pipeline-interop/assets';
import type { AutomationPipelineAssetChanges } from '@canopy/desktop-shared/types';
import type { PipelineAssetInstallMode } from '@canopy/desktop-shared/types/pipeline';
import {
  getPipelineAssetsDir,
  getPipelineAssetsManifestPath,
} from '../lib/paths';

/**
 * Installs an automation package's `file_asset` resources into the data dir
 * of the local pipeline that declared them, and records what it wrote in
 * `assets.json`. The package cache keeps the reviewed, immutable copy; the
 * asset dir is the recipient's working copy. Electron-main compatibility path
 * for `core.initiatedWork` installs.
 */

/** `<data>/pipeline-data/<id>/assets.json`. */
export interface PipelineAssetsManifestV1 {
  version: 1;
  assets: Record<
    string,
    {
      installMode: PipelineAssetInstallMode;
      /** sha256 of each file install wrote, by asset-relative path. */
      files: Record<string, string>;
    }
  >;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInstallMode(value: unknown): value is PipelineAssetInstallMode {
  return value === 'seed' || value === 'replace';
}

function errorCode(error: unknown): unknown {
  return isRecord(error) ? error.code : undefined;
}

function parseAssetsManifest(value: unknown): PipelineAssetsManifestV1 {
  const empty: PipelineAssetsManifestV1 = { version: 1, assets: {} };
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.assets))
    return empty;
  const assets: PipelineAssetsManifestV1['assets'] = {};
  for (const [assetId, entry] of Object.entries(value.assets)) {
    if (!isRecord(entry) || !isInstallMode(entry.installMode)) continue;
    if (!isRecord(entry.files)) continue;
    const files: Record<string, string> = {};
    for (const [relativePath, sha256] of Object.entries(entry.files)) {
      if (typeof sha256 === 'string') files[relativePath] = sha256;
    }
    assets[assetId] = { installMode: entry.installMode, files };
  }
  return { version: 1, assets };
}

/** The recorded install hashes, or an empty record when none are readable. */
export async function readPipelineAssetsManifest(
  localPipelineId: string,
): Promise<PipelineAssetsManifestV1> {
  try {
    const raw = await readFile(
      getPipelineAssetsManifestPath(localPipelineId),
      'utf8',
    );
    const value: unknown = JSON.parse(raw);
    return parseAssetsManifest(value);
  } catch (error) {
    if (errorCode(error) === 'ENOENT' || error instanceof SyntaxError)
      return { version: 1, assets: {} };
    throw error;
  }
}

async function writeFileAtomically(
  destination: string,
  contents: Uint8Array | string,
  options: { executable?: boolean } = {},
): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true });
  const temporaryPath = `${destination}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, contents, {
      flag: 'wx',
      ...(options.executable ? { mode: 0o755 } : {}),
    });
    await rename(temporaryPath, destination);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

/** Whether something exists at `target`, without following a symlink. */
async function pathExists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false;
    throw error;
  }
}

async function fileSha256(target: string): Promise<string | undefined> {
  try {
    const stats = await lstat(target);
    if (!stats.isFile()) return undefined;
    return createHash('sha256')
      .update(await readFile(target))
      .digest('hex');
  } catch {
    return undefined;
  }
}

/** The validated asset id of a `file_asset` resource. */
function fileAssetId(resource: PipelinePackageResource): string {
  const assetId = resource.assetId;
  if (
    resource.kind !== 'file_asset' ||
    assetId === undefined ||
    !PIPELINE_ASSET_ID_PATTERN.test(assetId)
  ) {
    throw new Error('The automation package has an invalid file resource.');
  }
  return assetId;
}

/** Where a packaged asset file goes under its asset dir; refuses escapes. */
function assetFileDestination(assetRoot: string, entryPath: string): string {
  if (!isSafeCapabilityRelativePath(entryPath)) {
    throw new Error('The automation package has an unsafe file path.');
  }
  const destination = path.resolve(assetRoot, ...entryPath.split('/'));
  const relative = path.relative(assetRoot, destination);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(
      `The automation package has an unsafe file path (${entryPath}).`,
    );
  }
  return destination;
}

/**
 * Copy each `file_asset` resource from the cached package into
 * `getPipelineAssetsDir(localPipelineId)/<assetId>`. `seed` writes only files
 * that are missing; `replace` overwrites. `assets.json` then records the hash
 * of every file install wrote (for `seed`, a file left in place keeps the
 * hash an earlier install recorded, or its own when it already matches).
 * Idempotent: a retry writes the same bytes and the same record.
 */
export async function installPipelineAssets(input: {
  localPipelineId: string;
  /** The verified cache directory of the package. */
  packagePath: string;
  /** The package's `file_asset` resources for this pipeline. */
  resources: readonly PipelinePackageResource[];
}): Promise<PipelineAssetsManifestV1> {
  const assetsRoot = getPipelineAssetsDir(input.localPipelineId);
  const previous = await readPipelineAssetsManifest(input.localPipelineId);
  const recorded: PipelineAssetsManifestV1 = {
    version: 1,
    assets: { ...previous.assets },
  };
  for (const resource of input.resources) {
    const assetId = fileAssetId(resource);
    const installMode = resource.installMode ?? 'seed';
    const assetRoot = path.join(assetsRoot, assetId);
    const previousFiles = previous.assets[assetId]?.files ?? {};
    const files: Record<string, string> = {};
    // An asset with no files (empty, or every file withheld) still installs
    // its folder, so runs resolve it here instead of the author's path.
    await mkdir(assetRoot, { recursive: true });
    for (const tree of resource.trees) {
      for (const entry of tree.entries) {
        const destination = assetFileDestination(assetRoot, entry.path);
        if (installMode === 'seed' && (await pathExists(destination))) {
          const kept =
            previousFiles[entry.path] ??
            ((await fileSha256(destination)) === entry.sha256
              ? entry.sha256
              : undefined);
          if (kept !== undefined) files[entry.path] = kept;
          continue;
        }
        const bytes = await readFile(
          path.join(input.packagePath, 'blobs', entry.sha256),
        );
        if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256) {
          throw new Error(
            `The cached package file ${entry.path} failed verification. Install the automation again.`,
          );
        }
        // A script the analyzer accepted as executable stays runnable.
        await writeFileAtomically(destination, bytes, {
          executable: entry.mode === 'execute',
        });
        files[entry.path] = entry.sha256;
      }
    }
    recorded.assets[assetId] = { installMode, files };
  }
  await writeFileAtomically(
    getPipelineAssetsManifestPath(input.localPipelineId),
    `${JSON.stringify(recorded, null, 2)}\n`,
  );
  return recorded;
}

/**
 * What {@link installPipelineAssets} would do to the files already in a
 * local pipeline's asset dirs, without writing. A file counts as edited here
 * when it differs from the hash `assets.json` recorded for it, or when
 * install never recorded it. Files that already match the share are left
 * out.
 */
export async function previewPipelineAssetChanges(input: {
  localPipelineId: string;
  resources: readonly PipelinePackageResource[];
}): Promise<AutomationPipelineAssetChanges[]> {
  const assetsRoot = getPipelineAssetsDir(input.localPipelineId);
  const previous = await readPipelineAssetsManifest(input.localPipelineId);
  const changes: AutomationPipelineAssetChanges[] = [];
  for (const resource of input.resources) {
    const assetId = fileAssetId(resource);
    const installMode = resource.installMode ?? 'seed';
    const assetRoot = path.join(assetsRoot, assetId);
    const recordedFiles = previous.assets[assetId]?.files ?? {};
    const change: AutomationPipelineAssetChanges = {
      assetId,
      installMode,
      added: [],
      updated: [],
      overwritten: [],
      kept: [],
    };
    for (const tree of resource.trees) {
      for (const entry of tree.entries) {
        const current = await fileSha256(
          assetFileDestination(assetRoot, entry.path),
        );
        if (current === undefined) {
          change.added.push(entry.path);
        } else if (current === entry.sha256) {
          continue;
        } else if (installMode === 'seed') {
          change.kept.push(entry.path);
        } else if (current === recordedFiles[entry.path]) {
          change.updated.push(entry.path);
        } else {
          change.overwritten.push(entry.path);
        }
      }
    }
    changes.push(change);
  }
  return changes;
}
