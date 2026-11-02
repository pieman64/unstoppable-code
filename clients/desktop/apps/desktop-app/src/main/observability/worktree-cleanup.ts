import {
  mkdir,
  readFile,
  readdir,
  rename,
  rmdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname } from 'node:path';
import type {
  AgentAuditEventType,
  AgentAuditTranscriptRequest,
} from '@canopy/desktop-shared/types';
import { parseAgentAuditEventType } from '@canopy/desktop-shared/types';
import {
  getAgentObservabilityAuditDayFilePath,
  getAgentObservabilityAuditDir,
  getAgentObservabilitySessionEventsDayFilePath,
  getAgentObservabilitySessionEventsDir,
  getAgentObservabilitySnapshotPath,
  getAgentObservabilityTranscriptDayDir,
  getAgentObservabilityTranscriptFilePath,
  getAgentObservabilityTranscriptIndexDayFilePath,
  getAgentObservabilityTranscriptIndexDir,
  getAgentObservabilityTranscriptsDir,
} from '../lib/paths';
import { isPathInside } from '../lib/path-safety';
import type { TranscriptIndexRecord } from './types';

interface PersistedWorktreeAuditEntry {
  id: string;
  eventType: AgentAuditEventType;
  startedAt: string;
  projectId?: string;
  worktreeId?: string;
}

