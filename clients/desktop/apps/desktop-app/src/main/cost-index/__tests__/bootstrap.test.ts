/* eslint-disable @typescript-eslint/explicit-function-return-type, @typescript-eslint/no-unsafe-return -- Jest host fixtures use deliberately minimal async mocks. */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  registerCostRetentionGuard,
  scheduleCostIndexStartup,
} from '../bootstrap';
import {
  mayPruneAuditDayFile,
  resetAuditStreamHooksForTest,
} from '../../observability/audit-stream-hooks';

const catchUpAndSealDay = jest.fn<Promise<boolean>, [string]>();
const startCostIndexScheduler = jest.fn();
jest.mock('../service', () => ({
  getDesktopCostIndexStore: () => ({ catchUpAndSealDay }),
}));
jest.mock('../scheduler', () => ({
  startCostIndexScheduler: () => startCostIndexScheduler(),
}));

describe('cost startup and first prune', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    resetAuditStreamHooksForTest();
  });
  afterEach(() => {
    jest.useRealTimers();
    resetAuditStreamHooksForTest();
  });

  it('guards the first prune without loading the scheduler and refuses an unconsumed day', async () => {
    catchUpAndSealDay.mockResolvedValue(false);
    registerCostRetentionGuard();
    expect(
      await mayPruneAuditDayFile({
        dayFilename: '2026-10-01.jsonl',
        fileDayTime: Date.parse('2026-10-01'),
        cutoffTime: Date.parse('2026-10-02'),
        retentionDays: 7,
      }),
    ).toBe(false);
    expect(catchUpAndSealDay).toHaveBeenCalledWith('2026-10-01.jsonl');
    expect(startCostIndexScheduler).not.toHaveBeenCalled();
    catchUpAndSealDay.mockResolvedValue(true);
    expect(
      await mayPruneAuditDayFile({
        dayFilename: '2026-10-01.jsonl',
        fileDayTime: Date.parse('2026-10-01'),
        cutoffTime: Date.parse('2026-10-02'),
        retentionDays: 7,
      }),
    ).toBe(true);
  });

  it('defers even importing/starting the scheduler for at least sixty seconds', async () => {
    scheduleCostIndexStartup();
    await jest.advanceTimersByTimeAsync(59_999);
    expect(startCostIndexScheduler).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(startCostIndexScheduler).toHaveBeenCalledTimes(1);
  });

  it('registers its guard before any observability startup invocation in main', async () => {
    const main = await readFile(join(__dirname, '../../index.ts'), 'utf8');
    expect(main.indexOf('registerCostRetentionGuard();')).toBeGreaterThan(0);
    expect(main.indexOf('registerCostRetentionGuard();')).toBeLessThan(
      main.indexOf('void initializeObservabilityService()'),
    );
  });
});
