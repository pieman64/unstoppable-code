import type { TerminalExitEvent } from '@canopy/protocol/terminal';
import {
  TERMINAL_ATTACHMENT_ITEM_MAX_BYTES,
  TERMINAL_ATTACHMENT_MAX_PENDING_ITEMS,
  TerminalAttachmentCapacityError,
  TerminalAttachments,
  type TerminalAttachmentSource,
} from '../attachments';
import type {
  TerminalAttachmentEnd,
  TerminalAttachmentItem,
  TerminalAttachmentSink,
} from '../ports';
import { TerminalReplayWindow } from '../replay';

const EXIT: TerminalExitEvent = {
  projectId: 'project-1',
  worktreeId: 'wt-1',
  terminalId: 'terminal-1',
  kind: 'shell',
  exitCode: 0,
  signal: null,
};

function source(capacity = 256 * 1024): TerminalAttachmentSource {
  return {
    terminalId: 'terminal-1',
    window: new TerminalReplayWindow(capacity),
    emitted: 0,
    exit: null,
  };
}

function emit(
  attachments: TerminalAttachments,
  target: TerminalAttachmentSource,
  text: string,
): void {
  const flushed = Buffer.from(text, 'utf8');
  target.window.append(flushed);
  target.emitted = target.window.endOffset;
  attachments.publish(target, flushed);
}

function recorder(): TerminalAttachmentSink & {
  items: TerminalAttachmentItem[];
  ends: TerminalAttachmentEnd[];
} {
  const items: TerminalAttachmentItem[] = [];
  const ends: TerminalAttachmentEnd[] = [];
  return {
    items,
    ends,
    item: (item): void => {
      items.push(item);
    },
    end: (end): void => {
      ends.push(end);
    },
  };
}

function text(items: readonly TerminalAttachmentItem[]): string {
  return items.map((item) => Buffer.from(item.data).toString('utf8')).join('');
}