interface PersistedSessionDiagnosticRecord {
  projectId: string;
  worktreeId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function safeJsonParse(line: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(line);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeCleanupWarning(message: string, detail: string): void {
  process.stderr.write(`${message}\n${detail}\n`);
}

function isSafeTranscriptPath(transcriptPath: string): boolean {
  return isPathInside(getAgentObservabilityTranscriptsDir(), transcriptPath);
}

function normalizePersistedEntry(
  value: Record<string, unknown>,
): PersistedWorktreeAuditEntry | null {
  const id = readString(value, 'id');
  const eventTypeRaw = readString(value, 'eventType');
  const startedAt = readString(value, 'startedAt');
  const eventType = eventTypeRaw
    ? parseAgentAuditEventType(eventTypeRaw)
    : null;

  if (!id || eventType === null || !startedAt) {
    return null;
  }

  return {
    id,
    eventType,
    startedAt,
    projectId: readString(value, 'projectId'),
    worktreeId: readString(value, 'worktreeId'),
  };
}

function persistedValueMatchesWorktree(
  value: Record<string, unknown>,
  projectId: string,
  worktreeId: string,
): boolean {
  return (
    readString(value, 'projectId') === projectId &&
    readString(value, 'worktreeId') === worktreeId
  );
}

function normalizeSessionDiagnosticRecord(
  value: Record<string, unknown>,
): PersistedSessionDiagnosticRecord | null {
  const projectId = readString(value, 'projectId');
  const worktreeId = readString(value, 'worktreeId');

  if (!projectId || !worktreeId) {
    return null;
  }

  return { projectId, worktreeId };
}

function normalizeTranscriptIndexRecord(
  value: Record<string, unknown>,
): TranscriptIndexRecord | null {
  const projectId = readString(value, 'projectId');
  const worktreeId = readString(value, 'worktreeId');
  const entryId = readString(value, 'entryId');
  const eventTypeRaw = readString(value, 'eventType');
  const startedAt = readString(value, 'startedAt');
  const transcriptPath = readString(value, 'transcriptPath');
  const eventType = eventTypeRaw
    ? parseAgentAuditEventType(eventTypeRaw)
    : null;

  if (
    value.version !== 1 ||
    !projectId ||
    !worktreeId ||
    !entryId ||
    eventType === null ||
    !startedAt ||
    !transcriptPath
  ) {
    return null;
  }

  return {
    version: 1,
    projectId,
    worktreeId,
    entryId,
    eventType,
    startedAt,
    transcriptPath,
  };
}

function entryMatchesWorktree(
  entry: Pick<PersistedWorktreeAuditEntry, 'projectId' | 'worktreeId'>,
  projectId: string,
  worktreeId: string,
): boolean {
  return entry.projectId === projectId && entry.worktreeId === worktreeId;
}

function buildTranscriptRequest(
  entry: Pick<PersistedWorktreeAuditEntry, 'id' | 'eventType' | 'startedAt'>,
): AgentAuditTranscriptRequest {
  return {
    id: entry.id,
    eventType: entry.eventType,
    startedAt: entry.startedAt,
  };
}

async function rewriteAuditDayFile(
  filePath: string,
  contents: string,
): Promise<void> {
  const tempPath = `${filePath}.tmp`;
  await mkdir(dirname(filePath), { recursive: true });
  let completed = false;
  try {
    await writeFile(tempPath, contents, 'utf8');
    await rename(tempPath, filePath);
    completed = true;
  } finally {
    if (!completed) {
      await rm(tempPath, { force: true }).catch(() => {});
    }
  }
}

async function rewriteJsonlFile(
  filePath: string,
  contents: string,
): Promise<void> {
  const tempPath = `${filePath}.tmp`;
  await mkdir(dirname(filePath), { recursive: true });
  let completed = false;
  try {
    await writeFile(tempPath, contents, 'utf8');
    await rename(tempPath, filePath);
    completed = true;
  } finally {
    if (!completed) {
      await rm(tempPath, { force: true }).catch(() => {});
    }
  }
}

async function removeDirectoryIfEmpty(dirPath: string): Promise<void> {
  try {
    const entries = await readdir(dirPath);
    if (entries.length === 0) {
      await rmdir(dirPath);
    }
  } catch {
    // Directory may not exist or may have become non-empty.
  }
}

export async function purgeWorktreeEntriesFromSnapshot(
  projectId: string,
  worktreeId: string,
): Promise<void> {
  const snapshotPath = getAgentObservabilitySnapshotPath();
  let contents = '';
  try {
    contents = await readFile(snapshotPath, 'utf8');
  } catch {
    return;
  }

  let parsed: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(contents);
    if (!isRecord(value)) {
      return;
    }
    parsed = value;
  } catch {
    writeCleanupWarning(
      '[observability] failed to parse snapshot during worktree purge',
      snapshotPath,
    );
    return;
  }

  const recentEntries = parsed.recentEntries;
  if (!Array.isArray(recentEntries)) {
    return;
  }

  const keptEntries = recentEntries.filter((entry) => {
    if (!isRecord(entry)) {
      return true;
    }
    return !entryMatchesWorktree(
      {
        projectId: readString(entry, 'projectId'),
        worktreeId: readString(entry, 'worktreeId'),
      },
      projectId,
      worktreeId,
    );
  });
  if (keptEntries.length === recentEntries.length) {
    return;
  }

  const nextSnapshot: Record<string, unknown> = {
    ...parsed,
    recentEntries: keptEntries,
  };
  const tempPath = `${snapshotPath}.tmp`;
  let completed = false;
  try {
    await writeFile(tempPath, JSON.stringify(nextSnapshot, null, 2), 'utf8');
    await rename(tempPath, snapshotPath);
    completed = true;
  } finally {
    if (!completed) {
      await rm(tempPath, { force: true }).catch(() => {});
    }
  }
}

export async function purgePersistedWorktreeObservabilityData(
  projectId: string,
  worktreeId: string,
): Promise<void> {
  // Usage metrics are intentionally excluded from per-worktree purge. They are
  // local-only aggregate events and deletion metrics must survive archive.
  const auditDir = getAgentObservabilityAuditDir();
  let filenames: string[] = [];
  try {
    filenames = await readdir(auditDir);
  } catch {
    filenames = [];
  }

  for (const filename of filenames.filter((name) => name.endsWith('.jsonl'))) {
    const day = filename.replace(/\.jsonl$/, '');
    const filePath = getAgentObservabilityAuditDayFilePath(day);
    let contents = '';
    try {
      contents = await readFile(filePath, 'utf8');
    } catch {
      continue;
    }

    const keptLines: string[] = [];
    let removedEntries = false;
    for (const line of contents.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }

      const parsed = safeJsonParse(trimmed);
      if (
        !parsed ||
        !persistedValueMatchesWorktree(parsed, projectId, worktreeId)
      ) {
        keptLines.push(trimmed);
        continue;
      }

      const entry = normalizePersistedEntry(parsed);
      if (entry) {
        await rm(
          getAgentObservabilityTranscriptFilePath(
            buildTranscriptRequest(entry),
          ),
          {
            force: true,
          },
        ).catch(() => {});
        await removeDirectoryIfEmpty(
          getAgentObservabilityTranscriptDayDir(day),
        );
      }
      removedEntries = true;
    }

    if (!removedEntries) {
      continue;
    }

    if (keptLines.length === 0) {
      await rm(filePath, { force: true }).catch(() => {});
      await removeDirectoryIfEmpty(getAgentObservabilityTranscriptDayDir(day));
      continue;
    }

    await rewriteAuditDayFile(filePath, `${keptLines.join('\n')}\n`);
  }

