import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { BRAND } from '@canopy/brand/current';
import {
  SHARED_WORKSPACE_TEMPLATE_API_VERSION,
  isWorkspaceTemplateContentHash,
  validateSharedWorkspaceTemplateDocument,
  type CuratedBlueprintCatalogItem,
  type CuratedBlueprintCatalogResponse,
  type PipelinePackageEnvironmentRequirement,
  type SharedWorkspaceTemplateDocument,
} from '@canopy/protocol';
import { requestCanopyCloudPublicJson } from '../canopy-cloud/client';
import { getBlueprintCatalogCacheFilePath } from '../lib/paths';
import { withPackageVersionNegotiation } from '../pipelines/canopy-server-client';

export const BLUEPRINT_CATALOG_MAX_AGE_MS = 24 * 60 * 60_000;
const CACHE_SCHEMA_VERSION = 1;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface CachedBlueprint {
  externalId: string;
  contentHash: string;
  document: SharedWorkspaceTemplateDocument;
  requirements?: PipelinePackageEnvironmentRequirement[];
}

interface BlueprintCatalogCache {
  cacheSchemaVersion: 1;
  apiVersion: number;
  fetchedAt: string;
  blueprints: CachedBlueprint[];
}

export type BlueprintSeedResolution =
  | { status: 'verified'; blueprints: CachedBlueprint[] }
  | { status: 'unavailable' };

// A successful refresh remains authoritative for this process even when a
// read-only data directory prevents the best-effort disk cache from updating.
// The picker receives this same validated array, so seed verification must not
// fall back to an older on-disk hash immediately afterwards.
let lastSuccessfulRefresh: BlueprintCatalogCache | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const REQUIREMENT_KINDS = new Set([
  'connector',
  'mcp',
  'model',
  'command',
  'runtime',
]);

function normalizeRequirements(
  value: unknown,
): PipelinePackageEnvironmentRequirement[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return undefined;
  const requirements: PipelinePackageEnvironmentRequirement[] = [];
  for (const requirement of value) {
    if (
      !isRecord(requirement) ||
      typeof requirement.id !== 'string' ||
      !REQUIREMENT_KINDS.has(String(requirement.kind)) ||
      typeof requirement.displayName !== 'string' ||
      typeof requirement.required !== 'boolean' ||
      typeof requirement.setupHint !== 'string' ||
      !Array.isArray(requirement.affectedSteps)
    ) {
      return undefined;
    }
    const affectedSteps: Array<{ jobId: string; stepId: string }> = [];
    for (const step of requirement.affectedSteps) {
      if (
        !isRecord(step) ||
        typeof step.jobId !== 'string' ||
        typeof step.stepId !== 'string'
      ) {
        return undefined;
      }
      affectedSteps.push({ jobId: step.jobId, stepId: step.stepId });
    }
    requirements.push({
      id: requirement.id,
      kind: requirement.kind as PipelinePackageEnvironmentRequirement['kind'],
      displayName: requirement.displayName,
      required: requirement.required,
      affectedSteps,
      setupHint: requirement.setupHint,
    });
  }
  return requirements;
}

function normalizeCatalogItem(
  value: unknown,
): CuratedBlueprintCatalogItem | null {
  if (
    !isRecord(value) ||
    typeof value.externalId !== 'string' ||
    !UUID_PATTERN.test(value.externalId) ||
    !isWorkspaceTemplateContentHash(value.contentHash) ||
    typeof value.name !== 'string' ||
    value.name.trim().length === 0 ||
    typeof value.description !== 'string' ||
    (value.color !== undefined && typeof value.color !== 'string')
  ) {
    return null;
  }
  return {
    externalId: value.externalId.toLowerCase(),
    contentHash: value.contentHash,
    name: value.name.trim(),
    description: value.description.trim(),
    ...(value.color === undefined ? {} : { color: value.color }),
  };
}

