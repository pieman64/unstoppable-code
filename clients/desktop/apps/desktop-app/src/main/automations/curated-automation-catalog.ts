import { createHash } from 'node:crypto';
import { serializedByteLength } from '@canopy/protocol/agents';
import {
  isCuratedAutomationDetail,
  isCuratedAutomationListResponse,
  type CuratedAutomationDetail,
  type CuratedAutomationListResponse,
  type CuratedAutomationSummary,
} from '@canopy/protocol/automation-catalog';
import type { SharedAutomationActionType } from '@canopy/protocol/automations';
import { isCuratedCatalogKey } from '@canopy/protocol/plugin-catalog';
import type {
  ListCuratedAutomationsRequest,
  ListCuratedAutomationsResult,
} from '@canopy/desktop-shared/types/curated-automations';
import {
  requestCanopyCloudJson,
  resolveCanopyCloudCredentialContext,
  type CanopyCloudCredentialContext,
} from '../canopy-cloud/client';
import {
  assertCurrentCuratedCatalogCredentials,
  curatedCatalogCredentialIdentity,
  CuratedCatalogPageCache,
} from '../canopy-cloud/curated-catalog-cache';
import { getCuratedAutomationsCatalogFilePath } from '../lib/paths';

const PREFIX = '/api/v1/curated-automations';
export const CURATED_AUTOMATION_CACHE_TTL_MS = 5 * 60_000;
class InvalidCatalogResponseError extends Error {}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function summary(row: CuratedAutomationSummary): CuratedAutomationSummary {
  return {
    key: row.key,
    name: row.name,
    shortDescription: row.shortDescription,
    icon: row.icon,
    triggerKind: row.triggerKind,
    cronExpression: row.cronExpression,
    actionType: row.actionType,
    pipelineSource: row.pipelineSource,
    referencedCuratedPipelineKey: row.referencedCuratedPipelineKey,
    pluginCount: row.pluginCount,
    contentHash: row.contentHash,
    contentSizeBytes: row.contentSizeBytes,
    categories: [...row.categories],
    popular: row.popular,
    sortOrder: row.sortOrder,
    revision: row.revision,
    authorName: row.authorName,
    authorUrl: row.authorUrl,
    docsUrl: row.docsUrl,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const catalogCache = new CuratedCatalogPageCache<CuratedAutomationListResponse>(
  {
    filePath: getCuratedAutomationsCatalogFilePath,
    isResponse: isCuratedAutomationListResponse,
    projectResponse: (response): CuratedAutomationListResponse => ({
      version: 1,
      data: response.data.map(summary),
      nextCursor: response.nextCursor,
    }),
  },
);

const ACTION_TYPES: SharedAutomationActionType[] = [
  'app_advisor_prompt',
  'standalone_prompt',
  'worktree_prompt',
  'worktree_pipeline',
];

function queryString(input: ListCuratedAutomationsRequest): string {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Invalid curated automation query.');
  }
  const query = new URLSearchParams();
  const limit = input.limit ?? 25;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error('Invalid page size.');
  }
  query.set('limit', String(limit));
  for (const [key, max] of [
    ['q', 256],
    ['category', 64],
    ['cursor', 2048],
  ] as const) {
    const value = input[key];
    if (
      value !== undefined &&
      (typeof value !== 'string' || value.length > max)
    ) {
      throw new Error(`Invalid ${key}.`);
    }
    if (value) query.set(key, value);
  }
  if (input.actionType !== undefined) {
    if (!ACTION_TYPES.some((value) => value === input.actionType)) {
      throw new Error('Invalid action type.');
    }
    query.set('actionType', input.actionType);
  }
  if (
    input.forceRefresh !== undefined &&
    typeof input.forceRefresh !== 'boolean'
  ) {
    throw new Error('Invalid refresh request.');
  }
  return query.toString();
}

