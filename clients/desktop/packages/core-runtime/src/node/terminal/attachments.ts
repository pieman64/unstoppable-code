import { randomUUID } from 'node:crypto';
import type { TerminalExitEvent } from '@canopy/protocol/terminal';
import type {
  TerminalAttachmentItem,
  TerminalAttachmentOutcome,
  TerminalAttachmentSink,
} from './ports';
import type { TerminalReplayWindow } from './replay';

/**
 * Stream bounds, sized to the bundled worker binding a `worker.terminal.attach`
 * stream will cross: the dispatcher buffers at most 1,024 items per stream and
 * the binding opens at most 128 streams. 128 unacknowledged items of 64 KiB is
 * 8 MiB of raw output, about 11 MiB as base64, inside the client's 16 MiB
 * stream budget. 64 attachments leave half of the binding's streams to other
 * operations.
 */
export const TERMINAL_ATTACHMENT_ITEM_MAX_BYTES = 64 * 1024;
export const TERMINAL_ATTACHMENT_MAX_PENDING_ITEMS = 128;
export const TERMINAL_ATTACH_REPLAY_MAX_BYTES = 1024 * 1024;
export const TERMINAL_MAX_ATTACHMENTS = 64;
export const TERMINAL_MAX_ATTACHMENTS_PER_TERMINAL = 8;

/**
 * The output every attachment to one terminal reads. Attachments keep it
 * after the terminal is gone, so they can drain to its exit.
 */
export interface TerminalAttachmentSource {
  readonly terminalId: string;
  readonly window: TerminalReplayWindow;
  /** Offset just past the last byte the terminal has emitted as output. */
  emitted: number;
  exit: TerminalExitEvent | null;
}

interface AttachmentState {
  readonly id: string;
  readonly source: TerminalAttachmentSource;
  readonly sink: TerminalAttachmentSink;
  cursor: number;
  truncatedBefore: boolean;
  /** `toOffset` of each delivered, unacknowledged item. */
  pending: number[];
  ended: boolean;
  pumping: boolean;
}

export class TerminalAttachmentCapacityError extends Error {
  public readonly code = 'ERR_TERMINAL_ATTACHMENT_CAPACITY';

  public constructor(message: string) {
    super(`ERR_TERMINAL_ATTACHMENT_CAPACITY: ${message}`);
    this.name = 'TerminalAttachmentCapacityError';
  }
}

export interface TerminalAttachmentsOptions {
  createAttachmentId?: () => string;
  maxAttachments?: number;
  maxAttachmentsPerTerminal?: number;
}

function assertOffset(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`Invalid ${label}: must be a non-negative integer`);
  }
}

/** The attachments of every terminal of one engine. */
export class TerminalAttachments {
  private readonly byId = new Map<string, AttachmentState>();

  private readonly bySource = new Map<
    TerminalAttachmentSource,
    Set<AttachmentState>
  >();

  private readonly createAttachmentId: () => string;

  /** The output being published, readable while its pumps run. */
  private flushed: {
    source: TerminalAttachmentSource;
    from: number;
    bytes: Buffer;
  } | null = null;

  private readonly maxAttachments: number;

  private readonly maxAttachmentsPerTerminal: number;

  public constructor(options: TerminalAttachmentsOptions = {}) {
    this.createAttachmentId = options.createAttachmentId ?? randomUUID;
    this.maxAttachments = options.maxAttachments ?? TERMINAL_MAX_ATTACHMENTS;
    this.maxAttachmentsPerTerminal =
      options.maxAttachmentsPerTerminal ??
      TERMINAL_MAX_ATTACHMENTS_PER_TERMINAL;
  }

  public open(
    source: TerminalAttachmentSource,
    request: {
      fromOffset: number;
      maxReplayBytes?: number;
      sink: TerminalAttachmentSink;
    },
  ): string {
    const maxReplayBytes =
      request.maxReplayBytes ?? TERMINAL_ATTACH_REPLAY_MAX_BYTES;
    assertOffset(request.fromOffset, 'fromOffset');
    assertOffset(maxReplayBytes, 'maxReplayBytes');
    if (request.fromOffset > source.emitted) {
      throw new RangeError(
        `Invalid fromOffset: terminal ${source.terminalId} has emitted ${source.emitted} bytes`,
      );
    }
    if (maxReplayBytes > TERMINAL_ATTACH_REPLAY_MAX_BYTES) {
      throw new RangeError(
        `Invalid maxReplayBytes: must be at most ${TERMINAL_ATTACH_REPLAY_MAX_BYTES}`,
      );
    }
    if (this.byId.size >= this.maxAttachments) {
      throw new TerminalAttachmentCapacityError(
        `Refusing more than ${this.maxAttachments} terminal attachments.`,
      );
    }
    const siblings = this.bySource.get(source) ?? new Set<AttachmentState>();
    if (siblings.size >= this.maxAttachmentsPerTerminal) {
      throw new TerminalAttachmentCapacityError(
        `Refusing more than ${this.maxAttachmentsPerTerminal} attachments to one terminal.`,
      );
    }

    const replayFrom = Math.max(
      request.fromOffset,
      source.window.startOffset,
      source.emitted - maxReplayBytes,
    );
    const state: AttachmentState = {
      id: this.createAttachmentId(),
      source,
      sink: request.sink,
      cursor: replayFrom,
      truncatedBefore: replayFrom > request.fromOffset,
      pending: [],
      ended: false,
      pumping: false,
    };
    this.byId.set(state.id, state);
    siblings.add(state);
    this.bySource.set(source, siblings);
    this.pump(state);
    return state.id;
  }

