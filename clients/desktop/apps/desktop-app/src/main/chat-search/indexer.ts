import { randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { chatTabLabel } from '@canopy/protocol';
import type { TranscriptTarget } from '@canopy/protocol/canopy-core';
import {
  getProviderForModel,
  type ArchivedContainerManifest,
  type ArchivedChatsFile,
  type ChatSearchChildLocator,
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
  /** Present only for a child transcript, whose owner remains a parent chat. */
  parentDocId?: string;
  /** Identity of the registered delegation target represented by this row. */
  childLocator?: ChatSearchChildLocator;
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
  const childLocator = isRecord(value) ? value.childLocator : undefined;
  const isChildLocator =
    isRecord(childLocator) &&
    typeof childLocator.delegationId === 'string' &&
    childLocator.delegationId.length > 0 &&
    typeof childLocator.runGeneration === 'number' &&
    Number.isSafeInteger(childLocator.runGeneration) &&
    childLocator.runGeneration >= 0;
  const isChildDocument =
    isRecord(value) && value.documentKind === 'chat-child';
  const expectedParentDocId =
    isChildDocument &&
    isRecord(value) &&
    typeof value.projectId === 'string' &&
    typeof value.worktreeId === 'string' &&
    typeof value.chatId === 'string' &&
    typeof value.source === 'string'
      ? `${value.projectId}/${value.worktreeId}/${value.chatId}/${value.source}`
      : null;
  const expectedChildDocId =
    isChildDocument &&
    isRecord(value) &&
    isRecord(childLocator) &&
    typeof value.projectId === 'string' &&
    typeof value.worktreeId === 'string' &&
    typeof value.chatId === 'string' &&
    typeof value.source === 'string' &&
    typeof childLocator.delegationId === 'string' &&
    typeof childLocator.runGeneration === 'number'
      ? `chat-child:${JSON.stringify([
          value.projectId,
          value.worktreeId,
          value.chatId,
          value.source,
          childLocator.delegationId,
          childLocator.runGeneration,
        ])}`
      : null;
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
    ['chat', 'chat-child', 'plan', 'archived-container'].includes(
      typeof value.documentKind === 'string' ? value.documentKind : '',
    ) &&
    (!isChildDocument ||
      (typeof value.parentDocId === 'string' &&
        value.parentDocId === expectedParentDocId &&
        isChildLocator &&
        value.docId === expectedChildDocId &&
        typeof value.transcriptFingerprint === 'string' &&
        value.transcriptFingerprint.length > 0)) &&
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

/**
 * The `chat_fts` rowids of the docs `docIds` selects. FTS5 cannot index
 * `doc_id`, so a `doc_id` filter reads every indexed row; `chat_docs` records
 * each doc's body and in-flight rowids instead. Read them before deleting or
 * rewriting the `chat_docs` rows.
 */
function ftsRowidsOf(docIds: string): string {
  return `WITH docs AS (${docIds})
    SELECT body_fts_rowid AS fts_rowid FROM chat_docs
    WHERE doc_id IN docs AND body_fts_rowid IS NOT NULL
    UNION ALL
    SELECT active_fts_rowid AS fts_rowid FROM chat_docs
    WHERE doc_id IN docs AND active_fts_rowid IS NOT NULL`;
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

/** Builds one independently owned FTS document for a registered child run. */
export function buildChatChildSearchDoc(
  parent: ChatSearchDoc,
  target: TranscriptTarget,
  fingerprint: string,
  body: string,
): ChatSearchDoc {
  if (
    parent.documentKind !== 'chat' ||
    parent.docId !==
      `${parent.projectId}/${parent.worktreeId}/${parent.chatId}/${parent.source}` ||
    target.kind !== 'delegation' ||
    target.chatId !== parent.chatId ||
    target.delegationId.length === 0 ||
    !Number.isSafeInteger(target.runGeneration) ||
    target.runGeneration < 0 ||
    fingerprint.length === 0
  )
    throw new Error(
      'A child search document requires a chat parent and target',
    );
  const childLocator: ChatSearchChildLocator = {
    delegationId: target.delegationId,
    runGeneration: target.runGeneration,
  };
  const docId = childSearchDocId(parent, childLocator);
  return {
    ...parent,
    docId,
    documentKind: 'chat-child',
    body,
    transcriptFingerprint: fingerprint,
    committedFingerprint: undefined,
    activeBody: undefined,
    parentDocId: parent.docId,
    childLocator,
  };
}

function childSearchDocId(
  parent: Pick<ChatSearchDoc, 'projectId' | 'worktreeId' | 'chatId' | 'source'>,
  childLocator: ChatSearchChildLocator,
): string {
  return `chat-child:${JSON.stringify([
    parent.projectId,
    parent.worktreeId,
    parent.chatId,
    parent.source,
    childLocator.delegationId,
    childLocator.runGeneration,
  ])}`;
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
    const docs = chatTabsToDocs(projectId, worktreeId, data);
    this.replaceScope(projectId, worktreeId, 'live', docs);
  }

  replaceWorktreeArchives(
    projectId: string,
    worktreeId: string,
    data: ArchivedChatsFile,
  ): void {
    const docs = archiveTabsToDocs(projectId, worktreeId, data);
    this.replaceScope(projectId, worktreeId, 'worktree-archive', docs);
  }

  replaceWorktreePlans(
    projectId: string,
    worktreeId: string,
    plans: readonly TrackedPlanIndexEntry[],
  ): void {
    const docs = plansToDocs(projectId, worktreeId, plans);
    this.replaceScope(projectId, worktreeId, 'plan', docs);
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
    const docs = [
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
    ];
    this.replaceScope(projectId, containerId, 'archived-container', docs);
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
      this.deleteChildDocuments(docId);
      this.deleteFtsRows('SELECT ?', docId);
      this.db.prepare('DELETE FROM chat_docs WHERE doc_id = ?').run(docId);
    });
  }

  deleteDocById(docId: string): void {
    withImmediateTransaction(this.db, () => {
      this.deleteChildDocuments(docId);
      this.deleteFtsRows('SELECT ?', docId);
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

  getMetadata(key: string): string | null {
    const result: unknown = this.db
      .prepare('SELECT value FROM search_meta WHERE key = ?')
      .get(key);
    if (result === undefined) return null;
    const row = requireSqliteRow(result);
    return typeof row.value === 'string' ? row.value : null;
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

  /** Creates a retained-set stage owned by one indexed parent chat. */
  public beginChildDocumentStage(parentDocId: string): string {
    if (parentDocId.length === 0)
      throw new Error('A child-document stage requires a parent document');
    this.db.exec(
      `CREATE TEMP TABLE IF NOT EXISTS chat_search_child_stages (
         job TEXT PRIMARY KEY,
         parent_doc_id TEXT NOT NULL
       );
       CREATE TEMP TABLE IF NOT EXISTS chat_search_child_staging (
         job TEXT NOT NULL,
         doc_id TEXT NOT NULL,
         document TEXT,
         fingerprint TEXT,
         reused INTEGER NOT NULL,
         PRIMARY KEY (job, doc_id)
       )`,
    );
    const job = randomUUID();
    this.db
      .prepare(
        'INSERT INTO chat_search_child_stages (job, parent_doc_id) VALUES (?, ?)',
      )
      .run(job, parentDocId);
    return job;
  }

  /** Records a fingerprint match without reading the stored FTS body back. */
  public reuseChildDocument(
    job: string,
    childDocId: string,
    fingerprint: string,
  ): boolean {
    const parentDocId = this.childDocumentStageParent(job);
    if (!this.isReusableChildDocument(childDocId, parentDocId, fingerprint))
      return false;
    this.db
      .prepare(
        `INSERT INTO chat_search_child_staging
           (job, doc_id, document, fingerprint, reused)
         VALUES (?, ?, NULL, ?, 1)`,
      )
      .run(job, childDocId, fingerprint);
    return true;
  }

  /** Stages a newly read child body; it is not visible until the whole set commits. */
  public stageChildDocument(job: string, doc: ChatSearchDoc): void {
    const parentDocId = this.childDocumentStageParent(job);
    if (
      !isChatSearchDoc(doc) ||
      doc.documentKind !== 'chat-child' ||
      doc.parentDocId !== parentDocId ||
      typeof doc.transcriptFingerprint !== 'string' ||
      doc.transcriptFingerprint.length === 0
    ) {
      throw new Error('Invalid staged child search document');
    }
    this.db
      .prepare(
        `INSERT INTO chat_search_child_staging
           (job, doc_id, document, fingerprint, reused)
         VALUES (?, ?, ?, ?, 0)`,
      )
      .run(job, doc.docId, JSON.stringify(doc), doc.transcriptFingerprint);
  }

  /** Atomically replaces exactly one parent's child set if that parent still exists. */
  public commitChildDocumentStage(job: string): boolean {
    const parentDocId = this.childDocumentStageParent(job);
    try {
      return withImmediateTransaction(this.db, () => {
        const parentResult: unknown = this.db
          .prepare(
            `SELECT project_id, worktree_id, chat_id, source
             FROM chat_docs WHERE doc_id = ? AND document_kind = 'chat'`,
          )
          .get(parentDocId);
        if (parentResult === undefined) return false;
        const parent = requireSqliteRow(parentResult);
        const stagedMetadata = this.db.prepare(
          `SELECT doc_id, fingerprint, reused, document IS NOT NULL AS has_document
           FROM chat_search_child_staging WHERE job = ? ORDER BY doc_id`,
        );
        const stagedMetadataRows = stagedMetadata.iterate(job);
        for (
          let next = stagedMetadataRows.next();
          !next.done;
          next = stagedMetadataRows.next()
        ) {
          const row = requireSqliteRow(next.value);
          if (
            typeof row.doc_id !== 'string' ||
            typeof row.fingerprint !== 'string'
          )
            throw new Error('Invalid child search stage row');
          if (row.reused === 1) {
            if (row.has_document !== 0) {
              throw new Error('Invalid reused child search stage row');
            }
            if (
              !this.isReusableChildDocument(
                row.doc_id,
                parentDocId,
                row.fingerprint,
              )
            )
              return false;
            continue;
          }
          if (row.reused !== 0 || row.has_document !== 1)
            throw new Error('Invalid staged child search document');
        }

        this.deleteFtsRows(
          `SELECT doc_id FROM chat_docs
           WHERE parent_doc_id = ? AND document_kind = 'chat-child'
             AND doc_id NOT IN (
               SELECT doc_id FROM chat_search_child_staging WHERE job = ?
             )`,
          parentDocId,
          job,
        );
        this.db
          .prepare(
            `DELETE FROM chat_docs
             WHERE parent_doc_id = ? AND document_kind = 'chat-child'
               AND doc_id NOT IN (
                 SELECT doc_id FROM chat_search_child_staging WHERE job = ?
               )`,
          )
          .run(parentDocId, job);

        const stagedDocuments = this.db.prepare(
          `SELECT doc_id, document, fingerprint
           FROM chat_search_child_staging
           WHERE job = ? AND reused = 0 ORDER BY doc_id`,
        );
        const stagedDocumentsRows = stagedDocuments.iterate(job);
        for (
          let next = stagedDocumentsRows.next();
          !next.done;
          next = stagedDocumentsRows.next()
        ) {
          const row = requireSqliteRow(next.value);
          if (
            typeof row.doc_id !== 'string' ||
            typeof row.document !== 'string' ||
            typeof row.fingerprint !== 'string'
          )
            throw new Error('Invalid staged child search document');
          const parsed: unknown = JSON.parse(row.document);
          if (
            !isChatSearchDoc(parsed) ||
            parsed.documentKind !== 'chat-child' ||
            parsed.parentDocId !== parentDocId ||
            parsed.docId !== row.doc_id ||
            parsed.transcriptFingerprint !== row.fingerprint ||
            parsed.projectId !== parent.project_id ||
            parsed.worktreeId !== parent.worktree_id ||
            parsed.chatId !== parent.chat_id ||
            parsed.source !== parent.source
          ) {
            throw new Error('Invalid staged child search document');
          }
          this.deleteFtsRows('SELECT ?', parsed.docId);
          this.writeDoc(parsed);
        }
        this.updateChildMetadataFromParent(parentDocId);
        return true;
      });
    } finally {
      this.discardChildDocumentStage(job);
    }
  }

  public discardChildDocumentStage(job: string): void {
    this.db
      .prepare('DELETE FROM chat_search_child_staging WHERE job = ?')
      .run(job);
    this.db
      .prepare('DELETE FROM chat_search_child_stages WHERE job = ?')
      .run(job);
  }

  private childDocumentStageParent(job: string): string {
    const result: unknown = this.db
      .prepare(
        'SELECT parent_doc_id FROM chat_search_child_stages WHERE job = ?',
      )
      .get(job);
    if (result === undefined) throw new Error('Unknown child-document stage');
    const row = requireSqliteRow(result);
    if (typeof row.parent_doc_id !== 'string')
      throw new Error('Invalid child-document stage');
    return row.parent_doc_id;
  }

  /** Validates ownership and identity without projecting any indexed body text. */
  private isReusableChildDocument(
    childDocId: string,
    parentDocId: string,
    fingerprint: string,
  ): boolean {
    const result: unknown = this.db
      .prepare(
        `SELECT d.project_id, d.worktree_id, d.chat_id, d.source,
                d.delegation_id, d.run_generation
         FROM chat_docs d
         WHERE d.doc_id = ? AND d.parent_doc_id = ?
           AND d.document_kind = 'chat-child'
           AND d.transcript_fingerprint = ?
           AND EXISTS (SELECT 1 FROM chat_fts f WHERE f.rowid = d.body_fts_rowid)`,
      )
      .get(childDocId, parentDocId, fingerprint);
    if (result === undefined) return false;
    const row = requireSqliteRow(result);
    const runGeneration =
      typeof row.run_generation === 'bigint'
        ? Number(row.run_generation)
        : row.run_generation;
    if (
      typeof row.project_id !== 'string' ||
      typeof row.worktree_id !== 'string' ||
      typeof row.chat_id !== 'string' ||
      typeof row.source !== 'string' ||
      typeof row.delegation_id !== 'string' ||
      row.delegation_id.length === 0 ||
      typeof runGeneration !== 'number' ||
      !Number.isSafeInteger(runGeneration) ||
      runGeneration < 0
    ) {
      return false;
    }
    return (
      parentDocId ===
        `${row.project_id}/${row.worktree_id}/${row.chat_id}/${row.source}` &&
      childDocId ===
        `chat-child:${JSON.stringify([
          row.project_id,
          row.worktree_id,
          row.chat_id,
          row.source,
          row.delegation_id,
          runGeneration,
        ])}`
    );
  }

  private replaceScope(
    projectId: string,
    worktreeId: string,
    source: ChatSearchSource,
    docs: Iterable<ChatSearchDoc>,
  ): void {
    const job = randomUUID();
    this.db.exec(
      `CREATE TEMP TABLE IF NOT EXISTS chat_search_retained_parents (
         job TEXT NOT NULL,
         doc_id TEXT NOT NULL,
         PRIMARY KEY (job, doc_id)
       )`,
    );
    try {
      withImmediateTransaction(this.db, () => {
        const rememberParent = this.db.prepare(
          'INSERT INTO chat_search_retained_parents (job, doc_id) VALUES (?, ?)',
        );
        const iterator = docs[Symbol.iterator]();
        for (let row = iterator.next(); !row.done; row = iterator.next()) {
          const doc = row.value;
          if (!isChatSearchDoc(doc) || doc.documentKind === 'chat-child')
            throw new Error('Invalid parent search scope document');
          this.deleteFtsRows('SELECT ?', doc.docId);
          this.writeDoc(doc);
          rememberParent.run(job, doc.docId);
          this.updateChildMetadataFromParent(doc.docId);
        }

        const obsoleteDocs = `
          SELECT d.doc_id FROM chat_docs d
          WHERE d.project_id = ? AND d.worktree_id = ? AND d.source = ?
            AND NOT EXISTS (
              SELECT 1 FROM chat_search_retained_parents retained
              WHERE retained.job = ?
                AND retained.doc_id = CASE
                  WHEN d.document_kind = 'chat-child' THEN d.parent_doc_id
                  ELSE d.doc_id
                END
            )`;
        this.deleteFtsRows(obsoleteDocs, projectId, worktreeId, source, job);
        this.db
          .prepare(`DELETE FROM chat_docs WHERE doc_id IN (${obsoleteDocs})`)
          .run(projectId, worktreeId, source, job);
      });
    } finally {
      this.db
        .prepare('DELETE FROM chat_search_retained_parents WHERE job = ?')
        .run(job);
    }
  }

  public upsertDoc(doc: ChatSearchDoc): void {
    if (!isChatSearchDoc(doc)) throw new Error('Invalid chat search document');
    withImmediateTransaction(this.db, () => {
      this.deleteFtsRows('SELECT ?', doc.docId);
      this.writeDoc(doc);
      if (doc.documentKind !== 'chat-child')
        this.updateChildMetadataFromParent(doc.docId);
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
    const result: unknown = this.db
      .prepare(
        `SELECT body_fts_rowid, active_fts_rowid, committed_fingerprint
         FROM chat_docs WHERE doc_id = ? AND transcript_fingerprint = ?`,
      )
      .get(docId, fingerprint);
    if (result === undefined) return null;
    const row = requireSqliteRow(result);
    const body = this.ftsBody(sqliteRowid(row.body_fts_rowid));
    if (body === null) return null;
    const activeBody = this.ftsBody(sqliteRowid(row.active_fts_rowid));
    return {
      body,
      ...(typeof row.committed_fingerprint === 'string'
        ? { committedFingerprint: row.committed_fingerprint }
        : {}),
      ...(activeBody === null ? {} : { activeBody }),
    };
  }

  private ftsBody(rowid: number | bigint | null): string | null {
    if (rowid === null) return null;
    const result: unknown = this.db
      .prepare('SELECT body FROM chat_fts WHERE rowid = ?')
      .get(rowid);
    if (result === undefined) return null;
    const row = requireSqliteRow(result);
    return typeof row.body === 'string' ? row.body : null;
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
          `SELECT title, committed_fingerprint, body_fts_rowid, active_fts_rowid
           FROM chat_docs WHERE doc_id = ?`,
        )
        .get(doc.docId);
      if (result === undefined) return false;
      const row = requireSqliteRow(result);
      if (row.committed_fingerprint !== expected) return false;
      const bodyRowid = sqliteRowid(row.body_fts_rowid);
      const activeRowid = sqliteRowid(row.active_fts_rowid);
      const committedRow =
        bodyRowid === null
          ? undefined
          : this.db
              .prepare('SELECT 1 FROM chat_fts WHERE rowid = ?')
              .get(bodyRowid);
      if (committedRow === undefined) return false;
      if (activeRowid !== null)
        this.db
          .prepare('DELETE FROM chat_fts WHERE rowid = ? AND doc_id = ?')
          .run(activeRowid, doc.docId);
      if (row.title !== doc.title)
        this.db
          .prepare('UPDATE chat_fts SET title = ? WHERE rowid = ?')
          .run(doc.title, bodyRowid);
      this.writeDocMetadata(doc);
      this.writeActiveRow(doc);
      this.updateChildMetadataFromParent(doc.docId);
      return true;
    });
  }

  /** Atomically refresh metadata only when a matching full body is already indexed. */
  public updateDocMetadataIfTranscriptUnchanged(doc: ChatSearchDoc): boolean {
    if (!doc.transcriptFingerprint) return false;
    const result = this.db
      .prepare(
        `SELECT * FROM chat_docs WHERE doc_id = ?
        AND EXISTS (
          SELECT 1 FROM chat_fts WHERE rowid = chat_docs.body_fts_rowid
        )`,
      )
      .get(doc.docId);
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
        this.setFtsTitle(doc.title, 'SELECT ?', doc.docId);
      this.updateChildMetadataFromParent(doc.docId);
      return true;
    });
  }

  private writeDoc(doc: ChatSearchDoc): void {
    this.writeDocMetadata(doc);
    const bodyRowid = this.db
      .prepare('INSERT INTO chat_fts (doc_id, title, body) VALUES (?, ?, ?)')
      .run(doc.docId, doc.title, doc.body).lastInsertRowid;
    this.db
      .prepare('UPDATE chat_docs SET body_fts_rowid = ? WHERE doc_id = ?')
      .run(bodyRowid, doc.docId);
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
           expires_at, review_status, transcript_fingerprint, parent_doc_id,
           delegation_id, run_generation
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
           transcript_fingerprint = excluded.transcript_fingerprint,
           parent_doc_id = excluded.parent_doc_id,
           delegation_id = excluded.delegation_id,
           run_generation = excluded.run_generation`,
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
        doc.parentDocId ?? null,
        doc.childLocator?.delegationId ?? null,
        doc.childLocator?.runGeneration ?? null,
      );
  }

  /** Keep a parent's current display and retention metadata on its children. */
  private updateChildMetadataFromParent(parentDocId: string): void {
    this.db
      .prepare(
        `WITH parent AS (
           SELECT doc_id, project_id, worktree_id, chat_id, source, title,
                  description, provider_type, updated_at, archived_at,
                  expires_at, message_count, review_status
           FROM chat_docs WHERE doc_id = ? AND document_kind = 'chat'
         )
         UPDATE chat_docs SET
           project_id = (SELECT project_id FROM parent),
           worktree_id = (SELECT worktree_id FROM parent),
           chat_id = (SELECT chat_id FROM parent),
           source = (SELECT source FROM parent),
           title = (SELECT title FROM parent),
           description = (SELECT description FROM parent),
           provider_type = (SELECT provider_type FROM parent),
           updated_at = (SELECT updated_at FROM parent),
           archived_at = (SELECT archived_at FROM parent),
           expires_at = (SELECT expires_at FROM parent),
           message_count = (SELECT message_count FROM parent),
           review_status = (SELECT review_status FROM parent)
         WHERE document_kind = 'chat-child'
           AND parent_doc_id = (SELECT doc_id FROM parent)
           AND (
             project_id IS NOT (SELECT project_id FROM parent) OR
             worktree_id IS NOT (SELECT worktree_id FROM parent) OR
             chat_id IS NOT (SELECT chat_id FROM parent) OR
             source IS NOT (SELECT source FROM parent) OR
             title IS NOT (SELECT title FROM parent) OR
             description IS NOT (SELECT description FROM parent) OR
             provider_type IS NOT (SELECT provider_type FROM parent) OR
             updated_at IS NOT (SELECT updated_at FROM parent) OR
             archived_at IS NOT (SELECT archived_at FROM parent) OR
             expires_at IS NOT (SELECT expires_at FROM parent) OR
             message_count IS NOT (SELECT message_count FROM parent) OR
             review_status IS NOT (SELECT review_status FROM parent)
           )`,
      )
      .run(parentDocId);
    const parent: unknown = this.db
      .prepare(
        `SELECT title FROM chat_docs WHERE doc_id = ? AND document_kind = 'chat'`,
      )
      .get(parentDocId);
    if (parent === undefined) return;
    const { title } = requireSqliteRow(parent);
    if (typeof title === 'string')
      this.setFtsTitle(
        title,
        `SELECT doc_id FROM chat_docs
         WHERE parent_doc_id = ? AND document_kind = 'chat-child'`,
        parentDocId,
      );
  }

  /**
   * Rowids are read before the rows are written: one FTS5 statement that both
   * selects and deletes many rows ran 10-40x slower than one delete per rowid.
   */
  private ftsRowids(
    docIds: string,
    params: SQLInputValue[],
  ): Array<number | bigint> {
    return this.db
      .prepare(ftsRowidsOf(docIds))
      .all(...params)
      .flatMap((result) => {
        const rowid = sqliteRowid(requireSqliteRow(result).fts_rowid);
        return rowid === null ? [] : [rowid];
      });
  }

  private deleteFtsRows(docIds: string, ...params: SQLInputValue[]): void {
    const remove = this.db.prepare('DELETE FROM chat_fts WHERE rowid = ?');
    for (const rowid of this.ftsRowids(docIds, params)) remove.run(rowid);
  }

  /** Rewriting an FTS5 row re-tokenizes its body, so unchanged titles are skipped. */
  private setFtsTitle(
    title: string,
    docIds: string,
    ...params: SQLInputValue[]
  ): void {
    const update = this.db.prepare(
      'UPDATE chat_fts SET title = ? WHERE rowid = ? AND title IS NOT ?',
    );
    for (const rowid of this.ftsRowids(docIds, params))
      update.run(title, rowid, title);
  }

  private deleteChildDocuments(parentDocId: string): void {
    this.deleteFtsRows(
      `SELECT doc_id FROM chat_docs
       WHERE parent_doc_id = ? AND document_kind = 'chat-child'`,
      parentDocId,
    );
    this.db
      .prepare(
        `DELETE FROM chat_docs
         WHERE parent_doc_id = ? AND document_kind = 'chat-child'`,
      )
      .run(parentDocId);
  }

  private deleteMatchingDocs(whereClause: string, params: string[]): void {
    withImmediateTransaction(this.db, () => {
      this.deleteFtsRows(
        `SELECT doc_id FROM chat_docs WHERE ${whereClause}`,
        ...params,
      );
      this.db
        .prepare(`DELETE FROM chat_docs WHERE ${whereClause}`)
        .run(...params);
    });
  }
}
