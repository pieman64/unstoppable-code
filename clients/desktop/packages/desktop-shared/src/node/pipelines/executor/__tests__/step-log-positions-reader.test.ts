import * as fs from 'node:fs';
import type * as FsPromises from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

/** Runs between the reader's file read and its second generation sample. */
const mockAfterRead: { hook: (() => void) | undefined } = { hook: undefined };

jest.mock('node:fs/promises', () => {
  const actual: typeof FsPromises = jest.requireActual('node:fs/promises');
  return {
    ...actual,
    readFile: async (
      ...args: Parameters<typeof actual.readFile>
    ): ReturnType<typeof actual.readFile> => {
      const content = await actual.readFile(...args);
      mockAfterRead.hook?.();
      return content;
    },
  };
});

import {
  commitWholeStepLog,
  completeUtf8PrefixLength,
  getStepLogGeneration,
  invalidateStepLogGeneration,
  openAppendingStepLogCursor,
  readStepLogFile,
  resetStepLogForPositionedWriter,
} from '../step-log-positions';

describe('step log generation registry and reader', () => {
  let tempDir: string;

  beforeEach(() => {
    mockAfterRead.hook = undefined;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-step-log-read-'));
  });

  afterEach(() => {
    mockAfterRead.hook = undefined;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('opens an appending cursor at the current end of the file', async () => {
    const logFile = path.join(tempDir, 'step.log');
    fs.writeFileSync(logFile, 'héader\n');
    const cursor = await openAppendingStepLogCursor(logFile);
    expect(cursor?.claim('x🙂')).toEqual({
      generation: cursor?.generation,
      offset: Buffer.byteLength('héader\n'),
      byteLength: 5,
    });
    expect(cursor?.claim('y')).toMatchObject({ offset: 13, byteLength: 1 });
    expect(getStepLogGeneration(logFile)).toBe(cursor?.generation);
  });

  it('returns no cursor for a missing log', async () => {
    await expect(
      openAppendingStepLogCursor(path.join(tempDir, 'missing.log')),
    ).resolves.toBeUndefined();
  });

  it('truncates for a whole-file writer and commits a strictly newer generation', async () => {
    const logFile = path.join(tempDir, 'step.log');
    fs.writeFileSync(logFile, 'setup line\n');
    const before = commitWholeStepLog(logFile, 'setup line\n').generation;
    const cursor = await resetStepLogForPositionedWriter(logFile);
    expect(fs.readFileSync(logFile, 'utf8')).toBe('');
    expect(cursor.generation).toBeGreaterThan(before);
    expect(cursor.claim('a')).toMatchObject({ offset: 0, byteLength: 1 });
    expect(getStepLogGeneration(logFile)).toBe(cursor.generation);
  });

  it('keeps the legacy lines shape by default and adds the byte length', async () => {
    const logFile = path.join(tempDir, 'step.log');
    fs.writeFileSync(logFile, 'one\r\ntwo\n');
    await expect(readStepLogFile(logFile)).resolves.toEqual({
      lines: ['one', 'two'],
      byteLength: 9,
    });
  });

  it('returns raw text that ends at a complete UTF-8 character', async () => {
    const logFile = path.join(tempDir, 'step.log');
    // 'ok\r\n ' plus two of the four bytes of an emoji: a write in progress.
    fs.writeFileSync(
      logFile,
      Buffer.concat([Buffer.from('ok\r\n '), Buffer.from([0xf0, 0x9f])]),
    );
    const { generation } = commitWholeStepLog(logFile, 'ok\r\n ');
    await expect(readStepLogFile(logFile, { format: 'text' })).resolves.toEqual(
      {
        lines: [],
        text: 'ok\r\n ',
        byteLength: 5,
        generation,
      },
    );
  });

  it('reads a missing log as empty without a generation', async () => {
    const logFile = path.join(tempDir, 'missing.log');
    await expect(readStepLogFile(logFile, { format: 'text' })).resolves.toEqual(
      { lines: [], text: '', byteLength: 0 },
    );
    await expect(readStepLogFile(logFile)).resolves.toEqual({
      lines: [],
      byteLength: 0,
    });
  });

  it('omits the generation once the log was invalidated for a rewrite', async () => {
    const logFile = path.join(tempDir, 'step.log');
    fs.writeFileSync(logFile, 'x\n');
    commitWholeStepLog(logFile, 'x\n');
    invalidateStepLogGeneration(logFile);
    await expect(
      readStepLogFile(logFile, { format: 'text' }),
    ).resolves.not.toHaveProperty('generation');
  });

  it.each([
    [
      'invalidated',
      (logFile: string): void => invalidateStepLogGeneration(logFile),
    ],
    [
      'replaced by a new generation',
      (logFile: string): void => {
        commitWholeStepLog(logFile, '');
      },
    ],
  ])(
    'omits the generation when it was %s while the read was in flight',
    async (_label, change) => {
      const logFile = path.join(tempDir, 'step.log');
      fs.writeFileSync(logFile, 'old\n');
      commitWholeStepLog(logFile, 'old\n');
      mockAfterRead.hook = (): void => change(logFile);

      const result = await readStepLogFile(logFile, { format: 'text' });
      expect(result.text).toBe('old\n');
      expect(result).not.toHaveProperty('generation');
    },
  );

  it('resolves registry keys by absolute path', () => {
    const logFile = path.join(tempDir, 'step.log');
    fs.writeFileSync(logFile, 'x');
    const { generation } = commitWholeStepLog(logFile, 'x');
    const relative = path.relative(process.cwd(), logFile);
    expect(getStepLogGeneration(relative)).toBe(generation);
  });

  it('bounds the registry, evicting the oldest committed log first', () => {
    const first = path.join(tempDir, 'first.log');
    commitWholeStepLog(first, '');
    for (let index = 0; index < 4096; index += 1) {
      commitWholeStepLog(path.join(tempDir, `log-${index}.log`), '');
    }
    expect(getStepLogGeneration(first)).toBeUndefined();
    expect(
      getStepLogGeneration(path.join(tempDir, 'log-4095.log')),
    ).toBeDefined();
  });

  it.each([
    ['empty', [], 0],
    ['ASCII', [0x61, 0x62], 2],
    ['complete two-byte', [0x61, 0xc3, 0xa9], 3],
    ['cut two-byte', [0x61, 0xc3], 1],
    ['cut three-byte', [0x61, 0xe2, 0x82], 1],
    ['cut four-byte after three', [0x61, 0xf0, 0x9f, 0x99], 1],
    ['complete four-byte', [0xf0, 0x9f, 0x99, 0x82], 4],
    ['stray continuation bytes', [0x80, 0x80], 2],
  ])(
    'completeUtf8PrefixLength keeps whole characters: %s',
    (_label, bytes, expected) => {
      expect(completeUtf8PrefixLength(Uint8Array.from(bytes))).toBe(expected);
    },
  );
});
