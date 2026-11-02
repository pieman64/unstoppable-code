import type { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TranscriptTarget } from '@canopy/protocol/canopy-core';
import {
  buildChatChildSearchDoc,
  ChatSearchIndexer,
  type ChatSearchDoc,
} from '../chat-search/indexer';
import {
  chatSearchQueryExceedsBodyThreshold,
  mapChatSearchCatalogRow,
  queryChatSearchDatabase,
} from '../chat-search/query';
import {
  CHAT_SEARCH_SCHEMA_VERSION,
  openChatSearchDatabase,
} from '../chat-search/schema';
import { requireSqliteRow } from '../chat-search/sqlite-rows';

interface SeededChild {
  delegationId: string;
  runGeneration: number;
  body: string;
  transcriptFingerprint?: string;
}

let testDirectory: string | undefined;
let database: DatabaseSync | undefined;
let indexer: ChatSearchIndexer | undefined;

beforeEach((): void => {
  testDirectory = mkdtempSync(join(tmpdir(), 'chat-search-child-storage-'));
  database = openChatSearchDatabase(join(testDirectory, 'search.sqlite'));
  indexer = new ChatSearchIndexer(database);
});

afterEach((): void => {
  if (database !== undefined) {
    database.close();
    database = undefined;
  }
  if (testDirectory !== undefined) {
    rmSync(testDirectory, { recursive: true, force: true });
    testDirectory = undefined;
  }
  indexer = undefined;
});

function currentDatabase(): DatabaseSync {
  if (database === undefined) throw new Error('Test database was not opened');
  return database;
}

function currentIndexer(): ChatSearchIndexer {
  if (indexer === undefined) throw new Error('Test indexer was not opened');
  return indexer;
}

function currentDatabasePath(): string {
  if (testDirectory === undefined)
    throw new Error('Test database directory was not opened');
  return join(testDirectory, 'search.sqlite');
}

function parentDoc(overrides: Partial<ChatSearchDoc> = {}): ChatSearchDoc {
  const doc: ChatSearchDoc = {
    docId: 'workspace/worktree/parent/live',
    projectId: 'workspace',
    worktreeId: 'worktree',
    chatId: 'parent',
    source: 'live',
    documentKind: 'chat',
    title: 'Parent chat',
    description: null,
    providerType: 'claude',
    updatedAt: 100,
    messageCount: 1,
    expiresAt: null,
    body: 'Parent chat body',
  };
  return { ...doc, ...overrides };
}

function seedChildDocument(parent: ChatSearchDoc, child: SeededChild): string {
  const doc = buildChatChildSearchDoc(
    parent,
    {
      kind: 'delegation',
      chatId: parent.chatId,
      delegationId: child.delegationId,
      runGeneration: child.runGeneration,
    },
    child.transcriptFingerprint ?? 'seed-fingerprint',
    child.body,
  );
  currentIndexer().upsertDoc(doc);
  return doc.docId;
}

async function* documents(
  values: readonly ChatSearchDoc[],
): AsyncGenerator<ChatSearchDoc> {
  for (const value of values) yield await Promise.resolve(value);
}

function sqliteColumnNames(db: DatabaseSync): string[] {
  const rows: unknown[] = db.prepare('PRAGMA table_info(chat_docs)').all();
  const names: string[] = [];
  for (const value of rows) {
    const row = requireSqliteRow(value);
    if (typeof row.name === 'string') names.push(row.name);
  }
  return names;
}

