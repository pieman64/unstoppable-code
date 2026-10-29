import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  isAgentDelegationTranscriptItem,
  type AgentDelegationTranscriptItem,
} from '@canopy/protocol/delegation';
import {
  recordChatStorageAtomicReplacement,
  recordChatStorageFileSync,
  recordChatStorageFileWrite,
} from '@canopy/desktop-shared/node/work-counters';
import {
  assertTranscriptIdentity,
  type CreatedArtifacts,
} from './chat-transcript-artifacts';
import { fsyncDirectory } from './fsync-directory';
import { isErrnoException } from './type-guards';

/** One delegate run generation, as its card names it. */
export interface DelegationRun {
  readonly delegationId: string;
  readonly runGeneration: number;
}

/** New and changed items of one run, appended together with other runs. */
export interface DelegationRunItems {
  readonly run: DelegationRun;
  readonly items: readonly AgentDelegationTranscriptItem[];
}

/** A log is compacted once it is this large and twice its live content. */
const COMPACT_MIN_BYTES = 1024 * 1024;

interface LogLine {
  readonly v: 1;
  readonly item: AgentDelegationTranscriptItem;
}

interface LogStats {
  fileBytes: number;
  /** False after a torn final line: the next append starts a new line. */
  endsWithNewline: boolean;
  /** Serialized line bytes of the newest version of each item. */
  readonly liveLineBytes: Map<string, number>;
  liveBytes: number;
}

function serializeLine(item: AgentDelegationTranscriptItem): string {
  const line: LogLine = { v: 1, item };
  return `${JSON.stringify(line)}\n`;
}

function parseLine(text: string): AgentDelegationTranscriptItem | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('v' in parsed) ||
    parsed.v !== 1 ||
    !('item' in parsed) ||
    !isAgentDelegationTranscriptItem(parsed.item)
  )
    return undefined;
  return parsed.item;
}

/** Newest version of each item, in delegate order. */
function liveItems(text: string): AgentDelegationTranscriptItem[] {
  const items = new Map<string, AgentDelegationTranscriptItem>();
  for (const line of text.split('\n')) {
    if (!line) continue;
    // A torn final line (a crash mid-append) or a foreign line is skipped:
    // the log is display evidence, never authority.
    const item = parseLine(line);
    if (item) items.set(item.id, item);
  }
  return Array.from(items.values()).sort(
    (left, right) => left.sequence - right.sequence,
  );
}

function assertRun(run: DelegationRun): void {
  if (
    typeof run.delegationId !== 'string' ||
    run.delegationId.length === 0 ||
    run.delegationId.length > 512 ||
    !Number.isSafeInteger(run.runGeneration) ||
    run.runGeneration < 1
  )
    throw new Error('Invalid delegation run');
}

/**
 * Per-chat, append-only transcript logs of delegated agent runs, beside the
 * parent chat's transcript (`transcripts/delegations/<chatId>/`). Each line
 * holds one transcript item; a later line with the same item id replaces the
 * earlier one, so a delegate's progress is appended, never rewritten, and the
 * parent chat's committed history does not change while it runs.
 *
 * The scope's chat storage owns these files. Copies and removal run under
 * the scope lease; appends run outside it and only add whole lines, so a
 * copy taken mid-append at worst ends in a torn line, which reads skip.
 */
export class ChatDelegationLogs {
  private readonly stats = new Map<string, LogStats>();
  private readonly tails = new Map<string, Promise<unknown>>();
  /**
   * Chats whose logs were removed. Appends run outside the scope lease, so
   * one already under way when its chat is deleted must not recreate the
   * directory; a run copied back into the chat (a restore) lifts this.
   */
  private readonly removed = new Set<string>();

  public constructor(
    private readonly transcriptsRoot: string,
    private readonly readOnly = false,
  ) {}

  private directory(chatId: string): string {
    assertTranscriptIdentity(chatId);
    return join(this.transcriptsRoot, 'delegations', chatId);
  }

