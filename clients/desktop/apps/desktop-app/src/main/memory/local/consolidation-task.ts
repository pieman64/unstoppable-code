import {
  memoryEditRevision,
  recordMemoryEdit,
  withMemoryWriteLock,
} from './edit-coordination';
import { createHash } from 'node:crypto';
import { access, readFile, readdir, rename, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import {
  type AgentModelConfig,
  type ChatModel,
  type ThinkingLevel,
} from '@canopy/desktop-shared/types';
import { getStructuredHelperQueryErrorUsage } from '@canopy/desktop-shared/lib/structured-helper-query';
import {
  IMPORTS_INPUT_BUDGET_BYTES,
  INBOX_INPUT_BUDGET_BYTES,
  MAX_INBOX_FILES_PER_RUN,
  TOPICS_INPUT_BUDGET_BYTES,
} from '@canopy/memory-consolidation/limits';
import {
  logicalMemorySourcePath,
  promptEntryCostBytes,
  type MemoryImportSourceTool,
} from '@canopy/memory-consolidation/input-budget';
import type {
  ConsolidationImportMetadata,
  ConsolidationInput,
  ConsolidationInputFile,
  ConsolidationInputOmission,
  ConsolidationOutput,
  ConsolidationUsageStats,
} from '@canopy/memory-consolidation/input';
import { isMemoryIndexWithinLimits } from '@canopy/memory-consolidation/memory-index';
import {
  compareUsageForRetention,
  parseTimestamp,
} from '@canopy/memory-consolidation/pruning';
import { redactMemoryContent } from '@canopy/memory-consolidation/redaction';
import {
  runMemoryConsolidation,
  type MemoryConsolidationApplyPlan,
  type MemoryConsolidationModelRequest,
  type MemoryConsolidationModelResponse,
  type MemoryConsolidationPorts,
  type MemoryConsolidationResult,
} from '@canopy/memory-consolidation/run';
import {
  normalizeTopicName,
  topicIdentity,
} from '@canopy/memory-consolidation/topic-identity';
import {
  finalizeObservedHelperTask,
  startObservedHelperTask,
} from '../../lib/helper-observed-task';
import { runLocalMemoryStructuredHelper } from './structured-helper';
import {
  assertMemoryPathContained,
  assertMemoryScopeLockHeld,
  ensureOwnerOnlyMemoryDir,
  isMemoryMarkdownFileName,
} from './memory-files';
import {
  LOCAL_MEMORY_READ_ONLY_MESSAGE,
  LocalMemoryScopeReadOnlyError,
} from './scope-manifest';
import { listPendingSources, type PendingSources } from './pending-sources';
import {
  LocalMemoryScopeChangedError,
  readLocalMemoryState,
  runVerifiedLocalMemoryWrite,
  saveLocalMemorySnapshot,
  type LocalMemoryState,
  type LocalMemoryWriteGuard,
  type StagedLocalMemoryFile,
} from './snapshots';
import { readUsage, usageEntryFor, type MemoryUsageEntry } from './usage';
import { deleteStaleUsageRows } from './consolidation-usage-cleanup';
import {
  stampImportsConsolidated,
  type ImportStateStagedEntry,
} from './import/ledger';

export type { ConsolidationInput } from '@canopy/memory-consolidation/input';

/*
 * The desktop host of a local memory consolidation run. The rules (prompt,
 * output schema, validation, topic and index handling, pruning) live in
 * `@canopy/memory-consolidation`, shared with Canopy Cloud; this module
 * collects the input from the scope folder, runs the model on the user's
 * memory model, and applies the result under the scope's write lock with a
 * snapshot and compensating rollback.
 */

export interface RunConsolidationOptions {
  scopeDir: string;
  workspaceId?: string;
  model: ChatModel;
  thinkingLevel: ThinkingLevel;
  modelConfig?: AgentModelConfig;
  shouldContinue?: () => boolean | Promise<boolean>;
  /**
   * Snapshot MEMORY.md and the topics before the write (default). A rebuild
   * turns this off for its own runs; its one snapshot precedes all of them.
   */
  snapshotBeforeWrite?: boolean;
  generate?: (
    input: ConsolidationInput,
    options: RunConsolidationOptions,
  ) => Promise<ConsolidationOutput | null>;
  /** Test seam for the one compaction retry of an oversized index. */
  compact?: (
    prompt: string,
    options: RunConsolidationOptions,
  ) => Promise<unknown>;
  now?: Date;
}

export type RunConsolidationResult = MemoryConsolidationResult;

async function readTextOrEmpty(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    // Only a missing file means "empty". Any other failure (EACCES, EIO, …)
    // must abort consolidation before MEMORY.md is overwritten or unread
    // inbox notes are archived based on silently-truncated input.
    if (isNodeError(error, 'ENOENT')) {
      return '';
    }
    throw error;
  }
}

