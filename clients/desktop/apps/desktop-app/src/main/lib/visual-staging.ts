import { createHash, randomUUID } from 'node:crypto';
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
import { join } from 'node:path';
import { TextDecoder } from 'node:util';
import {
  clampVisualHeight,
  isVisualId,
  VISUAL_PREPARED_MAX_BYTES,
  VISUAL_TITLE_MAX_LENGTH,
  VISUAL_HEIGHTS_MAX_ENTRIES,
} from '@canopy/agent-transcript/lib/visual-ref';
import { isErrnoException, isRecord } from './type-guards';
import { fsyncDirectory } from './fsync-directory';
import {
  SHOW_VISUAL_TOOL_KEY,
  VISUAL_STAGING_RETENTION_MS,
  type StageVisualDocument,
  type StagedVisual,
  type VisualStagingSidecar,
  type VisualStagingStore,
  type VisualStagingTarget,
} from './chat-visual-contracts';

const MAX_SIDECAR_BYTES = 64 * 1024;
// Keep a leading BOM: the staged bytes must match the sidecar exactly.
const UTF8_DECODER = new TextDecoder('utf-8', {
  fatal: true,
  ignoreBOM: true,
});

export interface VisualStagingOptions {
  now?: () => number;
}

function isWellFormedUtf16(value: string): boolean {
  return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
    value,
  );
}

function validHeights(
  value: unknown,
): value is ReadonlyArray<readonly [number, number]> {
  if (!Array.isArray(value) || value.length > VISUAL_HEIGHTS_MAX_ENTRIES)
    return false;
  const pairs: readonly unknown[] = value;
  for (const pair of pairs) {
    if (!Array.isArray(pair)) {
      return false;
    }
    const tuple: readonly unknown[] = pair;
    if (
      tuple.length !== 2 ||
      typeof tuple[0] !== 'number' ||
      !Number.isFinite(tuple[0]) ||
      tuple[0] <= 0 ||
      typeof tuple[1] !== 'number' ||
      !Number.isFinite(tuple[1]) ||
      tuple[1] <= 0
    ) {
      return false;
    }
  }
  return true;
}

function isValidSidecar(
  value: unknown,
  expectedId: string,
): value is VisualStagingSidecar {
  if (!isRecord(value)) return false;
  if (
    value.version !== 1 ||
    value.visualId !== expectedId ||
    !isVisualId(expectedId) ||
    typeof value.chatId !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/.test(value.chatId) ||
    value.toolKey !== SHOW_VISUAL_TOOL_KEY ||
    typeof value.createdAt !== 'number' ||
    !Number.isSafeInteger(value.createdAt) ||
    value.createdAt < 0 ||
    typeof value.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.sha256) ||
    typeof value.byteLength !== 'number' ||
    !Number.isSafeInteger(value.byteLength) ||
    value.byteLength < 0 ||
    value.byteLength > VISUAL_PREPARED_MAX_BYTES ||
    typeof value.title !== 'string' ||
    value.title.trim().length === 0 ||
    value.title !== value.title.trim() ||
    value.title.length > VISUAL_TITLE_MAX_LENGTH ||
    typeof value.maxHeight !== 'number' ||
    !Number.isFinite(value.maxHeight) ||
    clampVisualHeight(value.maxHeight) !== value.maxHeight
  ) {
    return false;
  }
  if (
    'heights' in value &&
    value.heights !== undefined &&
    !validHeights(value.heights)
  ) {
    return false;
  }
  if (
    'codexCallId' in value &&
    value.codexCallId !== undefined &&
    typeof value.codexCallId !== 'string'
  ) {
    return false;
  }
  return true;
}

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function sameMetadata(
  sidecar: VisualStagingSidecar,
  target: VisualStagingTarget,
  document: StageVisualDocument,
  title: string,
  maxHeight: number,
  bytes: Buffer,
): boolean {
  return (
    sidecar.chatId === target.chatId &&
    sidecar.visualId === document.visualId &&
    sidecar.toolKey === SHOW_VISUAL_TOOL_KEY &&
    sidecar.sha256 === digest(bytes) &&
    sidecar.byteLength === bytes.length &&
    sidecar.title === title &&
    sidecar.maxHeight === maxHeight &&
    sidecar.codexCallId === document.codexCallId &&
    JSON.stringify(sidecar.heights) === JSON.stringify(document.heights)
  );
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return false;
    throw error;
  }
}

export class VisualStagingStoreImpl implements VisualStagingStore {
  private readonly ids = new Set<string>();
  private readonly now: () => number;

  public constructor(
    private readonly directory: string,
    options: VisualStagingOptions = {},
  ) {
    this.now = options.now ?? Date.now;
  }

  private htmlPath(visualId: string): string {
    return join(this.directory, `${visualId}.html`);
  }

  private sidecarPath(visualId: string): string {
    return join(this.directory, `${visualId}.json`);
  }

