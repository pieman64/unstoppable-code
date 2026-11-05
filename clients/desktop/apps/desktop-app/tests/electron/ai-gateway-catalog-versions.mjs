// The AI Gateway catalog versions main accepts, read from the TypeScript
// sources so E2E seeds, the mock gateway route and performance fixtures cannot
// drift from them. A seeded cache with an older `cacheVersion` is promoted as
// stale or discarded, and main then refreshes it from the mock gateway, which
// silently replaces the seeded rows with the mock's default catalog.
import { readFileSync } from 'node:fs';

const REPO_ROOT = new URL('../../../../', import.meta.url);

function readExportedInteger(relativePath, constantName) {
  const source = readFileSync(new URL(relativePath, REPO_ROOT), 'utf8');
  const match = new RegExp(
    `^export const ${constantName}\\s*=\\s*(\\d+)\\b`,
    'm',
  ).exec(source);
  if (!match) {
    throw new Error(`Could not read ${constantName} from ${relativePath}`);
  }
  return Number(match[1]);
}

/** `cacheVersion` of main's `.cache/model-catalog/ai-gateway-v1.json`. */
export const AI_GATEWAY_MODEL_CATALOG_CACHE_VERSION = readExportedInteger(
  'packages/desktop-shared/src/node/ai-gateway-model-catalog/cache.ts',
  'AI_GATEWAY_MODEL_CATALOG_CACHE_VERSION',
);

/**
 * The catalog wire `version` this build requests (`?catalogVersion=`) and
 * stores: the gateway response's and the cached `catalog.version`.
 */
export const AI_GATEWAY_MODEL_CATALOG_VERSION = readExportedInteger(
  'packages/protocol/src/ai-gateway-models/index.ts',
  'AI_GATEWAY_MODEL_CATALOG_VERSION',
);
