import { inspect } from 'node:util';
import {
  LocalDelegationCleanupError,
  type LocalDelegationCleanupDiagnostic,
  type LocalDelegationCleanupResource,
} from '@canopy/desktop-shared/node/delegation/cleanup-diagnostics';

/** Planted in every rejected cleanup value; no log argument may contain it. */
export const CLEANUP_CANARY = 'CANARY_SECRET_VALUE';

const CLEANUP_MESSAGE = '[delegation] Local cleanup failed';
const MAX_RECORD_BYTES = 4096;
const SENSITIVE =
  /CANARY_SECRET_VALUE|sk-ant-|\/Users\/|\/tmp\/|\/var\/|:delegated:|reload-|project\/worktree/;

export const CLEANUP_RESOURCES = {
  approval: { label: 'approval-session', phase: 'preparation' },
  background: { label: 'background-task-dir', phase: 'preparation' },
  overlay: { label: 'capability-overlay', phase: 'capability', preparation: 0 },
  temporary: { label: 'claude-temp-dir', phase: 'preparation' },
  detach: { label: 'delegation-detach', phase: 'parent' },
  ledger: { label: 'ledger-tools', phase: 'parent' },
  mcp: { label: 'mcp-session', phase: 'capability', preparation: 0 },
  native: { label: 'native-process', phase: 'native' },
} satisfies Record<string, LocalDelegationCleanupResource>;

export type ExpectedCleanupFailure = Readonly<Record<string, unknown>>;

/** The expected entry for a callback retained with `resource`, or unlabelled. */
export function failure(
  resource: LocalDelegationCleanupResource | undefined,
  settlement: 'threw' | 'rejected' | 'pending',
  fields: Readonly<Record<string, string>> = {},
): ExpectedCleanupFailure {
  const unlabelled = { label: 'unlabelled', phase: 'unlabelled' };
  return { ...(resource ?? unlabelled), settlement, ...fields };
}

/** The fields of a rejected Error with a listed (or `other`) name and code. */
export function errorFields(
  errorName: string,
  errorCode?: string,
): Record<string, string> {
  return { valueType: 'error', errorName, ...(errorCode ? { errorCode } : {}) };
}

/** The emitted record, with counts derived from `failures` unless given. */
export function cleanupRecord(fields: {
  readonly failures: readonly ExpectedCleanupFailure[];
  readonly [field: string]: unknown;
}): Record<string, unknown> {
  const labels: Record<string, number> = {};
  for (const { label } of fields.failures)
    if (typeof label === 'string') labels[label] = (labels[label] ?? 0) + 1;
  return {
    harnessId: 'claude',
    runtimeKind: 'claude-sdk',
    // The shared fixture id `delegation-1` is not a UUID.
    delegationId: '<non-uuid>',
    runGeneration: 1,
    attempt: 1,
    outcome: 'rejected',
    retained: fields.failures.length,
    failureCount: fields.failures.length,
    labels,
    omittedFailures: 0,
    ...fields,
  };
}

/**
 * The parsed cleanup records from every `logMainProcessWarn` call, after
 * proving no call carries the canary, a raw cleanup error, or a path/secret.
 */
export function cleanupRecords(warn: {
  readonly mock: { readonly calls: readonly (readonly unknown[])[] };
}): unknown[] {
  const calls = warn.mock.calls;
  const logged = inspect(calls, { depth: null, showHidden: true });
  expect(logged).not.toContain(CLEANUP_CANARY);
  const message: unknown = expect.stringMatching(/remain open|timed out/);
  const rawCleanupError: unknown = expect.objectContaining({ message });
  for (const [, context] of calls) expect(context).not.toEqual(rawCleanupError);
  return calls
    .filter(([message]) => message === CLEANUP_MESSAGE)
    .map(([, context]) => {
      if (typeof context !== 'string')
        throw new Error('A cleanup record must be a string');
      expect(Buffer.byteLength(context)).toBeLessThanOrEqual(MAX_RECORD_BYTES);
      expect(context).not.toMatch(SENSITIVE);
      const record: unknown = JSON.parse(context);
      return record;
    });
}

/**
 * The diagnostic of every reported cleanup error, after proving the error
 * holds no canary and its retained diagnostic no secret or path.
 */
export function reportedCleanupDiagnostics(
  reported: readonly unknown[],
): LocalDelegationCleanupDiagnostic[] {
  return reported
    .filter(
      (error): error is LocalDelegationCleanupError =>
        error instanceof LocalDelegationCleanupError,
    )
    .map((error) => {
      expect(inspect(error, { depth: null, showHidden: true })).not.toContain(
        CLEANUP_CANARY,
      );
      expect(
        inspect(error.diagnostic, { depth: null, showHidden: true }),
      ).not.toMatch(SENSITIVE);
      return error.diagnostic;
    });
}