function usageStatsFor(
  usage: Map<string, MemoryUsageEntry>,
  fileKey: string,
  fallbackCreatedAt: string,
): ConsolidationUsageStats {
  const stats = usageEntryFor(usage, fileKey);
  return stats
    ? {
        usageCount: stats.usageCount,
        lastUsedAt: stats.lastUsedAt,
        createdAt: stats.createdAt,
      }
    : {
        usageCount: 0,
        lastUsedAt: null,
        createdAt: fallbackCreatedAt,
      };
}

async function readInputFile(
  scopeDir: string,
  fileKey: string,
  filename: string,
  content: string,
  usage: Map<string, MemoryUsageEntry>,
  importMetadata?: ConsolidationImportMetadata,
): Promise<ConsolidationInputFile | null> {
  try {
    const info = await stat(join(scopeDir, fileKey));
    const modifiedAt = info.mtime.toISOString();
    const fallbackCreatedAt = (
      info.birthtimeMs > 0 ? info.birthtime : info.mtime
    ).toISOString();
    const inputFile: ConsolidationInputFile = {
      fileKey,
      filename,
      content,
      modifiedAt,
      usage: usageStatsFor(usage, fileKey, fallbackCreatedAt),
    };
    return importMetadata ? { ...inputFile, importMetadata } : inputFile;
  } catch (error) {
    // Only a file that disappeared between listing and stat may be dropped
    // from the snapshot. Any other stat failure (EACCES, EIO, …) must abort
    // consolidation — silently omitting the input would rewrite MEMORY.md
    // from an incomplete snapshot and could archive notes it never read.
    if (isNodeError(error, 'ENOENT')) {
      return null;
    }
    throw error;
  }
}

interface ConsolidationInputCandidate {
  fileKey: string;
  filename: string;
  usage: ConsolidationUsageStats;
  totalBytes: number;
  importMetadata?: ConsolidationImportMetadata;
}

interface ConsolidationInputBatch {
  files: ConsolidationInputFile[];
  omitted: ConsolidationInputOmission;
}

interface ConsolidationImportInputBatch extends ConsolidationInputBatch {
  hashMaterials: Array<{
    fileKey: string;
    fileHash: string;
    repo?: string;
    modified?: string;
    sourceTool?: MemoryImportSourceTool;
  }>;
}

async function inspectInputFile(
  scopeDir: string,
  fileKey: string,
  filename: string,
  usage: Map<string, MemoryUsageEntry>,
  importSource?: {
    originalPath: string;
    entry: ImportStateStagedEntry;
  },
): Promise<ConsolidationInputCandidate | null> {
  try {
    const info = await stat(join(scopeDir, fileKey));
    const fallbackCreatedAt = (
      info.birthtimeMs > 0 ? info.birthtime : info.mtime
    ).toISOString();
    const candidate: ConsolidationInputCandidate = {
      fileKey,
      filename,
      usage: usageStatsFor(usage, fileKey, fallbackCreatedAt),
      totalBytes: info.size,
    };
    if (!importSource) {
      return candidate;
    }
    const sourceTool = importSource.entry.sourceTool ?? 'claude-code';
    return {
      ...candidate,
      importMetadata: {
        sourceTool,
        originalPath: redactMemoryContent(
          logicalMemorySourcePath(sourceTool, importSource.originalPath),
        ),
        sourceFilename: redactMemoryContent(
          basename(importSource.originalPath),
        ),
        ...(importSource.entry.repo ? { repo: importSource.entry.repo } : {}),
        modified: importSource.entry.modified ?? info.mtime.toISOString(),
      },
    };
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) {
      return null;
    }
    throw error;
  }
}

async function materializeInputFile(
  scopeDir: string,
  candidate: ConsolidationInputCandidate,
  usage: Map<string, MemoryUsageEntry>,
): Promise<ConsolidationInputFile | null> {
  const content = await readTextOrEmpty(join(scopeDir, candidate.fileKey));
  return readInputFile(
    scopeDir,
    candidate.fileKey,
    candidate.filename,
    content,
    usage,
    candidate.importMetadata,
  );
}

// Sequential on purpose: a large backlog fanned out through Promise.all would
// otherwise issue thousands of concurrent stat() calls.
async function inspectInputFiles(
  scopeDir: string,
  entries: Array<{
    fileKey: string;
    filename: string;
    importSource?: { originalPath: string; entry: ImportStateStagedEntry };
  }>,
  usage: Map<string, MemoryUsageEntry>,
): Promise<ConsolidationInputCandidate[]> {
  const candidates: ConsolidationInputCandidate[] = [];
  for (const entry of entries) {
    const candidate = await inspectInputFile(
      scopeDir,
      entry.fileKey,
      entry.filename,
      usage,
      entry.importSource,
    );
    if (candidate !== null) {
      candidates.push(candidate);
    }
  }
  return candidates;
}

