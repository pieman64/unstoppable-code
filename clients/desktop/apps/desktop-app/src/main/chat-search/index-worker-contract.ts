import type { ChatSearchIndexer } from './indexer';
import { isRecord } from '../lib/type-guards';

/** Private, same-process execution boundary. Search policy and source ownership stay in the service. */
export const INDEX_WORKER_METHODS = [
  'replaceWorktreePlans',
  'upsertCoworkArchive',
  'upsertDoc',
  'deleteArchivedContainerDocs',
  'deleteChatDoc',
  'deleteDocById',
  'deleteWorktreeDocs',
  'deleteWorkspaceDocs',
  'getSourceFingerprint',
  'setSourceFingerprint',
  'listSourceFileKeys',
  'deleteSourceFile',
  'setMetadata',
  'getIndexedBodiesIfTranscriptUnchanged',
  'getIndexedCommittedFingerprint',
  'replaceActiveBodyIfCommittedUnchanged',
  'updateDocMetadataIfTranscriptUnchanged',
  'beginStagedScope',
  'stageScopeDoc',
  'commitStagedScope',
  'discardStagedScope',
] as const satisfies readonly (keyof ChatSearchIndexer)[];
export type IndexWorkerMethod = (typeof INDEX_WORKER_METHODS)[number];
export type AsyncIndexMethods = {
  [K in IndexWorkerMethod]: (
    ...args: Parameters<ChatSearchIndexer[K]>
  ) => Promise<ReturnType<ChatSearchIndexer[K]>>;
};
export interface IndexWorkerRequest {
  id: number;
  method: IndexWorkerMethod | 'barrier' | 'close';
  args: unknown[];
}
export type IndexWorkerResponse =
  | { kind: 'ready'; dbPath: string }
  | { kind: 'result'; id: number; ok: true; value: unknown }
  | { kind: 'result'; id: number; ok: false; error: string }
  | { kind: 'fatal'; error: string };

export function isIndexWorkerMethod(
  value: unknown,
): value is IndexWorkerRequest['method'] {
  return (
    value === 'barrier' ||
    value === 'close' ||
    INDEX_WORKER_METHODS.some((method) => method === value)
  );
}

export function isIndexWorkerRequest(
  value: unknown,
): value is IndexWorkerRequest {
  return (
    isRecord(value) &&
    Number.isInteger(value.id) &&
    typeof value.id === 'number' &&
    value.id > 0 &&
    isIndexWorkerMethod(value.method) &&
    Array.isArray(value.args)
  );
}

export function isIndexWorkerResponse(
  value: unknown,
): value is IndexWorkerResponse {
  if (!isRecord(value)) return false;
  if (value.kind === 'ready') return typeof value.dbPath === 'string';
  if (value.kind === 'fatal') return typeof value.error === 'string';
  if (
    value.kind !== 'result' ||
    typeof value.id !== 'number' ||
    !Number.isInteger(value.id) ||
    typeof value.ok !== 'boolean'
  )
    return false;
  return value.ok || typeof value.error === 'string';
}
