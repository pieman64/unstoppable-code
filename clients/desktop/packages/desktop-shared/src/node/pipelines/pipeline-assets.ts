import { createHash } from 'node:crypto';
import * as path from 'node:path';
import type { NormalizedPipelineAssetDeclaration } from '@canopy/execution-engine/types/pipeline';

/**
 * Per-pipeline data layout under `<dataRoot>` (`<data>/pipeline-data`):
 *
 * - `<key>/state/` — the pipeline's data dir (`canopy.pipeline_data_dir`)
 * - `<key>/assets/<assetId>/` — installed asset files
 * - `<key>/assets.json` — per-file hashes of what install wrote
 *
 * `<key>` is the local pipeline UUID, or the sha256 of the absolute source
 * path for pipelines without one (project, bundled, curated). The data root
 * is app data, never a worktree checkout.
 */

/** Data-dir key for a pipeline: its local id, else a hash of its source. */
export function pipelineDataKey(input: {
  localPipelineId?: string;
  /** Absolute source path, or another stable source identity. */
  sourcePath: string;
}): string {
  const localPipelineId = input.localPipelineId?.trim();
  if (localPipelineId) return localPipelineId;
  const source = path.isAbsolute(input.sourcePath)
    ? path.resolve(input.sourcePath)
    : input.sourcePath;
  return createHash('sha256').update(source).digest('hex');
}

export function pipelineDataDir(dataRoot: string, key: string): string {
  return path.join(dataRoot, key, 'state');
}

export function pipelineAssetsDir(dataRoot: string, key: string): string {
  return path.join(dataRoot, key, 'assets');
}

export function pipelineAssetsManifestPath(
  dataRoot: string,
  key: string,
): string {
  return path.join(dataRoot, key, 'assets.json');
}

/**
 * Expand a declared asset path: `~` and `~/...` resolve under `homedir`.
 * Returns `undefined` for a path that is neither absolute nor home-relative,
 * since nothing would anchor it.
 */
export function expandPipelineAssetPath(
  declaredPath: string,
  homedir: string,
): string | undefined {
  const trimmed = declaredPath.trim();
  if (trimmed === '~') return path.resolve(homedir);
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return path.resolve(homedir, trimmed.slice(2));
  }
  return path.isAbsolute(trimmed) ? path.resolve(trimmed) : undefined;
}

export type ResolvePipelineAssetsResult =
  | {
      ok: true;
      /** Resolved directory per asset id; `''` for a missing optional asset. */
      assetPaths: Record<string, string>;
      /** Installed asset root, when the pipeline has a data key. */
      assetsDir?: string;
    }
  | { ok: false; assetId: string; message: string };

/**
 * Resolve each declared asset to a directory, in order:
 *
 * 1. `<assetsDir>/<assetId>` when that directory exists (installed copy);
 * 2. the declared `path`, `~` expanded, when it exists (author side);
 * 3. otherwise a required asset fails naming the asset, and an optional one
 *    resolves to `''`.
 */
export async function resolvePipelineAssets(input: {
  assets: readonly NormalizedPipelineAssetDeclaration[];
  dataRoot: string;
  /** Omitted for a run with no stable pipeline identity. */
  dataKey?: string;
  homedir: string;
  directoryExists: (directoryPath: string) => Promise<boolean>;
}): Promise<ResolvePipelineAssetsResult> {
  const assetsDir =
    input.dataKey === undefined
      ? undefined
      : pipelineAssetsDir(input.dataRoot, input.dataKey);
  const assetPaths: Record<string, string> = {};
  for (const asset of input.assets) {
    if (assetsDir !== undefined) {
      const installed = path.join(assetsDir, asset.id);
      if (await input.directoryExists(installed)) {
        assetPaths[asset.id] = installed;
        continue;
      }
    }
    const declared = expandPipelineAssetPath(asset.path, input.homedir);
    if (declared !== undefined && (await input.directoryExists(declared))) {
      assetPaths[asset.id] = declared;
      continue;
    }
    if (asset.required) {
      return {
        ok: false,
        assetId: asset.id,
        message:
          declared === undefined
            ? `Pipeline asset "${asset.id}" has path "${asset.path}", which must be absolute or start with ~`
            : `Pipeline asset "${asset.id}" is missing: no folder at ${declared}. Install the share that provides it or create the folder.`,
      };
    }
    assetPaths[asset.id] = '';
  }
  return {
    ok: true,
    assetPaths,
    ...(assetsDir === undefined ? {} : { assetsDir }),
  };
}
