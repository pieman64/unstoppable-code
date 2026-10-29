import {
  assertStorageWriteAllowed,
  evaluateStorageWrite,
  LEGACY_STORAGE_WRITERS,
  STORAGE_WRITER_PRINCIPALS,
  StorageWriteRefusedError,
  type StorageOwnershipRow,
  type StorageWriterPrincipal,
} from '../writer-authority';

type Namespace =
  | 'daemon_ns'
  | 'legacy_ns'
  | 'interface_ns'
  | 'offline_ns'
  | 'dup_ns';

const ROWS: readonly StorageOwnershipRow<Namespace>[] = Object.freeze([
  {
    id: 'daemon_ns',
    transitionOwner: 'daemon',
    plane: 'core',
    currentWriters: ['desktop_cli', 'electron_main'],
    schemaVersion: 1,
    workPackage: 'W5',
    backupPolicy: 'required_before_flip',
    backupShape: 'namespace_backup',
  },
  {
    id: 'legacy_ns',
    transitionOwner: 'legacy',
    currentWriters: ['desktop_cli', 'electron_main'],
    schemaVersion: 1,
    workPackage: 'W5',
    backupPolicy: 'required_before_flip',
    backupShape: 'namespace_backup',
  },
  {
    id: 'interface_ns',
    transitionOwner: 'interface-local',
    currentWriters: ['renderer'],
    schemaVersion: 'none',
    backupPolicy: 'none',
  },
  {
    id: 'offline_ns',
    transitionOwner: 'offline',
    currentWriters: ['electron_main'],
    schemaVersion: 'none',
    backupPolicy: 'none',
  },
  {
    id: 'dup_ns',
    transitionOwner: 'legacy',
    currentWriters: ['electron_main'],
    schemaVersion: 'none',
    backupPolicy: 'none',
  },
  {
    id: 'dup_ns',
    transitionOwner: 'legacy',
    currentWriters: ['desktop_cli'],
    schemaVersion: 'none',
    backupPolicy: 'none',
  },
]);

function refusal(
  namespaceId: Namespace,
  writer: StorageWriterPrincipal,
  rows: readonly StorageOwnershipRow<Namespace>[] = ROWS,
): string | undefined {
  const decision = evaluateStorageWrite(namespaceId, writer, rows);
  return decision.allowed ? undefined : decision.reason;
}

// Forges values the type system rejects, as an untyped caller could.
function evaluateUnchecked(
  namespaceId: string,
  writer: string,
  rows: readonly unknown[],
): unknown {
  const decision: unknown = Reflect.apply(evaluateStorageWrite, undefined, [
    namespaceId,
    writer,
    rows,
  ]);
  return decision;
}

function refused(reason: string): { allowed: false; reason: string } {
  return { allowed: false, reason };
}

function legacyRow(): StorageOwnershipRow<Namespace> {
  const row = ROWS.find((candidate) => candidate.id === 'legacy_ns');
  if (!row) throw new Error('fixture missing legacy_ns');
  return row;
}

describe('storage writer principals', () => {
  it('covers every manifest writer class plus the reserved daemon', () => {
    expect([...LEGACY_STORAGE_WRITERS]).toEqual([
      'electron_main',
      'desktop_cli',
      'renderer',
      'utility_process',
      'provider_native',
    ]);
    expect([...STORAGE_WRITER_PRINCIPALS]).toEqual([
      ...LEGACY_STORAGE_WRITERS,
      'daemon',
    ]);
  });
});

describe('evaluateStorageWrite', () => {
  it('lets only the daemon write a daemon-owned namespace', () => {
    expect(refusal('daemon_ns', 'daemon')).toBeUndefined();
    for (const writer of LEGACY_STORAGE_WRITERS)
      expect(refusal('daemon_ns', writer)).toBe('daemon_owned');
  });

  it('allows the listed current writers of a legacy namespace only', () => {
    expect(refusal('legacy_ns', 'desktop_cli')).toBeUndefined();
    expect(refusal('legacy_ns', 'electron_main')).toBeUndefined();
    expect(refusal('legacy_ns', 'renderer')).toBe('unlisted_writer');
    expect(refusal('legacy_ns', 'daemon')).toBe('unlisted_writer');
  });

  it('allows the listed writers of an interface-local namespace only', () => {
    expect(refusal('interface_ns', 'renderer')).toBeUndefined();
    expect(refusal('interface_ns', 'electron_main')).toBe('unlisted_writer');
    expect(refusal('interface_ns', 'daemon')).toBe('unlisted_writer');
  });

  it('refuses every writer of an offline namespace, including the daemon', () => {
    for (const writer of STORAGE_WRITER_PRINCIPALS)
      expect(refusal('offline_ns', writer)).toBe('offline');
  });

  it('refuses a namespace missing from the supplied table', () => {
    const rows = ROWS.filter((row) => row.id !== 'legacy_ns');
    expect(refusal('legacy_ns', 'daemon', rows)).toBe('unknown_namespace');
    expect(refusal('legacy_ns', 'desktop_cli', rows)).toBe('unknown_namespace');
    expect(refusal('legacy_ns', 'desktop_cli', [])).toBe('unknown_namespace');
  });

  it('refuses a namespace claimed by more than one row', () => {
    expect(refusal('dup_ns', 'electron_main')).toBe('ambiguous_namespace');
  });

  it('refuses a principal outside the closed writer set', () => {
    const forgedRow = { ...legacyRow(), currentWriters: ['root'] };
    expect(evaluateUnchecked('legacy_ns', 'root', ROWS)).toEqual(
      refused('invalid_writer'),
    );
    expect(evaluateUnchecked('legacy_ns', 'root', [forgedRow])).toEqual(
      refused('invalid_writer'),
    );
  });

  it('refuses a row whose transition owner is not a known value', () => {
    const corruptRow = { ...legacyRow(), transitionOwner: 'anyone' };
    expect(evaluateUnchecked('legacy_ns', 'desktop_cli', [corruptRow])).toEqual(
      refused('invalid_row'),
    );
  });

  it('decides from the supplied rows alone', () => {
    const flipped = ROWS.map(
      (row): StorageOwnershipRow<Namespace> =>
        row.id === 'legacy_ns' ? { ...row, transitionOwner: 'daemon' } : row,
    );
    expect(refusal('legacy_ns', 'desktop_cli', flipped)).toBe('daemon_owned');
    expect(refusal('legacy_ns', 'desktop_cli')).toBeUndefined();
  });
});

describe('assertStorageWriteAllowed', () => {
  it('returns for an allowed write', () => {
    expect(() =>
      assertStorageWriteAllowed('daemon_ns', 'daemon', ROWS),
    ).not.toThrow();
  });

  it('throws a typed refusal naming the namespace, writer, and reason', () => {
    let caught: unknown;
    try {
      assertStorageWriteAllowed('daemon_ns', 'desktop_cli', ROWS);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(StorageWriteRefusedError);
    expect(caught).toMatchObject({
      namespaceId: 'daemon_ns',
      writer: 'desktop_cli',
      reason: 'daemon_owned',
    });
  });
});
