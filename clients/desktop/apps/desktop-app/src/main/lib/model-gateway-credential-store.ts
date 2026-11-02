import type { SecureStorageFailure } from '@canopy/desktop-shared/types/secure-storage';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { writeFileAtomically } from './atomic-file';
import { readCanopyCloudAccountWithStatus } from './canopy-cloud-account-store';
import {
  getInternalLegacySharedModelGatewayCredentialStorePath,
  getLegacyModelGatewayCredentialStorePath,
  getModelGatewayCredentialStorePath,
} from './paths';
import {
  getSecretStoragePolicy,
  getSecureStorageFailure,
  type SecretStoragePolicy,
} from './secure-storage-policy';
import { migrateSecureStorageFile } from './secure-storage-migration';

interface StoredGatewayCredentialRecord {
  accountId: string;
  organizationId: string;
  encryptedApiKeyBase64: string;
  baseUrlAtSave: string;
  updatedAt: string;
  lastValidatedAt?: string;
  /** A successful validation, independent of routing rejection state. */
  validated?: boolean;
  lastError?: string;
}

interface StoredGatewayCredentialFile {
  /** Read-only projection; preserve these bytes before an authorized replacement. */
  ownerlessLegacy?: Buffer;
  version: 2;
  records: Record<string, StoredGatewayCredentialRecord>;
}

export interface ModelGatewayCredentialRecord {
  organizationId: string;
  apiKey: string;
  baseUrlAtSave: string;
  updatedAt: string;
  lastValidatedAt?: string;
  /** A successful validation, independent of routing rejection state. */
  validated?: boolean;
  lastError?: string;
}

