/**
 * Codex speed admission policy: trusted route classification, exact-speed
 * admission against the native catalog, metadata-only lifecycle tiers, Auto
 * rejection, and one-shot rejection reporting. The catalog module is real;
 * only the shared runtime's admin `model/list` is faked.
 */
const mockRequest = jest.fn();
jest.mock('../codex/runtime-service', () => ({
  getCodexRuntimeService: (): unknown => ({
    admin: (): unknown => ({
      request: mockRequest,
      onAccountUpdated: (): (() => void) => (): void => undefined,
    }),
  }),
  onCodexRuntimeServiceReplaced: (): (() => void) => (): void => undefined,
}));
jest.mock('../lib/e2e-mock-control-plane', () => ({
  fetchMockControlPlaneRecord: jest.fn(),
  getMockLlmOrigin: (): string | null => null,
}));

import { CodexSpeedUnsupportedError } from '@canopy/desktop-shared/lib/codex-speed';
import {
  getCodexSpeedCatalogSnapshot,
  resetCodexSpeedCatalogForTests,
  setCodexSpeedRouteCatalogSource,
  type CodexSpeedRouteCatalogFetch,
} from '../model-routing/codex-account-models';
import {
  admitCodexSpeed,
  assertAutoRoutingCodexSpeed,
  assertCodexTurnSpeedAdmitted,
  buildCodexSpeedRouteFacts,
  classifyCodexSpeedRouteProfile,
  codexLifecycleServiceTier,
  codexSpeedGatewayForOrigin,
  reportCodexSpeedTurnFailure,
  resolveAutoRoutingCodexSpeed,
  type CodexSpeedRouteEvidence,
} from '../codex/speed-policy';

function modelList(
  entries: Array<{ model: string; tiers: string[] }>,
): Record<string, unknown> {
  return {
    data: entries.map((entry) => ({
      id: entry.model,
      model: entry.model,
      serviceTiers: entry.tiers.map((id) => ({
        id,
        name: id,
        description: id,
      })),
    })),
    nextCursor: null,
  };
}

const NATIVE: CodexSpeedRouteEvidence = {
  modelSelection: 'explicit',
  selectedModel: 'gpt-5.5',
  runtimeModel: 'gpt-5.5',
  modelSource: 'codex-managed',
  harness: 'codex',
  providerType: 'codex',
  gateway: null,
  environment: {},
};

const ACCOUNT_PROXY: CodexSpeedRouteEvidence = {
  ...NATIVE,
  codexConfig: {
    model_provider: 'canopy_account_proxy',
    model_providers: {
      canopy_account_proxy: {
        name: 'Account proxy',
        base_url: 'http://127.0.0.1:4100/codex-gateway/route-1',
        wire_api: 'responses',
        requires_openai_auth: false,
      },
    },
  },
};

const mockProxyFetch = jest.fn<
  Promise<CodexSpeedRouteCatalogFetch | null>,
  []
>();

/** The account proxy's own list, as its catalog source reads it. */
function proxyList(
  entries: Array<{ model: string; tiers: string[] }>,
): CodexSpeedRouteCatalogFetch {
  return {
    truncated: false,
    models: entries.map((entry) => ({
      id: entry.model,
      model: entry.model,
      tiers: entry.tiers,
      source: 'serviceTiers',
    })),
  };
}

beforeEach(() => {
  resetCodexSpeedCatalogForTests();
  mockRequest.mockReset();
  mockProxyFetch.mockReset();
  setCodexSpeedRouteCatalogSource('account-proxy', {
    key: () => 'account-proxy:connection-1:on:keep',
    fetch: () => mockProxyFetch(),
  });
});

