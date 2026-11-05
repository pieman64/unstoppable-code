/** Checkpointed stream metadata mechanics. No backend policy lives here. */
import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  TranscriptStreamCatalogSchema,
  TranscriptStreamDescriptorSchema,
  TranscriptStreamRegistrationSchema,
  TranscriptStreamRegistryHeaderSchema,
  type TranscriptStreamCatalog,
  type TranscriptStreamDescriptor,
  type TranscriptStreamDescriptorUpdate,
  type TranscriptStreamRegistration,
  type TranscriptStreamRegistryHeader,
  type TranscriptTarget,
} from '@canopy/protocol/canopy-core';
import type { PersistedToolOutputReference } from '@canopy/agent-transcript/types';
import { delegationStreamKey } from '../transcript-stream-paths';
import { fsyncDirectory } from '../fsync-directory';
import {
  recordChatStorageFileSync,
  recordChatStorageFileWrite,
} from '@canopy/desktop-shared/node/work-counters';
import {
  ChatDeltaJournalIntegrityError,
  ChatStorageNewerFormatError,
  transcriptTargetKey,
} from './format';
import type { ZodType } from 'zod';

const utf8 = new TextDecoder('utf-8', { fatal: true });
const digest = (bytes: Buffer): string =>
  createHash('sha256').update(bytes).digest('hex');
const emptyDigest = digest(Buffer.alloc(0));

function integrity(message: string, cause?: unknown): never {
  throw new ChatDeltaJournalIntegrityError(
    message,
    cause === undefined ? undefined : { cause },
  );
}

function parseStrict<T>(schema: ZodType<T>, value: unknown, label: string): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  if (
    parsed.error.issues.some(
      (issue) =>
        issue.code === 'unrecognized_keys' || issue.code === 'invalid_value',
    )
  )
    throw new ChatStorageNewerFormatError(
      `${label} contains a newer version or unknown fields`,
    );
  return integrity(`Invalid ${label}`);
}

function decodeJson(bytes: Buffer, label: string): unknown {
  try {
    return JSON.parse(utf8.decode(bytes));
  } catch (error) {
    return integrity(`Invalid ${label} JSON or UTF-8`, error);
  }
}

export interface StreamRegistryPaths {
  parentDirectory: string;
  registry: string;
  index: string;
  streamDirectory: string;
  descriptor: string;
  log: string;
}

export function streamRegistryPaths(
  root: string,
  parentChatId: string,
  streamKey: string,
): StreamRegistryPaths {
  // The parent path is independently host-validated by the caller; this
  // helper also refuses traversal for direct use by storage/recovery code.
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(parentChatId) ||
    !/^[a-f0-9]{64}$/.test(streamKey)
  )
    return integrity('Invalid stream registry identity');
  const parentDirectory = join(root, 'delegations', parentChatId, 'v2');
  const streamDirectory = join(parentDirectory, streamKey);
  return {
    parentDirectory,
    registry: join(parentDirectory, 'registry.jsonl'),
    index: join(parentDirectory, 'registry.index.json'),
    streamDirectory,
    descriptor: join(streamDirectory, 'descriptor.json'),
    log: join(streamDirectory, 'transcript.jsonl'),
  };
}

export function streamCatalogPath(root: string): string {
  return join(root, 'delegations', 'stream-catalog.json');
}

export function assertStreamRegistration(
  entry: TranscriptStreamRegistration,
  parentChatId: string,
): void {
  if (
    entry.target.chatId !== parentChatId ||
    delegationStreamKey(entry.target) !== entry.streamKey
  )
    integrity('Stream registration target/key mismatch');
}

/**
 * Whether stream metadata stamped at `revision` belongs under a catalog
 * published at `catalogRevision`. A checkpoint may leave a registry or a
 * descriptor it did not change at the checkpoint that last wrote it, so an
 * older stamp is valid: the catalog pins each registry by digest, and each
 * descriptor is checked against its log. A stamp newer than the catalog is a
 * publication still in progress, and a descriptor is never older than its
 * stream's registration.
 */
export function publishedAtOrBefore(
  revision: number,
  catalogRevision: number,
  registeredAtRevision = 0,
): boolean {
  return revision <= catalogRevision && revision >= registeredAtRevision;
}

export interface ParsedStreamRegistry {
  header: TranscriptStreamRegistryHeader;
  entries: TranscriptStreamRegistration[];
  bytes: Buffer;
  sha256: string;
}

