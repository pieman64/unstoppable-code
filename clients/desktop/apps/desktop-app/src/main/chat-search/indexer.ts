import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { chatTabLabel } from '@canopy/protocol';
import {
  getProviderForModel,
  type ArchivedContainerManifest,
  type ArchivedChatsFile,
  type ChatSearchCatalogEntry,
  type ChatSearchDocumentKind,
  type ChatTabsFile,
  type PersistedChatMessage,
  type PersistedChatTab,
  type TrackedPlanReviewStatus,
  type WorktreeSummaryData,
} from '@canopy/desktop-shared/types';
import { requireSqliteRow } from './sqlite-rows';
import { isRecord } from '../lib/type-guards';

export type ChatSearchSource = ChatSearchCatalogEntry['source'];

export interface ChatSearchDoc extends ChatSearchCatalogEntry {
  documentKind: ChatSearchDocumentKind;
  body: string;
  expiresAt: number | null;
  /** Present only when the body was projected from a canonical transcript. */
  transcriptFingerprint?: string;
  /**
   * Set when `body` holds exactly this committed transcript prefix and any
   * in-flight text is `activeBody`, a separate FTS row under the same doc id.
   * An active-sidecar revision then replaces that row without rewriting the
   * committed one.
   */
  committedFingerprint?: string;
  /** Text of the transcript's in-flight (active sidecar) rows. */
  activeBody?: string;
}

/** Indexed text a scope replacement can carry forward unchanged. */
export interface IndexedChatSearchBodies {
  body: string;
  activeBody?: string;
  committedFingerprint?: string;
}

export function isIndexedChatSearchBodies(
  value: unknown,
): value is IndexedChatSearchBodies {
  return (
    isRecord(value) &&
    typeof value.body === 'string' &&
    (value.activeBody === undefined || typeof value.activeBody === 'string') &&
    (value.committedFingerprint === undefined ||
      typeof value.committedFingerprint === 'string')
  );
}

function isChatSearchDoc(value: unknown): value is ChatSearchDoc {
  return (
    isRecord(value) &&
    typeof value.docId === 'string' &&
    typeof value.projectId === 'string' &&
    typeof value.worktreeId === 'string' &&
    typeof value.chatId === 'string' &&
    [
      'live',
      'worktree-archive',
      'cowork-archive',
      'archived-container',
      'plan',
    ].includes(typeof value.source === 'string' ? value.source : '') &&
    ['chat', 'plan', 'archived-container'].includes(
      typeof value.documentKind === 'string' ? value.documentKind : '',
    ) &&
    typeof value.title === 'string' &&
    typeof value.body === 'string' &&
    (value.transcriptFingerprint === undefined ||
      typeof value.transcriptFingerprint === 'string') &&
    (value.committedFingerprint === undefined ||
      typeof value.committedFingerprint === 'string') &&
    (value.activeBody === undefined || typeof value.activeBody === 'string') &&
    typeof value.updatedAt === 'number' &&
    Number.isFinite(value.updatedAt) &&
    typeof value.messageCount === 'number' &&
    Number.isFinite(value.messageCount) &&
    (value.expiresAt === null ||
      (typeof value.expiresAt === 'number' && Number.isFinite(value.expiresAt)))
  );
}

/**
 * The subset of `TrackedPlanData` the index needs. `TrackedPlanData` is
 * assignable to this shape, and the service's tolerant disk reader can build
 * it without validating the full plan schema.
 */
export interface TrackedPlanIndexEntry {
  id: string;
  title: string;
  content: string;
  reviewStatus?: TrackedPlanReviewStatus;
  createdAt?: string;
  updatedAt?: string;
  hidden?: boolean;
}

export interface SourceFingerprint {
  mtimeMs: number;
  sizeBytes: number;
}

function withImmediateTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE;');
  try {
    const result = fn();
    db.exec('COMMIT;');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK;');
    } catch {
      // Preserve the original write failure.
    }
    throw error;
  }
}

function parseTimestamp(value: string | undefined): number | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function getUpdatedAt(tab: PersistedChatTab, archivedAt?: string): number {
  if (tab.transcript)
    return (
      tab.transcript.lastMessageAt ??
      parseTimestamp(archivedAt) ??
      parseTimestamp(tab.createdAt) ??
      0
    );
  for (let index = tab.messages.length - 1; index >= 0; index -= 1) {
    const timestamp = tab.messages[index]?.timestamp;
    if (typeof timestamp === 'number' && Number.isFinite(timestamp)) {
      return timestamp;
    }
  }
  return parseTimestamp(archivedAt) ?? parseTimestamp(tab.createdAt) ?? 0;
}

