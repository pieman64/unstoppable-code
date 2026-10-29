import { createHash } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import {
  PORTAL_ASSET_CHUNK_BYTES,
  PORTAL_ASSET_MAX_BYTES,
  type PortalAssetReadRange,
  type PortalAssetReadResult,
} from '@canopy/protocol/portal';
import { portalAttachmentMediaTypeForFilename } from '@canopy/protocol/cloud-attachments';
import { PortalServiceError } from './portal-service-error';
import { openPortalAssetFiles } from '../agents/delegation/file-process';

function fingerprint(stats: BigIntStats): string {
  return createHash('sha256')
    .update(
      `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}`,
    )
    .digest('hex');
}

function inside(path: string, root: string): boolean {
  const remainder = relative(root, path);
  return (
    remainder !== '..' &&
    !remainder.startsWith(`..${sep}`) &&
    !isAbsolute(remainder)
  );
}

function requireReadPermission(canRead?: () => boolean): void {
  if (canRead && !canRead()) {
    throw new PortalServiceError(
      'invalid_target',
      'The paired asset session is no longer authorized.',
    );
  }
}

function readOffset(
  range: PortalAssetReadRange,
  size: number,
  version: string,
  validateVersion = true,
): number {
  const offset = range.offset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > size) {
    throw new PortalServiceError(
      'invalid_payload',
      'Invalid asset byte offset.',
    );
  }
  if (
    validateVersion &&
    ((offset > 0 && !range.version) ||
      (range.version !== undefined && range.version !== version))
  ) {
    throw new PortalServiceError(
      'invalid_target',
      'The asset changed. Restart the download.',
    );
  }
  if (size > PORTAL_ASSET_MAX_BYTES) {
    throw new PortalServiceError(
      'invalid_target',
      'This asset exceeds the 100 MiB transfer limit.',
    );
  }
  return offset;
}

function resultFor(
  bytes: Buffer,
  input: {
    assetId: string;
    filename: string;
    mediaType: string;
    size: number;
    version: string;
    offset: number;
  },
): PortalAssetReadResult {
  const end = input.offset + bytes.byteLength;
  return {
    ...input,
    dataBase64: bytes.toString('base64'),
    contentSha256: createHash('sha256').update(bytes).digest('hex'),
    nextOffset: end < input.size ? end : null,
  };
}

async function inspectPath(
  path: string,
  root: string,
): Promise<Map<string, string>> {
  if (!inside(path, root) || path === root) {
    throw new PortalServiceError(
      'invalid_target',
      'The asset is outside its authorized root.',
    );
  }
  const identities = new Map<string, string>();
  let current = root;
  const segments = relative(root, path).split(sep);
  for (let index = -1; index < segments.length; index += 1) {
    if (index >= 0) current = resolve(current, segments[index]);
    const stats = await lstat(current, { bigint: true });
    if (
      stats.isSymbolicLink() ||
      (index < segments.length - 1 && !stats.isDirectory())
    ) {
      throw new PortalServiceError(
        'invalid_target',
        'Linked asset paths are not supported.',
      );
    }
    if (index === segments.length - 1 && !stats.isFile()) {
      throw new PortalServiceError(
        'invalid_target',
        'The asset is not a regular file.',
      );
    }
    identities.set(
      current,
      stats.isDirectory() ? `${stats.dev}:${stats.ino}` : fingerprint(stats),
    );
  }
  return identities;
}

type PortalAssetFiles = Awaited<ReturnType<typeof openPortalAssetFiles>>;

/**
 * One broker session per original transfer. The first chunk starts a broker
 * that walks the path without following links; continuation chunks carrying
 * that transfer's version reuse it, and the broker reads them from the file it
 * already opened. Every chunk is still compared with the host-checked path.
 */
interface PortalAssetTransfer {
  key?: string;
  files: PortalAssetFiles;
  abort: AbortController;
  active: number;
  retired: boolean;
  idleTimer?: ReturnType<typeof setTimeout>;
}

const assetTransfers = new Map<string, PortalAssetTransfer>();
const ASSET_TRANSFER_IDLE_MS = 30_000;
const ASSET_TRANSFER_LIMIT = 8;

function assetTransferKey(
  root: string,
  relativePath: string,
  version: string,
): string {
  return JSON.stringify([root, relativePath, version]);
}

