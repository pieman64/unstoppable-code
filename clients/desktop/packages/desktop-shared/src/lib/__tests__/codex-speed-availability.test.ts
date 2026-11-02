import type {
  CodexSpeedCatalog,
  CodexSpeedCatalogModel,
  CodexSpeedRouteCatalog,
} from '../../types/codex-speed-capabilities';
import {
  classifyCodexSpeedRejection,
  compareCodexSpeedCatalogOrder,
  createUnknownCodexSpeedCatalog,
  deriveCodexSpeedAvailability,
  deriveCodexSpeedOptions,
  describeCodexSpeedAvailability,
  isCodexSpeedCatalog,
  isDefinitiveCodexSpeedRejection,
  matchCodexSpeedCatalogModel,
  normalizeCodexServiceTierId,
  parseCodexSpeedCatalogModel,
  parseCodexSpeedCatalogWireModel,
  readCodexModelSpeedTiers,
  shouldAcceptCodexSpeedCatalog,
  type CodexSpeedRouteFacts,
} from '../codex-speed-availability';
import {
  isCodexSpeedReadRouteRequest,
  isCodexSpeedRouteFacts,
} from '../codex-speed-route';

describe('portable Codex route boundary', () => {
  const facts: CodexSpeedRouteFacts = {
    modelSelection: 'explicit',
    runtimeModel: 'future-codex-model',
    modelSource: 'codex-managed',
    harness: 'codex',
    routeProfile: 'codex-native',
  };

  it.each([
    { context: { kind: 'defaults' }, model: 'future-codex-model' },
    { context: { kind: 'home', projectId: 'workspace' }, model: null },
    {
      context: {
        kind: 'home',
        billingFramework: 'subscription',
        executionHarness: 'codex',
      },
    },
    {
      context: {
        kind: 'home',
        billingFramework: 'ai-credits',
        executionHarness: 'cursor',
      },
    },
    {
      context: {
        kind: 'chat',
        projectId: 'workspace',
        worktreeId: 'entry',
        chatId: 'chat',
      },
      modelSelection: 'auto',
    },
  ])('accepts portable request %j', (request) => {
    expect(isCodexSpeedReadRouteRequest(request)).toBe(true);
  });

  it.each([
    null,
    { context: { kind: 'chat', projectId: 'workspace' } },
    { context: { kind: 'home', projectId: '../workspace' } },
    { context: { kind: 'home', billingFramework: 'unknown' } },
    { context: { kind: 'home', executionHarness: 'unknown' } },
    {
      context: {
        kind: 'chat',
        projectId: 'workspace',
        worktreeId: 'entry',
        chatId: 'chat',
        billingFramework: 'subscription',
      },
    },
    { context: { kind: 'defaults', path: '/tmp/profile' } },
    { context: { kind: 'defaults' }, routeProfile: 'codex-native' },
    { context: { kind: 'defaults' }, model: 1 },
    { context: { kind: 'defaults' }, modelSelection: 'automatic' },
    { context: new Date(0) },
  ])('rejects malformed or host-shaped request %j', (request) => {
    expect(isCodexSpeedReadRouteRequest(request)).toBe(false);
  });

  it('accepts sanitized route facts including unresolved facts', () => {
    expect(isCodexSpeedRouteFacts(facts)).toBe(true);
    expect(
      isCodexSpeedRouteFacts({
        ...facts,
        runtimeModel: null,
        modelSource: null,
        harness: null,
        routeProfile: 'unknown',
      }),
    ).toBe(true);
  });

  it('accepts the account proxy route profile', () => {
    expect(
      isCodexSpeedRouteFacts({ ...facts, routeProfile: 'account-proxy' }),
    ).toBe(true);
  });

  it.each([
    { ...facts, routeProfile: 'custom' },
    { ...facts, accountId: 'private-account' },
    { ...facts, harness: 'ssh' },
    { ...facts, modelSource: 'custom' },
    { ...facts, equivalentModels: [1] },
  ])('rejects malformed or unportable route facts %j', (value) => {
    expect(isCodexSpeedRouteFacts(value)).toBe(false);
  });
});

const NOW = Date.parse('2026-09-30T12:00:00Z');

