import type {
  CanopyCallerDescriptor,
  CoreExecutionStatusEventsItem,
} from '@canopy/protocol/canopy-core';
import type { CanopyStreamFrame } from '@canopy/core-runtime';

// CAN-5080: every client reads core execution accounting through
// core.execution.*, and resource-monitor:get-snapshot projects that read.

jest.mock('electron', () => ({ app: { getAppMetrics: (): unknown[] => [] } }));

jest.mock('node:child_process', () => ({
  execFile: (
    _file: string,
    _args: string[],
    _options: unknown,
    callback: (error: Error | null, stdout: string) => void,
  ): void => callback(new Error('process table unavailable'), ''),
}));

jest.mock('../../observability', () => ({
  getObservabilityService: (): unknown => ({
    recordAppDiagnostic: jest.fn(),
  }),
}));

jest.mock('@canopy/desktop-instrumentation/electron/main', () => ({
  failDesktopOperation: jest.fn(),
  startDesktopOperation: jest.fn(),
  succeedDesktopOperation: jest.fn(),
}));

import { getExecutionAccounting } from '../../execution-accounting';
import {
  disposeResourceMonitorService,
  getResourceMonitorService,
} from '../../resource-monitor';
import { createDesktopRuntime } from '../desktop-runtime';
import { readResourceMonitorSnapshotThroughCore } from '../resource-monitor-dispatch';

const caller = (
  clientInstanceId: string,
  grants: CanopyCallerDescriptor['grants'] = ['core.execution.read'],
): CanopyCallerDescriptor => ({
  principalId: 'local-desktop-user',
  clientInstanceId,
  authorityId: 'desktop-local',
  interfaceKind: 'desktop',
  grants,
});

type Frame = CanopyStreamFrame<CoreExecutionStatusEventsItem, unknown>;

const flush = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

let dispatcher: ReturnType<typeof createDesktopRuntime>;

beforeEach(() => {
  dispatcher = createDesktopRuntime({ shutdownTimeoutMs: 25 });
});

afterEach(async () => {
  disposeResourceMonitorService();
  await dispatcher.shutdown();
});

describe('desktop dispatcher core.execution.*', () => {
  it('denies a caller without the execution read grant', async () => {
    await expect(
      dispatcher.query(
        'core.execution.status.get',
        {},
        { caller: caller('window', []) },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'permission_denied' } });
  });

  it('reads live family counts from the shared accounting', async () => {
    const lease = getExecutionAccounting().track('script', 'script:one');
    try {
      const { status } = await dispatcher.query(
        'core.execution.status.get',
        {},
        { caller: caller('window') },
      );
      expect(status.families.script).toMatchObject({ active: 1 });
    } finally {
      lease.release();
    }
  });

  it('delivers each sample to every attached client', async () => {
    const seen: Record<string, Frame[]> = { a: [], b: [] };
    const handles = await Promise.all(
      ['a', 'b'].map((id) =>
        dispatcher.openStream(
          'core.execution.status.events',
          {},
          {
            caller: caller(id),
            onFrame: (frame: Frame): void => {
              seen[id]?.push(frame);
            },
          },
        ),
      ),
    );
    await flush();
    const sample = await getExecutionAccounting().sample();
    await flush();
    for (const frames of Object.values(seen)) {
      const items = frames.flatMap((frame) =>
        frame.kind === 'item' ? [frame.item.status.sampledAt] : [],
      );
      expect(items).toHaveLength(2);
      expect(items[1]).toBe(sample.sampledAt);
    }
    for (const handle of handles) handle.close();
  });

  it('projects resource-monitor:get-snapshot from the core read unchanged', async () => {
    const service = getResourceMonitorService();
    const sampled = await service.sampleNow();
    const projected = await readResourceMonitorSnapshotThroughCore(
      dispatcher,
      caller('window', []),
    );
    expect(projected).toBe(sampled);
  });
});
