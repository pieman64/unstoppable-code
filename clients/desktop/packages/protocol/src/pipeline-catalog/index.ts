import {
  API_PIPELINE_TRIGGER_TYPES,
  PIPELINE_EXECUTION_SCOPES,
  type ApiPipelineTriggerType,
  type PipelineExecutionScope,
} from '../pipelines';
import { isCuratedCatalogKey } from '../plugin-catalog';
import type { PipelinePackageSummary } from '../pipelines';

export const PIPELINE_CATALOG_API_VERSION = 1;
export const MAX_CURATED_PIPELINE_BYTES = 1024 * 1024;
export interface PipelineCatalogIssue {
  path: string;
  code: string;
  message: string;
  line?: number;
  column?: number;
}
export interface PipelineCatalogErrorResponse {
  error: string;
  code: string;
  issues: PipelineCatalogIssue[];
}
/** Bounded persisted metadata. No definition, inputs, jobs, scripts or manifests. */
export interface CuratedPipelineSummary {
  key: string;
  name: string;
  shortDescription: string;
  icon: string;
  version: string;
  triggerTypes: ApiPipelineTriggerType[];
  scopes: PipelineExecutionScope[];
  jobCount: number;
  stepCount: number;
  contentHash: string;
  contentSizeBytes: number;
  categories: string[];
  popular: boolean;
  sortOrder: number;
  revision: number;
  authorName: string | null;
  authorUrl: string | null;
  docsUrl: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface CuratedPipelineDetail extends CuratedPipelineSummary {
  rawPipeline: string;
  package?: PipelinePackageSummary;
}
export interface CuratedPipelineListQuery {
  limit?: number;
  cursor?: string;
  q?: string;
  category?: string;
  triggerType?: ApiPipelineTriggerType;
  scope?: PipelineExecutionScope;
}
export interface CuratedPipelineListResponse {
  version: typeof PIPELINE_CATALOG_API_VERSION;
  data: CuratedPipelineSummary[];
  nextCursor: string | null;
}
export interface AdminCuratedPipelineSummary extends CuratedPipelineSummary {
  active: boolean;
  brands: Array<{ externalId: string; name: string; active: boolean | null }>;
  source: string | null;
  sourceId: string | null;
  internalNotes: string | null;
}
export interface AdminCuratedPipelineDetail extends AdminCuratedPipelineSummary {
  rawPipeline: string;
  /** Committed capability package shown by the admin review surface. */
  package?: PipelinePackageSummary;
}
export interface AdminCuratedPipelineListResponse {
  version: typeof PIPELINE_CATALOG_API_VERSION;
  data: AdminCuratedPipelineSummary[];
  nextCursor: string | null;
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max;
}
function nullableText(value: unknown, max: number): boolean {
  return value === null || text(value, max);
}
function integer(value: unknown, min: number, max: number): boolean {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= min &&
    value <= max
  );
}
function strings(
  value: unknown,
  max: number,
  length: number,
): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= max &&
    value.every((item) => text(item, length))
  );
}
export function isCuratedPipelineSummary(
  value: unknown,
): value is CuratedPipelineSummary {
  if (!record(value)) return false;
  return (
    typeof value.key === 'string' &&
    isCuratedCatalogKey(value.key) &&
    value.key.length <= 64 &&
    text(value.name, 256) &&
    value.name.trim().length > 0 &&
    text(value.shortDescription, 256) &&
    text(value.icon, 128) &&
    text(value.version, 64) &&
    strings(value.triggerTypes, API_PIPELINE_TRIGGER_TYPES.length, 32) &&
    value.triggerTypes.length > 0 &&
    value.triggerTypes.every((item) =>
      API_PIPELINE_TRIGGER_TYPES.some((valid) => valid === item),
    ) &&
    strings(value.scopes, 3, 32) &&
    value.scopes.length > 0 &&
    value.scopes.every((item) =>
      PIPELINE_EXECUTION_SCOPES.some((valid) => valid === item),
    ) &&
    integer(value.jobCount, 1, 1000) &&
    integer(value.stepCount, 1, 10000) &&
    text(value.contentHash, 64) &&
    /^[a-f0-9]{64}$/.test(value.contentHash) &&
    integer(value.contentSizeBytes, 1, MAX_CURATED_PIPELINE_BYTES) &&
    strings(value.categories, 20, 64) &&
    typeof value.popular === 'boolean' &&
    integer(value.sortOrder, -1000000, 1000000) &&
    integer(value.revision, 1, Number.MAX_SAFE_INTEGER) &&
    nullableText(value.authorName, 96) &&
    nullableText(value.authorUrl, 512) &&
    nullableText(value.docsUrl, 512) &&
    text(value.createdAt, 40) &&
    Number.isFinite(Date.parse(value.createdAt)) &&
    text(value.updatedAt, 40) &&
    Number.isFinite(Date.parse(value.updatedAt))
  );
}
export function isCuratedPipelineDetail(
  value: unknown,
): value is CuratedPipelineDetail {
  return (
    isCuratedPipelineSummary(value) &&
    record(value) &&
    typeof value.rawPipeline === 'string' &&
    new TextEncoder().encode(value.rawPipeline).byteLength <=
      MAX_CURATED_PIPELINE_BYTES
  );
}
/**
 * A catalog entry with any trigger type this build doesn't know dropped, so
 * a newer server can add one without the whole list failing validation here.
 */
function withKnownTriggerTypes(value: unknown): unknown {
  if (!record(value) || !Array.isArray(value.triggerTypes)) return value;
  return {
    ...value,
    triggerTypes: value.triggerTypes.filter((item) =>
      API_PIPELINE_TRIGGER_TYPES.some((valid) => valid === item),
    ),
  };
}

function hasNoTriggerTypes(value: unknown): boolean {
  return (
    record(value) &&
    Array.isArray(value.triggerTypes) &&
    value.triggerTypes.length === 0
  );
}

/**
 * Reads a catalog list response tolerantly: unknown trigger types are
 * dropped from each entry, and an entry left with none is skipped. Any other
 * invalid entry still rejects the response.
 */
export function readCuratedPipelineListResponse(
  value: unknown,
): CuratedPipelineListResponse | undefined {
  if (!record(value) || !Array.isArray(value.data)) return undefined;
  const candidate = {
    ...value,
    data: value.data
      .map(withKnownTriggerTypes)
      .filter((item) => !hasNoTriggerTypes(item)),
  };
  return isCuratedPipelineListResponse(candidate) ? candidate : undefined;
}

/** Reads one catalog entry's content, dropping unknown trigger types. */
export function readCuratedPipelineDetail(
  value: unknown,
): CuratedPipelineDetail | undefined {
  const candidate = withKnownTriggerTypes(value);
  return isCuratedPipelineDetail(candidate) ? candidate : undefined;
}

export function isCuratedPipelineListResponse(
  value: unknown,
): value is CuratedPipelineListResponse {
  return (
    record(value) &&
    value.version === PIPELINE_CATALOG_API_VERSION &&
    Array.isArray(value.data) &&
    value.data.length <= 100 &&
    value.data.every(isCuratedPipelineSummary) &&
    (value.nextCursor === null || text(value.nextCursor, 2048))
  );
}