function model(
  id: string,
  tiers: string[] | null,
  overrides: Partial<CodexSpeedCatalogModel> = {},
): CodexSpeedCatalogModel {
  return {
    id,
    model: id,
    tiers,
    source: tiers === null ? 'unknown' : 'serviceTiers',
    ...overrides,
  };
}

function catalog(
  models: CodexSpeedCatalogModel[],
  overrides: Partial<CodexSpeedCatalog> = {},
): CodexSpeedCatalog {
  return {
    generation: 3,
    status: 'ready',
    fetchedAt: NOW,
    expiresAt: NOW + 300_000,
    truncated: false,
    models,
    denials: [],
    ...overrides,
  };
}

function proxyCatalog(
  models: CodexSpeedCatalogModel[],
  overrides: Partial<CodexSpeedRouteCatalog> = {},
): CodexSpeedRouteCatalog {
  return {
    revision: 1,
    status: 'ready',
    fetchedAt: NOW,
    expiresAt: NOW + 300_000,
    truncated: false,
    models,
    ...overrides,
  };
}

/** A runtime catalog plus the account proxy's own list. */
function withProxy(
  runtime: CodexSpeedCatalogModel[],
  proxy: CodexSpeedRouteCatalog | undefined,
  overrides: Partial<CodexSpeedCatalog> = {},
): CodexSpeedCatalog {
  return catalog(runtime, {
    ...(proxy ? { routes: { 'account-proxy': proxy } } : {}),
    ...overrides,
  });
}

function route(
  overrides: Partial<CodexSpeedRouteFacts> = {},
): CodexSpeedRouteFacts {
  return {
    modelSelection: 'explicit',
    runtimeModel: 'gpt-6-astra',
    modelSource: 'codex-managed',
    harness: 'codex',
    routeProfile: 'codex-native',
    ...overrides,
  };
}

function ultra(input: {
  catalog: CodexSpeedCatalog | null;
  route?: CodexSpeedRouteFacts;
}): { status: string; reason: string } {
  const result = deriveCodexSpeedAvailability({
    catalog: input.catalog,
    route: input.route ?? route(),
    speed: 'ultrafast',
    now: NOW,
  });
  return { status: result.status, reason: result.reason };
}