describe('chat search child document storage', () => {
  it('escapes the complete parent and delegation tuple in child ids', () => {
    const parent = parentDoc({
      projectId: 'workspace/"quoted"',
      worktreeId: 'worktree/with/slashes',
      chatId: 'parent/"chat"',
      docId: 'workspace/"quoted"/worktree/with/slashes/parent/"chat"/live',
    });
    const target: TranscriptTarget = {
      kind: 'delegation',
      chatId: parent.chatId,
      delegationId: 'delegate/"one"',
      runGeneration: 4,
    };
    const child = buildChatChildSearchDoc(
      parent,
      target,
      'fingerprint',
      'body',
    );

    expect(child.docId).toBe(
      `chat-child:${JSON.stringify([
        parent.projectId,
        parent.worktreeId,
        parent.chatId,
        parent.source,
        target.delegationId,
        target.runGeneration,
      ])}`,
    );
  });

  it('maps a child document kind and its document-level locator', () => {
    const mapped = mapChatSearchCatalogRow({
      doc_id:
        'chat-child:["workspace","worktree","parent","live","delegate",4]',
      project_id: 'workspace',
      worktree_id: 'worktree',
      chat_id: 'parent',
      source: 'live',
      document_kind: 'chat-child',
      title: 'Parent chat',
      updated_at: 100,
      message_count: 1,
      parent_doc_id: 'workspace/worktree/parent/live',
      delegation_id: 'delegate',
      run_generation: 4,
    });

    expect(mapped.documentKind).toBe('chat-child');
    expect(
      Object.entries(mapped).find(([key]) => key === 'childLocator')?.[1],
    ).toEqual({ delegationId: 'delegate', runGeneration: 4 });
  });

  it('collapses matching parent and sibling child documents before pagination', () => {
    const parent = parentDoc({
      body: `${'parent-only '.repeat(500)} searchneedle`,
    });
    currentIndexer().upsertDoc(parent);
    seedChildDocument(parent, {
      delegationId: 'delegate-one',
      runGeneration: 1,
      body: 'searchneedle',
    });
    seedChildDocument(parent, {
      delegationId: 'delegate-two',
      runGeneration: 2,
      body: 'searchneedle',
    });

    const results = queryChatSearchDatabase(currentDatabase(), {
      query: 'searchneedle',
      limit: 10,
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      chatId: 'parent',
      documentKind: 'chat-child',
    });
  });

  it('checks the body threshold after collapsing matching child siblings', () => {
    const parent = parentDoc({ body: 'a parent body without the query' });
    currentIndexer().upsertDoc(parent);
    const matchingBody = `searchneedle ${'body '.repeat(1200)}`;
    seedChildDocument(parent, {
      delegationId: 'delegate-one',
      runGeneration: 1,
      body: matchingBody,
    });
    seedChildDocument(parent, {
      delegationId: 'delegate-two',
      runGeneration: 2,
      body: matchingBody,
    });

    expect(
      chatSearchQueryExceedsBodyThreshold(
        currentDatabase(),
        { query: 'searchneedle', limit: 10 },
        7000,
      ),
    ).toBe(false);
  });

  it('collapses source variants with the same palette parent key', () => {
    const liveParent = parentDoc({ body: 'live-source searchneedle' });
    const archivedParent = parentDoc({
      docId: 'workspace/worktree/parent/worktree-archive',
      source: 'worktree-archive',
      body: 'archived-source searchneedle',
    });
    currentIndexer().upsertDoc(liveParent);
    currentIndexer().upsertDoc(archivedParent);

    const results = queryChatSearchDatabase(currentDatabase(), {
      query: 'searchneedle',
      limit: 10,
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      projectId: liveParent.projectId,
      worktreeId: liveParent.worktreeId,
      chatId: liveParent.chatId,
    });
  });

  it('keeps distinct parent groups in a limited page when one parent has many child matches', () => {
    const crowdedParent = parentDoc({
      docId: 'workspace/worktree/crowded/live',
      chatId: 'crowded',
      body: 'searchneedle',
    });
    currentIndexer().upsertDoc(crowdedParent);
    seedChildDocument(crowdedParent, {
      delegationId: 'crowded-one',
      runGeneration: 1,
      body: 'searchneedle',
    });
    seedChildDocument(crowdedParent, {
      delegationId: 'crowded-two',
      runGeneration: 2,
      body: 'searchneedle',
    });
    seedChildDocument(crowdedParent, {
      delegationId: 'crowded-three',
      runGeneration: 3,
      body: 'searchneedle',
    });
    const secondParent = parentDoc({
      docId: 'workspace/worktree/second/live',
      chatId: 'second',
      body: `${'other '.repeat(1000)} searchneedle`,
    });
    currentIndexer().upsertDoc(secondParent);

    const results = queryChatSearchDatabase(currentDatabase(), {
      query: 'searchneedle',
      limit: 2,
    });

    expect(results).toHaveLength(2);
    expect(new Set(results.map((result) => result.chatId))).toEqual(
      new Set(['crowded', 'second']),
    );
  });

  it('does not return a whole unchanged child body for fingerprint reuse', () => {
    const parent = parentDoc();
    currentIndexer().upsertDoc(parent);
    const childDocId = seedChildDocument(parent, {
      delegationId: 'delegate',
      runGeneration: 4,
      body: 'stored child body must remain inside sqlite',
      transcriptFingerprint: 'child-fingerprint-v1',
    });
    const stage = currentIndexer().beginChildDocumentStage(parent.docId);
    expect(
      currentIndexer().reuseChildDocument(
        stage,
        childDocId,
        'different-fingerprint',
      ),
    ).toBe(false);
    expect(
      currentIndexer().reuseChildDocument(
        stage,
        childDocId,
        'child-fingerprint-v1',
      ),
    ).toBe(true);
    expect(
      currentDatabase()
        .prepare(
          'SELECT document, fingerprint, reused FROM chat_search_child_staging WHERE job = ?',
        )
        .get(stage),
    ).toMatchObject({
      document: null,
      fingerprint: 'child-fingerprint-v1',
      reused: 1,
    });
    expect(currentIndexer().commitChildDocumentStage(stage)).toBe(true);
  });

  it('atomically keeps reused children, adds staged children, and prunes stale siblings', () => {
    const parent = parentDoc();
    currentIndexer().upsertDoc(parent);
    const retainedChildId = seedChildDocument(parent, {
      delegationId: 'retained',
      runGeneration: 1,
      body: 'retained child body',
      transcriptFingerprint: 'retained-fingerprint',
    });
    const removedChildId = seedChildDocument(parent, {
      delegationId: 'removed',
      runGeneration: 2,
      body: 'stale child body',
      transcriptFingerprint: 'stale-fingerprint',
    });
    const stage = currentIndexer().beginChildDocumentStage(parent.docId);
    expect(
      currentIndexer().reuseChildDocument(
        stage,
        retainedChildId,
        'retained-fingerprint',
      ),
    ).toBe(true);
    const addedChild = buildChatChildSearchDoc(
      parent,
      {
        kind: 'delegation',
        chatId: parent.chatId,
        delegationId: 'added',
        runGeneration: 3,
      },
      'added-fingerprint',
      'added child body',
    );
    currentIndexer().stageChildDocument(stage, addedChild);

    expect(currentIndexer().commitChildDocumentStage(stage)).toBe(true);
    expect(
      currentDatabase()
        .prepare(
          'SELECT doc_id FROM chat_docs WHERE document_kind = ? ORDER BY doc_id',
        )
        .all('chat-child'),
    ).toEqual([{ doc_id: addedChild.docId }, { doc_id: retainedChildId }]);
    expect(
      currentDatabase()
        .prepare('SELECT body FROM chat_fts WHERE doc_id = ?')
        .get(retainedChildId),
    ).toEqual({ body: 'retained child body' });
    expect(
      currentDatabase()
        .prepare('SELECT doc_id FROM chat_docs WHERE doc_id = ?')
        .get(removedChildId),
    ).toBeUndefined();
  });

  it('does not publish a child set after its parent disappears', () => {
    const parent = parentDoc();
    currentIndexer().upsertDoc(parent);
    const stage = currentIndexer().beginChildDocumentStage(parent.docId);
    const child = buildChatChildSearchDoc(
      parent,
      {
        kind: 'delegation',
        chatId: parent.chatId,
        delegationId: 'late-child',
        runGeneration: 1,
      },
      'fingerprint',
      'late child body',
    );
    currentIndexer().stageChildDocument(stage, child);
    currentIndexer().deleteDocById(parent.docId);

    expect(currentIndexer().commitChildDocumentStage(stage)).toBe(false);
    expect(
      currentDatabase()
        .prepare('SELECT doc_id FROM chat_docs WHERE doc_id = ?')
        .get(child.docId),
    ).toBeUndefined();
  });

  it('keeps the complete old child set when staged child data is corrupt', () => {
    const parent = parentDoc();
    currentIndexer().upsertDoc(parent);
    const existingChildId = seedChildDocument(parent, {
      delegationId: 'existing-child',
      runGeneration: 1,
      body: 'existing child body',
    });
    const stage = currentIndexer().beginChildDocumentStage(parent.docId);
    const replacement = buildChatChildSearchDoc(
      parent,
      {
        kind: 'delegation',
        chatId: parent.chatId,
        delegationId: 'replacement-child',
        runGeneration: 2,
      },
      'replacement-fingerprint',
      'replacement child body',
    );
    currentIndexer().stageChildDocument(stage, replacement);
    currentDatabase()
      .prepare(
        'UPDATE chat_search_child_staging SET document = ? WHERE job = ?',
      )
      .run('{', stage);

    expect(() => currentIndexer().commitChildDocumentStage(stage)).toThrow();
    expect(
      currentDatabase()
        .prepare('SELECT body FROM chat_fts WHERE doc_id = ?')
        .get(existingChildId),
    ).toEqual({ body: 'existing child body' });
    expect(
      currentDatabase()
        .prepare('SELECT doc_id FROM chat_docs WHERE doc_id = ?')
        .get(replacement.docId),
    ).toBeUndefined();
  });

  it('keeps child metadata in sync when a parent title changes', () => {
    const parent = parentDoc();
    currentIndexer().upsertDoc(parent);
    const childDocId = seedChildDocument(parent, {
      delegationId: 'rename-child',
      runGeneration: 1,
      body: 'child body remains indexed',
    });

    currentIndexer().upsertDoc({
      ...parent,
      title: 'Renamed parent',
      updatedAt: 200,
      body: 'updated parent body',
    });

    expect(
      currentDatabase()
        .prepare('SELECT title, updated_at FROM chat_docs WHERE doc_id = ?')
        .get(childDocId),
    ).toEqual({ title: 'Renamed parent', updated_at: 200 });
    expect(
      currentDatabase()
        .prepare('SELECT title, body FROM chat_fts WHERE doc_id = ?')
        .get(childDocId),
    ).toEqual({ title: 'Renamed parent', body: 'child body remains indexed' });
  });

  it('cascades exact parent deletion to owned child docs and their FTS rows', () => {
    const parent = parentDoc();
    currentIndexer().upsertDoc(parent);
    const childDocId = seedChildDocument(parent, {
      delegationId: 'delegate',
      runGeneration: 2,
      body: 'child body',
    });

    currentIndexer().deleteChatDoc(
      parent.projectId,
      parent.worktreeId,
      parent.chatId,
      parent.source,
    );

    expect(
      currentDatabase()
        .prepare('SELECT doc_id FROM chat_docs WHERE doc_id = ?')
        .get(childDocId),
    ).toBeUndefined();
    expect(
      currentDatabase()
        .prepare('SELECT rowid FROM chat_fts WHERE doc_id = ?')
        .get(childDocId),
    ).toBeUndefined();
  });

  it('preserves retained children during parent scope staging and prunes them when the parent disappears', async () => {
    const parent = parentDoc();
    currentIndexer().upsertDoc(parent);
    const childDocId = seedChildDocument(parent, {
      delegationId: 'delegate',
      runGeneration: 1,
      body: 'retained child body',
    });

    const renamedParent = {
      ...parent,
      title: 'Renamed during scope replacement',
      updatedAt: 200,
    };
    await currentIndexer().replaceStreamedScope(
      parent.projectId,
      parent.worktreeId,
      parent.source,
      documents([renamedParent]),
    );

    expect(
      currentDatabase()
        .prepare('SELECT doc_id, title FROM chat_docs WHERE doc_id = ?')
        .get(childDocId),
    ).toEqual({ doc_id: childDocId, title: renamedParent.title });
    expect(
      currentDatabase()
        .prepare('SELECT title, body FROM chat_fts WHERE doc_id = ?')
        .get(childDocId),
    ).toEqual({ title: renamedParent.title, body: 'retained child body' });

    await currentIndexer().replaceStreamedScope(
      parent.projectId,
      parent.worktreeId,
      parent.source,
      documents([]),
    );

    expect(
      currentDatabase()
        .prepare('SELECT doc_id FROM chat_docs WHERE doc_id = ?')
        .get(childDocId),
    ).toBeUndefined();
  });

  it('preserves the old child set when a parent staged closure is corrupt', () => {
    const parent = parentDoc();
    currentIndexer().upsertDoc(parent);
    const childDocId = seedChildDocument(parent, {
      delegationId: 'stable-child',
      runGeneration: 1,
      body: 'stable child body',
    });
    const stage = currentIndexer().beginStagedScope();
    currentIndexer().stageScopeDoc(stage, 0, {
      ...parent,
      title: 'Uncommitted replacement',
    });
    currentDatabase()
      .prepare('UPDATE chat_search_staging SET document = ? WHERE job = ?')
      .run('{', stage);

    expect(() =>
      currentIndexer().commitStagedScope(
        stage,
        parent.projectId,
        parent.worktreeId,
        parent.source,
      ),
    ).toThrow();
    currentIndexer().discardStagedScope(stage);
    expect(
      currentDatabase()
        .prepare('SELECT title FROM chat_docs WHERE doc_id = ?')
        .get(parent.docId),
    ).toEqual({ title: parent.title });
    expect(
      currentDatabase()
        .prepare('SELECT body FROM chat_fts WHERE doc_id = ?')
        .get(childDocId),
    ).toEqual({ body: 'stable child body' });
  });

  it('rebuilds a schema-v8 index with owner columns for child rows', () => {
    currentIndexer().upsertDoc(parentDoc());
    const db = currentDatabase();
    db.prepare(
      "UPDATE search_meta SET value = '8' WHERE key = 'schema_version'",
    ).run();
    db.close();
    database = undefined;

    database = openChatSearchDatabase(currentDatabasePath());
    indexer = new ChatSearchIndexer(database);

    expect(sqliteColumnNames(currentDatabase())).toEqual(
      expect.arrayContaining([
        'parent_doc_id',
        'delegation_id',
        'run_generation',
      ]),
    );
    expect(
      currentDatabase()
        .prepare('SELECT doc_id FROM chat_docs WHERE doc_id = ?')
        .get('workspace/worktree/parent/live'),
    ).toBeUndefined();
    expect(
      currentDatabase()
        .prepare("SELECT value FROM search_meta WHERE key = 'schema_version'")
        .get(),
    ).toMatchObject({ value: String(CHAT_SEARCH_SCHEMA_VERSION) });
  });
});