export function encodeStreamRegistry(
  parentChatId: string,
  checkpointRevision: number,
  entries: readonly TranscriptStreamRegistration[],
): Buffer {
  const identities = new Set<string>();
  const keys = new Set<string>();
  for (const entry of entries) {
    const parsed = parseStrict(
      TranscriptStreamRegistrationSchema,
      entry,
      'stream registration',
    );
    assertStreamRegistration(parsed, parentChatId);
    const identity = transcriptTargetKey(parsed.target);
    if (identities.has(identity) || keys.has(parsed.streamKey))
      integrity('Duplicate stream registration');
    if (parsed.registeredAtRevision > checkpointRevision)
      integrity('Registration is newer than checkpoint');
    identities.add(identity);
    keys.add(parsed.streamKey);
  }
  const entryLines = Buffer.from(
    entries.map((entry) => `${JSON.stringify(entry)}\n`).join(''),
    'utf8',
  );
  const header = parseStrict(
    TranscriptStreamRegistryHeaderSchema,
    {
      type: 'stream-registry',
      version: 1,
      parentChatId,
      checkpointRevision,
      entryCount: entries.length,
      entriesSha256: digest(entryLines),
    },
    'stream registry header',
  );
  return Buffer.concat([
    Buffer.from(`${JSON.stringify(header)}\n`),
    entryLines,
  ]);
}

export function parseStreamRegistry(
  bytes: Buffer,
  parentChatId: string,
): ParsedStreamRegistry {
  if (bytes.length === 0 || bytes[bytes.length - 1] !== 10)
    integrity('Unterminated stream registry');
  let text: string;
  try {
    text = utf8.decode(bytes);
  } catch (error) {
    return integrity('Invalid stream registry UTF-8', error);
  }
  const firstEnd = bytes.indexOf(10);
  if (firstEnd < 0) integrity('Missing stream registry header');
  const header = parseStrict(
    TranscriptStreamRegistryHeaderSchema,
    decodeJson(bytes.subarray(0, firstEnd), 'stream registry header'),
    'stream registry header',
  );
  if (header.parentChatId !== parentChatId)
    integrity('Wrong stream registry parent');
  const entryBytes = bytes.subarray(firstEnd + 1);
  if (digest(entryBytes) !== header.entriesSha256)
    integrity('Stream registry entry hash mismatch');
  const lines = text.slice(firstEnd + 1).split('\n');
  lines.pop();
  if (lines.length !== header.entryCount)
    integrity('Stream registry entry count mismatch');
  const entries = lines.map((line) =>
    parseStrict(
      TranscriptStreamRegistrationSchema,
      decodeJson(Buffer.from(line), 'stream registration'),
      'stream registration',
    ),
  );
  const identities = new Set<string>();
  const keys = new Set<string>();
  for (const entry of entries) {
    assertStreamRegistration(entry, parentChatId);
    if (entry.registeredAtRevision > header.checkpointRevision)
      integrity('Registration is newer than checkpoint');
    const identity = transcriptTargetKey(entry.target);
    if (identities.has(identity) || keys.has(entry.streamKey))
      integrity('Duplicate stream registration');
    identities.add(identity);
    keys.add(entry.streamKey);
  }
  return { header, entries, bytes, sha256: digest(bytes) };
}

export interface StreamRegistryLocatorIndex {
  version: 1;
  registrySha256: string;
  registryBytes: number;
  entries: Record<string, { offset: number; length: number }>;
}

export function deriveStreamRegistryIndex(
  registry: ParsedStreamRegistry,
): StreamRegistryLocatorIndex {
  const entries: Record<string, { offset: number; length: number }> = {};
  let offset = registry.bytes.indexOf(10) + 1;
  for (const entry of registry.entries) {
    const end = registry.bytes.indexOf(10, offset);
    entries[entry.streamKey] = { offset, length: end + 1 - offset };
    offset = end + 1;
  }
  return {
    version: 1,
    registrySha256: registry.sha256,
    registryBytes: registry.bytes.length,
    entries,
  };
}

async function optionalRead(path: string): Promise<Buffer | undefined> {
  try {
    return await readFile(path);
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    )
      return undefined;
    throw error;
  }
}

export interface StreamRegistryReadOptions {
  /** Lease-free readers pass true so a stale locator is ignored, not rebuilt. */
  readOnly?: boolean;
  /** Verify digest and row count without buffering the whole log. */
  deep?: boolean;
  /** An unpublished checkpoint may already have appended finals past the descriptor. */
  logMayExtend?: boolean;
}

export class UnknownTranscriptStreamError extends Error {
  public override readonly name = 'UnknownTranscriptStreamError';
}

