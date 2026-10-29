/** @jest-environment node */
import io from 'node:fs/promises';
import { tmpdir, EOL } from 'node:os';
import { join } from 'node:path';
import { AsyncMainLogSink } from '../lib/async-main-log-sink';

let directory: string;
beforeEach(async () => {
  directory = await io.mkdtemp(join(tmpdir(), 'canopy-async-main-log-'));
});
afterEach(async () => {
  jest.restoreAllMocks();
  await io.rm(directory, { recursive: true, force: true });
});
function makeSink(maxSize = 1000, maxPendingBytes = 1000): AsyncMainLogSink {
  return new AsyncMainLogSink({
    path: join(directory, 'main.log'),
    maxSize,
    maxPendingBytes,
    fallback: jest.fn(),
  });
}

test('failed gap notice is counted and does not poison later admitted writes', async () => {
  const append = io.appendFile;
  let first = true;
  jest
    .spyOn(io, 'appendFile')
    .mockImplementation(async (...args): Promise<void> => {
      if (first) {
        first = false;
        throw new Error('owned gap write failure');
      }
      await append(...args);
    });
  const fallback = jest.fn();
  const sink = new AsyncMainLogSink({
    path: join(directory, 'main.log'),
    maxSize: 1000,
    maxPendingBytes: 10,
    fallback,
  });
  sink.append('oversized payload');
  expect(await sink.flush()).toEqual({
    throughSequence: 0,
    writtenRecords: 0,
    failedRecords: 0,
    droppedRecords: 1,
    failedGapNotices: 1,
  });
  expect(fallback).toHaveBeenCalledWith(
    'Main log gap notice failed',
    expect.any(Error),
  );
  sink.append('recovery');
  expect(await sink.drain()).toMatchObject({
    writtenRecords: 1,
    failedGapNotices: 1,
  });
  expect(await io.readFile(join(directory, 'main.log'), 'utf8')).toBe(
    `recovery${EOL}`,
  );
});

test('serial byte-aware rotation retains exact admitted order', async () => {
  const sink = makeSink(5);
  sink.append('ééé'); // Six UTF-8 bytes + EOL: rotation before the NEXT line.
  sink.append('tail');
  expect(await sink.drain()).toEqual({
    throughSequence: 2,
    writtenRecords: 2,
    failedRecords: 0,
    droppedRecords: 0,
    failedGapNotices: 0,
  });
  expect(await io.readFile(join(directory, 'main.old.log'), 'utf8')).toBe(
    `ééé${EOL}`,
  );
  expect(await io.readFile(join(directory, 'main.log'), 'utf8')).toBe(
    `tail${EOL}`,
  );
});

test('flush is a pre-call fence; terminal drain is idempotent and closes admission', async () => {
  const sink = makeSink();
  sink.append('first');
  const fence = sink.flush();
  sink.append('later');
  expect(await fence).toMatchObject({ throughSequence: 1, writtenRecords: 1 });
  const terminal = sink.drain();
  expect(sink.drain()).toBe(terminal);
  expect(await terminal).toMatchObject({
    throughSequence: 2,
    writtenRecords: 2,
  });
  sink.append('too late');
  expect(await io.readFile(join(directory, 'main.log'), 'utf8')).toBe(
    `first${EOL}later${EOL}`,
  );
});

test('rename failure uses asynchronous compatible crop and continues writing', async () => {
  const sink = makeSink(20);
  await io.writeFile(
    join(directory, 'main.log'),
    '012345678901234567890123456789',
  );
  // Directory at archive destination reliably rejects file rename on macOS/Windows.
  await io.mkdir(join(directory, 'main.old.log'));
  sink.append('after');
  expect(await sink.drain()).toMatchObject({
    writtenRecords: 1,
    failedRecords: 0,
  });
  expect(await io.readFile(join(directory, 'main.log'), 'utf8')).toBe(
    `[log cropped]${EOL}56789${EOL}after${EOL}`,
  );
});

test('bounded stalled admission reports exact loss, never recurses and recovers after I/O failure', async () => {
  const append = io.appendFile;
  let release = (): void => undefined;
  let entered = (): void => undefined;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let first = true;
  let active = 0;
  let maximum = 0;
  jest
    .spyOn(io, 'appendFile')
    .mockImplementation(async (...args): Promise<void> => {
      active += 1;
      maximum = Math.max(maximum, active);
      try {
        if (first) {
          first = false;
          entered();
          await blocked;
          throw new Error('owned ENOSPC fixture');
        }
        await append(...args);
      } finally {
        active -= 1;
      }
    });
  const fallback = jest.fn();
  const sink = new AsyncMainLogSink({
    path: join(directory, 'main.log'),
    maxSize: 1000,
    maxPendingBytes: 12,
    fallback,
  });
  sink.append('held');
  await started;
  sink.append('oversize payload');
  sink.append('oversize payload');
  sink.append('next');
  const fence = sink.flush();
  release();
  expect(await fence).toEqual({
    throughSequence: 2,
    writtenRecords: 1,
    failedRecords: 1,
    droppedRecords: 2,
    failedGapNotices: 0,
  });
  expect(maximum).toBe(1);
  expect(fallback).toHaveBeenCalledTimes(2);
  expect(fallback).toHaveBeenCalledWith(
    'Main log append failed',
    expect.any(Error),
  );
  expect(await io.readFile(join(directory, 'main.log'), 'utf8')).toBe(
    `[main log gap: 2 records not admitted]${EOL}next${EOL}`,
  );
  sink.append('recovered');
  expect(await sink.drain()).toMatchObject({
    writtenRecords: 2,
    failedRecords: 1,
  });
});

