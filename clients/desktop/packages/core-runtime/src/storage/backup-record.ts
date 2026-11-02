import type {
  StorageOwnershipRow,
  StorageSchemaVersion,
} from './writer-authority';

export interface StorageDigestEvidence {
  readonly algorithm: string;
  readonly digest: string;
}

export interface NamespaceBackupRecord {
  readonly namespaceId: string;
  readonly backupPath: string;
  readonly sourceRevision: string;
  readonly schemaVersion: StorageSchemaVersion;
  readonly createdAt: string;
  readonly verifiedBy: StorageDigestEvidence;
  readonly rollbackMigration: string;
  readonly restoreTestedAt: string;
}

export interface NamespaceBackupValidationContext {
  readonly rows: readonly StorageOwnershipRow[];
  readonly isOutsideCheckouts: (dataRootRelativePath: string) => boolean;
}

export type NamespaceBackupValidation =
  | { readonly ok: true; readonly record: NamespaceBackupRecord }
  | { readonly ok: false; readonly errors: readonly string[] };

export class NamespaceBackupRecordError extends Error {
  public readonly errors: readonly string[];

  public constructor(errors: readonly string[]) {
    super(`Invalid namespace_backup record: ${errors.join('; ')}`);
    this.name = 'NamespaceBackupRecordError';
    this.errors = errors;
  }
}

type Fields = Readonly<Record<string, unknown>>;

const DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/i;