  /** File names derive from a digest: delegation ids are opaque labels. */
  public path(chatId: string, run: DelegationRun): string {
    assertRun(run);
    const name = createHash('sha256')
      .update(run.delegationId)
      .digest('hex')
      .slice(0, 32);
    return join(
      this.directory(chatId),
      `${name}.${String(run.runGeneration)}.jsonl`,
    );
  }

  /**
   * Makes a chat's log directory; returns the first directory it created, as
   * `mkdir` does, for {@link syncNewEntries}.
   */
  private async makeDirectory(chatId: string): Promise<string | undefined> {
    return mkdir(this.directory(chatId), { recursive: true });
  }

  /**
   * Syncs each directory that gained an entry for a new log, deepest first,
   * up to the transcripts root, so the log survives a crash.
   */
  private async syncNewEntries(
    chatId: string,
    made: string | undefined,
  ): Promise<void> {
    const directory = this.directory(chatId);
    await fsyncDirectory(directory);
    if (made === undefined) return;
    await fsyncDirectory(join(this.transcriptsRoot, 'delegations'));
    if (made !== directory) await fsyncDirectory(this.transcriptsRoot);
  }

  private assertWritable(): void {
    if (this.readOnly) throw new Error('Delegation log store is read-only');
  }

  private serial<T>(path: string, work: () => Promise<T>): Promise<T> {
    const next = (this.tails.get(path) ?? Promise.resolve())
      .catch(() => undefined)
      .then(work);
    this.tails.set(path, next);
    void next.finally(() => {
      if (this.tails.get(path) === next) this.tails.delete(path);
    });
    return next;
  }

  private async readText(path: string): Promise<string | undefined> {
    try {
      return await readFile(path, 'utf8');
    } catch (error) {
      if (isErrnoException(error) && error.code === 'ENOENT') return undefined;
      throw error;
    }
  }

  private async loadStats(path: string): Promise<LogStats> {
    const cached = this.stats.get(path);
    if (cached) return cached;
    const text = (await this.readText(path)) ?? '';
    const liveLineBytes = new Map<string, number>();
    for (const item of liveItems(text))
      liveLineBytes.set(item.id, Buffer.byteLength(serializeLine(item)));
    const stats: LogStats = {
      fileBytes: Buffer.byteLength(text),
      endsWithNewline: text.length === 0 || text.endsWith('\n'),
      liveLineBytes,
      liveBytes: Array.from(liveLineBytes.values()).reduce(
        (total, bytes) => total + bytes,
        0,
      ),
    };
    this.stats.set(path, stats);
    return stats;
  }

  /**
   * Appends new and changed items and syncs the file. The caller batches
   * progress; each call is one write and one sync.
   */
  public async append(
    chatId: string,
    run: DelegationRun,
    items: readonly AgentDelegationTranscriptItem[],
  ): Promise<void> {
    this.assertWritable();
    if (items.length === 0) return;
    for (const item of items)
      if (!isAgentDelegationTranscriptItem(item))
        throw new Error('Invalid delegation transcript item');
    const path = this.path(chatId, run);
    await this.serial(path, async () => {
      if (this.removed.has(chatId)) return;
      const stats = await this.loadStats(path);
      const lines = items.map(serializeLine);
      // Never extend a torn final line: it would swallow the first item.
      const text = (stats.endsWithNewline ? '' : '\n') + lines.join('');
      const created = stats.fileBytes === 0;
      const made = created ? await this.makeDirectory(chatId) : undefined;
      const handle = await open(path, 'a', 0o600);
      try {
        await handle.writeFile(text);
        await handle.sync();
      } finally {
        await handle.close();
      }
      const bytes = Buffer.byteLength(text);
      recordChatStorageFileWrite(path, bytes, true);
      recordChatStorageFileSync(path);
      if (created) await this.syncNewEntries(chatId, made);
      stats.fileBytes += bytes;
      stats.endsWithNewline = true;
      items.forEach((item, index) => {
        const lineBytes = Buffer.byteLength(lines[index]);
        stats.liveBytes += lineBytes - (stats.liveLineBytes.get(item.id) ?? 0);
        stats.liveLineBytes.set(item.id, lineBytes);
      });
      if (
        stats.fileBytes >= COMPACT_MIN_BYTES &&
        stats.fileBytes > stats.liveBytes * 2
      )
        await this.compactLocked(path, stats);
    });
  }

