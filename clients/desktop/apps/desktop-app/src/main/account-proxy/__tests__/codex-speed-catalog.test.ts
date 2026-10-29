import type { AccountProxyRouteTarget } from '../service';
import type { CodexSpeedRouteCatalogSource } from '../../model-routing/codex-account-models';

let target: AccountProxyRouteTarget | null = null;
const serving = new AbortController();
jest.mock('../service', () => ({
  getAccountProxyRouteTarget: jest.fn(() => Promise.resolve(target)),
  accountProxyServingSignal: (): AbortSignal => serving.signal,
  accountProxySettingsSignature: (): string =>
    'account-proxy:connection-1:on:keep',
}));
const mockSetSource = jest.fn<
  void,
  [string, CodexSpeedRouteCatalogSource | null]
>();
jest.mock('../../model-routing/codex-account-models', () => ({
  setCodexSpeedRouteCatalogSource: (
    route: string,
    source: CodexSpeedRouteCatalogSource | null,
  ): void => mockSetSource(route, source),
}));

import { getAccountProxyRouteTarget } from '../service';
import {
  fetchAccountProxyCodexCatalog,
  parseAccountProxyCodexCatalog,
  registerAccountProxyCodexSpeedCatalog,
} from '../codex-speed-catalog';

const TIER = (id: string): Record<string, string> => ({
  id,
  name: id,
  description: id,
});

/** Trimmed from CLIProxyAPI 8.0.28 `GET /v1/models?client_version=`. */
const CPA_CATALOG = {
  models: [
    {
      slug: 'gpt-6-astra',
      display_name: 'GPT 6 Astra',
      base_instructions: 'You are Codex.',
      service_tiers: [TIER('priority'), TIER('ultrafast')],
      prefer_websockets: true,
    },
    {
      slug: 'gpt-6-luna',
      display_name: 'GPT 6 Luna',
      service_tiers: [TIER('priority')],
    },
    // A model a non-Codex account also serves has its tiers cleared.
    { slug: 'claude-sonnet-4-6', service_tiers: [], prefer_websockets: false },
  ],
};

let fetchMock: jest.SpiedFunction<typeof fetch>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  target = {
    connection: {
      id: 'connection-1',
      kind: 'server',
      url: 'https://proxy.example.com',
    },
    clientKey: 'canopy-device-key',
    keepChatOnOneAccount: true,
    readyAccounts: 1,
    noUsableAccounts: null,
  };
  fetchMock = jest
    .spyOn(global, 'fetch')
    .mockImplementation(() => Promise.resolve(json(CPA_CATALOG)));
});

afterEach(() => {
  fetchMock.mockRestore();
});

describe('fetchAccountProxyCodexCatalog', () => {
  it("reads the proxy's Codex catalog with this device's client key", async () => {
    const result = await fetchAccountProxyCodexCatalog();

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toEqual(
      new URL('https://proxy.example.com/v1/models?client_version=2.0.0'),
    );
    expect(init?.headers).toMatchObject({
      authorization: 'Bearer canopy-device-key',
    });
    expect(init?.redirect).toBe('error');
    expect(getAccountProxyRouteTarget).toHaveBeenCalledWith('codex');
    expect(result).toEqual({
      truncated: false,
      models: [
        {
          id: 'gpt-6-astra',
          model: 'gpt-6-astra',
          tiers: ['priority', 'ultrafast'],
          source: 'serviceTiers',
        },
        {
          id: 'gpt-6-luna',
          model: 'gpt-6-luna',
          tiers: ['priority'],
          source: 'serviceTiers',
        },
        {
          id: 'claude-sonnet-4-6',
          model: 'claude-sonnet-4-6',
          tiers: [],
          source: 'serviceTiers',
        },
      ],
    });
  });

  it('uses the open-server token for a server without client keys', async () => {
    target = target ? { ...target, clientKey: null } : null;
    await fetchAccountProxyCodexCatalog();
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: 'Bearer canopy-open-server',
    });
  });

  it('reads nothing when the proxy would not take Codex work', async () => {
    target = null;
    await expect(fetchAccountProxyCodexCatalog()).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['a refused request', (): Response => json({ error: 'no' }, 401)],
    [
      'a body that is not JSON',
      (): Response => new Response('<html>', { status: 200 }),
    ],
    ['a body without models', (): Response => json({ data: [] })],
  ])('rejects %s', async (_label, respond) => {
    fetchMock.mockResolvedValueOnce(respond());
    await expect(fetchAccountProxyCodexCatalog()).rejects.toThrow(
      'account proxy',
    );
  });
});

describe('parseAccountProxyCodexCatalog', () => {
  it('skips entries without a slug and keeps an empty list empty', () => {
    expect(
      parseAccountProxyCodexCatalog({
        models: [{ display_name: 'no slug' }, { slug: 'x' }],
      }).models,
    ).toEqual([{ id: 'x', model: 'x', tiers: null, source: 'unknown' }]);
    expect(parseAccountProxyCodexCatalog({ models: [] })).toEqual({
      models: [],
      truncated: false,
    });
  });
});

describe('registerAccountProxyCodexSpeedCatalog', () => {
  it("registers the proxy's catalog for the account proxy route", async () => {
    registerAccountProxyCodexSpeedCatalog();
    const [route, source] = mockSetSource.mock.calls[0] ?? [];
    expect(route).toBe('account-proxy');
    expect(source?.key()).toBe('account-proxy:connection-1:on:keep');
    const fetched = await source?.fetch();
    expect(fetched?.models.map((model) => model.model)).toContain(
      'gpt-6-astra',
    );
  });
});