function normalizeCatalogResponse(
  value: unknown,
): CuratedBlueprintCatalogResponse | null {
  if (!isRecord(value) || !Array.isArray(value.blueprints)) return null;
  const blueprints: CuratedBlueprintCatalogItem[] = [];
  for (const item of value.blueprints) {
    const normalized = normalizeCatalogItem(item);
    if (!normalized) return null;
    blueprints.push(normalized);
  }
  return { blueprints };
}

function normalizeCachedBlueprint(value: unknown): CachedBlueprint | null {
  if (
    !isRecord(value) ||
    typeof value.externalId !== 'string' ||
    !UUID_PATTERN.test(value.externalId) ||
    !isWorkspaceTemplateContentHash(value.contentHash)
  ) {
    return null;
  }
  const parsed = validateSharedWorkspaceTemplateDocument(value.document);
  if (!parsed.ok) return null;
  const requirements = normalizeRequirements(value.requirements);
  return {
    externalId: value.externalId.toLowerCase(),
    contentHash: value.contentHash,
    document: parsed.document,
    ...(requirements === undefined ? {} : { requirements }),
  };
}

async function readCache(): Promise<BlueprintCatalogCache | null> {
  try {
    const value: unknown = JSON.parse(
      await readFile(getBlueprintCatalogCacheFilePath(), 'utf8'),
    );
    if (
      !isRecord(value) ||
      value.cacheSchemaVersion !== CACHE_SCHEMA_VERSION ||
      value.apiVersion !== SHARED_WORKSPACE_TEMPLATE_API_VERSION ||
      typeof value.fetchedAt !== 'string' ||
      !Array.isArray(value.blueprints)
    ) {
      return null;
    }
    const blueprints: CachedBlueprint[] = [];
    for (const item of value.blueprints) {
      const normalized = normalizeCachedBlueprint(item);
      if (!normalized) return null;
      blueprints.push(normalized);
    }
    return {
      cacheSchemaVersion: 1,
      apiVersion: SHARED_WORKSPACE_TEMPLATE_API_VERSION,
      fetchedAt: value.fetchedAt,
      blueprints,
    };
  } catch {
    return null;
  }
}

async function writeCache(
  blueprints: CachedBlueprint[],
  fetchedAt: string,
): Promise<void> {
  const filePath = getBlueprintCatalogCacheFilePath();
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(
    filePath,
    JSON.stringify(
      {
        cacheSchemaVersion: 1,
        apiVersion: SHARED_WORKSPACE_TEMPLATE_API_VERSION,
        fetchedAt,
        blueprints,
      } satisfies BlueprintCatalogCache,
      null,
      2,
    ),
    'utf8',
  );
}

function cacheIsFresh(cache: BlueprintCatalogCache, nowMs: number): boolean {
  const fetchedAt = Date.parse(cache.fetchedAt);
  return (
    Number.isFinite(fetchedAt) &&
    nowMs - fetchedAt <= BLUEPRINT_CATALOG_MAX_AGE_MS
  );
}

async function fetchBlueprintDocument(
  item: CuratedBlueprintCatalogItem,
): Promise<CachedBlueprint | null> {
  const pathname =
    `/api/v1/${BRAND.web.apiNamespace}/public-shares/workspaces/` +
    `${encodeURIComponent(item.externalId)}?expectedWorkspaceTemplateContentHash=` +
    encodeURIComponent(item.contentHash);
  const value: unknown = await withPackageVersionNegotiation((headers) =>
    requestCanopyCloudPublicJson(pathname, { headers }),
  );
  if (
    !isRecord(value) ||
    value.externalId !== item.externalId ||
    value.contentHash !== item.contentHash
  ) {
    return null;
  }
  const parsed = validateSharedWorkspaceTemplateDocument(value.template);
  const packageSummaries = [
    ...(isRecord(value.package) ? [value.package] : []),
    ...(Array.isArray(value.skillPackages)
      ? value.skillPackages.flatMap((entry) =>
          isRecord(entry) && isRecord(entry.package) ? [entry.package] : [],
        )
      : []),
  ];
  const requirements = Array.from(
    new Map(
      packageSummaries
        .flatMap(
          (summary) =>
            normalizeRequirements(summary.environmentRequirements) ?? [],
        )
        .map((requirement) => [
          `${requirement.kind}:${requirement.id}`,
          requirement,
        ]),
    ).values(),
  );
  return parsed.ok
    ? {
        externalId: item.externalId,
        contentHash: item.contentHash,
        document: parsed.document,
        ...(packageSummaries.length === 0 ? {} : { requirements }),
      }
    : null;
}