// The prompt embeds each file as an entry of JSON.stringify(entries, null, 2),
// so the budget must charge the serialized fragment (JSON escaping, the
// filename, and array indentation), not raw content bytes — a quote-heavy
// file serializes to roughly double its raw size. Every line of the entry is
// indented two extra spaces inside the array, plus the ",\n" separator.
// Single selection path for every input class so inbox and topic accounting
// cannot drift. 'stop' preserves FIFO semantics (everything behind the first
// over-budget file stays pending); 'skip' lets lower-ranked files fill the
// remaining room.
async function selectFilesWithinBudget(options: {
  scopeDir: string;
  usage: Map<string, MemoryUsageEntry>;
  candidates: ConsolidationInputCandidate[];
  budgetBytes: number;
  maxFiles: number;
  onOverBudget: 'stop' | 'skip';
}): Promise<ConsolidationInputBatch> {
  const files: ConsolidationInputFile[] = [];
  const omitted: ConsolidationInputOmission = {
    fileCount: 0,
    totalBytes: 0,
  };
  let includedBytes = 0;
  const omitRemaining = (fromIndex: number): void => {
    for (const remaining of options.candidates.slice(fromIndex)) {
      omitted.fileCount += 1;
      omitted.totalBytes += remaining.totalBytes;
    }
  };
  for (let index = 0; index < options.candidates.length; index += 1) {
    const candidate = options.candidates[index];
    if (!candidate) {
      continue;
    }
    if (files.length >= options.maxFiles) {
      omitRemaining(index);
      break;
    }
    // Raw size is a lower bound on the serialized cost, so a candidate whose
    // stat size alone busts the budget can be rejected without reading it.
    if (includedBytes + candidate.totalBytes > options.budgetBytes) {
      if (options.onOverBudget === 'stop') {
        omitRemaining(index);
        break;
      }
      omitted.fileCount += 1;
      omitted.totalBytes += candidate.totalBytes;
      continue;
    }
    const file = await materializeInputFile(
      options.scopeDir,
      candidate,
      options.usage,
    );
    if (file === null) {
      continue;
    }
    const costBytes = promptEntryCostBytes(file);
    if (includedBytes + costBytes > options.budgetBytes) {
      if (options.onOverBudget === 'stop') {
        omitted.fileCount += 1;
        omitted.totalBytes += costBytes;
        omitRemaining(index + 1);
        break;
      }
      omitted.fileCount += 1;
      omitted.totalBytes += costBytes;
      continue;
    }
    files.push(file);
    includedBytes += costBytes;
  }
  return { files, omitted };
}

async function readInboxFiles(
  scopeDir: string,
  usage: Map<string, MemoryUsageEntry>,
  names: string[],
): Promise<ConsolidationInputBatch> {
  const candidates = await inspectInputFiles(
    scopeDir,
    names.map((filename) => ({ fileKey: `inbox/${filename}`, filename })),
    usage,
  );
  return selectFilesWithinBudget({
    scopeDir,
    usage,
    candidates,
    budgetBytes: INBOX_INPUT_BUDGET_BYTES,
    maxFiles: MAX_INBOX_FILES_PER_RUN,
    onOverBudget: 'stop',
  });
}

