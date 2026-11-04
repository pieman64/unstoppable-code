import {
  MEMORY_SYNC_ERROR_CODES,
  MEMORY_SYNC_ERROR_HTTP_STATUS,
  MemoryCommitRequestSchema,
  MemoryManifestFileSchema,
  MemoryNoteFrontmatterIdentitySchema,
  MemoryNoteRecordSchema,
  MemoryNoteSchema,
  MemoryNotesPushRequestSchema,
  MemoryRevisionRecordSchema,
  MemoryScopeRecordSchema,
  MemorySyncErrorResponseSchema,
  MemorySyncStateFileSchema,
  initialMemoryChangeCursor,
  memoryReplicaPathSegments,
  type MemoryCommitRequest,
  type MemoryNote,
} from '../index';

const ACCOUNT_ID = '00000000-0000-4000-8000-0000000000c1';
const DEVICE_ID = '00000000-0000-4000-8000-0000000000d1';
const SCOPE_ID = '00000000-0000-4000-8000-0000000000a1';
const PROJECT_ID = '00000000-0000-4000-8000-0000000000b1';
const ORG_ID = '00000000-0000-4000-8000-0000000000e1';
const LEASE_ID = '00000000-0000-4000-8000-0000000000f1';
const NOTE_ID = '01JB2Z8Q4F6X9M3N5P7R1T2V3W';
const OTHER_NOTE_ID = '01JB2Z8Q4F6X9M3N5P7R1T2V3X';
const COMMIT_ID = '01JB2Z8Q4F6X9M3N5P7R1T2V3Y';
const HASH = 'a'.repeat(64);
const AT = '2026-10-27T10:00:00.000Z';

