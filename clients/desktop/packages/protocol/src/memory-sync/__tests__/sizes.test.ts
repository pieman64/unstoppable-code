import {
  MEMORY_SYNC_LIMITS,
  MemoryChangesPageSchema,
  MemoryCommitRequestSchema,
  MemoryDocumentChangesSchema,
  MemoryNoteRecordSchema,
  MemoryNoteSchema,
  MemoryNotesPushRequestSchema,
  encodeMemoryUlid,
  formatMemoryChangeCursor,
  isMemoryChangesPageWithinBytes,
  memoryChangesPageHasRoom,
  memorySyncJsonBytes,
  type MemoryChange,
  type MemoryChangesPage,
  type MemoryCommitRequest,
  type MemoryDocumentChange,
  type MemoryNote,
  type MemoryRevisionRecord,
} from '../index';

const DEVICE_ID = '00000000-0000-4000-8000-0000000000d1';
const SCOPE_ID = '00000000-0000-4000-8000-0000000000a1';
const PROJECT_ID = '00000000-0000-4000-8000-0000000000b1';
const ORG_ID = '00000000-0000-4000-8000-0000000000e1';
const LEASE_ID = '00000000-0000-4000-8000-0000000000f1';
const NOTE_ID = '01JB2Z8Q4F6X9M3N5P7R1T2V3W';
const COMMIT_ID = '01JB2Z8Q4F6X9M3N5P7R1T2V3Y';
const HASH = 'a'.repeat(64);
const AT = '2026-10-27T10:00:00.000Z';
const MAX_SEQ = '9'.repeat(18);
const MAX_REVISION = 2_147_483_647;
const KiB = 1024;

function escapedWorstCase(chars: number): string {
  return '\u0001'.repeat(chars);
}

const INBOX_NOTE: MemoryNote = {
  noteId: NOTE_ID,
  kind: 'inbox',
  fileKey: 'inbox/2026-10-27T10-00-00-prefer-pnpm.md',
  body: 'Prefer pnpm in this workspace.',
  contentHash: HASH,
  createdAt: AT,
  modifiedAt: AT,
  device: { deviceId: DEVICE_ID, label: 'MacBook Pro' },
  source: { provider: 'claude', chatId: 'chat-1' },
  origin: { projectId: PROJECT_ID, organizationId: ORG_ID },
};

const IMPORT_NOTE: MemoryNote = {
  ...INBOX_NOTE,
  kind: 'import',
  fileKey: 'imported/device-build-0123abcd.md',
  source: null,
  importSource: {
    tool: 'canopy-device',
    originKey: HASH,
    sourceFilename: 'build.md',
    modifiedAt: AT,
  },
};

describe('memory note sizes', () => {
  it('lets an import note carry a whole document but holds other notes to the note limit', () => {
    const body = 'a'.repeat(300 * KiB);
    expect(MemoryNoteSchema.safeParse({ ...IMPORT_NOTE, body }).success).toBe(
      true,
    );
    expect(MemoryNoteSchema.safeParse({ ...INBOX_NOTE, body }).success).toBe(
      false,
    );
    expect(
      MemoryNoteSchema.safeParse({
        ...IMPORT_NOTE,
        body: 'a'.repeat(MEMORY_SYNC_LIMITS.documentMaxBytes + 1),
      }).success,
    ).toBe(false);
    expect(
      MemoryNoteRecordSchema.safeParse({
        ...IMPORT_NOTE,
        body,
        state: 'pending',
        receivedAt: AT,
        consumedInRevision: null,
        closedAt: null,
      }).success,
    ).toBe(true);
  });

  it('admits one maximum-size import note per push, even with worst-case escaping', () => {
    const note: MemoryNote = {
      ...IMPORT_NOTE,
      body: escapedWorstCase(MEMORY_SYNC_LIMITS.importNoteBodyMaxBytes),
      device: {
        deviceId: DEVICE_ID,
        label: escapedWorstCase(MEMORY_SYNC_LIMITS.deviceLabelMaxChars),
      },
      importSource: {
        tool: 'canopy-device',
        originKey: HASH,
        sourceFilename: escapedWorstCase(255),
        repo: escapedWorstCase(255),
        modifiedAt: AT,
      },
    };
    const push = { ops: [{ op: 'put', note }] };
    expect(MemoryNotesPushRequestSchema.safeParse(push).success).toBe(true);
    expect(memorySyncJsonBytes(push)).toBeLessThanOrEqual(
      MEMORY_SYNC_LIMITS.pushRequestMaxBytes,
    );
  });
});