async function readTopicFiles(
  scopeDir: string,
  usage: Map<string, MemoryUsageEntry>,
): Promise<ConsolidationInputBatch> {
  // Strict readers: the store's listTopics/readTopic swallow filesystem
  // errors by design (silent-fallback contract), which is wrong here — a
  // listing or read failure must abort consolidation rather than silently
  // dropping a topic from the consolidated snapshot. Enumerate and read the
  // topics directory directly with ENOENT-only tolerance, mirroring
  // readInboxFiles.
  const topicsDir = join(scopeDir, 'topics');
  let names: string[];
  try {
    const entries = await readdir(topicsDir, { withFileTypes: true });
    names = entries
      .filter((entry) => entry.isFile() && isMemoryMarkdownFileName(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) {
      return {
        files: [],
        omitted: { fileCount: 0, totalBytes: 0 },
      };
    }
    throw error;
  }
  const eligibleNames = names.filter((name) => {
    const stem = name.slice(0, -3);
    // Skip names the store would never list (keeps parity with listTopics).
    return normalizeTopicName(stem) === stem;
  });
  const inspected = await inspectInputFiles(
    scopeDir,
    eligibleNames.map((name) => ({
      fileKey: `topics/${name}`,
      filename: name,
    })),
    usage,
  );
  return selectFilesWithinBudget({
    scopeDir,
    usage,
    candidates: [...inspected].sort(compareUsageForRetention),
    budgetBytes: TOPICS_INPUT_BUDGET_BYTES,
    maxFiles: Number.POSITIVE_INFINITY,
    onOverBudget: 'skip',
  });
}

function warnAboutUnusableImports(pending: PendingSources): void {
  if (pending.ledgerUnreadable) {
    process.emitWarning(
      'Unreadable local memory import ledger; skipping staged imports this run',
      { code: 'LOCAL_MEMORY_CONSOLIDATION_IMPORT_LEDGER_INVALID' },
    );
    return;
  }
  for (const filename of pending.unusableImports) {
    process.emitWarning(
      `Staged import imported/${filename} has no ledger entry; skipping it this run`,
      { code: 'LOCAL_MEMORY_CONSOLIDATION_IMPORT_ORPHANED' },
    );
  }
}

async function readImportFiles(
  scopeDir: string,
  usage: Map<string, MemoryUsageEntry>,
  pending: PendingSources,
): Promise<ConsolidationImportInputBatch> {
  warnAboutUnusableImports(pending);
  const entries = pending.imports.map((pendingImport) => ({
    fileKey: pendingImport.fileKey,
    filename: pendingImport.filename,
    importSource: {
      originalPath: pendingImport.originalPath,
      entry: pendingImport.entry,
    },
  }));
  const hashMaterials: ConsolidationImportInputBatch['hashMaterials'] =
    pending.imports.map(({ fileKey, entry }) => ({
      fileKey,
      fileHash: entry.fileHash,
      ...(entry.sourceTool ? { sourceTool: entry.sourceTool } : {}),
      ...(entry.repo ? { repo: entry.repo } : {}),
      ...(entry.modified ? { modified: entry.modified } : {}),
    }));
  const inspected = await inspectInputFiles(scopeDir, entries, usage);
  const oldestFirst = [...inspected].sort((left, right) => {
    const leftModified = left.importMetadata?.modified ?? null;
    const rightModified = right.importMetadata?.modified ?? null;
    return (
      parseTimestamp(leftModified) - parseTimestamp(rightModified) ||
      left.fileKey.localeCompare(right.fileKey)
    );
  });
  const selected = await selectFilesWithinBudget({
    scopeDir,
    usage,
    candidates: oldestFirst,
    budgetBytes: IMPORTS_INPUT_BUDGET_BYTES,
    maxFiles: Number.POSITIVE_INFINITY,
    onOverBudget: 'stop',
  });
  return { ...selected, hashMaterials };
}

function hashInput(input: {
  memoryMd: string;
  topicFiles: ConsolidationInputFile[];
  inboxFiles: ConsolidationInputFile[];
  importFiles: ConsolidationInputFile[];
  importHashMaterials: ConsolidationImportInputBatch['hashMaterials'];
}): string {
  const hash = createHash('sha256');
  hash.update('MEMORY.md\0');
  hash.update(input.memoryMd);
  for (const file of [
    ...input.topicFiles,
    ...input.inboxFiles,
    ...input.importFiles,
  ].sort((a, b) => a.fileKey.localeCompare(b.fileKey))) {
    hash.update('\0');
    hash.update(file.fileKey);
    hash.update('\0');
    hash.update(file.content);
  }
  for (const material of [...input.importHashMaterials].sort((left, right) =>
    left.fileKey.localeCompare(right.fileKey),
  )) {
    hash.update('\0import-ledger\0');
    hash.update(material.fileKey);
    hash.update('\0');
    hash.update(material.fileHash);
    hash.update('\0');
    if (material.sourceTool) {
      hash.update(material.sourceTool);
      hash.update('\0');
    }
    hash.update(material.repo ?? '');
    hash.update('\0');
    hash.update(material.modified ?? '');
  }
  return hash.digest('hex');
}

export async function collectConsolidationInput(
  scopeDir: string,
): Promise<ConsolidationInput> {
  const memoryMd = await readTextOrEmpty(join(scopeDir, 'MEMORY.md'));
  const { trackingSince, entries: usage } = await readUsage(scopeDir);
  const pending = await listPendingSources(scopeDir);
  const inbox = await readInboxFiles(scopeDir, usage, pending.inboxFiles);
  const inboxFiles = inbox.files;
  const imports = await readImportFiles(scopeDir, usage, pending);
  const importFiles = imports.files;
  const indexWithinLimits = isMemoryIndexWithinLimits(memoryMd);
  if (
    inboxFiles.length === 0 &&
    importFiles.length === 0 &&
    imports.omitted.fileCount === 0 &&
    indexWithinLimits
  ) {
    return {
      memoryMd,
      topicFiles: [],
      inboxFiles,
      importFiles,
      omittedInboxFiles: inbox.omitted,
      omittedImportFiles: imports.omitted,
      inputHash: hashInput({
        memoryMd,
        topicFiles: [],
        inboxFiles,
        importFiles,
        importHashMaterials: imports.hashMaterials,
      }),
      indexWithinLimits,
      usageTrackingSince: trackingSince,
    };
  }

  const topics = await readTopicFiles(scopeDir, usage);
  const topicFiles = topics.files;
  return {
    memoryMd,
    topicFiles,
    inboxFiles,
    importFiles,
    omittedTopicFiles: topics.omitted,
    omittedInboxFiles: inbox.omitted,
    omittedImportFiles: imports.omitted,
    inputHash: hashInput({
      memoryMd,
      topicFiles,
      inboxFiles,
      importFiles,
      importHashMaterials: imports.hashMaterials,
    }),
    indexWithinLimits,
    usageTrackingSince: trackingSince,
  };
}

const OBSERVED_TASK_LABELS: Record<
  MemoryConsolidationModelRequest['purpose'],
  string
> = {
  consolidation: 'Memory Consolidation',
  compaction: 'Memory Compaction',
};

/**
 * One structured call on the user's local memory model, observed as a
 * helper task. A failed call records its failure here; otherwise the shared
 * run settles the task once it knows whether the answer was used.
 */
async function generateStructuredOutput(
  request: MemoryConsolidationModelRequest,
  options: RunConsolidationOptions,
): Promise<MemoryConsolidationModelResponse> {
  const model = options.model;
  const taskKey = `helper:local-memory-consolidation:${options.scopeDir}:${Date.now()}`;
  startObservedHelperTask({
    taskKey,
    eventType: 'local_memory_consolidation',
    label: OBSERVED_TASK_LABELS[request.purpose],
    model,
    modelConfig: options.modelConfig,
  });
  try {
    const result = await runLocalMemoryStructuredHelper({
      taskKey,
      kind: 'local-memory-consolidation',
      label: 'Local Memory Consolidation',
      scopeDir: options.scopeDir,
      workspaceId: options.workspaceId,
      helperModel: {
        model,
        thinkingLevel: options.thinkingLevel,
        modelConfig: options.modelConfig,
      },
      systemPrompt: request.systemPrompt,
      userMessage: request.userMessage,
      schema: request.schema,
      resultValidationSchema: request.resultValidationSchema,
      onResultRejected: request.onResultRejected,
      isResult: request.isResult,
    });
    const usage = result.usage;
    return {
      value: result.value,
      settle: (outcome, reason): void => {
        finalizeObservedHelperTask(taskKey, outcome, reason, usage);
      },
    };
  } catch (error) {
    finalizeObservedHelperTask(
      taskKey,
      'failure',
      error instanceof Error ? error.message : String(error),
      // Unwraps TransientAgentRetryExhaustedError too, so exhausted retries
      // still record their accumulated cross-attempt usage.
      getStructuredHelperQueryErrorUsage(error),
    );
    throw error;
  }
}

function consolidationModel(
  options: RunConsolidationOptions,
): MemoryConsolidationPorts['model'] {
  return async (request) => {
    if (request.purpose === 'consolidation' && options.generate) {
      return { value: await options.generate(request.input, options) };
    }
    if (request.purpose === 'compaction' && options.compact) {
      return { value: await options.compact(request.userMessage, options) };
    }
    return generateStructuredOutput(request, options);
  };
}

async function existingTopicIdentities(
  scopeDir: string,
): Promise<ReadonlySet<string>> {
  // Every file or link, not only the names the store lists: on a
  // case-insensitive filesystem a generated name replaces whatever entry
  // shares its identity. A directory cannot be replaced by a file rename.
  try {
    return new Set(
      (await readdir(join(scopeDir, 'topics'), { withFileTypes: true }))
        .filter((entry) => !entry.isDirectory())
        .map((entry) => topicIdentity(entry.name)),
    );
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return new Set();
    throw error;
  }
}

async function existingTopicNames(scopeDir: string): Promise<string[]> {
  try {
    return (await readdir(join(scopeDir, 'topics'), { withFileTypes: true }))
      .filter(
        (entry) =>
          entry.isFile() &&
          isMemoryMarkdownFileName(entry.name) &&
          normalizeTopicName(entry.name.slice(0, -3)) ===
            entry.name.slice(0, -3),
      )
      .map((entry) => entry.name);
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return [];
    throw error;
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  );
}

// Archives a consumed inbox/import file or pruned topic file. Imports use
// imported/.consolidated/; inbox notes and topics use inbox/.consolidated/
// (topics gain a `topic-` prefix). Returns the destination path, or null when
// the source no longer existed (nothing was moved, so there is nothing to
// undo). A topic is moved through `guard`, which checks it right before.
async function moveFileToConsolidated(
  scopeDir: string,
  file: ConsolidationInputFile,
  guard?: LocalMemoryWriteGuard,
): Promise<string | null> {
  const source = join(scopeDir, file.fileKey);
  const imported = file.fileKey.startsWith('imported/');
  const consolidatedDir = imported
    ? join(scopeDir, 'imported', '.consolidated')
    : join(scopeDir, 'inbox', '.consolidated');
  await ensureOwnerOnlyMemoryDir(scopeDir, consolidatedDir);
  const prefix = file.fileKey.startsWith('topics/') ? 'topic-' : '';
  const extensionIndex = file.filename.toLowerCase().lastIndexOf('.md');
  const stem =
    extensionIndex === -1
      ? file.filename
      : file.filename.slice(0, extensionIndex);
  let suffix = 1;
  while (true) {
    const destinationName =
      suffix === 1
        ? `${prefix}${file.filename}`
        : `${prefix}${stem}-${suffix}.md`;
    const destination = join(consolidatedDir, destinationName);
    try {
      await access(destination);
      suffix += 1;
      continue;
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) {
        throw error;
      }
    }
    try {
      if (guard) await guard.move(source, destination);
      else {
        await assertMemoryPathContained(scopeDir, consolidatedDir);
        await assertMemoryScopeLockHeld();
        await rename(source, destination);
      }
      return destination;
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) {
        return null;
      }
      if (!isNodeError(error, 'EEXIST')) {
        throw error;
      }
      suffix += 1;
    }
  }
}