  /**
   * New output or the exit reached `source`. `flushed` is the output just
   * emitted, ending at `source.emitted`: attachments that keep up read it
   * even where it is larger than the replay window.
   */
  public publish(source: TerminalAttachmentSource, flushed?: Buffer): void {
    const states = this.bySource.get(source);
    if (!states) return;
    const previous = this.flushed;
    if (flushed) {
      this.flushed = {
        source,
        from: source.emitted - flushed.length,
        bytes: flushed,
      };
    }
    try {
      for (const state of Array.from(states)) this.pump(state);
    } finally {
      this.flushed = previous;
    }
  }

  public acknowledge(attachmentId: string, offset: number): void {
    assertOffset(offset, 'offset');
    const state = this.byId.get(attachmentId);
    if (!state) return;
    state.pending = state.pending.filter((pending) => pending > offset);
    this.pump(state);
  }

  public release(attachmentId: string): void {
    const state = this.byId.get(attachmentId);
    if (state) this.end(state, 'cancelled');
  }

  public count(source: TerminalAttachmentSource): number {
    return this.bySource.get(source)?.size ?? 0;
  }

  private pump(state: AttachmentState): void {
    if (state.ended || state.pumping) return;
    state.pumping = true;
    try {
      const { source } = state;
      while (
        !state.ended &&
        state.pending.length < TERMINAL_ATTACHMENT_MAX_PENDING_ITEMS
      ) {
        const oldest = this.oldestReadable(source);
        if (state.cursor < oldest) {
          state.cursor = oldest;
          state.truncatedBefore = true;
        }
        if (state.cursor < source.emitted) {
          const to = Math.min(
            source.emitted,
            state.cursor + TERMINAL_ATTACHMENT_ITEM_MAX_BYTES,
          );
          const data = this.read(source, state.cursor, to);
          if (data === null) break;
          this.deliver(state, to, Uint8Array.from(data), null);
          continue;
        }
        if (source.exit !== null) {
          this.deliver(state, state.cursor, new Uint8Array(0), source.exit);
          this.end(state, 'completed');
        }
        break;
      }
    } finally {
      state.pumping = false;
    }
  }

  private oldestReadable(source: TerminalAttachmentSource): number {
    const flushed = this.flushed?.source === source ? this.flushed : null;
    return Math.min(
      source.window.startOffset,
      flushed?.from ?? Number.POSITIVE_INFINITY,
    );
  }

  private read(
    source: TerminalAttachmentSource,
    from: number,
    to: number,
  ): Buffer | null {
    const windowed = source.window.slice(from, to);
    if (windowed !== null) return windowed;
    const flushed = this.flushed?.source === source ? this.flushed : null;
    if (!flushed || from < flushed.from) return null;
    return flushed.bytes.subarray(from - flushed.from, to - flushed.from);
  }

  private deliver(
    state: AttachmentState,
    toOffset: number,
    data: Uint8Array,
    exit: TerminalExitEvent | null,
  ): void {
    const item: TerminalAttachmentItem = {
      attachmentId: state.id,
      terminalId: state.source.terminalId,
      fromOffset: state.cursor,
      toOffset,
      data,
      truncatedBefore: state.truncatedBefore,
      exit,
    };
    state.cursor = toOffset;
    state.truncatedBefore = false;
    state.pending.push(toOffset);
    try {
      state.sink.item(item);
    } catch {
      // A failing sink loses only its own attachment.
      this.forget(state);
    }
  }

  private end(
    state: AttachmentState,
    outcome: TerminalAttachmentOutcome,
  ): void {
    if (state.ended) return;
    this.forget(state);
    try {
      state.sink.end({
        attachmentId: state.id,
        terminalId: state.source.terminalId,
        outcome,
        offset: state.cursor,
      });
    } catch {
      // The attachment is already gone.
    }
  }

  private forget(state: AttachmentState): void {
    state.ended = true;
    this.byId.delete(state.id);
    const siblings = this.bySource.get(state.source);
    siblings?.delete(state);
    if (siblings?.size === 0) this.bySource.delete(state.source);
  }
}