/** Recommendations consume only the current account's cached default listing. */
export async function readCachedCuratedAutomations(): Promise<CuratedAutomationListResponse | null> {
  const context = await resolveCanopyCloudCredentialContext();
  const cacheKey = `${curatedCatalogCredentialIdentity(context)}:${queryString({})}`;
  const cached = (await catalogCache.read()).find(
    (page) => page.query === cacheKey,
  );
  await assertCurrentCuratedCatalogCredentials(context);
  return cached?.response ?? null;
}

export async function listCuratedAutomations(
  input: ListCuratedAutomationsRequest = {},
): Promise<ListCuratedAutomationsResult> {
  const query = queryString(input);
  const context = await resolveCanopyCloudCredentialContext();
  const cacheKey = `${curatedCatalogCredentialIdentity(context)}:${query}`;
  const cached = (await catalogCache.read()).find(
    (page) => page.query === cacheKey,
  );
  if (
    !input.forceRefresh &&
    cached &&
    Date.now() - cached.fetchedAt < CURATED_AUTOMATION_CACHE_TTL_MS
  ) {
    await assertCurrentCuratedCatalogCredentials(context);
    return { ...cached.response, stale: false };
  }
  try {
    const raw: unknown = await requestCanopyCloudJson(`${PREFIX}?${query}`, {
      credentialContext: context,
    });
    if (!isCuratedAutomationListResponse(raw)) {
      throw new InvalidCatalogResponseError(
        'Invalid curated automation catalog response.',
      );
    }
    const response: CuratedAutomationListResponse = {
      version: 1,
      data: raw.data.map(summary),
      nextCursor: raw.nextCursor,
    };
    await assertCurrentCuratedCatalogCredentials(context);
    await catalogCache
      .write({ query: cacheKey, fetchedAt: Date.now(), response })
      .catch(() => undefined);
    return { ...response, stale: false };
  } catch (error) {
    await assertCurrentCuratedCatalogCredentials(context);
    if (
      error instanceof InvalidCatalogResponseError ||
      (record(error) &&
        typeof error.status === 'number' &&
        error.status >= 400 &&
        error.status < 500)
    ) {
      throw error;
    }
    if (cached) return { ...cached.response, stale: true };
    throw error;
  }
}

function validateKey(key: unknown): asserts key is string {
  if (typeof key !== 'string' || key.length > 64 || !isCuratedCatalogKey(key)) {
    throw new Error('Invalid curated automation key.');
  }
}

async function fetchDetailUncached(
  key: string,
  context: CanopyCloudCredentialContext,
): Promise<CuratedAutomationDetail> {
  validateKey(key);
  const raw: unknown = await requestCanopyCloudJson(
    `${PREFIX}/${encodeURIComponent(key)}`,
    { credentialContext: context },
  );
  await assertCurrentCuratedCatalogCredentials(context);
  if (!isCuratedAutomationDetail(raw) || raw.key !== key) {
    throw new Error('Invalid curated automation content.');
  }
  const bytes = serializedByteLength(raw.automation);
  const hash = createHash('sha256')
    .update(JSON.stringify(raw.automation))
    .digest('hex');
  if (bytes !== raw.contentSizeBytes || hash !== raw.contentHash) {
    throw new Error(
      'Curated automation content failed verification. Refresh the catalog and try again.',
    );
  }
  return {
    ...summary(raw),
    automation: raw.automation,
    ...(raw.package ? { package: raw.package } : {}),
  };
}

const detailReads = new Map<string, Promise<CuratedAutomationDetail>>();

export async function getCuratedAutomation(
  key: string,
): Promise<CuratedAutomationDetail> {
  validateKey(key);
  const context = await resolveCanopyCloudCredentialContext();
  const identity = `${curatedCatalogCredentialIdentity(context)}:${key}`;
  const pending = detailReads.get(identity);
  if (pending) return pending;
  const operation = fetchDetailUncached(key, context);
  detailReads.set(identity, operation);
  void operation
    .finally(() => {
      if (detailReads.get(identity) === operation) detailReads.delete(identity);
    })
    .catch(() => undefined);
  return operation;
}
