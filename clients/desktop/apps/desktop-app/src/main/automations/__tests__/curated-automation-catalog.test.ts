import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CuratedAutomationDetail } from '@canopy/protocol/automation-catalog';

let mockCachePath = '';
let mockCredentials = {
  baseUrl: 'https://cloud.example.test',
  apiKey: 'account-one-key',
};
const mockRequest = jest.fn<Promise<unknown>, unknown[]>();

jest.mock('../../lib/paths', () => ({
  getCuratedAutomationsCatalogFilePath: (): string => mockCachePath,
}));

jest.mock('../../canopy-cloud/client', () => ({
  requestCanopyCloudJson: (...args: unknown[]): Promise<unknown> =>
    mockRequest(...args),
  resolveCanopyCloudCredentialContext: (): Promise<typeof mockCredentials> =>
    Promise.resolve({ ...mockCredentials }),
}));

import {
  getCuratedAutomation,
  listCuratedAutomations,
  readCachedCuratedAutomations,
} from '../curated-automation-catalog';

function fixture(): CuratedAutomationDetail {
  const automation = {
    version: 1 as const,
    name: 'Daily review',
    description: 'Review open work',
    trigger: {
      kind: 'cron' as const,
      expression: '0 9 * * *',
      timezone: 'local' as const,
    },
    action: {
      type: 'app_advisor_prompt' as const,
      prompt: 'Review',
      plugins: [],
    },
    hasRunCondition: false,
  };
  const serialized = JSON.stringify(automation);
  return {
    key: 'daily-review',
    name: 'Daily review',
    shortDescription: 'Review open work',
    icon: '',
    triggerKind: 'cron',
    cronExpression: '0 9 * * *',
    actionType: 'app_advisor_prompt',
    pipelineSource: null,
    referencedCuratedPipelineKey: null,
    pluginCount: 0,
    contentHash: createHash('sha256').update(serialized).digest('hex'),
    contentSizeBytes: Buffer.byteLength(serialized),
    categories: ['review'],
    popular: false,
    sortOrder: 0,
    revision: 1,
    authorName: null,
    authorUrl: null,
    docsUrl: null,
    createdAt: '2026-09-30T12:00:00.000Z',
    updatedAt: '2026-09-30T12:00:00.000Z',
    automation,
  };
}

let directory: string;

beforeEach(async () => {
  jest.clearAllMocks();
  directory = await mkdtemp(join(tmpdir(), 'curated-automation-test-'));
  mockCachePath = join(directory, 'catalog.json');
  mockCredentials = {
    baseUrl: 'https://cloud.example.test',
    apiKey: 'account-one-key',
  };
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

it('caches only bounded summary metadata', async () => {
  mockRequest.mockResolvedValue({
    version: 1,
    data: [{ ...fixture(), unexpected: 'drop-me' }],
    nextCursor: null,
  });
  const result = await listCuratedAutomations({ limit: 25 });
  expect(result.data[0]).not.toHaveProperty('automation');
  expect(result.data[0]).not.toHaveProperty('unexpected');
  expect(await readFile(mockCachePath, 'utf8')).not.toContain('drop-me');
  await listCuratedAutomations({ limit: 25 });
  expect(mockRequest).toHaveBeenCalledTimes(1);
});

it('coalesces detail reads and verifies the canonical document hash', async () => {
  mockRequest.mockResolvedValue(fixture());
  const [first, second] = await Promise.all([
    getCuratedAutomation('daily-review'),
    getCuratedAutomation('daily-review'),
  ]);
  expect(first).toEqual(second);
  expect(mockRequest).toHaveBeenCalledTimes(1);

  mockRequest.mockResolvedValue({ ...fixture(), contentHash: 'b'.repeat(64) });
  await expect(getCuratedAutomation('daily-review')).rejects.toThrow(
    'failed verification',
  );
});

it('reads recommendations without refreshing and isolates the current account', async () => {
  expect(await readCachedCuratedAutomations()).toBeNull();
  expect(mockRequest).not.toHaveBeenCalled();
  mockRequest.mockResolvedValue({
    version: 1,
    data: [fixture()],
    nextCursor: null,
  });
  await listCuratedAutomations();
  mockRequest.mockClear();
  expect(await readCachedCuratedAutomations()).toMatchObject({
    data: [{ key: 'daily-review' }],
  });
  mockCredentials = { ...mockCredentials, apiKey: 'account-two-key' };
  expect(await readCachedCuratedAutomations()).toBeNull();
  expect(mockRequest).not.toHaveBeenCalled();
});
