import {
  inputMatches,
  type ExpectedInput,
  type InputRecorder,
} from '../frames/input-recorder';
import type { DocumentMapping } from './actionability';
import type { InputAttribution } from './input-dispatch';

/** Pause between recorder reads while delivery is still unconfirmed. */
const POLL_INTERVAL_MS = 50;

/** Whether a CDP input command is a press that a page reports. */
export function isPressEvent(
  method: string,
  params: Record<string, unknown>,
): boolean {
  return (
    (method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed') ||
    (method === 'Input.dispatchKeyEvent' &&
      (params.type === 'keyDown' || params.type === 'rawKeyDown'))
  );
}

/** `MouseEvent.button` for a CDP button. */
export function mouseButtonNumber(button: InputAttribution['button']): number {
  return button === 'right' ? 2 : button === 'middle' ? 1 : 0;
}

/** A session point in the target document's coordinates. */
export function documentPoint(
  mapping: DocumentMapping | undefined,
  point: { x: number; y: number },
): { x: number; y: number } {
  if (!mapping) return point;
  return {
    x: (point.x - mapping.originX) / mapping.scaleX,
    y: (point.y - mapping.originY) / mapping.scaleY,
  };
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    const abort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}

/**
 * Delivery confirmation for an action whose target is in a child frame.
 * The main frame's preload reports trusted input only for its own
 * document, so a recorder in the target's document (its host world) is
 * read instead: after each press reaches the page, and by polling until
 * the delivery deadline. A press matches by type, button and point (in the
 * target document's coordinates) or by key.
 */
export class FrameDelivery {
  private readonly expected: ExpectedInput[] = [];

  private matched = false;

  public constructor(
    private readonly options: {
      recorder: InputRecorder | undefined;
      /** Tracks a read in the action lane (reads follow dispatch). */
      track: <T>(command: Promise<T>) => Promise<T>;
      /** Whether a match still counts: not finished, before the deadline. */
      open: () => boolean;
      onMatch: () => void;
      /** The target document's mapping actionability last read. */
      mapping: () => DocumentMapping | undefined;
    },
  ) {}

  /** Records what a dispatched press must produce in the target document. */
  public expect(event: InputAttribution): void {
    if (event.type === 'mousePressed') {
      if (event.x === undefined || event.y === undefined) return;
      this.expected.push({
        at: event.timestamp,
        type: 'pointerdown',
        button: mouseButtonNumber(event.button),
        point: documentPoint(this.options.mapping(), {
          x: event.x,
          y: event.y,
        }),
      });
    } else if (
      (event.type === 'keyDown' || event.type === 'rawKeyDown') &&
      event.key !== undefined
    )
      this.expected.push({
        at: event.timestamp,
        type: 'keydown',
        key: event.key,
      });
  }

  /** Reads the recorder once; a match calls `onMatch` once. */
  public async confirm(): Promise<void> {
    const recorder = this.options.recorder;
    if (!recorder || this.matched || this.expected.length === 0) return;
    if (!this.options.open()) return;
    const recorded = await this.options
      .track(recorder.read())
      .catch(() => undefined);
    if (
      this.matched ||
      !this.options.open() ||
      !recorded?.some((entry) =>
        this.expected.some((expected) => inputMatches(entry, expected)),
      )
    )
      return;
    this.matched = true;
    this.options.onMatch();
  }

  /** Reads until a match, until no longer open, or until `signal` aborts. */
  public async poll(signal: AbortSignal): Promise<void> {
    while (!this.matched && this.options.open() && !signal.aborted) {
      await this.confirm();
      if (this.matched || signal.aborted) return;
      await pause(POLL_INTERVAL_MS, signal);
    }
  }
}
