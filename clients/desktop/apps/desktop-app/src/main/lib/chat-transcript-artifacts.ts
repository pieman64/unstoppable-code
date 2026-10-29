import { isArtifactDispatchTool } from '@canopy/desktop-shared/lib/agent-artifact-projection';
import {
  extractCanonicalAgentArtifacts,
  MAX_AGENT_ARTIFACT_OUTPUT_CHARS,
  serializeAgentArtifactReceipts,
} from '@canopy/protocol/agent-artifacts';
import { createHash, randomUUID } from 'node:crypto';
import {
  copyFile,
  mkdir,
  open,
  opendir,
  rename,
  rm,
  stat,
  type FileHandle,
} from 'node:fs/promises';
import type { Dir } from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  PersistedChatMessage,
  PersistedToolOutputReference,
  PersistedVisualReference,
} from '@canopy/agent-transcript/types';
import {
  clampVisualHeight,
  findVisualTokens,
  isVisualId,
  VISUAL_PREPARED_MAX_BYTES,
  VISUAL_TITLE_MAX_LENGTH,
  type PersistedArtifactReference,
} from '@canopy/agent-transcript/lib/visual-ref';
import {
  TOOL_OUTPUT_INLINE_BYTES,
  TOOL_OUTPUT_PREVIEW_HEAD_BYTES,
} from '@canopy/agent-transcript/transcript-storage';
import {
  recordChatStorageArtifactPublished,
  recordChatStorageAtomicReplacement,
  recordChatStorageFileSync,
  recordChatStorageFileWrite,
} from '@canopy/desktop-shared/node/work-counters';
import {
  storedArtifactLocations,
  storedArtifactRefsOf,
  type StoredArtifactFamily,
} from './chat-artifact-references';
import { fsyncDirectory } from './fsync-directory';
import { isErrnoException } from './type-guards';
import {
  SHOW_VISUAL_TOOL_KEY,
  type ExternalizeVisualContext,
  type PromotedVisual,
  type StagedVisual,
} from './chat-visual-contracts';

interface VisualContentReference {
  artifactId: string;
  byteLength: number;
  sha256: string;
}

export function assertTranscriptIdentity(id: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/.test(id)) {
    throw new Error('Invalid transcript identity');
  }
}

function utf8Prefix(value: string, bytes: number): string {
  let end = 0;
  let used = 0;
  while (end < value.length) {
    const point = value.codePointAt(end);
    if (point === undefined) break;
    const size = point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
    if (used + size > bytes) break;
    used += size;
    end += point > 0xffff ? 2 : 1;
  }
  return value.slice(0, end);
}

function preview(output: string): string {
  const marker = '\n[Full output stored separately]\n';
  const head = utf8Prefix(output, TOOL_OUTPUT_PREVIEW_HEAD_BYTES);
  const tailBudget =
    TOOL_OUTPUT_INLINE_BYTES - Buffer.byteLength(head + marker);
  let start = output.length;
  let used = 0;
  while (start > 0) {
    const last = output.charCodeAt(start - 1);
    const prior = start >= 2 ? output.charCodeAt(start - 2) : 0;
    const paired =
      last >= 0xdc00 && last <= 0xdfff && prior >= 0xd800 && prior <= 0xdbff;
    const size = paired ? 4 : last < 0x80 ? 1 : last < 0x800 ? 2 : 3;
    if (used + size > tailBudget) break;
    used += size;
    start -= paired ? 2 : 1;
  }
  return head + marker + output.slice(start);
}

function* encodedOutputChunks(
  output: string,
  encoding: 'utf-8' | 'utf-16le',
  buffer: Buffer,
): Generator<Buffer> {
  const nodeEncoding = encoding === 'utf-8' ? 'utf8' : 'utf16le';
  for (let start = 0; start < output.length; ) {
    let end = Math.min(output.length, start + 16_384);
    if (end < output.length && /[\uD800-\uDBFF]/.test(output.charAt(end - 1)))
      end -= 1;
    const written = buffer.write(
      output.slice(start, end),
      0,
      buffer.length,
      nodeEncoding,
    );
    // The caller must consume each view before advancing: the next chunk
    // overwrites this same backing buffer.
    yield buffer.subarray(0, written);
    start = end;
  }
}

