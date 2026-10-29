/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  CODEX_SPEED_CATALOG_TTL_MS,
  deriveCodexSpeedOptions,
  type CodexSpeedRouteFacts,
} from '@canopy/desktop-shared/lib/codex-speed-availability';
import type {
  CodexSpeedApi,
  CodexSpeedCatalog,
  CodexSpeedCatalogModel,
} from '@canopy/desktop-shared/types/codex-speed-capabilities';
import * as desktopTypes from '@canopy/desktop-shared/types';
import {
  initClaudeModels,
  initCodexModels,
} from '@canopy/desktop-shared/types';
import { resetCodexSpeedStoreForTests } from '../../stores/codexSpeedStore';
import {
  codexSpeedBlockedReason,
  codexSpeedChoiceStates,
  codexSpeedConnectionStates,
  codexSpeedDowngrade,
  codexSpeedRouteInput,
  resolveCodexSpeedRouteFacts,
  useCodexSpeedControl,
  type CodexSpeedControl,
  type CodexSpeedRouteInput,
  type CodexSpeedRouteRequest,
} from '../useCodexSpeedControl';

jest.mock('../../lib/renderer-error-logging', () => ({
  reportRendererConsoleError: jest.fn(),
}));

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Date.parse('2026-09-30T12:00:00.000Z');

/** A future, non-allowlisted model: eligibility comes only from the catalog. */
const FUTURE_MODEL = 'gpt-9-future';

const FAST_ONLY: CodexSpeedCatalogModel = {
  id: FUTURE_MODEL,
  model: FUTURE_MODEL,
  tiers: ['priority'],
  source: 'serviceTiers',
};

const WITH_ULTRAFAST: CodexSpeedCatalogModel = {
  ...FAST_ONLY,
  tiers: ['priority', 'ultrafast'],
};

function catalog(
  overrides: Partial<CodexSpeedCatalog> = {},
): CodexSpeedCatalog {
  return {
    generation: 1,
    status: 'ready',
    fetchedAt: NOW,
    expiresAt: NOW + CODEX_SPEED_CATALOG_TTL_MS,
    truncated: false,
    models: [WITH_ULTRAFAST],
    denials: [],
    ...overrides,
  };
}

/** The catalog plus the account proxy's own list. */
function withProxyList(
  current: CodexSpeedCatalog,
  models: CodexSpeedCatalogModel[],
): CodexSpeedCatalog {
  return {
    ...current,
    routes: {
      'account-proxy': {
        revision: 1,
        status: 'ready',
        fetchedAt: NOW,
        expiresAt: NOW + CODEX_SPEED_CATALOG_TTL_MS,
        truncated: false,
        models,
      },
    },
  };
}

/** A host projection that could not resolve the route. */
const UNRESOLVED_ROUTE: CodexSpeedRouteFacts = {
  modelSelection: 'explicit',
  runtimeModel: null,
  modelSource: null,
  harness: null,
  routeProfile: 'unknown',
};

/** A native-shaped route the renderer has not had confirmed by the host. */
const UNCONFIRMED_INPUT: CodexSpeedRouteInput = {
  model: FUTURE_MODEL,
  modelSelection: 'explicit',
  modelSource: 'codex-managed',
  harness: 'codex',
  aiCreditsRouted: false,
};

/** The same route with a trusted, context-scoped host projection. */
const NATIVE_INPUT: CodexSpeedRouteInput = {
  ...UNCONFIRMED_INPUT,
  routeProfile: 'codex-native',
};

function statesFor(
  input: CodexSpeedRouteInput,
  current: CodexSpeedCatalog | null,
  status: CodexSpeedControl['status'] = current ? current.status : 'loading',
): ReturnType<typeof codexSpeedChoiceStates> {
  const route = resolveCodexSpeedRouteFacts(input);
  return codexSpeedChoiceStates({
    route,
    status,
    options: deriveCodexSpeedOptions({ catalog: current, route, now: NOW }),
  });
}

