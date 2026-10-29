/** @jest-environment node */
import fs from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  initializeMainProcessLogging,
  resetMainProcessLoggingForTests,
} from '../lib/main-process-logging';

// Keep the installed electron-log writer, transforms and initializer real.
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

async function waitForText(path: string, marker: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const text = await readFile(path, 'utf8').catch(() => '');
    if (text.includes(marker)) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Owned main log did not receive ${marker}`);
}

test('production initializer does not synchronously append recurring error records', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'canopy-main-log-red-'));
  const previous = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = directory;
  const logPath = join(directory, 'logs', 'main.log');
  const originalWrite = fs.writeFileSync;
  let recurringSyncWrites = 0;
  // Preserve real writes. Count only nonempty writes for this exact owned path,
  // after initialization, not incidental startup or other modules' I/O.
  try {
    initializeMainProcessLogging();
    const spy = jest
      .spyOn(fs, 'writeFileSync')
      .mockImplementation((file, data, options): void => {
        if (
          file === logPath &&
          typeof data === 'string' &&
          data.includes('causal-main-log-burst-')
        )
          recurringSyncWrites += 1;
        originalWrite(file, data, options);
      });
    try {
      for (let index = 0; index < 32; index += 1)
        // eslint-disable-next-line no-console -- exercise actual console forwarding
        console.error(`causal-main-log-burst-${index}`);
      await waitForText(logPath, 'causal-main-log-burst-31');
      // Intended unchanged-source RED: 32 actual fs.writeFileSync appends.
      expect(recurringSyncWrites).toBe(0);
    } finally {
      spy.mockRestore();
    }
  } finally {
    resetMainProcessLoggingForTests();
    if (previous === undefined) delete process.env.CANOPY_DATA_DIR;
    else process.env.CANOPY_DATA_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