export class GatewayCredentialStorageUnavailableError extends Error {
  constructor(readonly secureStorageFailure?: SecureStorageFailure) {
    super('Secure storage unavailable');
    this.name = 'GatewayCredentialStorageUnavailableError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function availableStorage(): SecretStoragePolicy {
  const policy = getSecretStoragePolicy();
  const run = <T>(operation: () => T): T => {
    try {
      return operation();
    } catch (error) {
      const failure = getSecureStorageFailure(error);
      if (failure) throw new GatewayCredentialStorageUnavailableError(failure);
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

function isStoredRecord(
  value: unknown,
): value is StoredGatewayCredentialRecord {
  return (
    isRecord(value) &&
    typeof value.accountId === 'string' &&
    typeof value.organizationId === 'string' &&
    typeof value.encryptedApiKeyBase64 === 'string' &&
    typeof value.baseUrlAtSave === 'string' &&
    typeof value.updatedAt === 'string' &&
    (value.lastValidatedAt === undefined ||
      typeof value.lastValidatedAt === 'string') &&
    (value.validated === undefined || typeof value.validated === 'boolean') &&
    (value.lastError === undefined || typeof value.lastError === 'string')
  );
}

function parseFile(raw: Buffer): StoredGatewayCredentialFile {
  const parsed: unknown = JSON.parse(raw.toString('utf8'));
  // Ownerless data stays isolated. Retain the complete original bytes so an
  // explicit authorized mutation can back it up before starting a v2 store.
  if (isRecord(parsed) && parsed.version === 1) {
    return { version: 2, records: {}, ownerlessLegacy: raw };
  }
  if (!isRecord(parsed) || parsed.version !== 2 || !isRecord(parsed.records)) {
    throw new Error('Invalid model gateway credential store');
  }
  const records: Record<string, StoredGatewayCredentialRecord> = {};
  for (const [key, value] of Object.entries(parsed.records)) {
    if (!isStoredRecord(value)) {
      throw new Error('Invalid model gateway credential record');
    }
    records[key] = value;
  }
  return { version: 2, records };
}

function decrypt(
  storage: SecretStoragePolicy,
  record: StoredGatewayCredentialRecord,
): ModelGatewayCredentialRecord {
  return {
    organizationId: record.organizationId,
    apiKey: storage.decrypt(
      Buffer.from(record.encryptedApiKeyBase64, 'base64'),
    ),
    baseUrlAtSave: record.baseUrlAtSave,
    updatedAt: record.updatedAt,
    lastValidatedAt: record.lastValidatedAt,
    validated: record.validated,
    lastError: record.lastError,
  };
}

function validateFile(
  storage: SecretStoragePolicy,
  file: StoredGatewayCredentialFile,
): StoredGatewayCredentialFile {
  Object.values(file.records).forEach((record) => decrypt(storage, record));
  return file;
}

function reencryptFile(
  storage: SecretStoragePolicy,
  file: StoredGatewayCredentialFile,
): string {
  if (file.ownerlessLegacy)
    throw new Error('Ownerless model gateway credential store');
  const records = Object.fromEntries(
    Object.entries(file.records).map(([key, record]) => {
      const clear = decrypt(storage, record);
      return [
        key,
        {
          ...record,
          encryptedApiKeyBase64: storage
            .encrypt(clear.apiKey)
            .toString('base64'),
        },
      ];
    }),
  );
  return JSON.stringify({ version: 2, records }, null, 2);
}

async function readStore(): Promise<StoredGatewayCredentialFile> {
  const storage = availableStorage();
  const currentPath = getModelGatewayCredentialStorePath();
  const migration = await migrateSecureStorageFile<StoredGatewayCredentialFile>(
    {
      currentPath,
      legacyPath: getInternalLegacySharedModelGatewayCredentialStorePath(),
      decode: parseFile,
      decodeLegacy: (raw) => validateFile(storage, parseFile(raw)),
      encode: (file) => reencryptFile(storage, file),
      storeKind: 'model-gateway',
      beforeWrite: async () => {
        await mkdir(dirname(currentPath), { recursive: true });
        storage.assertCanWrite();
      },
      writeOptions: { encoding: 'utf8', mode: 0o600 },
    },
  );
  if (
    migration.status === 'current' ||
    migration.status === 'migrated' ||
    migration.status === 'legacy-decoded-write-deferred'
  ) {
    return migration.value;
  }
  if (migration.status === 'unavailable') storage.assertCanRead();
  if (
    migration.status === 'current-error' ||
    migration.status === 'storage-error'
  ) {
    throw migration.error;
  }
  if (
    migration.status === 'foreign-legacy-skipped' &&
    migration.secureStorageFailure
  )
    return { version: 2, records: {} };
  if (migration.status !== 'absent')
    throw new Error('Model gateway credential store unavailable');
  try {
    return parseFile(
      await readFile(getLegacyModelGatewayCredentialStorePath()),
    );
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT')
      return { version: 2, records: {} };
    throw error;
  }
}

async function writeStore(
  file: StoredGatewayCredentialFile,
  requiresWrite = false,
): Promise<void> {
  const path = getModelGatewayCredentialStorePath();
  await mkdir(dirname(path), { recursive: true });
  if (requiresWrite) availableStorage().assertCanWrite();
  await writeFileAtomically(path, JSON.stringify(file, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  });
  await rm(getLegacyModelGatewayCredentialStorePath(), { force: true }).catch(
    () => undefined,
  );
}

let mutationQueue: Promise<void> = Promise.resolve();

function credentialKey(accountId: string, organizationId: string): string {
  return JSON.stringify([accountId, organizationId]);
}

async function resolveCredentialOwner(
  organizationId: string,
): Promise<{ accountId: string; key: string } | null> {
  const read = await readCanopyCloudAccountWithStatus();
  if (read.status !== 'ok') {
    const failure =
      read.status === 'unavailable'
        ? read.secureStorageFailure
        : getSecureStorageFailure(read.error);
    if (failure) throw new GatewayCredentialStorageUnavailableError(failure);
    throw read.error;
  }
  const account = read.entry;
  const accountId = account?.account?.id.trim();
  const organizationIsCurrent = account?.enforcedSettings?.some(
    (org) =>
      org.organizationId === organizationId &&
      org.policies.some((policy) => policy.kind === 'model-gateway'),
  );
  return accountId && organizationIsCurrent
    ? { accountId, key: credentialKey(accountId, organizationId) }
    : null;
}

function queueMutation(
  mutation: (file: StoredGatewayCredentialFile) => void,
  options: { requiresWrite?: boolean; replaceOwnerlessLegacy?: boolean } = {},
): Promise<void> {
  const { requiresWrite = false, replaceOwnerlessLegacy = false } = options;
  const next = mutationQueue.then(async () => {
    let file = await readStore();
    if (file.ownerlessLegacy) {
      // Runtime rejection metadata cannot authorize recovery of ownerless data.
      if (!replaceOwnerlessLegacy) return;
      const path = getModelGatewayCredentialStorePath();
      await mkdir(dirname(path), { recursive: true });
      if (requiresWrite) availableStorage().assertCanWrite();
      // Publish a complete, private recovery copy before replacing any source.
      // A unique, exclusive destination never overwrites an earlier backup;
      // durability failures propagate and all backups remain for recovery.
      await writeFileAtomically(
        `${path}.v1-backup-${randomUUID()}`,
        file.ownerlessLegacy,
        { mode: 0o600, overwrite: false, durable: true },
      );
      file = { version: 2, records: {} };
    }
    mutation(file);
    await writeStore(file, requiresWrite);
  });
  mutationQueue = next.catch(() => undefined);
  return next;
}

export async function loadModelGatewayCredential(
  organizationId: string,
): Promise<ModelGatewayCredentialRecord | null> {
  const storage = availableStorage();
  const owner = await resolveCredentialOwner(organizationId);
  if (!owner) return null;
  const stored = (await readStore()).records[owner.key];
  if (!stored) return null;
  return decrypt(storage, stored);
}

export async function saveModelGatewayCredential(input: {
  organizationId: string;
  apiKey: string;
  baseUrlAtSave: string;
  lastValidatedAt?: string;
  /** A successful validation, independent of routing rejection state. */
  validated?: boolean;
  lastError?: string;
}): Promise<void> {
  const storage = availableStorage();
  const apiKey = input.apiKey.trim();
  if (apiKey) storage.assertCanWrite();
  const owner = await resolveCredentialOwner(input.organizationId);
  if (!owner) {
    throw new Error(
      'Cannot save a model gateway credential outside the current account policy.',
    );
  }
  await queueMutation(
    (file) => {
      if (!apiKey) {
        delete file.records[owner.key];
        return;
      }
      file.records[owner.key] = {
        accountId: owner.accountId,
        organizationId: input.organizationId,
        encryptedApiKeyBase64: storage.encrypt(apiKey).toString('base64'),
        baseUrlAtSave: input.baseUrlAtSave,
        updatedAt: new Date().toISOString(),
        lastValidatedAt: input.lastValidatedAt,
        validated: input.validated,
        lastError: input.lastError,
      };
    },
    { requiresWrite: Boolean(apiKey), replaceOwnerlessLegacy: true },
  );
}

/** Persist a gateway-issued runtime rejection without exposing or replacing the key. */
export async function markModelGatewayCredentialRejected(
  organizationId: string,
  lastError: string,
  expectedUpdatedAt?: string,
  expectedAccountId?: string,
): Promise<boolean> {
  const owner = await resolveCredentialOwner(organizationId);
  if (
    !owner ||
    (expectedAccountId !== undefined && owner.accountId !== expectedAccountId)
  )
    return false;
  let updated = false;
  await queueMutation((file) => {
    const record = file.records[owner.key];
    if (!record) return;
    if (expectedUpdatedAt && record.updatedAt !== expectedUpdatedAt) return;
    record.lastError = lastError;
    record.validated = false;
    record.lastValidatedAt = new Date().toISOString();
    updated = true;
  });
  return updated;
}

export function isModelGatewayCredentialStorageAvailable(): boolean {
  return getSecretStoragePolicy().isWriteAvailable();
}

export function resetModelGatewayCredentialStoreForTests(): void {
  mutationQueue = Promise.resolve();
}