function isArtifactIntegrityError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message === 'Tool output artifact failed integrity validation' ||
      error.message === 'Visual artifact failed integrity validation')
  );
}

function isWellFormedUtf16(value: string): boolean {
  return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
    value,
  );
}

function sameOwner(
  left: { messageId: string; toolUseId: string },
  right: { messageId: string; toolUseId: string },
): boolean {
  return (
    left.messageId === right.messageId && left.toolUseId === right.toolUseId
  );
}

function stagedVisualMatches(
  staged: StagedVisual,
  chatId: string,
  visualId: string,
): boolean {
  const { sidecar, html } = staged;
  if (
    !isVisualId(visualId) ||
    sidecar.version !== 1 ||
    sidecar.visualId !== visualId ||
    sidecar.chatId !== chatId ||
    sidecar.toolKey !== SHOW_VISUAL_TOOL_KEY ||
    !/^[a-f0-9]{64}$/.test(sidecar.sha256) ||
    !Number.isSafeInteger(sidecar.byteLength) ||
    sidecar.byteLength < 0 ||
    sidecar.byteLength > VISUAL_PREPARED_MAX_BYTES ||
    !isWellFormedUtf16(html)
  ) {
    return false;
  }
  const title = sidecar.title.trim();
  if (
    title.length === 0 ||
    title.length > VISUAL_TITLE_MAX_LENGTH ||
    title !== sidecar.title ||
    !Number.isFinite(sidecar.maxHeight) ||
    sidecar.maxHeight !== clampVisualHeight(sidecar.maxHeight)
  ) {
    return false;
  }
  const bytes = Buffer.from(html, 'utf8');
  return (
    bytes.length === sidecar.byteLength &&
    createHash('sha256').update(bytes).digest('hex') === sidecar.sha256
  );
}

/**
 * Artifact files one operation created rather than found in place. Because
 * artifacts are content addressed and every earlier transaction published
 * its own artifacts before its journal record, a file this operation created
 * is referenced by no committed row, active sidecar, or pending payload until
 * the operation's own record publishes. Discarding is therefore exact and
 * needs no reachability scan.
 */
export class CreatedArtifacts {
  private readonly paths = new Set<string>();

  public add(path: string): void {
    this.paths.add(path);
  }

  public get size(): number {
    return this.paths.size;
  }

  /** Remove every tracked file and sync each affected directory. */
  public async discard(): Promise<void> {
    const directories = new Set<string>();
    for (const path of Array.from(this.paths)) {
      await rm(path, { force: true });
      directories.add(dirname(path));
    }
    this.paths.clear();
    for (const directory of Array.from(directories))
      await fsyncDirectory(directory);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return false;
    throw error;
  }
}

/** File paths are derived exclusively from validated identities. */
export class ChatTranscriptArtifacts {
  private readonly verified = new Map<string, string>();
  public constructor(
    private readonly transcriptsRoot: string,
    private readonly readOnly = false,
  ) {}

  private directory(
    chatId: string,
    family: StoredArtifactFamily = 'tool-output',
  ): string {
    assertTranscriptIdentity(chatId);
    const location = Array.from(storedArtifactLocations()).find(
      (item) => item.family === family,
    );
    if (!location) throw new Error('Unknown transcript artifact family');
    return join(this.transcriptsRoot, location.directory, chatId);
  }

  /** The caller owns and closes this bounded maintenance iterator. */
  public async openCandidateDirectory(
    chatId: string,
    family: StoredArtifactFamily = 'tool-output',
  ): Promise<Dir | undefined> {
    try {
      return await opendir(this.directory(chatId, family));
    } catch (error) {
      if (isErrnoException(error) && error.code === 'ENOENT') return undefined;
      throw error;
    }
  }

  /** Only a complete canonical reachability pass may authorize these names. */
  public async reclaimCandidates(
    chatId: string,
    artifactIds: readonly string[],
    family: StoredArtifactFamily = 'tool-output',
  ): Promise<void> {
    if (this.readOnly) throw new Error('Transcript store is read-only');
    const directory = this.directory(chatId, family);
    const extension = family === 'visual' ? '.html' : '.txt';
    for (const artifactId of artifactIds) {
      if (!/^sha256-v1-[a-f0-9]{64}$/.test(artifactId))
        throw new Error(
          family === 'visual'
            ? 'Invalid visual artifact identity'
            : 'Invalid tool output artifact identity',
        );
      await rm(join(directory, `${artifactId}${extension}`), { force: true });
      this.verified.delete(
        `${family === 'visual' ? 'visual:' : ''}${artifactId.slice('sha256-v1-'.length)}`,
      );
    }
    if (artifactIds.length) await fsyncDirectory(directory);
  }

