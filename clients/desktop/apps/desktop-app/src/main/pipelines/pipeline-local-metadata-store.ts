import * as fs from 'node:fs';
import * as path from 'node:path';
import { serializePipelinePreferenceLocator } from '@canopy/desktop-shared/pipelines/plugin-collections';
import type {
  PipelineAgentAuthor,
  PipelineAgentChatAddress,
  PipelinePreferenceLocator,
} from '@canopy/desktop-shared/types/pipeline';
import { parseWorkspaceContext } from '@canopy/protocol/workspace-context';
import { getPipelineLocalMetadataFilePath } from '../lib/paths';
import { atomicWriteFile } from './fs-utils';

/**
 * Main-only facts about a user pipeline that never travel with its content:
 * the owner it was created in and the agent chat that last wrote it.
 */
export interface PipelineLocalMetadata {
  /** Serialized owner (`personal` / `org:<uuid>`). */
  owner?: string;
  agentAuthor?: PipelineAgentAuthor;
  /**
   * The automation this pipeline was generated for, which deletes it with
   * itself (CAN-4551, the Workflows plan's `workflow.owner`). A marker whose
   * automation is gone, or no longer runs this pipeline, is stale and ignored.
   */
  ownerAutomationId?: string;
}

interface PipelineLocalMetadataFile {
  version: 1;
  entries: Record<string, PipelineLocalMetadata>;
  /** The file exists but can't be read; it is never overwritten. */
  unreadable?: true;
}

