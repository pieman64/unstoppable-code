type RegisteredIpcHandler = (
  event: unknown,
  ...args: unknown[]
) => Promise<unknown>;

const mockIpcMainHandle = jest.fn<void, [string, RegisteredIpcHandler]>();
const mockIpcMainRemoveHandler = jest.fn<void, [string]>();

jest.mock('electron', () => ({
  ipcMain: {
    handle: mockIpcMainHandle,
    removeHandler: mockIpcMainRemoveHandler,
  },
}));

jest.mock(
  '@canopy/desktop-instrumentation',
  (): {
    createDesktopInstrumentationOperationKey: (value: string) => string;
  } => ({
    createDesktopInstrumentationOperationKey: (value: string) =>
      `hashed:${value}`,
  }),
);

jest.mock('@canopy/desktop-instrumentation/electron/main', () => ({
  failDesktopOperation: jest.fn(),
  startDesktopOperation: jest.fn(),
  succeedDesktopOperation: jest.fn(),
}));

import {
  startDesktopOperation,
  succeedDesktopOperation,
  failDesktopOperation,
} from '@canopy/desktop-instrumentation/electron/main';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import {
  resetWorkCounters,
  snapshotWorkCounters,
} from '@canopy/desktop-shared/node/work-counters';
import { registerIpcHandler } from '../ipc/register';
import { addRendererDeliveryBarrier } from '../lib/web-contents-send';
import {
  getSlowActionSnapshot,
  resetSlowActionTrackerForTests,
} from '../lib/slow-action-tracker';

function matchingObject(value: Record<string, unknown>): unknown {
  return expect.objectContaining(value);
}

function matchingString(pattern: RegExp): unknown {
  return expect.stringMatching(pattern);
}

function getRegisteredHandler(): RegisteredIpcHandler {
  const calls = mockIpcMainHandle.mock.calls;
  const lastCall = calls[calls.length - 1];
  if (!lastCall) {
    throw new Error('No IPC handler was registered');
  }
  return lastCall[1];
}

