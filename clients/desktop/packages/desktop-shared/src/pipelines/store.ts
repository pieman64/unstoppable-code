import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import * as yaml from 'js-yaml';
import {
  getBundledPipelinesDir,
  getUserPipelineIndexPath,
  getUserPipelinesDir,
} from './config-paths';
import {
  atomicWriteFile,
  ensureDir,
  safeDeleteFile,
  safeReadFile,
} from './fs-utils';
import { normalizePipeline } from './normalize-pipeline';
import {
  getTriggerTypes,
  type IPCResult,
  type Pipeline,
  type PipelineExecutionScope,
  type PipelineData,
  type PipelineIndex,
  type PipelineIndexEntry,
  type PipelineInfo,
  type PipelineSaveInput,
  type PipelineTriggerType,
} from '../types/pipeline';
import { normalizePipelineScopes } from './scope';
import { parsePipelineText } from './parse-pipeline';
import { serializePipelineDocument } from '@canopy/pipeline-interop/serialize-pipeline';
import { isCuratedCatalogKey } from '@canopy/protocol/plugin-catalog';
import type { CuratedPipelineOrigin } from '@canopy/protocol/pipelines';
import {
  parseShareRemoteMetadata,
  type ShareRemoteMetadata,
} from '@canopy/protocol/sharing';

interface ResolvedPipelineEntry {
  entry: PipelineIndexEntry;
  source: 'user' | 'bundled';
  filePath: string;
}

export interface StoredPipelinePath {
  source: 'user' | 'bundled';
  filePath: string;
}

const PIPELINE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isPipelineTriggerType(value: unknown): value is PipelineTriggerType {
  return (
    value === 'dispatch' || value === 'plan_ready' || value === 'task_ready'
  );
}

function isPathInside(rootDir: string, candidatePath: string): boolean {
  const relativePath = path.relative(rootDir, candidatePath);
  return (
    relativePath.length > 0 &&
    relativePath !== '..' &&
    !relativePath.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relativePath)
  );
}

function resolveUserPipelineFilePath(filename: string): string | null {
  const userDirPath = path.resolve(getUserPipelinesDir());
  const filePath = path.resolve(userDirPath, filename);
  return isPathInside(userDirPath, filePath) ? filePath : null;
}

function isRegularFile(filePath: string): boolean {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function parseCuratedOrigin(value: unknown): CuratedPipelineOrigin | undefined {
  if (
    !isRecord(value) ||
    typeof value.key !== 'string' ||
    !isCuratedCatalogKey(value.key) ||
    typeof value.contentHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.contentHash) ||
    typeof value.revision !== 'number' ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1 ||
    typeof value.importedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.importedAt))
  )
    return undefined;
  return {
    key: value.key,
    contentHash: value.contentHash,
    revision: value.revision,
    importedAt: value.importedAt,
  };
}

function parsePipelineIndexEntry(value: unknown): PipelineIndexEntry | null {
  if (!isRecord(value)) {
    return null;
  }

  const id = value.id;
  const name = value.name;
  const filename = value.filename;
  const createdAt = value.createdAt;
  const updatedAt = value.updatedAt;

  if (
    typeof id !== 'string' ||
    typeof name !== 'string' ||
    typeof filename !== 'string' ||
    typeof createdAt !== 'string' ||
    typeof updatedAt !== 'string'
  ) {
    return null;
  }

  const description =
    typeof value.description === 'string' ? value.description : '';
  const icon = typeof value.icon === 'string' ? value.icon : '';
  const triggerTypesValue = value.triggerTypes;
  const triggerTypes = Array.isArray(triggerTypesValue)
    ? triggerTypesValue.filter((entry): entry is PipelineTriggerType =>
        isPipelineTriggerType(entry),
      )
    : undefined;
  let scopes: PipelineExecutionScope[] | undefined;
  try {
    scopes =
      value.scopes === undefined
        ? undefined
        : normalizePipelineScopes(value.scopes, `Pipeline index entry "${id}"`);
  } catch {
    scopes = undefined;
  }

  const curatedOrigin = parseCuratedOrigin(value.curatedOrigin);
  const remote = parseShareRemoteMetadata(value.remote);
  // The cached step count lets list reads skip reparsing each definition.
  const stepCount =
    typeof value.stepCount === 'number' &&
    Number.isInteger(value.stepCount) &&
    value.stepCount >= 0
      ? value.stepCount
      : undefined;
  const revision =
    typeof value.revision === 'number' &&
    Number.isSafeInteger(value.revision) &&
    value.revision > 0
      ? value.revision
      : undefined;
  return {
    id,
    name,
    filename,
    description,
    icon,
    createdAt,
    updatedAt,
    ...(curatedOrigin ? { curatedOrigin } : {}),
    ...(remote ? { remote } : {}),
    triggerTypes,
    scopes,
    ...(stepCount === undefined ? {} : { stepCount }),
    ...(revision === undefined ? {} : { revision }),
  };
}