const NOTE: MemoryNote = {
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

const COMMIT: MemoryCommitRequest = {
  commitId: COMMIT_ID,
  kind: 'consolidation',
  baseRevision: 3,
  lease: { leaseId: LEASE_ID, epoch: 2 },
  changes: [
    {
      op: 'put',
      path: 'MEMORY.md',
      content: '- [Build](topics/build.md)\n',
      contentHash: HASH,
    },
    { op: 'delete', path: 'topics/old.md' },
  ],
  consumedNoteIds: [NOTE_ID],
  metadata: {
    model: { modelId: 'claude-sonnet' },
    promptVersion: 'consolidation-v1',
    consolidationPackageVersion: '1.0.0',
    inputHash: HASH,
  },
};

describe('memory notes', () => {
  it('round-trips a note exactly as the device wrote it', () => {
    expect(MemoryNoteSchema.parse(NOTE)).toEqual(NOTE);
  });

  it('keeps the folder, kind and import source consistent', () => {
    expect(
      MemoryNoteSchema.safeParse({ ...NOTE, fileKey: 'imported/x.md' }).success,
    ).toBe(false);
    expect(
      MemoryNoteSchema.safeParse({
        ...NOTE,
        kind: 'import',
        fileKey: 'imported/claude-notes-0123abcd.md',
      }).success,
    ).toBe(false);
    expect(
      MemoryNoteSchema.safeParse({
        ...NOTE,
        kind: 'import',
        fileKey: 'imported/claude-notes-0123abcd.md',
        importSource: {
          tool: 'claude-code',
          originKey: HASH,
          sourceFilename: 'notes.md',
          modifiedAt: AT,
        },
      }).success,
    ).toBe(true);
    expect(
      MemoryNoteSchema.safeParse({ ...NOTE, supersedes: NOTE_ID }).success,
    ).toBe(false);
  });

  it('refuses bodies the device would not have stored', () => {
    expect(
      MemoryNoteSchema.safeParse({ ...NOTE, body: 'line\r\nline' }).success,
    ).toBe(false);
    expect(MemoryNoteSchema.safeParse({ ...NOTE, body: 'a\0b' }).success).toBe(
      false,
    );
    expect(
      MemoryNoteSchema.safeParse({ ...NOTE, body: 'é'.repeat(131_073) })
        .success,
    ).toBe(false);
  });

  it('ties a record state to its revision and closing time', () => {
    const pending = {
      ...NOTE,
      state: 'pending',
      receivedAt: AT,
      consumedInRevision: null,
      closedAt: null,
    };
    expect(MemoryNoteRecordSchema.safeParse(pending).success).toBe(true);
    expect(
      MemoryNoteRecordSchema.safeParse({ ...pending, state: 'consolidated' })
        .success,
    ).toBe(false);
    expect(
      MemoryNoteRecordSchema.safeParse({
        ...pending,
        state: 'consolidated',
        consumedInRevision: 4,
        closedAt: AT,
      }).success,
    ).toBe(true);
    expect(
      MemoryNoteRecordSchema.safeParse({
        ...pending,
        state: 'tombstoned',
        consumedInRevision: 4,
        closedAt: AT,
      }).success,
    ).toBe(false);
  });
});

describe('memory pushes and commits', () => {
  it('names each note once per push and requires a superseded note on replace', () => {
    expect(
      MemoryNotesPushRequestSchema.safeParse({
        ops: [
          { op: 'put', note: NOTE },
          { op: 'tombstone', noteId: OTHER_NOTE_ID, deletedAt: AT },
        ],
      }).success,
    ).toBe(true);
    expect(
      MemoryNotesPushRequestSchema.safeParse({
        ops: [
          { op: 'put', note: NOTE },
          { op: 'tombstone', noteId: NOTE_ID, deletedAt: AT },
        ],
      }).success,
    ).toBe(false);
    expect(
      MemoryNotesPushRequestSchema.safeParse({
        ops: [{ op: 'replace', note: NOTE }],
      }).success,
    ).toBe(false);
    expect(
      MemoryNotesPushRequestSchema.safeParse({
        ops: [
          {
            op: 'replace',
            note: { ...NOTE, noteId: OTHER_NOTE_ID, supersedes: NOTE_ID },
          },
        ],
      }).success,
    ).toBe(true);
  });

  it('round-trips a fenced consolidation commit', () => {
    expect(MemoryCommitRequestSchema.parse(COMMIT)).toEqual(COMMIT);
  });

  it('refuses commits that could not be applied unambiguously', () => {
    expect(
      MemoryCommitRequestSchema.safeParse({ ...COMMIT, lease: null }).success,
    ).toBe(false);
    expect(
      MemoryCommitRequestSchema.safeParse({
        ...COMMIT,
        kind: 'manual_edit',
        lease: null,
      }).success,
    ).toBe(false);
    expect(
      MemoryCommitRequestSchema.safeParse({
        ...COMMIT,
        changes: [],
        consumedNoteIds: [],
      }).success,
    ).toBe(false);
    expect(
      MemoryCommitRequestSchema.safeParse({
        ...COMMIT,
        consumedNoteIds: [NOTE_ID, NOTE_ID],
      }).success,
    ).toBe(false);
    expect(
      MemoryCommitRequestSchema.safeParse({
        ...COMMIT,
        changes: [
          { op: 'delete', path: 'topics/Build.md' },
          {
            op: 'put',
            path: 'topics/build.md',
            content: '# Build\n',
            contentHash: HASH,
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('keeps revisions linear and restores pointing backwards', () => {
    const revision = {
      revision: 4,
      parentRevision: 3,
      commitId: COMMIT_ID,
      kind: 'consolidation',
      committedAt: AT,
      holder: { kind: 'cloud', workerId: 'memory-worker-1' },
      model: null,
      promptVersion: null,
      consolidationPackageVersion: null,
      inputHash: null,
      changedPaths: ['MEMORY.md'],
      consumedNoteCount: 1,
      restoredFromRevision: null,
    };
    expect(MemoryRevisionRecordSchema.safeParse(revision).success).toBe(true);
    expect(
      MemoryRevisionRecordSchema.safeParse({ ...revision, parentRevision: 2 })
        .success,
    ).toBe(false);
    expect(
      MemoryRevisionRecordSchema.safeParse({ ...revision, kind: 'restore' })
        .success,
    ).toBe(false);
    expect(
      MemoryRevisionRecordSchema.safeParse({
        ...revision,
        kind: 'restore',
        restoredFromRevision: 4,
      }).success,
    ).toBe(false);
  });

  it('gives a project scope its project and a user scope none', () => {
    const scope = {
      scopeId: SCOPE_ID,
      accountId: ACCOUNT_ID,
      kind: 'user',
      projectId: null,
      revision: 0,
      cursor: initialMemoryChangeCursor(SCOPE_ID, 1),
      syncState: 'active',
      serverConsolidation: 'inherit',
      createdAt: AT,
      updatedAt: AT,
    };
    expect(MemoryScopeRecordSchema.safeParse(scope).success).toBe(true);
    expect(
      MemoryScopeRecordSchema.safeParse({ ...scope, projectId: PROJECT_ID })
        .success,
    ).toBe(false);
    expect(
      MemoryScopeRecordSchema.safeParse({ ...scope, kind: 'project' }).success,
    ).toBe(false);
  });

  it('maps every error code to a status and parses an error body', () => {
    for (const code of MEMORY_SYNC_ERROR_CODES) {
      expect(MEMORY_SYNC_ERROR_HTTP_STATUS[code]).toBeGreaterThanOrEqual(400);
    }
    expect(
      MemorySyncErrorResponseSchema.safeParse({
        error: {
          code: 'memory_revision_conflict',
          message: 'Memory changed on another device.',
          retry: 'after_pull',
          headRevision: 5,
        },
      }).success,
    ).toBe(true);
  });
});

describe('memory replica files', () => {
  it('keeps fields a newer build added when an older build reads them', () => {
    const manifest = {
      version: 2,
      incarnation: LEASE_ID,
      revision: 7,
      minWriterFormat: 2,
      createdAt: AT,
      backfilledAt: AT,
      binding: null,
      migratedTo: [],
      addedLater: { kept: true },
    };
    expect(MemoryManifestFileSchema.parse(manifest)).toEqual(manifest);
    expect(
      MemoryManifestFileSchema.safeParse({ ...manifest, minWriterFormat: 1 })
        .success,
    ).toBe(false);
  });

  it('reads note identity beside the version 1 front matter fields', () => {
    const frontmatter = {
      id: NOTE_ID,
      source: { provider: 'claude', chatId: 'chat-1' },
      created: AT,
      modified: AT,
      type: 'inbox',
      device: DEVICE_ID,
      origin: { organizationId: ORG_ID },
    };
    expect(MemoryNoteFrontmatterIdentitySchema.parse(frontmatter)).toEqual(
      frontmatter,
    );
    expect(
      MemoryNoteFrontmatterIdentitySchema.safeParse({
        ...frontmatter,
        id: NOTE_ID.toLowerCase(),
      }).success,
    ).toBe(false);
  });

  it('parses a sync state with base documents keyed by path', () => {
    const state = {
      version: 1,
      binding: {
        accountId: ACCOUNT_ID,
        scopeId: SCOPE_ID,
        kind: 'project',
        projectId: PROJECT_ID,
      },
      deviceId: DEVICE_ID,
      mode: 'syncing',
      cursor: initialMemoryChangeCursor(SCOPE_ID, 1),
      baseRevision: 3,
      baseDocuments: {
        'MEMORY.md': { contentHash: HASH, changedInRevision: 3 },
      },
      localOnlyNoteIds: [],
      pendingCommit: null,
      conflicts: [],
      firstEnable: null,
      lastPulledAt: AT,
      lastPushedAt: null,
      lastError: null,
    };
    expect(MemorySyncStateFileSchema.parse(state)).toEqual(state);
    expect(
      MemorySyncStateFileSchema.safeParse({
        ...state,
        baseDocuments: {
          'inbox/x.md': { contentHash: HASH, changedInRevision: 3 },
        },
      }).success,
    ).toBe(false);
  });

  it('places each account replica in its own directory', () => {
    expect(memoryReplicaPathSegments(ACCOUNT_ID, { kind: 'user' })).toEqual([
      'memory-replicas',
      ACCOUNT_ID,
      'user',
    ]);
    expect(
      memoryReplicaPathSegments(ACCOUNT_ID, {
        kind: 'project',
        projectId: PROJECT_ID,
      }),
    ).toEqual(['memory-replicas', ACCOUNT_ID, 'projects', PROJECT_ID]);
  });
});