test('rotation and crop failure preserve admitted order and throttle retries until recovery', async () => {
  const logPath = join(directory, 'main.log');
  const seed = '012345678901234567890123456789';
  await io.writeFile(logPath, seed);
  let now = 1000;
  jest.spyOn(performance, 'now').mockImplementation((): number => now);
  const rename = jest
    .spyOn(io, 'rename')
    .mockRejectedValue(new Error('owned archive sharing violation'));
  const crop = jest
    .spyOn(io, 'writeFile')
    .mockRejectedValue(new Error('owned crop write failure'));
  const fallback = jest.fn();
  const sink = new AsyncMainLogSink({
    path: logPath,
    maxSize: 20,
    maxPendingBytes: 1000,
    fallback,
  });
  sink.append('first');
  sink.append('second');
  expect(await sink.flush()).toEqual({
    throughSequence: 2,
    writtenRecords: 2,
    failedRecords: 0,
    droppedRecords: 0,
    failedGapNotices: 0,
  });
  expect(await io.readFile(logPath, 'utf8')).toBe(
    seed + `first${EOL}second${EOL}`,
  );
  expect(rename).toHaveBeenCalledTimes(1);
  expect(crop).toHaveBeenCalledTimes(1);
  expect(fallback).toHaveBeenCalledTimes(2);

  now = 5999;
  sink.append('before retry');
  await sink.flush();
  expect(rename).toHaveBeenCalledTimes(1);
  expect(fallback).toHaveBeenCalledTimes(2);
  now = 6000;
  sink.append('retry');
  expect(await sink.flush()).toMatchObject({
    writtenRecords: 4,
    failedRecords: 0,
  });
  expect(rename).toHaveBeenCalledTimes(2);
  expect(crop).toHaveBeenCalledTimes(2);
  expect(fallback).toHaveBeenCalledTimes(4);
  const admitted =
    seed + `first${EOL}second${EOL}before retry${EOL}retry${EOL}`;
  expect(await io.readFile(logPath, 'utf8')).toBe(admitted);

  rename.mockRestore();
  crop.mockRestore();
  now = 11000;
  sink.append('recovered');
  expect(await sink.drain()).toEqual({
    throughSequence: 5,
    writtenRecords: 5,
    failedRecords: 0,
    droppedRecords: 0,
    failedGapNotices: 0,
  });
  expect(await io.readFile(join(directory, 'main.old.log'), 'utf8')).toBe(
    admitted,
  );
  expect(await io.readFile(logPath, 'utf8')).toBe(`recovered${EOL}`);
});

test('partially failed crop re-stats without classifying a successful append as failed', async () => {
  const logPath = join(directory, 'main.log');
  await io.writeFile(logPath, '012345678901234567890123456789');
  let now = 1000;
  jest.spyOn(performance, 'now').mockImplementation((): number => now);
  const rename = jest
    .spyOn(io, 'rename')
    .mockRejectedValue(new Error('owned archive failure'));
  const write = io.writeFile;
  jest
    .spyOn(io, 'writeFile')
    .mockImplementationOnce(async (): Promise<void> => {
      await write(logPath, 'partial');
      throw new Error('owned crop failed after truncation');
    });
  const stat = jest.spyOn(io, 'stat');
  const sink = makeSink(20);
  sink.append('first');
  expect(await sink.flush()).toMatchObject({
    writtenRecords: 1,
    failedRecords: 0,
  });
  expect(stat).toHaveBeenCalledTimes(2);
  expect(await io.readFile(logPath, 'utf8')).toBe(`partialfirst${EOL}`);
  now = 6000;
  sink.append('tail');
  expect(await sink.drain()).toMatchObject({
    writtenRecords: 2,
    failedRecords: 0,
  });
  expect(rename).toHaveBeenCalledTimes(1); // Actual cropped size is below maxSize.
  expect(await io.readFile(logPath, 'utf8')).toBe(
    `partialfirst${EOL}tail${EOL}`,
  );
});

test('rotation fallback does not hide a genuine append failure or poison recovery', async () => {
  const logPath = join(directory, 'main.log');
  const seed = '012345678901234567890123456789';
  await io.writeFile(logPath, seed);
  jest.spyOn(performance, 'now').mockReturnValue(1000);
  jest
    .spyOn(io, 'rename')
    .mockRejectedValue(new Error('owned archive failure'));
  jest
    .spyOn(io, 'writeFile')
    .mockRejectedValue(new Error('owned crop failure'));
  const append = io.appendFile;
  jest
    .spyOn(io, 'appendFile')
    .mockRejectedValueOnce(new Error('owned append failure'))
    .mockImplementation(async (...args): Promise<void> => {
      await append(...args);
    });
  const sink = makeSink(20);
  sink.append('failed');
  sink.append('recovery');
  expect(await sink.drain()).toEqual({
    throughSequence: 2,
    writtenRecords: 1,
    failedRecords: 1,
    droppedRecords: 0,
    failedGapNotices: 0,
  });
  expect(await io.readFile(logPath, 'utf8')).toBe(seed + `recovery${EOL}`);
});

test('flush after terminal drain reuses its fence and never writes a late gap', async () => {
  const sink = makeSink();
  sink.append('first');
  const terminal = sink.drain();
  const result = await terminal;
  sink.append('late closed admission');
  const after = sink.flush();
  await after;
  expect(await io.readFile(join(directory, 'main.log'), 'utf8')).toBe(
    `first${EOL}`,
  );
  expect(after).toBe(terminal);
  expect(await after).toBe(result);
  expect(result).toEqual({
    throughSequence: 1,
    writtenRecords: 1,
    failedRecords: 0,
    droppedRecords: 0,
    failedGapNotices: 0,
  });
});