describe('classifyCodexSpeedRouteProfile', () => {
  it('treats the native Codex sign-in with no overrides as native', () => {
    expect(classifyCodexSpeedRouteProfile(NATIVE)).toBe('codex-native');
  });

  it.each([
    [{ gateway: 'ai-credits' as const }, 'ai-credits'],
    [{ gateway: 'org-gateway' as const }, 'org-gateway'],
    [{ providerType: 'ollama' }, 'ollama'],
    [{ modelSource: 'ollama' as const }, 'ollama'],
    [{ harness: 'cursor' as const, providerType: 'cursor' }, 'cursor'],
    [{ harness: 'claude' as const, providerType: 'claude' }, 'foreign'],
    [{ environment: { OPENAI_API_KEY: 'sk-user' } }, 'foreign'],
    [{ environment: { OPENAI_BASE_URL: 'https://proxy.test' } }, 'foreign'],
    [{ codexConfig: { model_provider: 'custom' } }, 'foreign'],
    [
      { codexConfig: { model_providers: { custom: { base_url: 'x' } } } },
      'foreign',
    ],
    [{ unresolvedRoute: true }, 'unknown'],
  ])('classifies %j as %s', (override, expected) => {
    expect(classifyCodexSpeedRouteProfile({ ...NATIVE, ...override })).toBe(
      expected,
    );
  });

  it('recognizes the account proxy provider block as the proxy route', () => {
    expect(classifyCodexSpeedRouteProfile(ACCOUNT_PROXY)).toBe('account-proxy');
    expect(
      classifyCodexSpeedRouteProfile({
        ...ACCOUNT_PROXY,
        codexConfig: { model_provider: 'canopy_account_proxy' },
      }),
    ).toBe('account-proxy');
  });

  it.each([
    [{ environment: { OPENAI_API_KEY: 'sk-user' } }, 'foreign'],
    [
      {
        codexConfig: {
          model_provider: 'canopy_account_proxy',
          model_providers: { custom: { base_url: 'x' } },
        },
      },
      'foreign',
    ],
    [{ gateway: 'ai-credits' as const }, 'ai-credits'],
  ])('classifies the proxy block with %j as %s', (override, expected) => {
    expect(
      classifyCodexSpeedRouteProfile({ ...ACCOUNT_PROXY, ...override }),
    ).toBe(expected);
  });

  it('ignores blank credential values and unrelated environment keys', () => {
    expect(
      classifyCodexSpeedRouteProfile({
        ...NATIVE,
        environment: { OPENAI_API_KEY: '  ', FOO: 'bar' },
      }),
    ).toBe('codex-native');
  });

  it('pairs the deterministic mock provider with its own mock catalog', () => {
    expect(
      classifyCodexSpeedRouteProfile({
        ...NATIVE,
        mockProvider: true,
        environment: { CANOPY_MOCK_API_KEY: 'mock' },
      }),
    ).toBe('codex-native');
  });
});

describe('buildCodexSpeedRouteFacts', () => {
  it('derives source from the selected model and keeps the runtime model', () => {
    expect(
      buildCodexSpeedRouteFacts({
        ...NATIVE,
        runtimeModel: 'gpt-5.5-runtime',
      }),
    ).toEqual(
      expect.objectContaining({
        modelSelection: 'explicit',
        runtimeModel: 'gpt-5.5-runtime',
        equivalentModels: ['gpt-5.5'],
        modelSource: 'codex-managed',
        harness: 'codex',
        routeProfile: 'codex-native',
      }),
    );
  });
});