  private async readSidecar(
    visualId: string,
  ): Promise<VisualStagingSidecar | undefined> {
    try {
      const info = await stat(this.sidecarPath(visualId));
      if (!info.isFile() || info.size > MAX_SIDECAR_BYTES) return undefined;
      const bytes = await readFile(this.sidecarPath(visualId));
      if (bytes.length > MAX_SIDECAR_BYTES) return undefined;
      const parsed: unknown = JSON.parse(UTF8_DECODER.decode(bytes));
      return isValidSidecar(parsed, visualId) ? parsed : undefined;
    } catch (error) {
      if (isErrnoException(error) && error.code === 'ENOENT') return undefined;
      if (error instanceof SyntaxError || error instanceof TypeError)
        return undefined;
      throw error;
    }
  }

  private async writeAtomic(
    destination: string,
    bytes: Buffer,
    afterRename?: () => void,
  ): Promise<void> {
    const temporary = join(this.directory, `.${randomUUID()}.tmp`);
    const handle = await open(temporary, 'wx', 0o600);
    let renamed = false;
    try {
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      await rename(temporary, destination);
      renamed = true;
      afterRename?.();
      await fsyncDirectory(this.directory);
    } finally {
      if (!renamed) {
        await handle.close().catch(() => undefined);
        await rm(temporary, { force: true });
      }
    }
  }

  public async initialize(now: number = this.now()): Promise<void> {
    await this.scanAndSweep(now);
  }

  public hasEntries(): boolean {
    return this.ids.size > 0;
  }

  public stagedIds(): ReadonlySet<string> {
    return new Set(this.ids);
  }

  public async stage(
    target: VisualStagingTarget,
    document: StageVisualDocument,
    now: number = this.now(),
  ): Promise<VisualStagingSidecar> {
    if (!isVisualId(document.visualId)) throw new Error('Invalid visual id');
    if (!Number.isSafeInteger(now) || now < 0)
      throw new Error('Invalid visual staging time');
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/.test(target.chatId))
      throw new Error('Invalid chat identity');
    const title = document.title.trim();
    if (title.length === 0 || title.length > VISUAL_TITLE_MAX_LENGTH)
      throw new Error('Invalid visual title');
    if (!isWellFormedUtf16(document.html))
      throw new Error('Visual HTML must be well-formed UTF-8');
    const htmlBytes = Buffer.from(document.html, 'utf8');
    if (htmlBytes.length > VISUAL_PREPARED_MAX_BYTES)
      throw new Error('Visual HTML exceeds the prepared byte limit');
    if (document.heights !== undefined && !validHeights(document.heights))
      throw new Error('Invalid visual heights');
    await mkdir(this.directory, { recursive: true });

    const maxHeight = clampVisualHeight(document.maxHeight);
    const sidecar: VisualStagingSidecar = {
      version: 1,
      visualId: document.visualId,
      chatId: target.chatId,
      toolKey: SHOW_VISUAL_TOOL_KEY,
      createdAt: now,
      sha256: digest(htmlBytes),
      byteLength: htmlBytes.length,
      title,
      maxHeight,
      ...(document.heights !== undefined ? { heights: document.heights } : {}),
      ...(document.codexCallId !== undefined
        ? { codexCallId: document.codexCallId }
        : {}),
    };
    const sidecarBytes = Buffer.from(JSON.stringify(sidecar), 'utf8');
    if (sidecarBytes.length > MAX_SIDECAR_BYTES)
      throw new Error('Visual staging sidecar exceeds the size limit');

    const existing = await this.readSidecar(document.visualId);
    if (existing) {
      const currentHtml = await this.readCandidate(
        target.chatId,
        document.visualId,
      );
      if (
        currentHtml &&
        currentHtml.sidecar.sha256 === existing.sha256 &&
        sameMetadata(existing, target, document, title, maxHeight, htmlBytes)
      ) {
        this.ids.add(document.visualId);
        return existing;
      }
      throw new Error('Visual id is already staged with different content');
    }
    if (await pathExists(this.sidecarPath(document.visualId)))
      throw new Error('Visual id has an invalid staging sidecar');