interface CommittedFileWrite {
  targetPath: string;
  previousContent: string | null;
}

interface ArchivedInboxMove {
  sourcePath: string;
  destinationPath: string;
}

function emitRollbackWarning(error: unknown): void {
  // Emit the message string, not the Error instance: emitWarning ignores the
  // options object (and thus the code) when the first argument is an Error.
  process.emitWarning(error instanceof Error ? error.message : String(error), {
    code: 'LOCAL_MEMORY_CONSOLIDATION_ROLLBACK_FAILED',
  });
}

// Best-effort compensation for a commit that failed part-way: un-archive the
// already-moved inbox notes and imports, then, through the compare-before-
// destroy guard, un-archive pruned topics and restore (or remove) every
// already-committed file, in reverse commit order. The memory files are put
// back only while each still holds its bytes from before or after the
// commit (`expected`); anything else changed them meanwhile, and they are
// left as they are. Rollback failures are warned about and swallowed so the
// original commit error is what propagates to the caller.
async function rollbackAppliedConsolidation(
  scopeDir: string,
  expected: readonly LocalMemoryState[],
  committed: CommittedFileWrite[],
  archived: ArchivedInboxMove[],
): Promise<void> {
  const topicsDir = join(scopeDir, 'topics');
  const isTopicMove = (move: ArchivedInboxMove): boolean =>
    dirname(move.sourcePath) === topicsDir;
  for (const move of [...archived].reverse()) {
    if (isTopicMove(move)) continue;
    try {
      await assertMemoryScopeLockHeld();
      await rename(move.destinationPath, move.sourcePath);
    } catch (error) {
      emitRollbackWarning(error);
    }
  }
  try {
    await runVerifiedLocalMemoryWrite(scopeDir, expected, async (guard) => {
      // Stage every file to put back before the first change.
      const restores: Array<{
        targetPath: string;
        staged: StagedLocalMemoryFile | null;
      }> = [];
      for (const write of [...committed].reverse()) {
        restores.push({
          targetPath: write.targetPath,
          staged:
            write.previousContent === null
              ? null
              : await guard.stage(write.targetPath, write.previousContent),
        });
      }
      // A file that changed meanwhile stops every later change; the rest
      // are best effort.
      const attempt = async (change: () => Promise<unknown>): Promise<void> => {
        try {
          await change();
        } catch (error) {
          if (error instanceof LocalMemoryScopeChangedError) throw error;
          emitRollbackWarning(error);
        }
      };
      for (const move of [...archived].reverse()) {
        if (isTopicMove(move)) {
          await attempt(() =>
            guard.move(move.destinationPath, move.sourcePath),
          );
        }
      }
      for (const restore of restores) {
        const { staged } = restore;
        await attempt(() =>
          staged === null
            ? guard.remove(restore.targetPath)
            : guard.replace(staged),
        );
      }
    });
  } catch (error) {
    emitRollbackWarning(error);
  }
}

