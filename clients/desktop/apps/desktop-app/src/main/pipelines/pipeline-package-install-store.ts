import { copyFile, mkdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import {
  damagedCopiesOf,
  pruneDamagedCopies,
} from '@canopy/execution-engine/node/lib/damaged-copies';
import {
  isPipelineContentHash,
  isPipelinePackageDigest,
} from '@canopy/protocol/pipelines';
import type {
  CapabilityPackageInstallOwner,
  CapabilityPackageInstallRecordV1,
  PipelinePackageInstallRecordV1,
} from '@canopy/execution-engine/types/pipeline';
import { CAPABILITY_PACKAGE_INSTALL_OWNER_KINDS } from '@canopy/execution-engine/types/pipeline';
import { writeStoreFileDurably } from '../lib/durable-store-write';

interface PipelinePackageInstallStoreV1 {
  version: 1;
  records: CapabilityPackageInstallRecordV1[];
  /**
   * Rows this build could not parse, carried verbatim so a write does not
   * delete them. These are normally records from a NEWER build (a packaged
   * skill install read by a build that predates skill owners); dropping them
   * would silently un-install whatever the newer build had recorded. Never
   * written as its own key — {@link writeStore} folds these back into
   * `records`.
   */
  unreadable: unknown[];
  /**
   * The file existed but could not be parsed at all (not JSON, or not the v1
   * envelope). Reads still degrade to empty so package resolution keeps
   * working, but the next write must not replace those bytes: a truncated or
   * hand-edited file may still hold every install the user has. {@link
   * writeStore} copies it aside first.
   */
  unreadableFile?: boolean;
  /**
   * The file is a ledger from a newer version. Reads degrade to empty like an
   * unreadable file, but no write replaces it: the newer build that wrote it
   * is the only one that can carry its records forward.
   */
  newerVersion?: boolean;
}

const mutationQueues = new Map<string, Promise<void>>();

async function mutateStore<T>(
  storePath: string,
  mutation: () => Promise<T>,
): Promise<T> {
  const previous = mutationQueues.get(storePath) ?? Promise.resolve();
  const operation = previous.catch(() => undefined).then(mutation);
  const settled = operation.then(
    () => undefined,
    () => undefined,
  );
  mutationQueues.set(storePath, settled);
  try {
    return await operation;
  } finally {
    if (mutationQueues.get(storePath) === settled) {
      mutationQueues.delete(storePath);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseInstallOwner(
  value: unknown,
): CapabilityPackageInstallOwner | null {
  if (!isRecord(value)) return null;
  if (
    value.kind === 'pipeline' &&
    typeof value.localPipelineId === 'string' &&
    value.localPipelineId.length > 0
  ) {
    return { kind: 'pipeline', localPipelineId: value.localPipelineId };
  }
  if (
    value.kind === 'automation' &&
    typeof value.localAutomationId === 'string' &&
    value.localAutomationId.length > 0
  ) {
    return { kind: 'automation', localAutomationId: value.localAutomationId };
  }
  for (const kind of CAPABILITY_PACKAGE_INSTALL_OWNER_KINDS) {
    if (
      value.kind === kind &&
      typeof value.localId === 'string' &&
      value.localId.length > 0
    ) {
      return { kind, localId: value.localId };
    }
  }
  return null;
}

function parseInstallRecord(
  value: unknown,
): CapabilityPackageInstallRecordV1 | null {
  if (!isRecord(value)) return null;
  const owner =
    parseInstallOwner(value.owner) ??
    (typeof value.localPipelineId === 'string' &&
    value.localPipelineId.length > 0
      ? { kind: 'pipeline' as const, localPipelineId: value.localPipelineId }
      : null);
  if (
    owner === null ||
    (value.supportingFilesComplete !== undefined &&
      typeof value.supportingFilesComplete !== 'boolean') ||
    (value.originExternalId !== undefined &&
      (typeof value.originExternalId !== 'string' ||
        value.originExternalId.length === 0)) ||
    (value.localContentHash !== undefined &&
      !isPipelineContentHash(value.localContentHash)) ||
    !isPipelineContentHash(value.pipelineContentHash) ||
    typeof value.installedAt !== 'string' ||
    Number.isNaN(Date.parse(value.installedAt))
  ) {
    return null;
  }
  const common = {
    owner,
    ...(typeof value.originExternalId === 'string'
      ? { originExternalId: value.originExternalId }
      : {}),
    ...(typeof value.localContentHash === 'string'
      ? { localContentHash: value.localContentHash }
      : {}),
    pipelineContentHash: value.pipelineContentHash,
    installedAt: value.installedAt,
    ...(typeof value.supportingFilesComplete === 'boolean'
      ? { supportingFilesComplete: value.supportingFilesComplete }
      : {}),
  };
  if (value.distributionMode === 'definition_only') {
    return value.packageDigest === undefined
      ? { ...common, distributionMode: 'definition_only' }
      : null;
  }
  if (
    (value.distributionMode === undefined ||
      value.distributionMode === 'package') &&
    isPipelinePackageDigest(value.packageDigest)
  ) {
    return {
      ...common,
      ...(value.distributionMode === 'package'
        ? { distributionMode: 'package' as const }
        : {}),
      packageDigest: value.packageDigest,
    };
  }
  return null;
}

// Namespaced by kind, so a skill and an Agent that happen to share a local id
// stay two independent ledger rows.
function installOwnerKey(owner: CapabilityPackageInstallOwner): string {
  if (owner.kind === 'pipeline') return `pipeline:${owner.localPipelineId}`;
  if (owner.kind === 'automation')
    return `automation:${owner.localAutomationId}`;
  return `${owner.kind}:${owner.localId}`;
}

async function readStore(
  storePath: string,
): Promise<PipelinePackageInstallStoreV1> {
  let raw: string;
  try {
    raw = await readFile(storePath, 'utf8');
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return { version: 1, records: [], unreadable: [] };
    }
    throw error;
  }
  try {
    const value: unknown = JSON.parse(raw);
    if (
      isRecord(value) &&
      typeof value.version === 'number' &&
      value.version > 1
    ) {
      return { version: 1, records: [], unreadable: [], newerVersion: true };
    }
    if (
      !isRecord(value) ||
      value.version !== 1 ||
      !Array.isArray(value.records)
    ) {
      throw new Error('invalid shape');
    }
    // Keyed by owner so a later row replaces an earlier one: last writer wins,
    // matching `upsertCapabilityPackageInstall`, which treats the newest write
    // for an owner as authoritative. Only a hand-edited or corrupted file can
    // hold duplicates, but when one does, dropping the newer row would be the
    // wrong way round. A `Map` keeps each owner at its first position.
    const byOwner = new Map<string, CapabilityPackageInstallRecordV1>();
    const unreadable: unknown[] = [];
    for (const value_ of value.records) {
      const record = parseInstallRecord(value_);
      // Keep what this build cannot read rather than discarding the file. A
      // record written by a NEWER build is the expected case — install a
      // packaged skill, then downgrade, and the older `isInstallRecord` rejects
      // a skill-owner row for having no top-level `localPipelineId`. Throwing
      // here took the whole ledger with it, and no call site catches it, so
      // every pipeline and automation package resolution hard-failed.
      if (!record) {
        unreadable.push(value_);
        continue;
      }
      byOwner.set(installOwnerKey(record.owner), record);
    }
    return { version: 1, records: Array.from(byOwner.values()), unreadable };
  } catch {
    // A file this build cannot parse AT ALL (not JSON, or not the v1 envelope)
    // still initializes empty rather than throwing, matching the repo's
    // persistence rule, so package resolution keeps working. It is flagged so
    // the next write preserves the original bytes instead of replacing them.
    return { version: 1, records: [], unreadable: [], unreadableFile: true };
  }
}

async function writeStore(
  storePath: string,
  store: PipelinePackageInstallStoreV1,
): Promise<void> {
  if (store.newerVersion) {
    throw new Error('Pipeline package install ledger is from a newer version');
  }
  await mkdir(path.dirname(storePath), { recursive: true });
  if (store.unreadableFile) {
    // Keep the bytes this build could not read. Writing over them would turn a
    // recoverable file (truncated or hand-edited) into permanent loss of every
    // install it recorded. If the copy itself fails (EACCES, disk full) this
    // throws and the write does not happen: blocking one install is preferable
    // to overwriting the only copy of the user's ledger. Only the newest five
    // side copies are kept, so a ledger damaged again and again, or a rewrite
    // that keeps failing, cannot fill the data directory.
    await copyFile(storePath, `${storePath}.unreadable-${Date.now()}`);
    await pruneDamagedCopies(damagedCopiesOf(storePath, '.unreadable-'));
  }
  // Rows this build could not parse are written back alongside the ones it
  // could, so a downgrade does not quietly delete a newer build's installs.
  const serializable = {
    version: store.version,
    records: [...store.records, ...store.unreadable],
  };
  await writeStoreFileDurably(
    storePath,
    `${JSON.stringify(serializable, null, 2)}\n`,
    { encoding: 'utf8' },
  );
}

export async function listPipelinePackageInstalls(
  storePath: string,
): Promise<PipelinePackageInstallRecordV1[]> {
  const pipelineRecords: PipelinePackageInstallRecordV1[] = [];
  for (const record of await listCapabilityPackageInstalls(storePath)) {
    if (record.owner.kind !== 'pipeline') continue;
    const common = {
      localPipelineId: record.owner.localPipelineId,
      ...(record.originExternalId !== undefined
        ? { originExternalId: record.originExternalId }
        : {}),
      pipelineContentHash: record.pipelineContentHash,
      installedAt: record.installedAt,
    };
    if (record.distributionMode === 'definition_only') {
      pipelineRecords.push({
        ...common,
        distributionMode: 'definition_only',
      });
    } else {
      pipelineRecords.push({
        ...common,
        ...(record.distributionMode === 'package'
          ? { distributionMode: 'package' as const }
          : {}),
        packageDigest: record.packageDigest,
      });
    }
  }
  return pipelineRecords;
}

export async function listCapabilityPackageInstalls(
  storePath: string,
): Promise<CapabilityPackageInstallRecordV1[]> {
  return [...(await readStore(storePath)).records];
}

export async function findCapabilityPackageInstallByOwner(
  storePath: string,
  owner: CapabilityPackageInstallOwner,
): Promise<CapabilityPackageInstallRecordV1 | null> {
  const ownerKey = installOwnerKey(owner);
  return (
    (await listCapabilityPackageInstalls(storePath)).find(
      (record) => installOwnerKey(record.owner) === ownerKey,
    ) ?? null
  );
}

export async function findPipelinePackageInstall(
  storePath: string,
  identity: {
    pipelineContentHash: string;
    packageDigest: string;
    originExternalId?: string;
  },
): Promise<PipelinePackageInstallRecordV1 | null> {
  const records = await listPipelinePackageInstalls(storePath);
  return (
    records.find(
      (record) =>
        record.distributionMode !== 'definition_only' &&
        record.pipelineContentHash === identity.pipelineContentHash &&
        record.packageDigest === identity.packageDigest &&
        (identity.originExternalId === undefined ||
          record.originExternalId === identity.originExternalId),
    ) ?? null
  );
}

export async function upsertPipelinePackageInstall(
  storePath: string,
  record: PipelinePackageInstallRecordV1,
): Promise<void> {
  const capabilityRecord: CapabilityPackageInstallRecordV1 =
    record.distributionMode === 'definition_only'
      ? {
          owner: {
            kind: 'pipeline',
            localPipelineId: record.localPipelineId,
          },
          ...(record.originExternalId !== undefined
            ? { originExternalId: record.originExternalId }
            : {}),
          pipelineContentHash: record.pipelineContentHash,
          distributionMode: 'definition_only',
          installedAt: record.installedAt,
        }
      : {
          owner: {
            kind: 'pipeline',
            localPipelineId: record.localPipelineId,
          },
          ...(record.originExternalId !== undefined
            ? { originExternalId: record.originExternalId }
            : {}),
          pipelineContentHash: record.pipelineContentHash,
          ...(record.distributionMode === 'package'
            ? { distributionMode: 'package' as const }
            : {}),
          packageDigest: record.packageDigest,
          installedAt: record.installedAt,
        };
  return upsertCapabilityPackageInstall(storePath, capabilityRecord);
}

export async function upsertCapabilityPackageInstall(
  storePath: string,
  record: CapabilityPackageInstallRecordV1,
): Promise<void> {
  // The NORMALIZED result is what gets stored, not the caller's object, so
  // unrecognized extra fields are never persisted forward.
  const normalized = parseInstallRecord(record);
  if (!normalized) {
    throw new Error('Invalid pipeline package install record');
  }
  await mutateStore(storePath, async () => {
    const store = await readStore(storePath);
    const ownerKey = installOwnerKey(normalized.owner);
    const existingIndex = store.records.findIndex(
      (entry) => installOwnerKey(entry.owner) === ownerKey,
    );
    if (existingIndex === -1) store.records.push(normalized);
    else store.records[existingIndex] = normalized;
    await writeStore(storePath, store);
  });
}

/**
 * Records fallback provenance without replacing a package install that won
 * the same owner race. The existence check lives inside the store mutation
 * queue so another writer cannot interleave between the read and write.
 */
export async function insertCapabilityPackageInstallIfAbsent(
  storePath: string,
  record: CapabilityPackageInstallRecordV1,
): Promise<boolean> {
  const normalized = parseInstallRecord(record);
  if (!normalized) {
    throw new Error('Invalid pipeline package install record');
  }
  return mutateStore(storePath, async () => {
    const store = await readStore(storePath);
    const ownerKey = installOwnerKey(normalized.owner);
    if (
      store.records.some((entry) => installOwnerKey(entry.owner) === ownerKey)
    ) {
      return false;
    }
    store.records.push(normalized);
    await writeStore(storePath, store);
    return true;
  });
}

/**
 * Moves an install's local content pin from `expected` to `next` while it
 * still pins `expected` (a record without its own pin pins its manifest's
 * hash). The check lives inside the store mutation queue, so an install that
 * replaced the record meanwhile keeps its pin. True when the pin moved.
 */
export async function repinCapabilityPackageInstallLocalContent(
  storePath: string,
  owner: CapabilityPackageInstallOwner,
  expected: string,
  next: string,
): Promise<boolean> {
  if (!isPipelineContentHash(next)) {
    throw new Error('Invalid pipeline package install content hash');
  }
  return mutateStore(storePath, async () => {
    const store = await readStore(storePath);
    const ownerKey = installOwnerKey(owner);
    const index = store.records.findIndex(
      (entry) => installOwnerKey(entry.owner) === ownerKey,
    );
    const record = store.records[index];
    if (
      record === undefined ||
      (record.localContentHash ?? record.pipelineContentHash) !== expected
    ) {
      return false;
    }
    store.records[index] = { ...record, localContentHash: next };
    await writeStore(storePath, store);
    return true;
  });
}

export async function removePipelinePackageInstall(
  storePath: string,
  localPipelineId: string,
): Promise<void> {
  return removeCapabilityPackageInstall(storePath, {
    kind: 'pipeline',
    localPipelineId,
  });
}

export async function removeCapabilityPackageInstall(
  storePath: string,
  owner: CapabilityPackageInstallOwner,
): Promise<void> {
  await mutateStore(storePath, async () => {
    const store = await readStore(storePath);
    const ownerKey = installOwnerKey(owner);
    const records = store.records.filter(
      (record) => installOwnerKey(record.owner) !== ownerKey,
    );
    if (records.length === store.records.length && !store.newerVersion) return;
    await writeStore(storePath, { ...store, records });
  });
}