/** Role-prefixed transcript text and tool output enter FTS; V2 callers resolve full output. */
export function extractChatSearchBody(
  messages: PersistedChatMessage[],
): string {
  return messages
    .map((message) => {
      if (
        typeof message !== 'object' ||
        message === null ||
        message.hidden === true ||
        !Array.isArray(message.blocks)
      ) {
        return null;
      }
      if (message.role !== 'user' && message.role !== 'assistant') {
        return null;
      }
      const text = message.blocks
        .map((block) => {
          if (typeof block !== 'object' || block === null) return '';
          if (block.type === 'text' && typeof block.text === 'string')
            return block.text.trim();
          if (block.type === 'tool_result' && typeof block.output === 'string')
            return block.output.trim();
          // A card whose children are in the delegate log has no child rows
          // here: its task and result stand in for them.
          if (
            block.type === 'delegated_agent_call' &&
            block.transcriptStore === 'chat-log-v1'
          )
            return [block.description, block.finalText ?? '']
              .map((value) => value.trim())
              .filter(Boolean)
              .join('\n');
          return '';
        })
        .filter(Boolean)
        .join('\n');
      if (!text) return null;
      const role = message.role === 'user' ? 'User' : 'Assistant';
      return `${role}: ${text}`;
    })
    .filter((value): value is string => value !== null)
    .join('\n\n');
}

export function buildChatSearchDoc(
  projectId: string,
  worktreeId: string,
  source: ChatSearchSource,
  tab: PersistedChatTab,
  archivedAt?: string,
  expiresAt?: string,
  projectedBody?: string,
): ChatSearchDoc {
  const providerType =
    tab.providerType ??
    (tab.model ? getProviderForModel(tab.model) : undefined);
  return {
    docId: `${projectId}/${worktreeId}/${tab.id}/${source}`,
    projectId,
    worktreeId,
    chatId: tab.id,
    source,
    documentKind: 'chat',
    title: chatTabLabel({ customTitle: tab.customTitle, title: tab.title }),
    description: tab.description ?? null,
    providerType: providerType ?? null,
    updatedAt: getUpdatedAt(tab, archivedAt),
    archivedAt: parseTimestamp(archivedAt),
    expiresAt: parseTimestamp(expiresAt),
    messageCount:
      tab.transcript?.messageCount ??
      tab.transcript?.committedMessageCount ??
      tab.messages.length,
    body: projectedBody ?? extractChatSearchBody(tab.messages),
    transcriptFingerprint:
      tab.transcript && projectedBody !== undefined
        ? transcriptFingerprint(tab.transcript)
        : undefined,
  };
}

/**
 * Identity of the transcript text an indexed body was projected from.
 * Committed counts and digest identify the durable prefix. Preview projection
 * also reads the active sidecar, so its revision must invalidate reuse while
 * active. Once the sidecar is gone, revisions alone do not change the body.
 */
export function transcriptFingerprint(
  transcript: NonNullable<PersistedChatTab['transcript']>,
): string {
  return JSON.stringify([
    transcript.format,
    transcript.committedMessageCount,
    transcript.committedByteLength,
    transcript.committedDigest ?? null,
    transcript.hasActiveSidecar,
    transcript.hasActiveSidecar ? transcript.transcriptRevision : null,
  ]);
}

/** Identity of the committed transcript prefix alone, without the sidecar. */
export function committedTranscriptFingerprint(
  transcript: NonNullable<PersistedChatTab['transcript']>,
): string {
  return JSON.stringify([
    transcript.format,
    transcript.committedMessageCount,
    transcript.committedByteLength,
    transcript.committedDigest ?? null,
  ]);
}

function sqliteRowid(value: unknown): number | bigint | null {
  return typeof value === 'number' || typeof value === 'bigint' ? value : null;
}

function chatTabsToDocs(
  projectId: string,
  worktreeId: string,
  data: ChatTabsFile,
): ChatSearchDoc[] {
  return data.tabs
    .filter((tab) => (tab.kind ?? 'chat') === 'chat')
    .map((tab) => buildChatSearchDoc(projectId, worktreeId, 'live', tab));
}

