import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  CanopyCallerDescriptor,
  CanopyJsonValue,
} from '@canopy/protocol/canopy-core';
import { OperationService } from '../../../operations';
import { OperationLedger } from '../../../operations/ledger';
import {
  AdvisorActionRuns,
  CORE_APP_ADVISOR_ACTION_RUN,
  type AdvisorActionRunRequest,
} from '..';

const caller: CanopyCallerDescriptor = {
  principalId: 'desktop-app-advisor',
  clientInstanceId: 'app-advisor-chat:c',
  authorityId: 'local-desktop',
  interfaceKind: 'mcp',
  grants: ['core.pipeline.write'],
};

interface Result {
  [key: string]: string;
  text: string;
}

let root: string;
let ledgerPath: string;
const services: OperationService[] = [];

function open(
  openLedger: () => OperationLedger = (): OperationLedger =>
    OperationLedger.open(ledgerPath),
): { operations: OperationService; runs: AdvisorActionRuns } {
  const operations = new OperationService({ openLedger });
  services.push(operations);
  return { operations, runs: new AdvisorActionRuns({ operations }) };
}

function request(
  effect: () => Promise<Result>,
  action: CanopyJsonValue = { type: 'pipeline.create', name: 'p' },
): AdvisorActionRunRequest<Result> {
  return {
    caller,
    idempotencyKey: 'app-advisor-action:c:toolu_1',
    fingerprintInput: {
      type: 'pipeline.create',
      action,
      expectedUiRevision: null,
    },
    scope: { workspaceId: 'app-advisor', worktreeId: 'global', chatId: 'c' },
    actionType: 'pipeline.create',
    decode: (outcome) =>
      typeof outcome === 'object' &&
      outcome !== null &&
      'text' in outcome &&
      typeof outcome.text === 'string'
        ? { text: outcome.text }
        : null,
    effect,
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'can-4133-'));
  ledgerPath = join(root, 'ledger.sqlite');
});
afterEach(() => {
  for (const service of services.splice(0)) service.close();
  rmSync(root, { recursive: true, force: true });
});

describe('App Advisor action receipts (CAN-4133)', () => {
  it('runs the effect once for a repeated key, across a restart', async () => {
    const first = open();
    const effect = jest.fn(
      (): Promise<Result> => Promise.resolve({ text: 'created' }),
    );

    await expect(first.runs.run(request(effect))).resolves.toEqual({
      status: 'ran',
      result: { text: 'created' },
    });
    await expect(first.runs.run(request(effect))).resolves.toEqual({
      status: 'replayed',
      result: { text: 'created' },
    });
    expect(effect).toHaveBeenCalledTimes(1);

    first.operations.close();
    const second = open();
    await expect(second.runs.run(request(effect))).resolves.toEqual({
      status: 'replayed',
      result: { text: 'created' },
    });
    expect(effect).toHaveBeenCalledTimes(1);
  });

  it('a concurrent repeat joins the running attempt', async () => {
    const { runs } = open();
    let finish = (): void => undefined;
    const effect = jest.fn(
      (): Promise<Result> =>
        new Promise<Result>((resolve) => {
          finish = (): void => resolve({ text: 'created' });
        }),
    );

    const first = runs.run(request(effect));
    const second = runs.run(request(effect));
    await new Promise((resolve) => setImmediate(resolve));
    finish();

    const [a, b] = await Promise.all([first, second]);
    expect(effect).toHaveBeenCalledTimes(1);
    expect(a).toEqual({ status: 'ran', result: { text: 'created' } });
    expect(b).toEqual({ status: 'replayed', result: { text: 'created' } });
  });

  it('an interrupted attempt is never re-run', async () => {
    const first = open();
    let started = (): void => undefined;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    void first.runs
      .run(
        request(() => {
          started();
          return new Promise<Result>(() => undefined);
        }),
      )
      .catch(() => undefined);
    await running;

    first.operations.close();
    const second = open();
    const effect = jest.fn(
      (): Promise<Result> => Promise.resolve({ text: 'again' }),
    );
    await expect(second.runs.run(request(effect))).resolves.toEqual({
      status: 'interrupted',
    });
    expect(effect).not.toHaveBeenCalled();
  });

  it('a reused key with another action conflicts and does not run', async () => {
    const { runs } = open();
    const effect = jest.fn(
      (): Promise<Result> => Promise.resolve({ text: 'created' }),
    );

    await runs.run(request(effect));
    await expect(
      runs.run(request(effect, { type: 'pipeline.create', name: 'other' })),
    ).resolves.toEqual({ status: 'conflict' });
    expect(effect).toHaveBeenCalledTimes(1);
  });

  it('a ledger refusal does not run the effect', async () => {
    const { runs } = open((): OperationLedger => {
      throw new Error('disk full');
    });
    const effect = jest.fn(
      (): Promise<Result> => Promise.resolve({ text: 'created' }),
    );

    await expect(runs.run(request(effect))).resolves.toEqual({
      status: 'unavailable',
    });
    expect(effect).not.toHaveBeenCalled();
  });

  it('the record holds the action type and never the action', async () => {
    const { operations, runs } = open();
    const secret = 'sk-live-do-not-store';

    await runs.run(
      request(() => Promise.resolve({ text: 'created' }), {
        type: 'pipeline.create',
        rawYaml: secret,
      }),
    );

    const { items } = await operations.list({
      kinds: [CORE_APP_ADVISOR_ACTION_RUN],
      limit: 10,
    });
    expect(items).toHaveLength(1);
    expect(items[0]?.origin.context).toEqual({ actionType: 'pipeline.create' });
    const stored = await operations.get(items[0]?.operationId ?? '');
    expect(JSON.stringify(stored)).not.toContain(secret);
  });
});
