import { isSyntacticallyValidModelId } from '../../lib/model-id';
import { createHash, randomUUID } from 'node:crypto';
import { capabilityFiles } from '../capabilities/file-snapshot';
import {
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;

/** Canonical JSON retains array order, sorts record keys and refuses non-JSON data. */
export function canonicalOpenCodeCapability(value: unknown, depth = 0): string {
  if (depth > 64)
    throw new Error('OpenCode capabilities are too deeply nested.');
  if (value === null || value === undefined) return 'null';
  if (
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  )
    return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map((item) => canonicalOpenCodeCapability(item, depth + 1)).join(',')}]`;
  if (typeof value !== 'object')
    throw new Error('OpenCode capabilities contain unsupported data.');
  return `{${Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(
      ([key, item]) =>
        `${JSON.stringify(key)}:${canonicalOpenCodeCapability(item, depth + 1)}`,
    )
    .join(',')}}`;
}
export function openCodeCapabilityDigest(value: unknown): string {
  const text = canonicalOpenCodeCapability(value);
  if (Buffer.byteLength(text) > MAX_SNAPSHOT_BYTES)
    throw new Error('OpenCode capability snapshot exceeds the size limit.');
  return createHash('sha256').update(text).digest('hex');
}

/** Hash the delivered private copies, not source mtimes or selection labels. */
export async function openCodeCapabilityFiles(
  roots: readonly string[],
  signal: AbortSignal,
): Promise<Record<string, string>> {
  return capabilityFiles(roots, signal, 'OpenCode');
}

export interface OpenCodeInferenceSelection {
  modelId: string;
  fundingDigest: string;
}

export interface OpenCodeCapabilitySnapshot {
  version: 1;
  runtime: unknown;
  contextDigest: string;
  providerSettingsDigest: string;
  inferenceRouteDigest?: string;
  inferenceSelection?: OpenCodeInferenceSelection;
  files: Record<string, string>;
  mcp: readonly { name: string; identity: unknown; tools: readonly Tool[] }[];
}
export interface OpenCodeCapabilityBinding {
  /** Older hosts must reject managed authority or model-transition metadata they cannot verify. */
  version: 1 | 2 | 3;
  sessionId: string;
  digest: string;
  generation: number;
  inferenceRouteDigest?: string;
  inferenceSelection?: OpenCodeInferenceSelection;
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isInferenceSelection(
  value: unknown,
): value is OpenCodeInferenceSelection {
  return (
    record(value) &&
    typeof value.modelId === 'string' &&
    isSyntacticallyValidModelId(value.modelId) &&
    typeof value.fundingDigest === 'string' &&
    /^[a-f0-9]{64}$/.test(value.fundingDigest)
  );
}
function missing(error: unknown): boolean {
  return record(error) && error.code === 'ENOENT';
}
function bindingPath(profile: string, sessionId: string): string {
  return join(
    profile,
    'capability-bindings',
    `${openCodeCapabilityDigest(sessionId)}.json`,
  );
}
export async function readOpenCodeCapabilityBinding(
  profile: string,
  sessionId: string,
): Promise<OpenCodeCapabilityBinding | undefined> {
  let text: string;
  try {
    const file = bindingPath(profile, sessionId);
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4096)
      throw new Error(
        'OpenCode capability binding is invalid. Start a new chat.',
      );
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
  const value: unknown = JSON.parse(text);
  if (
    !record(value) ||
    (value.version !== 1 && value.version !== 2 && value.version !== 3) ||
    value.sessionId !== sessionId ||
    typeof value.digest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.digest) ||
    typeof value.generation !== 'number' ||
    !Number.isSafeInteger(value.generation) ||
    value.generation < 1
  )
    throw new Error(
      'OpenCode capability binding is invalid. Start a new chat.',
    );
  if (
    value.version !== 1
      ? typeof value.inferenceRouteDigest !== 'string' ||
        !/^[a-f0-9]{64}$/.test(value.inferenceRouteDigest)
      : value.inferenceRouteDigest !== undefined
  )
    throw new Error('OpenCode inference binding is invalid. Start a new chat.');
  if (
    value.version === 3
      ? !isInferenceSelection(value.inferenceSelection)
      : value.inferenceSelection !== undefined
  )
    throw new Error(
      'OpenCode inference selection is invalid. Start a new chat.',
    );
  const file = join(profile, 'capability-snapshots', `${value.digest}.json`);
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_SNAPSHOT_BYTES)
    throw new Error(
      'OpenCode capability snapshot is invalid. Start a new chat.',
    );
  const snapshot: unknown = JSON.parse(await readFile(file, 'utf8'));
  if (!record(snapshot) || snapshot.version !== 1)
    throw new Error(
      'OpenCode capability snapshot version is unavailable. Start a new chat.',
    );
  if (openCodeCapabilityDigest(snapshot) !== value.digest)
    throw new Error(
      'OpenCode capability snapshot changed on disk. Start a new chat.',
    );
  if (snapshot.inferenceRouteDigest !== value.inferenceRouteDigest)
    throw new Error(
      'OpenCode inference binding changed on disk. Start a new chat.',
    );
  if (
    openCodeCapabilityDigest(snapshot.inferenceSelection) !==
    openCodeCapabilityDigest(value.inferenceSelection)
  )
    throw new Error(
      'OpenCode inference selection changed on disk. Start a new chat.',
    );
  return {
    ...(isInferenceSelection(value.inferenceSelection)
      ? { inferenceSelection: { ...value.inferenceSelection } }
      : {}),
    version: value.version,
    sessionId,
    digest: value.digest,
    generation: value.generation,
    ...(typeof value.inferenceRouteDigest === 'string'
      ? { inferenceRouteDigest: value.inferenceRouteDigest }
      : {}),
  };
}
async function atomicJson(
  directory: string,
  name: string,
  value: unknown,
  signal: AbortSignal,
): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error('OpenCode capability storage is invalid.');
  const temporary = join(directory, `${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, canonicalOpenCodeCapability(value), {
      mode: 0o600,
      flag: 'wx',
    });
    signal.throwIfAborted();
    await rename(temporary, join(directory, name));
  } finally {
    await rm(temporary, { force: true });
  }
}
export async function saveOpenCodeCapabilitySnapshot(
  profile: string,
  sessionId: string,
  snapshot: OpenCodeCapabilitySnapshot,
  previous: OpenCodeCapabilityBinding | undefined,
  signal: AbortSignal,
): Promise<OpenCodeCapabilityBinding> {
  if (
    snapshot.inferenceRouteDigest !== undefined &&
    !/^[a-f0-9]{64}$/.test(snapshot.inferenceRouteDigest)
  )
    throw new Error('OpenCode inference binding is invalid.');
  if (
    snapshot.inferenceSelection !== undefined &&
    (!snapshot.inferenceRouteDigest ||
      !isInferenceSelection(snapshot.inferenceSelection))
  )
    throw new Error('OpenCode inference selection is invalid.');
  const digest = openCodeCapabilityDigest(snapshot);
  const binding: OpenCodeCapabilityBinding = {
    version: snapshot.inferenceSelection
      ? 3
      : snapshot.inferenceRouteDigest
        ? 2
        : 1,
    ...(snapshot.inferenceSelection
      ? { inferenceSelection: { ...snapshot.inferenceSelection } }
      : {}),
    sessionId,
    digest,
    generation: previous
      ? previous.generation + Number(previous.digest !== digest)
      : 1,
    ...(snapshot.inferenceRouteDigest
      ? { inferenceRouteDigest: snapshot.inferenceRouteDigest }
      : {}),
  };
  await atomicJson(
    join(profile, 'capability-snapshots'),
    `${digest}.json`,
    snapshot,
    signal,
  );
  await atomicJson(
    join(profile, 'capability-bindings'),
    `${openCodeCapabilityDigest(sessionId)}.json`,
    binding,
    signal,
  );
  return binding;
}