describe('native tier parsing', () => {
  it('normalizes known tier IDs and ignores unknown ones', () => {
    expect(normalizeCodexServiceTierId('priority')).toBe('priority');
    expect(normalizeCodexServiceTierId('fast')).toBe('priority');
    expect(normalizeCodexServiceTierId('ultrafast')).toBe('ultrafast');
    expect(normalizeCodexServiceTierId('flex')).toBeNull();
    expect(normalizeCodexServiceTierId(7)).toBeNull();
  });

  it('treats serviceTiers as authoritative even when empty', () => {
    expect(
      readCodexModelSpeedTiers({
        serviceTiers: [],
        additionalSpeedTiers: ['fast', 'ultrafast'],
      }),
    ).toEqual({ tiers: [], source: 'serviceTiers' });
    expect(
      readCodexModelSpeedTiers({
        serviceTiers: [
          { id: 'priority', name: 'Fast', description: '' },
          { id: 'ultrafast', name: 'Ultra fast', description: '' },
          { id: 'fast', name: 'Fast', description: '' },
          { id: 'mystery', name: '?', description: '' },
        ],
      }),
    ).toEqual({ tiers: ['priority', 'ultrafast'], source: 'serviceTiers' });
  });

  it('uses additionalSpeedTiers only when the modern field is missing', () => {
    expect(
      readCodexModelSpeedTiers({ additionalSpeedTiers: ['fast'] }),
    ).toEqual({ tiers: ['priority'], source: 'additionalSpeedTiers' });
    expect(readCodexModelSpeedTiers({})).toEqual({
      tiers: null,
      source: 'unknown',
    });
  });

  it('parses the Codex /models wire shape a proxy serves', () => {
    expect(
      parseCodexSpeedCatalogWireModel({
        slug: 'gpt-6-astra',
        display_name: 'GPT 6 Astra',
        service_tiers: [
          { id: 'priority', name: 'Fast', description: '' },
          { id: 'ultrafast', name: 'Ultra fast', description: '' },
        ],
        base_instructions: 'long text',
      }),
    ).toEqual({
      id: 'gpt-6-astra',
      model: 'gpt-6-astra',
      tiers: ['priority', 'ultrafast'],
      source: 'serviceTiers',
    });
    expect(
      parseCodexSpeedCatalogWireModel({ slug: 'claude-x', service_tiers: [] }),
    ).toMatchObject({ tiers: [], source: 'serviceTiers' });
    expect(
      parseCodexSpeedCatalogWireModel({
        slug: 'old',
        additional_speed_tiers: ['fast'],
      }),
    ).toMatchObject({ tiers: ['priority'], source: 'additionalSpeedTiers' });
    expect(parseCodexSpeedCatalogWireModel({ slug: 'bare' })).toMatchObject({
      tiers: null,
      source: 'unknown',
    });
    expect(parseCodexSpeedCatalogWireModel({ id: 'no-slug' })).toBeNull();
  });

  it('parses the bundled 0.159 catalog shape, keeping only sanitized fields', () => {
    expect(
      parseCodexSpeedCatalogModel({
        id: 'gpt-6-astra',
        model: 'gpt-6-astra',
        displayName: 'GPT-6 Astra',
        serviceTiers: [{ id: 'priority', name: 'Fast', description: '2x' }],
        additionalSpeedTiers: ['fast'],
        defaultServiceTier: null,
        availableAccessPrograms: null,
      }),
    ).toEqual({
      id: 'gpt-6-astra',
      model: 'gpt-6-astra',
      tiers: ['priority'],
      source: 'serviceTiers',
      displayName: 'GPT-6 Astra',
    });
    expect(parseCodexSpeedCatalogModel({ model: 'only-model' })).toEqual({
      id: 'only-model',
      model: 'only-model',
      tiers: null,
      source: 'unknown',
    });
    expect(parseCodexSpeedCatalogModel({ displayName: 'x' })).toBeNull();
  });

  it('reads account model metadata from strings and objects (CAN-4716)', () => {
    expect(
      parseCodexSpeedCatalogModel({
        id: 'gpt-6-luna',
        model: 'gpt-6-luna',
        displayName: ' Luna 6.0 ',
        hidden: false,
        isDefault: true,
        supportedReasoningEfforts: [
          { reasoningEffort: 'low', description: 'Fast' },
          'medium',
          'medium',
          { reasoningEffort: 7 },
          null,
          '',
          'high',
        ],
      }),
    ).toEqual({
      id: 'gpt-6-luna',
      model: 'gpt-6-luna',
      tiers: null,
      source: 'unknown',
      displayName: 'Luna 6.0',
      hidden: false,
      isDefault: true,
      reasoningEfforts: ['low', 'medium', 'high'],
    });
  });

  it('ignores malformed account metadata without dropping the model', () => {
    expect(
      parseCodexSpeedCatalogModel({
        id: 'gpt-6-luna',
        displayName: '   ',
        hidden: 'yes',
        isDefault: 1,
        supportedReasoningEfforts: 'high',
      }),
    ).toEqual({
      id: 'gpt-6-luna',
      model: 'gpt-6-luna',
      tiers: null,
      source: 'unknown',
    });
    expect(
      parseCodexSpeedCatalogModel({
        id: 'gpt-6-luna',
        supportedReasoningEfforts: [{}, 5],
      }),
    ).not.toHaveProperty('reasoningEfforts');
  });

  it.each([null, 'malformed', 7, {}])(
    'keeps malformed modern metadata %j unknown despite a legacy Ultra tier',
    (serviceTiers) => {
      const parsed = parseCodexSpeedCatalogModel({
        id: 'future-model',
        serviceTiers,
        additionalSpeedTiers: ['ultrafast'],
      });
      if (!parsed) throw new Error('Expected a model descriptor');
      expect(parsed.tiers).toBeNull();
      expect(
        ultra({
          catalog: catalog([parsed]),
          route: route({ runtimeModel: 'future-model' }),
        }),
      ).toEqual({ status: 'unknown', reason: 'tiers-unknown' });
    },
  );
});

