import {
  createNamespaceBackupRecord,
  NamespaceBackupRecordError,
  validateNamespaceBackupRecord,
  type NamespaceBackupRecord,
  type NamespaceBackupValidationContext,
} from '../backup-record';
import type { StorageOwnershipRow } from '../writer-authority';
import { NAMESPACE_BACKUP_FIELDS } from '../storage-ownership.generated';

const ROWS: readonly StorageOwnershipRow[] = [
  {
    id: 'workspace_index',
    transitionOwner: 'legacy',
    currentWriters: ['desktop_cli', 'electron_main'],
    schemaVersion: 1,
    workPackage: 'W5',
    backupPolicy: 'required_before_flip',
    backupShape: 'namespace_backup',
  },
  {
    id: 'preferences',
    transitionOwner: 'legacy',
    currentWriters: ['electron_main'],
    schemaVersion: 'none',
    backupPolicy: 'none',
  },
];

const CONTEXT: NamespaceBackupValidationContext = {
  rows: ROWS,
  isOutsideCheckouts: () => true,
};

function validRecord(): NamespaceBackupRecord {
  return {
    namespaceId: 'workspace_index',
    backupPath: 'backups/w5/workspace_index/index.json',
    sourceRevision: 'sha256:0f1e',
    schemaVersion: 1,
    createdAt: '2026-10-08T09:00:00Z',
    verifiedBy: { algorithm: 'sha256', digest: 'ab'.repeat(32) },
    rollbackMigration: 'w5-restore-workspace-index',
    restoreTestedAt: '2026-10-08T11:05:00.250+02:00',
  };
}

function errorsFor(
  candidate: unknown,
  context: NamespaceBackupValidationContext = CONTEXT,
): readonly string[] {
  const result = validateNamespaceBackupRecord(candidate, context);
  return result.ok ? [] : result.errors;
}