describe('resolveCodexSpeedRouteFacts', () => {
  it('treats a native-shaped route as native only when the host confirms it for this context', () => {
    const route = resolveCodexSpeedRouteFacts(NATIVE_INPUT);
    expect(route).toEqual<CodexSpeedRouteFacts>({
      modelSelection: 'explicit',
      runtimeModel: FUTURE_MODEL,
      modelSource: 'codex-managed',
      harness: 'codex',
      routeProfile: 'codex-native',
    });
  });

  it('keeps a native-shaped route unknown without a context-scoped projection', () => {
    expect(resolveCodexSpeedRouteFacts(UNCONFIRMED_INPUT).routeProfile).toBe(
      'unknown',
    );
    // A readable (even advertising) global catalog never qualifies a chat.
    expect(statesFor(UNCONFIRMED_INPUT, catalog()).ultrafast).toMatchObject({
      selectable: false,
      shortReason: "Couldn't confirm availability",
    });
  });

  it('offers Ultra fast on an account proxy route only when the proxy list offers it too', () => {
    const proxyInput: CodexSpeedRouteInput = {
      ...UNCONFIRMED_INPUT,
      routeProfile: 'account-proxy',
    };
    expect(resolveCodexSpeedRouteFacts(proxyInput).routeProfile).toBe(
      'account-proxy',
    );
    expect(
      statesFor(proxyInput, withProxyList(catalog(), [WITH_ULTRAFAST]))
        .ultrafast,
    ).toEqual({ selectable: true });
    // The proxy's accounts do not offer it, though the runtime catalog does.
    expect(
      statesFor(proxyInput, withProxyList(catalog(), [FAST_ONLY])).ultrafast,
    ).toMatchObject({
      selectable: false,
      shortReason: 'Not offered for this model',
    });
    // The proxy offers it, but the runtime catalog does not.
    expect(
      statesFor(
        proxyInput,
        withProxyList(catalog({ models: [FAST_ONLY] }), [WITH_ULTRAFAST]),
      ).ultrafast,
    ).toMatchObject({
      selectable: false,
      shortReason: 'Not offered for this model',
    });
    // Without the proxy list it is never offered.
    expect(statesFor(proxyInput, catalog()).ultrafast).toMatchObject({
      selectable: false,
      shortReason: "Couldn't confirm availability",
    });
  });

  it('honors a non-native host projection for a native-shaped route', () => {
    expect(
      resolveCodexSpeedRouteFacts({
        ...UNCONFIRMED_INPUT,
        routeProfile: 'org-gateway',
      }).routeProfile,
    ).toBe('org-gateway');
  });

  it('never treats gateway, credits, local, Cursor, or Claude routes as native', () => {
    // Renderer-known non-native facts win even over a native projection.
    const profile = (patch: Partial<CodexSpeedRouteInput>): string =>
      resolveCodexSpeedRouteFacts({ ...NATIVE_INPUT, ...patch }).routeProfile;
    expect(profile({ aiCreditsRouted: true })).toBe('ai-credits');
    expect(profile({ modelSource: 'ai-gateway' })).toBe('ai-credits');
    expect(profile({ modelSource: 'ollama' })).toBe('ollama');
    expect(profile({ modelSource: 'cursor-managed' })).toBe('cursor');
    expect(profile({ harness: 'cursor' })).toBe('cursor');
    expect(profile({ modelSource: 'claude-managed', harness: 'claude' })).toBe(
      'foreign',
    );
    expect(profile({ harness: 'claude' })).toBe('foreign');
  });

  it('records Auto routing so Ultra fast needs an explicit model', () => {
    expect(
      resolveCodexSpeedRouteFacts({ ...NATIVE_INPUT, modelSelection: 'auto' })
        .modelSelection,
    ).toBe('auto');
  });
});

describe('codexSpeedRouteInput', () => {
  beforeEach(() => {
    initClaudeModels([{ id: 'claude-sonnet-4-5', label: 'Sonnet' }]);
    initCodexModels([{ id: FUTURE_MODEL, label: 'Future' }]);
  });

  it('reads the model source and harness from the hydrated registry', () => {
    expect(
      codexSpeedRouteInput({
        model: FUTURE_MODEL,
        auto: false,
        aiCreditsRouted: false,
      }),
    ).toEqual(UNCONFIRMED_INPUT);
  });

  it('carries the host route projection only when the surface supplies one', () => {
    expect(
      codexSpeedRouteInput({
        model: FUTURE_MODEL,
        auto: false,
        aiCreditsRouted: false,
        routeProfile: 'codex-native',
      }),
    ).toEqual(NATIVE_INPUT);
  });

  it('carries Auto routing, the captured harness, and the billing lane', () => {
    expect(
      codexSpeedRouteInput({
        model: FUTURE_MODEL,
        auto: true,
        capturedHarness: 'claude',
        aiCreditsRouted: true,
      }),
    ).toEqual({
      ...UNCONFIRMED_INPUT,
      modelSelection: 'auto',
      harness: 'claude',
      aiCreditsRouted: true,
    });
    expect(
      codexSpeedRouteInput({
        model: 'claude-sonnet-4-5',
        auto: false,
        aiCreditsRouted: false,
      }).modelSource,
    ).toBe('claude-managed');
  });
});