function normalizeUserIndex(index: unknown): {
  index: PipelineIndex;
  didChange: boolean;
} {
  const pipelinesValue =
    isRecord(index) && Array.isArray(index.pipelines) ? index.pipelines : [];
  const seenIds = new Set<string>();
  const seenFilenames = new Set<string>();
  const normalizedEntries: PipelineIndexEntry[] = [];
  let didChange = !isRecord(index) || !Array.isArray(index.pipelines);

  for (const entryValue of pipelinesValue) {
    const entry = parsePipelineIndexEntry(entryValue);
    if (!entry) {
      didChange = true;
      continue;
    }

    const filePath = resolveUserPipelineFilePath(entry.filename);
    if (
      filePath === null ||
      !existsSync(filePath) ||
      !isRegularFile(filePath)
    ) {
      didChange = true;
      continue;
    }

    if (seenIds.has(entry.id) || seenFilenames.has(entry.filename)) {
      didChange = true;
      continue;
    }

    seenIds.add(entry.id);
    seenFilenames.add(entry.filename);
    normalizedEntries.push(entry);
  }

  if (!didChange) {
    return {
      index: {
        pipelines: normalizedEntries,
      },
      didChange: false,
    };
  }

  return {
    index: {
      pipelines: normalizedEntries,
    },
    didChange: true,
  };
}

function readIndex(): PipelineIndex {
  const raw = safeReadFile(getUserPipelineIndexPath());
  let index: unknown = { pipelines: [] };

  if (raw) {
    try {
      index = JSON.parse(raw) as unknown;
    } catch {
      /* corrupt index, reset */
    }
  }

  const normalized = normalizeUserIndex(index);
  if (normalized.didChange) {
    try {
      writeIndex(normalized.index);
    } catch {
      /* best-effort index cleanup */
    }
  }

  return normalized.index;
}

function writeIndex(index: PipelineIndex): void {
  const indexPath = getUserPipelineIndexPath();
  if (!ensureDir(path.dirname(indexPath))) {
    throw new Error(
      `Failed to ensure index directory: ${path.dirname(indexPath)}`,
    );
  }
  atomicWriteFile(indexPath, JSON.stringify(index, null, 2));
}

function readBundledIndex(): PipelineIndex {
  const raw = safeReadFile(path.join(getBundledPipelinesDir(), 'index.json'));
  if (raw) {
    try {
      return JSON.parse(raw) as PipelineIndex;
    } catch {
      /* corrupt */
    }
  }
  return { pipelines: [] };
}

function resolvePipelineEntry(id: string): ResolvedPipelineEntry | null {
  const userIndex = readIndex();
  const userEntry = userIndex.pipelines.find((p) => p.id === id);
  if (userEntry) {
    const filePath = resolveUserPipelineFilePath(userEntry.filename);
    if (filePath === null) {
      return null;
    }
    return {
      entry: userEntry,
      source: 'user',
      filePath,
    };
  }

  const bundledIndex = readBundledIndex();
  const bundledEntry = bundledIndex.pipelines.find((p) => p.id === id);
  if (bundledEntry) {
    return {
      entry: bundledEntry,
      source: 'bundled',
      filePath: path.join(getBundledPipelinesDir(), bundledEntry.filename),
    };
  }

  return null;
}