  private path(chatId: string, ref: PersistedToolOutputReference): string {
    if (
      ref.version !== 1 ||
      !['utf-8', 'utf-16le'].includes(ref.encoding) ||
      ref.mediaType !== 'text/plain' ||
      !/^[a-f0-9]{64}$/.test(ref.sha256) ||
      ref.artifactId !== `sha256-v1-${ref.sha256}` ||
      !Number.isSafeInteger(ref.byteLength) ||
      ref.byteLength < 0
    )
      throw new Error('Invalid tool output reference');
    return join(this.directory(chatId), `${ref.artifactId}.txt`);
  }

  private visualContentPath(
    chatId: string,
    ref: VisualContentReference,
  ): string {
    assertTranscriptIdentity(chatId);
    if (
      !/^[a-f0-9]{64}$/.test(ref.sha256) ||
      ref.artifactId !== `sha256-v1-${ref.sha256}` ||
      !Number.isSafeInteger(ref.byteLength) ||
      ref.byteLength < 0 ||
      ref.byteLength > VISUAL_PREPARED_MAX_BYTES
    ) {
      throw new Error('Invalid visual reference');
    }
    return join(this.directory(chatId, 'visual'), `${ref.artifactId}.html`);
  }

  private visualPath(chatId: string, ref: PersistedVisualReference): string {
    if (
      ref.version !== 1 ||
      ref.mediaType !== 'text/html' ||
      !isVisualId(ref.visualId)
    ) {
      throw new Error('Invalid visual reference');
    }
    return this.visualContentPath(chatId, ref);
  }

  /** Sync an existing, verified file and its directory before reusing it. */
  private async syncIfVerified(
    chatId: string,
    ref: PersistedToolOutputReference,
  ): Promise<boolean> {
    let handle: FileHandle;
    try {
      // Windows requires write access to sync a file handle.
      handle = await open(this.path(chatId, ref), 'r+');
    } catch (error) {
      if (isErrnoException(error) && error.code === 'ENOENT') return false;
      throw error;
    }
    try {
      try {
        await this.verifyHandle(handle, ref);
      } catch (error) {
        if (isArtifactIntegrityError(error)) return false;
        throw error;
      }
      await handle.sync();
      recordChatStorageFileSync(this.path(chatId, ref));
    } finally {
      await handle.close();
    }
    await fsyncDirectory(this.directory(chatId));
    return true;
  }

