import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { syncDirectory, writeFileAtomically } from '../lib/atomic-file';
import { isE2eBuild } from '../lib/e2e-gate';
import { getCopilotCredentialFilePath } from '../lib/paths';
import type { SecureStorageFailure } from '@canopy/execution-engine/types/secure-storage';
import {
  getSecretStoragePolicy,
  getSecureStorageFailure,
} from '../lib/secure-storage-policy';

/** The whole GitHub App grant; the refresh token is the long-lived secret. */
export interface CopilotGrant {
  clientId: string;
  host: string;
  login: string;
  id: string;
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  refreshTokenExpiresAt: string;
}

/** One stored revision of an entry. */
export interface CopilotCredentialRevision {
  /** Minted when the entry is created and never reissued. */
  entryId: string;
  /** 1 at creation; each replacement increments it. */
  revision: number;
}

/**
 * The stored grant. The identity fields are additive under `version: 1`, so
 * older builds still parse the record and drop them.
 */
export interface CopilotCredential
  extends CopilotGrant, CopilotCredentialRevision {
  version: 1;
}

export type CopilotCredentialRead =
  | { status: 'present'; credential: CopilotCredential }
  | { status: 'absent' }
  | { status: 'unreadable'; secureStorageFailure?: SecureStorageFailure };

/** `conflict`: the store no longer holds the expected revision. */
export type CopilotCredentialReplace =
  | { status: 'written'; credential: CopilotCredential }
  | { status: 'conflict' }
  | { status: 'unreadable'; secureStorageFailure?: SecureStorageFailure };

export type CopilotCredentialDelete =
  | { status: 'deleted' }
  | { status: 'conflict' }
  | { status: 'unreadable'; secureStorageFailure?: SecureStorageFailure };

type DiskRead =
  | CopilotCredentialRead
  | { status: 'legacy'; grant: CopilotGrant; digest: string };

const STORAGE_UNAVAILABLE =
  "Couldn't store the Copilot sign-in on this device.";

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function parseGrant(value: unknown): CopilotGrant | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return null;
  const record: Record<string, unknown> = { ...value };
  const text = (key: string): string | null => {
    const field = record[key];
    return typeof field === 'string' && field ? field : null;
  };
  const clientId = text('clientId');
  const host = text('host');
  const login = text('login');
  const id = text('id');
  const accessToken = text('accessToken');
  const refreshToken = text('refreshToken');
  if (
    record.version !== 1 ||
    !clientId ||
    !host ||
    !login ||
    !id ||
    !accessToken ||
    !refreshToken ||
    !isIsoDate(record.accessTokenExpiresAt) ||
    !isIsoDate(record.refreshTokenExpiresAt)
  )
    return null;
  return {
    clientId,
    host,
    login,
    id,
    accessToken,
    accessTokenExpiresAt: record.accessTokenExpiresAt,
    refreshToken,
    refreshTokenExpiresAt: record.refreshTokenExpiresAt,
  };
}

/** A record without a valid identity is legacy and is adopted on load. */
function parseRevision(value: unknown): CopilotCredentialRevision | null {
  if (typeof value !== 'object' || value === null) return null;
  const entryId = 'entryId' in value ? value.entryId : undefined;
  const revision = 'revision' in value ? value.revision : undefined;
  if (
    typeof entryId !== 'string' ||
    !/^[0-9a-f]{32}$/.test(entryId) ||
    typeof revision !== 'number' ||
    !Number.isSafeInteger(revision) ||
    revision < 1
  )
    return null;
  return { entryId, revision };
}

/** Builds the stored record from known fields only. */
function credentialOf(
  grant: CopilotGrant,
  revision: CopilotCredentialRevision,
): CopilotCredential {
  return {
    version: 1,
    clientId: grant.clientId,
    host: grant.host,
    login: grant.login,
    id: grant.id,
    accessToken: grant.accessToken,
    accessTokenExpiresAt: grant.accessTokenExpiresAt,
    refreshToken: grant.refreshToken,
    refreshTokenExpiresAt: grant.refreshTokenExpiresAt,
    entryId: revision.entryId,
    revision: revision.revision,
  };
}

function sameRevision(
  left: CopilotCredentialRevision,
  right: CopilotCredentialRevision,
): boolean {
  return left.entryId === right.entryId && left.revision === right.revision;
}

function mintEntryId(): string {
  return randomBytes(16).toString('hex');
}

export function isCopilotCredentialStorageAvailable(): boolean {
  return getSecretStoragePolicy().isWriteAvailable();
}

// An adoption that could not be saved keeps its identity for the same bytes,
// so this process presents one stable entry until a write lands.
let unsavedAdoption:
  | { digest: string; revision: CopilotCredentialRevision }
  | undefined;