  private async writeAtomically(
    path: string,
    items: readonly AgentDelegationTranscriptItem[],
  ): Promise<number> {
    const temporary = `${path}.${randomUUID()}.tmp`;
    const text = items.map(serializeLine).join('');
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(text);
      await handle.sync();
    } catch (error) {
      await handle.close();
      await rm(temporary, { force: true });
      throw error;
    }
    await handle.close();
    await rename(temporary, path);
    const bytes = Buffer.byteLength(text);
    recordChatStorageFileWrite(path, bytes, true);
    recordChatStorageFileSync(path);
    recordChatStorageAtomicReplacement(path);
    return bytes;
  }

  private async compactLocked(path: string, stats: LogStats): Promise<void> {
    const items = liveItems((await this.readText(path)) ?? '');
    const bytes = await this.writeAtomically(path, items);
    await fsyncDirectory(join(path, '..'));
    stats.fileBytes = bytes;
    stats.endsWithNewline = true;
  }

  /** The run's items in delegate order; empty when it has no log. */
  public async read(
    chatId: string,
    run: DelegationRun,
  ): Promise<AgentDelegationTranscriptItem[]> {
    const path = this.path(chatId, run);
    return this.serial(path, async () =>
      liveItems((await this.readText(path)) ?? ''),
    );
  }

  /** Whether the run has a log. */
  public async has(chatId: string, run: DelegationRun): Promise<boolean> {
    try {
      await stat(this.path(chatId, run));
      return true;
    } catch (error) {
      if (isErrnoException(error) && error.code === 'ENOENT') return false;
      throw error;
    }
  }

  /**
   * Copies one run's log to another chat (fork, copy, restore) as a compacted
   * file. The caller holds both scope leases; `created` rolls it back if the
   * enclosing commit fails.
   */
  public async copyRun(
    sourceChatId: string,
    targetChatId: string,
    run: DelegationRun,
    destination: ChatDelegationLogs,
    created?: CreatedArtifacts,
  ): Promise<void> {
    destination.assertWritable();
    if (
      this.transcriptsRoot === destination.transcriptsRoot &&
      sourceChatId === targetChatId
    )
      return;
    const items = await this.read(sourceChatId, run);
    if (items.length === 0) return;
    const target = destination.path(targetChatId, run);
    destination.removed.delete(targetChatId);
    await destination.serial(target, async () => {
      const made = await destination.makeDirectory(targetChatId);
      const existed = await stat(target).then(
        () => true,
        () => false,
      );
      await destination.writeAtomically(target, items);
      destination.stats.delete(target);
      await destination.syncNewEntries(targetChatId, made);
      if (!existed) created?.add(target);
    });
  }

  /**
   * Removes every log of a chat (the chat was deleted), after any write to
   * them already under way; later appends for the chat write nothing.
   */
  public async remove(chatId: string): Promise<void> {
    this.assertWritable();
    const directory = this.directory(chatId);
    const inChat = (path: string): boolean =>
      path.startsWith(`${directory}/`) || path.startsWith(`${directory}\\`);
    this.removed.add(chatId);
    await Promise.allSettled(
      Array.from(this.tails)
        .filter(([path]) => inChat(path))
        .map(([, tail]) => tail),
    );
    for (const path of Array.from(this.stats.keys()))
      if (inChat(path)) this.stats.delete(path);
    await rm(directory, { recursive: true, force: true });
  }
}
