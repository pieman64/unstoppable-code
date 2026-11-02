// W6g (CAN-5498): every commit the schema accepts must cross one frame and
// yield a result the schema also accepts.
import { composeCanopyOperationEnvelopes } from '../../../wire';
import {
  CORE_WORKSPACE_RECORDS_INSTRUCTION_DEFINITIONS,
  CORE_WORKSPACE_RECORDS_LIMITS,
  CORE_WORKSPACE_RECORDS_QUERY_DEFINITIONS,
  type CoreWorkspaceRecordsCommitParams,
} from '../registry';

const COMMIT =
  CORE_WORKSPACE_RECORDS_INSTRUCTION_DEFINITIONS[
    'core.workspaceRecords.commit'
  ];
const CAPTURE =
  CORE_WORKSPACE_RECORDS_QUERY_DEFINITIONS['core.workspaceRecords.capture'];
const request = composeCanopyOperationEnvelopes(
  'core.workspaceRecords.commit',
  COMMIT,
).request;
const wire = (params: unknown): boolean =>
  request.safeParse({
    jsonrpc: '2.0',
    id: 1,
    method: 'core.workspaceRecords.commit',
    params,
  }).success;

function withContents(contents: string): CoreWorkspaceRecordsCommitParams {
  return {
    operation: 'w5.worktree_list.write',
    advance: [{ kind: 'worktrees', workspaceId: 'a' }],
    files: [
      {
        target: { kind: 'worktrees', workspaceId: 'a' },
        contents,
        previousFingerprint: null,
      },
    ],
    outcome: null,
  };
}
const encoded = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;

describe('core.workspaceRecords.commit params', () => {
  it('refuses a commit that names no record, on the wire envelope too', () => {
    const empty = { operation: 'o', advance: [], files: [], outcome: null };
    expect(COMMIT.params.safeParse(empty).success).toBe(false);
    expect(wire(empty)).toBe(false);
    expect(
      COMMIT.params.safeParse({ ...empty, expectedRevisions: [] }).success,
    ).toBe(false);
    for (const named of [
      { ...empty, advance: [{ kind: 'workspaces' }] },
      {
        ...empty,
        expectedRevisions: [{ resource: { kind: 'workspaces' }, revision: 0 }],
      },
    ]) {
      expect(COMMIT.params.safeParse(named).success).toBe(true);
      expect(wire(named)).toBe(true);
    }
  });

  it('caps the encoded request below one frame, counting UTF-8 bytes', () => {
    const { requestBytes } = CORE_WORKSPACE_RECORDS_LIMITS;
    const room = requestBytes - encoded(withContents(''));
    expect(encoded(withContents('a'.repeat(room)))).toBe(requestBytes);
    expect(
      COMMIT.params.safeParse(withContents('a'.repeat(room))).success,
    ).toBe(true);
    expect(
      COMMIT.params.safeParse(withContents('a'.repeat(room + 1))).success,
    ).toBe(false);
    // Fewer characters than the per-file cap, more bytes than one frame.
    const multibyte = withContents('é'.repeat(Math.ceil(room / 2) + 1));
    expect(multibyte.files[0]?.contents?.length).toBeLessThan(
      CORE_WORKSPACE_RECORDS_LIMITS.bytes,
    );
    expect(COMMIT.params.safeParse(multibyte).success).toBe(false);
    expect(wire(multibyte)).toBe(false);
  });
});

