/**
 * Delta-journal diagnostics are scope-specific session events.
 *
 * A scope whose journal holds a record from a newer journal version is
 * refused: the repository records a content-free
 * `delta_journal_newer_format` storage diagnostic. A journal
 * ending in invalid incomplete bytes records `delta_journal_torn_tail_dropped`
 * when recovery drops them. `ChatStateService` turns every
 * one into a `chat_storage_diagnostic` session record keyed by the scope,
 * with no chat id or content, and nothing goes to the global app-events
 * stream.
 */
import { createHash } from 'node:crypto';
import { appendFile, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DELTA_JOURNAL_FILE_NAME,
  FRAME_HEADER_BYTES,
} from '../lib/chat-delta-journal/format';
import { readDeltaJournal } from '../lib/chat-delta-journal/replay';
import {
  ChatDeltaJournalWriter,
  promoteToDeltaJournal,
  type DeltaJournalDiagnostic,
} from '../lib/chat-delta-journal/writer';
import { ChatStorageV2 } from '../lib/chat-storage-v2';
import type { SessionDiagnosticRecord } from '../observability/service';
import {
  ChatStateService,
  storageSessionDiagnostic,
} from '../services/chat-state-service';
import { ChatStateV2Repository } from '../services/chat-state-v2-repository';
import { createV2Scope, message } from './helpers/chat-delta-journal-harness';
import {
  drainAfterTest,
  drainOpenRepositories,
} from './helpers/chat-delta-journal-scope';

const mockAppDiagnostic = jest.fn();
jest.mock('../observability', () => ({
  getObservabilityService: (): Record<string, jest.Mock> => ({
    recordSessionDiagnostic: mockAppDiagnostic,
    recordAppDiagnostic: mockAppDiagnostic,
    observeSteeringInput: jest.fn(),
  }),
}));

const SCOPE = { projectId: 'workspace', worktreeId: 'scope' };