describe('validateNamespaceBackupRecord', () => {
  it('accepts a complete record for a required_before_flip namespace', () => {
    expect(
      Object.keys(createNamespaceBackupRecord(validRecord(), CONTEXT)).sort(),
    ).toEqual([...NAMESPACE_BACKUP_FIELDS].sort());
    expect(validateNamespaceBackupRecord(validRecord(), CONTEXT)).toEqual({
      ok: true,
      record: validRecord(),
    });
  });

  it('accepts digest algorithms beyond the schema example', () => {
    const record = {
      ...validRecord(),
      verifiedBy: { algorithm: 'blake3', digest: 'Zm9vYmFy' },
    };
    expect(errorsFor(record)).toEqual([]);
  });

  it('accepts a valid RFC 3339 year below 100', () => {
    expect(
      errorsFor({ ...validRecord(), createdAt: '0001-01-01T00:00:00Z' }),
    ).toEqual([]);
  });

  it('rejects input that is not a record', () => {
    expect(errorsFor(null)).toEqual([expect.stringMatching(/object/)]);
    expect(errorsFor([validRecord()])).toEqual([
      expect.stringMatching(/object/),
    ]);
  });

  it('reports each missing required field', () => {
    const errors = errorsFor({});
    for (const field of [
      'namespaceId',
      'backupPath',
      'sourceRevision',
      'schemaVersion',
      'createdAt',
      'verifiedBy',
      'rollbackMigration',
      'restoreTestedAt',
    ])
      expect(errors).toContainEqual(expect.stringContaining(field));
  });

  it('requires a namespace with a required_before_flip row', () => {
    expect(
      errorsFor({ ...validRecord(), namespaceId: 'unknown_ns' }),
    ).toContainEqual(expect.stringMatching(/namespaceId.*unknown_ns/));
    expect(
      errorsFor({
        ...validRecord(),
        namespaceId: 'preferences',
        schemaVersion: 'none',
      }),
    ).toContainEqual(expect.stringMatching(/required_before_flip/));
  });

  it('requires the row schemaVersion', () => {
    expect(errorsFor({ ...validRecord(), schemaVersion: 2 })).toContainEqual(
      expect.stringMatching(/schemaVersion/),
    );
    expect(errorsFor({ ...validRecord(), schemaVersion: '1' })).toContainEqual(
      expect.stringMatching(/schemaVersion/),
    );
  });

  it('requires a nonblank source revision and rollback migration', () => {
    expect(errorsFor({ ...validRecord(), sourceRevision: '  ' })).toEqual([
      expect.stringMatching(/sourceRevision/),
    ]);
    expect(errorsFor({ ...validRecord(), rollbackMigration: '' })).toEqual([
      expect.stringMatching(/rollbackMigration/),
    ]);
  });

  it.each([
    '2026-10-08',
    '2026-10-08T09:00:00',
    '2026-02-30T09:00:00Z',
    '2026-10-08T24:00:00Z',
    'yesterday',
  ])('rejects the date-time %s', (createdAt) => {
    expect(errorsFor({ ...validRecord(), createdAt })).toContainEqual(
      expect.stringMatching(/createdAt/),
    );
  });

  it('rejects a restore test that predates the copy', () => {
    expect(
      errorsFor({
        ...validRecord(),
        restoreTestedAt: '2026-10-08T08:59:59Z',
      }),
    ).toEqual([expect.stringMatching(/restoreTestedAt/)]);
  });

  it.each([
    ['a string', 'sha256:abcd'],
    ['a missing digest', { algorithm: 'sha256' }],
    ['a blank algorithm', { algorithm: ' ', digest: 'abcd' }],
    ['a padded digest', { algorithm: 'sha256', digest: ' abcd' }],
  ])('rejects verifiedBy as %s', (_label, verifiedBy) => {
    expect(errorsFor({ ...validRecord(), verifiedBy })).toEqual([
      expect.stringMatching(/verifiedBy/),
    ]);
  });

  it.each([
    '',
    '/var/canopy/backups/index.json',
    'C:\\canopy\\backups\\index.json',
    'C:/canopy/backups/index.json',
    'C:backups',
    '\\\\server\\share\\index.json',
    '\\backups\\index.json',
    '..',
    'backups/../../index.json',
    'backups\\..\\index.json',
    './backups/index.json',
    'backups//index.json',
    'backups/',
    'backups/.. /index.json',
    'backups/.../index.json',
    'backups/index.json\u0000.bak',
  ])('rejects the unsafe backupPath %j', (backupPath) => {
    const isOutsideCheckouts = jest.fn(() => true);
    expect(
      errorsFor(
        { ...validRecord(), backupPath },
        { rows: ROWS, isOutsideCheckouts },
      ),
    ).toEqual([expect.stringMatching(/backupPath/)]);
    expect(isOutsideCheckouts).not.toHaveBeenCalled();
  });

  it('requires the trusted host to place backupPath outside every checkout', () => {
    const isOutsideCheckouts = jest.fn(() => false);
    expect(
      errorsFor(validRecord(), { rows: ROWS, isOutsideCheckouts }),
    ).toEqual([expect.stringMatching(/backupPath.*checkout/)]);
    expect(isOutsideCheckouts).toHaveBeenCalledWith(
      'backups/w5/workspace_index/index.json',
    );
  });

  it('fails closed when the checkout predicate throws', () => {
    const isOutsideCheckouts = (): boolean => {
      throw new Error('checkout registry unavailable');
    };
    expect(
      errorsFor(validRecord(), { rows: ROWS, isOutsideCheckouts }),
    ).toEqual([expect.stringMatching(/backupPath.*checkout/)]);
  });

  it('does not infer checkout placement from path names', () => {
    const record = {
      ...validRecord(),
      backupPath: 'workspaces/acme/worktrees/main/backup.json',
    };
    expect(errorsFor(record)).toEqual([]);
  });
});

describe('createNamespaceBackupRecord', () => {
  it('returns a frozen copy that shares nothing with its input', () => {
    const input = validRecord();
    const record = createNamespaceBackupRecord(input, CONTEXT);
    expect(record).toEqual(input);
    expect(Object.isFrozen(record)).toBe(true);
    expect(Object.isFrozen(record.verifiedBy)).toBe(true);
    expect(record.verifiedBy).not.toBe(input.verifiedBy);
  });

  it('keeps only schema fields', () => {
    const input = {
      ...validRecord(),
      verified: true,
      verifiedBy: { algorithm: 'sha256', digest: 'ab'.repeat(32), ok: true },
    };
    expect(createNamespaceBackupRecord(input, CONTEXT)).toEqual(validRecord());
  });

  it('throws every validation error for an invalid record', () => {
    let caught: unknown;
    try {
      createNamespaceBackupRecord(
        { ...validRecord(), backupPath: '/abs', rollbackMigration: '' },
        CONTEXT,
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(NamespaceBackupRecordError);
    expect(caught).toMatchObject({
      errors: [
        expect.stringMatching(/backupPath/),
        expect.stringMatching(/rollbackMigration/),
      ],
    });
  });
});