function retireAssetTransfer(transfer: PortalAssetTransfer): void {
  if (
    transfer.key !== undefined &&
    assetTransfers.get(transfer.key) === transfer
  )
    assetTransfers.delete(transfer.key);
  transfer.retired = true;
  if (transfer.idleTimer) clearTimeout(transfer.idleTimer);
  transfer.idleTimer = undefined;
  if (transfer.active === 0) {
    transfer.abort.abort();
    void transfer.files.close().catch(() => undefined);
  }
}

function releaseAssetTransfer(transfer: PortalAssetTransfer): void {
  transfer.active -= 1;
  if (transfer.active > 0) return;
  if (transfer.retired) {
    retireAssetTransfer(transfer);
    return;
  }
  transfer.idleTimer = setTimeout(
    () => retireAssetTransfer(transfer),
    ASSET_TRANSFER_IDLE_MS,
  );
  transfer.idleTimer.unref();
}

function registerAssetTransfer(
  transfer: PortalAssetTransfer,
  key: string,
): void {
  const previous = assetTransfers.get(key);
  if (previous && previous !== transfer) retireAssetTransfer(previous);
  transfer.key = key;
  assetTransfers.set(key, transfer);
  for (const [oldest, entry] of Array.from(assetTransfers)) {
    if (assetTransfers.size <= ASSET_TRANSFER_LIMIT) break;
    if (oldest !== key) retireAssetTransfer(entry);
  }
}

function isDelegationFileError(error: unknown): error is Error {
  return error instanceof Error && error.name === 'DelegationFileAccessError';
}

function isRefusedByBroker(error: unknown): boolean {
  return (
    isDelegationFileError(error) && 'kind' in error && error.kind === 'refused'
  );
}

async function startAssetTransfer(root: string): Promise<PortalAssetTransfer> {
  const abort = new AbortController();
  const files = await openPortalAssetFiles(root, abort.signal);
  return { files, abort, active: 1, retired: false };
}

/** The transfer a single chunk read currently holds, released exactly once. */
interface AssetTransferLease {
  transfer?: PortalAssetTransfer;
}

type PortalAssetChunk = Awaited<ReturnType<PortalAssetFiles['readAsset']>>;

/** Reuse the session of a running transfer, or start one for a new transfer. */
async function acquireAssetTransfer(
  lease: AssetTransferLease,
  root: string,
  relativePath: string,
  range: PortalAssetReadRange,
): Promise<PortalAssetTransfer> {
  const cached =
    (range.offset ?? 0) > 0 && range.version !== undefined
      ? assetTransfers.get(assetTransferKey(root, relativePath, range.version))
      : undefined;
  if (cached && !cached.retired) {
    if (cached.idleTimer) clearTimeout(cached.idleTimer);
    cached.idleTimer = undefined;
    cached.active += 1;
    lease.transfer = cached;
    return cached;
  }
  const started = await startAssetTransfer(root);
  lease.transfer = started;
  return started;
}

async function readLeasedAssetChunk(
  lease: AssetTransferLease,
  input: {
    root: string;
    relativePath: string;
    range: PortalAssetReadRange;
    canRead?: () => boolean;
  },
): Promise<PortalAssetChunk> {
  const offset = input.range.offset ?? 0;
  const transfer = await acquireAssetTransfer(
    lease,
    input.root,
    input.relativePath,
    input.range,
  );
  const reused = transfer.key !== undefined;
  requireReadPermission(input.canRead);
  try {
    return await transfer.files.readAsset(input.relativePath, offset);
  } catch (error) {
    // A shared session can stop (for example after its byte budget); a
    // continuation then starts its own session once instead of failing.
    if (!reused || isRefusedByBroker(error)) throw error;
    lease.transfer = undefined;
    retireAssetTransfer(transfer);
    releaseAssetTransfer(transfer);
    const replacement = await startAssetTransfer(input.root);
    lease.transfer = replacement;
    requireReadPermission(input.canRead);
    return replacement.files.readAsset(input.relativePath, offset);
  }
}

/** Close every cached broker session, for example when Portal stops. */
export function closePortalAssetTransfers(): void {
  for (const transfer of Array.from(assetTransfers.values()))
    retireAssetTransfer(transfer);
}

