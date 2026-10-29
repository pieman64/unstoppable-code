// ---------------------------------------------------------------------------
// One-time automatic conversion pass per organization (hybrid model,
// 2026-10-02).
//
// Automatic conversion (CAN-3416, CAN-3532) moves existing Personal projects
// into the organization that owns their repository once. Each organization
// gets its own pass, started the first time this device sees the member in
// it; only the Personal workspaces that existed then are eligible, and once
// the pass completes nothing is moved into that organization automatically
// again.
//
// This module holds the device-local ledger of those passes. A missing file
// is an empty ledger; any other read failure is `unreadable`, and the caller
// fails closed: restarting every pass from a corrupt file would move projects
// created since.
// ---------------------------------------------------------------------------

import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { writeFileAtomically } from './atomic-file';
import { isErrnoException, isRecord } from './type-guards';

export interface OrgProjectMigrationPass {
  /** ISO time the pass started: first sight of the membership on this device. */
  startedAt: string;
  /** Personal workspaces that existed when the pass started; the only ones it may move. */
  eligibleWorkspaceIds: string[];
  /** ISO time the pass finished; afterwards nothing moves into this organization. */
  completedAt?: string;
}

export interface OrgProjectMigrationPassesFile {
  version: 1;
  /** Keyed by lower-cased organization id. */
  organizations: Record<string, OrgProjectMigrationPass>;
}

export type OrgProjectMigrationPassesRead =
  | { status: 'ok'; file: OrgProjectMigrationPassesFile }
  | { status: 'unreadable' };

export interface OrgProjectMigrationPassStore {
  read(): Promise<OrgProjectMigrationPassesRead>;
  /** Serialized read-modify-write; throws on failure. */
  update(
    change: (
      file: OrgProjectMigrationPassesFile,
    ) => OrgProjectMigrationPassesFile,
  ): Promise<void>;
}

/** The error an update of an unreadable ledger, and its report, carry. */
export const ORG_PROJECT_MIGRATION_PASSES_UNREADABLE =
  'migration-passes-unreadable';

const ID = /^[a-z0-9][a-z0-9-]*$/;
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_ID_LENGTH = 256;
const MAX_TIME_LENGTH = 64;
/** Bounds the file; a device with more Personal workspaces is not expected. */
const MAX_ELIGIBLE_WORKSPACES = 10_000;

function isId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= MAX_ID_LENGTH &&
    ID.test(value) &&
    !RESERVED_KEYS.has(value)
  );
}

function isTime(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= MAX_TIME_LENGTH &&
    !Number.isNaN(Date.parse(value))
  );
}

/** Whether the ledger can hold a pass for this (lower-cased) organization id. */
export function isMigrationPassOrganizationId(organizationId: string): boolean {
  return isId(organizationId);
}

/** Whether the ledger can hold this workspace id in a pass. */
export function isMigrationPassWorkspaceId(workspaceId: string): boolean {
  return isId(workspaceId);
}

function normalizePass(value: unknown): OrgProjectMigrationPass | null {
  if (
    !isRecord(value) ||
    !isTime(value.startedAt) ||
    !Array.isArray(value.eligibleWorkspaceIds) ||
    !value.eligibleWorkspaceIds.every(isId) ||
    (value.completedAt !== undefined && !isTime(value.completedAt))
  )
    return null;
  const eligibleWorkspaceIds = Array.from(new Set(value.eligibleWorkspaceIds));
  if (eligibleWorkspaceIds.length > MAX_ELIGIBLE_WORKSPACES) return null;
  return {
    startedAt: value.startedAt,
    eligibleWorkspaceIds,
    ...(value.completedAt === undefined
      ? {}
      : { completedAt: value.completedAt }),
  };
}

/**
 * The ledger in its version-1 shape, or `null` when anything in it is not.
 * Nothing is dropped: a malformed entry would otherwise start that
 * organization's pass again and move projects created since, so it makes
 * the whole ledger unreadable and the caller fails closed.
 */
export function normalizeOrgProjectMigrationPasses(
  value: unknown,
): OrgProjectMigrationPassesFile | null {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.organizations))
    return null;
  const organizations: OrgProjectMigrationPassesFile['organizations'] = {};
  for (const [rawId, entry] of Object.entries(value.organizations)) {
    const organizationId = rawId.toLowerCase();
    const pass = normalizePass(entry);
    if (!isId(organizationId) || pass === null) return null;
    organizations[organizationId] = pass;
  }
  return { version: 1, organizations };
}

/**
 * The ledger at `filePath()`, written atomically with owner-only permissions.
 * Updates are serialized, and an update never overwrites a file it cannot
 * read.
 */
const writesByPath = new Map<string, Promise<void>>();
export function createOrgProjectMigrationPassStore(
  filePath: () => string,
): OrgProjectMigrationPassStore {
  async function load(): Promise<OrgProjectMigrationPassesRead> {
    let content: string;
    try {
      content = await readFile(filePath(), 'utf8');
    } catch (error) {
      return isErrnoException(error) && error.code === 'ENOENT'
        ? { status: 'ok', file: { version: 1, organizations: {} } }
        : { status: 'unreadable' };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      return { status: 'unreadable' };
    }
    const file = normalizeOrgProjectMigrationPasses(parsed);
    return file === null ? { status: 'unreadable' } : { status: 'ok', file };
  }
  return {
    async read(): Promise<OrgProjectMigrationPassesRead> {
      await writesByPath.get(filePath());
      return load();
    },
    update(change): Promise<void> {
      const path = filePath();
      const operation = (writesByPath.get(path) ?? Promise.resolve()).then(
        async (): Promise<void> => {
          const current = await load();
          if (current.status === 'unreadable')
            throw new Error(ORG_PROJECT_MIGRATION_PASSES_UNREADABLE);
          const next = normalizeOrgProjectMigrationPasses(change(current.file));
          if (next === null)
            throw new Error('Invalid organization project migration passes');
          await mkdir(dirname(path), { recursive: true });
          await writeFileAtomically(path, JSON.stringify(next), {
            mode: 0o600,
          });
        },
      );
      const settled = operation.catch((): void => {});
      writesByPath.set(path, settled);
      void settled.then(() => {
        if (writesByPath.get(path) === settled) writesByPath.delete(path);
      });
      return operation;
    },
  };
}