function resolvePipelineEntryBySource(
  source: 'user' | 'bundled',
  id: string,
): ResolvedPipelineEntry | null {
  if (source === 'user') {
    const userEntry = readIndex().pipelines.find((p) => p.id === id);
    if (!userEntry) {
      return null;
    }
    const filePath = resolveUserPipelineFilePath(userEntry.filename);
    if (filePath === null) {
      return null;
    }
    return {
      entry: userEntry,
      source,
      filePath,
    };
  }

  const bundledEntry = readBundledIndex().pipelines.find((p) => p.id === id);
  if (!bundledEntry) {
    return null;
  }
  return {
    entry: bundledEntry,
    source,
    filePath: path.join(getBundledPipelinesDir(), bundledEntry.filename),
  };
}

function isSafePipelineId(id: string): boolean {
  if (!PIPELINE_ID_PATTERN.test(id)) return false;
  if (id.includes('\0')) return false;
  const normalized = path.normalize(id);
  if (normalized !== id) return false;
  if (path.basename(id) !== id) return false;
  if (path.posix.basename(id) !== id) return false;
  if (path.win32.basename(id) !== id) return false;
  return true;
}

function parsePipelineFile(raw: string, filePath: string): IPCResult<Pipeline> {
  try {
    const parsed = yaml.load(raw, { schema: yaml.JSON_SCHEMA }) as {
      pipeline?: Pipeline;
    };
    return {
      success: true,
      data: parsed.pipeline ?? (parsed as unknown as Pipeline),
    };
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof Error
          ? `Failed to parse workflow file ${path.basename(filePath)}: ${error.message}`
          : `Failed to parse workflow file ${path.basename(filePath)}: ${String(error)}`,
    };
  }
}

function loadPipelineFromFile(filePath: string): IPCResult<Pipeline> {
  const raw = safeReadFile(filePath);
  return raw
    ? parsePipelineFile(raw, filePath)
    : {
        success: false,
        error: `Workflow file not found: ${path.basename(filePath)}`,
      };
}

function derivePipelineScopes(
  pipeline: Pipeline,
): PipelineExecutionScope[] | undefined {
  try {
    return normalizePipeline(pipeline).scope;
  } catch {
    return undefined;
  }
}

