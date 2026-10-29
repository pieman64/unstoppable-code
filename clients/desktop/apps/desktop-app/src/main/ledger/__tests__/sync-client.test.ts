import type {
  LedgerScopeRegisterRequest,
  LedgerSyncPushRequest,
} from '@canopy/protocol/ledger-sync';
import { CanopyCloudClientError } from '../../canopy-cloud/client';
import {
  createLedgerMirrorClient,
  ledgerSyncFailureFor,
  type LedgerSyncFailure,
} from '../sync-client';

const LEDGER_ID = '00000000-0000-4000-8000-0000000000f1';
const ACCOUNT_ID = '00000000-0000-4000-8000-0000000000c1';
const REGISTRATION: LedgerScopeRegisterRequest = {
  schemaVersion: 1,
  ledgerId: LEDGER_ID,
  accountId: ACCOUNT_ID,
  scopeKind: 'code_worktree',
  session: {
    deviceId: 'device-1',
    installationGeneration: 3,
    nonce: '00000000-0000-4000-8000-0000000000d1',
  },
  audience: { kind: 'private' },
};
const PUSH: LedgerSyncPushRequest = {
  schemaVersion: 1,
  ledgerId: LEDGER_ID,
  accountId: ACCOUNT_ID,
  writerEpoch: '1',
  acknowledgedSequence: '0',
  events: [
    {
      eventId: '00000000-0000-4000-8000-000000000001',
      scopeSequence: '1',
      kind: 'scope_archived',
      entryId: null,
      entryRevision: null,
      occurredAt: '2026-10-01T10:00:00.000Z',
      payloadHash: 'a'.repeat(64),
      payload: {},
    },
  ],
};

function httpError(
  status: number,
  serverCode?: string,
  retryAfterMs?: number,
): CanopyCloudClientError {
  return new CanopyCloudClientError(
    'http-error',
    'refused',
    status,
    serverCode,
    undefined,
    serverCode !== undefined,
    retryAfterMs,
  );
}

describe('ledgerSyncFailureFor', () => {
  it("maps each of the mirror's refusals to what sync does next", () => {
    const cases: [CanopyCloudClientError, LedgerSyncFailure][] = [
      [httpError(403, 'ledger_scope_prohibited'), { kind: 'prohibited' }],
      [
        httpError(403, 'ledger_audience_forbidden'),
        { kind: 'audience_forbidden' },
      ],
      [httpError(409, 'ledger_stale_binding'), { kind: 'stale_binding' }],
      [
        httpError(404, 'ledger_scope_not_registered'),
        { kind: 'not_registered' },
      ],
      [
        httpError(409, 'ledger_stale_writer'),
        { kind: 'repair', reason: 'stale_writer' },
      ],
      [
        httpError(409, 'ledger_sequence_gap'),
        { kind: 'repair', reason: 'sequence_gap' },
      ],
      [
        httpError(409, 'ledger_divergent_event'),
        { kind: 'repair', reason: 'divergent_event' },
      ],
      [
        httpError(422, 'ledger_illegal_event'),
        { kind: 'repair', reason: 'illegal_event' },
      ],
      [
        httpError(400, 'ledger_invalid_request'),
        { kind: 'repair', reason: 'invalid_request' },
      ],
      [
        httpError(413, 'ledger_invalid_request'),
        { kind: 'repair', reason: 'invalid_request' },
      ],
    ];
    for (const [error, failure] of cases) {
      expect(ledgerSyncFailureFor(error)).toEqual(failure);
    }
  });

  it('waits out the kill switch, an older server and a failing one', () => {
    expect(
      ledgerSyncFailureFor(httpError(503, 'ledger_ingest_disabled', 300_000)),
    ).toEqual({ kind: 'retry', retryAfterMs: 300_000 });
    // A server that predates the mirror has no such route.
    expect(ledgerSyncFailureFor(httpError(404))).toEqual({ kind: 'retry' });
    for (const status of [408, 425, 429, 500, 502, 503, 504]) {
      expect(ledgerSyncFailureFor(httpError(status))).toEqual({
        kind: 'retry',
      });
    }
    expect(
      ledgerSyncFailureFor(
        new CanopyCloudClientError('network-error', 'offline'),
      ),
    ).toEqual({ kind: 'retry' });
    expect(
      ledgerSyncFailureFor(
        new CanopyCloudClientError('invalid-response', 'not JSON', 200),
      ),
    ).toEqual({ kind: 'retry' });
    expect(ledgerSyncFailureFor(new Error('boom'))).toEqual({ kind: 'retry' });
  });

  it('pauses when the account cannot send at all', () => {
    for (const error of [
      httpError(401),
      httpError(403),
      new CanopyCloudClientError('missing-api-key', 'signed out'),
      new CanopyCloudClientError('cloud-not-configured', 'no cloud'),
      new CanopyCloudClientError('unsupported-capability', 'older server'),
    ]) {
      expect(ledgerSyncFailureFor(error)).toEqual({ kind: 'paused' });
    }
  });

  it('asks for repair after a refusal it does not know', () => {
    for (const status of [400, 409, 413, 422]) {
      expect(ledgerSyncFailureFor(httpError(status))).toEqual({
        kind: 'repair',
        reason: 'invalid_request',
      });
    }
  });
});

