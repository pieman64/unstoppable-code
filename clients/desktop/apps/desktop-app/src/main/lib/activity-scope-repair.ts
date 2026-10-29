// ---------------------------------------------------------------------------
// Repair of activity uploaded under the wrong scope before CAN-3515
// (CAN-3517).
//
// Before CAN-3515 the sidebar selection chose where activity was uploaded, so
// some organization-project work landed as the member's private rows and some
// Personal work landed in an organization. The desktop is the authority on who
// owns each local workspace, so once per workspace after upgrade the startup
// sweep asks the server to move the member's rows to where they belong; the
// server verifies everything before it moves anything and records every move.
//
// This module holds the pure decisions and the device-local ledger that makes
// the repair run once per workspace. The coordinator
// (`org-project-materialization.ts`) drives it.
// ---------------------------------------------------------------------------

import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type {
  WorkspaceOwnerBinding,
  WorkspaceOwnershipTransfer,
} from '@canopy/desktop-shared/types';
import { CanopyCloudClientError } from '../canopy-cloud/client';
import { writeFileAtomically } from './atomic-file';

/** What the sweep does for one workspace's already-uploaded activity. */
export type ActivityRepairTarget =
  /**
   * Converted into its current project (CAN-3418): the project's past moves
   * with it, retried on every launch until the server has it.
   */
  | { kind: 'converted'; projectId: string }
  /** Bound to an organization project: move its private rows there. */
  | {
      kind: 'organization';
      organizationId: string;
      projectId: string;
      key: string;
    }
  /** Personal: return its rows filed in an organization. */
  | { kind: 'personal'; key: 'personal' };

/**
 * The repair a workspace needs, from its authoritative ownership, or `null`
 * for none. A workspace moved back to Personal is skipped: while it was
 * bound, its organization rows were that project's, and the move back already
 * returned its recorded past.
 */
export function activityRepairTarget(ownership: {
  owner?: WorkspaceOwnerBinding;
  ownershipTransfer?: WorkspaceOwnershipTransfer;
}): ActivityRepairTarget | null {
  const { owner, ownershipTransfer } = ownership;
  if (owner !== undefined) {
    if (
      ownershipTransfer !== undefined &&
      ownershipTransfer.movedBackAt === undefined &&
      ownershipTransfer.projectId === owner.projectId
    ) {
      return { kind: 'converted', projectId: owner.projectId };
    }
    return {
      kind: 'organization',
      organizationId: owner.organizationId,
      projectId: owner.projectId,
      key: `organization:${owner.organizationId}:${owner.projectId}`,
    };
  }
  if (ownershipTransfer !== undefined) return null;
  return { kind: 'personal', key: 'personal' };
}

/**
 * Server refusals no later launch can change; anything else (offline, a
 * server without the route, rate limits, a transient conflict, an instance
 * not READY yet) is retried on the next launch.
 */
const TERMINAL_REFUSALS = new Set([
  'forbidden',
  'invalid_request',
  'not_personal',
  'source_project_conflict',
  'repository_mismatch',
  'scope_prohibited',
  'body_unreadable',
]);

export function classifyActivityRepairFailure(
  error: unknown,
): 'retry' | `refused-${string}` {
  if (!(error instanceof CanopyCloudClientError)) return 'retry';
  if (error.status === 400) return 'refused-invalid_request';
  const code = error.serverCode ?? '';
  return TERMINAL_REFUSALS.has(code) ? `refused-${code}` : 'retry';
}

// ===========================================================================
// Ledger: `activity-scope-repair.json` in the data directory.
// ===========================================================================

/** The repair recorded for one workspace. */
export interface ActivityRepairRecord {
  /**
   * The ownership the repair ran for: `personal`, or
   * `organization:<organization id>:<project id>`. A workspace whose
   * ownership changed since is repaired again for its new owner.
   */
  target: string;
  /** Server outcome, `kept-private`, or `refused-<code>`. */
  outcome: string;
  at: string;
}

export interface ActivityRepairLedgerFile {
  version: 1;
  byAccount: Record<string, Record<string, ActivityRepairRecord>>;
}

const ACCOUNT_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
const WORKSPACE_ID = /^[a-z0-9][a-z0-9-]*$/;
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_FIELD_LENGTH = 256;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isField(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_FIELD_LENGTH;
}

function normalizeRecord(value: unknown): ActivityRepairRecord | null {
  if (
    !isRecord(value) ||
    !isField(value.target) ||
    !isField(value.outcome) ||
    !isField(value.at)
  )
    return null;
  return { target: value.target, outcome: value.outcome, at: value.at };
}

export function normalizeActivityRepairLedger(
  value: unknown,
): ActivityRepairLedgerFile {
  const byAccount: ActivityRepairLedgerFile['byAccount'] = {};
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.byAccount)) {
    return { version: 1, byAccount };
  }
  for (const [accountId, entries] of Object.entries(value.byAccount)) {
    if (
      !ACCOUNT_ID.test(accountId) ||
      RESERVED_KEYS.has(accountId) ||
      !isRecord(entries)
    )
      continue;
    const records: Record<string, ActivityRepairRecord> = {};
    for (const [workspaceId, entry] of Object.entries(entries)) {
      const record = normalizeRecord(entry);
      if (WORKSPACE_ID.test(workspaceId) && record !== null) {
        records[workspaceId] = record;
      }
    }
    if (Object.keys(records).length > 0) byAccount[accountId] = records;
  }
  return { version: 1, byAccount };
}

export interface ActivityRepairLedger {
  /** The account's records by workspace id; empty when none or unreadable. */
  read(accountId: string): Promise<Record<string, ActivityRepairRecord>>;
  record(
    accountId: string,
    workspaceId: string,
    record: ActivityRepairRecord,
  ): Promise<void>;
}

/**
 * The ledger that makes the repair run once per workspace. A missing or
 * corrupt file reads as empty: repeating a repair is safe, since the server
 * answers a replay with nothing to move.
 */
export function createActivityRepairLedger(
  filePath: () => string,
): ActivityRepairLedger {
  let pending: Promise<void> = Promise.resolve();
  async function load(): Promise<ActivityRepairLedgerFile> {
    try {
      return normalizeActivityRepairLedger(
        JSON.parse(await readFile(filePath(), 'utf8')),
      );
    } catch {
      return { version: 1, byAccount: {} };
    }
  }
  return {
    async read(accountId): Promise<Record<string, ActivityRepairRecord>> {
      await pending;
      return (await load()).byAccount[accountId] ?? {};
    },
    record(accountId, workspaceId, record): Promise<void> {
      const operation = pending.then(async (): Promise<void> => {
        const file = await load();
        const next = normalizeActivityRepairLedger({
          version: 1,
          byAccount: {
            ...file.byAccount,
            [accountId]: {
              ...file.byAccount[accountId],
              [workspaceId]: record,
            },
          },
        });
        const path = filePath();
        await mkdir(dirname(path), { recursive: true });
        await writeFileAtomically(path, JSON.stringify(next), { mode: 0o600 });
      });
      pending = operation.catch((): void => {});
      return operation;
    },
  };
}
