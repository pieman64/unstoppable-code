import { SettingsOperationError } from '@canopy/protocol/settings';
import type { ModelRoutingBacktestV1 } from '@canopy/protocol/model-routing';
import { createFakeSettingsClient } from '../../../__tests__/helpers/test-settings-host';
import { TeamApiError } from '../../team-api';
import {
  createRoutingBacktest,
  getRoutingBacktest,
  lookupRoutingBacktest,
} from '../routing-backtest-api';

jest.mock('../../team-api', () => ({
  TeamApiError: class TeamApiError extends Error {
    constructor(
      public status: number,
      public serverDetail?: string,
      public code?: string,
    ) {
      super('Something went wrong. Try again.');
    }
  },
}));

const RANGE = {
  startIso: '2026-09-01T00:00:00.000Z',
  endIso: '2026-10-01T00:00:00.000Z',
};

const RUN: ModelRoutingBacktestV1 = {
  id: 'bt-1',
  subject: 'user',
  scope: 'organization',
  status: 'queued',
  mode: 'sample',
  rangeStartIso: RANGE.startIso,
  rangeEndIso: RANGE.endIso,
  createdAtIso: RANGE.endIso,
  completedAtIso: null,
  estimatedCostUsd: 0.6,
  progress: { replayedTurnCount: 0, plannedTurnCount: 10 },
  failureCode: null,
  result: null,
};

const LOOKUP = { backtest: null, estimate: null, unavailableReason: null };

describe('routing-backtest-api', () => {
  it('reads the personal estimate through the account entries', async () => {
    const client = createFakeSettingsClient({
      'account.profile.routingBacktest.lookup': () => LOOKUP,
      'account.profile.routingBacktest.create': () => ({
        backtest: RUN,
        cached: false,
      }),
      'account.profile.routingBacktest.read': () => ({ backtest: RUN }),
    });
    await lookupRoutingBacktest(client, { kind: 'user' }, RANGE);
    await createRoutingBacktest(client, { kind: 'user' }, RANGE, 'full');
    await expect(
      getRoutingBacktest(client, { kind: 'user' }, 'bt-1'),
    ).resolves.toEqual(RUN);
    expect(client.calls).toEqual([
      { operation: 'account.profile.routingBacktest.lookup', input: RANGE },
      {
        operation: 'account.profile.routingBacktest.create',
        input: { ...RANGE, mode: 'full' },
      },
      {
        operation: 'account.profile.routingBacktest.read',
        input: { backtestId: 'bt-1' },
      },
    ]);
  });

  it('passes the Statistics filter to the organization entries', async () => {
    const client = createFakeSettingsClient({
      'organization.statistics.routingBacktest.lookup': () => LOOKUP,
      'organization.statistics.routingBacktest.get': () => ({ backtest: RUN }),
    });
    const subject = {
      kind: 'organization' as const,
      orgId: 'org-1',
      scope: 'team' as const,
      teamId: 'team-1',
    };
    await lookupRoutingBacktest(client, subject, RANGE);
    await getRoutingBacktest(client, subject, 'bt-1');
    expect(client.calls).toEqual([
      {
        operation: 'organization.statistics.routingBacktest.lookup',
        input: {
          organizationId: 'org-1',
          scope: 'team',
          teamId: 'team-1',
          ...RANGE,
        },
      },
      {
        operation: 'organization.statistics.routingBacktest.get',
        input: { organizationId: 'org-1', backtestId: 'bt-1' },
      },
    ]);
  });

  it("keeps the route's code, and its message only as the log detail, on a refused start", async () => {
    const client = createFakeSettingsClient({
      'account.profile.routingBacktest.create': () => {
        throw new SettingsOperationError({
          code: 'failed',
          status: 402,
          message: 'Not enough AI Credits.',
          serverCode: 'insufficient_credits',
        });
      },
    });
    const error: unknown = await createRoutingBacktest(
      client,
      { kind: 'user' },
      RANGE,
      'sample',
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TeamApiError);
    expect(error).toMatchObject({
      status: 402,
      serverDetail: 'Not enough AI Credits.',
      code: 'insufficient_credits',
    });
    expect(String(error)).not.toContain('Not enough AI Credits.');
  });

  it('carries no detail when the route sent no message', async () => {
    const client = createFakeSettingsClient({
      'account.profile.routingBacktest.lookup': () => {
        throw new SettingsOperationError({ code: 'failed', status: 429 });
      },
    });
    await expect(
      lookupRoutingBacktest(client, { kind: 'user' }, RANGE),
    ).rejects.toMatchObject({ status: 429, serverDetail: undefined });
  });

  it('leaves a failure without a response as a plain error', async () => {
    const client = createFakeSettingsClient({
      'account.profile.routingBacktest.lookup': () => {
        throw new SettingsOperationError({ code: 'offline' });
      },
    });
    const error: unknown = await lookupRoutingBacktest(
      client,
      { kind: 'user' },
      RANGE,
    ).catch((caught: unknown) => caught);
    expect(error).not.toBeInstanceOf(TeamApiError);
  });

  it('rejects a malformed run as an invalid server response', async () => {
    const client = createFakeSettingsClient({
      'account.profile.routingBacktest.read': () => ({ backtest: { id: 1 } }),
    });
    await expect(
      getRoutingBacktest(client, { kind: 'user' }, 'bt-1'),
    ).rejects.toMatchObject({ serverDetail: 'Invalid server response' });
  });
});