function maximumLengthTopicPath(index: number): string {
  const digits = String(MEMORY_SYNC_LIMITS.commitChangesMax).length;
  return `topics/${String(index).padStart(digits, '0')}${'a'.repeat(
    MEMORY_SYNC_LIMITS.fileNameMaxBytes - '.md'.length - digits,
  )}.md`;
}

function maximumCommit(): MemoryCommitRequest {
  const paths = Array.from(
    { length: MEMORY_SYNC_LIMITS.commitChangesMax },
    (_, index) => maximumLengthTopicPath(index),
  );
  const deleted = paths.slice(0, paths.length / 2);
  const put = paths.slice(paths.length / 2);
  const changesWith = (
    contentFor: (index: number) => string,
  ): MemoryDocumentChange[] => [
    ...deleted.map((path) => ({ op: 'delete' as const, path })),
    ...put.map((path, index) => ({
      op: 'put' as const,
      path,
      content: contentFor(index),
      contentHash: HASH,
    })),
  ];
  const commit: MemoryCommitRequest = {
    commitId: COMMIT_ID,
    kind: 'consolidation',
    baseRevision: MAX_REVISION - 1,
    lease: { leaseId: LEASE_ID, epoch: MAX_REVISION },
    changes: changesWith(() => ''),
    consumedNoteIds: Array.from(
      { length: MEMORY_SYNC_LIMITS.commitConsumedNotesMax },
      (_, index) =>
        encodeMemoryUlid(1_700_000_000_000 + index, new Uint8Array(10)),
    ),
    metadata: {
      model: {
        modelId: escapedWorstCase(256),
        provider: escapedWorstCase(64),
        thinkingLevel: escapedWorstCase(32),
      },
      promptVersion: escapedWorstCase(64),
      consolidationPackageVersion: escapedWorstCase(64),
      inputHash: HASH,
    },
  };
  const spare =
    MEMORY_SYNC_LIMITS.commitRequestMaxBytes - memorySyncJsonBytes(commit);
  const share = Math.floor(spare / put.length);
  return {
    ...commit,
    changes: changesWith((index) =>
      'a'.repeat(index === 0 ? share + (spare - share * put.length) : share),
    ),
  };
}

function revisionRecord(
  commit: Pick<MemoryCommitRequest, 'commitId' | 'changes' | 'metadata'>,
  consumedNoteCount: number,
  restoredFromRevision: number | null,
): MemoryRevisionRecord {
  return {
    revision: MAX_REVISION,
    parentRevision: MAX_REVISION - 1,
    commitId: commit.commitId,
    kind: restoredFromRevision === null ? 'consolidation' : 'restore',
    committedAt: AT,
    holder: {
      kind: 'desktop',
      deviceId: DEVICE_ID,
      deviceLabel: escapedWorstCase(MEMORY_SYNC_LIMITS.deviceLabelMaxChars),
    },
    model: commit.metadata.model,
    promptVersion: commit.metadata.promptVersion,
    consolidationPackageVersion: commit.metadata.consolidationPackageVersion,
    inputHash: commit.metadata.inputHash,
    changedPaths: commit.changes.map((change) => change.path),
    consumedNoteCount,
    restoredFromRevision,
  };
}

function revisionEntry(commit: MemoryCommitRequest): MemoryChange {
  return {
    kind: 'revision',
    seq: MAX_SEQ,
    revision: revisionRecord(commit, commit.consumedNoteIds.length, null),
    changes: commit.changes,
    consumedNoteIds: commit.consumedNoteIds,
  };
}

function pageOf(changes: MemoryChange[]): MemoryChangesPage {
  return {
    scopeId: SCOPE_ID,
    changes,
    nextCursor: formatMemoryChangeCursor({
      scopeId: SCOPE_ID,
      generation: 999_999_999,
      seq: MAX_SEQ,
    }),
    hasMore: false,
    headRevision: MAX_REVISION,
  };
}