describe('codexSpeedChoiceStates', () => {
  it('never gates Regular or Fast', () => {
    for (const current of [null, catalog({ models: [FAST_ONLY] })]) {
      const states = statesFor(
        { ...NATIVE_INPUT, aiCreditsRouted: true },
        current,
      );
      expect(states.standard.selectable).toBe(true);
      expect(states.fast.selectable).toBe(true);
    }
  });

  it('offers Ultra fast only when the resolved model advertises it', () => {
    expect(statesFor(NATIVE_INPUT, catalog()).ultrafast.selectable).toBe(true);
    const fastOnly = statesFor(NATIVE_INPUT, catalog({ models: [FAST_ONLY] }));
    expect(fastOnly.ultrafast).toEqual({
      selectable: false,
      shortReason: 'Not offered for this model',
      reason:
        "This Codex connection doesn't offer Ultra fast for this model. Choose Regular or Fast.",
      definite: true,
    });
  });

  it('gives each unavailable or unknown state a distinct short reason', () => {
    expect(
      statesFor({ ...NATIVE_INPUT, modelSelection: 'auto' }, catalog())
        .ultrafast.shortReason,
    ).toBe('Choose a specific model');
    expect(
      statesFor({ ...NATIVE_INPUT, aiCreditsRouted: true }, catalog()).ultrafast
        .shortReason,
    ).toBe('Not available on this connection');
    expect(statesFor(NATIVE_INPUT, null).ultrafast.shortReason).toBe(
      'Checking availability',
    );
    expect(
      statesFor(
        NATIVE_INPUT,
        catalog({ status: 'unknown', fetchedAt: null, models: [] }),
      ).ultrafast.shortReason,
    ).toBe("Couldn't confirm availability");
    expect(
      statesFor(
        NATIVE_INPUT,
        catalog({
          denials: [{ model: FUTURE_MODEL, expiresAt: NOW + 60_000 }],
        }),
      ).ultrafast.shortReason,
    ).toBe('Recently declined');
  });

  it('keeps an unresolved model source in the checking state', () => {
    expect(
      statesFor({ ...NATIVE_INPUT, modelSource: null }, catalog()).ultrafast
        .shortReason,
    ).toBe('Checking availability');
  });
});

describe('codexSpeedBlockedReason', () => {
  it('blocks only an Ultra fast selection that cannot run, never while loading', () => {
    const unavailable = statesFor(
      NATIVE_INPUT,
      catalog({ models: [FAST_ONLY] }),
    );
    expect(codexSpeedBlockedReason('fast', unavailable, 'ready')).toBeNull();
    expect(codexSpeedBlockedReason('ultrafast', unavailable, 'ready')).toBe(
      unavailable.ultrafast.reason,
    );
    expect(
      codexSpeedBlockedReason(
        'ultrafast',
        statesFor(NATIVE_INPUT, null),
        'loading',
      ),
    ).toBeNull();
    expect(
      codexSpeedBlockedReason(
        'ultrafast',
        statesFor(NATIVE_INPUT, catalog()),
        'ready',
      ),
    ).toBeNull();
  });
});