function warn(message: string): void {
  process.stderr.write(`[pipeline-local-metadata] ${message}\n`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function normalizeChatAddress(
  value: unknown,
): PipelineAgentChatAddress | undefined {
  if (!isRecord(value)) return undefined;
  const projectId = nonEmptyString(value.projectId);
  const worktreeId = nonEmptyString(value.worktreeId);
  const chatId = nonEmptyString(value.chatId);
  return projectId && worktreeId && chatId
    ? { projectId, worktreeId, chatId }
    : undefined;
}

function normalizeEntry(value: unknown): PipelineLocalMetadata {
  if (!isRecord(value)) return {};
  const entry: PipelineLocalMetadata = {};
  if (
    typeof value.owner === 'string' &&
    parseWorkspaceContext(value.owner) !== null
  ) {
    entry.owner = value.owner;
  }
  if (isRecord(value.agentAuthor)) {
    const chat = normalizeChatAddress(value.agentAuthor.chat);
    const recordedAt = nonEmptyString(value.agentAuthor.recordedAt);
    if (chat && recordedAt) entry.agentAuthor = { chat, recordedAt };
  }
  const ownerAutomationId = nonEmptyString(value.ownerAutomationId);
  if (ownerAutomationId) entry.ownerAutomationId = ownerAutomationId;
  return entry;
}

/**
 * The last parsed file. Main is the only writer, and every write here
 * replaces the file atomically (a new inode) and refreshes this copy; the
 * stat key only lets a read notice a file replaced some other way.
 */
let cachedFile:
  | {
      filePath: string;
      key: string;
      file: PipelineLocalMetadataFile;
    }
  | undefined;

function statKey(stat: fs.Stats): string {
  return `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}

function copyOf(file: PipelineLocalMetadataFile): PipelineLocalMetadataFile {
  return { ...file, entries: { ...file.entries } };
}

function rememberFile(filePath: string, file: PipelineLocalMetadataFile): void {
  try {
    cachedFile = {
      filePath,
      key: statKey(fs.statSync(filePath)),
      file: copyOf(file),
    };
  } catch {
    cachedFile = undefined;
  }
}

function readMetadataFile(): PipelineLocalMetadataFile {
  const filePath = getPipelineLocalMetadataFilePath();
  try {
    const key = statKey(fs.statSync(filePath));
    if (cachedFile?.filePath === filePath && cachedFile.key === key)
      return copyOf(cachedFile.file);
  } catch {
    // Missing or unreadable; parsing below reports which.
  }
  const file = parseMetadataFile(filePath);
  // Only a parsed file is kept; a failed read is retried on the next call.
  if (file.unreadable) cachedFile = undefined;
  else rememberFile(filePath, file);
  return file;
}

function parseMetadataFile(filePath: string): PipelineLocalMetadataFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? error.code
        : undefined;
    if (code === 'ENOENT') return { version: 1, entries: {} };
    warn('Failed to parse metadata file; using empty defaults.');
    return { version: 1, entries: {}, unreadable: true };
  }
  if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.entries)) {
    warn('Unsupported metadata file version or shape; using empty defaults.');
    return { version: 1, entries: {}, unreadable: true };
  }
  const entries: Record<string, PipelineLocalMetadata> = {};
  for (const [locatorKey, rawEntry] of Object.entries(parsed.entries)) {
    const entry = normalizeEntry(rawEntry);
    if (Object.keys(entry).length > 0) entries[locatorKey] = entry;
  }
  return { version: 1, entries };
}

function writeMetadataFile(file: PipelineLocalMetadataFile): void {
  const filePath = getPipelineLocalMetadataFilePath();
  // Rewriting a file that can't be read would drop every owner it holds.
  if (file.unreadable) {
    warn('Metadata file is unreadable; leaving it unchanged.');
    return;
  }
  const entries: Record<string, PipelineLocalMetadata> = {};
  for (const [locatorKey, entry] of Object.entries(file.entries)) {
    if (Object.keys(entry).length > 0) entries[locatorKey] = entry;
  }
  // Metadata never fails the save or run that records it.
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    atomicWriteFile(
      filePath,
      `${JSON.stringify({ version: 1, entries }, null, 2)}\n`,
    );
    fs.chmodSync(filePath, 0o600);
    rememberFile(filePath, { version: 1, entries });
  } catch (error) {
    warn(
      `Failed to write metadata file: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function userPipelineKey(pipelineId: string): string {
  return serializePipelinePreferenceLocator({
    type: 'stored',
    source: 'user',
    value: pipelineId,
  });
}

/** Synchronous read-modify-write keeps writes ordered on the main event loop. */
function updateUserPipelineEntry(
  pipelineId: string,
  update: (entry: PipelineLocalMetadata) => PipelineLocalMetadata,
): void {
  const file = readMetadataFile();
  const key = userPipelineKey(pipelineId);
  file.entries[key] = update({ ...file.entries[key] });
  writeMetadataFile(file);
}

/** Whether stored owners can be read; a missing file counts as readable. */
export function isPipelineLocalMetadataReadable(): boolean {
  return readMetadataFile().unreadable !== true;
}

export function readPipelineLocalMetadata(
  locator: PipelinePreferenceLocator,
): PipelineLocalMetadata {
  return (
    readMetadataFile().entries[serializePipelinePreferenceLocator(locator)] ??
    {}
  );
}

export function recordUserPipelineOwner(
  pipelineId: string,
  owner: string,
): void {
  updateUserPipelineEntry(pipelineId, (entry) => ({ ...entry, owner }));
}

/** `null` clears the marker, as when the user saves the pipeline themselves. */
export function setUserPipelineAgentAuthor(
  pipelineId: string,
  author: PipelineAgentAuthor | null,
): void {
  const key = userPipelineKey(pipelineId);
  if (author === null && !readMetadataFile().entries[key]?.agentAuthor) return;
  updateUserPipelineEntry(pipelineId, (entry) => ({
    ...(entry.owner === undefined ? {} : { owner: entry.owner }),
    ...(author ? { agentAuthor: author } : {}),
    ...(entry.ownerAutomationId === undefined
      ? {}
      : { ownerAutomationId: entry.ownerAutomationId }),
  }));
}

/** `null` clears the owning automation (CAN-4551). */
export function setUserPipelineOwnerAutomation(
  pipelineId: string,
  automationId: string | null,
): void {
  const key = userPipelineKey(pipelineId);
  if (
    automationId === null &&
    !readMetadataFile().entries[key]?.ownerAutomationId
  )
    return;
  updateUserPipelineEntry(pipelineId, (entry) => {
    const { ownerAutomationId, ...rest } = entry;
    void ownerAutomationId;
    return automationId === null
      ? rest
      : { ...rest, ownerAutomationId: automationId };
  });
}

export function deleteUserPipelineLocalMetadata(pipelineId: string): void {
  const file = readMetadataFile();
  const key = userPipelineKey(pipelineId);
  if (!file.entries[key]) return;
  delete file.entries[key];
  writeMetadataFile(file);
}
