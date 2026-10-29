/**
 * Darwin's background policy is applied and lifted by separate `taskpolicy`
 * processes. Launched back to back, they can exit in either order, so a
 * foreground request (`-B`) that finished before the earlier background
 * request (`-b`) was overwritten and left a worker disk-throttled while an
 * agent waited on it. Transitions for one pid must run in request order.
 */
type TaskpolicyCallback = (error: Error | null) => void;

interface PendingTaskpolicy {
  args: readonly string[];
  finish: TaskpolicyCallback;
}

const mockTaskpolicyRuns: PendingTaskpolicy[] = [];
const mockSetPriority = jest.fn();

jest.mock('node:child_process', () => ({
  execFile: (
    _command: string,
    args: readonly string[],
    _options: unknown,
    callback: TaskpolicyCallback,
  ): { unref: () => void } => {
    mockTaskpolicyRuns.push({ args, finish: callback });
    return { unref: (): void => undefined };
  },
}));
jest.mock('node:os', () => ({
  constants: { priority: { PRIORITY_LOW: 19 } },
  setPriority: (...args: unknown[]): unknown => mockSetPriority(...args),
}));

import {
  leaveBackgroundProcessPolicy,
  lowerSpawnedProcessPriority,
} from '../lib/background-process';

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

function setPlatform(value: string): void {
  Object.defineProperty(process, 'platform', {
    value,
    writable: true,
    configurable: true,
  });
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
}

function flags(): string[] {
  return mockTaskpolicyRuns.map((run) => run.args[0] ?? '');
}

describe('Darwin background process policy', () => {
  beforeEach(() => {
    mockTaskpolicyRuns.length = 0;
    mockSetPriority.mockReset();
    setPlatform('darwin');
  });

  afterAll(() => {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform);
    }
  });

  it('lifts the policy only after the background request has exited', async () => {
    lowerSpawnedProcessPriority(4242, { background: true });
    leaveBackgroundProcessPolicy(4242);
    await settle();

    expect(flags()).toEqual(['-b']);

    mockTaskpolicyRuns[0]?.finish(null);
    await settle();

    expect(flags()).toEqual(['-b', '-B']);
    expect(mockTaskpolicyRuns[1]?.args).toEqual(['-B', '-p', '4242']);
  });

  it('falls back to CPU priority before lifting a failed background request', async () => {
    lowerSpawnedProcessPriority(4343, { background: true });
    leaveBackgroundProcessPolicy(4343);
    await settle();

    mockTaskpolicyRuns[0]?.finish(new Error('taskpolicy failed'));
    await settle();

    expect(mockSetPriority).toHaveBeenCalledWith(4343, 19);
    expect(flags()).toEqual(['-b', '-B']);
  });

  it('does not order transitions for different processes', async () => {
    lowerSpawnedProcessPriority(1, { background: true });
    leaveBackgroundProcessPolicy(2);
    await settle();

    expect(mockTaskpolicyRuns.map((run) => run.args)).toEqual([
      ['-b', '-p', '1'],
      ['-B', '-p', '2'],
    ]);
  });

  it('only lowers CPU priority off Darwin', async () => {
    setPlatform('linux');
    lowerSpawnedProcessPriority(77, { background: true });
    leaveBackgroundProcessPolicy(77);
    await settle();

    expect(mockTaskpolicyRuns).toEqual([]);
    expect(mockSetPriority).toHaveBeenCalledWith(77, 19);
  });
});