describe('codexSpeedDowngrade', () => {
  it('steps an Ultra fast the model does not offer down to Fast', () => {
    const fastOnly = statesFor(NATIVE_INPUT, catalog({ models: [FAST_ONLY] }));
    expect(codexSpeedDowngrade('ultrafast', fastOnly, 'ready')).toBe('fast');
  });

  it('steps down to Regular when Fast cannot be chosen either', () => {
    const fastOnly = statesFor(NATIVE_INPUT, catalog({ models: [FAST_ONLY] }));
    expect(
      codexSpeedDowngrade(
        'ultrafast',
        { ...fastOnly, fast: { selectable: false } },
        'ready',
      ),
    ).toBe('standard');
  });

  it('steps down for Auto and for a route that is not the native sign-in', () => {
    expect(
      codexSpeedDowngrade(
        'ultrafast',
        statesFor({ ...NATIVE_INPUT, modelSelection: 'auto' }, catalog()),
        'ready',
      ),
    ).toBe('fast');
    expect(
      codexSpeedDowngrade(
        'ultrafast',
        statesFor({ ...NATIVE_INPUT, aiCreditsRouted: true }, catalog()),
        'ready',
      ),
    ).toBe('fast');
  });

  it('keeps a runnable, checking, or unconfirmed Ultra fast', () => {
    expect(
      codexSpeedDowngrade(
        'ultrafast',
        statesFor(NATIVE_INPUT, catalog()),
        'ready',
      ),
    ).toBeNull();
    expect(
      codexSpeedDowngrade(
        'ultrafast',
        statesFor(NATIVE_INPUT, null),
        'loading',
      ),
    ).toBeNull();
    // A failed or unconfirmed read is not an answer: the selection stays.
    expect(
      codexSpeedDowngrade(
        'ultrafast',
        statesFor(UNCONFIRMED_INPUT, catalog()),
        'ready',
      ),
    ).toBeNull();
    expect(
      codexSpeedDowngrade(
        'ultrafast',
        statesFor(NATIVE_INPUT, catalog({ status: 'unknown' }), 'unknown'),
        'unknown',
      ),
    ).toBeNull();
  });

  it('never changes Regular or Fast', () => {
    const fastOnly = statesFor(NATIVE_INPUT, catalog({ models: [FAST_ONLY] }));
    expect(codexSpeedDowngrade('fast', fastOnly, 'ready')).toBeNull();
    expect(codexSpeedDowngrade('standard', fastOnly, 'ready')).toBeNull();
  });
});

describe('codexSpeedConnectionStates', () => {
  it('never qualifies an Ultra fast default from the global catalog alone', () => {
    expect(codexSpeedConnectionStates(catalog(), 'ready').ultrafast).toEqual({
      selectable: false,
      shortReason: "Couldn't confirm availability",
      reason:
        "Couldn't confirm Ultra fast for this Codex connection. Try again, or choose Regular or Fast.",
    });
    expect(
      codexSpeedConnectionStates(catalog(), 'ready', 'org-gateway').ultrafast
        .shortReason,
    ).toBe('Not available on this connection');
  });

  it('offers an Ultra fast default when the defaults route is native and a model advertises it', () => {
    expect(
      codexSpeedConnectionStates(catalog(), 'ready', 'codex-native').ultrafast,
    ).toEqual({ selectable: true });
  });

  it('offers an Ultra fast default on the account proxy only when both lists offer a model', () => {
    expect(
      codexSpeedConnectionStates(
        withProxyList(catalog(), [WITH_ULTRAFAST]),
        'ready',
        'account-proxy',
      ).ultrafast,
    ).toEqual({ selectable: true });
    expect(
      codexSpeedConnectionStates(
        withProxyList(catalog(), [FAST_ONLY]),
        'ready',
        'account-proxy',
      ).ultrafast.shortReason,
    ).toBe('Not offered on this Codex connection');
    expect(
      codexSpeedConnectionStates(
        withProxyList(catalog({ models: [FAST_ONLY] }), [WITH_ULTRAFAST]),
        'ready',
        'account-proxy',
      ).ultrafast.shortReason,
    ).toBe('Not offered on this Codex connection');
    expect(
      codexSpeedConnectionStates(catalog(), 'ready', 'account-proxy').ultrafast
        .shortReason,
    ).toBe("Couldn't confirm availability");
  });

  it('explains a connection without Ultra fast and an unconfirmed catalog differently', () => {
    expect(
      codexSpeedConnectionStates(
        catalog({ models: [FAST_ONLY] }),
        'ready',
        'codex-native',
      ).ultrafast.shortReason,
    ).toBe('Not offered on this Codex connection');
    expect(
      codexSpeedConnectionStates(null, 'loading').ultrafast.shortReason,
    ).toBe('Checking availability');
    expect(
      codexSpeedConnectionStates(
        catalog({ status: 'unknown', fetchedAt: null, models: [] }),
        'unknown',
      ).ultrafast.shortReason,
    ).toBe("Couldn't confirm availability");
    expect(
      codexSpeedConnectionStates(
        catalog({ models: [FAST_ONLY], truncated: true }),
        'ready',
        'codex-native',
      ).ultrafast.shortReason,
    ).toBe("Couldn't confirm availability");
  });
});