function archiveTabsToDocs(
  projectId: string,
  worktreeId: string,
  data: ArchivedChatsFile,
): ChatSearchDoc[] {
  return data.archived.map((entry) =>
    buildChatSearchDoc(
      projectId,
      worktreeId,
      'worktree-archive',
      entry.tab,
      entry.archivedAt,
    ),
  );
}

function archivedContainerTabsToDocs(
  projectId: string,
  containerId: string,
  chats: ChatTabsFile,
  archives: ArchivedChatsFile,
  archivedAt: string,
  expiresAt?: string,
): ChatSearchDoc[] {
  const byChatId = new Map<string, ChatSearchDoc>();
  for (const entry of archives.archived) {
    byChatId.set(
      entry.tab.id,
      buildChatSearchDoc(
        projectId,
        containerId,
        'archived-container',
        entry.tab,
        entry.archivedAt,
        expiresAt,
      ),
    );
  }
  for (const tab of chats.tabs) {
    if ((tab.kind ?? 'chat') !== 'chat') continue;
    byChatId.set(
      tab.id,
      buildChatSearchDoc(
        projectId,
        containerId,
        'archived-container',
        tab,
        archivedAt,
        expiresAt,
      ),
    );
  }
  return Array.from(byChatId.values());
}

export function buildPlanSearchDoc(
  projectId: string,
  worktreeId: string,
  plan: TrackedPlanIndexEntry,
  options?: {
    source?: ChatSearchSource;
    archivedAt?: string;
    expiresAt?: string;
  },
): ChatSearchDoc {
  const source = options?.source ?? 'plan';
  const docKindSuffix =
    source === 'archived-container' ? 'archived-container-plan' : source;
  return {
    docId: `${projectId}/${worktreeId}/${plan.id}/${docKindSuffix}`,
    projectId,
    worktreeId,
    chatId: plan.id,
    source,
    documentKind: 'plan',
    title: plan.title,
    description: null,
    providerType: null,
    updatedAt:
      parseTimestamp(plan.updatedAt) ?? parseTimestamp(plan.createdAt) ?? 0,
    archivedAt: parseTimestamp(options?.archivedAt),
    expiresAt: parseTimestamp(options?.expiresAt),
    messageCount: 0,
    reviewStatus: plan.reviewStatus ?? null,
    body: plan.content,
  };
}

export function buildArchivedContainerEntityDoc(
  manifest: ArchivedContainerManifest,
  summary: WorktreeSummaryData | null,
  messageCount: number,
  expiresAt?: string,
): ChatSearchDoc {
  const title = manifest.label?.trim() || manifest.name;
  const description = summary?.description?.trim() || null;
  const body = [
    manifest.name,
    manifest.label,
    manifest.branchName,
    manifest.originalWorktree?.label,
    manifest.originalWorktree?.branchName,
    manifest.originalEntry?.title,
    summary?.title,
    summary?.description,
    ...(summary?.highlights ?? []),
  ]
    .filter(
      (value): value is string =>
        typeof value === 'string' && value.trim().length > 0,
    )
    .join('\n');
  return {
    docId: `${manifest.projectId}/${manifest.id}/__container__/archived-container`,
    projectId: manifest.projectId,
    worktreeId: manifest.id,
    chatId: '__container__',
    source: 'archived-container',
    documentKind: 'archived-container',
    title,
    description,
    providerType: null,
    updatedAt:
      parseTimestamp(manifest.archivedAt) ??
      parseTimestamp(manifest.createdAt) ??
      0,
    archivedAt: parseTimestamp(manifest.archivedAt),
    expiresAt: parseTimestamp(expiresAt),
    messageCount,
    body,
  };
}

function plansToDocs(
  projectId: string,
  worktreeId: string,
  plans: readonly TrackedPlanIndexEntry[],
): ChatSearchDoc[] {
  return plans
    .filter((plan) => plan.hidden !== true)
    .map((plan) => buildPlanSearchDoc(projectId, worktreeId, plan));
}

export class ChatSearchIndexer {
  constructor(private readonly db: DatabaseSync) {}

  replaceLiveTabs(
    projectId: string,
    worktreeId: string,
    data: ChatTabsFile,
  ): void {
    this.replaceScope(
      projectId,
      worktreeId,
      'live',
      chatTabsToDocs(projectId, worktreeId, data),
    );
  }