describe('memory changes page sizes', () => {
  it('delivers the revision of a maximum-count, maximum-size commit as one page within the hard maximum', () => {
    const commit = maximumCommit();
    expect(commit.changes).toHaveLength(MEMORY_SYNC_LIMITS.commitChangesMax);
    expect(MemoryCommitRequestSchema.safeParse(commit).success).toBe(true);
    expect(memorySyncJsonBytes(commit)).toBe(
      MEMORY_SYNC_LIMITS.commitRequestMaxBytes,
    );

    const entry = revisionEntry(commit);
    const page = pageOf([entry]);
    const bytes = memorySyncJsonBytes(page);
    expect(memorySyncJsonBytes(pageOf([]))).toBeLessThanOrEqual(
      MEMORY_SYNC_LIMITS.changesPageEnvelopeMaxBytes,
    );
    expect(bytes).toBeGreaterThan(MEMORY_SYNC_LIMITS.changesPageTargetBytes);
    expect(bytes).toBeLessThanOrEqual(
      MEMORY_SYNC_LIMITS.changesPageHardMaxBytes,
    );
    expect(MemoryChangesPageSchema.safeParse(page).success).toBe(true);
    expect(
      memoryChangesPageHasRoom(
        { entryCount: 0, entriesBytes: 0 },
        memorySyncJsonBytes(entry),
      ),
    ).toBe(true);
  });

  it('stops adding entries at the target except for the first', () => {
    const removed: MemoryChange = {
      kind: 'note_removed',
      seq: '1',
      noteId: NOTE_ID,
      reason: 'tombstoned',
      at: AT,
    };
    const large = revisionEntry(maximumCommit());
    const largeAfter = { ...large, seq: '2' };
    expect(
      memoryChangesPageHasRoom(
        { entryCount: 1, entriesBytes: memorySyncJsonBytes(removed) },
        memorySyncJsonBytes(largeAfter),
      ),
    ).toBe(false);
    expect(isMemoryChangesPageWithinBytes(pageOf([removed, largeAfter]))).toBe(
      false,
    );
    expect(
      MemoryChangesPageSchema.safeParse(pageOf([removed, largeAfter])).success,
    ).toBe(false);
  });
});

type Documents = ReadonlyMap<string, string>;

function topicSet(names: readonly string[]): Map<string, string> {
  return new Map(names.map((name) => [`topics/${name}.md`, `# ${name}\n`]));
}

function applyChanges(
  documents: Documents,
  changes: readonly MemoryDocumentChange[],
): Documents {
  const next = new Map(documents);
  for (const change of changes) {
    if (change.op === 'delete') next.delete(change.path);
    else next.set(change.path, change.content);
  }
  return next;
}

function renameChanges(
  documents: Documents,
  renames: ReadonlyMap<string, string>,
): MemoryDocumentChange[] {
  return [...renames].flatMap(([from, to]): MemoryDocumentChange[] => [
    { op: 'delete', path: from },
    {
      op: 'put',
      path: to,
      content: documents.get(from) ?? '',
      contentHash: HASH,
    },
  ]);
}

function restoreChanges(
  head: Documents,
  target: Documents,
): MemoryDocumentChange[] {
  const deletes = [...head.keys()]
    .filter((path) => !target.has(path))
    .map((path): MemoryDocumentChange => ({ op: 'delete', path }));
  const puts = [...target]
    .filter(([path, content]) => head.get(path) !== content)
    .map(
      ([path, content]): MemoryDocumentChange => ({
        op: 'put',
        path,
        content,
        contentHash: HASH,
      }),
    );
  return [...deletes, ...puts];
}

describe('memory restore sizes', () => {
  it('restores a scope whose topics were all renamed in one revision', () => {
    const names = Array.from(
      { length: 300 },
      (_, index) => `topic-${String(index).padStart(3, '0')}`,
    );
    const original = topicSet(names);
    const renamesOf = (batch: readonly string[]): Map<string, string> =>
      new Map(
        batch.map((name) => [`topics/${name}.md`, `topics/${name}-renamed.md`]),
      );
    const firstRename = renameChanges(original, renamesOf(names.slice(0, 150)));
    const afterFirst = applyChanges(original, firstRename);
    const secondRename = renameChanges(afterFirst, renamesOf(names.slice(150)));
    const head = applyChanges(afterFirst, secondRename);
    expect(MemoryDocumentChangesSchema.safeParse(firstRename).success).toBe(
      true,
    );
    expect(MemoryDocumentChangesSchema.safeParse(secondRename).success).toBe(
      true,
    );

    const restore = restoreChanges(head, original);
    expect(restore).toHaveLength(600);
    expect(applyChanges(head, restore)).toEqual(original);
    expect(MemoryDocumentChangesSchema.safeParse(restore).success).toBe(true);

    const restoreCommit = {
      commitId: COMMIT_ID,
      changes: restore,
      metadata: {
        model: null,
        promptVersion: null,
        consolidationPackageVersion: null,
        inputHash: null,
      },
    };
    const entry: MemoryChange = {
      kind: 'revision',
      seq: MAX_SEQ,
      revision: revisionRecord(restoreCommit, 0, 1),
      changes: restore,
      consumedNoteIds: [],
    };
    expect(MemoryChangesPageSchema.safeParse(pageOf([entry])).success).toBe(
      true,
    );
  });
});
