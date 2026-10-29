import * as path from 'node:path';

/**
 * Root of the checkout that holds a Codex marketplace manifest. The manifest
 * directory decides it, not the file name: one checkout can hold several
 * manifests, such as the curated catalog's `marketplace.json` and the
 * `api_marketplace.json` Codex serves while signed out.
 */
export function codexMarketplaceRootFromPath(
  marketplacePath?: string | null,
): string | null {
  if (!marketplacePath) {
    return null;
  }

  const manifestPath = path.normalize(marketplacePath);
  const manifestDir = path.dirname(manifestPath);
  if (
    path.basename(manifestDir) === 'plugins' &&
    path.basename(path.dirname(manifestDir)) === '.agents'
  ) {
    return path.dirname(path.dirname(manifestDir));
  }
  if (path.basename(manifestDir) === '.claude-plugin') {
    return path.dirname(manifestDir);
  }

  return manifestDir;
}