describe('useCodexSpeedControl', () => {
  let container: HTMLDivElement;
  let root: Root;
  let readCapabilities: jest.Mock;
  let setActive: jest.Mock;

  beforeEach(() => {
    jest.useFakeTimers({ now: NOW });
    resetCodexSpeedStoreForTests();
    initClaudeModels([{ id: 'claude-sonnet-4-5', label: 'Sonnet' }]);
    initCodexModels([{ id: FUTURE_MODEL, label: 'Future' }]);
    readCapabilities = jest.fn(() => Promise.resolve(catalog()));
    setActive = jest.fn(() => Promise.resolve());
    const codexSpeed: CodexSpeedApi = {
      // Not read by this hook: the route projection is supplied by callers.
      readRoute: jest.fn(() => Promise.resolve(UNRESOLVED_ROUTE)),
      readCapabilities,
      setActive,
      onChanged: jest.fn(() => (): void => undefined),
    };
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { codexSpeed },
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    resetCodexSpeedStoreForTests();
    jest.useRealTimers();
  });

  const NATIVE_REQUEST: CodexSpeedRouteRequest = {
    model: FUTURE_MODEL,
    auto: false,
    aiCreditsRouted: false,
    routeProfile: 'codex-native',
  };

  const probe: { current: CodexSpeedControl | null } = { current: null };

  function Probe({
    enabled,
    request,
  }: {
    enabled: boolean;
    request: CodexSpeedRouteRequest;
  }): null {
    // A fresh request object each render, as composers pass it.
    probe.current = useCodexSpeedControl({ enabled, route: { ...request } });
    return null;
  }

  async function renderControl(
    enabled: boolean,
    request: CodexSpeedRouteRequest = NATIVE_REQUEST,
  ): Promise<{ current: CodexSpeedControl | null }> {
    await act(async () => {
      root.render(<Probe enabled={enabled} request={request} />);
      for (let index = 0; index < 10; index += 1) await Promise.resolve();
    });
    return probe;
  }

  it('looks up the model source once per route change, not on every render', async () => {
    const lookup = jest.spyOn(desktopTypes, 'getModelSource');
    try {
      await renderControl(true);
      const states = probe.current?.states;
      const callsAfterMount = lookup.mock.calls.length;
      expect(callsAfterMount).toBeGreaterThan(0);
      await renderControl(true);
      await renderControl(true);
      expect(lookup.mock.calls.length).toBe(callsAfterMount);
      expect(probe.current?.states).toBe(states);
      await renderControl(true, { ...NATIVE_REQUEST, auto: true });
      expect(probe.current?.states.ultrafast.shortReason).toBe(
        'Choose a specific model',
      );
    } finally {
      lookup.mockRestore();
    }
  });

  it('reads the shared catalog and derives per-speed states for the route', async () => {
    const probe = await renderControl(true);
    expect(readCapabilities).toHaveBeenCalled();
    expect(probe.current?.status).toBe('ready');
    expect(probe.current?.states.ultrafast.selectable).toBe(true);
    expect(probe.current?.canRefresh).toBe(false);
  });

  it('offers a forced refresh when availability is unknown', async () => {
    readCapabilities.mockImplementation(() =>
      Promise.resolve(
        catalog({ status: 'unknown', fetchedAt: null, models: [] }),
      ),
    );
    const probe = await renderControl(true);
    expect(probe.current?.canRefresh).toBe(true);
    readCapabilities.mockClear();
    await act(async () => {
      probe.current?.refresh();
      await Promise.resolve();
    });
    expect(readCapabilities).toHaveBeenCalledWith({ force: true });
  });

  it('keeps Ultra fast unconfirmed until the surface supplies a host route projection', async () => {
    const probe = await renderControl(true, {
      model: FUTURE_MODEL,
      auto: false,
      aiCreditsRouted: false,
    });
    expect(probe.current?.status).toBe('ready');
    expect(probe.current?.states.ultrafast).toMatchObject({
      selectable: false,
      shortReason: "Couldn't confirm availability",
    });
    expect(probe.current?.blockedReason('ultrafast')).toBe(
      "Couldn't confirm Ultra fast for this model. Try again, or choose Regular or Fast.",
    );
  });

  it('stays inactive for surfaces that do not show a Codex speed', async () => {
    const probe = await renderControl(false);
    expect(readCapabilities).not.toHaveBeenCalled();
    expect(setActive).not.toHaveBeenCalled();
    expect(probe.current?.states.fast.selectable).toBe(true);
  });
});
