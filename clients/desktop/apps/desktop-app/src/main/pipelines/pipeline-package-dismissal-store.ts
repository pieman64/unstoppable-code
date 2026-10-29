import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

export interface PipelinePackageDismissalRecord {
  scopeKey: string;
  provider: 'claude' | 'codex';
  token: string;
  dismissedAt: string;
}

interface PipelinePackageDismissalStoreV1 {
  version: 1;
  records: PipelinePackageDismissalRecord[];
}

const mutationQueues = new Map<string, Promise<void>>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isDismissalRecord(
  value: unknown,
): value is PipelinePackageDismissalRecord {
  return (
    isRecord(value) &&
    typeof value.scopeKey === 'string' &&
    value.scopeKey.length > 0 &&
    (value.provider === 'claude' || value.provider === 'codex') &&
    typeof value.token === 'string' &&
    value.token.length <= 128 &&
    /^[/$][A-Za-z0-9._-]+(?::[A-Za-z0-9._-]+)*$/.test(value.token) &&
    typeof value.dismissedAt === 'string' &&
    !Number.isNaN(Date.parse(value.dismissedAt))
  );
}

async function readStore(
  storePath: string,
): Promise<PipelinePackageDismissalStoreV1> {
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
      return { version: 1, records: [] };
    }
    throw error;
  }
  try {
    const value: unknown = JSON.parse(raw);
    if (
      !isRecord(value) ||
      value.version !== 1 ||
      !Array.isArray(value.records) ||
      !value.records.every(isDismissalRecord)
    ) {
      throw new Error('invalid shape');
    }
    return { version: 1, records: value.records };
  } catch {
    throw new Error('Invalid pipeline package dismissal store');
  }
}

async function writeStore(
  storePath: string,
  store: PipelinePackageDismissalStoreV1,
): Promise<void> {
  await mkdir(path.dirname(storePath), { recursive: true });
  const temporaryPath = `${storePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(store, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  });
  await rename(temporaryPath, storePath);
}

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
    if (mutationQueues.get(storePath) === settled)
      mutationQueues.delete(storePath);
  }
}

export async function listPipelinePackageDismissals(
  storePath: string,
  scopeKey: string,
): Promise<PipelinePackageDismissalRecord[]> {
  return (await readStore(storePath)).records.filter(
    (record) => record.scopeKey === scopeKey,
  );
}

export async function replacePipelinePackageDismissals(
  storePath: string,
  scopeKey: string,
  dismissals: Array<{ provider: 'claude' | 'codex'; token: string }>,
): Promise<void> {
  if (!scopeKey) throw new Error('Invalid pipeline package dismissal scope');
  const unique = new Map(
    dismissals.map((dismissal) => [
      `${dismissal.provider}\0${dismissal.token}`,
      dismissal,
    ]),
  );
  if (unique.size > 50) {
    throw new Error('Too many pipeline package dismissal records');
  }
  if (
    Array.from(unique.values()).some(
      ({ provider, token }) =>
        (provider !== 'claude' && provider !== 'codex') ||
        token.length > 128 ||
        !/^[/$][A-Za-z0-9._-]+(?::[A-Za-z0-9._-]+)*$/.test(token),
    )
  ) {
    throw new Error('Invalid pipeline package dismissal record');
  }
  await mutateStore(storePath, async () => {
    const store = await readStore(storePath);
    const existing = new Map(
      store.records
        .filter((record) => record.scopeKey === scopeKey)
        .map((record) => [`${record.provider}\0${record.token}`, record]),
    );
    const dismissedAt = new Date().toISOString();
    const scopedRecords = Array.from(unique.entries()).map(
      ([key, dismissal]): PipelinePackageDismissalRecord =>
        existing.get(key) ?? { scopeKey, ...dismissal, dismissedAt },
    );
    await writeStore(storePath, {
      version: 1,
      records: [
        ...store.records.filter((record) => record.scopeKey !== scopeKey),
        ...scopedRecords,
      ],
    });
  });
}