function isFields(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUntrimmedToken(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && value === value.trim();
}

function nonblank(
  fields: Fields,
  field: string,
  errors: string[],
): string | undefined {
  const value = fields[field];
  if (value === undefined) errors.push(`${field} is required`);
  else if (typeof value !== 'string' || value.trim() === '')
    errors.push(`${field} must be a nonblank string`);
  else return value;
  return undefined;
}

/** Epoch milliseconds of an RFC 3339 date-time, or undefined if invalid. */
function instant(value: string): number | undefined {
  const match = DATE_TIME.exec(value);
  if (!match) return undefined;
  const [year, month, day, hour, minute, second] = match
    .slice(1, 7)
    .map(Number);
  const utc = new Date(0);
  utc.setUTCFullYear(year, month - 1, day);
  utc.setUTCHours(hour, minute, second, 0);
  if (
    utc.getUTCFullYear() !== year ||
    utc.getUTCMonth() !== month - 1 ||
    utc.getUTCDate() !== day ||
    utc.getUTCHours() !== hour ||
    utc.getUTCMinutes() !== minute ||
    utc.getUTCSeconds() !== second
  )
    return undefined;
  const [, , , , , , , fraction, sign, offsetHours, offsetMinutes] = match;
  let offset = 0;
  if (sign !== undefined) {
    if (Number(offsetHours) > 23 || Number(offsetMinutes) > 59)
      return undefined;
    offset =
      (sign === '-' ? -1 : 1) *
      (Number(offsetHours) * 60 + Number(offsetMinutes));
  }
  const millis = fraction === undefined ? 0 : Number(`0${fraction}`) * 1000;
  return utc.getTime() + millis - offset * 60_000;
}

function dateTime(
  fields: Fields,
  field: string,
  errors: string[],
): { readonly text: string; readonly at: number } | undefined {
  const text = nonblank(fields, field, errors);
  if (text === undefined) return undefined;
  const at = instant(text);
  if (at === undefined) {
    errors.push(`${field} must be an RFC 3339 date-time with a time zone`);
    return undefined;
  }
  return { text, at };
}

/**
 * Data-root-relative, slash-separated, normalized. Backslashes and colons are
 * refused outright so Windows drive, UNC, and stream forms cannot slip through.
 * Win32 strips trailing dots and spaces, so `.. ` would traverse there; any
 * segment ending in either is refused, which also covers `.` and `..`.
 */
function backupPathError(path: string): string | undefined {
  if (path.includes('\0')) return 'backupPath must not contain NUL';
  if (path.includes('\\') || path.includes(':'))
    return 'backupPath must not contain backslashes or colons';
  if (path.startsWith('/')) return 'backupPath must be data-root-relative';
  if (
    path.split('/').some((segment) => segment === '' || /[. ]$/.test(segment))
  )
    return 'backupPath segments must be nonempty and not end in "." or a space';
  return undefined;
}

function provenOutsideCheckouts(
  path: string,
  isOutsideCheckouts: NamespaceBackupValidationContext['isOutsideCheckouts'],
): boolean {
  try {
    return isOutsideCheckouts(path) === true;
  } catch {
    return false;
  }
}

/**
 * Why a backup path is unusable, or undefined when it is a normalized
 * data-root-relative path proven outside every checkout. Writers check it
 * before touching the file system.
 */
export function namespaceBackupPathError(
  path: string,
  isOutsideCheckouts: NamespaceBackupValidationContext['isOutsideCheckouts'],
): string | undefined {
  const pathError = backupPathError(path);
  if (pathError !== undefined) return pathError;
  if (!provenOutsideCheckouts(path, isOutsideCheckouts))
    return 'backupPath must be proven outside every checkout';
  return undefined;
}

/**
 * Validates a namespace_backup record against the schema and the namespace's
 * ownership row. Shape only: it neither reads the copy nor checks its digest.
 */
export function validateNamespaceBackupRecord(
  candidate: unknown,
  context: NamespaceBackupValidationContext,
): NamespaceBackupValidation {
  if (!isFields(candidate))
    return { ok: false, errors: ['namespace_backup must be an object'] };
  const errors: string[] = [];

  const namespaceId = nonblank(candidate, 'namespaceId', errors);
  const rows = context.rows.filter((row) => row.id === namespaceId);
  const row = rows.length === 1 ? rows[0] : undefined;
  if (namespaceId !== undefined) {
    if (row === undefined)
      errors.push(`namespaceId ${namespaceId} names no unique storage row`);
    else if (
      row.backupPolicy !== 'required_before_flip' ||
      row.backupShape !== 'namespace_backup'
    )
      errors.push(
        `namespaceId ${namespaceId} is not a required_before_flip namespace_backup row`,
      );
  }

  const backupPath = nonblank(candidate, 'backupPath', errors);
  if (backupPath !== undefined) {
    const pathError = namespaceBackupPathError(
      backupPath,
      context.isOutsideCheckouts,
    );
    if (pathError !== undefined) errors.push(pathError);
  }

  const sourceRevision = nonblank(candidate, 'sourceRevision', errors);

  const schemaVersion = candidate.schemaVersion;
  if (schemaVersion === undefined) errors.push('schemaVersion is required');
  else if (row !== undefined && schemaVersion !== row.schemaVersion)
    errors.push(
      `schemaVersion must equal the row schemaVersion ${row.schemaVersion}`,
    );
  const validSchemaVersion =
    schemaVersion === 'none' ||
    (typeof schemaVersion === 'number' &&
      Number.isInteger(schemaVersion) &&
      schemaVersion > 0)
      ? schemaVersion
      : undefined;
  if (schemaVersion !== undefined && validSchemaVersion === undefined)
    errors.push('schemaVersion must be a positive integer or none');

  const createdAt = dateTime(candidate, 'createdAt', errors);

  const evidence = candidate.verifiedBy;
  let verifiedBy: StorageDigestEvidence | undefined;
  if (evidence === undefined) errors.push('verifiedBy is required');
  else if (
    isFields(evidence) &&
    isUntrimmedToken(evidence.algorithm) &&
    isUntrimmedToken(evidence.digest)
  )
    verifiedBy = Object.freeze({
      algorithm: evidence.algorithm,
      digest: evidence.digest,
    });
  else
    errors.push(
      'verifiedBy must be an object with nonblank algorithm and digest strings',
    );

  const rollbackMigration = nonblank(candidate, 'rollbackMigration', errors);

  const restoreTestedAt = dateTime(candidate, 'restoreTestedAt', errors);
  if (
    createdAt !== undefined &&
    restoreTestedAt !== undefined &&
    restoreTestedAt.at < createdAt.at
  )
    errors.push('restoreTestedAt must not precede createdAt');

  if (
    errors.length > 0 ||
    namespaceId === undefined ||
    backupPath === undefined ||
    sourceRevision === undefined ||
    validSchemaVersion === undefined ||
    createdAt === undefined ||
    verifiedBy === undefined ||
    rollbackMigration === undefined ||
    restoreTestedAt === undefined
  )
    return { ok: false, errors };
  return {
    ok: true,
    record: Object.freeze({
      namespaceId,
      backupPath,
      sourceRevision,
      schemaVersion: validSchemaVersion,
      createdAt: createdAt.text,
      verifiedBy,
      rollbackMigration,
      restoreTestedAt: restoreTestedAt.text,
    }),
  };
}

/** Returns a frozen, validated copy of `input`; throws on any violation. */
export function createNamespaceBackupRecord(
  input: NamespaceBackupRecord,
  context: NamespaceBackupValidationContext,
): NamespaceBackupRecord {
  const result = validateNamespaceBackupRecord(input, context);
  if (!result.ok) throw new NamespaceBackupRecordError(result.errors);
  return result.record;
}