  await purgePersistedWorktreeSessionDiagnostics(projectId, worktreeId);

  const transcriptIndexDir = getAgentObservabilityTranscriptIndexDir();
  let transcriptIndexFilenames: string[] = [];
  try {
    transcriptIndexFilenames = await readdir(transcriptIndexDir);
  } catch {
    transcriptIndexFilenames = [];
  }

  for (const filename of transcriptIndexFilenames.filter((name) =>
    name.endsWith('.jsonl'),
  )) {
    const day = filename.replace(/\.jsonl$/, '');
    const filePath = getAgentObservabilityTranscriptIndexDayFilePath(day);
    let contents = '';
    try {
      contents = await readFile(filePath, 'utf8');
    } catch {
      continue;
    }

    const keptLines: string[] = [];
    let removedEntries = false;
    let loggedMalformedLine = false;
    for (const line of contents.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }

      const parsed = safeJsonParse(trimmed);
      const entry = parsed ? normalizeTranscriptIndexRecord(parsed) : null;
      if (!entry) {
        if (!loggedMalformedLine) {
          loggedMalformedLine = true;
          writeCleanupWarning(
            '[observability] dropping malformed transcript index line during worktree purge',
            filePath,
          );
        }
        removedEntries = true;
        continue;
      }

      if (!entryMatchesWorktree(entry, projectId, worktreeId)) {
        keptLines.push(trimmed);
        continue;
      }

      if (!isSafeTranscriptPath(entry.transcriptPath)) {
        writeCleanupWarning(
          '[observability] skipping transcript deletion outside transcripts root during worktree purge',
          entry.transcriptPath,
        );
      } else {
        await rm(entry.transcriptPath, { force: true }).catch(() => {});
        await removeDirectoryIfEmpty(dirname(entry.transcriptPath));
      }
      removedEntries = true;
    }

    if (!removedEntries) {
      continue;
    }

    if (keptLines.length === 0) {
      await rm(filePath, { force: true }).catch(() => {});
      continue;
    }

    await rewriteJsonlFile(filePath, `${keptLines.join('\n')}\n`);
  }

  await purgeWorktreeEntriesFromSnapshot(projectId, worktreeId);
}

/** Removes a worktree's persisted session diagnostics only. */
export async function purgePersistedWorktreeSessionDiagnostics(
  projectId: string,
  worktreeId: string,
): Promise<void> {
  const sessionEventsDir = getAgentObservabilitySessionEventsDir();
  let sessionEventFilenames: string[] = [];
  try {
    sessionEventFilenames = await readdir(sessionEventsDir);
  } catch {
    sessionEventFilenames = [];
  }

  for (const filename of sessionEventFilenames.filter((name) =>
    name.endsWith('.jsonl'),
  )) {
    const day = filename.replace(/\.jsonl$/, '');
    const filePath = getAgentObservabilitySessionEventsDayFilePath(day);
    let contents = '';
    try {
      contents = await readFile(filePath, 'utf8');
    } catch {
      continue;
    }

    const keptLines: string[] = [];
    let removedEntries = false;
    let loggedMalformedLine = false;
    for (const line of contents.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }

      const parsed = safeJsonParse(trimmed);
      if (!parsed) {
        if (!loggedMalformedLine) {
          loggedMalformedLine = true;
          writeCleanupWarning(
            '[observability] dropping malformed session diagnostic line during worktree purge',
            filePath,
          );
        }
        removedEntries = true;
        continue;
      }

      const entry = normalizeSessionDiagnosticRecord(parsed);
      if (!entry) {
        keptLines.push(trimmed);
        continue;
      }

      if (!entryMatchesWorktree(entry, projectId, worktreeId)) {
        keptLines.push(trimmed);
        continue;
      }

      removedEntries = true;
    }

    if (!removedEntries) {
      continue;
    }

    if (keptLines.length === 0) {
      await rm(filePath, { force: true }).catch(() => {});
      continue;
    }

    // Global app diagnostics are excluded here on purpose: only
    // `session-events/` carries worktree identifiers and participates in
    // per-worktree deletion.
    await rewriteJsonlFile(filePath, `${keptLines.join('\n')}\n`);
  }
}
