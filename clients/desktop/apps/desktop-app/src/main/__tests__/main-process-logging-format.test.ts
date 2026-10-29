/** @jest-environment node */
import log from 'electron-log/main.js';
import type { LogMessage } from 'electron-log';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import io from 'node:fs/promises';
import { EOL, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  initializeMainProcessLogging,
  drainMainProcessLogging,
  drainMainProcessLoggingBestEffort,
  resetMainProcessLoggingForTests,
} from '../lib/main-process-logging';
jest.mock('electron', () => ({
  app: {
    isPackaged: false,
    isReady: (): boolean => true,
    setAppLogsPath: jest.fn(),
    getPath: (): string => '/unused',
    on: jest.fn(),
    off: jest.fn(),
  },
  ipcMain: { on: jest.fn(), handle: jest.fn() },
}));
jest.mock('../lib/e2e-gate', () => ({ isE2eBuild: (): boolean => true }));

test('custom transport retains actual installed Error/object/Unicode formatting at admission', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'canopy-main-log-format-'));
  const previous = process.env.CANOPY_DATA_DIR;
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  process.env.CANOPY_DATA_DIR = directory;
  try {
    initializeMainProcessLogging();
    const value = { value: 'before' };
    const message = {
      date: new Date('2026-10-01T12:30:45.123Z'),
      level: 'error',
      data: ['format-é\nsecond line', new Error('owned failure'), value],
    };
    const typedMessage: LogMessage = {
      ...message,
      level: 'error',
    };
    let expected: unknown = typedMessage.data;
    for (const transform of log.transports.file.transforms) {
      if (!Array.isArray(expected)) throw new Error('unexpected transform');
      expected = transform({
        data: expected,
        message: typedMessage,
        logger: log,
        transport: log.transports.file,
      });
    }
    log.processMessage(typedMessage);
    log.debug('filtered-main-debug');
    value.value = 'after';
    const result = await drainMainProcessLogging();
    expect(result.failedRecords + result.droppedRecords).toBe(0);
    const text = await readFile(join(directory, 'logs', 'main.log'), 'utf8');
    if (typeof expected !== 'string')
      throw new Error('Expected formatted string');
    expect(text.endsWith(`${expected}${EOL}`)).toBe(true);
    expect(text).not.toContain('filtered-main-debug');
    expect(text).not.toContain("value: 'after'");
  } finally {
    resetMainProcessLoggingForTests();
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previous === undefined) delete process.env.CANOPY_DATA_DIR;
    else process.env.CANOPY_DATA_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test('failure-exit terminal deadline reports timeout without blocking further required cleanup', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'canopy-main-log-deadline-'));
  const previous = process.env.CANOPY_DATA_DIR;
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  process.env.CANOPY_DATA_DIR = directory;
  const append = io.appendFile;
  let release = (): void => undefined;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const spy = jest
    .spyOn(io, 'appendFile')
    .mockImplementation(async (...args): Promise<void> => {
      await blocked;
      await append(...args);
    });
  try {
    initializeMainProcessLogging();
    jest.useFakeTimers();
    const result = drainMainProcessLoggingBestEffort(25);
    jest.advanceTimersByTime(25);
    expect(await result).toBeNull();
  } finally {
    jest.useRealTimers();
    release();
    await drainMainProcessLogging();
    spy.mockRestore();
    resetMainProcessLoggingForTests();
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previous === undefined) delete process.env.CANOPY_DATA_DIR;
    else process.env.CANOPY_DATA_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