  replaceWorktreeArchives(
    projectId: string,
    worktreeId: string,
    data: ArchivedChatsFile,
  ): void {
    this.replaceScope(
      projectId,
      worktreeId,
      'worktree-archive',
      archiveTabsToDocs(projectId, worktreeId, data),
    );
  }

  replaceWorktreePlans(
    projectId: string,
    worktreeId: string,
    plans: readonly TrackedPlanIndexEntry[],
  ): void {
    this.replaceScope(
      projectId,
      worktreeId,
      'plan',
      plansToDocs(projectId, worktreeId, plans),
    );
  }

  replaceArchivedContainer(
    manifest: ArchivedContainerManifest,
    summary: WorktreeSummaryData | null,
    chats: ChatTabsFile,
    archives: ArchivedChatsFile,
    plans: readonly TrackedPlanIndexEntry[],
    expiresAt?: string,
  ): void {
    const projectId = manifest.projectId;
    const containerId = manifest.id;
    const archivedAt = manifest.archivedAt;
    const chatDocs = archivedContainerTabsToDocs(
      projectId,
      containerId,
      chats,
      archives,
      archivedAt,
      expiresAt,
    );
    const messageCount = chatDocs.reduce(
      (total, doc) => total + doc.messageCount,
      0,
    );
    this.replaceScope(projectId, containerId, 'archived-container', [
      buildArchivedContainerEntityDoc(
        manifest,
        summary,
        messageCount,
        expiresAt,
      ),
      ...chatDocs,
      // Work-entry archives cannot capture tracked plans, and their viewer has
      // no Plans tab. Keep that invariant explicit and defensively avoid
      // publishing an unreachable deep link if a malformed archive contains
      // plan data.
      ...(manifest.kind === 'worktree' ? plans : [])
        .filter((plan) => plan.hidden !== true)
        .map((plan) =>
          buildPlanSearchDoc(projectId, containerId, plan, {
            source: 'archived-container',
            archivedAt,
            expiresAt,
          }),
        ),
    ]);
  }

  deleteArchivedContainerDocs(projectId: string, containerId: string): void {
    this.deleteMatchingDocs(
      'project_id = ? AND worktree_id = ? AND source = ?',
      [projectId, containerId, 'archived-container'],
    );
  }

  upsertCoworkArchive(
    projectId: string,
    worktreeId: string,
    tab: PersistedChatTab,
    archivedAt: string,
  ): void {
    this.upsertDoc(
      buildChatSearchDoc(
        projectId,
        worktreeId,
        'cowork-archive',
        tab,
        archivedAt,
      ),
    );
  }

  upsertLiveTab(
    projectId: string,
    worktreeId: string,
    tab: PersistedChatTab,
  ): void {
    if ((tab.kind ?? 'chat') !== 'chat') return;
    this.upsertDoc(buildChatSearchDoc(projectId, worktreeId, 'live', tab));
  }

  deleteChatDoc(
    projectId: string,
    worktreeId: string,
    chatId: string,
    source: ChatSearchSource,
  ): void {
    const docId = `${projectId}/${worktreeId}/${chatId}/${source}`;
    withImmediateTransaction(this.db, () => {
      this.db.prepare('DELETE FROM chat_fts WHERE doc_id = ?').run(docId);
      this.db.prepare('DELETE FROM chat_docs WHERE doc_id = ?').run(docId);
    });
  }

  deleteDocById(docId: string): void {
    withImmediateTransaction(this.db, () => {
      this.db.prepare('DELETE FROM chat_fts WHERE doc_id = ?').run(docId);
      this.db.prepare('DELETE FROM chat_docs WHERE doc_id = ?').run(docId);
    });
  }

  deleteWorktreeDocs(projectId: string, worktreeId: string): void {
    this.deleteMatchingDocs('project_id = ? AND worktree_id = ?', [
      projectId,
      worktreeId,
    ]);
  }

  deleteWorkspaceDocs(projectId: string): void {
    this.deleteMatchingDocs('project_id = ?', [projectId]);
  }

  getSourceFingerprint(fileKey: string): SourceFingerprint | null {
    const result: unknown = this.db
      .prepare(
        `SELECT mtime_ms AS mtimeMs, size_bytes AS sizeBytes
         FROM source_files WHERE file_key = ?`,
      )
      .get(fileKey);
    if (result === undefined) return null;
    const row = requireSqliteRow(result);
    if (typeof row.mtimeMs !== 'number' || typeof row.sizeBytes !== 'number') {
      return null;
    }
    return { mtimeMs: row.mtimeMs, sizeBytes: row.sizeBytes };
  }