    await rm(this.htmlPath(document.visualId), { force: true });
    await this.writeAtomic(this.htmlPath(document.visualId), htmlBytes);
    await this.writeAtomic(
      this.sidecarPath(document.visualId),
      sidecarBytes,
      () => {
        this.ids.add(document.visualId);
      },
    );
    return sidecar;
  }

  public async readCandidate(
    chatId: string,
    visualId: string,
  ): Promise<StagedVisual | undefined> {
    if (!isVisualId(visualId)) return undefined;
    const sidecar = await this.readSidecar(visualId);
    if (!sidecar || sidecar.chatId !== chatId) return undefined;
    try {
      const bytes = await readFile(this.htmlPath(visualId));
      if (
        bytes.length !== sidecar.byteLength ||
        bytes.length > VISUAL_PREPARED_MAX_BYTES ||
        digest(bytes) !== sidecar.sha256
      ) {
        return undefined;
      }
      return { sidecar, html: UTF8_DECODER.decode(bytes) };
    } catch (error) {
      if (
        (isErrnoException(error) && error.code === 'ENOENT') ||
        error instanceof TypeError
      ) {
        return undefined;
      }
      throw error;
    }
  }

  public async remove(visualId: string): Promise<void> {
    if (!isVisualId(visualId)) return;
    await rm(this.sidecarPath(visualId), { force: true });
    await rm(this.htmlPath(visualId), { force: true });
    this.ids.delete(visualId);
    try {
      await fsyncDirectory(this.directory);
    } catch (error) {
      if (!(isErrnoException(error) && error.code === 'ENOENT')) throw error;
    }
  }

  public async removeChat(chatId: string): Promise<void> {
    for (const visualId of Array.from(this.ids)) {
      const sidecar = await this.readSidecar(visualId);
      if (sidecar?.chatId === chatId) await this.remove(visualId);
    }
  }

  private async fileAge(
    path: string,
    now: number,
  ): Promise<'expired' | 'young' | 'missing'> {
    try {
      const info = await stat(path);
      return now - info.mtimeMs > VISUAL_STAGING_RETENTION_MS
        ? 'expired'
        : 'young';
    } catch (error) {
      if (isErrnoException(error) && error.code === 'ENOENT') return 'missing';
      throw error;
    }
  }

  private async removeEntry(visualId: string): Promise<void> {
    await rm(this.sidecarPath(visualId), { force: true });
    await rm(this.htmlPath(visualId), { force: true });
    this.ids.delete(visualId);
  }

  private async readDirectory(): Promise<Dirent[] | undefined> {
    try {
      return await readdir(this.directory, { withFileTypes: true });
    } catch (error) {
      if (isErrnoException(error) && error.code === 'ENOENT') return undefined;
      throw error;
    }
  }

  private async scanSidecars(
    entries: readonly Dirent[],
    now: number,
  ): Promise<{
    validIds: Set<string>;
    stagedIds: Set<string>;
    removedEntries: number;
  }> {
    const validSidecars = new Set<string>();
    const nextIds = new Set<string>();
    let removedEntries = 0;

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const visualId = entry.name.slice(0, -'.json'.length);
      if (!isVisualId(visualId)) {
        await rm(join(this.directory, entry.name), { force: true });
        continue;
      }
      const sidecar = await this.readSidecar(visualId);
      if (!sidecar) {
        await rm(this.sidecarPath(visualId), { force: true });
        continue;
      }
      if (now - sidecar.createdAt > VISUAL_STAGING_RETENTION_MS) {
        await this.removeEntry(visualId);
        removedEntries += 1;
        continue;
      }
      validSidecars.add(visualId);
      nextIds.add(visualId);
    }
    return {
      validIds: validSidecars,
      stagedIds: nextIds,
      removedEntries,
    };
  }

  /** Removes expired orphans and returns how many young ones remain. */
  private async removeOldOrphans(
    entries: readonly Dirent[],
    now: number,
    validSidecars: ReadonlySet<string>,
  ): Promise<number> {
    let retained = 0;
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const isTemporary = entry.name.endsWith('.tmp');
      const isOrphan =
        entry.name.endsWith('.html') &&
        !validSidecars.has(entry.name.slice(0, -'.html'.length));
      if (!isTemporary && !isOrphan) continue;
      const path = join(this.directory, entry.name);
      const age = await this.fileAge(path, now);
      if (age === 'expired') await rm(path, { force: true });
      // An entry removed earlier in this pass is missing, not retained.
      else if (age === 'young') retained += 1;
    }
    return retained;
  }

  private async scanAndSweep(
    now: number,
  ): Promise<{ removed: number; retainedOrphans: number }> {
    const entries = await this.readDirectory();
    if (!entries) {
      this.ids.clear();
      return { removed: 0, retainedOrphans: 0 };
    }
    const sidecars = await this.scanSidecars(entries, now);
    const retainedOrphans = await this.removeOldOrphans(
      entries,
      now,
      sidecars.validIds,
    );
    this.ids.clear();
    sidecars.stagedIds.forEach((visualId) => this.ids.add(visualId));
    return { removed: sidecars.removedEntries, retainedOrphans };
  }

  /**
   * `remaining` counts staged entries and young orphan or temporary files,
   * so the scopes marker stays until a later pass can remove them.
   */
  public async sweep(
    now: number = this.now(),
  ): Promise<{ removed: number; remaining: number }> {
    const { removed, retainedOrphans } = await this.scanAndSweep(now);
    return { removed, remaining: this.ids.size + retainedOrphans };
  }
}