/**
 * The index and topics a complete commit of `output` over `prior` leaves:
 * the output's index, its topics in place of any of the same identity, and
 * the pruned topics gone.
 */
function consolidationTargetState(
  prior: LocalMemoryState,
  output: ConsolidationOutput,
  prunedTopics: ConsolidationInputFile[],
): LocalMemoryState {
  const written = output.topicFiles ?? [];
  const replaced = new Set([
    ...written.map((topic) => topicIdentity(topic.filename)),
    ...prunedTopics.map((file) => topicIdentity(file.filename)),
  ]);
  return {
    memoryMd: output.memoryMd,
    topicFiles: [
      ...prior.topicFiles.filter(
        (topic) => !replaced.has(topicIdentity(topic.filename)),
      ),
      ...written,
    ],
  };
}

// Applies validated consolidation output as staged writes plus a best-effort
// compensating rollback on the exception path; it is not all-or-nothing, and
// durability across a process crash mid-commit is out of scope. Stage phase:
// every generated file is fully written to a temp sibling first, so a write
// failure aborts before the live store is touched. Commit phase: staged
// files are renamed into place (topics before MEMORY.md, so the index is
// only ever replaced after every topic it references exists), inbox notes
// are archived, and pruned topics are archived after a final per-file
// revalidation; a failure anywhere in the commit triggers the compensating
// rollback of the files and moves already committed, so the exception path
// does not leave MEMORY.md inconsistent with the topics, pending inbox
// notes, and pruned topics.
async function applyConsolidationOutput(
  scopeDir: string,
  guard: LocalMemoryWriteGuard,
  prior: LocalMemoryState,
  output: ConsolidationOutput,
  inboxFiles: ConsolidationInputFile[],
  importFiles: ConsolidationInputFile[],
  prunedTopics: ConsolidationInputFile[],
  usageTrackingSince: string | null,
  consolidatedAt: string,
): Promise<void> {
  const writes = [
    ...(output.topicFiles ?? []).map((topic) => ({
      targetPath: join(scopeDir, 'topics', topic.filename),
      content: topic.content,
    })),
    { targetPath: join(scopeDir, 'MEMORY.md'), content: output.memoryMd },
  ];

  // Every file is staged before the first change; the guard deletes any
  // staged file that never reaches its target.
  const staged: StagedLocalMemoryFile[] = [];
  for (const write of writes) {
    staged.push(await guard.stage(write.targetPath, write.content));
  }

  const committed: CommittedFileWrite[] = [];
  const archived: ArchivedInboxMove[] = [];
  try {
    for (const file of staged) {
      const previousContent = await guard.replace(file);
      committed.push({ targetPath: file.targetPath, previousContent });
    }
    for (const file of inboxFiles) {
      const destinationPath = await moveFileToConsolidated(scopeDir, file);
      if (destinationPath !== null) {
        archived.push({
          sourcePath: join(scopeDir, file.fileKey),
          destinationPath,
        });
      }
    }
    const consolidatedImports: string[] = [];
    for (const file of importFiles) {
      const destinationPath = await moveFileToConsolidated(scopeDir, file);
      if (destinationPath !== null) {
        archived.push({
          sourcePath: join(scopeDir, file.fileKey),
          destinationPath,
        });
        consolidatedImports.push(file.fileKey);
      }
    }
    for (const file of prunedTopics) {
      // The awaited commit renames and inbox moves above reopened a race
      // window: a SearchMemory hit can commit a usage row after the prune
      // set was validated. Re-check the live usage store and the file's
      // mtime immediately before this file's rename so the remaining window
      // shrinks to the single rename. A veto here intentionally accepts the
      // already-committed MEMORY.md without this topic's index line: content
      // preservation wins over index completeness — the topic file survives
      // on disk and the next consolidation pass re-indexes it.
      const confirmedAtMove = await revalidatePruneCandidates(
        scopeDir,
        usageTrackingSince,
        [file],
      );
      if (confirmedAtMove.length === 0) {
        continue;
      }
      const destinationPath = await moveFileToConsolidated(
        scopeDir,
        file,
        guard,
      );
      if (destinationPath !== null) {
        archived.push({
          sourcePath: join(scopeDir, file.fileKey),
          destinationPath,
        });
      }
    }
    await stampImportsConsolidated(
      scopeDir,
      consolidatedImports,
      consolidatedAt,
    );
  } catch (error) {
    await rollbackAppliedConsolidation(
      scopeDir,
      [prior, consolidationTargetState(prior, output, prunedTopics)],
      committed,
      archived,
    );
    throw error;
  }
}

