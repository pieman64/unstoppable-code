import { createHash } from 'node:crypto';

import {
  LedgerActorRegisteredPayloadSchema,
  LedgerEntryRevisionPayloadSchema,
  LedgerScopeLifecyclePayloadSchema,
  LedgerScopeRegisteredPayloadSchema,
  LedgerSyncEventSchema,
  isLedgerCanonicalValue,
  toLedgerCanonicalJson,
  type LedgerSyncEvent,
} from '@canopy/protocol/ledger-sync';

import {
  NO_DETAILS,
  addInput,
  readLedgerDatabase,
  setUpLedger,
  updateInput,
  type LedgerTestContext,
} from './ledger-test-harness';

/*
 * The outbox is what the mirror receives. Every event the repository writes
 * must fit the sync contract as it is stored: the envelope, the payload of its
 * kind, and a hash the mirror reproduces from the payload.
 */

function readOutboxEvents(
  databasePath: string,
  ledgerId: string,
): LedgerSyncEvent[] {
  return readLedgerDatabase(databasePath, (raw) =>
    raw
      .prepare(
        `SELECT event_id, scope_sequence, kind, entry_id, entry_revision,
                occurred_at, payload_json, payload_hash
         FROM ledger_outbox WHERE ledger_id = ? ORDER BY scope_sequence`,
      )
      .all(ledgerId)
      .map((row) => {
        const payload: unknown = JSON.parse(String(row.payload_json));
        return LedgerSyncEventSchema.parse({
          eventId: row.event_id,
          scopeSequence: String(row.scope_sequence),
          kind: row.kind,
          entryId: row.entry_id,
          entryRevision:
            row.entry_revision === null ? null : Number(row.entry_revision),
          occurredAt: row.occurred_at,
          payloadHash: row.payload_hash,
          payload,
        });
      }),
  );
}

describe('LedgerRepository outbox and the sync contract', () => {
  let context: LedgerTestContext;

  beforeEach(() => {
    context = setUpLedger();
  });

  afterEach(() => {
    context.dispose();
  });

  it('writes every event as the mirror parses and hashes it', () => {
    const { repository, ledgerId } = context;
    const created = repository.addEntry(
      addInput(
        context,
        context.user,
        {
          type: 'TASK',
          title: 'Écrire les notes 📝',
          content: 'Cover the Ledger panel.\nAnd its sources.',
          highlights: ['Panel'],
          referenceFiles: [
            { rootId: 'repo-1', path: 'src/a.ts', startLine: 3 },
          ],
        },
        'sync-1',
      ),
    );
    repository.updateEntry(
      updateInput(
        context,
        context.user,
        {
          entryId: created.entry.entryId,
          expectedRevision: 1,
          status: 'IN_PROGRESS',
          owner: { actorId: context.chat.actorId, eligibilityToken: 'token' },
        },
        'sync-2',
        { newOwner: context.chat },
      ),
    );
    repository.publishSummary({
      ledgerId,
      helper: context.helper,
      helperDetails: NO_DETAILS,
      params: {
        snapshotId: 'snapshot-1',
        generationId: 'generation-1',
        title: 'Summary of the work',
        content: 'The notes were written.',
        sourceTruncated: true,
      },
      idempotencyKey: `summary:${ledgerId}:snapshot-1`,
    });
    repository.setScopeLifecycle({ ledgerId, state: 'archived' });
    repository.setScopeLifecycle({ ledgerId, state: 'active' });
    // The store holds the file exclusively; read it once it is closed.
    repository.close();

    const events = readOutboxEvents(context.databasePath, ledgerId);

    expect(events.map((event) => event.kind)).toEqual([
      'scope_registered',
      'actor_registered',
      'actor_registered',
      'actor_registered',
      'actor_registered',
      'actor_registered',
      'entry_revision',
      'entry_revision',
      'entry_revision',
      'scope_archived',
      'scope_restored',
    ]);
    expect(events.map((event) => event.scopeSequence)).toEqual(
      events.map((_event, index) => String(index + 1)),
    );
    for (const event of events) {
      if (!isLedgerCanonicalValue(event.payload)) {
        throw new Error('The payload is not JSON data');
      }
      expect(
        createHash('sha256')
          .update(toLedgerCanonicalJson(event.payload), 'utf8')
          .digest('hex'),
      ).toBe(event.payloadHash);
      switch (event.kind) {
        case 'scope_registered':
          expect(
            LedgerScopeRegisteredPayloadSchema.parse(event.payload).scope
              .ledgerId,
          ).toBe(ledgerId);
          break;
        case 'actor_registered':
          LedgerActorRegisteredPayloadSchema.parse(event.payload);
          break;
        case 'entry_revision': {
          const payload = LedgerEntryRevisionPayloadSchema.parse(event.payload);
          expect(event.entryId).toBe(payload.entry.entryId);
          expect(event.entryRevision).toBe(payload.entry.revision);
          // Parsing keeps the payload byte for byte: nothing is trimmed away.
          expect(toLedgerCanonicalJson(payload)).toBe(
            toLedgerCanonicalJson(event.payload),
          );
          break;
        }
        case 'scope_archived':
        case 'scope_restored':
          LedgerScopeLifecyclePayloadSchema.parse(event.payload);
          break;
      }
    }
    const summary = LedgerEntryRevisionPayloadSchema.parse(events[8]?.payload);
    expect(summary.publication).toEqual({ sourceTruncated: true });
    expect(summary.entry.type).toBe('SUMMARY');
  });
});