  setSourceFingerprint(fileKey: string, fingerprint: SourceFingerprint): void {
    this.db
      .prepare(
        `INSERT INTO source_files (file_key, mtime_ms, size_bytes)
         VALUES (?, ?, ?)
         ON CONFLICT(file_key) DO UPDATE SET
           mtime_ms = excluded.mtime_ms,
           size_bytes = excluded.size_bytes`,
      )
      .run(fileKey, fingerprint.mtimeMs, fingerprint.sizeBytes);
  }

  listSourceFileKeys(): string[] {
    const rows: unknown[] = this.db
      .prepare('SELECT file_key FROM source_files')
      .all();
    return rows.flatMap((result) => {
      const row = requireSqliteRow(result);
      return typeof row.file_key === 'string' ? [row.file_key] : [];
    });
  }

  deleteSourceFile(fileKey: string): void {
    this.db.prepare('DELETE FROM source_files WHERE file_key = ?').run(fileKey);
  }

  setMetadata(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO search_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  /** Stage each projected chat separately in SQLite. A failed transcript read
   * leaves the complete old search scope intact; no aggregate body array and
   * no transaction held open across disk awaits.
   */
  public async replaceStreamedScope(
    projectId: string,
    worktreeId: string,
    source: ChatSearchSource,
    docs: AsyncIterable<ChatSearchDoc>,
    isCurrent: () => boolean = () => true,
  ): Promise<void> {
    const job = this.beginStagedScope();
    let ordinal = 0;
    try {
      for await (const doc of docs) {
        if (!isCurrent()) return;
        this.stageScopeDoc(job, ordinal++, doc);
      }
      if (isCurrent())
        this.commitStagedScope(job, projectId, worktreeId, source);
    } finally {
      this.discardStagedScope(job);
    }
  }

  beginStagedScope(): string {
    this.db.exec(
      'CREATE TEMP TABLE IF NOT EXISTS chat_search_staging (job TEXT NOT NULL, ordinal INTEGER NOT NULL, document TEXT NOT NULL, PRIMARY KEY (job, ordinal))',
    );
    return randomUUID();
  }

  stageScopeDoc(job: string, ordinal: number, doc: ChatSearchDoc): void {
    this.db
      .prepare(
        'INSERT INTO chat_search_staging (job, ordinal, document) VALUES (?, ?, ?)',
      )
      .run(job, ordinal, JSON.stringify(doc));
  }

  commitStagedScope(
    job: string,
    projectId: string,
    worktreeId: string,
    source: ChatSearchSource,
  ): void {
    const rows = this.db
      .prepare(
        'SELECT document FROM chat_search_staging WHERE job = ? ORDER BY ordinal',
      )
      .iterate(job);
    this.replaceScope(
      projectId,
      worktreeId,
      source,
      (function* (): Generator<ChatSearchDoc> {
        for (let row = rows.next(); !row.done; row = rows.next()) {
          const value = requireSqliteRow(row.value);
          if (typeof value.document !== 'string')
            throw new Error('Invalid staged search document');
          const parsed: unknown = JSON.parse(value.document);
          if (!isChatSearchDoc(parsed))
            throw new Error('Invalid staged search document');
          yield parsed;
        }
      })(),
    );
  }

  discardStagedScope(job: string): void {
    this.db.prepare('DELETE FROM chat_search_staging WHERE job = ?').run(job);
  }

  private replaceScope(
    projectId: string,
    worktreeId: string,
    source: ChatSearchSource,
    docs: Iterable<ChatSearchDoc>,
  ): void {
    withImmediateTransaction(this.db, () => {
      const existing: unknown[] = this.db
        .prepare(
          `SELECT doc_id FROM chat_docs
           WHERE project_id = ? AND worktree_id = ? AND source = ?`,
        )
        .all(projectId, worktreeId, source);
      const deleteFts = this.db.prepare(
        'DELETE FROM chat_fts WHERE doc_id = ?',
      );
      for (const result of existing) {
        const row = requireSqliteRow(result);
        if (typeof row.doc_id === 'string') deleteFts.run(row.doc_id);
      }
      this.db
        .prepare(
          `DELETE FROM chat_docs
           WHERE project_id = ? AND worktree_id = ? AND source = ?`,
        )
        .run(projectId, worktreeId, source);
      const iterator = docs[Symbol.iterator]();
      for (let row = iterator.next(); !row.done; row = iterator.next())
        this.writeDoc(row.value);
    });
  }

  public upsertDoc(doc: ChatSearchDoc): void {
    withImmediateTransaction(this.db, () => {
      this.db.prepare('DELETE FROM chat_fts WHERE doc_id = ?').run(doc.docId);
      this.writeDoc(doc);
    });
  }

  /**
   * The indexed text for `docId` when it was projected from the same
   * transcript and its FTS row still exists; otherwise null. Lets scope
   * replacements carry unchanged chats forward without re-reading transcripts.
   */
  public getIndexedBodiesIfTranscriptUnchanged(
    docId: string,
    fingerprint: string,
  ): IndexedChatSearchBodies | null {
    const rows: unknown[] = this.db
      .prepare(
        `SELECT chat_fts.body AS body,
                chat_fts.rowid IS chat_docs.active_fts_rowid AS active,
                chat_docs.committed_fingerprint AS committed_fingerprint
         FROM chat_docs
         JOIN chat_fts ON chat_fts.doc_id = chat_docs.doc_id
         WHERE chat_docs.doc_id = ? AND chat_docs.transcript_fingerprint = ?`,
      )
      .all(docId, fingerprint);
    let indexed: IndexedChatSearchBodies | null = null;
    let activeBody: string | undefined;
    for (const result of rows) {
      const row = requireSqliteRow(result);
      if (typeof row.body !== 'string') return null;
      if (row.active === 1) {
        activeBody = row.body;
        continue;
      }
      indexed = {
        body: row.body,
        ...(typeof row.committed_fingerprint === 'string'
          ? { committedFingerprint: row.committed_fingerprint }
          : {}),
      };
    }
    if (indexed === null) return null;
    return activeBody === undefined ? indexed : { ...indexed, activeBody };
  }

  /** The committed prefix identity whose text the doc's body row holds. */
  public getIndexedCommittedFingerprint(docId: string): string | null {
    const result: unknown = this.db
      .prepare('SELECT committed_fingerprint FROM chat_docs WHERE doc_id = ?')
      .get(docId);
    if (result === undefined) return null;
    const row = requireSqliteRow(result);
    return typeof row.committed_fingerprint === 'string'
      ? row.committed_fingerprint
      : null;
  }

  /**
   * Replaces a transcript's in-flight row and its metadata while the index
   * still holds the committed text `doc.committedFingerprint` identifies.
   * `doc.body` is ignored. False means nothing changed and the caller must
   * project the whole transcript.
   */
  public replaceActiveBodyIfCommittedUnchanged(doc: ChatSearchDoc): boolean {
    const expected = doc.committedFingerprint;
    if (expected === undefined) return false;
    return withImmediateTransaction(this.db, () => {
      const result: unknown = this.db
        .prepare(
          `SELECT title, committed_fingerprint, active_fts_rowid
           FROM chat_docs WHERE doc_id = ?`,
        )
        .get(doc.docId);
      if (result === undefined) return false;
      const row = requireSqliteRow(result);
      if (row.committed_fingerprint !== expected) return false;
      const activeRowid = sqliteRowid(row.active_fts_rowid);
      const committedRow = this.db
        .prepare('SELECT 1 FROM chat_fts WHERE doc_id = ? AND rowid IS NOT ?')
        .get(doc.docId, activeRowid);
      if (committedRow === undefined) return false;
      if (activeRowid !== null)
        this.db
          .prepare('DELETE FROM chat_fts WHERE rowid = ? AND doc_id = ?')
          .run(activeRowid, doc.docId);
      if (row.title !== doc.title)
        this.db
          .prepare('UPDATE chat_fts SET title = ? WHERE doc_id = ?')
          .run(doc.title, doc.docId);
      this.writeDocMetadata(doc);
      this.writeActiveRow(doc);
      return true;
    });
  }

  /** Atomically refresh metadata only when a matching full body is already indexed. */
  public updateDocMetadataIfTranscriptUnchanged(doc: ChatSearchDoc): boolean {
    if (!doc.transcriptFingerprint) return false;
    const result = this.db
      .prepare(
        `SELECT * FROM chat_docs WHERE doc_id = ?
        AND EXISTS (SELECT 1 FROM chat_fts WHERE doc_id = ?)`,
      )
      .get(doc.docId, doc.docId);
    if (!result) return false;
    const row = requireSqliteRow(result);
    if (row.transcript_fingerprint !== doc.transcriptFingerprint) return false;
    const expected = {
      project_id: doc.projectId,
      worktree_id: doc.worktreeId,
      chat_id: doc.chatId,
      source: doc.source,
      document_kind: doc.documentKind,
      title: doc.title,
      description: doc.description ?? null,
      provider_type: doc.providerType ?? null,
      updated_at: doc.updatedAt,
      archived_at: doc.archivedAt ?? null,
      message_count: doc.messageCount,
      expires_at: doc.expiresAt,
      review_status: doc.reviewStatus ?? null,
    };
    // Provider events often only update runtime state. Avoid opening a write
    // transaction (and a disk commit) when the searchable metadata is identical.
    if (Object.entries(expected).every(([key, value]) => row[key] === value))
      return true;
    return withImmediateTransaction(this.db, () => {
      this.writeDocMetadata(doc);
      if (row.title !== doc.title)
        this.db
          .prepare('UPDATE chat_fts SET title = ? WHERE doc_id = ?')
          .run(doc.title, doc.docId);
      return true;
    });
  }

  private writeDoc(doc: ChatSearchDoc): void {
    this.writeDocMetadata(doc);
    this.db
      .prepare('INSERT INTO chat_fts (doc_id, title, body) VALUES (?, ?, ?)')
      .run(doc.docId, doc.title, doc.body);
    this.writeActiveRow(doc);
  }

  /** Inserts the in-flight row, if any, and records how the doc is split. */
  private writeActiveRow(doc: ChatSearchDoc): void {
    const activeRowid = doc.activeBody
      ? this.db
          .prepare(
            'INSERT INTO chat_fts (doc_id, title, body) VALUES (?, ?, ?)',
          )
          .run(doc.docId, doc.title, doc.activeBody).lastInsertRowid
      : null;
    this.db
      .prepare(
        `UPDATE chat_docs SET committed_fingerprint = ?, active_fts_rowid = ?
         WHERE doc_id = ?`,
      )
      .run(doc.committedFingerprint ?? null, activeRowid, doc.docId);
  }

  private writeDocMetadata(doc: ChatSearchDoc): void {
    this.db
      .prepare(
        `INSERT INTO chat_docs (
           doc_id, project_id, worktree_id, chat_id, source, document_kind, title,
           description, provider_type, updated_at, archived_at, message_count,
           expires_at, review_status, transcript_fingerprint
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(doc_id) DO UPDATE SET
           project_id = excluded.project_id,
           worktree_id = excluded.worktree_id,
           chat_id = excluded.chat_id,
           source = excluded.source,
           document_kind = excluded.document_kind,
           title = excluded.title,
           description = excluded.description,
           provider_type = excluded.provider_type,
           updated_at = excluded.updated_at,
           archived_at = excluded.archived_at,
           message_count = excluded.message_count,
           expires_at = excluded.expires_at,
           review_status = excluded.review_status,
           transcript_fingerprint = excluded.transcript_fingerprint`,
      )
      .run(
        doc.docId,
        doc.projectId,
        doc.worktreeId,
        doc.chatId,
        doc.source,
        doc.documentKind,
        doc.title,
        doc.description ?? null,
        doc.providerType ?? null,
        doc.updatedAt,
        doc.archivedAt ?? null,
        doc.messageCount,
        doc.expiresAt,
        doc.reviewStatus ?? null,
        doc.transcriptFingerprint ?? null,
      );
  }

  private deleteMatchingDocs(whereClause: string, params: string[]): void {
    withImmediateTransaction(this.db, () => {
      const rows: unknown[] = this.db
        .prepare(`SELECT doc_id FROM chat_docs WHERE ${whereClause}`)
        .all(...params);
      const deleteFts = this.db.prepare(
        'DELETE FROM chat_fts WHERE doc_id = ?',
      );
      for (const result of rows) {
        const row = requireSqliteRow(result);
        if (typeof row.doc_id === 'string') deleteFts.run(row.doc_id);
      }
      this.db
        .prepare(`DELETE FROM chat_docs WHERE ${whereClause}`)
        .run(...params);
    });
  }
}
