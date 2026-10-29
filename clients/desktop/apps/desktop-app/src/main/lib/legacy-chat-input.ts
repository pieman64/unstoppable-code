import { createReadStream } from 'node:fs';
import { mkdir, open, rm, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { JSONParser } from '@streamparser/json';
import type {
  ChatJournalRecord,
  PersistedChatMessage,
} from '@canopy/desktop-shared/types';
import { isPersistedChatMessage } from './chat-tabs-reader';
import { isChatJournalRecord } from './chat-state-journal';
import { writeBufferFully } from './cooperative-json';

export interface LegacyInputLocation {
  offset: number;
  length: number;
}
type Location = LegacyInputLocation;

/** An in-memory id/position index, never an in-memory transcript body. */
export class LegacyMessageList {
  private readonly rows = new Map<string, Location>();
  public duplicateIds = false;
  public constructor(private readonly input: LegacyChatInput) {}
  public get size(): number {
    return this.rows.size;
  }
  public set(id: string, location: Location): void {
    if (this.rows.has(id)) this.duplicateIds = true;
    this.rows.set(id, location);
  }
  public async upsert(message: PersistedChatMessage): Promise<void> {
    this.set(message.id, await this.input.spill(message));
  }
  public remove(id: string): void {
    this.rows.delete(id);
  }
  public async last(): Promise<PersistedChatMessage | undefined> {
    let last: Location | undefined;
    for (const location of Array.from(this.rows.values())) last = location;
    return last ? this.input.read(last) : undefined;
  }
  public async *iterate(): AsyncGenerator<PersistedChatMessage> {
    for (const location of Array.from(this.rows.values()))
      yield await this.input.read(location);
  }
}

const MESSAGE_PATHS = [
  '$.tabs.*.messages.*',
  '$.tab.messages.*',
  '$.archived.*.tab.messages.*',
  '$.mutations.*.tab.messages.*',
  '$.mutations.*.entry.tab.messages.*',
  '$.mutations.*.messages.*',
];

/**
 * Input-only v1 parser. Complete message values are spilled before parsing the
 * next input chunk; parent arrays are cleared as each row is emitted. Remaining
 * objects carry metadata and stable, private array identities for replay.
 * Scratch files are never an authority and source files are never modified.
 */
export class LegacyChatInput {
  private readonly lists = new WeakMap<object, LegacyMessageList>();
  private readonly digests = new WeakMap<object, string>();
  private readonly origins = new WeakMap<object, Location>();
  private offset = 0;
  private readCache?: { offset: number; bytes: Buffer };
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });
  private constructor(
    private readonly handle: FileHandle,
    private readonly path: string,
  ) {}
  public static async create(
    scratchDirectory: string,
  ): Promise<LegacyChatInput> {
    await mkdir(scratchDirectory, { recursive: true });
    const path = join(scratchDirectory, `${randomUUID()}.rows`);
    return new LegacyChatInput(await open(path, 'wx+', 0o600), path);
  }
  public async close(): Promise<void> {
    await this.handle.close();
    await rm(this.path, { force: true });
  }
  public messages(array: readonly PersistedChatMessage[]): LegacyMessageList {
    let list = this.lists.get(array);
    if (!list) {
      if (array.length)
        throw new Error('Legacy replay requires a spilled message array');
      list = new LegacyMessageList(this);
      this.lists.set(array, list);
    }
    return list;
  }
  public fingerprint(record: ChatJournalRecord): string {
    const hash = this.digests.get(record);
    if (!hash) throw new Error('Legacy record has no source fingerprint');
    return hash;
  }
  public origin(record: ChatJournalRecord): Location {
    const location = this.origins.get(record);
    if (!location) throw new Error('Legacy record has no source location');
    return location;
  }
  public async spill(message: PersistedChatMessage): Promise<Location> {
    if (!isPersistedChatMessage(message) || !message.id)
      throw new Error('Invalid legacy transcript message');
    const bytes = Buffer.from(JSON.stringify(message) + '\n');
    const location = { offset: this.offset, length: bytes.length };
    await writeBufferFully(bytes, async (buffer, start, length) => {
      const { bytesWritten } = await this.handle.write(
        buffer,
        start,
        length,
        this.offset,
      );
      this.offset += bytesWritten;
      return bytesWritten;
    });
    return location;
  }
  public async read(location: Location): Promise<PersistedChatMessage> {
    const cached = this.readCache;
    let bytes: Buffer;
    if (
      cached &&
      location.offset >= cached.offset &&
      location.offset + location.length <= cached.offset + cached.bytes.length
    ) {
      bytes = cached.bytes.subarray(
        location.offset - cached.offset,
        location.offset - cached.offset + location.length,
      );
    } else {
      // The scratch file is append-only and private to this migration. Read
      // adjacent small rows together instead of issuing one filesystem request
      // per message; retain at most 64 KiB regardless of transcript size.
      const buffer = Buffer.alloc(Math.max(64 * 1024, location.length));
      let offset = 0;
      while (offset < location.length) {
        const { bytesRead } = await this.handle.read(
          buffer,
          offset,
          buffer.length - offset,
          location.offset + offset,
        );
        if (!bytesRead)
          throw new Error('Incomplete legacy migration scratch row');
        offset += bytesRead;
      }
      bytes = buffer.subarray(0, location.length);
      this.readCache =
        buffer.length <= 64 * 1024
          ? { offset: location.offset, bytes: buffer.subarray(0, offset) }
          : undefined;
    }
    const value: unknown = JSON.parse(this.decoder.decode(bytes));
    if (!isPersistedChatMessage(value))
      throw new Error('Invalid legacy migration scratch row');
    return value;
  }

  private parser(metadataOnly = false): {
    write(bytes: Uint8Array): Promise<void>;
    finish(): Promise<unknown>;
    hasDuplicates(): boolean;
  } {
    const parser = new JSONParser({
      paths: ['$', ...MESSAGE_PATHS],
      stringBufferSize: 64 * 1024,
    });
    const utf8 = new TextDecoder('utf-8', { fatal: true });
    const pending: Array<{
      list: LegacyMessageList;
      message: PersistedChatMessage;
    }> = [];
    const documentLists = new Set<LegacyMessageList>();
    let result: unknown;
    let complete = false;
    const messageDigest = createHash('sha256');
    parser.onValue = ({ value, parent, stack }): void => {
      if (stack.length === 0) {
        result = value;
        complete = true;
        return;
      }
      if (!Array.isArray(parent) || !isPersistedChatMessage(value))
        throw new Error('Invalid legacy transcript message');
      messageDigest
        .update(JSON.stringify(stack.map((entry) => entry.key)))
        .update(JSON.stringify(value))
        .update('\n');
      let list = this.lists.get(parent);
      if (!list) {
        list = new LegacyMessageList(this);
        this.lists.set(parent, list);
      }
      documentLists.add(list);
      if (!metadataOnly) pending.push({ list, message: value });
      // The tokenizer owns the ordinal independently of array.length. Clearing
      // it also prevents a sparse array's length from growing with the file.
      parent.length = 0;
    };
    const drain = async (): Promise<void> => {
      for (const { list, message } of pending) await list.upsert(message);
      pending.length = 0;
    };
    return {
      write: async (bytes): Promise<void> => {
        // Validate original bytes before any decoder can insert U+FFFD.
        utf8.decode(bytes, { stream: true });
        parser.write(bytes);
        await drain();
      },
      finish: async (): Promise<unknown> => {
        utf8.decode();
        if (!parser.isEnded) parser.end();
        await drain();
        if (!complete) throw new Error('Incomplete legacy JSON input');
        if (result && typeof result === 'object')
          this.digests.set(
            result,
            createHash('sha256')
              .update(JSON.stringify(result))
              .update(messageDigest.digest('hex'))
              .digest('hex'),
          );
        return result;
      },
      hasDuplicates: () =>
        Array.from(documentLists).some((list) => list.duplicateIds),
    };
  }

  public async snapshot(path: string, location?: Location): Promise<unknown> {
    const parser = this.parser();
    for await (const chunk of createReadStream(path, {
      highWaterMark: 64 * 1024,
      ...(location
        ? { start: location.offset, end: location.offset + location.length - 1 }
        : {}),
    })) {
      if (!Buffer.isBuffer(chunk))
        throw new Error('Legacy snapshot stream must contain bytes');
      await parser.write(chunk);
    }
    return parser.finish();
  }

  public async *journal(
    path: string,
    metadataOnly = false,
  ): AsyncGenerator<ChatJournalRecord> {
    let parser = this.parser(metadataOnly);
    let hasInput = false;
    let lineStart = 0;
    let consumed = 0;
    for await (const chunk of createReadStream(path, {
      highWaterMark: 64 * 1024,
    })) {
      if (!Buffer.isBuffer(chunk))
        throw new Error('Legacy journal stream must contain bytes');
      let start = 0;
      for (let i = 0; i < chunk.length; i += 1) {
        const byte = chunk[i];
        if (byte !== 10 && byte !== 13 && byte !== 32 && byte !== 9)
          hasInput = true;
        if (byte !== 10) continue;
        await parser.write(chunk.subarray(start, i + 1));
        if (hasInput) {
          const value = await parser.finish();
          if (!isChatJournalRecord(value))
            throw new Error('Invalid legacy journal record');
          if (parser.hasDuplicates())
            throw new Error('Duplicate message ids in legacy journal mutation');
          this.origins.set(value, {
            offset: lineStart,
            length: consumed + i + 1 - lineStart,
          });
          yield value;
        }
        parser = this.parser(metadataOnly);
        hasInput = false;
        start = i + 1;
        lineStart = consumed + i + 1;
      }
      if (start < chunk.length) await parser.write(chunk.subarray(start));
      consumed += chunk.length;
    }
    if (hasInput)
      throw new Error('Incomplete legacy journal tail; source is preserved');
  }
}
