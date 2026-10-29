import { createReadPool, parseJsonLinesHead } from '../file-head';

describe('parseJsonLinesHead', () => {
  it('drops a torn trailing record only when the head was cut mid-line', () => {
    const complete = '{"a":1}\n{"b":2}\n';
    expect(parseJsonLinesHead(complete, Buffer.byteLength(complete))).toEqual([
      { a: 1 },
      { b: 2 },
    ]);

    const torn = '{"a":1}\n{"b":2';
    expect(parseJsonLinesHead(torn, Buffer.byteLength(torn))).toEqual([
      { a: 1 },
    ]);

    // Room to spare means nothing was cut, even without a final newline.
    const whole = '{"a":1}\n{"b":2}';
    expect(parseJsonLinesHead(whole, Buffer.byteLength(whole) + 10)).toEqual([
      { a: 1 },
      { b: 2 },
    ]);
  });

  it('ignores blank and malformed lines', () => {
    expect(parseJsonLinesHead('\n{"a":1}\nnot json\n', 1024)).toEqual([
      { a: 1 },
    ]);
  });
});

describe('createReadPool', () => {
  it('holds the total in flight to the limit across many concurrent callers', async () => {
    const pool = createReadPool(3);
    let running = 0;
    let peak = 0;
    const results = await Promise.all(
      Array.from({ length: 20 }, (_value, index) =>
        pool.run(async () => {
          running += 1;
          peak = Math.max(peak, running);
          await new Promise((resolve) => setImmediate(resolve));
          running -= 1;
          return index;
        }),
      ),
    );
    expect(results).toEqual(Array.from({ length: 20 }, (_value, i) => i));
    expect(peak).toBe(3);
  });

  it('frees the slot when a task throws or rejects', async () => {
    const pool = createReadPool(1);
    await expect(
      pool.run(() => {
        throw new Error('sync');
      }),
    ).rejects.toThrow('sync');
    await expect(
      pool.run(() => Promise.reject(new Error('async'))),
    ).rejects.toThrow('async');
    // A leaked slot would leave this waiting forever.
    expect(await pool.run(() => Promise.resolve('ok'))).toBe('ok');
  });

  it('treats a limit that is not a positive number as one at a time', async () => {
    const pool = createReadPool(Number.NaN);
    let running = 0;
    let peak = 0;
    await Promise.all(
      [1, 2, 3].map((item) =>
        pool.run(async () => {
          running += 1;
          peak = Math.max(peak, running);
          await new Promise((resolve) => setImmediate(resolve));
          running -= 1;
          return item;
        }),
      ),
    );
    expect(peak).toBe(1);
  });
});
