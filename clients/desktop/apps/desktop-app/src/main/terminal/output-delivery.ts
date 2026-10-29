/**
 * Per-frame delivery of PTY output to the renderer.
 *
 * `PtyManager` emits output per microtask (or per 8 KB), and its main-process
 * listeners keep that cadence. Only the renderer send goes through here: a
 * terminal's output is sent at once when nothing was sent for it in the last
 * frame, so a lone keystroke's echo never waits, and otherwise held until
 * that frame ends or 64 KiB is held, then sent as one event. A merged event
 * is the held events' bytes in order with the last event's `seq` (the
 * terminal's byte count), which is what one larger PTY flush would have
 * produced; the renderer's attach deduplication works on `seq` alone.
 *
 * Any other terminal event, and (through the renderer delivery barrier) any
 * other message or invoke reply, first sends everything held, so the renderer
 * sees every message in the order it did before; only adjacent output of one
 * terminal is merged. Nothing here touches input, execution or the PTY.
 */
import type { TerminalOutputEvent } from '@canopy/desktop-shared/types';

/** About one display frame. */
export const TERMINAL_OUTPUT_FRAME_MS = 16;
/** Held output that is sent without waiting for the frame to end. */
export const TERMINAL_OUTPUT_FRAME_BYTES = 64 * 1024;

interface TerminalOutputDeliveryOptions {
  /** Send one output event to the renderer. */
  deliver(event: TerminalOutputEvent): void;
  now(): number;
  setTimer(callback: () => void, delayMs: number): () => void;
  frameMs?: number;
  frameBytes?: number;
}

interface HeldOutput {
  events: TerminalOutputEvent[];
  bytes: number;
  due: number;
}

function merge(events: readonly TerminalOutputEvent[]): TerminalOutputEvent {
  const last = events[events.length - 1];
  if (!last) throw new Error('No terminal output to merge');
  if (events.length === 1) return last;
  const data = new Uint8Array(
    events.reduce((total, event) => total + event.data.length, 0),
  );
  let offset = 0;
  for (const event of events) {
    data.set(event.data, offset);
    offset += event.data.length;
  }
  return { ...last, data };
}

export class TerminalOutputDelivery {
  private readonly held = new Map<string, HeldOutput>();
  private readonly lastSentAt = new Map<string, number>();
  private readonly frameMs: number;
  private readonly frameBytes: number;
  private cancelTimer: (() => void) | null = null;
  private timerDue = Number.POSITIVE_INFINITY;
  /** A send in progress: its own barriers must not send other output first. */
  private delivering = false;

  constructor(private readonly options: TerminalOutputDeliveryOptions) {
    this.frameMs = options.frameMs ?? TERMINAL_OUTPUT_FRAME_MS;
    this.frameBytes = options.frameBytes ?? TERMINAL_OUTPUT_FRAME_BYTES;
  }

  /** One output event from the PTY manager. */
  push(event: TerminalOutputEvent): void {
    const terminalId = event.terminalId;
    const held = this.held.get(terminalId);
    if (held) {
      held.events.push(event);
      held.bytes += event.data.length;
      if (held.bytes >= this.frameBytes) this.flushTerminal(terminalId);
      return;
    }
    const now = this.options.now();
    const lastSentAt = this.lastSentAt.get(terminalId);
    if (lastSentAt === undefined || now - lastSentAt >= this.frameMs) {
      this.deliverNow(event, now);
      return;
    }
    this.held.set(terminalId, {
      events: [event],
      bytes: event.data.length,
      due: lastSentAt + this.frameMs,
    });
    if (event.data.length >= this.frameBytes) {
      this.flushTerminal(terminalId);
      return;
    }
    this.rearm();
  }

  /** Send everything held now, terminals in the order they started holding. */
  flushAll(): void {
    if (this.held.size === 0 || this.delivering) return;
    const terminalIds = Array.from(this.held.keys());
    for (const terminalId of terminalIds) this.flushTerminal(terminalId);
  }

  /** The terminal is gone: forget when it last sent. */
  forget(terminalId: string): void {
    this.flushTerminal(terminalId);
    this.lastSentAt.delete(terminalId);
  }

  dispose(): void {
    this.flushAll();
    this.cancelTimer?.();
    this.cancelTimer = null;
    this.timerDue = Number.POSITIVE_INFINITY;
  }

  private flushTerminal(terminalId: string): void {
    const held = this.held.get(terminalId);
    if (!held) return;
    this.held.delete(terminalId);
    this.deliverNow(merge(held.events), this.options.now());
    this.rearm();
  }

  private deliverNow(event: TerminalOutputEvent, now: number): void {
    this.lastSentAt.set(event.terminalId, now);
    this.delivering = true;
    try {
      this.options.deliver(event);
    } finally {
      this.delivering = false;
    }
  }

  private rearm(): void {
    let due = Number.POSITIVE_INFINITY;
    this.held.forEach((held) => {
      due = Math.min(due, held.due);
    });
    if (due === this.timerDue) return;
    this.cancelTimer?.();
    this.cancelTimer = null;
    this.timerDue = due;
    if (due === Number.POSITIVE_INFINITY) return;
    this.cancelTimer = this.options.setTimer(
      () => {
        this.cancelTimer = null;
        this.timerDue = Number.POSITIVE_INFINITY;
        this.flushDue();
      },
      Math.max(0, due - this.options.now()),
    );
  }

  private flushDue(): void {
    const now = this.options.now();
    for (const [terminalId, held] of Array.from(this.held.entries())) {
      if (held.due <= now) this.flushTerminal(terminalId);
    }
    this.rearm();
  }
}