async function streamLogIdentity(path: string): Promise<{
  bytes: number;
  sha256: string;
  rows: number;
  terminated: boolean;
}> {
  const handle = await open(path, 'r');
  const hash = createHash('sha256');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let bytes = 0;
  let rows = 0;
  let last = -1;
  try {
    while (true) {
      const read = await handle.read(buffer, 0, buffer.length, bytes);
      if (read.bytesRead === 0) break;
      const chunk = buffer.subarray(0, read.bytesRead);
      hash.update(chunk);
      const text = decoder.decode(chunk, { stream: true });
      for (const character of text) if (character === '\n') rows += 1;
      last = chunk[chunk.length - 1];
      bytes += read.bytesRead;
    }
    decoder.decode();
  } finally {
    await handle.close();
  }
  return {
    bytes,
    sha256: hash.digest('hex'),
    rows,
    terminated: bytes === 0 || last === 10,
  };
}

/** Validate one registered target without traversing unrelated children. */
export async function validateStreamTarget(
  root: string,
  catalog: TranscriptStreamCatalog,
  target: TranscriptTarget,
  options: StreamRegistryReadOptions = {},
): Promise<TranscriptStreamDescriptor> {
  const parsedCatalog = parseStrict(
    TranscriptStreamCatalogSchema,
    catalog,
    'stream catalog',
  );
  if (target.kind !== 'delegation')
    throw new UnknownTranscriptStreamError('Unknown transcript stream');
  const reference = parsedCatalog.parents[target.chatId];
  if (!reference)
    throw new UnknownTranscriptStreamError('Unknown transcript stream');
  const registry = await loadStreamRegistry(root, target.chatId, options);
  if (
    !publishedAtOrBefore(
      registry.header.checkpointRevision,
      parsedCatalog.checkpointRevision,
    ) ||
    registry.header.entryCount !== reference.entryCount ||
    registry.bytes.length !== reference.registryBytes ||
    registry.sha256 !== reference.registrySha256
  )
    return integrity('Stream registry disagrees with catalog');
  const entry = registry.entries.find(
    (candidate) =>
      transcriptTargetKey(candidate.target) === transcriptTargetKey(target),
  );
  if (!entry)
    throw new UnknownTranscriptStreamError('Unknown transcript stream');
  const paths = streamRegistryPaths(root, target.chatId, entry.streamKey);
  const bytes = await optionalRead(paths.descriptor);
  if (!bytes) return integrity('Missing known stream descriptor');
  const descriptor = parseStreamDescriptor(bytes);
  let logSize: number;
  try {
    logSize = (await stat(paths.log)).size;
  } catch (error) {
    return integrity('Missing known stream log', error);
  }
  if (
    transcriptTargetKey(descriptor.target) !== transcriptTargetKey(target) ||
    descriptor.streamKey !== entry.streamKey ||
    !publishedAtOrBefore(
      descriptor.checkpointRevision,
      parsedCatalog.checkpointRevision,
      entry.registeredAtRevision,
    ) ||
    (options.logMayExtend
      ? descriptor.committedByteLength > logSize
      : descriptor.committedByteLength !== logSize)
  )
    return integrity('Stream descriptor/log mismatch');
  if (options.deep !== false) {
    let identity: Awaited<ReturnType<typeof streamLogIdentity>>;
    try {
      identity = await streamLogIdentity(paths.log);
    } catch (error) {
      return integrity('Invalid stream log', error);
    }
    if (
      identity.bytes !== descriptor.committedByteLength ||
      identity.sha256 !== descriptor.committedSha256 ||
      identity.rows !== descriptor.committedRowCount ||
      !identity.terminated
    )
      return integrity('Stream log row count, digest or termination mismatch');
  }
  if (
    (descriptor.status === 'open' && descriptor.settleReceipt !== null) ||
    (descriptor.status === 'settled' && descriptor.settleReceipt === null)
  )
    return integrity('Stream descriptor settlement mismatch');
  return descriptor;
}

/** Authoritative registry load; the locator is disposable and rebuilt if stale. */
export async function loadStreamRegistry(
  root: string,
  parentChatId: string,
  options: StreamRegistryReadOptions = {},
): Promise<ParsedStreamRegistry> {
  const paths = streamRegistryPaths(root, parentChatId, emptyDigest);
  const bytes = await optionalRead(paths.registry);
  if (!bytes) return integrity('Missing known stream registry');
  const registry = parseStreamRegistry(bytes, parentChatId);
  if (options.readOnly) return registry;
  const expected = deriveStreamRegistryIndex(registry);
  const existing = await optionalRead(paths.index);
  let matches = false;
  if (existing) {
    try {
      matches =
        JSON.stringify(decodeJson(existing, 'stream locator')) ===
        JSON.stringify(expected);
    } catch {
      matches = false;
    }
  }
  if (!matches)
    await publishStreamMetadata(
      paths.index,
      Buffer.from(JSON.stringify(expected)),
    );
  return registry;
}

