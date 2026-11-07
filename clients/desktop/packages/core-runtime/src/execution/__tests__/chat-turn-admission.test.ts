import type { PlatformProcessTable } from '../../platform/platform-services';
import { ExecutionAccounting } from '../accounting';
import {
  ChatTurnAdmissionError,
  type ExecutionAccountingLimits,
} from '../types';

const MIB = 1024 * 1024;

async function accounting(options: {
  maxActiveChatTurns: number | null;
  memoryCritical: boolean;
}): Promise<ExecutionAccounting<{ type: string }>> {
  const value = new ExecutionAccounting<{ type: string }>({
    rootPid: 1,
    readProcessTable: (): Promise<PlatformProcessTable> =>
      Promise.resolve({
        kind: 'sampled',
        rows: new Map([
          [
            1,
            {
              pid: 1,
              ppid: 0,
              pgid: 1,
              command: 'host',
              cpuPercent: 0,
              memoryRssBytes: 512 * MIB,
            },
          ],
        ]),
      }),
    limits: (): ExecutionAccountingLimits => ({
      maxActive: {},
      memoryGuardEnabled: true,
      warningMemoryBytes: 64 * MIB,
      criticalMemoryBytes: options.memoryCritical ? 128 * MIB : 4096 * MIB,
      maxActiveChatTurns: options.maxActiveChatTurns,
    }),
    productName: 'Test',
    groupLabel: (id): string => id,
    executionIdOf: (): undefined => undefined,
  });
  await value.sample();
  return value;
}

function refusal(run: () => unknown): ChatTurnAdmissionError {
  try {
    run();
  } catch (error) {
    if (error instanceof ChatTurnAdmissionError) return error;
    throw error;
  }
  throw new Error('Expected a chat-turn admission refusal.');
}

it('chatTurn admission counts outside activity, pending starts and the cap exactly as the desktop guard did', async () => {
  const value = await accounting({
    maxActiveChatTurns: 2,
    memoryCritical: false,
  });
  const first = value.admitChatTurn(1);
  expect(value.chatTurnPending()).toBe(1);
  expect(refusal(() => value.admitChatTurn(1))).toMatchObject({
    reason: 'limit',
    maxActive: 2,
  });
  first.release();
  first.release();
  expect(value.chatTurnPending()).toBe(0);
  value.admitChatTurn(1).release();
  value.dispose();
});

it('memory pressure refuses after the cap check', async () => {
  const value = await accounting({
    maxActiveChatTurns: 2,
    memoryCritical: true,
  });
  expect(refusal(() => value.admitChatTurn(2))).toMatchObject({
    reason: 'limit',
  });
  expect(refusal(() => value.admitChatTurn(0))).toMatchObject({
    reason: 'memory',
    maxActive: 2,
  });
  value.dispose();
});

it('clear forgets pending starts and a later release stays at zero', async () => {
  const value = await accounting({
    maxActiveChatTurns: null,
    memoryCritical: false,
  });
  const reservation = value.admitChatTurn(10);
  value.admitChatTurn(10);
  expect(value.chatTurnPending()).toBe(2);
  value.clearChatTurnPending();
  expect(value.chatTurnPending()).toBe(0);
  reservation.release();
  expect(value.chatTurnPending()).toBe(0);
  value.dispose();
});