/** Retain verified history for a native fork, without copying credentials or runtime state. */
export async function forkOpenCodeCapabilityBinding(
  source: string,
  sourceSessionId: string,
  destination: string,
  forkSessionId: string,
  signal: AbortSignal,
  expected?: OpenCodeCapabilityBinding,
): Promise<OpenCodeCapabilityBinding> {
  signal.throwIfAborted();
  if (
    resolve(source) === resolve(destination) ||
    sourceSessionId === forkSessionId
  )
    throw new Error(
      'OpenCode forks require distinct profiles and native session IDs.',
    );
  const original = await readOpenCodeCapabilityBinding(source, sourceSessionId);
  if (!original)
    throw new Error('OpenCode source capability history is unavailable.');
  if (
    expected &&
    (expected.digest !== original.digest ||
      expected.generation !== original.generation ||
      expected.sessionId !== original.sessionId)
  )
    throw new Error('OpenCode source capabilities changed while forking.');
  const file = join(source, 'capability-snapshots', `${original.digest}.json`);
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_SNAPSHOT_BYTES)
    throw new Error('OpenCode source capability snapshot is invalid.');
  const snapshot: unknown = JSON.parse(await readFile(file, 'utf8'));
  // Recheck the actual copied value: source history can change between reads.
  if (openCodeCapabilityDigest(snapshot) !== original.digest)
    throw new Error('OpenCode capability snapshot changed on disk.');
  const binding = { ...original, sessionId: forkSessionId };
  await atomicJson(
    join(destination, 'capability-snapshots'),
    `${original.digest}.json`,
    snapshot,
    signal,
  );
  await atomicJson(
    join(destination, 'capability-bindings'),
    `${openCodeCapabilityDigest(forkSessionId)}.json`,
    binding,
    signal,
  );
  return binding;
}