export async function refreshBlueprints(
  now: Date = new Date(),
): Promise<CachedBlueprint[] | null> {
  try {
    const rawCatalog = await requestCanopyCloudPublicJson(
      '/api/v1/public-shares/blueprints/curated',
    );
    const catalog = normalizeCatalogResponse(rawCatalog);
    if (!catalog) return null;
    const blueprints: CachedBlueprint[] = [];
    for (const item of catalog.blueprints) {
      const fetched = await fetchBlueprintDocument(item);
      if (!fetched) return null;
      blueprints.push(fetched);
    }
    const refreshSnapshot: BlueprintCatalogCache = {
      cacheSchemaVersion: CACHE_SCHEMA_VERSION,
      apiVersion: SHARED_WORKSPACE_TEMPLATE_API_VERSION,
      fetchedAt: now.toISOString(),
      blueprints,
    };
    try {
      await writeCache(blueprints, now.toISOString());
      lastSuccessfulRefresh = null;
    } catch {
      // A read-only cache must not hide successfully fetched data.
      lastSuccessfulRefresh = refreshSnapshot;
    }
    return blueprints;
  } catch {
    return null;
  }
}

export interface BlueprintCatalogRead {
  blueprints: CachedBlueprint[];
  /**
   * False only when nothing usable was cached AND the refresh could not reach
   * the cloud, so the empty list is "could not answer" rather than "verified
   * empty". The renderer offers a retry on exactly that distinction, so it has
   * to survive the IPC boundary instead of being asserted true here.
   */
  available: boolean;
}

export async function listBlueprints(
  now: Date = new Date(),
): Promise<BlueprintCatalogRead> {
  if (
    lastSuccessfulRefresh &&
    cacheIsFresh(lastSuccessfulRefresh, now.getTime())
  ) {
    return { blueprints: lastSuccessfulRefresh.blueprints, available: true };
  }
  const cache = await readCache();
  if (cache && cacheIsFresh(cache, now.getTime())) {
    return { blueprints: cache.blueprints, available: true };
  }
  const refreshed = await refreshBlueprints(now);
  if (refreshed !== null) return { blueprints: refreshed, available: true };
  // A stale-but-readable cache still beats an empty picker: serve it, and do
  // not claim the catalog is unavailable when we have something to show. An
  // unwritten in-memory refresh is newer than the disk snapshot it replaced,
  // even after its TTL expires, and must remain aligned with seed verification.
  const fallback = lastSuccessfulRefresh ?? cache;
  return fallback
    ? { blueprints: fallback.blueprints, available: true }
    : { blueprints: [], available: false };
}

/** Refresh the startup cache only when its 24-hour stale gate has elapsed. */
export async function prefetchBlueprints(
  now: Date = new Date(),
): Promise<boolean> {
  const cache = await readCache();
  if (cache && cacheIsFresh(cache, now.getTime())) return true;
  return (await refreshBlueprints(now)) !== null;
}

export async function resolveBlueprintsForSeeding(): Promise<BlueprintSeedResolution> {
  if (lastSuccessfulRefresh) {
    return {
      status: 'verified',
      blueprints: lastSuccessfulRefresh.blueprints,
    };
  }
  const cache = await readCache();
  if (cache) return { status: 'verified', blueprints: cache.blueprints };
  const refreshed = await refreshBlueprints();
  return refreshed
    ? { status: 'verified', blueprints: refreshed }
    : { status: 'unavailable' };
}
