import { PassThrough, Readable } from 'node:stream';
import { createJsonLineStream } from '../json-lines';

describe('JSONL framing', () => {
  it('preserves every UTF-8 byte boundary, CRLF, and a final unterminated record', async () => {
    const value = { text: 'Mermaid\u2028diagram\u2029🦜' };
    const bytes = Buffer.from(
      `${JSON.stringify(value)}\r\n\n${JSON.stringify(value)}`,
    );
    const lines = createJsonLineStream(
      Readable.from(Array.from(bytes, (byte) => Buffer.from([byte]))),
    );
    const records: unknown[] = [];
    for await (const line of lines) {
      if (typeof line === 'string' && line.trim())
        records.push(JSON.parse(line));
    }
    expect(records).toEqual([value, value]);
  });

  it('propagates a source read failure and removes its listener', async () => {
    const input = new PassThrough();
    const lines = createJsonLineStream(input);
    const consume = async (): Promise<void> => {
      for await (const line of lines) {
        void line;
      }
    };
    const result = consume();
    input.destroy(new Error('rollout read failed'));
    await expect(result).rejects.toThrow('rollout read failed');
    expect(input.listenerCount('error')).toBe(0);
  });

  it('detaches a discarded parser without destroying a shared input', async () => {
    const input = new PassThrough();
    const lines = createJsonLineStream(input);
    const closed = new Promise<void>((resolve) => lines.once('close', resolve));
    lines.destroy();
    await closed;
    expect(input.listenerCount('error')).toBe(0);
    expect(input.destroyed).toBe(false);
    input.destroy();
  });

  it('stops framing one large input chunk when the consumer pauses', async () => {
    const input = new PassThrough();
    const lines = createJsonLineStream(input);
    let received = 0;
    const completed = new Promise<void>((resolve, reject) => {
      lines.once('end', resolve);
      lines.once('error', reject);
    });
    lines.on('data', () => {
      received += 1;
      if (received === 1) lines.pause();
    });
    const burst = Array.from(
      { length: 128 },
      (_, index) => `${JSON.stringify({ index, body: 'x'.repeat(2048) })}\n`,
    ).join('');
    try {
      input.end(burst);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(received).toBe(1);
      // The readable object-mode high-water mark is sixteen frames. An
      // already received source chunk is the explicit overshoot floor, but
      // it must not be copied into a second unbounded frame queue.
      expect(lines.readableLength).toBeLessThanOrEqual(16);
    } finally {
      lines.resume();
      await completed;
      input.destroy();
    }
    expect(received).toBe(128);
  });

  it('settles a pending producer write when a paused parser is destroyed', async () => {
    const burst = Array.from(
      { length: 128 },
      (_, index) => `${JSON.stringify({ index, body: 'x'.repeat(2048) })}\n`,
    ).join('');
    for (const destroyError of [undefined, new Error('parser canceled')]) {
      const input = new PassThrough();
      const lines = createJsonLineStream(input);
      lines.on('error', () => undefined);
      lines.once('data', () => lines.pause());
      let writeSettlements = 0;
      let writeError: Error | undefined;
      const write = new Promise<void>((resolve) => {
        lines.write(burst, (error) => {
          writeSettlements += 1;
          writeError = error ?? undefined;
          resolve();
        });
      });
      try {
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(writeSettlements).toBe(0);
        const closed = new Promise<void>((resolve) =>
          lines.once('close', resolve),
        );
        lines.destroy(destroyError);
        await closed;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            write,
            new Promise<void>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error('pending write was stranded')),
                1000,
              );
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
        expect(writeSettlements).toBe(1);
        expect(writeError?.message).toBe(
          destroyError?.message ?? 'JSONL parser destroyed',
        );
        expect(input.destroyed).toBe(false);
        expect(input.listenerCount('error')).toBe(0);
      } finally {
        lines.destroy();
        input.destroy();
      }
    }
  });
});
