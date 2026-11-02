export const LEGACY_STORAGE_WRITERS = [
  'electron_main',
  'desktop_cli',
  'renderer',
  'utility_process',
  'provider_native',
] as const;
export const STORAGE_WRITER_PRINCIPALS = [
  ...LEGACY_STORAGE_WRITERS,
  'daemon',
] as const;

export type LegacyStorageWriter = (typeof LEGACY_STORAGE_WRITERS)[number];
export type StorageWriterPrincipal = (typeof STORAGE_WRITER_PRINCIPALS)[number];
export type StorageTransitionOwner =
  | 'legacy'
  | 'daemon'
  | 'offline'
  | 'interface-local';
export type StorageBackupPolicy = 'none' | 'required_before_flip';
export type StorageBackupShape = 'namespace_backup' | 'owner_flip';
export type StorageSchemaVersion = number | 'none';

export interface StorageOwnershipRow<Id extends string = string> {
  readonly id: Id;
  readonly transitionOwner: StorageTransitionOwner;
  readonly currentWriters: readonly StorageWriterPrincipal[];
  readonly schemaVersion: StorageSchemaVersion;
  readonly backupPolicy: StorageBackupPolicy;
  readonly workPackage?: string;
  readonly backupShape?: StorageBackupShape;
  readonly plane?: 'core' | 'worker';
  /**
   * The only source modules that may write the row (abbreviated as in the
   * manifest). Enforced by the ownership census, the admitted-writers lint
   * and, for writes through the shared writer, `evaluateAdmittedWriter`.
   */
  readonly admittedWriters?: readonly string[];
}

export type StorageWriteRefusalReason =
  | 'invalid_writer'
  | 'unknown_namespace'
  | 'ambiguous_namespace'
  | 'daemon_owned'
  | 'offline'
  | 'unlisted_writer'
  | 'unadmitted_writer'
  | 'invalid_row';

export type StorageWriteDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: StorageWriteRefusalReason };

export class StorageWriteRefusedError extends Error {
  public readonly namespaceId: string;
  public readonly writer: string;
  public readonly reason: StorageWriteRefusalReason;

  public constructor(
    namespaceId: string,
    writer: string,
    reason: StorageWriteRefusalReason,
  ) {
    super(`Storage write to ${namespaceId} by ${writer} refused: ${reason}`);
    this.name = 'StorageWriteRefusedError';
    this.namespaceId = namespaceId;
    this.writer = writer;
    this.reason = reason;
  }
}

const PRINCIPALS: ReadonlySet<string> = new Set(STORAGE_WRITER_PRINCIPALS);
const ALLOWED: StorageWriteDecision = Object.freeze({ allowed: true });

function refuse(reason: StorageWriteRefusalReason): StorageWriteDecision {
  return { allowed: false, reason };
}

/**
 * Decides a write from the supplied ownership rows alone; the caller names
 * its principal explicitly. Unknown namespaces and principals fail closed.
 * `offline` refuses every writer, the daemon included, until a maintenance
 * lock principal exists; revisit when that authority lands.
 */
export function evaluateStorageWrite<Id extends string>(
  namespaceId: NoInfer<Id>,
  writer: StorageWriterPrincipal,
  rows: readonly StorageOwnershipRow<Id>[],
): StorageWriteDecision {
  if (!PRINCIPALS.has(writer)) return refuse('invalid_writer');
  const matches = rows.filter((row) => row.id === namespaceId);
  const row = matches[0];
  if (row === undefined) return refuse('unknown_namespace');
  if (matches.length > 1) return refuse('ambiguous_namespace');
  switch (row.transitionOwner) {
    case 'daemon':
      return writer === 'daemon' ? ALLOWED : refuse('daemon_owned');
    case 'offline':
      return refuse('offline');
    case 'legacy':
    case 'interface-local':
      return writer !== 'daemon' && row.currentWriters.includes(writer)
        ? ALLOWED
        : refuse('unlisted_writer');
    default:
      return refuse('invalid_row');
  }
}

export function assertStorageWriteAllowed<Id extends string>(
  namespaceId: NoInfer<Id>,
  writer: StorageWriterPrincipal,
  rows: readonly StorageOwnershipRow<Id>[],
): void {
  const decision = evaluateStorageWrite(namespaceId, writer, rows);
  if (!decision.allowed)
    throw new StorageWriteRefusedError(namespaceId, writer, decision.reason);
}

/**
 * The principal decision plus, for a row that names `admittedWriters`, the
 * writer module. `module` is self-declared, like the principal: it refuses
 * an accidental writer, not code that forges another module's name.
 */
export function evaluateAdmittedWriter<Id extends string>(
  namespaceId: NoInfer<Id>,
  writer: StorageWriterPrincipal,
  module: string | undefined,
  rows: readonly StorageOwnershipRow<Id>[],
): StorageWriteDecision {
  const decision = evaluateStorageWrite(namespaceId, writer, rows);
  if (!decision.allowed) return decision;
  const admitted = rows.find((row) => row.id === namespaceId)?.admittedWriters;
  if (admitted === undefined) return ALLOWED;
  return module !== undefined && admitted.includes(module)
    ? ALLOWED
    : refuse('unadmitted_writer');
}

export function assertAdmittedWriter<Id extends string>(
  namespaceId: NoInfer<Id>,
  writer: StorageWriterPrincipal,
  module: string | undefined,
  rows: readonly StorageOwnershipRow<Id>[],
): void {
  const decision = evaluateAdmittedWriter(namespaceId, writer, module, rows);
  if (!decision.allowed)
    throw new StorageWriteRefusedError(
      namespaceId,
      module === undefined ? writer : `${writer} (${module})`,
      decision.reason,
    );
}
