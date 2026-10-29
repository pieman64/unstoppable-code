const readFileMock = jest.fn();
const writeFileMock = jest.fn();
const mkdirMock = jest.fn();
const requestPublicJsonMock = jest.fn();

jest.mock('node:fs/promises', () => ({
  readFile: readFileMock,
  writeFile: writeFileMock,
  mkdir: mkdirMock,
}));

jest.mock('../../canopy-cloud/client', () => ({
  requestCanopyCloudPublicJson: requestPublicJsonMock,
}));

jest.mock('../../lib/paths', () => ({
  getOpenAiPricingCacheFilePath: jest.fn(() => '/mock/openai-pricing.json'),
}));

import type { OpenAiPricingResponseV1 } from '@canopy/protocol/openai-pricing';
import {
  getOpenAiPricingForCosting,
  getOpenAiPricingForCostingSync,
  resetOpenAiPricingCacheForTest,
} from '../pricing-client';

const payload: OpenAiPricingResponseV1 = {
  version: 1,
  currency: 'usd',
  tokenUnit: 'per_1m_tokens',
  source: {
    pricingUrl: 'https://developers.openai.com/api/docs/pricing',
    codexPricingUrl: 'https://developers.openai.com/codex/pricing',
    codexSpeedUrl: 'https://developers.openai.com/codex/speed',
    fetchedAt: '2026-06-18T00:00:00.000Z',
    generatedBy: 'test',
  },
  cache: { maxAgeSeconds: 3600, staleWhileRevalidateSeconds: 86400 },
  basis: {
    tokenPricing: 'openai_api_standard',
    fastModePricing: 'codex_credit_adjusted_standard_equivalent',
    notes: ['cache-creation input billed as uncached input'],
  },
  serviceTierAliases: {
    default: 'standard',
    standard: 'standard',
    priority: 'fast',
    fast: 'fast',
  },
  models: {},
  unpricedModels: {},
  billableTools: {},
};

describe('OpenAI pricing client', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-06-18T12:00:00.000Z'));
    resetOpenAiPricingCacheForTest();
    readFileMock.mockReset();
    writeFileMock.mockReset();
    mkdirMock.mockReset();
    requestPublicJsonMock.mockReset();
    mkdirMock.mockResolvedValue(undefined);
    writeFileMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('fetches and caches from network when no cache exists', async () => {
    readFileMock.mockRejectedValue(new Error('missing'));
    requestPublicJsonMock.mockResolvedValue(payload);

    const state = await getOpenAiPricingForCosting();

    expect(state.loadedFrom).toBe('network');
    expect(state.stale).toBe(false);
    expect(writeFileMock).toHaveBeenCalled();
    expect(getOpenAiPricingForCostingSync().loadedFrom).toBe('memory');
  });

  it('returns fresh disk cache without network', async () => {
    readFileMock.mockResolvedValue(
      JSON.stringify({
        payload,
        fetchedAt: '2026-06-18T11:30:00.000Z',
      }),
    );

    const state = await getOpenAiPricingForCosting();

    expect(state.loadedFrom).toBe('disk');
    expect(state.stale).toBe(false);
    expect(requestPublicJsonMock).not.toHaveBeenCalled();
  });

  it('returns stale disk cache and refreshes in the background', async () => {
    readFileMock.mockResolvedValue(
      JSON.stringify({
        payload,
        fetchedAt: '2026-06-18T10:00:00.000Z',
      }),
    );
    requestPublicJsonMock.mockRejectedValue(new Error('offline'));

    const state = await getOpenAiPricingForCosting();

    expect(state.loadedFrom).toBe('disk');
    expect(state.stale).toBe(true);
    expect(requestPublicJsonMock).toHaveBeenCalled();
  });

  it('returns none when network fails and no cache exists', async () => {
    readFileMock.mockRejectedValue(new Error('missing'));
    requestPublicJsonMock.mockRejectedValue(new Error('offline'));

    const state = await getOpenAiPricingForCosting();

    expect(state).toEqual({ loadedFrom: 'none', stale: true });
  });

  it('rejects invalid network payloads and does not cache them', async () => {
    readFileMock.mockRejectedValue(new Error('missing'));
    requestPublicJsonMock.mockResolvedValue({ version: 1 });

    const state = await getOpenAiPricingForCosting();

    expect(state.loadedFrom).toBe('none');
    expect(writeFileMock).not.toHaveBeenCalled();
  });
});