// Re-checks each prune candidate against the live file and usage store. The
// candidate set was computed from snapshots taken before LLM generation,
// which is slow; a user edit or a SearchMemory usage increment during that
// window must veto the prune (content changes surface through mtime).
async function revalidatePruneCandidates(
  scopeDir: string,
  snapshotTrackingSince: string | null,
  candidates: ConsolidationInputFile[],
): Promise<ConsolidationInputFile[]> {
  if (candidates.length === 0) {
    return [];
  }
  const current = await readUsage(scopeDir);
  // A store that became unavailable or was recreated since the snapshot no
  // longer backs the zero-usage evidence the candidates were selected on.
  if (
    current.trackingSince === null ||
    current.trackingSince !== snapshotTrackingSince
  ) {
    return [];
  }
  const validated: ConsolidationInputFile[] = [];
  for (const file of candidates) {
    let modifiedAt: string;
    try {
      const info = await stat(join(scopeDir, file.fileKey));
      modifiedAt = info.mtime.toISOString();
    } catch {
      // Vanished or unreadable since the snapshot: nothing safe to move.
      continue;
    }
    const usageCount =
      usageEntryFor(current.entries, file.fileKey)?.usageCount ?? 0;
    if (
      modifiedAt !== file.modifiedAt ||
      usageCount !== file.usage.usageCount
    ) {
      continue;
    }
    validated.push(file);
  }
  return validated;
}

