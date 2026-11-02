import type { Stats } from 'node:fs';
import type * as FsPromises from 'node:fs/promises';

type PollerStat = (path: string) => Promise<Stats>;

const sendToAllWindows = jest.fn<void, [string, unknown]>();
const mockStat = jest.fn<ReturnType<PollerStat>, Parameters<PollerStat>>();

jest.mock('../lib/window-send', () => ({
  get sendToAllWindows(): typeof sendToAllWindows {
    return sendToAllWindows;
  },
}));
jest.mock('node:fs/promises', () => {
  const actual = jest.requireActual<typeof FsPromises>('node:fs/promises');
  return {
    ...actual,
    stat: (path: string): Promise<Stats> => mockStat(path),
  };
});

import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import {
  flushAndStopOutputPollingForSession,
  startOutputPolling,
  stopAllOutputPolling,
} from '../lib/bg-output-poller';

const target = {
  projectId: 'p1',
  worktreeId: 'w1',
  chatId: 'c1',
  taskId: 'task-1',
};

let dir: string;
let outputFile: string;

function nullWindow(): null {
  return null;
}

/** Wait for started polls to finish their stat/open/read/close chains. */
async function waitForEmittedLineCount(expectedCount: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (emittedLines().length < expectedCount) {
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for ${expectedCount} emitted output line(s)`,
      );
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

async function settlePendingPoll(): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/**
 * Emitted output lines, minus the trailing empty entry a newline-terminated
 * chunk produces. That split behavior predates this test and is not what these
 * cases are about.
 */
function emittedLines(): string[] {
  return sendToAllWindows.mock.calls.flatMap((call): string[] => {
    const [channel, event] = call;
    if (channel !== IPC_CHANNELS.activityBgProcessOutput) return [];
    if (typeof event !== 'object' || event === null) return [];
    const lines: unknown = Reflect.get(event, 'lines');
    return Array.isArray(lines)
      ? lines.filter(
          (line): line is string => typeof line === 'string' && line !== '',
        )
      : [];
  });
}

beforeEach(async () => {
  jest.clearAllMocks();
  const actual = jest.requireActual<typeof FsPromises>('node:fs/promises');
  mockStat.mockImplementation((path) => actual.stat(path));
  dir = await mkdtemp(join(tmpdir(), 'bg-output-poller-'));
  outputFile = join(dir, 'task.output');
});

afterEach(async () => {
  jest.useRealTimers();
  stopAllOutputPolling();
  await rm(dir, { recursive: true, force: true });
});

describe('flushAndStopOutputPollingForSession', () => {
  it('emits the tail written after the last interval poll, then stops the poller', async () => {
    await writeFile(outputFile, 'first\n', 'utf8');
    startOutputPolling({ ...target, outputFile }, nullWindow);
    await waitForEmittedLineCount(1);
    expect(emittedLines()).toEqual(['first']);

    await appendFile(outputFile, 'last\n', 'utf8');
    await flushAndStopOutputPollingForSession('p1/w1/c1');

    expect(emittedLines()).toEqual(['first', 'last']);

    // The poller is gone: further writes are never emitted.
    sendToAllWindows.mockClear();
    await appendFile(outputFile, 'after\n', 'utf8');
    await flushAndStopOutputPollingForSession('p1/w1/c1');
    expect(emittedLines()).toEqual([]);
  });

  it('emits a final line when the output has no trailing newline', async () => {
    await writeFile(outputFile, 'unterminated output', 'utf8');
    startOutputPolling({ ...target, outputFile }, nullWindow);
    await settlePendingPoll();

    expect(emittedLines()).toEqual([]);

    await flushAndStopOutputPollingForSession('p1/w1/c1');

    expect(emittedLines()).toEqual(['unterminated output']);
  });

  it('drains a final tail larger than the per-poll byte cap', async () => {
    await writeFile(outputFile, 'first\n', 'utf8');
    startOutputPolling({ ...target, outputFile }, nullWindow);
    await waitForEmittedLineCount(1);

    const largeTail = `${'x'.repeat(1023)}\n`.repeat(600);
    await appendFile(outputFile, `${largeTail}last-line`, 'utf8');
    await flushAndStopOutputPollingForSession('p1/w1/c1');

    const lines = emittedLines();
    expect(lines.at(-1)).toBe('last-line');
    expect(lines).toHaveLength(602);
  });

  it('does not emit from a read that finishes after the final-flush timeout', async () => {
    jest.useFakeTimers();
    const actual = jest.requireActual<typeof FsPromises>('node:fs/promises');
    let releaseStat = (): void => undefined;
    const statGate = new Promise<void>((resolve) => {
      releaseStat = resolve;
    });
    mockStat.mockImplementationOnce(async (path) => {
      await statGate;
      return actual.stat(path);
    });

    await writeFile(outputFile, 'late output\n', 'utf8');
    startOutputPolling({ ...target, outputFile }, nullWindow);
    const flush = flushAndStopOutputPollingForSession('p1/w1/c1');

    await jest.advanceTimersByTimeAsync(1_000);
    await flush;
    jest.useRealTimers();

    releaseStat();
    await settlePendingPoll();

    expect(emittedLines()).toEqual([]);
  });

  it('leaves pollers for other sessions running', async () => {
    await writeFile(outputFile, 'a\n', 'utf8');
    const otherFile = join(dir, 'other.output');
    await writeFile(otherFile, 'b\n', 'utf8');
    startOutputPolling({ ...target, outputFile }, nullWindow);
    startOutputPolling(
      { ...target, chatId: 'c2', outputFile: otherFile },
      nullWindow,
    );
    await waitForEmittedLineCount(2);

    await flushAndStopOutputPollingForSession('p1/w1/c1');
    sendToAllWindows.mockClear();

    await appendFile(otherFile, 'c\n', 'utf8');
    await flushAndStopOutputPollingForSession('p1/w1/c2');
    expect(emittedLines()).toEqual(['c']);
  });

  it('resolves for a session with no pollers', async () => {
    await expect(
      flushAndStopOutputPollingForSession('p1/w1/none'),
    ).resolves.toBeUndefined();
  });

  it('resolves even when the output file has disappeared', async () => {
    await writeFile(outputFile, 'a\n', 'utf8');
    startOutputPolling({ ...target, outputFile }, nullWindow);
    await waitForEmittedLineCount(1);
    await rm(outputFile);

    await expect(
      flushAndStopOutputPollingForSession('p1/w1/c1'),
    ).resolves.toBeUndefined();
  });
});