function isMissing(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

async function readFromDisk(): Promise<DiskRead> {
  const safeStorage = getSecretStoragePolicy();
  let raw: Buffer;
  try {
    raw = await readFile(getCopilotCredentialFilePath());
  } catch (error) {
    return isMissing(error) ? { status: 'absent' } : { status: 'unreadable' };
  }
  try {
    const parsed: unknown = JSON.parse(safeStorage.decrypt(raw));
    const grant = parseGrant(parsed);
    if (!grant) return { status: 'unreadable' };
    const revision = parseRevision(parsed);
    if (revision)
      return { status: 'present', credential: credentialOf(grant, revision) };
    return {
      status: 'legacy',
      grant,
      digest: createHash('sha256').update(raw).digest('hex'),
    };
  } catch (error) {
    const secureStorageFailure = getSecureStorageFailure(error);
    return {
      status: 'unreadable',
      ...(secureStorageFailure ? { secureStorageFailure } : {}),
    };
  }
}

async function install(credential: CopilotCredential): Promise<void> {
  const safeStorage = getSecretStoragePolicy();
  const filePath = getCopilotCredentialFilePath();
  try {
    safeStorage.assertCanWrite();
    const encrypted = safeStorage.encrypt(JSON.stringify(credential));
    await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
    safeStorage.assertCanWrite();
    await writeFileAtomically(filePath, encrypted, {
      mode: 0o600,
      durable: true,
    });
  } catch (error) {
    const secureStorageFailure = getSecureStorageFailure(error);
    if (secureStorageFailure)
      throw Object.assign(new Error(STORAGE_UNAVAILABLE), {
        secureStorageFailure,
      });
    throw error;
  }
}

async function remove(): Promise<void> {
  const filePath = getCopilotCredentialFilePath();
  await rm(filePath, { force: true });
  try {
    await syncDirectory(dirname(filePath));
  } catch (error) {
    // No directory means no entry left to make durable.
    if (!isMissing(error)) throw error;
  }
  unsavedAdoption = undefined;
}

// Compare-and-swap holds while this process is the only writer, which the
// single-instance lock guarantees: every mutation re-reads under this queue.
let queue: Promise<unknown> = Promise.resolve();
function serialized<T>(operation: () => Promise<T>): Promise<T> {
  const run = queue.then(operation, operation);
  queue = run.catch(() => undefined);
  return run;
}

async function readAdopting(): Promise<CopilotCredentialRead> {
  const read = await readFromDisk();
  if (read.status !== 'legacy') return read;
  const revision =
    unsavedAdoption?.digest === read.digest
      ? unsavedAdoption.revision
      : { entryId: mintEntryId(), revision: 1 };
  const credential = credentialOf(read.grant, revision);
  try {
    await install(credential);
    unsavedAdoption = undefined;
  } catch {
    unsavedAdoption = { digest: read.digest, revision };
  }
  return { status: 'present', credential };
}

async function readStored(): Promise<CopilotCredentialRead> {
  const read = await readFromDisk();
  if (read.status !== 'legacy') return read;
  return serialized(readAdopting);
}

let e2eSeedApplied = false;

/**
 * E2E builds may seed a connected state; production folds this branch away.
 * The seed applies once per process so a later sign-out stays signed out.
 */
async function seedFromE2eEnvironment(): Promise<boolean> {
  if (!isE2eBuild() || e2eSeedApplied) return false;
  e2eSeedApplied = true;
  const raw = process.env.CANOPY_E2E_COPILOT_CREDENTIAL?.trim();
  if (!raw) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  const grant = parseGrant(parsed);
  if (!grant) return false;
  await createCopilotCredential(grant);
  return true;
}

export async function readCopilotCredential(): Promise<CopilotCredentialRead> {
  const first = await readStored();
  if (first.status !== 'absent') return first;
  if (await seedFromE2eEnvironment()) return readStored();
  return first;
}

/** Creates a new entry in place of whatever is stored. */
export function createCopilotCredential(
  grant: CopilotGrant,
): Promise<CopilotCredential> {
  return serialized(async () => {
    const credential = credentialOf(grant, {
      entryId: mintEntryId(),
      revision: 1,
    });
    await install(credential);
    unsavedAdoption = undefined;
    return credential;
  });
}

/**
 * Replaces the entry only while it is still at `expected`. Retrying a
 * replacement that already landed, such as one whose directory sync failed,
 * syncs the directory again and reports it written.
 */
export function replaceCopilotCredential(
  expected: CopilotCredentialRevision,
  grant: CopilotGrant,
): Promise<CopilotCredentialReplace> {
  return serialized(async () => {
    const read = await readAdopting();
    if (read.status === 'unreadable') return read;
    if (read.status === 'absent') return { status: 'conflict' };
    const next = { entryId: expected.entryId, revision: expected.revision + 1 };
    const credential = credentialOf(grant, next);
    if (
      sameRevision(read.credential, next) &&
      JSON.stringify(read.credential) === JSON.stringify(credential)
    ) {
      // The file was synced before its rename; only the rename can be lost.
      await syncDirectory(dirname(getCopilotCredentialFilePath()));
      return { status: 'written', credential: read.credential };
    }
    if (!sameRevision(read.credential, expected)) return { status: 'conflict' };
    await install(credential);
    return { status: 'written', credential };
  });
}

/**
 * Deletes the entry only while it is still `expected.entryId` and, when
 * given, at `expected.revision`.
 */
export function deleteCopilotCredential(expected: {
  entryId: string;
  revision?: number;
}): Promise<CopilotCredentialDelete> {
  return serialized(async () => {
    const read = await readAdopting();
    if (read.status === 'unreadable') return read;
    if (
      read.status === 'absent' ||
      read.credential.entryId !== expected.entryId ||
      (expected.revision !== undefined &&
        read.credential.revision !== expected.revision)
    )
      return { status: 'conflict' };
    await remove();
    return { status: 'deleted' };
  });
}

/**
 * Deletes the latest revision, readable or not. It queues behind any
 * compare-and-swap write, so a write that started first cannot land after it.
 */
export function clearCopilotCredential(): Promise<void> {
  return serialized(remove);
}