describe('delta journal diagnostics', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'chat-delta-journal-diagnostics-'));
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await drainOpenRepositories();
    mockAppDiagnostic.mockReset();

    await rm(root, { recursive: true, force: true });
  });

  /** Append a valid frame whose record is from a newer journal version. */
  async function appendNewerRecord(journalPath: string): Promise<void> {
    const journal = await readDeltaJournal(
      join(root, 'chat-storage-v2', 'scope'),
      'scope',
    );
    const payload = Buffer.from(
      JSON.stringify({
        type: 'commit',
        v: 2,
        prev: journal.lastDigest,
        fromRevision: journal.lastRevision,
        toRevision: journal.lastRevision + 1,
      }),
      'utf8',
    );
    const header = Buffer.alloc(FRAME_HEADER_BYTES);
    header.write('CDJ1', 0, 'ascii');
    header.writeUInt32LE(payload.length, 4);
    createHash('sha256').update(payload).digest().copy(header, 8);
    await appendFile(journalPath, Buffer.concat([header, payload]));
  }

  /** A version 3 scope with one record after its checkpoint. */
  async function journaledScope(): Promise<string> {
    const store = await createV2Scope(root, 'scope', [
      { id: 'chat', messages: [message('m0', 'secret prompt text', 'user')] },
    ]);
    await promoteToDeltaJournal(store);
    const writer = await ChatDeltaJournalWriter.open(store);
    const current = writer.indexes();
    await writer.commit({
      expectedRevision: 0,
      next: {
        live: { ...current.live, revision: 1 },
        archive: { ...current.archive, revision: 1 },
        recovery: { ...current.recovery, mutationIds: ['a'] },
      },
      writes: [
        {
          chatId: 'chat',
          kind: 'append',
          messages: [message('a', 'secret reply text')],
        },
      ],
      mutationIds: ['a'],
    });
    return join(store.directory, DELTA_JOURNAL_FILE_NAME);
  }

  function repository(): ChatStateV2Repository {
    return drainAfterTest(
      new ChatStateV2Repository({
        resolvePaths: (): {
          tabs: string;
          archives: string;
          journal: string;
        } => ({
          tabs: join(root, 'chats', 'scope.json'),
          archives: join(root, 'chat-archives', 'scope.json'),
          journal: join(root, 'chat-journals', 'scope.jsonl'),
        }),
      }),
    );
  }

  it('records the refusal of a newer journal version once per load attempt', async () => {
    const journal = await journaledScope();
    await appendNewerRecord(journal);
    const target = repository();
    await expect(target.getState(SCOPE)).rejects.toThrow('newer');
    await expect(target.getRevision(SCOPE)).rejects.toThrow('newer');
    // The sticky load error itself names the cause.
    const [loadError] = target.getDiagnostics(SCOPE);
    expect(loadError?.kind).toBe('unrecoverable_journal');
    expect(loadError?.message).toContain('newer');
    expect(target.getStorageDiagnostics(SCOPE)).toEqual([
      expect.objectContaining({
        kind: 'delta_journal_newer_format',
        storageAuthority: 'v2',
        ...SCOPE,
        // The journal's newer record is unreadable, so no summary.
        journalBytes: 0,
      }),
    ]);
  });

  it('records an unacknowledged journal tail with its size', async () => {
    const journal = await journaledScope();
    const verified = (await stat(journal)).size;
    await appendFile(journal, Buffer.from('CDJ1 torn'));
    const target = repository();
    // Recovery drops the unacknowledged tail and keeps journal authority.
    await target.getState(SCOPE);
    expect(target.getStorageDiagnostics(SCOPE)).toEqual([
      expect.objectContaining({
        kind: 'delta_journal_torn_tail_dropped',
        ...SCOPE,
        journalBytes: verified,
        recordBytes: 9,
        recordCount: 1,
        journalTailReason: 'incomplete',
      }),
    ]);
    // An incomplete tail is truncated, never quarantined.
    expect(
      target
        .getStorageDiagnostics(SCOPE)
        .some((diagnostic) => 'journalQuarantineFile' in diagnostic),
    ).toBe(false);
  });

  it('records the refusal when the journal itself is missing', async () => {
    const journal = await journaledScope();
    await rm(journal);
    const target = repository();
    await expect(target.getState(SCOPE)).rejects.toThrow(
      'Delta journal is missing',
    );
    expect(target.getDiagnostics(SCOPE)[0]?.kind).toBe('unrecoverable_journal');
  });

  it('becomes content-free session events, never global app events', async () => {
    const journal = await journaledScope();
    // A complete header without a frame: a checksum mismatch.
    await appendFile(journal, Buffer.alloc(64));
    const records: SessionDiagnosticRecord[] = [];
    const target = new ChatStateService({
      repository: repository(),
      recordDiagnostic: (record): void => {
        records.push(record);
      },
    });
    await target.getState(SCOPE);
    expect(records).toEqual([
      expect.objectContaining({
        kind: 'chat_storage_diagnostic',
        projectId: SCOPE.projectId,
        worktreeId: SCOPE.worktreeId,
        chatId: '',
        chatStorageKind: 'delta_journal_torn_tail_dropped',
        chatStorageRecordBytes: 64,
        chatStorageRecordCount: 1,
        chatStorageJournalTailReason: 'checksum_mismatch',
        chatStorageJournalQuarantineFile: 'delta-journal-tail-quarantine-1.bin',
      }),
    ]);
    const text = JSON.stringify(records);
    for (const secret of ['secret', '"chat"', 'm0'])
      expect(text).not.toContain(secret);
    expect(mockAppDiagnostic).not.toHaveBeenCalled();
    await target.drain();
  });

  it("forwards the writer's quarantine file name, and only its base name", async () => {
    const journal = await journaledScope();
    const garbled = Buffer.alloc(64, 0x41);
    await appendFile(journal, garbled);
    const diagnostics: DeltaJournalDiagnostic[] = [];
    await ChatDeltaJournalWriter.open(new ChatStorageV2(root, 'scope'), {
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    expect(diagnostics).toHaveLength(1);
    const record = storageSessionDiagnostic({
      ...diagnostics[0],
      ...SCOPE,
      occurredAt: '2026-10-01T00:00:00.000Z',
      storageAuthority: 'v2',
    });
    expect(record).toEqual(
      expect.objectContaining({
        kind: 'chat_storage_diagnostic',
        chatId: '',
        chatStorageKind: 'delta_journal_torn_tail_dropped',
        chatStorageRecordBytes: 64,
        chatStorageJournalTailReason: 'checksum_mismatch',
        chatStorageJournalQuarantineFile: 'delta-journal-tail-quarantine-1.bin',
      }),
    );
    expect(JSON.stringify(record)).not.toContain(root);
  });

  it('forwards the category of an artifact maintenance failure', () => {
    expect(
      storageSessionDiagnostic({
        kind: 'artifact_maintenance_failed',
        ...SCOPE,
        occurredAt: '2026-10-01T00:00:00.000Z',
        storageAuthority: 'v2',
        journalBytes: 0,
        maintenanceReason: 'invalid_sidecar',
      }),
    ).toEqual(
      expect.objectContaining({
        chatStorageKind: 'artifact_maintenance_failed',
        chatStorageMaintenanceReason: 'invalid_sidecar',
      }),
    );
  });
});