describe('deriveCodexSpeedAvailability', () => {
  it('never gates Regular or Fast, even without metadata or on other routes', () => {
    for (const speed of ['standard', 'fast'] as const) {
      for (const facts of [
        route(),
        route({ routeProfile: 'ai-credits', modelSource: 'ai-gateway' }),
        route({ modelSelection: 'auto', runtimeModel: null }),
      ]) {
        expect(
          deriveCodexSpeedAvailability({
            catalog: null,
            route: facts,
            speed,
            now: NOW,
          }),
        ).toEqual({
          speed,
          status: 'available',
          reason: 'not-gated',
          generation: null,
        });
      }
    }
    const options = deriveCodexSpeedOptions({
      catalog: catalog([model('gpt-6-astra', [])]),
      route: route(),
      now: NOW,
    });
    expect(options.fast.status).toBe('available');
    expect(options.standard.status).toBe('available');
    expect(options.ultrafast.status).toBe('unavailable');
  });

  it('makes any advertised model eligible without name or plan inference', () => {
    const future = catalog([
      model('some-future-model', ['ultrafast']),
      model('gpt-6-astra', ['priority']),
    ]);
    expect(
      ultra({
        catalog: future,
        route: route({ runtimeModel: 'some-future-model' }),
      }),
    ).toEqual({ status: 'available', reason: 'advertised' });
    // A well-known model name does not imply eligibility.
    expect(ultra({ catalog: future })).toEqual({
      status: 'unavailable',
      reason: 'not-advertised',
    });
  });

  it('distinguishes unknown metadata from an authoritative list without Ultra fast', () => {
    expect(ultra({ catalog: catalog([model('gpt-6-astra', null)]) })).toEqual({
      status: 'unknown',
      reason: 'tiers-unknown',
    });
    expect(ultra({ catalog: catalog([model('gpt-6-astra', [])]) })).toEqual({
      status: 'unavailable',
      reason: 'not-advertised',
    });
    expect(ultra({ catalog: null })).toEqual({
      status: 'unknown',
      reason: 'catalog-unknown',
    });
    expect(ultra({ catalog: createUnknownCodexSpeedCatalog(4) })).toEqual({
      status: 'unknown',
      reason: 'catalog-unknown',
    });
  });

  it('matches the catalog model field before the id', () => {
    const entries = catalog([
      model('alias-entry', ['ultrafast'], { model: 'gpt-6-astra' }),
      model('gpt-6-astra', [], { model: 'something-else' }),
    ]);
    expect(ultra({ catalog: entries })).toEqual({
      status: 'available',
      reason: 'advertised',
    });
    expect(
      matchCodexSpeedCatalogModel(entries, ['something-else']),
    ).toMatchObject({ kind: 'match', model: { id: 'gpt-6-astra' } });
  });

  it('tries equivalent alias/base identities after the runtime model', () => {
    const entries = catalog([model('base-model', ['ultrafast'])]);
    expect(
      ultra({
        catalog: entries,
        route: route({
          runtimeModel: 'alias-model',
          equivalentModels: ['base-model'],
        }),
      }),
    ).toEqual({ status: 'available', reason: 'advertised' });
  });

  it('treats conflicting matches and truncated omissions as unknown', () => {
    expect(
      ultra({
        catalog: catalog([
          model('a', ['ultrafast'], { model: 'gpt-6-astra' }),
          model('b', ['priority'], { model: 'gpt-6-astra' }),
        ]),
      }),
    ).toEqual({ status: 'unknown', reason: 'model-ambiguous' });
    expect(
      ultra({
        catalog: catalog([
          model('a', ['ultrafast', 'priority'], { model: 'gpt-6-astra' }),
          model('b', ['priority', 'ultrafast'], { model: 'gpt-6-astra' }),
        ]),
      }),
    ).toEqual({ status: 'available', reason: 'advertised' });
    expect(
      ultra({
        catalog: catalog([model('other', ['ultrafast'])], { truncated: true }),
      }),
    ).toEqual({ status: 'unknown', reason: 'catalog-truncated' });
    expect(
      ultra({ catalog: catalog([model('other', ['ultrafast'])]) }),
    ).toEqual({ status: 'unavailable', reason: 'model-unlisted' });
  });

  it('requires the native Codex route and an explicit model', () => {
    const advertised = catalog([model('gpt-6-astra', ['ultrafast'])]);
    for (const facts of [
      route({ routeProfile: 'ai-credits' }),
      route({ routeProfile: 'org-gateway' }),
      route({ routeProfile: 'foreign' }),
      route({ modelSource: 'ai-gateway', routeProfile: 'ai-credits' }),
      route({ modelSource: 'ollama', routeProfile: 'ollama' }),
      route({
        modelSource: 'cursor-managed',
        harness: 'cursor',
        routeProfile: 'cursor',
      }),
      route({ harness: 'claude' }),
    ]) {
      expect(ultra({ catalog: advertised, route: facts })).toEqual({
        status: 'unavailable',
        reason: 'route-not-native',
      });
    }
    expect(
      ultra({ catalog: advertised, route: route({ routeProfile: 'unknown' }) }),
    ).toEqual({ status: 'unknown', reason: 'route-unknown' });
    expect(
      ultra({ catalog: advertised, route: route({ modelSelection: 'auto' }) }),
    ).toEqual({ status: 'unavailable', reason: 'auto-model' });
    expect(
      ultra({ catalog: advertised, route: route({ runtimeModel: null }) }),
    ).toEqual({ status: 'unavailable', reason: 'no-model' });
  });

  it('admits Ultra fast through the account proxy only when both catalogs advertise it', () => {
    const proxy = route({ routeProfile: 'account-proxy' });
    const ultrafast = [model('gpt-6-astra', ['priority', 'ultrafast'])];
    const fastOnly = [model('gpt-6-astra', ['priority'])];
    expect(
      ultra({
        catalog: withProxy(ultrafast, proxyCatalog(ultrafast)),
        route: proxy,
      }),
    ).toEqual({ status: 'available', reason: 'advertised' });
    // The proxy's accounts do not offer it, though the runtime catalog does.
    expect(
      ultra({
        catalog: withProxy(ultrafast, proxyCatalog(fastOnly)),
        route: proxy,
      }),
    ).toEqual({ status: 'unavailable', reason: 'not-advertised' });
    expect(
      ultra({
        catalog: withProxy(
          ultrafast,
          proxyCatalog([model('other', ['ultrafast'])]),
        ),
        route: proxy,
      }),
    ).toEqual({ status: 'unavailable', reason: 'model-unlisted' });
    // The proxy offers it, but Codex would drop a tier its runtime catalog
    // does not list for the model.
    expect(
      ultra({
        catalog: withProxy(fastOnly, proxyCatalog(ultrafast)),
        route: proxy,
      }),
    ).toEqual({ status: 'unavailable', reason: 'not-advertised' });
    // The same catalogs answer the native route from the runtime list alone.
    expect(
      ultra({ catalog: withProxy(ultrafast, proxyCatalog(fastOnly)) }),
    ).toEqual({ status: 'available', reason: 'advertised' });
    expect(
      ultra({
        catalog: withProxy(ultrafast, proxyCatalog(ultrafast)),
        route: route({ routeProfile: 'account-proxy', modelSelection: 'auto' }),
      }),
    ).toEqual({ status: 'unavailable', reason: 'auto-model' });
  });

  it('fails closed on the account proxy route without its own catalog', () => {
    const proxy = route({ routeProfile: 'account-proxy' });
    const ultrafast = [model('gpt-6-astra', ['ultrafast'])];
    for (const proxyList of [
      undefined,
      proxyCatalog([], { status: 'unknown', error: 'failed' }),
      proxyCatalog([model('gpt-6-astra', null)]),
      proxyCatalog([model('other', ['ultrafast'])], { truncated: true }),
    ]) {
      expect(
        ultra({ catalog: withProxy(ultrafast, proxyList), route: proxy })
          .status,
      ).toBe('unknown');
    }
    expect(ultra({ catalog: null, route: proxy })).toEqual({
      status: 'unknown',
      reason: 'catalog-unknown',
    });
    expect(
      deriveCodexSpeedAvailability({
        catalog: withProxy(ultrafast, undefined),
        route: proxy,
        speed: 'fast',
        now: NOW,
      }).status,
    ).toBe('available');
  });

  it('keeps account proxy and native sign-in denials apart', () => {
    const advertised = [model('gpt-6-astra', ['ultrafast'])];
    const proxyDenied = withProxy(advertised, proxyCatalog(advertised), {
      denials: [
        { model: 'gpt-6-astra', expiresAt: NOW + 1, route: 'account-proxy' },
      ],
    });
    const nativeDenied = withProxy(advertised, proxyCatalog(advertised), {
      denials: [{ model: 'gpt-6-astra', expiresAt: NOW + 1 }],
    });
    const proxy = route({ routeProfile: 'account-proxy' });
    expect(ultra({ catalog: proxyDenied, route: proxy })).toEqual({
      status: 'unavailable',
      reason: 'denied',
    });
    expect(ultra({ catalog: proxyDenied })).toEqual({
      status: 'available',
      reason: 'advertised',
    });
    expect(ultra({ catalog: nativeDenied, route: proxy })).toEqual({
      status: 'available',
      reason: 'advertised',
    });
  });

  it('honors unexpired denials only', () => {
    const denied = catalog([model('gpt-6-astra', ['ultrafast'])], {
      denials: [{ model: 'gpt-6-astra', expiresAt: NOW + 1 }],
    });
    expect(ultra({ catalog: denied })).toEqual({
      status: 'unavailable',
      reason: 'denied',
    });
    expect(
      deriveCodexSpeedAvailability({
        catalog: denied,
        route: route(),
        speed: 'ultrafast',
        now: NOW + 1,
      }).status,
    ).toBe('available');
  });

  it('describes every unavailable state with an alternative', () => {
    const reasons = [
      route({ routeProfile: 'ai-credits' }),
      route({ modelSelection: 'auto' }),
      route({ routeProfile: 'unknown' }),
    ].map((facts) =>
      describeCodexSpeedAvailability(
        deriveCodexSpeedAvailability({
          catalog: null,
          route: facts,
          speed: 'ultrafast',
          now: NOW,
        }),
      ),
    );
    for (const message of reasons) {
      expect(message).toMatch(/Regular or Fast/);
    }
    expect(
      describeCodexSpeedAvailability(
        deriveCodexSpeedAvailability({
          catalog: null,
          route: route(),
          speed: 'fast',
          now: NOW,
        }),
      ),
    ).toBeNull();
  });
});

