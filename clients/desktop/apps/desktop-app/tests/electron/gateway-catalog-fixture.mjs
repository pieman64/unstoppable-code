// Load AI Gateway models into Electron main for E2E specs.
//
// Specs and journey runners must not send `model-registry:updated` to the
// renderer directly. That splits the renderer from main: the renderer picks a
// gateway model main has never heard of, and main refuses it with "The
// selected model could not be applied to this chat." (CAN-5022). Load gateway
// models into main instead by seeding its catalog cache before launch. Main
// hydrates the cache through its production cold-start path
// (`createAiGatewayModelCatalogService.hydrate`), derives gateway routes, and
// ships them to the renderer with the first registry read.
//
// The seed is written with `fetchedAt: now`, so it stays fresh for the
// catalog TTL (`AI_GATEWAY_MODEL_CATALOG_TTL_MS`, 15 minutes) and main
// schedules no network refresh. A single launch must stay under that TTL: a
// refresh replaces the seed with the mock's default catalog and drops the
// gateway-only rows.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildGatewayCatalog } from './mock-server/routes/ai-gateway-catalog.mjs';
import { DEFAULT_MOCK_BASE_URL } from './seeders/index.mjs';

// The cache read rejects a cache written for a different server origin or
// brand namespace, so these must match what main resolves in E2E builds.
const CATALOG_CACHE_VERSION = 8;
const BRAND_API_NAMESPACE = 'desktop-app';

/**
 * Builds one catalog v8 entry. `family` and `familyLabel` are explicit so an
 * unknown vendor prefix (for example `unknown-vendor/zulu-gateway`) works
 * without the mock's prefix map.
 *
 * `requiresLocalHarnessSupport` defaults to false because main drops a
 * gateway-only entry (one no package model claims) that requires local
 * harness support; such a row never reaches the registry.
 */
export function gatewayCatalogEntry({
  id,
  gatewayId,
  label,
  family,
  familyLabel,
  recommendedHarness,
  contextWindow = 128_000,
  supportedThinkingLevels = [],
  requiresLocalHarnessSupport = false,
  showMoreOnly = false,
}) {
  return {
    id,
    gatewayId,
    label,
    family,
    familyLabel,
    recommendedHarness,
    contextWindow,
    supportsPromptCaching: recommendedHarness === 'claude',
    requiresLocalHarnessSupport,
    showMoreOnly,
    supportedThinkingLevels: [...supportedThinkingLevels],
    toolSchemaProfile: 'standard',
  };
}

/**
 * Writes main's AI Gateway catalog cache. Call it after seeding workspaces
 * and chats and before `launchCanopy`. The catalog is the mock's default
 * catalog with `add` entries merged in and `withoutGatewayIds` removed.
 */
export function seedGatewayCatalogCache(
  userDataDir,
  { add = [], withoutGatewayIds = [] } = {},
) {
  const cacheDir = path.join(userDataDir, '.cache', 'model-catalog');
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(
    path.join(cacheDir, 'ai-gateway-v1.json'),
    `${JSON.stringify({
      cacheVersion: CATALOG_CACHE_VERSION,
      serverOrigin:
        process.env.CANOPY_E2E_CLOUD_BASE_URL ?? DEFAULT_MOCK_BASE_URL,
      brandApiNamespace: BRAND_API_NAMESPACE,
      fetchedAt: new Date().toISOString(),
      catalog: buildGatewayCatalog({ add, withoutGatewayIds }),
    })}\n`,
    'utf8',
  );
}

/**
 * Waits until main's model registry has each requested gateway route, and
 * each gateway-only model among its AI Gateway models. The registry read is
 * served by main, so a pass proves main owns the models.
 *
 * @param {import('@playwright/test').Page} window
 * @param {Array<{ modelId: string, gatewayId: string, gatewayOnly: boolean }>} routes
 */
export async function expectGatewayRoutesInMain(
  window,
  routes,
  { timeout = 30_000 } = {},
) {
  const deadline = Date.now() + timeout;
  let lastRoutes = [];
  let lastGatewayModelIds = [];
  let missing = routes;
  for (;;) {
    const snapshot = await window.evaluate(() => window.api.getModelRegistry());
    lastRoutes = (snapshot?.gatewayRoutes ?? []).map(
      ({ modelId, gatewayId, gatewayOnly }) => ({
        modelId,
        gatewayId,
        gatewayOnly,
      }),
    );
    lastGatewayModelIds = (snapshot?.aiGatewayModels ?? []).map(
      (model) => model.id,
    );
    missing = routes.filter(
      ({ modelId, gatewayId, gatewayOnly }) =>
        !lastRoutes.some(
          (route) =>
            route.modelId === modelId &&
            route.gatewayId === gatewayId &&
            route.gatewayOnly === gatewayOnly,
        ) ||
        (gatewayOnly && !lastGatewayModelIds.includes(modelId)),
    );
    if (missing.length === 0) return;
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `main's model registry is missing gateway routes ${JSON.stringify(
      missing,
    )}; last routes ${JSON.stringify(
      lastRoutes,
    )}; last AI Gateway models ${JSON.stringify(lastGatewayModelIds)}`,
  );
}