  /** Content-addressed publication with durable reuse of verified bytes. */
  public async put(
    chatId: string,
    output: string,
    created?: CreatedArtifacts,
  ): Promise<PersistedToolOutputReference> {
    if (this.readOnly) throw new Error('Tool output store is read-only');
    const directory = this.directory(chatId);
    // JSON permits unpaired UTF-16 code units. Never silently turn them into
    // U+FFFD while extracting an otherwise lossless transcript string.
    const encoding =
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
        output,
      )
        ? 'utf-16le'
        : 'utf-8';
    const encodingBuffer = Buffer.allocUnsafe(
      Math.min(output.length, 16_384) * (encoding === 'utf-8' ? 3 : 2),
    );
    const hash = createHash('sha256');
    let byteLength = 0;
    let bytesSinceYield = 0;
    const hashChunks = encodedOutputChunks(output, encoding, encodingBuffer);
    for (let next = hashChunks.next(); !next.done; next = hashChunks.next()) {
      const bytes = next.value;
      if (bytesSinceYield + bytes.length > 1024 * 1024) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        bytesSinceYield = 0;
      }
      hash.update(bytes);
      byteLength += bytes.length;
      bytesSinceYield += bytes.length;
    }
    const sha256 = hash.digest('hex');
    const ref: PersistedToolOutputReference = {
      version: 1,
      artifactId: `sha256-v1-${sha256}`,
      byteLength,
      sha256,
      encoding,
      mediaType: 'text/plain',
    };
    const path = this.path(chatId, ref);
    await mkdir(directory, { recursive: true });
    await fsyncDirectory(join(this.transcriptsRoot, 'tool-output'));
    await fsyncDirectory(this.transcriptsRoot);
    if (await this.syncIfVerified(chatId, ref)) return ref;

    const temporary = join(directory, `.${randomUUID()}.tmp`);
    const handle = await open(temporary, 'wx', 0o600);
    try {
      const writeChunks = encodedOutputChunks(output, encoding, encodingBuffer);
      for (let next = writeChunks.next(); !next.done; next = writeChunks.next())
        await handle.writeFile(next.value);
      await handle.sync();
      recordChatStorageFileWrite(temporary, byteLength, false);
      recordChatStorageFileSync(temporary);
    } catch (error) {
      await handle.close();
      await rm(temporary, { force: true });
      throw error;
    }
    await handle.close();
    const existed = await exists(path);
    await rename(temporary, path);
    recordChatStorageAtomicReplacement(path);
    recordChatStorageArtifactPublished();
    await fsyncDirectory(directory);
    if (!existed) created?.add(path);
    return ref;
  }

  /** Sync an existing, verified visual before reusing its content address. */
  private async syncVisualIfVerified(
    chatId: string,
    ref: VisualContentReference,
  ): Promise<boolean> {
    let handle: FileHandle;
    try {
      handle = await open(this.visualContentPath(chatId, ref), 'r+');
    } catch (error) {
      if (isErrnoException(error) && error.code === 'ENOENT') return false;
      throw error;
    }
    try {
      try {
        await this.verifyVisualHandle(handle, ref);
      } catch (error) {
        if (isArtifactIntegrityError(error)) return false;
        throw error;
      }
      await handle.sync();
      recordChatStorageFileSync(this.visualContentPath(chatId, ref));
    } finally {
      await handle.close();
    }
    await fsyncDirectory(this.directory(chatId, 'visual'));
    return true;
  }

  /** Publishes well-formed UTF-8 HTML under its byte-only content address. */
  public async putVisual(
    chatId: string,
    html: string,
    created?: CreatedArtifacts,
  ): Promise<VisualContentReference> {
    if (this.readOnly) throw new Error('Visual store is read-only');
    if (!isWellFormedUtf16(html))
      throw new Error('Visual HTML must be well-formed UTF-8');
    const bytes = Buffer.from(html, 'utf8');
    if (bytes.length > VISUAL_PREPARED_MAX_BYTES)
      throw new Error('Visual HTML exceeds the prepared byte limit');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const ref: VisualContentReference = {
      artifactId: `sha256-v1-${sha256}`,
      byteLength: bytes.length,
      sha256,
    };
    const directory = this.directory(chatId, 'visual');
    const path = this.visualContentPath(chatId, ref);
    await mkdir(directory, { recursive: true });
    await fsyncDirectory(join(this.transcriptsRoot, 'visuals'));
    await fsyncDirectory(this.transcriptsRoot);
    if (await this.syncVisualIfVerified(chatId, ref)) return ref;

    const temporary = join(directory, `.${randomUUID()}.tmp`);
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
      recordChatStorageFileWrite(temporary, ref.byteLength, false);
      recordChatStorageFileSync(temporary);
    } catch (error) {
      await handle.close();
      await rm(temporary, { force: true });
      throw error;
    }
    await handle.close();
    const existed = await exists(path);
    await rename(temporary, path);
    recordChatStorageAtomicReplacement(path);
    recordChatStorageArtifactPublished();
    await fsyncDirectory(directory);
    if (!existed) created?.add(path);
    return ref;
  }

  public async verify(
    chatId: string,
    ref: PersistedToolOutputReference,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    const handle = await open(this.path(chatId, ref), 'r');
    try {
      await this.verifyHandle(handle, ref, signal);
    } finally {
      await handle.close();
    }
  }

  public async verifyVisual(
    chatId: string,
    ref: PersistedVisualReference,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    const handle = await open(this.visualPath(chatId, ref), 'r');
    try {
      await this.verifyVisualHandle(handle, ref, signal);
    } finally {
      await handle.close();
    }
  }

  /** Verify any stored artifact against its reference. */
  public async verifyArtifact(
    chatId: string,
    ref: PersistedArtifactReference,
    signal?: AbortSignal,
  ): Promise<void> {
    switch (ref.family) {
      case 'tool-output':
        return this.verify(chatId, ref.reference, signal);
      case 'visual':
        return this.verifyVisual(chatId, ref.reference, signal);
    }
  }

  /** Copy any stored artifact to another chat, as `copyToChat` does. */
  public async copyArtifactToChat(
    sourceChatId: string,
    targetChatId: string,
    ref: PersistedArtifactReference,
    destination: ChatTranscriptArtifacts = this,
    created?: CreatedArtifacts,
  ): Promise<void> {
    switch (ref.family) {
      case 'tool-output':
        return this.copyToChat(
          sourceChatId,
          targetChatId,
          ref.reference,
          destination,
          created,
        );
      case 'visual':
        return this.copyVisualToChat(
          sourceChatId,
          targetChatId,
          ref.reference,
          destination,
          created,
        );
    }
  }

  /** Copy while the caller holds the source scope lease. The destination is
   * independent of future source deletion; reference bytes remain identical.
   */
  public async copyToChat(
    sourceChatId: string,
    targetChatId: string,
    ref: PersistedToolOutputReference,
    destination: ChatTranscriptArtifacts = this,
    created?: CreatedArtifacts,
  ): Promise<void> {
    if (destination.readOnly) throw new Error('Tool output store is read-only');
    await this.verify(sourceChatId, ref);
    if (
      this.transcriptsRoot === destination.transcriptsRoot &&
      sourceChatId === targetChatId
    )
      return;
    const directory = destination.directory(targetChatId);
    await mkdir(directory, { recursive: true });
    // Persist newly created directory entries before publishing their artifacts.
    await fsyncDirectory(join(destination.transcriptsRoot, 'tool-output'));
    await fsyncDirectory(destination.transcriptsRoot);
    if (await destination.syncIfVerified(targetChatId, ref)) return;
    const temporary = join(directory, `.${randomUUID()}.tmp`);
    let renamed = false;
    try {
      await copyFile(this.path(sourceChatId, ref), temporary);
      // Verification reads the copy; Windows fsync also requires write access.
      const handle = await open(temporary, 'r+');
      try {
        await this.verifyHandle(handle, ref);
        await handle.sync();
        recordChatStorageFileWrite(temporary, ref.byteLength, false);
        recordChatStorageFileSync(temporary);
      } finally {
        await handle.close();
      }
      const path = destination.path(targetChatId, ref);
      const existed = await exists(path);
      await rename(temporary, path);
      renamed = true;
      recordChatStorageAtomicReplacement(path);
      recordChatStorageArtifactPublished();
      await fsyncDirectory(directory);
      if (!existed) created?.add(path);
    } finally {
      if (!renamed) await rm(temporary, { force: true });
    }
  }

  private async copyVisualToChat(
    sourceChatId: string,
    targetChatId: string,
    ref: PersistedVisualReference,
    destination: ChatTranscriptArtifacts,
    created?: CreatedArtifacts,
  ): Promise<void> {
    if (destination.readOnly) throw new Error('Visual store is read-only');
    await this.verifyVisual(sourceChatId, ref);
    if (
      this.transcriptsRoot === destination.transcriptsRoot &&
      sourceChatId === targetChatId
    )
      return;
    const directory = destination.directory(targetChatId, 'visual');
    await mkdir(directory, { recursive: true });
    await fsyncDirectory(join(destination.transcriptsRoot, 'visuals'));
    await fsyncDirectory(destination.transcriptsRoot);
    if (await destination.syncVisualIfVerified(targetChatId, ref)) return;
    const temporary = join(directory, `.${randomUUID()}.tmp`);
    let renamed = false;
    try {
      await copyFile(this.visualPath(sourceChatId, ref), temporary);
      const handle = await open(temporary, 'r+');
      try {
        await destination.verifyVisualHandle(handle, ref);
        await handle.sync();
        recordChatStorageFileWrite(temporary, ref.byteLength, false);
        recordChatStorageFileSync(temporary);
      } finally {
        await handle.close();
      }
      const path = destination.visualPath(targetChatId, ref);
      const existed = await exists(path);
      await rename(temporary, path);
      renamed = true;
      recordChatStorageAtomicReplacement(path);
      recordChatStorageArtifactPublished();
      await fsyncDirectory(directory);
      if (!existed) created?.add(path);
    } finally {
      if (!renamed) await rm(temporary, { force: true });
    }
  }

  private async verifyHandle(
    handle: FileHandle,
    ref: PersistedToolOutputReference,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    const info = await handle.stat();
    if (info.size !== ref.byteLength)
      throw new Error('Tool output artifact failed integrity validation');
    const signature = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
    if (this.verified.get(ref.sha256) === signature) return;
    const hash = createHash('sha256');
    let byteLength = 0;
    for await (const chunk of handle.createReadStream({
      start: 0,
      autoClose: false,
      signal,
    })) {
      signal?.throwIfAborted();
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      hash.update(bytes);
      byteLength += bytes.length;
    }
    if (byteLength !== ref.byteLength || hash.digest('hex') !== ref.sha256) {
      throw new Error('Tool output artifact failed integrity validation');
    }
    const after = await handle.stat();
    if (
      after.size !== info.size ||
      after.mtimeMs !== info.mtimeMs ||
      after.ctimeMs !== info.ctimeMs
    )
      throw new Error('Tool output artifact changed during validation');
    this.verified.set(ref.sha256, signature);
    if (this.verified.size > 128) {
      const oldest = this.verified.keys().next().value;
      if (oldest !== undefined) this.verified.delete(oldest);
    }
  }

  private async verifyVisualHandle(
    handle: FileHandle,
    ref: VisualContentReference,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    const info = await handle.stat();
    if (info.size !== ref.byteLength)
      throw new Error('Visual artifact failed integrity validation');
    const signature = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
    const cacheKey = `visual:${ref.sha256}`;
    if (this.verified.get(cacheKey) === signature) return;
    const hash = createHash('sha256');
    let byteLength = 0;
    for await (const chunk of handle.createReadStream({
      start: 0,
      autoClose: false,
      signal,
    })) {
      signal?.throwIfAborted();
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      hash.update(bytes);
      byteLength += bytes.length;
    }
    if (byteLength !== ref.byteLength || hash.digest('hex') !== ref.sha256)
      throw new Error('Visual artifact failed integrity validation');
    const after = await handle.stat();
    if (
      after.size !== info.size ||
      after.mtimeMs !== info.mtimeMs ||
      after.ctimeMs !== info.ctimeMs
    )
      throw new Error('Visual artifact changed during validation');
    this.verified.set(cacheKey, signature);
    if (this.verified.size > 128) {
      const oldest = this.verified.keys().next().value;
      if (oldest !== undefined) this.verified.delete(oldest);
    }
  }

  /** Read an exact raw-byte range after verifying the complete visual. */
  public async readVisualRange(
    chatId: string,
    ref: PersistedVisualReference,
    offset = 0,
    limit = 65_536,
    signal?: AbortSignal,
  ): Promise<{
    bytes: Buffer;
    offset: number;
    length: number;
    byteLength: number;
    sha256: string;
  }> {
    signal?.throwIfAborted();
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > ref.byteLength ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 1_048_576
    ) {
      throw new Error('Invalid visual range');
    }
    const handle = await open(this.visualPath(chatId, ref), 'r');
    try {
      await this.verifyVisualHandle(handle, ref, signal);
      const length = Math.min(limit, ref.byteLength - offset);
      const bytes = Buffer.alloc(length);
      let bytesRead = 0;
      while (bytesRead < length) {
        signal?.throwIfAborted();
        const read = await handle.read(
          bytes,
          bytesRead,
          length - bytesRead,
          offset + bytesRead,
        );
        if (read.bytesRead === 0)
          throw new Error('Unexpected end of visual artifact');
        bytesRead += read.bytesRead;
      }
      signal?.throwIfAborted();
      return {
        bytes,
        offset,
        length,
        byteLength: ref.byteLength,
        sha256: ref.sha256,
      };
    } finally {
      await handle.close();
    }
  }

  public async readRange(
    chatId: string,
    ref: PersistedToolOutputReference,
    offset = 0,
    limit = 65_536,
    signal?: AbortSignal,
  ): Promise<{ text: string; nextOffset?: number; byteLength: number }> {
    signal?.throwIfAborted();
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > ref.byteLength ||
      !Number.isSafeInteger(limit) ||
      limit < 4 ||
      limit > 65_536
    ) {
      throw new Error('Invalid tool output range');
    }
    const handle = await open(this.path(chatId, ref), 'r');
    try {
      await this.verifyHandle(handle, ref, signal);
      const buffer = Buffer.alloc(Math.min(limit + 4, ref.byteLength - offset));
      let bytesRead = 0;
      while (bytesRead < buffer.length) {
        signal?.throwIfAborted();
        const read = await handle.read(
          buffer,
          bytesRead,
          buffer.length - bytesRead,
          offset + bytesRead,
        );
        if (read.bytesRead === 0)
          throw new Error('Unexpected end of tool output artifact');
        bytesRead += read.bytesRead;
      }
      signal?.throwIfAborted();
      if (
        ref.encoding === 'utf-8' &&
        bytesRead > 0 &&
        (buffer[0] & 0xc0) === 0x80
      ) {
        throw new Error('Tool output offset splits a UTF-8 character');
      }
      let end = Math.min(limit, bytesRead);
      if (ref.encoding === 'utf-8') {
        while (end > 0 && end < bytesRead && (buffer[end] & 0xc0) === 0x80)
          end -= 1;
      } else {
        if (offset % 2 !== 0 || ref.byteLength % 2 !== 0)
          throw new Error('Tool output offset splits a UTF-16 code unit');
        end -= end % 2;
        // Keep well-formed surrogate pairs together between range responses.
        if (
          end >= 2 &&
          end + 2 <= bytesRead &&
          buffer.readUInt16LE(end - 2) >= 0xd800 &&
          buffer.readUInt16LE(end - 2) <= 0xdbff &&
          buffer.readUInt16LE(end) >= 0xdc00 &&
          buffer.readUInt16LE(end) <= 0xdfff
        )
          end -= 2;
      }
      return {
        text: buffer
          .subarray(0, end)
          .toString(ref.encoding === 'utf-8' ? 'utf8' : 'utf16le'),
        byteLength: ref.byteLength,
        ...(offset + end < ref.byteLength ? { nextOffset: offset + end } : {}),
      };
    } finally {
      await handle.close();
    }
  }

  private async promoteVisual(
    chatId: string,
    messageId: string,
    toolUseId: string,
    output: string,
    created: CreatedArtifacts | undefined,
    visualContext: ExternalizeVisualContext | undefined,
  ): Promise<PromotedVisual | undefined> {
    if (!visualContext || visualContext.chatId !== chatId) return undefined;
    try {
      if (!visualContext.hasStagedEntries()) return undefined;
    } catch {
      return undefined;
    }

    for (const visualId of findVisualTokens(output)) {
      try {
        const owner = visualContext.ownerOf(visualId);
        if (owner && !sameOwner(owner, { messageId, toolUseId })) continue;
        const call = visualContext.linkedToolCall(toolUseId);
        if (
          !call ||
          call.toolUseId !== toolUseId ||
          visualContext.resolveToolKey(call) !== SHOW_VISUAL_TOOL_KEY
        ) {
          continue;
        }
        const staged = await visualContext.readStaged(visualId);
        if (!staged || !stagedVisualMatches(staged, chatId, visualId)) continue;
        if (
          staged.sidecar.codexCallId !== undefined &&
          call.codexCallId !== staged.sidecar.codexCallId
        ) {
          continue;
        }
        const ownerFence = {
          messageId,
          toolUseId,
          ...(call.codexCallId !== undefined
            ? { codexCallId: call.codexCallId }
            : {}),
          claimedAt: visualContext.now(),
        };
        if (!visualContext.reserve(visualId, ownerFence)) continue;

        const artifact = await this.putVisual(chatId, staged.html, created);
        const reference: PersistedVisualReference = {
          version: 1,
          visualId,
          artifactId: artifact.artifactId,
          byteLength: artifact.byteLength,
          sha256: artifact.sha256,
          mediaType: 'text/html',
          title: staged.sidecar.title,
          maxHeight: staged.sidecar.maxHeight,
          ...(staged.sidecar.heights !== undefined
            ? { heights: staged.sidecar.heights }
            : {}),
        };
        return { chatId, visualId, reference };
      } catch {
        continue;
      }
    }
    return undefined;
  }

  /** Bounded lazy upgrade for old rows whose canonical result is already externalized. */
  public async hydrateAgentArtifacts(
    chatId: string,
    message: PersistedChatMessage,
  ): Promise<PersistedChatMessage> {
    let changed = false;
    const blocks: PersistedChatMessage['blocks'] = [];
    for (const block of message.blocks) {
      if (
        block.type !== 'tool_result' ||
        block.isError ||
        !block.fullOutputRef ||
        block.agentArtifacts?.length ||
        !isArtifactDispatchTool(block.toolName) ||
        block.fullOutputRef.byteLength > MAX_AGENT_ARTIFACT_OUTPUT_CHARS
      ) {
        blocks.push(block);
        continue;
      }
      try {
        let output = '';
        let offset: number | undefined = 0;
        while (offset !== undefined) {
          const page = await this.readRange(
            chatId,
            block.fullOutputRef,
            offset,
            64 * 1024,
          );
          output += page.text;
          offset = page.nextOffset;
        }
        const receipts = extractCanonicalAgentArtifacts(output);
        if (receipts.length) {
          blocks.push({ ...block, agentArtifacts: receipts });
          changed = true;
        } else blocks.push(block);
      } catch {
        blocks.push(block);
      }
    }
    return changed ? { ...message, blocks } : message;
  }

  public async externalize(
    chatId: string,
    message: PersistedChatMessage,
    created?: CreatedArtifacts,
    visualContext?: ExternalizeVisualContext,
  ): Promise<PersistedChatMessage> {
    const result = await this.externalizeWithVisuals(
      chatId,
      message,
      created,
      visualContext,
    );
    return result.message;
  }

  /** Externalize a message and expose newly promoted visuals for publication. */
  public async externalizeWithVisuals(
    chatId: string,
    message: PersistedChatMessage,
    created?: CreatedArtifacts,
    visualContext?: ExternalizeVisualContext,
  ): Promise<{
    message: PersistedChatMessage;
    promotedVisuals: PromotedVisual[];
  }> {
    const blocks: PersistedChatMessage['blocks'] = [];
    const promotedVisuals: PromotedVisual[] = [];
    for (const block of message.blocks) {
      if (block.type !== 'tool_result') {
        blocks.push(block);
        continue;
      }
      for (const ref of storedArtifactRefsOf(block))
        await this.verifyArtifact(chatId, ref);
      const promotion = block.visualRef
        ? undefined
        : await this.promoteVisual(
            chatId,
            message.id,
            block.toolUseId,
            block.output,
            created,
            visualContext,
          );
      if (promotion) promotedVisuals.push(promotion);
      const canonical = block.isError
        ? []
        : block.fullOutputRef
          ? serializeAgentArtifactReceipts(block.agentArtifacts)
          : extractCanonicalAgentArtifacts(block.output);
      const promotedBlock = {
        ...block,
        ...(promotion ? { visualRef: promotion.reference } : {}),
      };
      delete promotedBlock.agentArtifacts;
      if (canonical.length) promotedBlock.agentArtifacts = canonical;
      if (block.fullOutputRef) {
        if (
          Buffer.byteLength(block.output, 'utf8') > TOOL_OUTPUT_INLINE_BYTES
        ) {
          throw new Error(
            'Referenced tool output preview exceeds inline budget',
          );
        }
        blocks.push(promotedBlock);
      } else if (block.outputTruncated) {
        throw new Error('Truncated tool output has no lossless artifact');
      } else if (
        Buffer.byteLength(block.output, 'utf8') > TOOL_OUTPUT_INLINE_BYTES
      ) {
        const fullOutputRef = await this.put(chatId, block.output, created);
        blocks.push({
          ...promotedBlock,
          output: preview(block.output),
          outputTruncated: true,
          fullOutputRef,
        });
      } else {
        blocks.push(promotedBlock);
      }
    }
    return { message: { ...message, blocks }, promotedVisuals };
  }
}