describe('createLedgerMirrorClient', () => {
  it('posts a registration and returns what the mirror applied', async () => {
    const request = jest.fn().mockResolvedValue({
      ledgerId: LEDGER_ID,
      writerEpoch: '2',
      acknowledgedSequence: '5',
      audience: { kind: 'private' },
    });

    await expect(
      createLedgerMirrorClient(request).register(REGISTRATION),
    ).resolves.toEqual({
      ok: true,
      value: {
        ledgerId: LEDGER_ID,
        writerEpoch: '2',
        acknowledgedSequence: '5',
        audience: { kind: 'private' },
      },
    });
    expect(request).toHaveBeenCalledWith('/api/v1/ledger/scopes/register', {
      method: 'POST',
      body: JSON.stringify(REGISTRATION),
      timeoutMs: 15_000,
    });
  });

  it('posts a batch and returns the acknowledgment', async () => {
    const request = jest.fn().mockResolvedValue({
      ledgerId: LEDGER_ID,
      acknowledgedSequence: '1',
      applied: 1,
      replayed: 0,
    });

    await expect(
      createLedgerMirrorClient(request).push(PUSH),
    ).resolves.toMatchObject({
      ok: true,
      value: { acknowledgedSequence: '1', applied: 1 },
    });
    expect(request).toHaveBeenCalledWith('/api/v1/ledger/sync/push', {
      method: 'POST',
      body: JSON.stringify(PUSH),
      timeoutMs: 30_000,
    });
  });

  it('never sends a request the contract would refuse', async () => {
    const request = jest.fn();
    const client = createLedgerMirrorClient(request);

    await expect(
      client.register({ ...REGISTRATION, accountId: 'account-1' }),
    ).resolves.toEqual({
      ok: false,
      failure: { kind: 'repair', reason: 'invalid_request' },
    });
    await expect(client.push({ ...PUSH, events: [] })).resolves.toEqual({
      ok: false,
      failure: { kind: 'repair', reason: 'invalid_request' },
    });
    expect(request).not.toHaveBeenCalled();
  });

  it('reports a failed call, and an answer that is not the contract', async () => {
    const refused = jest
      .fn()
      .mockRejectedValue(httpError(409, 'ledger_stale_writer'));
    await expect(createLedgerMirrorClient(refused).push(PUSH)).resolves.toEqual(
      {
        ok: false,
        failure: { kind: 'repair', reason: 'stale_writer' },
      },
    );

    const garbled = jest.fn().mockResolvedValue({ acknowledged: true });
    await expect(createLedgerMirrorClient(garbled).push(PUSH)).resolves.toEqual(
      { ok: false, failure: { kind: 'retry' } },
    );
  });

  it("never takes another ledger's answer for this one", async () => {
    const otherLedger = '00000000-0000-4000-8000-0000000000f2';
    const request = jest
      .fn()
      .mockResolvedValueOnce({
        ledgerId: otherLedger,
        writerEpoch: '2',
        acknowledgedSequence: '5',
        audience: { kind: 'private' },
      })
      .mockResolvedValueOnce({
        ledgerId: otherLedger,
        acknowledgedSequence: '1',
        applied: 1,
        replayed: 0,
      });
    const client = createLedgerMirrorClient(request);

    await expect(client.register(REGISTRATION)).resolves.toEqual({
      ok: false,
      failure: { kind: 'retry' },
    });
    await expect(client.push(PUSH)).resolves.toEqual({
      ok: false,
      failure: { kind: 'retry' },
    });
  });
});
