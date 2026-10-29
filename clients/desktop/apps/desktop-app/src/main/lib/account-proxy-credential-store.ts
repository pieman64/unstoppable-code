import type { SecureStorageFailure } from '@canopy/desktop-shared/types/secure-storage';
// Secrets for the account proxy, encrypted with Electron safe storage and
// keyed by connection id: the management key the user pasted and, once
// routing exists, the client key this device uses for agent requests.
// Device-only by design; the connection itself is a preference.

import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { writeFileAtomically } from './atomic-file';
import { getAccountProxyCredentialStorePath } from './paths';
import {
  getSecretStoragePolicy,
  getSecureStorageFailure,
  type SecretStoragePolicy,
} from './secure-storage-policy';

interface StoredRecord {
  readonly encryptedManagementKeyBase64: string;
  readonly encryptedClientKeyBase64?: string;
  /** The server rejected this management key; it is not sent again. */
  readonly keyRejection?: AccountProxyKeyRejection;
  readonly updatedAt: string;
}

interface StoredFile {
  readonly version: 1;
  readonly records: Record<string, StoredRecord>;
}

/** Why the server last refused the stored management key, and when. */
export interface AccountProxyKeyRejection {
  readonly code: 'unauthorized' | 'blocked';
  readonly at: number;
}

export interface AccountProxyCredentials {
  readonly managementKey: string;
  readonly clientKey: string | null;
  /** Kept across restarts so a refused key is never sent again unasked. */
  readonly keyRejection?: AccountProxyKeyRejection | null;
}

export class AccountProxyStorageUnavailableError extends Error {
  constructor(readonly secureStorageFailure?: SecureStorageFailure) {
    super('Secure storage unavailable');
    this.name = 'AccountProxyStorageUnavailableError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isKeyRejection(value: unknown): value is AccountProxyKeyRejection {
  return (
    isRecord(value) &&
    (value.code === 'unauthorized' || value.code === 'blocked') &&
    typeof value.at === 'number' &&
    Number.isFinite(value.at)
  );
}

function isStoredRecord(value: unknown): value is StoredRecord {
  return (
    isRecord(value) &&
    typeof value.encryptedManagementKeyBase64 === 'string' &&
    (value.encryptedClientKeyBase64 === undefined ||
      typeof value.encryptedClientKeyBase64 === 'string') &&
    (value.keyRejection === undefined || isKeyRejection(value.keyRejection)) &&
    typeof value.updatedAt === 'string'
  );
}

function availableStorage(): SecretStoragePolicy {
  const policy = getSecretStoragePolicy();
  const run = <T>(operation: () => T): T => {
    try {
      return operation();
    } catch (error) {
      const failure = getSecureStorageFailure(error);
      if (failure) throw new AccountProxyStorageUnavailableError(failure);
      throw error;
    }
  };
  return {
    ...policy,
    assertCanWrite: () => run(() => policy.assertCanWrite()),
    encrypt: (text) => run(() => policy.encrypt(text)),
    decrypt: (ciphertext) => run(() => policy.decrypt(ciphertext)),
  };
}

async function readStore(): Promise<StoredFile> {
  let raw: string;
  try {
    raw = await readFile(getAccountProxyCredentialStorePath(), 'utf8');
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT')
      return { version: 1, records: {} };
    throw error;
  }
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.records))
    throw new Error('Invalid account proxy credential store');
  const records: Record<string, StoredRecord> = {};
  for (const [key, value] of Object.entries(parsed.records)) {
    if (!isStoredRecord(value))
      throw new Error('Invalid account proxy credential record');
    records[key] = value;
  }
  return { version: 1, records };
}

async function writeStore(
  file: StoredFile,
  requiresWrite = false,
): Promise<void> {
  const path = getAccountProxyCredentialStorePath();
  await mkdir(dirname(path), { recursive: true });
  if (requiresWrite) availableStorage().assertCanWrite();
  await writeFileAtomically(path, JSON.stringify(file, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  });
}

let mutationQueue: Promise<void> = Promise.resolve();

function queueMutation(
  mutation: (records: Record<string, StoredRecord>) => void,
  requiresWrite = false,
): Promise<void> {
  const next = mutationQueue.then(async () => {
    const file = await readStore();
    const records = { ...file.records };
    mutation(records);
    await writeStore({ version: 1, records }, requiresWrite);
  });
  mutationQueue = next.catch(() => undefined);
  return next;
}

export async function loadAccountProxyCredentials(
  connectionId: string,
): Promise<AccountProxyCredentials | null> {
  const storage = availableStorage();
  await mutationQueue;
  const record = (await readStore()).records[connectionId];
  if (!record) return null;
  return {
    managementKey: storage.decrypt(
      Buffer.from(record.encryptedManagementKeyBase64, 'base64'),
    ),
    clientKey: record.encryptedClientKeyBase64
      ? storage.decrypt(Buffer.from(record.encryptedClientKeyBase64, 'base64'))
      : null,
    keyRejection: record.keyRejection ?? null,
  };
}

export async function saveAccountProxyCredentials(
  connectionId: string,
  credentials: AccountProxyCredentials,
): Promise<void> {
  const storage = availableStorage();
  storage.assertCanWrite();
  const encrypt = (value: string): string =>
    storage.encrypt(value).toString('base64');
  await queueMutation((records) => {
    records[connectionId] = {
      encryptedManagementKeyBase64: encrypt(credentials.managementKey),
      ...(credentials.clientKey
        ? { encryptedClientKeyBase64: encrypt(credentials.clientKey) }
        : {}),
      updatedAt: new Date().toISOString(),
    };
  }, true);
}

/**
 * Records that the server refused `rejectedKey`. Nothing changes when the
 * stored key is a different one, such as a replacement saved while the
 * refusal was on its way. Saving a key clears the rejection.
 */
export async function markAccountProxyKeyRejected(
  connectionId: string,
  keyRejection: AccountProxyKeyRejection,
  rejectedKey: string,
): Promise<void> {
  const storage = availableStorage();
  await queueMutation((records) => {
    const current = records[connectionId];
    if (!current) return;
    const storedKey = storage.decrypt(
      Buffer.from(current.encryptedManagementKeyBase64, 'base64'),
    );
    if (storedKey !== rejectedKey) return;
    records[connectionId] = {
      ...current,
      keyRejection,
      updatedAt: new Date().toISOString(),
    };
  });
}

export async function deleteAccountProxyCredentials(
  connectionId: string,
): Promise<void> {
  await queueMutation((records) => {
    delete records[connectionId];
  });
}

export function isAccountProxyCredentialStorageAvailable(): boolean {
  return getSecretStoragePolicy().isWriteAvailable();
}

export function resetAccountProxyCredentialStoreForTests(): void {
  mutationQueue = Promise.resolve();
}