/**
 * The scope's revision, read once the scope is ready for writes; null when
 * a newer build made it read-only.
 */
async function writableEditRevision(scopeDir: string): Promise<string | null> {
  try {
    return await withMemoryWriteLock(scopeDir, () =>
      memoryEditRevision(scopeDir),
    );
  } catch (error) {
    if (error instanceof LocalMemoryScopeReadOnlyError) return null;
    throw error;
  }
}

export async function runLocalMemoryConsolidation(
  options: RunConsolidationOptions,
): Promise<RunConsolidationResult> {
  const editRevision = await writableEditRevision(options.scopeDir);
  if (editRevision === null) {
    return { status: 'failed', reason: LOCAL_MEMORY_READ_ONLY_MESSAGE };
  }
  // The index and topics this run replaces, read before its input so the
  // input can only be newer: the commit runs only while the scope is still
  // exactly this state (compare-before-destroy), the consolidation snapshot
  // saves it, and a failed commit's rollback accepts only this state or the
  // one the commit was writing.
  const priorState = await readLocalMemoryState(options.scopeDir);
  const input = await collectConsolidationInput(options.scopeDir);
  const apply = async (
    plan: MemoryConsolidationApplyPlan,
  ): Promise<boolean> => {
    const applied = await withMemoryWriteLock(options.scopeDir, async () => {
      if ((await memoryEditRevision(options.scopeDir)) !== editRevision) {
        return false;
      }
      if (plan.writesDocuments) {
        await recordMemoryEdit(options.scopeDir);
        if (options.snapshotBeforeWrite !== false) {
          await saveLocalMemorySnapshot(
            options.scopeDir,
            priorState,
            'consolidation',
            plan.now,
          );
        }
        try {
          await runVerifiedLocalMemoryWrite(
            options.scopeDir,
            [priorState],
            (guard) =>
              applyConsolidationOutput(
                options.scopeDir,
                guard,
                priorState,
                plan.output,
                plan.consumedInboxFiles,
                plan.consumedImportFiles,
                plan.prunedTopics,
                input.usageTrackingSince,
                plan.now.toISOString(),
              ),
          );
        } catch (error) {
          // Edited outside the app since this run read it: cancel like an
          // in-app edit, with nothing written.
          if (error instanceof LocalMemoryScopeChangedError) return false;
          throw error;
        }
      }
      return true;
    });
    if (applied) {
      // Usage-row cleanup runs after the transactional apply: a failure here
      // fails the run but must not roll back the committed consolidation —
      // stale rows are advisory-only and swept again on the next pass.
      const usage = await readUsage(options.scopeDir);
      await deleteStaleUsageRows(options.scopeDir, usage.entries.keys());
    }
    return applied;
  };
  return runMemoryConsolidation(input, {
    model: consolidationModel(options),
    ...(options.shouldContinue
      ? { shouldContinue: options.shouldContinue }
      : {}),
    listTopicIdentities: () => existingTopicIdentities(options.scopeDir),
    listTopicNames: () => existingTopicNames(options.scopeDir),
    confirmPrunable: (candidates) =>
      revalidatePruneCandidates(
        options.scopeDir,
        input.usageTrackingSince,
        candidates,
      ),
    apply,
    warn: (message, code) => {
      process.emitWarning(message, { code });
    },
    now: () => options.now ?? new Date(),
  });
}