export async function readPortalAssetFile(input: {
  path: string;
  root: string;
  excludedRoots?: readonly string[];
  assetId: string;
  range: PortalAssetReadRange;
  canRead?: () => boolean;
}): Promise<PortalAssetReadResult> {
  requireReadPermission(input.canRead);
  const path = resolve(input.path);
  const root = resolve(input.root);
  if (
    input.excludedRoots?.some((excluded) => inside(path, resolve(excluded)))
  ) {
    throw new PortalServiceError(
      'invalid_target',
      'The asset is inside an excluded root.',
    );
  }
  const lease: AssetTransferLease = {};
  let completed = false;
  try {
    const identities = await inspectPath(path, root);
    const rootReal = await realpath(root);
    const pathReal = await realpath(path);
    if (!inside(pathReal, rootReal)) {
      throw new PortalServiceError(
        'invalid_target',
        'The asset is outside its authorized root.',
      );
    }
    requireReadPermission(input.canRead);
    const initial = await lstat(path, { bigint: true });
    readOffset(input.range, Number(initial.size), '', false);
    const relativePath = relative(root, path).split(sep).join('/');
    const { bytes, size, version, snapshot } = await readLeasedAssetChunk(
      lease,
      { root, relativePath, range: input.range, canRead: input.canRead },
    );
    const offset = readOffset(input.range, size, version);
    requireReadPermission(input.canRead);
    const currentIdentities = await inspectPath(path, root);
    const openedFingerprint = createHash('sha256')
      .update(
        `${snapshot.device}:${snapshot.inode}:${snapshot.size}:${snapshot.modifiedNs}:${snapshot.changedNs}`,
      )
      .digest('hex');
    if (
      identities.get(path) !== openedFingerprint ||
      bytes.byteLength !== Math.min(PORTAL_ASSET_CHUNK_BYTES, size - offset) ||
      Array.from(identities).some(
        ([entry, identity]) => currentIdentities.get(entry) !== identity,
      )
    ) {
      throw new PortalServiceError(
        'invalid_target',
        'The asset changed during the download.',
      );
    }
    const filename = basename(path);
    requireReadPermission(input.canRead);
    const result = resultFor(bytes, {
      assetId: input.assetId,
      filename,
      mediaType: portalAttachmentMediaTypeForFilename(filename),
      size,
      version,
      offset,
    });
    const transfer = lease.transfer;
    if (transfer && result.nextOffset === null) retireAssetTransfer(transfer);
    else if (transfer && transfer.key === undefined)
      registerAssetTransfer(
        transfer,
        assetTransferKey(root, relativePath, version),
      );
    completed = true;
    return result;
  } catch (error) {
    if (error instanceof PortalServiceError) throw error;
    if (isDelegationFileError(error)) {
      throw new PortalServiceError(
        'invalid_target',
        'Linked asset paths or changed originals cannot be read.',
      );
    }
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      throw new PortalServiceError(
        'not_found',
        'The original asset is no longer available.',
      );
    }
    throw new PortalServiceError(
      'invalid_target',
      'The original asset could not be safely opened.',
    );
  } finally {
    const transfer = lease.transfer;
    if (transfer) {
      if (!completed) retireAssetTransfer(transfer);
      releaseAssetTransfer(transfer);
    }
  }
}

interface InlineAssetMetadata {
  dataUrl: string;
  encodedStart: number;
  mediaType: string;
  size: number;
  version: string;
  expiresAt: number;
  expiryTimer?: ReturnType<typeof setTimeout>;
}

const inlineAssets = new Map<string, InlineAssetMetadata>();
const INLINE_ASSET_CACHE_BYTES =
  Math.ceil(PORTAL_ASSET_MAX_BYTES / 3) * 8 + 1024;
const INLINE_ASSET_CACHE_ENTRIES = 16;
const INLINE_ASSET_CACHE_TTL_MS = 60_000;

function evictInlineAsset(assetId: string): void {
  const metadata = inlineAssets.get(assetId);
  if (metadata?.expiryTimer) clearTimeout(metadata.expiryTimer);
  inlineAssets.delete(assetId);
}

function scheduleInlineExpiry(
  assetId: string,
  metadata: InlineAssetMetadata,
): void {
  metadata.expiryTimer = setTimeout(
    () => {
      if (inlineAssets.get(assetId) !== metadata) return;
      if (metadata.expiresAt <= Date.now()) evictInlineAsset(assetId);
      else scheduleInlineExpiry(assetId, metadata);
    },
    Math.max(1, metadata.expiresAt - Date.now()),
  );
  metadata.expiryTimer.unref();
}