export function listStoredPipelines(): IPCResult<PipelineInfo[]> {
  try {
    const bundled = readBundledIndex().pipelines.map((p) => {
      const loaded = loadPipelineFromFile(
        path.join(getBundledPipelinesDir(), p.filename),
      );
      const stepCount =
        loaded.success && loaded.data
          ? Object.values(loaded.data.jobs).reduce(
              (count, job) => count + job.steps.length,
              0,
            )
          : p.stepCount;
      return {
        ...p,
        ...(stepCount === undefined ? {} : { stepCount }),
        scopes: p.scopes ?? ['directory' as const],
        source: 'bundled' as const,
        readonly: true,
      };
    });
    const userIndex = readIndex();
    let shouldPersistDerivedMetadata = false;
    const user = userIndex.pipelines.map((p, index) => {
      if (p.triggerTypes && p.scopes && p.stepCount !== undefined) {
        return { ...p, source: 'user' as const, readonly: false };
      }
      const filePath = resolveUserPipelineFilePath(p.filename);
      const result =
        filePath === null
          ? {
              success: false,
              error: `Workflow file not found: ${p.filename}`,
            }
          : loadPipelineFromFile(filePath);
      const triggerTypes =
        result.success && result.data
          ? getTriggerTypes(result.data.on)
          : undefined;
      const scopes =
        result.success && result.data
          ? derivePipelineScopes(result.data)
          : undefined;
      const stepCount =
        result.success && result.data
          ? Object.values(result.data.jobs).reduce(
              (count, job) => count + job.steps.length,
              0,
            )
          : undefined;
      if (triggerTypes) {
        userIndex.pipelines[index] = {
          ...userIndex.pipelines[index],
          triggerTypes,
        };
        shouldPersistDerivedMetadata = true;
      }
      if (scopes) {
        userIndex.pipelines[index] = {
          ...userIndex.pipelines[index],
          scopes,
        };
        shouldPersistDerivedMetadata = true;
      }
      if (stepCount !== undefined) {
        userIndex.pipelines[index] = {
          ...userIndex.pipelines[index],
          stepCount,
        };
        shouldPersistDerivedMetadata = true;
      }
      return {
        ...p,
        triggerTypes: triggerTypes ?? p.triggerTypes,
        scopes: scopes ?? p.scopes,
        stepCount: stepCount ?? p.stepCount,
        source: 'user' as const,
        readonly: false,
      };
    });
    if (shouldPersistDerivedMetadata) {
      try {
        writeIndex(userIndex);
      } catch {
        /* best-effort index backfill */
      }
    }
    return { success: true, data: [...bundled, ...user] };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

export function getStoredPipeline(id: string): IPCResult<PipelineData> {
  try {
    const resolved = resolvePipelineEntry(id);
    if (!resolved) {
      return { success: false, error: `Workflow not found: ${id}` };
    }

    const rawContent = safeReadFile(resolved.filePath);
    if (!rawContent) {
      return {
        success: false,
        error: `Workflow file not found: ${resolved.entry.filename}`,
      };
    }
    const pipeline = parsePipelineFile(rawContent, resolved.filePath);
    if (!pipeline.success || !pipeline.data) {
      return { success: false, error: pipeline.error };
    }

    return {
      success: true,
      data: {
        info: {
          ...resolved.entry,
          scopes:
            resolved.entry.scopes ?? normalizePipeline(pipeline.data).scope,
          source: resolved.source,
          readonly: resolved.source === 'bundled',
        },
        content: pipeline.data,
        rawContent,
      },
    };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

export function getStoredPipelineBySource(
  source: 'bundled' | 'user',
  id: string,
): IPCResult<PipelineData> {
  try {
    const resolved = resolvePipelineEntryBySource(source, id);
    if (!resolved) {
      return { success: false, error: `Workflow not found: ${id}` };
    }

    const rawContent = safeReadFile(resolved.filePath);
    if (!rawContent) {
      return {
        success: false,
        error: `Workflow file not found: ${resolved.entry.filename}`,
      };
    }
    const pipeline = parsePipelineFile(rawContent, resolved.filePath);
    if (!pipeline.success || !pipeline.data) {
      return { success: false, error: pipeline.error };
    }

    return {
      success: true,
      data: {
        info: {
          ...resolved.entry,
          scopes:
            resolved.entry.scopes ?? normalizePipeline(pipeline.data).scope,
          source: resolved.source,
          readonly: resolved.source === 'bundled',
        },
        content: pipeline.data,
        rawContent,
      },
    };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

/** A stored definition's index entry and raw text, read for core. */
export type StoredPipelineDocumentRead =
  | { kind: 'missing' }
  | { kind: 'unreadable'; message: string }
  | {
      kind: 'found';
      source: 'user' | 'bundled';
      entry: PipelineIndexEntry;
      rawContent: string;
    };

/**
 * Read one stored definition by source, or by id with user before bundled.
 * Unlike the IPC readers, a missing entry is told apart from an unreadable
 * file, and the text is returned unparsed.
 */
export function readStoredPipelineDocument(
  id: string,
  source?: 'user' | 'bundled',
): StoredPipelineDocumentRead {
  const resolved = source
    ? resolvePipelineEntryBySource(source, id)
    : resolvePipelineEntry(id);
  if (!resolved) return { kind: 'missing' };
  const rawContent = safeReadFile(resolved.filePath);
  if (!rawContent) {
    return {
      kind: 'unreadable',
      message: `Workflow file not found: ${resolved.entry.filename}`,
    };
  }
  return {
    kind: 'found',
    source: resolved.source,
    entry: resolved.entry,
    rawContent,
  };
}

export function getStoredPipelineText(id: string): IPCResult<string> {
  try {
    const resolved = resolvePipelineEntry(id);
    if (!resolved) {
      return { success: false, error: `Workflow not found: ${id}` };
    }

    const raw = safeReadFile(resolved.filePath);
    if (!raw) {
      return {
        success: false,
        error: `Workflow file not found: ${resolved.entry.filename}`,
      };
    }

    return { success: true, data: raw };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

export function getStoredPipelinePath(id: string): IPCResult<string> {
  try {
    const resolved = resolvePipelineEntry(id);
    if (!resolved) {
      return { success: false, error: `Workflow not found: ${id}` };
    }

    return { success: true, data: resolved.filePath };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

export function getStoredPipelinePathWithSource(
  id: string,
): IPCResult<StoredPipelinePath> {
  try {
    const resolved = resolvePipelineEntry(id);
    if (!resolved) {
      return { success: false, error: `Workflow not found: ${id}` };
    }

    return {
      success: true,
      data: {
        source: resolved.source,
        filePath: resolved.filePath,
      },
    };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

export function saveStoredPipeline(
  input: PipelineSaveInput,
  trustedCreate?: { id: string },
): IPCResult<PipelineInfo> {
  try {
    const userDir = getUserPipelinesDir();
    if (!ensureDir(userDir)) {
      return {
        success: false,
        error: `Failed to ensure pipeline directory: ${userDir}`,
      };
    }

    const index = readIndex();
    const now = new Date().toISOString();
    const requestedId = trustedCreate?.id ?? input.id?.trim();
    if (requestedId && !isSafePipelineId(requestedId)) {
      return { success: false, error: `Invalid pipeline id: ${requestedId}` };
    }
    const existing = requestedId
      ? index.pipelines.findIndex((p) => p.id === requestedId)
      : -1;
    if (
      trustedCreate &&
      (!requestedId ||
        existing >= 0 ||
        existsSync(path.join(userDir, `${requestedId}.yaml`)))
    ) {
      return {
        success: false,
        error: 'Pipeline create identity already exists or is invalid',
      };
    }
    const id =
      (trustedCreate || existing >= 0) && requestedId
        ? requestedId
        : randomUUID();
    const filename = `${id}.yaml`;
    const userDirPath = path.resolve(userDir);
    const filePath = path.resolve(userDirPath, filename);
    if (!filePath.startsWith(`${userDirPath}${path.sep}`)) {
      return { success: false, error: `Invalid pipeline path for id: ${id}` };
    }

    const contentToSave: Pipeline = { ...input.content };
    delete contentToSave.readonly;

    if (input.rawContent !== undefined) {
      const rawPipeline = { ...parsePipelineText(input.rawContent) };
      delete rawPipeline.readonly;
      if (!isDeepStrictEqual(rawPipeline, contentToSave)) {
        return {
          success: false,
          error:
            'Raw pipeline document does not match parsed pipeline content.',
        };
      }
    }

    let normalized;
    try {
      normalized = normalizePipeline(contentToSave);
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    const yamlContent =
      input.rawContent ?? serializePipelineDocument(contentToSave);
    atomicWriteFile(filePath, yamlContent);

    const curatedOrigin = parseCuratedOrigin(
      input.curatedOrigin ??
        (existing >= 0 ? index.pipelines[existing].curatedOrigin : undefined),
    );
    const remote = existing >= 0 ? index.pipelines[existing].remote : undefined;
    const entry: PipelineIndexEntry = {
      id,
      name: input.name,
      filename,
      description: input.description,
      icon: input.icon,
      createdAt: existing >= 0 ? index.pipelines[existing].createdAt : now,
      updatedAt: now,
      ...(curatedOrigin ? { curatedOrigin } : {}),
      ...(remote ? { remote } : {}),
      revision:
        existing >= 0 ? (index.pipelines[existing].revision ?? 0) + 1 : 1,
      triggerTypes: getTriggerTypes(contentToSave.on),
      stepCount: Object.values(contentToSave.jobs).reduce(
        (count, job) => count + job.steps.length,
        0,
      ),
      scopes: normalized.scope,
    };

    if (existing >= 0) {
      index.pipelines[existing] = entry;
    } else {
      index.pipelines.push(entry);
    }

    try {
      writeIndex(index);
    } catch (error) {
      if (trustedCreate) safeDeleteFile(filePath);
      throw error;
    }
    return {
      success: true,
      data: { ...entry, source: 'user', readonly: false },
    };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

/** Persist the author-side cloud link beside a stored user pipeline. */
export function writeStoredPipelineRemoteMetadata(
  id: string,
  remote: ShareRemoteMetadata,
): IPCResult<PipelineInfo> {
  try {
    const index = readIndex();
    const entryIndex = index.pipelines.findIndex((entry) => entry.id === id);
    if (entryIndex < 0) {
      return { success: false, error: `Workflow not found: ${id}` };
    }
    const entry = { ...index.pipelines[entryIndex], remote: { ...remote } };
    index.pipelines[entryIndex] = entry;
    writeIndex(index);
    return {
      success: true,
      data: { ...entry, source: 'user', readonly: false },
    };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

/** Clear every stored user pipeline linked to the deleted cloud share. */
export function clearStoredPipelineRemoteMetadataByRemoteId(
  remoteId: string,
): IPCResult<number> {
  try {
    const index = readIndex();
    let count = 0;
    index.pipelines = index.pipelines.map((entry) => {
      if (entry.remote?.remoteId !== remoteId) return entry;
      const next = { ...entry };
      delete next.remote;
      count += 1;
      return next;
    });
    if (count > 0) writeIndex(index);
    return { success: true, data: count };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

/**
 * The stored revision of a user pipeline, `bundled` for a bundled id, or
 * `null` when neither store has it. A read and a write in the same
 * synchronous turn form a compare-and-swap within this process.
 */
export function readStoredPipelineRevision(
  id: string,
): { source: 'user'; revision: number } | { source: 'bundled' } | null {
  const entry = readIndex().pipelines.find((p) => p.id === id);
  if (entry) return { source: 'user', revision: entry.revision ?? 0 };
  return readBundledIndex().pipelines.some((p) => p.id === id)
    ? { source: 'bundled' }
    : null;
}

export function deleteStoredPipeline(id: string): IPCResult {
  try {
    const index = readIndex();
    const idx = index.pipelines.findIndex((p) => p.id === id);
    if (idx < 0) {
      if (readBundledIndex().pipelines.some((p) => p.id === id)) {
        return {
          success: false,
          error: `Cannot delete bundled workflow: ${id}`,
        };
      }
      return { success: false, error: `Workflow not found: ${id}` };
    }

    const entry = index.pipelines[idx];
    safeDeleteFile(path.join(getUserPipelinesDir(), entry.filename));
    index.pipelines.splice(idx, 1);
    writeIndex(index);
    return { success: true };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

export function updateStoredPipeline(
  id: string,
  input: PipelineSaveInput,
): IPCResult<PipelineInfo> {
  try {
    const index = readIndex();
    if (!index.pipelines.some((p) => p.id === id)) {
      if (readBundledIndex().pipelines.some((p) => p.id === id)) {
        return {
          success: false,
          error: `Cannot update bundled workflow: ${id}`,
        };
      }
      return { success: false, error: `Workflow not found: ${id}` };
    }

    return saveStoredPipeline({ ...input, id });
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

export function duplicateStoredPipeline(id: string): IPCResult<PipelineInfo> {
  try {
    const result = getStoredPipeline(id);
    if (!result.success || !result.data) {
      return { success: false, error: result.error || 'Source not found' };
    }

    const content: Pipeline = { ...result.data.content };
    delete content.readonly;

    return saveStoredPipeline({
      name: `${result.data.info.name} (Copy)`,
      curatedOrigin: result.data.info.curatedOrigin,
      description: result.data.info.description,
      icon: result.data.info.icon,
      content,
    });
  } catch (error) {
    return { success: false, error: String(error) };
  }
}
