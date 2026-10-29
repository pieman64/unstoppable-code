import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  StandaloneArchiveListEntry,
  StandaloneChatMetaFile,
} from '@canopy/desktop-shared/types';
import {
  getWorkspaceChatHistoryRootDir,
  getWorkspaceDerivedDir,
} from './paths';
import { resolveCoworkWorkspaceId } from './cowork-migration-map';
import { isRecord } from './type-guards';
import {
  readArchiveListing,
  readArchiveMeta,
  readArchiveSummary,
  type StandaloneArchiveListing,
} from './standalone-history';

function getHistoryIndexFilePath(projectId: string): string {
  return join(
    getWorkspaceDerivedDir(resolveCoworkWorkspaceId(projectId)),
    'history-index.json',
  );
}

interface HistoryIndexFile {
  version: 1;
  entries: StandaloneArchiveListEntry[];
}

function isArchiveListEntry(
  value: unknown,
): value is StandaloneArchiveListEntry {
  return (
    isRecord(value) &&
    typeof value.chatId === 'string' &&
    typeof value.title === 'string' &&
    typeof value.createdAt === 'string' &&
    typeof value.archivedAt === 'string' &&
    typeof value.messageCount === 'number' &&
    typeof value.hasConversationSnapshot === 'boolean' &&
    typeof value.legacySummaryOnly === 'boolean' &&
    (value.summaryPreview === undefined ||
      typeof value.summaryPreview === 'string') &&
    (value.providerType === undefined || typeof value.providerType === 'string')
  );
}

function trimSummaryPreview(summary: string): string | undefined {
  const trimmed = summary.replace(/\s+/g, ' ').trim();
  if (!trimmed) return undefined;
  return trimmed.length > 240 ? `${trimmed.slice(0, 237)}...` : trimmed;
}

function shouldIndexHistoryEntry(
  meta: StandaloneChatMetaFile | null,
  snapshot: StandaloneArchiveListing | null,
): boolean {
  if (!meta && !snapshot) {
    return false;
  }

  return snapshot !== null || meta?.archived === true;
}

function getHistoryTitle(
  chatId: string,
  meta: StandaloneChatMetaFile | null,
  snapshot: StandaloneArchiveListing | null,
): string {
  return snapshot?.title || meta?.title || meta?.description || chatId;
}

function getHistoryCreatedAt(
  meta: StandaloneChatMetaFile | null,
  snapshot: StandaloneArchiveListing | null,
): string {
  return snapshot?.createdAt || meta?.createdAt || new Date().toISOString();
}

function getHistoryArchivedAt(
  meta: StandaloneChatMetaFile | null,
  snapshot: StandaloneArchiveListing | null,
): string {
  return (
    snapshot?.archivedAt ||
    meta?.archivedAt ||
    meta?.lastMessageAt ||
    meta?.createdAt ||
    new Date().toISOString()
  );
}

function getHistoryMessageCount(
  meta: StandaloneChatMetaFile | null,
  snapshot: StandaloneArchiveListing | null,
): number {
  return snapshot?.messageCount ?? meta?.messageCount ?? 0;
}

function getOptionalHistoryFields(
  meta: StandaloneChatMetaFile | null,
  snapshot: StandaloneArchiveListing | null,
  summary: string,
): Partial<
  Pick<StandaloneArchiveListEntry, 'providerType' | 'summaryPreview'>
> {
  const fields: Partial<
    Pick<StandaloneArchiveListEntry, 'providerType' | 'summaryPreview'>
  > = {};
  const summaryPreview = trimSummaryPreview(summary);
  const providerType = snapshot?.providerType || meta?.providerType;

  if (summaryPreview) {
    fields.summaryPreview = summaryPreview;
  }
  if (providerType) {
    fields.providerType = providerType;
  }

  return fields;
}

export async function listHistoryChatIds(projectId: string): Promise<string[]> {
  const historyDir = getWorkspaceChatHistoryRootDir(
    resolveCoworkWorkspaceId(projectId),
  );
  try {
    const dirents = await readdir(historyDir, { withFileTypes: true });
    return dirents
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

async function buildHistoryEntry(
  projectId: string,
  chatId: string,
): Promise<StandaloneArchiveListEntry | null> {
  // Listing is a catalog read: `readArchiveListing` never admits or migrates
  // the archive. Migration stays on the explicit open path
  // (`readArchiveSnapshot`).
  const [meta, snapshot, summary] = await Promise.all([
    readArchiveMeta(projectId, chatId),
    readArchiveListing(projectId, chatId).catch(() => null),
    readArchiveSummary(projectId, chatId),
  ]);

  if (!shouldIndexHistoryEntry(meta, snapshot)) {
    return null;
  }

  return {
    chatId,
    title: getHistoryTitle(chatId, meta, snapshot),
    ...getOptionalHistoryFields(meta, snapshot, summary),
    createdAt: getHistoryCreatedAt(meta, snapshot),
    archivedAt: getHistoryArchivedAt(meta, snapshot),
    messageCount: getHistoryMessageCount(meta, snapshot),
    hasConversationSnapshot: snapshot !== null,
    legacySummaryOnly: snapshot === null,
  };
}

export async function rebuildHistoryIndex(
  projectId: string,
): Promise<StandaloneArchiveListEntry[]> {
  const entries = await listHistoryChatIds(projectId);

  // Sequential on purpose: each legacy listing spills its rows to scratch,
  // so a workspace with many archives must not open them all at once.
  const built: StandaloneArchiveListEntry[] = [];
  for (const chatId of entries) {
    const entry = await buildHistoryEntry(projectId, chatId);
    if (entry) built.push(entry);
  }

  built.sort(
    (a, b) =>
      new Date(b.archivedAt).getTime() - new Date(a.archivedAt).getTime(),
  );

  const filePath = getHistoryIndexFilePath(projectId);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(
    filePath,
    JSON.stringify(
      { version: 1, entries: built } satisfies HistoryIndexFile,
      null,
      2,
    ),
    'utf8',
  );
  return built;
}

export async function loadHistoryIndex(
  projectId: string,
): Promise<StandaloneArchiveListEntry[]> {
  try {
    const raw = await readFile(getHistoryIndexFilePath(projectId), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (
      isRecord(parsed) &&
      parsed.version === 1 &&
      Array.isArray(parsed.entries)
    ) {
      return parsed.entries.filter(isArchiveListEntry);
    }
  } catch {
    // Rebuild below.
  }

  return rebuildHistoryIndex(projectId);
}
