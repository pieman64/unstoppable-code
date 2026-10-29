import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { UserEnvironmentEntry } from '@canopy/desktop-shared/types';
import { normalizeUserEnvironmentEntries } from '@canopy/desktop-shared/lib/user-environment';
import { getSharedContainerRunEnvFilePath } from '../lib/paths';
import { getSecretStoragePolicy } from '../lib/secure-storage-policy';
import { writeFileAtomically } from '../lib/atomic-file';
import { isMissingFileError } from '../lib/fs-utils';
import { isRecord } from '../lib/type-guards';

interface RunEnvFile {
  version: 1;
  containers: Record<string, string>;
}

const EMPTY: RunEnvFile = { version: 1, containers: {} };
let queue: Promise<unknown> = Promise.resolve();

function validContainerId(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(value);
}

async function read(): Promise<RunEnvFile> {
  let raw: string;
  try {
    raw = await readFile(getSharedContainerRunEnvFilePath(), 'utf8');
  } catch (error) {
    if (isMissingFileError(error)) return { ...EMPTY, containers: {} };
    throw error;
  }
  const value: unknown = JSON.parse(raw);
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.containers)) {
    throw new Error('Invalid shared-container run environment store');
  }
  const containers = new Map<string, string>();
  for (const [id, encrypted] of Object.entries(value.containers)) {
    if (!validContainerId(id) || typeof encrypted !== 'string') {
      throw new Error('Invalid shared-container run environment record');
    }
    containers.set(id, encrypted);
  }
  return { version: 1, containers: Object.fromEntries(containers) };
}

async function write(
  file: RunEnvFile,
  requireSecureWrite = false,
): Promise<void> {
  const path = getSharedContainerRunEnvFilePath();
  await mkdir(dirname(path), { recursive: true });
  if (requireSecureWrite) getSecretStoragePolicy().assertCanWrite();
  await writeFileAtomically(path, `${JSON.stringify(file, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
}

function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const result = queue.then(operation, operation);
  queue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export async function readSharedContainerRunEnvironment(
  containerId: string,
): Promise<UserEnvironmentEntry[]> {
  if (!validContainerId(containerId)) return [];
  const { containers } = await read();
  if (!Object.prototype.hasOwnProperty.call(containers, containerId)) return [];
  const encrypted = containers[containerId];
  const value: unknown = JSON.parse(
    getSecretStoragePolicy().decrypt(Buffer.from(encrypted, 'base64')),
  );
  if (!Array.isArray(value))
    throw new Error('Invalid shared-container run environment values');
  return normalizeUserEnvironmentEntries(value);
}

export function writeSharedContainerRunEnvironment(
  containerId: string,
  values: UserEnvironmentEntry[],
): Promise<UserEnvironmentEntry[]> {
  if (!validContainerId(containerId))
    throw new Error('Invalid shared-container id');
  return enqueue(async () => {
    const normalized = normalizeUserEnvironmentEntries(values).slice(0, 64);
    const policy = getSecretStoragePolicy();
    policy.assertCanWrite();
    const file = await read();
    const containers = new Map(Object.entries(file.containers));
    containers.set(
      containerId,
      policy.encrypt(JSON.stringify(normalized)).toString('base64'),
    );
    await write(
      { version: 1, containers: Object.fromEntries(containers) },
      true,
    );
    return normalized;
  });
}

export function removeSharedContainerRunEnvironment(
  containerId: string,
): Promise<void> {
  return enqueue(async () => {
    const file = await read();
    if (!Object.prototype.hasOwnProperty.call(file.containers, containerId))
      return;
    const containers = new Map(Object.entries(file.containers));
    containers.delete(containerId);
    await write({ version: 1, containers: Object.fromEntries(containers) });
  });
}
