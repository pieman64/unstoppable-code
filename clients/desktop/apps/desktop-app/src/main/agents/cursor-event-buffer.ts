const TEXT_FLUSH_MS = 25;
const MAX_TEXT_CHARS = 16 * 1024;

interface PendingEvent {
  event: Record<string, unknown>;
  settled: Array<{ resolve: () => void; reject: (error: unknown) => void }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function textPatch(
  event: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (
    event.type !== 'canopy_assistant_patch' ||
    (event.provider !== 'cursor' &&
      event.provider !== 'copilot' &&
      event.provider !== 'opencode') ||
    (event.role !== undefined && event.role !== 'assistant') ||
    typeof event.messageId !== 'string' ||
    typeof event.timestamp !== 'number' ||
    typeof event.revision !== 'number' ||
    !Array.isArray(event.patches) ||
    event.patches.length !== 1
  )
    return undefined;
  const patch: unknown = event.patches[0];
  if (!isRecord(patch) || !Number.isSafeInteger(patch.index)) return undefined;
  if (typeof patch.appendText === 'string' && patch.block === undefined)
    return patch;
  if (
    patch.appendText === undefined &&
    isRecord(patch.block) &&
    (patch.block.type === 'text' || patch.block.type === 'thinking') &&
    typeof patch.block.text === 'string'
  )
    return patch;
  return undefined;
}

function mergeText(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const previous = textPatch(left);
  const next = textPatch(right);
  if (
    !previous ||
    !next ||
    typeof next.appendText !== 'string' ||
    previous.index !== next.index ||
    left.provider !== right.provider ||
    left.messageId !== right.messageId ||
    left.timestamp !== right.timestamp ||
    left.role !== right.role ||
    left.canopy_turn_user_message_id !== right.canopy_turn_user_message_id ||
    typeof left.revision !== 'number' ||
    typeof right.revision !== 'number' ||
    right.revision <= left.revision
  )
    return undefined;
  const block = isRecord(previous.block) ? previous.block : undefined;
  const text = block?.text ?? previous.appendText;
  if (
    typeof text !== 'string' ||
    text.length + next.appendText.length > MAX_TEXT_CHARS
  )
    return undefined;
  return {
    ...left,
    revision: right.revision,
    patches: [
      block
        ? { ...previous, block: { ...block, text: text + next.appendText } }
        : { ...previous, appendText: text + next.appendText },
    ],
  };
}

/**
 * Coalesce only adjacent text appends while the preceding commit is in flight.
 * Every producer promise stays pending through delivery: ACP's existing byte
 * credits therefore bound the queued wire input, including a slow disk. Tool,
 * notice, message and turn boundaries remain ordered individual events.
 */
export class CursorEventBuffer {
  private readonly pending: PendingEvent[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private pumping?: Promise<void>;
  private failure?: { error: Error };

  constructor(
    private readonly deliver: (event: Record<string, unknown>) => Promise<void>,
  ) {}

  push(event: Record<string, unknown>): Promise<void> {
    if (this.failure) return Promise.reject(this.failure.error);
    const completion = new Promise<void>((resolve, reject) => {
      const previous = this.pending[this.pending.length - 1];
      const merged = previous && mergeText(previous.event, event);
      if (previous && merged) {
        previous.event = merged;
        previous.settled.push({ resolve, reject });
      } else this.pending.push({ event, settled: [{ resolve, reject }] });
    });
    if (!textPatch(event)) {
      void this.flush().catch(() => undefined);
    } else if (!this.pumping && !this.timer) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.flush().catch(() => undefined);
      }, TEXT_FLUSH_MS);
    }
    return completion;
  }

  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.failure) throw this.failure.error;
    if (this.pumping) {
      await this.pumping;
      if (this.pending.length) await this.flush();
      return;
    }
    const pumping = Promise.resolve().then(async (): Promise<void> => {
      for (;;) {
        const current = this.pending.shift();
        if (!current) return;
        try {
          await this.deliver(current.event);
          for (const waiter of current.settled) waiter.resolve();
        } catch (error) {
          const failure =
            error instanceof Error ? error : new Error(String(error));
          this.failure = { error: failure };
          for (const entry of [current, ...this.pending.splice(0)])
            for (const waiter of entry.settled) waiter.reject(failure);
          throw failure;
        }
      }
    });
    this.pumping = pumping;
    try {
      await pumping;
    } finally {
      this.pumping = undefined;
      // A producer resumed by the last commit can enqueue after the pump's
      // empty check but before this continuation clears the in-flight marker.
      if (this.pending.length && !this.failure) await this.flush();
    }
  }
}