function inlineMetadata(assetId: string, dataUrl: string): InlineAssetMetadata {
  const now = Date.now();
  const cached = inlineAssets.get(assetId);
  if (cached && cached.expiresAt > now && cached.dataUrl === dataUrl) {
    cached.expiresAt = now + INLINE_ASSET_CACHE_TTL_MS;
    return cached;
  }
  const separator = dataUrl.slice(0, 64).indexOf(',');
  const header = dataUrl.slice(0, separator);
  const match = /^data:(image\/(?:png|jpeg|gif|webp));base64$/.exec(header);
  const encodedStart = separator + 1;
  const encodedLength = dataUrl.length - encodedStart;
  if (!match || encodedLength % 4 !== 0) {
    throw new PortalServiceError(
      'invalid_target',
      'The inline image format is not supported.',
    );
  }
  if (encodedLength > Math.ceil(PORTAL_ASSET_MAX_BYTES / 3) * 4) {
    throw new PortalServiceError(
      'invalid_target',
      'This asset exceeds the 100 MiB transfer limit.',
    );
  }
  const tail = dataUrl.slice(Math.max(encodedStart, dataUrl.length - 4));
  if (Buffer.from(tail, 'base64').toString('base64') !== tail) {
    throw new PortalServiceError(
      'invalid_target',
      'The inline image is malformed.',
    );
  }
  const padding = dataUrl.endsWith('==') ? 2 : dataUrl.endsWith('=') ? 1 : 0;
  const encodedEnd = dataUrl.length - padding;
  for (
    let offset = encodedStart;
    offset < encodedEnd;
    offset += PORTAL_ASSET_CHUNK_BYTES
  ) {
    if (
      !/^[A-Za-z0-9+/]+$/.test(
        dataUrl.slice(
          offset,
          Math.min(encodedEnd, offset + PORTAL_ASSET_CHUNK_BYTES),
        ),
      )
    ) {
      throw new PortalServiceError(
        'invalid_target',
        'The inline image is malformed.',
      );
    }
  }
  const metadata: InlineAssetMetadata = {
    dataUrl,
    encodedStart,
    mediaType: match[1],
    size: (encodedLength / 4) * 3 - padding,
    version: createHash('sha256').update(dataUrl).digest('hex'),
    expiresAt: now + INLINE_ASSET_CACHE_TTL_MS,
  };
  evictInlineAsset(assetId);
  let retainedBytes = metadata.dataUrl.length * 2;
  const retained = Array.from(inlineAssets);
  for (let index = retained.length - 1; index >= 0; index -= 1) {
    const [key, value] = retained[index];
    const nextRetainedBytes = retainedBytes + value.dataUrl.length * 2;
    if (
      value.expiresAt <= now ||
      nextRetainedBytes > INLINE_ASSET_CACHE_BYTES ||
      inlineAssets.size >= INLINE_ASSET_CACHE_ENTRIES
    ) {
      evictInlineAsset(key);
    } else {
      retainedBytes = nextRetainedBytes;
    }
  }
  if (metadata.dataUrl.length * 2 <= INLINE_ASSET_CACHE_BYTES) {
    inlineAssets.set(assetId, metadata);
    scheduleInlineExpiry(assetId, metadata);
  }
  return metadata;
}

export function readPortalAssetDataUrl(input: {
  assetId: string;
  dataUrl: string;
  range: PortalAssetReadRange;
  canRead?: () => boolean;
}): PortalAssetReadResult {
  requireReadPermission(input.canRead);
  const { encodedStart, mediaType, size, version } = inlineMetadata(
    input.assetId,
    input.dataUrl,
  );
  const offset = readOffset(input.range, size, version);
  const start = Math.floor(offset / 3) * 4;
  const end =
    Math.ceil(Math.min(size, offset + PORTAL_ASSET_CHUNK_BYTES) / 3) * 4;
  const bytes = Buffer.from(
    input.dataUrl.slice(encodedStart + start, encodedStart + end),
    'base64',
  );
  const leadingBytes = offset % 3;
  requireReadPermission(input.canRead);
  return resultFor(
    bytes.subarray(leadingBytes, leadingBytes + PORTAL_ASSET_CHUNK_BYTES),
    {
      assetId: input.assetId,
      filename: `image.${mediaType === 'image/jpeg' ? 'jpg' : mediaType.slice(6)}`,
      mediaType,
      size,
      version,
      offset,
    },
  );
}
