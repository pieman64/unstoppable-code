import type {
  InterfaceToolDeliveredEvent,
  InterfaceToolSettledEvent,
} from '@canopy/core-runtime/node/client';
import {
  createInterfaceToolProvenance,
  type InterfaceToolProvenanceIngest,
} from '../interface-tool-provenance';

const scope = { workspaceId: 'p', worktreeId: 'w', chatId: 'c' };
const delivered: InterfaceToolDeliveredEvent = {
  toolName: 'ui.show_files',
  callId: 'call-1',
  leaseId: 'lease-1',
  surface: 'main',
  scope,
};
const settled: InterfaceToolSettledEvent = {
  toolName: 'ui.show_files',
  callId: 'call-1',
  leaseId: 'lease-1',
  surface: 'main',
  interfaceKind: 'desktop',
  scope,
  outcome: 'answered',
  deliveredAt: 0,
  settledAt: 1,
};

function fakeIngest(steps: string[]): InterfaceToolProvenanceIngest {
  return {
    noteInterfaceToolCallDelivered: (_p, _w, _c, callId): void => {
      steps.push(`bind:${callId}`);
    },
    recordInterfaceToolCall: (_p, _w, _c, call): void => {
      steps.push(`record:${call.callId}`);
    },
  };
}

const flush = async (): Promise<void> => {
  for (let tick = 0; tick < 10; tick += 1) await Promise.resolve();
};

describe('interface tool provenance hooks (CAN-5828)', () => {
  it('a delivery binds its call before anything else can run', async () => {
    const steps: string[] = [];
    const hooks = createInterfaceToolProvenance({
      load: () => Promise.resolve(fakeIngest(steps)),
      onError: (error) => {
        throw error;
      },
    });
    await flush();
    hooks.onDelivered(delivered);
    // Synchronous: a turn that starts after this line cannot take the call.
    steps.push('next turn starts');
    hooks.onSettled(settled);
    await flush();
    expect(steps).toEqual(['bind:call-1', 'next turn starts', 'record:call-1']);
  });

  it('a call delivered before the ingest loaded is never bound later', async () => {
    const steps: string[] = [];
    let finishLoad: (ingest: InterfaceToolProvenanceIngest) => void = () =>
      undefined;
    const hooks = createInterfaceToolProvenance({
      load: () =>
        new Promise((resolve) => {
          finishLoad = resolve;
        }),
      onError: (error) => {
        throw error;
      },
    });
    hooks.onDelivered(delivered);
    steps.push('next turn starts');
    finishLoad(fakeIngest(steps));
    await flush();
    hooks.onSettled(settled);
    await flush();
    // Unbound, so the service drops the record instead of crediting the
    // turn open when the ingest arrived.
    expect(steps).toEqual(['next turn starts', 'record:call-1']);
  });
});