describe('core.workspaceRecords.commit resources', () => {
  const advance = (
    resource: unknown,
  ): { operation: string; advance: unknown[]; files: []; outcome: null } => ({
    operation: 'w5.worktree.record',
    advance: [resource],
    files: [],
    outcome: null,
  });
  const longest = 'w'.repeat(128);

  it('accepts only workspace ids the capture grammar can name, for every resource', () => {
    for (const workspaceId of [
      `${longest}w`,
      'a/b',
      '..',
      'a.b',
      'con',
      'LPT1',
      '',
    ]) {
      for (const resource of [
        { kind: 'workspace', workspaceId },
        { kind: 'worktrees', workspaceId },
        { kind: 'worktree', workspaceId, worktreeId: 'one' },
      ]) {
        expect(COMMIT.params.safeParse(advance(resource)).success).toBe(false);
        expect(
          COMMIT.params.safeParse({
            ...advance({ kind: 'workspaces' }),
            expectedRevisions: [{ resource, revision: 0 }],
          }).success,
        ).toBe(false);
      }
    }
    for (const resource of [
      { kind: 'workspace', workspaceId: longest },
      { kind: 'worktrees', workspaceId: longest },
      { kind: 'worktree', workspaceId: longest, worktreeId: 'one' },
    ])
      expect(COMMIT.params.safeParse(advance(resource)).success).toBe(true);
  });

  it('accepts only well-formed worktree ids, whose UTF-8 key reads back', () => {
    for (const worktreeId of ['\uD800x', 'x\uDFFF', '\uDC00\uD800', '']) {
      const resource = { kind: 'worktree', workspaceId: 'a', worktreeId };
      expect(COMMIT.params.safeParse(advance(resource)).success).toBe(false);
      expect(
        COMMIT.params.safeParse({
          ...advance({ kind: 'workspaces' }),
          expectedRevisions: [{ resource, revision: 0 }],
        }).success,
      ).toBe(false);
    }
    for (const worktreeId of ['\u{1F600}'.repeat(128), 'a\u0000b', 'x/y'])
      expect(
        COMMIT.params.safeParse(
          advance({ kind: 'worktree', workspaceId: 'a', worktreeId }),
        ).success,
      ).toBe(true);
  });
});

describe('core.workspaceRecords.commit result', () => {
  it('accepts the revision key of the longest worktree resource the params accept', () => {
    const workspaceId = 'w'.repeat(128);
    const worktreeId = 't'.repeat(256);
    const resource: CoreWorkspaceRecordsCommitParams['advance'][number] = {
      kind: 'worktree',
      workspaceId,
      worktreeId,
    };
    const params: CoreWorkspaceRecordsCommitParams = {
      operation: 'w5.worktree.record',
      advance: [resource],
      files: [],
      outcome: null,
    };
    expect(COMMIT.params.safeParse(params).success).toBe(true);
    expect(
      COMMIT.params.safeParse({
        ...params,
        advance: [{ ...resource, worktreeId: `${worktreeId}t` }],
      }).success,
    ).toBe(false);
    const key = `worktree:${workspaceId}/${worktreeId}`;
    expect(
      COMMIT.result.safeParse({
        status: 'applied',
        commitId: 1,
        revisions: { [key]: 1 },
      }).success,
    ).toBe(true);
  });
});

describe('core.workspaceRecords.capture result', () => {
  it('carries every revision key the capture itself serves, up to its 512-character cap', () => {
    const capture = (key: string): unknown => ({
      files: [],
      discovery: 'not-requested',
      log: {
        commitId: 1,
        retainedCommits: 1,
        unresolvedCommits: 0,
        schemaVersion: 1,
        revisions: { [key]: 1 },
        files: [],
        chains: [],
        resourceRevisionEligibility: 'unproven',
      },
    });
    // An in-process writer's key under a capture-named worktree list.
    const key = `worktree:a/${'t'.repeat(512 - 'worktree:a/'.length)}`;
    expect(CAPTURE.result.safeParse(capture(key)).success).toBe(true);
    expect(CAPTURE.result.safeParse(capture(`${key}t`)).success).toBe(false);
  });
});

// CAN-5506: receipts and reservations.
const RECEIPT = {
  caller: 'desktop-host:test',
  operation: 'core.worktree.update',
  idempotencyKey: 'key',
  fingerprint: 'f'.repeat(64),
};

describe('keyed core.workspaceRecords.commit', () => {
  const keyed = { operation: 'o', advance: [], files: [], outcome: null };

  it('accepts a keyed decision that names no record, which records only its receipt or completes its reservation', () => {
    for (const params of [
      { ...keyed, receipt: RECEIPT },
      { ...keyed, reservationId: 'r' },
    ]) {
      expect(COMMIT.params.safeParse(params).success).toBe(true);
      expect(wire(params)).toBe(true);
    }
    expect(
      COMMIT.params.safeParse({ ...keyed, receipt: { ...RECEIPT, extra: 1 } })
        .success,
    ).toBe(false);
    expect(
      COMMIT.params.safeParse({ ...keyed, receipt: { ...RECEIPT, caller: '' } })
        .success,
    ).toBe(false);
  });

  it('returns a replay with its saved outcome, or an expired one without it', () => {
    expect(
      COMMIT.result.safeParse({
        status: 'replayed',
        commitId: 3,
        outcome: { id: 'one' },
      }).success,
    ).toBe(true);
    expect(
      COMMIT.result.safeParse({ status: 'replay-expired', commitId: 3 })
        .success,
    ).toBe(true);
    expect(
      COMMIT.result.safeParse({
        status: 'replay-expired',
        commitId: 3,
        outcome: null,
      }).success,
    ).toBe(false);
  });
});