describe('admitCodexSpeed', () => {
  it('admits Regular and Fast without reading the catalog', async () => {
    await expect(admitCodexSpeed('standard', NATIVE)).resolves.toEqual(
      expect.objectContaining({ speed: 'standard' }),
    );
    await expect(
      admitCodexSpeed('fast', { ...NATIVE, gateway: 'ai-credits' }),
    ).resolves.toEqual(expect.objectContaining({ speed: 'fast' }));
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('admits Ultra fast only when the native catalog advertises it for the actual model', async () => {
    mockRequest.mockResolvedValue(
      modelList([{ model: 'gpt-5.5', tiers: ['priority', 'ultrafast'] }]),
    );
    const admission = await admitCodexSpeed('ultrafast', NATIVE);
    expect(admission.speed).toBe('ultrafast');
    expect(admission.availability.status).toBe('available');
    expect(mockRequest).toHaveBeenCalledWith('model/list', expect.anything());
  });

  it('rejects Ultra fast when the model advertises only Fast', async () => {
    mockRequest.mockResolvedValue(
      modelList([{ model: 'gpt-5.5', tiers: ['priority'] }]),
    );
    await expect(admitCodexSpeed('ultrafast', NATIVE)).rejects.toBeInstanceOf(
      CodexSpeedUnsupportedError,
    );
  });

  it('admits Ultra fast through the account proxy when both catalogs advertise it', async () => {
    mockRequest.mockResolvedValue(
      modelList([{ model: 'gpt-5.5', tiers: ['priority', 'ultrafast'] }]),
    );
    mockProxyFetch.mockResolvedValue(
      proxyList([{ model: 'gpt-5.5', tiers: ['priority', 'ultrafast'] }]),
    );
    const admission = await admitCodexSpeed('ultrafast', ACCOUNT_PROXY);
    expect(admission.speed).toBe('ultrafast');
    expect(admission.availability.status).toBe('available');
    expect(admission.routeProfile).toBe('account-proxy');
  });

  it.each([
    ['the proxy', ['priority', 'ultrafast'], ['priority']],
    ['the runtime', ['priority'], ['priority', 'ultrafast']],
  ])(
    'rejects Ultra fast through the account proxy when %s does not advertise it',
    async (_side, runtime, proxy) => {
      mockRequest.mockResolvedValue(
        modelList([{ model: 'gpt-5.5', tiers: runtime }]),
      );
      mockProxyFetch.mockResolvedValue(
        proxyList([{ model: 'gpt-5.5', tiers: proxy }]),
      );
      await expect(
        admitCodexSpeed('ultrafast', ACCOUNT_PROXY),
      ).rejects.toBeInstanceOf(CodexSpeedUnsupportedError);
    },
  );

  it('fails closed on the account proxy when its catalog cannot be read', async () => {
    mockRequest.mockResolvedValue(
      modelList([{ model: 'gpt-5.5', tiers: ['priority', 'ultrafast'] }]),
    );
    mockProxyFetch.mockRejectedValue(new Error('unreachable'));
    await expect(
      admitCodexSpeed('ultrafast', ACCOUNT_PROXY),
    ).rejects.toBeInstanceOf(CodexSpeedUnsupportedError);
    await expect(admitCodexSpeed('fast', ACCOUNT_PROXY)).resolves.toEqual(
      expect.objectContaining({ speed: 'fast' }),
    );
  });

  it.each([
    [{ gateway: 'ai-credits' as const }],
    [{ environment: { OPENAI_API_KEY: 'sk-user' } }],
    [{ modelSelection: 'auto' as const }],
    [{ providerType: 'ollama' }],
  ])(
    'rejects Ultra fast on %j without consulting the native catalog',
    async (override) => {
      await expect(
        admitCodexSpeed('ultrafast', { ...NATIVE, ...override }),
      ).rejects.toBeInstanceOf(CodexSpeedUnsupportedError);
      expect(mockRequest).not.toHaveBeenCalled();
    },
  );
});

describe('codexLifecycleServiceTier', () => {
  it('keeps exact Regular/Fast tiers and uses an explicit default for unadmitted Ultra fast', () => {
    expect(codexLifecycleServiceTier({ speed: 'standard' })).toBe('default');
    expect(codexLifecycleServiceTier({ speed: 'fast' })).toBe('priority');
    expect(codexLifecycleServiceTier({ fastMode: true })).toBe('priority');
    expect(codexLifecycleServiceTier({ speed: 'ultrafast' })).toBe('default');
    expect(codexLifecycleServiceTier(undefined)).toBe('default');
  });
});

describe('assertCodexTurnSpeedAdmitted', () => {
  it('refuses only an unadmitted Ultra fast turn', () => {
    expect(() =>
      assertCodexTurnSpeedAdmitted({ speed: 'ultrafast' }, false),
    ).toThrow(CodexSpeedUnsupportedError);
    expect(() =>
      assertCodexTurnSpeedAdmitted({ speed: 'ultrafast' }, true),
    ).not.toThrow();
    expect(() =>
      assertCodexTurnSpeedAdmitted({ speed: 'fast', fastMode: true }, false),
    ).not.toThrow();
    expect(() =>
      assertCodexTurnSpeedAdmitted({ fastMode: true }, false),
    ).not.toThrow();
    expect(() => assertCodexTurnSpeedAdmitted(undefined, false)).not.toThrow();
  });
});

describe('codexSpeedGatewayForOrigin', () => {
  it('distinguishes organization gateways from AI Credits', () => {
    expect(codexSpeedGatewayForOrigin('org-gateway')).toBe('org-gateway');
    expect(codexSpeedGatewayForOrigin('ai-gateway')).toBe('ai-credits');
    expect(codexSpeedGatewayForOrigin(undefined)).toBe('ai-credits');
  });
});

describe('Auto routing speed', () => {
  it('reads the request, then the retained Codex speed, then the Codex default', () => {
    expect(
      resolveAutoRoutingCodexSpeed({
        requestModelConfig: { speed: 'fast', fastMode: true },
        tab: { providerType: 'codex', retainedCodexSpeed: 'ultrafast' },
        defaults: { codex: { speed: 'ultrafast' } },
      }),
    ).toBe('fast');
    expect(
      resolveAutoRoutingCodexSpeed({
        tab: { providerType: 'claude', retainedCodexSpeed: 'ultrafast' },
        defaults: {},
      }),
    ).toBe('ultrafast');
    expect(
      resolveAutoRoutingCodexSpeed({
        tab: { providerType: 'claude' },
        defaults: { codex: { speed: 'ultrafast', fastMode: false } },
      }),
    ).toBe('ultrafast');
    expect(
      resolveAutoRoutingCodexSpeed({
        requestCodexFastModeEnabled: false,
        tab: { providerType: 'codex' },
        defaults: { codex: { speed: 'ultrafast' } },
      }),
    ).toBe('standard');
  });

  it('rejects Auto with Ultra fast and never before an explicit model', () => {
    expect(() => assertAutoRoutingCodexSpeed('ultrafast')).toThrow(
      CodexSpeedUnsupportedError,
    );
    expect(() => assertAutoRoutingCodexSpeed('ultrafast')).toThrow(
      /specific model/,
    );
    expect(() => assertAutoRoutingCodexSpeed('fast')).not.toThrow();
    expect(() => assertAutoRoutingCodexSpeed('standard')).not.toThrow();
  });
});

describe('reportCodexSpeedTurnFailure', () => {
  async function admitted(): Promise<
    Awaited<ReturnType<typeof admitCodexSpeed>>
  > {
    mockRequest.mockResolvedValue(
      modelList([{ model: 'gpt-5.5', tiers: ['ultrafast'] }]),
    );
    return admitCodexSpeed('ultrafast', NATIVE);
  }

  it('records a temporary denial for a definitive tier rejection', async () => {
    const admission = await admitted();
    expect(
      reportCodexSpeedTurnFailure(admission, 'gpt-5.5', {
        codexErrorInfo: 'badRequest',
        message: 'The requested service_tier is not available',
      }),
    ).toBe(true);
    expect(getCodexSpeedCatalogSnapshot().denials).toEqual([
      expect.objectContaining({ model: 'gpt-5.5' }),
    ]);
  });

  it('keeps a proxy account refusal from hiding Ultra fast on the native sign-in', async () => {
    mockRequest.mockResolvedValue(
      modelList([{ model: 'gpt-5.5', tiers: ['ultrafast'] }]),
    );
    mockProxyFetch.mockResolvedValue(
      proxyList([{ model: 'gpt-5.5', tiers: ['ultrafast'] }]),
    );
    const proxied = await admitCodexSpeed('ultrafast', ACCOUNT_PROXY);
    expect(
      reportCodexSpeedTurnFailure(proxied, 'gpt-5.5', {
        codexErrorInfo: 'badRequest',
        message: 'The requested service_tier is not available',
      }),
    ).toBe(true);
    expect(getCodexSpeedCatalogSnapshot().denials).toEqual([
      expect.objectContaining({ model: 'gpt-5.5', route: 'account-proxy' }),
    ]);
    await expect(
      admitCodexSpeed('ultrafast', ACCOUNT_PROXY),
    ).rejects.toBeInstanceOf(CodexSpeedUnsupportedError);
    await expect(admitCodexSpeed('ultrafast', NATIVE)).resolves.toEqual(
      expect.objectContaining({ speed: 'ultrafast' }),
    );
  });

  it.each([
    [{ codexErrorInfo: 'unauthorized', message: 'no' }],
    [{ codexErrorInfo: 'rateLimitExceeded', message: 'slow down' }],
    [{ codexErrorInfo: 'serverOverloaded', message: 'busy' }],
    [{ message: 'something broke' }],
  ])('never records a denial for %j', async (failure) => {
    const admission = await admitted();
    expect(reportCodexSpeedTurnFailure(admission, 'gpt-5.5', failure)).toBe(
      false,
    );
    expect(getCodexSpeedCatalogSnapshot().denials).toEqual([]);
  });

  it('ignores failures without an Ultra fast admission', async () => {
    const regular = await admitCodexSpeed('standard', NATIVE);
    expect(
      reportCodexSpeedTurnFailure(regular, 'gpt-5.5', {
        codexErrorInfo: 'badRequest',
        message: 'service tier',
      }),
    ).toBe(false);
    expect(
      reportCodexSpeedTurnFailure(undefined, 'gpt-5.5', {
        codexErrorInfo: 'badRequest',
        message: 'service tier',
      }),
    ).toBe(false);
  });
});
