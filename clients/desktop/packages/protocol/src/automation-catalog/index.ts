import { serializedByteLength } from '../agents';
import {
  MAX_SHARED_AUTOMATION_BYTES,
  validateSharedAutomationDocument,
  type SharedAutomationActionType,
  type SharedAutomationDocument,
  type SharedAutomationInstallSource,
  type SharedAutomationPipelineRef,
} from '../automations';
import { isCuratedCatalogKey } from '../plugin-catalog';
import type { PipelinePackageSummary } from '../pipelines';

export const AUTOMATION_CATALOG_API_VERSION = 1;

export type CuratedAutomationPipelineSource = Exclude<
  SharedAutomationPipelineRef['source'],
  'shared' | 'unresolved'
>;

export interface AutomationCatalogIssue {
  path: string;
  code: string;
  message: string;
}

export interface AutomationCatalogErrorResponse {
  error: string;
  code: string;
  issues: AutomationCatalogIssue[];
}

/** Bounded persisted metadata. The canonical Automation document is detail-only. */
export interface CuratedAutomationSummary {
  key: string;
  name: string;
  shortDescription: string;
  icon: string;
  triggerKind: 'cron';
  cronExpression: string;
  actionType: SharedAutomationActionType;
  pipelineSource: CuratedAutomationPipelineSource | null;
  referencedCuratedPipelineKey: string | null;
  pluginCount: number;
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

export interface CuratedAutomationDetail extends CuratedAutomationSummary {
  automation: SharedAutomationDocument;
  package?: PipelinePackageSummary;
}

export interface CuratedAutomationListQuery {
  limit?: number;
  cursor?: string;
  q?: string;
  category?: string;
  actionType?: SharedAutomationActionType;
}

export interface CuratedAutomationListResponse {
  version: typeof AUTOMATION_CATALOG_API_VERSION;
  data: CuratedAutomationSummary[];
  nextCursor: string | null;
}

export interface AdminCuratedAutomationSummary extends CuratedAutomationSummary {
  active: boolean;
  brands: Array<{ externalId: string; name: string; active: boolean | null }>;
  source: string | null;
  sourceId: string | null;
  internalNotes: string | null;
}

export interface AdminCuratedAutomationDetail extends AdminCuratedAutomationSummary {
  automation: SharedAutomationDocument;
  package?: PipelinePackageSummary;
}

export interface AdminCuratedAutomationListResponse {
  version: typeof AUTOMATION_CATALOG_API_VERSION;
  data: AdminCuratedAutomationSummary[];
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
  maxItems: number,
  maxLength: number,
): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= maxItems &&
    value.every((item) => text(item, maxLength))
  );
}

const ACTION_TYPES: SharedAutomationActionType[] = [
  'app_advisor_prompt',
  'standalone_prompt',
  'worktree_prompt',
  'worktree_pipeline',
];

const PIPELINE_SOURCES: CuratedAutomationPipelineSource[] = [
  'bundled',
  'inline',
  'curated',
];

export function isCuratedAutomationSummary(
  value: unknown,
): value is CuratedAutomationSummary {
  if (!record(value)) return false;
  return (
    typeof value.key === 'string' &&
    isCuratedCatalogKey(value.key) &&
    value.key.length <= 64 &&
    text(value.name, 200) &&
    value.name.trim().length > 0 &&
    text(value.shortDescription, 256) &&
    text(value.icon, 128) &&
    value.triggerKind === 'cron' &&
    text(value.cronExpression, 256) &&
    value.cronExpression.trim().length > 0 &&
    ACTION_TYPES.some((item) => item === value.actionType) &&
    (value.pipelineSource === null ||
      PIPELINE_SOURCES.some((item) => item === value.pipelineSource)) &&
    (value.referencedCuratedPipelineKey === null ||
      (text(value.referencedCuratedPipelineKey, 64) &&
        isCuratedCatalogKey(value.referencedCuratedPipelineKey))) &&
    integer(value.pluginCount, 0, 10000) &&
    text(value.contentHash, 64) &&
    /^[a-f0-9]{64}$/.test(value.contentHash) &&
    integer(value.contentSizeBytes, 1, MAX_SHARED_AUTOMATION_BYTES) &&
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

export function isCuratedAutomationDetail(
  value: unknown,
): value is CuratedAutomationDetail {
  if (!isCuratedAutomationSummary(value) || !record(value)) return false;
  const result = validateSharedAutomationDocument(value.automation);
  return (
    result.ok &&
    serializedByteLength(result.document) <= MAX_SHARED_AUTOMATION_BYTES
  );
}

export function isCuratedAutomationListResponse(
  value: unknown,
): value is CuratedAutomationListResponse {
  return (
    record(value) &&
    value.version === AUTOMATION_CATALOG_API_VERSION &&
    Array.isArray(value.data) &&
    value.data.length <= 100 &&
    value.data.every(isCuratedAutomationSummary) &&
    (value.nextCursor === null || text(value.nextCursor, 2048))
  );
}

export function toCuratedAutomationInstallSource(
  detail: CuratedAutomationDetail,
): SharedAutomationInstallSource {
  return {
    id: detail.key,
    contentHash: detail.contentHash,
    automation: detail.automation,
  };
}