describe('core.workspaceRecords.receipt.lookup', () => {
  const LOOKUP =
    CORE_WORKSPACE_RECORDS_QUERY_DEFINITIONS[
      'core.workspaceRecords.receipt.lookup'
    ];

  it('carries each keyed decision, with path-free commit recovery counts and opaque reservation diagnostics', () => {
    for (const result of [
      { status: 'none' },
      { status: 'key-reused' },
      { status: 'replay', commitId: 1, outcome: null },
      { status: 'replay-expired', commitId: 1 },
      {
        status: 'commit-recovery-required',
        commitId: 1,
        conflictCount: 1,
        writtenFileCount: 0,
        unexpectedFailure: false,
      },
      { status: 'in-progress', reservationId: 'r' },
      { status: 'recovery-required', reservationId: 'r', diagnostics: 'null' },
    ])
      expect(LOOKUP.result.safeParse(result).success).toBe(true);
    for (const result of [
      // Apply diagnostics name the authority's paths; only counts cross.
      {
        status: 'commit-recovery-required',
        commitId: 1,
        diagnostics: { conflicts: [] },
      },
      // Reservation diagnostics cross only as opaque text.
      {
        status: 'recovery-required',
        reservationId: 'r',
        diagnostics: { ownedPaths: ['/a'] },
      },
    ])
      expect(LOOKUP.result.safeParse(result).success).toBe(false);
    expect(LOOKUP.params.safeParse({ receipt: RECEIPT }).success).toBe(true);
  });
});

describe('core.workspaceRecords reservations', () => {
  const LIST =
    CORE_WORKSPACE_RECORDS_QUERY_DEFINITIONS[
      'core.workspaceRecords.reservation.list'
    ];
  const RESERVE =
    CORE_WORKSPACE_RECORDS_INSTRUCTION_DEFINITIONS[
      'core.workspaceRecords.reservation.reserve'
    ];
  const MARK =
    CORE_WORKSPACE_RECORDS_INSTRUCTION_DEFINITIONS[
      'core.workspaceRecords.reservation.markRecoveryRequired'
    ];

  it('takes diagnostics as opaque text, keyed or not', () => {
    expect(
      RESERVE.params.safeParse({
        reservationId: 'r',
        operation: 'core.workspace.create',
        diagnostics: '{"ownedPaths":[]}',
      }).success,
    ).toBe(true);
    expect(
      RESERVE.params.safeParse({
        reservationId: 'r',
        operation: RECEIPT.operation,
        receipt: RECEIPT,
      }).success,
    ).toBe(true);
    expect(
      RESERVE.params.safeParse({
        reservationId: 'r',
        operation: 'o',
        diagnostics: { ownedPaths: [] },
      }).success,
    ).toBe(false);
  });

  it('takes only content-free failure diagnostics', () => {
    const mark = (diagnostics: unknown): boolean =>
      MARK.params.safeParse({ reservationId: 'r', diagnostics }).success;
    expect(mark({ operation: 'o', errorName: 'GitError' })).toBe(true);
    expect(
      mark({ operation: 'o', errorName: 'GitError', errorCode: 'ENOENT' }),
    ).toBe(true);
    expect(mark({ operation: 'o', errorName: 'failed at /tmp/x' })).toBe(false);
    expect(mark({ operation: 'o', errorName: 'E', errorCode: '/tmp/x' })).toBe(
      false,
    );
    expect(mark({ operation: 'o', errorName: 'E', message: 'm' })).toBe(false);
  });

  it('keeps a reservation list within one frame', () => {
    const entry = (index: number, size: number): unknown => ({
      reservationId: `r${index}`,
      operation: 'core.workspace.create',
      state: 'reserved',
      diagnostics: 'x'.repeat(size),
    });
    expect(
      LIST.result.safeParse({ reservations: [entry(0, 1024)] }).success,
    ).toBe(true);
    expect(
      LIST.result.safeParse({
        reservations: Array.from({ length: 40 }, (_, index) =>
          entry(index, 200 * 1024),
        ),
      }).success,
    ).toBe(false);
  });
});