describe('catalog transport helpers', () => {
  it('validates the sanitized catalog shape', () => {
    const valid = catalog([model('gpt-6-astra', ['priority'])], {
      denials: [{ model: 'gpt-6-astra', expiresAt: NOW }],
      error: "Couldn't check Codex speed availability. Try again.",
    });
    expect(isCodexSpeedCatalog(valid)).toBe(true);
    expect(isCodexSpeedCatalog(createUnknownCodexSpeedCatalog())).toBe(true);
    const withMetadata = catalog([
      {
        ...model('gpt-6-luna', null),
        displayName: 'Luna 6.0',
        hidden: false,
        isDefault: true,
        reasoningEfforts: ['low', 'high'],
      },
    ]);
    expect(isCodexSpeedCatalog(withMetadata)).toBe(true);
    for (const malformed of [
      { displayName: '' },
      { hidden: 'no' },
      { isDefault: 1 },
      { reasoningEfforts: 'high' },
      { reasoningEfforts: [3] },
    ]) {
      expect(
        isCodexSpeedCatalog({
          ...withMetadata,
          models: [{ ...model('gpt-6-luna', null), ...malformed }],
        }),
      ).toBe(false);
    }
    expect(isCodexSpeedCatalog({ ...valid, generation: -1 })).toBe(false);
    expect(isCodexSpeedCatalog({ ...valid, status: 'maybe' })).toBe(false);
    expect(
      isCodexSpeedCatalog({
        ...valid,
        models: [{ id: 'x', model: 'x', tiers: [1], source: 'serviceTiers' }],
      }),
    ).toBe(false);
    expect(
      isCodexSpeedCatalog({
        ...valid,
        denials: [
          { model: 'gpt-6-astra', expiresAt: NOW, route: 'account-proxy' },
        ],
      }),
    ).toBe(true);
    expect(
      isCodexSpeedCatalog({
        ...valid,
        denials: [{ model: 'gpt-6-astra', expiresAt: NOW, route: 'foreign' }],
      }),
    ).toBe(false);
    expect(
      isCodexSpeedCatalog({
        ...valid,
        routes: {
          'account-proxy': proxyCatalog([model('gpt-6-astra', ['ultrafast'])]),
        },
      }),
    ).toBe(true);
    expect(isCodexSpeedCatalog({ ...valid, routes: {} })).toBe(true);
    expect(
      isCodexSpeedCatalog({ ...valid, routes: { foreign: proxyCatalog([]) } }),
    ).toBe(false);
    expect(
      isCodexSpeedCatalog({
        ...valid,
        routes: { 'account-proxy': { ...proxyCatalog([]), status: 'maybe' } },
      }),
    ).toBe(false);
    expect(
      isCodexSpeedCatalog({
        ...valid,
        routes: { 'account-proxy': { ...proxyCatalog([]), revision: -1 } },
      }),
    ).toBe(false);
    expect(isCodexSpeedCatalog({ ...valid, error: 5 })).toBe(false);
    expect(isCodexSpeedCatalog(null)).toBe(false);
  });

  it('orders equal runtime catalogs by the account proxy list revision', () => {
    const without = catalog([]);
    const older = withProxy(
      [],
      proxyCatalog([model('gpt-6-astra', ['ultrafast'])], { revision: 3 }),
    );
    // A failed revalidation clears the list, so its fetchedAt goes back to
    // null, yet it is the newer snapshot.
    const cleared = withProxy(
      [],
      proxyCatalog([], { revision: 4, status: 'unknown', fetchedAt: null }),
    );
    expect(compareCodexSpeedCatalogOrder(without, older)).toBeLessThan(0);
    expect(shouldAcceptCodexSpeedCatalog(older, cleared)).toBe(true);
    expect(shouldAcceptCodexSpeedCatalog(cleared, older)).toBe(false);
    expect(shouldAcceptCodexSpeedCatalog(cleared, without)).toBe(false);
  });

  it('orders catalogs by generation, then fetchedAt', () => {
    const older = catalog([], { generation: 2, fetchedAt: NOW + 10 });
    const reset = catalog([], { generation: 3, fetchedAt: null });
    const fetched = catalog([], { generation: 3, fetchedAt: NOW });
    expect(compareCodexSpeedCatalogOrder(older, reset)).toBeLessThan(0);
    expect(compareCodexSpeedCatalogOrder(reset, fetched)).toBeLessThan(0);
    expect(shouldAcceptCodexSpeedCatalog(null, older)).toBe(true);
    expect(shouldAcceptCodexSpeedCatalog(fetched, older)).toBe(false);
    expect(shouldAcceptCodexSpeedCatalog(fetched, reset)).toBe(false);
    expect(shouldAcceptCodexSpeedCatalog(older, reset)).toBe(true);
    expect(shouldAcceptCodexSpeedCatalog(fetched, { ...fetched })).toBe(true);
  });

  it('classifies rejections conservatively', () => {
    expect(
      classifyCodexSpeedRejection({
        codexErrorInfo: 'badRequest',
        message: 'The requested service tier is not available for this model.',
      }),
    ).toBe('tier');
    expect(
      classifyCodexSpeedRejection({
        codexErrorInfo: 'badRequest',
        message: 'Invalid tool schema.',
      }),
    ).toBe('unknown');
    expect(
      classifyCodexSpeedRejection({ codexErrorInfo: 'unauthorized' }),
    ).toBe('auth');
    expect(
      classifyCodexSpeedRejection({ codexErrorInfo: 'usageLimitExceeded' }),
    ).toBe('rate-limit');
    expect(
      classifyCodexSpeedRejection({ codexErrorInfo: 'serverOverloaded' }),
    ).toBe('capacity');
    expect(
      classifyCodexSpeedRejection({
        codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 502 } },
      }),
    ).toBe('network');
    expect(classifyCodexSpeedRejection('boom')).toBe('unknown');
    expect(isDefinitiveCodexSpeedRejection('tier')).toBe(true);
    for (const kind of [
      'auth',
      'network',
      'rate-limit',
      'capacity',
      'unknown',
    ] as const) {
      expect(isDefinitiveCodexSpeedRejection(kind)).toBe(false);
    }
  });
});
