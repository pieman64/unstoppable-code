import { closeSync, readSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { chmod, mkdtemp, rm, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openScratchFileIn, openScratchFileSync } from './private-scratch-file';
import { SpillingRecordStore, type RecordEncoding } from './record-store';

/**
 * Bounded state for streaming a child-controlled JSON record.
 *
 * Values are not the only unbounded dimension. Keys, numeric tokens and
 * nesting depth are written by the same child, so holding any of them whole
 * leaves the resident term O(record) with a different letter on it. Everything
 * here keeps a bounded resident window and puts the remainder in the same kind
 * of private file the record itself uses.
 *
 * Nothing here rejects, caps or renames anything. Crossing a threshold changes
 * only WHERE the bytes sit.
 */

/**
 * Bounded-state work counters.
 *
 * `keyIndexSpills` is the positive control the key budget needs: a record
 * designed to exhaust it has to be observed reaching the file-backed path,
 * not merely observed finishing.
 *
 * These are PROCESS-GLOBAL and monotonic. Two executions sharing a process
 * share them, so a delta measured around one run is only that run's work when
 * nothing else is running — which is true of the tests that read them and is
 * NOT true in general. They measure the specific terms named below and nothing
 * else: a counter that has not moved says that term did no work, never that
 * the work or the memory was bounded.
 */
export const boundedJsonStateCounters = {
  keyIndexSpills: 0,
  /** Slot reads by the file-backed identity table: its lookup work. */
  indexSlotReads: 0,
};

/** Characters buffered before a token block is handed to its store. */
const TOKEN_BLOCK_CHARS = 64 * 1024;

/**
 * One token — a key, a number — being assembled.
 *
 * A small token never touches disk and costs one string, which is what
 * essentially every record contains. A token past `spillAfterChars` keeps
 * going into a private file, so a single multi-gigabyte key costs the same
 * resident memory as a short one.
 */
export class TokenBuffer {
  /**
   * Pieces awaiting a block, joined rather than concatenated.
   *
   * `block += character` per character builds a cons rope with one node per
   * character — roughly 24 bytes each, so a 1 MiB token cost tens of MB of
   * rope before a single byte reached the file, and OOMed under a 96 MB cap.
   * `join` produces one flat string instead.
   */
  private units: string[] = [];
  private unitChars = 0;
  private store: SpillingRecordStore;
  private total = 0;

  constructor(
    private readonly label: string,
    private readonly spillAfterChars: number,
    private readonly encoding: RecordEncoding = 'utf8',
  ) {
    this.store = new SpillingRecordStore(spillAfterChars, label, encoding);
  }

  get length(): number {
    return this.total;
  }

  /** True once this token is file-backed. */
  get spilled(): boolean {
    return this.store.spilled;
  }

  /**
   * Characters this token still holds in memory: the pending block plus
   * whatever its store has not handed to the filesystem yet. Exposed so the
   * bound can be measured rather than asserted.
   */
  get residentLength(): number {
    return this.unitChars + this.store.residentLength;
  }

  /**
   * Appends to the token. A returned promise MUST be awaited: it means the
   * token has passed its budget and either its file is still being created or
   * the established file's write queue is saturated. Continuing to append
   * without waiting keeps the token in memory — exactly the term the budget
   * exists to remove.
   *
   * Both halves matter. Waiting only for creation bounded nothing once the
   * file existed: `append` reports a saturated stream by returning `false`,
   * and ignoring that let a source which never yields — an async generator
   * over an in-memory string — queue the whole token in the stream's own
   * buffer, 16 MiB resident for a 16 MiB token. A promise is still returned
   * only at a block boundary, never per accepted character or per accepted
   * block, so an ordinary token costs no waiting at all.
   */
  push(text: string): Promise<void> | undefined {
    this.units.push(text);
    this.unitChars += text.length;
    this.total += text.length;
    if (this.unitChars < TOKEN_BLOCK_CHARS) return undefined;
    const accepted = this.flushBlock();
    // While the file is still being created every block is held in memory, so
    // that wait comes first; afterwards a refused write is the stream telling
    // this caller to stop until it has drained.
    const settling = this.store.settling();
    if (settling) return settling;
    return accepted ? undefined : this.store.whenDrained();
  }

  /** Hands the pending block to the store, reporting whether it was accepted. */
  private flushBlock(): boolean {
    if (this.unitChars === 0) return true;
    const accepted = this.store.append(this.units.join(''));
    this.units = [];
    this.unitChars = 0;
    return accepted;
  }

  /** Replays the token in bounded chunks. May be called more than once. */
  async *replay(): AsyncIterable<string> {
    this.flushBlock();
    await this.store.whenDrained();
    yield* this.store.replay();
  }

  /** Discards this token's contents and any file behind it. */
  async clear(): Promise<void> {
    this.units = [];
    this.unitChars = 0;
    this.total = 0;
    const previous = this.store;
    this.store = new SpillingRecordStore(
      this.spillAfterChars,
      this.label,
      this.encoding,
    );
    await previous.dispose();
  }

  dispose(): Promise<void> {
    this.units = [];
    this.unitChars = 0;
    this.total = 0;
    return this.store.dispose();
  }
}

/**
 * Text accumulated up to a limit, then abandoned.
 *
 * Same reason as `TokenBuffer`: building it with `+=` per character is a rope
 * with a node per character. Once the limit is passed the text is dropped
 * entirely — the caller keeps the digest, which stays exact.
 */
export class BoundedText {
  private units: string[] = [];
  private blocks: string[] = [];
  private unitCount = 0;
  private total = 0;
  private overflowed = false;

  constructor(private readonly limit: number) {}

  push(text: string): void {
    if (this.overflowed) return;
    this.total += text.length;
    if (this.total > this.limit) {
      this.overflowed = true;
      this.units = [];
      this.blocks = [];
      return;
    }
    this.units.push(text);
    this.unitCount += 1;
    if (this.unitCount < 4096) return;
    this.blocks.push(this.units.join(''));
    this.units = [];
    this.unitCount = 0;
  }

  /** The accumulated text, or `undefined` once it passed the limit. */
  value(): string | undefined {
    if (this.overflowed) return undefined;
    if (this.unitCount > 0) {
      this.blocks.push(this.units.join(''));
      this.units = [];
      this.unitCount = 0;
    }
    if (this.blocks.length > 1) this.blocks = [this.blocks.join('')];
    return this.blocks[0] ?? '';
  }
}

// ---------------------------------------------------------------------------
// Key identities
// ---------------------------------------------------------------------------

/**
 * A resumable 128-bit digest.
 *
 * Resumable because a candidate name is the identity plus `__N`: continuing
 * the digest past the identity is what lets a key too large to hold still be
 * probed against `identity__1`, `identity__2`, ... without re-reading it.
 *
 * It is an ACCELERATOR, never an identity: every digest match is confirmed by
 * comparing the stored name exactly. The seeds are salted once per process so
 * collisions cannot be precomputed offline to crowd one probe sequence.
 */
export type DigestState = [number, number, number, number];

/**
 * Drawn once per process, on first use rather than at import: drawing it at
 * load made merely importing the executor chain require a working
 * `randomBytes`, which broke unrelated suites that partially mock
 * `node:crypto`. There is no fallback — without randomness there are no seeds.
 */
let digestSeeds: readonly number[] | undefined;

function seeds(): readonly number[] {
  if (digestSeeds) return digestSeeds;
  const salt = randomBytes(16);
  digestSeeds = [
    (0x811c9dc5 ^ salt.readUInt32LE(0)) >>> 0,
    (0x27d4eb2f ^ salt.readUInt32LE(4)) >>> 0,
    (0x7feb352d ^ salt.readUInt32LE(8)) >>> 0,
    (0x2545f491 ^ salt.readUInt32LE(12)) >>> 0,
  ];
  return digestSeeds;
}
const DIGEST_PRIMES: readonly number[] = [
  16777619, 0x85ebca6b, 0xc2b2ae35, 0x9e3779b1,
];

export function digestStart(): DigestState {
  const [a = 0, b = 0, c = 0, d = 0] = seeds();
  return [a, b, c, d];
}

export function digestPush(state: DigestState, code: number): void {
  for (let lane = 0; lane < 4; lane += 1) {
    const mixed = (state[lane] ?? 0) ^ (code + lane * 0x9e3779b9);
    state[lane] = Math.imul(mixed, DIGEST_PRIMES[lane] ?? 1) >>> 0;
  }
}

export function digestPushText(state: DigestState, text: string): void {
  for (let at = 0; at < text.length; at += 1)
    digestPush(state, text.charCodeAt(at));
}

export function digestCopy(state: DigestState): DigestState {
  return [state[0], state[1], state[2], state[3]];
}

/** The literal every masked value becomes. */
const MASK = '***';

/**
 * A key identity too large to hold as text, readable again on demand.
 *
 * `hasMask` is computed while the identity streams past, so a key that can
 * never collide with a masked name is recognised without reading it back.
 */
export interface IdentitySource {
  readonly length: number;
  readonly hasMask: boolean;
  replay(): AsyncIterable<string>;
}

/**
 * Key text of any length: held as a string up to `limit` characters, then
 * continued into a `TokenBuffer` so it can still be compared exactly.
 */
export class IdentityText {
  private held: string[] = [];
  private heldChars = 0;
  private spilled: TokenBuffer | undefined;
  private total = 0;
  private tail = '';
  private sawMask = false;

  constructor(
    private readonly limit: number,
    private readonly spillAfterChars: number,
  ) {}

  push(text: string): Promise<void> | undefined {
    this.total += text.length;
    if (!this.sawMask) {
      const probe = this.tail + text;
      if (probe.includes(MASK)) this.sawMask = true;
      else this.tail = probe.slice(-(MASK.length - 1));
    }
    const buffer = this.spilled;
    if (buffer) return buffer.push(text);
    this.held.push(text);
    this.heldChars += text.length;
    if (this.heldChars <= this.limit) return undefined;
    const moving = this.held.join('');
    this.held = [];
    this.heldChars = 0;
    // Decoded key text: its exact code units ARE the identity, lone
    // surrogates from JSON escapes included.
    const created = new TokenBuffer(
      'identity',
      this.spillAfterChars,
      'utf16le',
    );
    this.spilled = created;
    return created.push(moving);
  }

  /** The text, when it was small enough to hold. */
  text(): string | undefined {
    if (this.spilled) return undefined;
    if (this.held.length > 1) this.held = [this.held.join('')];
    return this.held[0] ?? '';
  }

  source(): IdentitySource {
    const spilled = this.spilled;
    const text = this.text();
    return {
      length: this.total,
      hasMask: this.sawMask,
      replay: spilled
        ? (): AsyncIterable<string> => spilled.replay()
        : async function* (): AsyncIterable<string> {
            yield await Promise.resolve(text ?? '');
          },
    };
  }

  async dispose(): Promise<void> {
    this.held = [];
    const spilled = this.spilled;
    this.spilled = undefined;
    if (spilled) await spilled.dispose();
  }
}

/**
 * What one retained identity costs beyond its own characters, in the
 * resident exact set. Empty names are valid JSON and stay supported; they are
 * just not free. A deliberate under-estimate of a JS Set entry plus its string
 * header, expressed in the same units as the budget.
 */
const ENTRY_OVERHEAD_CHARS = 32;
/** What one scope costs in the resident exact set. */
const SCOPE_OVERHEAD_CHARS = 64;

/** Bytes per slot in the file-backed identity table. */
const SLOT_BYTES = 56;
/** Initial slot count; the table doubles at half load. */
const INITIAL_SLOTS = 1 << 12;
/** Slots read per block while rehashing. */
const REHASH_BLOCK_SLOTS = 1024;
/** Slot kinds: a reserved identity, or the next-suffix hint for a base name. */
const KIND_IDENTITY = 1;
const KIND_HINT = 2;

interface Ident {
  lanes: DigestState;
  chars: number;
  chunks: () => AsyncIterable<string>;
}

function identOf(
  digest: DigestState,
  text: string | undefined,
  source: IdentitySource | undefined,
): Ident {
  if (text !== undefined)
    return {
      lanes: digest,
      chars: text.length,
      chunks: async function* (): AsyncIterable<string> {
        yield await Promise.resolve(text);
      },
    };
  if (!source) throw new Error('A key identity needs its text or a source');
  return {
    lanes: digest,
    chars: source.length,
    chunks: (): AsyncIterable<string> => source.replay(),
  };
}

function withSuffix(ident: Ident, suffix: string): Ident {
  const lanes = digestCopy(ident.lanes);
  digestPushText(lanes, suffix);
  const base = ident.chunks;
  return {
    lanes,
    chars: ident.chars + suffix.length,
    chunks: async function* (): AsyncIterable<string> {
      yield* base();
      yield suffix;
    },
  };
}

/**
 * An exact set of `(kind, scope, identity) -> value`, on disk.
 *
 * Open addressing with linear probing over a slot file, identities stored once
 * in a data file as UTF-16 (so any JS string — lone surrogates included —
 * round-trips exactly). Resident state is a fixed handful of numbers and two
 * reusable buffers however many identities it holds: no per-run descriptor,
 * no cache that grows. Load stays at or below one half, so a lookup reads a
 * small expected number of slots; a slot's digest only rules candidates OUT —
 * a match is always confirmed by comparing the stored name exactly.
 */
class ExactIdentityTable {
  private slots: FileHandle | undefined;
  private data: FileHandle | undefined;
  private directory: string | undefined;
  private slotsName = 'slots-0';
  private generation = 0;
  private capacity = INITIAL_SLOTS;
  private count = 0;
  private dataEnd = 0;
  private readonly slot = Buffer.alloc(SLOT_BYTES);
  private readonly compareBuffer = Buffer.alloc(64 * 1024);

  constructor(private readonly forceCollisions: boolean) {}

  /** Resident descriptors: constant by construction. */
  readonly residentBookkeeping = 2;

  /**
   * Set once by `dispose`. Anything an operation already in flight acquires
   * afterwards is released at once instead of being published into a table
   * nobody will dispose again.
   */
  private disposed = false;

  /**
   * Acquires the directory and both files, owning each the moment it exists.
   *
   * Recording them only after the NEXT step succeeded left what was already
   * acquired outside disposal whenever a step failed: the directory on a
   * failed chmod, an open descriptor on a failed open or truncate. Any failure
   * here now releases everything acquired so far before it propagates.
   *
   * Each file is unlinked before its first write (see `openScratchFileIn`),
   * so a killed process leaves none of the stored names behind: at most this
   * empty directory, which later slot files are created in.
   */
  private async open(): Promise<{ slots: FileHandle; data: FileHandle }> {
    const slots = this.slots;
    const data = this.data;
    if (slots && data) return { slots, data };
    this.assertOpen();
    try {
      const directory = await mkdtemp(join(tmpdir(), 'canopy-keyindex-'));
      this.directory = directory;
      this.assertOpen();
      await chmod(directory, 0o700);
      const openedSlots = await openScratchFileIn(directory, this.slotsName);
      this.slots = openedSlots;
      this.assertOpen();
      await openedSlots.truncate(this.capacity * SLOT_BYTES);
      const openedData = await openScratchFileIn(directory, 'data');
      this.data = openedData;
      this.assertOpen();
      return { slots: openedSlots, data: openedData };
    } catch (error) {
      await this.release();
      throw error;
    }
  }

  private assertOpen(): void {
    if (this.disposed) throw new Error('The key index is closed');
  }

  private lanesOf(ident: Ident): DigestState {
    return this.forceCollisions ? [1, 2, 3, 4] : ident.lanes;
  }

  private position(
    kind: number,
    scope: number,
    lanes: DigestState,
    capacity: number,
  ): number {
    let mixed =
      (lanes[0] ^
        Math.imul(lanes[1], 0x9e3779b1) ^
        Math.imul(lanes[2], 0x85ebca6b) ^
        lanes[3] ^
        Math.imul(scope >>> 0, 0xc2b2ae35) ^
        Math.imul(Math.floor(scope / 0x100000000), 0x27d4eb2f) ^
        kind) >>>
      0;
    mixed = Math.imul(mixed ^ (mixed >>> 16), 0x7feb352d) >>> 0;
    return (mixed ^ (mixed >>> 15)) & (capacity - 1);
  }

  private async readSlot(handle: FileHandle, index: number): Promise<void> {
    boundedJsonStateCounters.indexSlotReads += 1;
    await handle.read(this.slot, 0, SLOT_BYTES, index * SLOT_BYTES);
  }

  /** Streams the identity and compares it to the stored UTF-16 bytes. */
  private async sameText(
    data: FileHandle,
    offset: number,
    ident: Ident,
  ): Promise<boolean> {
    let at = offset;
    for await (const chunk of ident.chunks()) {
      const bytes = Buffer.from(chunk, 'utf16le');
      for (let done = 0; done < bytes.length; ) {
        const size = Math.min(this.compareBuffer.length, bytes.length - done);
        await data.read(this.compareBuffer, 0, size, at);
        if (
          !this.compareBuffer
            .subarray(0, size)
            .equals(bytes.subarray(done, done + size))
        )
          return false;
        done += size;
        at += size;
      }
    }
    return true;
  }

  private slotMatches(
    kind: number,
    scope: number,
    lanes: DigestState,
    chars: number,
  ): boolean {
    return (
      this.slot.readUInt8(0) === 1 &&
      this.slot.readUInt8(1) === kind &&
      this.slot.readDoubleLE(8) === scope &&
      this.slot.readUInt32LE(16) === lanes[0] &&
      this.slot.readUInt32LE(20) === lanes[1] &&
      this.slot.readUInt32LE(24) === lanes[2] &&
      this.slot.readUInt32LE(28) === lanes[3] &&
      this.slot.readDoubleLE(40) === chars
    );
  }

  /** The slot index and value for an exact match, or `undefined`. */
  async find(
    kind: number,
    scope: number,
    ident: Ident,
  ): Promise<{ index: number; value: number } | undefined> {
    const { slots, data } = await this.open();
    const lanes = this.lanesOf(ident);
    let index = this.position(kind, scope, lanes, this.capacity);
    for (let probed = 0; probed < this.capacity; probed += 1) {
      await this.readSlot(slots, index);
      if (this.slot.readUInt8(0) === 0) return undefined;
      if (this.slotMatches(kind, scope, lanes, ident.chars)) {
        const offset = this.slot.readDoubleLE(32);
        const value = this.slot.readDoubleLE(48);
        if (await this.sameText(data, offset, ident)) return { index, value };
      }
      index = (index + 1) & (this.capacity - 1);
    }
    return undefined;
  }

  private encodeSlot(
    kind: number,
    scope: number,
    lanes: DigestState,
    offset: number,
    chars: number,
    value: number,
  ): Buffer {
    const out = Buffer.alloc(SLOT_BYTES);
    out.writeUInt8(1, 0);
    out.writeUInt8(kind, 1);
    out.writeDoubleLE(scope, 8);
    out.writeUInt32LE(lanes[0], 16);
    out.writeUInt32LE(lanes[1], 20);
    out.writeUInt32LE(lanes[2], 24);
    out.writeUInt32LE(lanes[3], 28);
    out.writeDoubleLE(offset, 32);
    out.writeDoubleLE(chars, 40);
    out.writeDoubleLE(value, 48);
    return out;
  }

  private async place(
    slots: FileHandle,
    capacity: number,
    encoded: Buffer,
  ): Promise<void> {
    const lanes: DigestState = [
      encoded.readUInt32LE(16),
      encoded.readUInt32LE(20),
      encoded.readUInt32LE(24),
      encoded.readUInt32LE(28),
    ];
    let index = this.position(
      encoded.readUInt8(1),
      encoded.readDoubleLE(8),
      lanes,
      capacity,
    );
    for (;;) {
      await this.readSlot(slots, index);
      if (this.slot.readUInt8(0) === 0) break;
      index = (index + 1) & (capacity - 1);
    }
    await slots.write(encoded, 0, SLOT_BYTES, index * SLOT_BYTES);
  }

  /** Inserts an identity known to be absent. */
  async insert(
    kind: number,
    scope: number,
    ident: Ident,
    value: number,
  ): Promise<void> {
    if ((this.count + 1) * 2 > this.capacity) await this.grow();
    const { slots, data } = await this.open();
    const offset = this.dataEnd;
    for await (const chunk of ident.chunks()) {
      const bytes = Buffer.from(chunk, 'utf16le');
      await data.write(bytes, 0, bytes.length, this.dataEnd);
      this.dataEnd += bytes.length;
    }
    await this.place(
      slots,
      this.capacity,
      this.encodeSlot(
        kind,
        scope,
        this.lanesOf(ident),
        offset,
        ident.chars,
        value,
      ),
    );
    this.count += 1;
  }

  async setValue(index: number, value: number): Promise<void> {
    const { slots } = await this.open();
    const bytes = Buffer.alloc(8);
    bytes.writeDoubleLE(value, 0);
    await slots.write(bytes, 0, 8, index * SLOT_BYTES + 48);
  }

  /** Doubles the slot file, reinserting every slot in bounded blocks. */
  private async grow(): Promise<void> {
    const { slots: old } = await this.open();
    const directory = this.directory ?? '';
    const next = this.capacity * 2;
    this.generation += 1;
    const nextName = `slots-${this.generation}`;
    const fresh = await openScratchFileIn(directory, nextName);
    // Until it replaces the old file, the fresh one belongs to this call: a
    // failed truncate, read or rehash write closes and removes it, and the
    // table carries on with the old file at the old capacity.
    try {
      this.assertOpen();
      await fresh.truncate(next * SLOT_BYTES);
      const block = Buffer.alloc(REHASH_BLOCK_SLOTS * SLOT_BYTES);
      for (let start = 0; start < this.capacity; start += REHASH_BLOCK_SLOTS) {
        const count = Math.min(REHASH_BLOCK_SLOTS, this.capacity - start);
        await old.read(block, 0, count * SLOT_BYTES, start * SLOT_BYTES);
        for (let at = 0; at < count; at += 1) {
          const encoded = block.subarray(
            at * SLOT_BYTES,
            (at + 1) * SLOT_BYTES,
          );
          if (encoded.readUInt8(0) === 1)
            await this.place(fresh, next, Buffer.from(encoded));
        }
      }
      this.assertOpen();
    } catch (error) {
      // Already nameless, so closing it frees it.
      await fresh.close().catch(() => undefined);
      throw error;
    }
    // Published BEFORE the old file is released, so a failure releasing it
    // can never leave the fresh descriptor unowned.
    this.slots = fresh;
    this.slotsName = nextName;
    this.capacity = next;
    await old.close().catch(() => undefined);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.release();
  }

  /** Closes and removes whatever is currently owned. Idempotent. */
  private async release(): Promise<void> {
    const handles = [this.slots, this.data];
    this.slots = undefined;
    this.data = undefined;
    for (const handle of handles)
      if (handle) await handle.close().catch(() => undefined);
    const directory = this.directory;
    this.directory = undefined;
    if (directory)
      await rm(directory, { recursive: true, force: true }).catch(
        () => undefined,
      );
  }
}

/**
 * The set of key names a masked key must not take, per object scope.
 *
 * Only a name that CONTAINS the mask can ever equal a masked name or one of
 * its `__N` candidates, because every one of those contains the mask. So an
 * identity without it is never retained at all — an exact filter, not a
 * probabilistic one, and it makes ordinary records cost nothing here.
 *
 * Below `exactAfterChars` of retained text the mask-bearing names are held as
 * strings — the path essentially every record takes. Past it, and for any
 * name too large to hold, they live in an `ExactIdentityTable`: identity is
 * decided by exact comparison there too, so output never depends on the
 * backing, a digest collision can only cost a comparison, and resident
 * bookkeeping stays constant however many names there are.
 */
export class KeyIdentityIndex {
  private readonly exact = new Map<number, Set<string>>();
  private readonly nextSuffix = new Map<string, number>();
  private exactChars = 0;
  private table: ExactIdentityTable | undefined;

  constructor(
    private readonly exactAfterChars: number,
    private readonly options: { forceDigestCollisions?: boolean } = {},
  ) {}

  /** True once names are held in the file-backed table. */
  get spilled(): boolean {
    return this.table !== undefined;
  }

  /**
   * Resident bookkeeping entries: bounded by the budget before spilling and
   * constant after it.
   */
  get residentBookkeeping(): number {
    return this.table
      ? this.table.residentBookkeeping
      : this.exact.size + this.nextSuffix.size;
  }

  private ensureTable(): ExactIdentityTable {
    const existing = this.table;
    if (existing) return existing;
    const created = new ExactIdentityTable(
      this.options.forceDigestCollisions ?? false,
    );
    this.table = created;
    return created;
  }

  private async moveToTable(): Promise<ExactIdentityTable> {
    const table = this.ensureTable();
    if (this.exact.size === 0 && this.nextSuffix.size === 0) return table;
    boundedJsonStateCounters.keyIndexSpills += 1;
    for (const scopeId of Array.from(this.exact.keys()))
      for (const name of Array.from(this.exact.get(scopeId) ?? [])) {
        const digest = digestStart();
        digestPushText(digest, name);
        const ident = identOf(digest, name, undefined);
        if (!(await table.find(KIND_IDENTITY, scopeId, ident)))
          await table.insert(KIND_IDENTITY, scopeId, ident, 0);
      }
    for (const [hint, next] of Array.from(this.nextSuffix.entries())) {
      const split = hint.indexOf(' ');
      const scopeId = Number(hint.slice(0, split));
      const name = hint.slice(split + 1);
      const digest = digestStart();
      digestPushText(digest, name);
      await table.insert(
        KIND_HINT,
        scopeId,
        identOf(digest, name, undefined),
        next,
      );
    }
    this.exact.clear();
    this.nextSuffix.clear();
    this.exactChars = 0;
    return table;
  }

  /**
   * Records an identity present in `scopeId`.
   *
   * `text` is the decoded identity when small enough to hold; otherwise
   * `source` replays it. Names without the mask are ignored, exactly.
   */
  reserve(
    scopeId: number,
    digest: DigestState,
    text: string | undefined,
    source?: IdentitySource,
  ): Promise<void> | undefined {
    const hasMask =
      text !== undefined ? text.includes(MASK) : (source?.hasMask ?? false);
    if (!hasMask) return undefined;
    if (!this.table && text !== undefined) {
      const existing = this.exact.get(scopeId);
      const scope = existing ?? new Set<string>();
      if (!existing) {
        this.exact.set(scopeId, scope);
        this.exactChars += SCOPE_OVERHEAD_CHARS;
      }
      if (!scope.has(text)) {
        scope.add(text);
        this.exactChars += text.length + ENTRY_OVERHEAD_CHARS;
      }
      if (this.exactChars <= this.exactAfterChars) return undefined;
      return this.moveToTable().then(() => undefined);
    }
    return this.reserveInTable(scopeId, identOf(digest, text, source));
  }

  private async reserveInTable(scopeId: number, ident: Ident): Promise<void> {
    const table = await this.moveToTable();
    if (!(await table.find(KIND_IDENTITY, scopeId, ident)))
      await table.insert(KIND_IDENTITY, scopeId, ident, 0);
  }

  /**
   * Returns the `__N` suffix a masked key must take in `scopeId`, or 0 when
   * the name is free, and reserves whatever it returns. Only masked names are
   * asked about — the filter that makes this exact depends on it.
   */
  allocate(
    scopeId: number,
    digest: DigestState,
    text: string | undefined,
    source?: IdentitySource,
  ): number | Promise<number> {
    const hasMask =
      text !== undefined ? text.includes(MASK) : (source?.hasMask ?? false);
    if (!hasMask)
      throw new Error('Only a masked key name is allocated a suffix');
    if (!this.table && text !== undefined) {
      const scope = this.exact.get(scopeId);
      if (!scope?.has(text)) {
        const settled = this.reserve(scopeId, digest, text);
        return settled ? settled.then(() => 0) : 0;
      }
      // A reserved name is never released, so a candidate rejected once can
      // never become free; resuming past it keeps k colliding siblings linear.
      const hint = `${scopeId} ${text}`;
      for (let counter = this.nextSuffix.get(hint) ?? 1; ; counter += 1) {
        const candidate = `${text}__${counter}`;
        if (scope.has(candidate)) continue;
        const candidateDigest = digestCopy(digest);
        digestPushText(candidateDigest, `__${counter}`);
        if (!this.nextSuffix.has(hint))
          this.exactChars += hint.length + ENTRY_OVERHEAD_CHARS;
        this.nextSuffix.set(hint, counter + 1);
        const settled = this.reserve(scopeId, candidateDigest, candidate);
        const taken = counter;
        return settled ? settled.then(() => taken) : taken;
      }
    }
    return this.allocateInTable(scopeId, identOf(digest, text, source));
  }

  private async allocateInTable(scopeId: number, base: Ident): Promise<number> {
    const table = await this.moveToTable();
    if (!(await table.find(KIND_IDENTITY, scopeId, base))) {
      await table.insert(KIND_IDENTITY, scopeId, base, 0);
      return 0;
    }
    // The hint is stored in the same exact table, so resuming past rejected
    // candidates keeps colliding siblings linear without a resident cache.
    const hint = await table.find(KIND_HINT, scopeId, base);
    for (let counter = hint?.value ?? 1; ; counter += 1) {
      const candidate = withSuffix(base, `__${counter}`);
      if (await table.find(KIND_IDENTITY, scopeId, candidate)) continue;
      await table.insert(KIND_IDENTITY, scopeId, candidate, 0);
      if (hint) await table.setValue(hint.index, counter + 1);
      else await table.insert(KIND_HINT, scopeId, base, counter + 1);
      return counter;
    }
  }

  async dispose(): Promise<void> {
    this.exact.clear();
    this.nextSuffix.clear();
    const table = this.table;
    this.table = undefined;
    if (table) await table.dispose();
  }
}

// ---------------------------------------------------------------------------
// Nesting
// ---------------------------------------------------------------------------

/** Frames held in memory; deeper ones live in a private file. */
const RESIDENT_FRAMES = 1 << 16;
/**
 * Bytes per frame: one kind byte, padding, and a float64 scope id.
 *
 * Every object gets the next scope id and nothing caps how many objects a
 * record holds, so the id must stay exact past 2^32 — a signed 32-bit id went
 * negative at 2^31 and wrapped onto earlier scopes at 2^32, merging unrelated
 * objects' key sets. A double is exact for every integer up to 2^53.
 */
const FRAME_BYTES = 16;

/**
 * The open-container stack.
 *
 * Nesting is child-controlled, so `Array<'object' | 'array'>` plus a parallel
 * number array is an unbounded resident term. Frames are packed into typed
 * arrays and the portion below the resident window is written to a private
 * file, so a record that is nothing but opening brackets costs a fixed window.
 *
 * Deliberately synchronous: this sits on the per-character path, and making it
 * asynchronous would make the whole validator asynchronous per character. The
 * file is touched once per 32,768 levels of depth — tens of kilobytes of pure
 * brackets per block — so the amortized cost is negligible, and it is reached
 * only by input engineered to reach it.
 */
export class FrameStack {
  private kinds = new Uint8Array(1024);
  private scopes = new Float64Array(1024);
  /** Frames already written out; `depth - base` indexes the resident window. */
  private base = 0;
  private depth = 0;
  private descriptor: number | undefined;
  private directory: string | undefined;
  private block: Buffer | undefined;

  get size(): number {
    return this.depth;
  }

  get topKind(): 'object' | 'array' | undefined {
    if (this.depth === 0) return undefined;
    return (this.kinds[this.depth - this.base - 1] ?? 0) === 1
      ? 'object'
      : 'array';
  }

  get topScope(): number {
    if (this.depth === 0) return 0;
    return this.scopes[this.depth - this.base - 1] ?? 0;
  }

  push(kind: 'object' | 'array', scopeId: number): void {
    if (this.depth - this.base >= this.kinds.length) this.grow();
    const at = this.depth - this.base;
    this.kinds[at] = kind === 'object' ? 1 : 2;
    this.scopes[at] = scopeId;
    this.depth += 1;
  }

  pop(): void {
    if (this.depth === 0) return;
    this.depth -= 1;
    // The top frame's index is `depth - 1`, so the window is exhausted once
    // `depth` reaches `base` — not once it falls below it. Off by one here
    // returned an empty frame as the top of a 200,000-deep stack.
    if (this.depth <= this.base && this.base > 0) this.pageIn();
  }

  private grow(): void {
    if (this.kinds.length >= RESIDENT_FRAMES) {
      this.pageOut();
      return;
    }
    const kinds = new Uint8Array(this.kinds.length * 2);
    kinds.set(this.kinds);
    this.kinds = kinds;
    const scopes = new Float64Array(this.scopes.length * 2);
    scopes.set(this.scopes);
    this.scopes = scopes;
  }

  private buffer(): Buffer {
    const existing = this.block;
    if (existing) return existing;
    const created = Buffer.allocUnsafe((RESIDENT_FRAMES >> 1) * FRAME_BYTES);
    this.block = created;
    return created;
  }

  private file(): number {
    const existing = this.descriptor;
    if (existing !== undefined) return existing;
    // Nameless from before its first write (see `openScratchFileSync`), so a
    // killed process leaves no frame file behind; a failed setup removes what
    // it created before this throws.
    const { descriptor, directory } = openScratchFileSync(
      'canopy-frames-',
      'frames',
    );
    this.directory = directory;
    this.descriptor = descriptor;
    return descriptor;
  }

  private pageOut(): void {
    const count = RESIDENT_FRAMES >> 1;
    const block = this.buffer();
    for (let at = 0; at < count; at += 1) {
      block.writeUInt8(this.kinds[at] ?? 0, at * FRAME_BYTES);
      block.writeDoubleBE(this.scopes[at] ?? 0, at * FRAME_BYTES + 8);
    }
    writeSync(
      this.file(),
      block,
      0,
      count * FRAME_BYTES,
      this.base * FRAME_BYTES,
    );
    this.kinds.copyWithin(0, count);
    this.scopes.copyWithin(0, count);
    this.base += count;
  }

  private pageIn(): void {
    const count = Math.min(RESIDENT_FRAMES >> 1, this.base);
    if (count === 0) return;
    const from = this.base - count;
    const block = this.buffer();
    readSync(this.file(), block, 0, count * FRAME_BYTES, from * FRAME_BYTES);
    const live = Math.max(this.depth - this.base, 0);
    this.kinds.copyWithin(count, 0, live);
    this.scopes.copyWithin(count, 0, live);
    for (let at = 0; at < count; at += 1) {
      this.kinds[at] = block.readUInt8(at * FRAME_BYTES);
      this.scopes[at] = block.readDoubleBE(at * FRAME_BYTES + 8);
    }
    this.base = from;
  }

  /** Awaitable so the removal cannot outlive the caller as a floating task. */
  dispose(): Promise<void> {
    const descriptor = this.descriptor;
    this.descriptor = undefined;
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Already closed; disposal is idempotent.
      }
    }
    const directory = this.directory;
    this.directory = undefined;
    this.block = undefined;
    if (!directory) return Promise.resolve();
    return rm(directory, { recursive: true, force: true }).catch(
      () => undefined,
    );
  }
}