export function createEmptyStreamDescriptor(
  entry: TranscriptStreamRegistration,
  checkpointRevision: number,
): TranscriptStreamDescriptor {
  return TranscriptStreamDescriptorSchema.parse({
    version: 1,
    target: entry.target,
    streamKey: entry.streamKey,
    checkpointRevision,
    ...(entry.openedAt === undefined ? {} : { openedAt: entry.openedAt }),
    status: 'open',
    streamRevision: 0,
    committedRowCount: 0,
    latestRowTimestamp: null,
    committedByteLength: 0,
    committedSha256: emptyDigest,
    settleReceipt: null,
    cardState: null,
  });
}

/** Journal-order compare-and-set; settlement identity is immutable. */
export function applyStreamDescriptorUpdate(
  descriptor: TranscriptStreamDescriptor,
  update: TranscriptStreamDescriptorUpdate,
): TranscriptStreamDescriptor {
  if (
    transcriptTargetKey(descriptor.target) !==
      transcriptTargetKey(update.target) ||
    descriptor.streamRevision !== update.expectedStreamRevision ||
    update.nextStreamRevision !== update.expectedStreamRevision + 1
  )
    return integrity('Stream descriptor revision mismatch');
  if (
    descriptor.status === 'settled' &&
    (update.status !== undefined || update.settleReceipt !== undefined)
  )
    return integrity('Settled stream descriptor is immutable');
  if (update.status === 'settled' && !update.settleReceipt)
    return integrity('Stream settlement requires receipt');
  if (
    update.settleReceipt &&
    (update.status !== 'settled' ||
      descriptor.settleReceipt !== null ||
      update.settleReceipt.streamRevision !== update.nextStreamRevision)
  )
    return integrity('Stream settlement receipt mismatch');
  return TranscriptStreamDescriptorSchema.parse({
    ...descriptor,
    streamRevision: update.nextStreamRevision,
    ...(update.cardState === undefined ? {} : { cardState: update.cardState }),
    ...(update.latestRowTimestamp === undefined
      ? {}
      : { latestRowTimestamp: update.latestRowTimestamp }),
    ...(update.status === undefined ? {} : { status: update.status }),
    ...(update.settleReceipt === undefined
      ? {}
      : { settleReceipt: update.settleReceipt }),
  });
}

export function parseStreamDescriptor(
  bytes: Buffer,
): TranscriptStreamDescriptor {
  return parseStrict(
    TranscriptStreamDescriptorSchema,
    decodeJson(bytes, 'stream descriptor'),
    'stream descriptor',
  );
}

export function encodeStreamDescriptor(
  descriptor: TranscriptStreamDescriptor,
): Buffer {
  const parsed = parseStrict(
    TranscriptStreamDescriptorSchema,
    descriptor,
    'stream descriptor',
  );
  return Buffer.from(JSON.stringify(parsed), 'utf8');
}

/** Enumerate the canonical answer bodies retained by a stream descriptor. */
export function streamDescriptorAnswerReferences(
  descriptor: TranscriptStreamDescriptor,
): readonly PersistedToolOutputReference[] {
  const cardState = descriptor.cardState;
  if (!cardState || cardState.version !== 2 || !cardState.canonical) return [];

  const references: PersistedToolOutputReference[] = [];
  if (cardState.canonical.finalTextRef)
    references.push(cardState.canonical.finalTextRef);
  if (cardState.canonical.partialTextRef)
    references.push(cardState.canonical.partialTextRef);
  return references;
}

export function parseStreamCatalog(bytes: Buffer): TranscriptStreamCatalog {
  return parseStrict(
    TranscriptStreamCatalogSchema,
    decodeJson(bytes, 'stream catalog'),
    'stream catalog',
  );
}

export function encodeStreamCatalog(catalog: TranscriptStreamCatalog): Buffer {
  const parsed = parseStrict(
    TranscriptStreamCatalogSchema,
    catalog,
    'stream catalog',
  );
  return Buffer.from(JSON.stringify(parsed), 'utf8');
}

export async function loadStreamCatalog(
  root: string,
): Promise<TranscriptStreamCatalog> {
  const bytes = await optionalRead(streamCatalogPath(root));
  if (!bytes) return integrity('Missing stream catalog');
  return parseStreamCatalog(bytes);
}