describe('registerIpcHandler', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-05-27T12:00:00.000Z'));
    jest.clearAllMocks();
    resetSlowActionTrackerForTests();
  });

  afterEach(() => {
    resetSlowActionTrackerForTests();
    jest.useRealTimers();
  });

  it('converts synchronous Error throws into rejected promises with failure telemetry', async () => {
    registerIpcHandler('test:sync-error', () => {
      throw new Error('sync failed');
    });

    await expect(getRegisteredHandler()({})).rejects.toThrow('sync failed');

    expect(failDesktopOperation).toHaveBeenCalledWith(
      'canopy.ipc_action',
      'error',
      matchingObject({
        operationKey: matchingString(/^hashed:tracked-action:ipc:slow-ipc-/),
        context: matchingObject({
          channel: 'test:sync-error',
          duration_ms: 0,
          status: 'failure',
        }),
      }),
    );
  });

  it('normalizes synchronous non-Error throws before telemetry wrapping', async () => {
    registerIpcHandler('test:sync-non-error', () => {
      // eslint-disable-next-line no-throw-literal, @typescript-eslint/only-throw-error
      throw {
        toString: (): string => 'sync failed',
      };
    });

    await expect(getRegisteredHandler()({})).rejects.toThrow('sync failed');

    expect(failDesktopOperation).toHaveBeenCalledWith(
      'canopy.ipc_action',
      'error',
      matchingObject({
        context: matchingObject({
          channel: 'test:sync-non-error',
          status: 'failure',
        }),
      }),
    );
  });

  it('runs renderer delivery barriers for the sender before the reply settles', async () => {
    const order: string[] = [];
    const sender = { id: 7 };
    const remove = addRendererDeliveryBarrier((target, channel) => {
      order.push(
        `barrier:${channel}:${target === sender ? 'sender' : 'other'}`,
      );
    });
    try {
      registerIpcHandler('test:reply-barrier', async () => {
        await Promise.resolve();
        order.push('handler-settled');
        return 'value';
      });
      const resolved = getRegisteredHandler()({ sender }).then((value) => {
        order.push(`reply:${String(value)}`);
      });
      registerIpcHandler('test:reply-barrier-error', () => {
        order.push('handler-threw');
        throw new Error('failed');
      });
      const rejected = getRegisteredHandler()({ sender }).catch(() => {
        order.push('reply:error');
      });
      await Promise.all([resolved, rejected]);
    } finally {
      remove();
    }
    const at = (entry: string): number => {
      const index = order.indexOf(entry);
      expect(index).toBeGreaterThanOrEqual(0);
      return index;
    };
    expect(at('handler-settled')).toBeLessThan(
      at('barrier:test:reply-barrier:sender'),
    );
    expect(at('barrier:test:reply-barrier:sender')).toBeLessThan(
      at('reply:value'),
    );
    expect(at('handler-threw')).toBeLessThan(
      at('barrier:test:reply-barrier-error:sender'),
    );
    expect(at('barrier:test:reply-barrier-error:sender')).toBeLessThan(
      at('reply:error'),
    );
    expect(order).toHaveLength(6);
  });

  it('tracks a long memory report without timing it out, retrying, or serializing invokes', async () => {
    let finishReport: ((value: string) => void) | undefined;
    const report = new Promise<string>((resolve) => {
      finishReport = resolve;
    });
    const createReport = jest.fn(() => report);
    registerIpcHandler(
      IPC_CHANNELS.memoryDiagnosticsCreateReport,
      createReport,
    );
    const invoke = getRegisteredHandler();
    let settled = false;
    const first = invoke({}).then((value) => {
      settled = true;
      return value;
    });
    const second = invoke({});

    // Each request reaches the service immediately; admission remains service-owned.
    expect(createReport).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(300_000);
    expect(settled).toBe(false);
    expect(createReport).toHaveBeenCalledTimes(2);
    expect(failDesktopOperation).not.toHaveBeenCalled();
    expect(getSlowActionSnapshot().records).toHaveLength(2);
    for (const record of getSlowActionSnapshot().records) {
      expect(record.label).toBe('Creating a memory report');
    }

    if (finishReport === undefined) throw new Error('Missing report resolver');
    finishReport('complete');
    await expect(first).resolves.toBe('complete');
    await expect(second).resolves.toBe('complete');
    expect(getSlowActionSnapshot().records).toEqual([]);
  });

  it('does not wrap script:run handlers in slow-action telemetry', async () => {
    registerIpcHandler(IPC_CHANNELS.scriptRun, () => 'done');

    await expect(getRegisteredHandler()({})).resolves.toBe('done');

    expect(failDesktopOperation).not.toHaveBeenCalled();
  });

  it('counts every invocation per channel, including rejected and untracked ones', async () => {
    resetWorkCounters();
    registerIpcHandler('test:counted', () => 'ok');
    const counted = getRegisteredHandler();
    registerIpcHandler(IPC_CHANNELS.scriptRun, () => {
      throw new Error('script failed');
    });
    const untracked = getRegisteredHandler();

    await expect(counted({})).resolves.toBe('ok');
    await expect(counted({}, 'argument')).resolves.toBe('ok');
    await expect(untracked({})).rejects.toThrow('script failed');

    expect(snapshotWorkCounters().ipc).toEqual({
      'invoke.test:counted': 2,
      [`invoke.${IPC_CHANNELS.scriptRun}`]: 1,
    });
  });
});

it.each([IPC_CHANNELS.orgProjectLinksList, IPC_CHANNELS.orgProjectLinksDecide])(
  'never emits telemetry for private relationship IPC %s',
  async (channel): Promise<void> => {
    jest.clearAllMocks();
    registerIpcHandler(channel, (): never => {
      throw new Error('Project not available');
    });
    await expect(
      getRegisteredHandler()({}, { personalWorkspaceId: 'private' }),
    ).rejects.toThrow('Project not available');
    expect(startDesktopOperation).not.toHaveBeenCalled();
    expect(succeedDesktopOperation).not.toHaveBeenCalled();
    expect(failDesktopOperation).not.toHaveBeenCalled();
  },
);