describe('TerminalAttachments', () => {
  it('holds output past 128 unacknowledged items until credit returns', () => {
    const attachments = new TerminalAttachments();
    const target = source(16 * 1024 * 1024);
    const sink = recorder();
    const id = attachments.open(target, { fromOffset: 0, sink });

    const total =
      (TERMINAL_ATTACHMENT_MAX_PENDING_ITEMS + 2) *
      TERMINAL_ATTACHMENT_ITEM_MAX_BYTES;
    emit(attachments, target, 'x'.repeat(total));

    expect(sink.items).toHaveLength(TERMINAL_ATTACHMENT_MAX_PENDING_ITEMS);
    expect(
      sink.items.every(
        (item) => item.data.length === TERMINAL_ATTACHMENT_ITEM_MAX_BYTES,
      ),
    ).toBe(true);

    attachments.acknowledge(id, sink.items[1].toOffset);

    expect(sink.items).toHaveLength(TERMINAL_ATTACHMENT_MAX_PENDING_ITEMS + 2);
    expect(sink.items.at(-1)?.toOffset).toBe(total);
    expect(sink.items.some((item) => item.truncatedBefore)).toBe(false);
  });

  it('delivers a flush larger than the replay window to an attachment that keeps up', () => {
    const attachments = new TerminalAttachments();
    const target = source(TERMINAL_ATTACHMENT_ITEM_MAX_BYTES);
    let id = '';
    const items: TerminalAttachmentItem[] = [];
    id = attachments.open(target, {
      fromOffset: 0,
      sink: {
        item: (item): void => {
          items.push(item);
          attachments.acknowledge(id, item.toOffset);
        },
        end: (): void => {},
      },
    });
    const chunk = 'y'.repeat(TERMINAL_ATTACHMENT_ITEM_MAX_BYTES * 3 + 7);

    emit(attachments, target, chunk);

    expect(text(items)).toBe(chunk);
    expect(items.some((item) => item.truncatedBefore)).toBe(false);
  });

  it('skips output that left the replay window and flags the gap', () => {
    const attachments = new TerminalAttachments();
    const target = source(TERMINAL_ATTACHMENT_ITEM_MAX_BYTES * 2);
    const sink = recorder();
    const id = attachments.open(target, { fromOffset: 0, sink });

    for (
      let index = 0;
      index < TERMINAL_ATTACHMENT_MAX_PENDING_ITEMS;
      index += 1
    ) {
      emit(attachments, target, 'a');
    }
    emit(
      attachments,
      target,
      'b'.repeat(TERMINAL_ATTACHMENT_ITEM_MAX_BYTES * 3),
    );
    expect(sink.items).toHaveLength(TERMINAL_ATTACHMENT_MAX_PENDING_ITEMS);

    attachments.acknowledge(id, target.emitted);

    const resumed = sink.items.slice(TERMINAL_ATTACHMENT_MAX_PENDING_ITEMS);
    expect(resumed[0]).toMatchObject({
      fromOffset: target.window.startOffset,
      truncatedBefore: true,
    });
    expect(resumed.slice(1).every((item) => !item.truncatedBefore)).toBe(true);
    expect(resumed.at(-1)?.toOffset).toBe(target.emitted);
  });

  it('replays from a cursor, flags one outside the window and caps the replay', () => {
    const attachments = new TerminalAttachments();
    const target = source(8);
    emit(attachments, target, '0123456789');

    const fromCursor = recorder();
    attachments.open(target, { fromOffset: 6, sink: fromCursor });
    expect(text(fromCursor.items)).toBe('6789');
    expect(fromCursor.items[0].truncatedBefore).toBe(false);

    const stale = recorder();
    attachments.open(target, { fromOffset: 0, sink: stale });
    expect(stale.items[0]).toMatchObject({
      fromOffset: 2,
      truncatedBefore: true,
    });

    const capped = recorder();
    attachments.open(target, {
      fromOffset: 0,
      maxReplayBytes: 3,
      sink: capped,
    });
    expect(text(capped.items)).toBe('789');
  });

  it('drains to the exit after the terminal is gone, then completes', () => {
    const attachments = new TerminalAttachments();
    const target = source(16 * 1024 * 1024);
    const sink = recorder();
    const id = attachments.open(target, { fromOffset: 0, sink });
    emit(
      attachments,
      target,
      'x'.repeat(
        (TERMINAL_ATTACHMENT_MAX_PENDING_ITEMS + 1) *
          TERMINAL_ATTACHMENT_ITEM_MAX_BYTES,
      ),
    );
    target.exit = EXIT;
    attachments.publish(target);
    expect(sink.ends).toEqual([]);

    attachments.acknowledge(id, target.emitted);

    expect(sink.items.at(-2)?.exit).toBeNull();
    expect(sink.items.at(-1)).toMatchObject({
      fromOffset: target.emitted,
      toOffset: target.emitted,
      exit: EXIT,
    });
    expect(sink.ends).toEqual([
      expect.objectContaining({ outcome: 'completed', offset: target.emitted }),
    ]);
    expect(attachments.count(target)).toBe(0);
  });

  it('releases only the released attachment', () => {
    const attachments = new TerminalAttachments();
    const target = source();
    const first = recorder();
    const second = recorder();
    const firstId = attachments.open(target, { fromOffset: 0, sink: first });
    attachments.open(target, { fromOffset: 0, sink: second });

    attachments.release(firstId);
    attachments.release(firstId);
    emit(attachments, target, 'after');

    expect(first.ends).toEqual([
      expect.objectContaining({ attachmentId: firstId, outcome: 'cancelled' }),
    ]);
    expect(first.items).toEqual([]);
    expect(text(second.items)).toBe('after');
    expect(attachments.count(target)).toBe(1);
  });

  it('refuses attachments past the per-terminal and total caps', () => {
    const attachments = new TerminalAttachments({
      maxAttachments: 3,
      maxAttachmentsPerTerminal: 2,
    });
    const target = source();
    attachments.open(target, { fromOffset: 0, sink: recorder() });
    attachments.open(target, { fromOffset: 0, sink: recorder() });
    expect(() =>
      attachments.open(target, { fromOffset: 0, sink: recorder() }),
    ).toThrow(TerminalAttachmentCapacityError);

    attachments.open(source(), { fromOffset: 0, sink: recorder() });
    expect(() =>
      attachments.open(source(), { fromOffset: 0, sink: recorder() }),
    ).toThrow(TerminalAttachmentCapacityError);
  });

  it('rejects offsets past the output and oversized replays', () => {
    const attachments = new TerminalAttachments();
    const target = source();
    emit(attachments, target, 'abc');

    expect(() =>
      attachments.open(target, { fromOffset: 4, sink: recorder() }),
    ).toThrow(RangeError);
    expect(() =>
      attachments.open(target, { fromOffset: -1, sink: recorder() }),
    ).toThrow(RangeError);
    expect(() =>
      attachments.open(target, {
        fromOffset: 0,
        maxReplayBytes: 1024 * 1024 + 1,
        sink: recorder(),
      }),
    ).toThrow(RangeError);
  });

  it('drops an attachment whose sink throws without touching the others', () => {
    const attachments = new TerminalAttachments();
    const target = source();
    const healthy = recorder();
    attachments.open(target, {
      fromOffset: 0,
      sink: {
        item: (): void => {
          throw new Error('renderer gone');
        },
        end: (): void => {},
      },
    });
    attachments.open(target, { fromOffset: 0, sink: healthy });

    emit(attachments, target, 'one');
    emit(attachments, target, 'two');

    expect(text(healthy.items)).toBe('onetwo');
    expect(attachments.count(target)).toBe(1);
  });

  it('accepts an acknowledgement from inside the sink', () => {
    const attachments = new TerminalAttachments();
    const target = source(16 * 1024 * 1024);
    let id = '';
    const items: TerminalAttachmentItem[] = [];
    id = attachments.open(target, {
      fromOffset: 0,
      sink: {
        item: (item): void => {
          items.push(item);
          attachments.acknowledge(id, item.toOffset);
        },
        end: (): void => {},
      },
    });
    const total =
      TERMINAL_ATTACHMENT_MAX_PENDING_ITEMS *
      2 *
      TERMINAL_ATTACHMENT_ITEM_MAX_BYTES;
    emit(attachments, target, 'x'.repeat(total));

    expect(items.at(-1)?.toOffset).toBe(total);
  });
});