/** Write and sync a named staged file; callers can publish in marker order. */
export async function stageStreamMetadata(
  path: string,
  bytes: Buffer,
): Promise<string> {
  const staged = `${path}.checkpoint`;
  await mkdir(dirname(staged), { recursive: true });
  const handle = await open(staged, 'w');
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  recordChatStorageFileWrite(staged, bytes.length, true);
  recordChatStorageFileSync(staged);
  return staged;
}

/** Atomic authoritative publication, including a directory durability fence. */
export async function publishStagedStreamMetadata(
  staged: string,
  path: string,
): Promise<void> {
  await rename(staged, path);
  await fsyncDirectory(dirname(path));
}

export async function publishStreamMetadata(
  path: string,
  bytes: Buffer,
): Promise<void> {
  const staged = await stageStreamMetadata(path, bytes);
  await publishStagedStreamMetadata(staged, path);
}

/** Validate a catalog-rooted checkpoint without treating missing authority as empty. */
/**
 * Checkpointed format 4 only, where the indexes are complete: a compatibility
 * transaction that deleted a parent leaves its catalog entry and tree behind.
 * Drop the entry, then remove every delegation tree no indexed chat owns, which
 * also sweeps trees an interrupted earlier prune left unnamed.
 */
export async function pruneStreamCatalog(
  root: string,
  indexedChatIds: ReadonlySet<string>,
): Promise<void> {
  const catalog = await loadStreamCatalog(root);
  const parents = Object.fromEntries(
    Object.entries(catalog.parents).filter(([id]) => indexedChatIds.has(id)),
  );
  if (Object.keys(parents).length !== Object.keys(catalog.parents).length)
    await publishStreamMetadata(
      streamCatalogPath(root),
      Buffer.from(JSON.stringify({ ...catalog, parents })),
    );
  let owners: Dirent[];
  try {
    owners = await readdir(join(root, 'delegations'), { withFileTypes: true });
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    )
      return;
    throw error;
  }
  for (const owner of owners)
    if (owner.isDirectory() && !indexedChatIds.has(owner.name))
      await rm(join(root, 'delegations', owner.name), {
        recursive: true,
        force: true,
      });
}

export async function validateStreamClosure(
  root: string,
  catalog: TranscriptStreamCatalog,
  options: StreamRegistryReadOptions = {},
): Promise<void> {
  const parsedCatalog = parseStrict(
    TranscriptStreamCatalogSchema,
    catalog,
    'stream catalog',
  );
  for (const [parentChatId, reference] of Object.entries(
    parsedCatalog.parents,
  )) {
    const registry = await loadStreamRegistry(root, parentChatId, options);
    if (
      !publishedAtOrBefore(
        registry.header.checkpointRevision,
        parsedCatalog.checkpointRevision,
      ) ||
      registry.header.entryCount !== reference.entryCount ||
      registry.bytes.length !== reference.registryBytes ||
      registry.sha256 !== reference.registrySha256
    )
      integrity('Stream registry disagrees with catalog');
    for (const entry of registry.entries) {
      const paths = streamRegistryPaths(root, parentChatId, entry.streamKey);
      const descriptorBytes = await optionalRead(paths.descriptor);
      let logSize: number;
      try {
        logSize = (await stat(paths.log)).size;
      } catch (error) {
        return integrity('Missing known stream descriptor or log', error);
      }
      if (!descriptorBytes) integrity('Missing known stream descriptor or log');
      const descriptor = parseStreamDescriptor(descriptorBytes);
      if (
        transcriptTargetKey(descriptor.target) !==
          transcriptTargetKey(entry.target) ||
        descriptor.streamKey !== entry.streamKey ||
        !publishedAtOrBefore(
          descriptor.checkpointRevision,
          parsedCatalog.checkpointRevision,
          entry.registeredAtRevision,
        ) ||
        (options.logMayExtend
          ? descriptor.committedByteLength > logSize
          : descriptor.committedByteLength !== logSize)
      )
        integrity('Stream descriptor/log mismatch');
      if (options.deep) {
        let identity: Awaited<ReturnType<typeof streamLogIdentity>>;
        try {
          identity = await streamLogIdentity(paths.log);
        } catch (error) {
          return integrity('Invalid stream log', error);
        }
        if (
          identity.bytes !== descriptor.committedByteLength ||
          identity.sha256 !== descriptor.committedSha256 ||
          identity.rows !== descriptor.committedRowCount ||
          !identity.terminated
        )
          integrity('Stream log row count, digest or termination mismatch');
      }
      if (
        (descriptor.status === 'open' && descriptor.settleReceipt !== null) ||
        (descriptor.status === 'settled' && descriptor.settleReceipt === null)
      )
        integrity('Stream descriptor settlement mismatch');
    }
  }
}
