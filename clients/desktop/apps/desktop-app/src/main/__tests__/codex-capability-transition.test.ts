import {
  initAiGatewayModels,
  OLLAMA_SERVER_UNAVAILABLE_ERROR_CODE,
  OLLAMA_SERVER_UNAVAILABLE_ERROR_NAME,
  type ModelHarnessInvocation,
} from '@canopy/desktop-shared/types';
import { isCoworkWorkspace } from '../lib/workspace-registry';
import { buildCoworkDispatchSystemPromptAppend } from '../lib/cowork-chat-system-prompt';
import { BRAND } from '@canopy/brand/current';
import { getAppAdvisorLedgerToolNames } from '@canopy/desktop-shared/lib/app-advisor-tools';
import type { LedgerChatScope } from '../canopy-tools/ledger-tools-runtime';

// Jest hoists `jest.mock` factories above the imports, so every binding a
// factory closes over must be declared with a `mock`-prefixed name.
interface MaterializeRequest {
  reasoningRouteFamily?: string;
  params: {
    model?: string;
    config?: Record<string, unknown>;
    developerInstructions?: string;
  };
  items?: unknown[];
}
interface SeedItemsOptions {
  targetRouteFamily?: string;
  sourceRouteFamily?: string;
}

const mockMaterializeThread = jest.fn<
  Promise<{ threadId: string }>,
  [MaterializeRequest]
>();
const mockReadLease = jest.fn<Promise<unknown>, [string]>();
const mockResolveOllamaInvocation = jest.fn<
  Promise<ModelHarnessInvocation>,
  [string | undefined, { assertInstalled?: boolean }?]
>();
interface SeedItemsLoad {
  items: unknown[];
  loadedItemCount: number;
}
const mockLoadSeedItems = jest.fn<Promise<SeedItemsLoad>, [SeedItemsOptions]>();
const mockResolveLedgerToolExposure = jest.fn<
  Promise<LedgerChatScope | null>,
  [unknown]
>();
const mockLedgerToolPromptFor = jest.fn<string, [unknown]>();
const mockBuildCodexSessionDynamicToolSpecs = jest.fn<unknown[], [unknown]>();

jest.mock('../plugins/plugin-resolver', () => ({
  resolvePlugins: jest.fn().mockResolvedValue({
    codexMcpServers: {},
    selectedCapabilityRoots: [],
  }),
}));
jest.mock('../plugins/global-plugin-overlay', () => ({
  resolveEffectiveChatPluginContext: jest
    .fn()
    .mockResolvedValue({ selections: {} }),
}));
jest.mock('@canopy/desktop-shared/lib/effective-plugin-selections', () => ({
  chatSurfaceUsesGlobalPluginDefaults: jest.fn().mockReturnValue(false),
}));
jest.mock('../lib/resolve-worktree', () => ({
  resolveWorktreeCwd: jest.fn().mockReturnValue('/tmp/repo'),
}));
jest.mock('../lib/user-environment-runtime', () => ({
  resolveCodexRuntimeEnvironmentProfile: jest.fn().mockReturnValue({
    environment: {},
    logicalWorkspaceEnvironmentId: 'env',
  }),
}));
jest.mock('@canopy/desktop-shared/node/e2e-mock-env', () => ({
  resolveCodexMockAppServerOverride: jest.fn().mockReturnValue(null),
}));
jest.mock('../lib/workspace-registry', () => ({
  isCoworkWorkspace: jest.fn().mockReturnValue(false),
}));
jest.mock('../canopy-tools/prompting', () => ({
  buildCoworkInjectedToolPrompt: jest.fn().mockReturnValue('cowork'),
  buildWorktreeInjectedToolPrompt: jest.fn().mockReturnValue('worktree'),
}));
jest.mock('../lib/cowork-chat-system-prompt', () => ({
  buildCoworkSystemPromptAppend: jest.fn().mockReturnValue('cowork-append'),
  buildCoworkDispatchSystemPromptAppend: jest
    .fn()
    .mockReturnValue('cowork-append\n\ncowork'),
}));
jest.mock('../lib/code-graph-availability', () => ({
  isCodeGraphAvailableForWorkspace: jest.fn().mockReturnValue(false),
}));
jest.mock('../codex/transcript-seed', () => ({
  loadPersistedCodexFallbackSeedItems: jest.fn().mockResolvedValue([]),
}));
jest.mock('../codex/runtime-service', () => ({
  getCodexRuntimeService: jest.fn().mockReturnValue({
    materializeThread: mockMaterializeThread,
    getCanonicalState: jest
      .fn()
      .mockResolvedValue({ codexHome: '/tmp/.codex' }),
    revokeStdioMcpRoutes: jest.fn().mockResolvedValue(undefined),
  }),
}));
jest.mock('../codex/capability-store', () => ({
  getDesktopCodexCapabilityStore: jest.fn().mockReturnValue({
    readLease: mockReadLease,
  }),
}));
jest.mock('../mcp/http-proxy-service', () => ({
  getMcpHttpProxyService: jest.fn().mockReturnValue({
    getCodexCapabilityAuthorityIds: jest.fn().mockReturnValue([]),
    unregisterRoutesForSession: jest.fn(),
  }),
}));
jest.mock('../lib/chat-visuals-feature-flag', () => ({
  chatVisualsEligible: jest.fn().mockReturnValue(false),
}));
jest.mock('../codex/session-dynamic-tools', () => ({
  buildCodexSessionDynamicToolSpecs: (options: unknown): unknown[] =>
    mockBuildCodexSessionDynamicToolSpecs(options),
}));
jest.mock('../canopy-tools/ledger-tools-runtime', () => ({
  resolveLedgerToolExposure: (
    target: unknown,
  ): Promise<LedgerChatScope | null> => mockResolveLedgerToolExposure(target),
  ledgerToolPromptFor: (options: unknown): string =>
    mockLedgerToolPromptFor(options),
}));
jest.mock('../ollama/codex-compatible', () => ({
  resolveCodexCompatibleOllamaInvocation: mockResolveOllamaInvocation,
}));
jest.mock('@canopy/desktop-shared/node/codex-runtime', () => ({
  createCodexCapabilitySnapshotId: jest.fn().mockReturnValue('snapshot-new'),
  loadCodexThreadSeedItemsWithLoadCount: mockLoadSeedItems,
}));

import { materializeCodexCapabilityTransition } from '../codex/capability-transition';

const OLLAMA_INVOCATION: ModelHarnessInvocation = {
  source: 'ollama',
  harness: 'codex',
  runtimeModel: 'llama3.3',
  aiCreditsRouted: false,
  codexConfig: {
    model_provider: 'canopy-ollama',
    model_providers: {
      'canopy-ollama': { base_url: 'http://127.0.0.1:11434/v1' },
    },
  },
};

/**
 * The shape `OllamaServerUnavailableError` puts on the wire, rebuilt here so
 * this suite does not have to import the whole Electron-main Ollama service.
 * `ollama-service.test.ts` pins that the real service throws exactly this for
 * an unreachable server.
 */
function serverUnavailableError(message: string): Error {
  const error = new Error(message);
  error.name = OLLAMA_SERVER_UNAVAILABLE_ERROR_NAME;
  Object.defineProperty(error, 'code', {
    value: OLLAMA_SERVER_UNAVAILABLE_ERROR_CODE,
    enumerable: true,
  });
  return error;
}

const baseInput = {
  projectId: 'project',
  worktreeId: 'worktree',
  chatId: 'chat',
  sourceThreadId: 'thread-existing',
  pluginSelections: {},
  localMemoryEnabled: false,
};

beforeAll(() => {
  // `gateway:<upstream>` families are derived from the gateway route registry,
  // so the suite needs one catalogued gateway route to resolve against.
  initAiGatewayModels(
    [
      {
        id: 'deepseek-v4-pro',
        label: 'DeepSeek V4 Pro',
        recommendedHarness: 'codex',
        contextWindow: 1_000_000,
        supportsPromptCaching: false,
        supportedThinkingLevels: [],
        toolSchemaProfile: 'flat',
      },
    ],
    [
      {
        modelId: 'deepseek-v4-pro',
        gatewayId: 'deepseek/deepseek-v4-pro',
        recommendedHarness: 'codex',
        gatewayOnly: true,
        contextWindow: 1_000_000,
        supportsPromptCaching: false,
        supportedThinkingLevels: [],
        toolSchemaProfile: 'flat',
      },
      // Sol is reachable through BOTH routes. It has a gateway entry but is not
      // `gatewayOnly`, which is exactly what makes the recovered routing bit
      // dangerous: recovering `true` for it resolves `gateway:openai` even
      // though the chat will actually run natively.
      {
        modelId: 'gpt-5.6-sol',
        gatewayId: 'openai/gpt-5.6-sol',
        recommendedHarness: 'codex',
        gatewayOnly: false,
        contextWindow: 400_000,
        supportsPromptCaching: false,
        supportedThinkingLevels: [],
        toolSchemaProfile: 'standard',
      },
    ],
  );
});

beforeEach(() => {
  mockMaterializeThread.mockReset();
  mockMaterializeThread.mockResolvedValue({ threadId: 'thread-new' });
  mockReadLease.mockReset();
  mockReadLease.mockResolvedValue(null);
  mockResolveOllamaInvocation.mockReset();
  mockResolveOllamaInvocation.mockResolvedValue(OLLAMA_INVOCATION);
  mockLoadSeedItems.mockReset();
  mockLoadSeedItems.mockResolvedValue({
    items: [{ type: 'message', role: 'user', content: [] }],
    loadedItemCount: 1,
  });
  mockResolveLedgerToolExposure.mockReset();
  mockResolveLedgerToolExposure.mockResolvedValue(null);
  mockLedgerToolPromptFor.mockReset();
  mockLedgerToolPromptFor.mockReturnValue('ledger-prompt');
  mockBuildCodexSessionDynamicToolSpecs.mockReset();
  mockBuildCodexSessionDynamicToolSpecs.mockReturnValue([]);
});

describe('materializeCodexCapabilityTransition reasoning route family', () => {
  it('records the native family and forwards the model unchanged', async () => {
    await materializeCodexCapabilityTransition({
      ...baseInput,
      model: 'gpt-5.6-sol',
    });

    expect(mockBuildCodexSessionDynamicToolSpecs).toHaveBeenCalledWith(
      expect.objectContaining({ includeChatVisuals: false }),
    );
    expect(mockResolveOllamaInvocation).not.toHaveBeenCalled();
    const request = mockMaterializeThread.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      reasoningRouteFamily: 'native',
      params: { model: 'gpt-5.6-sol' },
    });
  });

  it('composes Cowork chat instructions through the shared Cowork dispatch builder', async () => {
    jest.mocked(isCoworkWorkspace).mockReturnValueOnce(true);
    await materializeCodexCapabilityTransition({
      ...baseInput,
      model: 'gpt-5.6-sol',
    });

    // Codex keeps the deferred-tool paragraph and the injected-tool steering,
    // gated on the chat's local-memory preference, so the harness and the
    // preference and resolved private-memory policy must reach the builder unchanged.
    expect(
      jest.mocked(buildCoworkDispatchSystemPromptAppend),
    ).toHaveBeenCalledWith('codex', false, false, false);
    const request = mockMaterializeThread.mock.calls[0]?.[0];
    // The Cowork prompt leads the developer instructions; MCP discovery text
    // is appended after it.
    const leadsWithCoworkPrompt: unknown = expect.stringContaining(
      'cowork-append\n\ncowork',
    );
    expect(request).toMatchObject({
      params: { developerInstructions: leadsWithCoworkPrompt },
    });
  });

  it('supplies the project doc config to the rebuilt thread', async () => {
    await materializeCodexCapabilityTransition(baseInput);

    expect(mockMaterializeThread.mock.calls[0]?.[0]).toMatchObject({
      params: {
        config: {
          project_doc_max_bytes: 131_072,
          project_doc_fallback_filenames: ['CLAUDE.md'],
        },
      },
    });
  });

  it('rebuilds an Ollama chat under Ollama, not merely labelled as Ollama', async () => {
    // Recording the `ollama` family is necessary but not sufficient: the
    // replacement thread must also carry the raw runtime model id and the
    // loopback Responses configuration, or it fails or routes to the wrong
    // backend while still claiming Ollama provenance.
    await materializeCodexCapabilityTransition({
      ...baseInput,
      model: 'ollama-llama3.3',
      providerType: 'ollama',
    });

    // `assertInstalled` matches the session path: the transition already
    // requires a reachable Ollama server, so rebuilding onto a model that
    // server cannot serve would replace the thread and defer the failure to the
    // next turn. `ensureRunningReason` stays omitted — a tool update must not
    // start a server as a side effect.
    expect(mockResolveOllamaInvocation).toHaveBeenCalledWith(
      'ollama-llama3.3',
      {
        assertInstalled: true,
      },
    );
    const request = mockMaterializeThread.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      // Keyed by model, and by the *stripped* model id so the persisted
      // `ollama-` UI id and the raw runtime id below agree on one family.
      reasoningRouteFamily: 'ollama:llama3.3',
      params: {
        // Raw runtime id, NOT the persisted `ollama-*` UI id.
        model: 'llama3.3',
        config: { model_provider: 'canopy-ollama' },
      },
    });
  });

  it('asks the user to start Ollama instead of surfacing the raw probe error', async () => {
    // Rebuilding an Ollama chat needs the local server, which updating tool
    // selections never needed before. The failure is expected and recoverable,
    // so it must read as an instruction rather than an internal probe message.
    mockResolveOllamaInvocation.mockRejectedValue(
      serverUnavailableError(
        'Could not determine the Ollama version on port 11434 before starting a Codex-harness session. Verify the configured Ollama server is running and exposes /api/version.',
      ),
    );

    await expect(
      materializeCodexCapabilityTransition({
        ...baseInput,
        model: 'ollama-llama3.3',
        providerType: 'ollama',
      }),
    ).rejects.toThrow(/Start Ollama to update the tools for this chat/);
    expect(mockMaterializeThread).not.toHaveBeenCalled();
  });

  it('surfaces a missing-model failure instead of telling the user to start Ollama', async () => {
    // The real message `assertInstalled` produces when the server is running
    // and answering, but does not have the model. "Start Ollama" cannot
    // possibly resolve it — the server is already up — and burying the real
    // cause in parentheses hides the one action that would (pull the model).
    mockResolveOllamaInvocation.mockRejectedValue(
      new Error('Ollama model "llama3.3" is not installed on port 11434'),
    );

    await expect(
      materializeCodexCapabilityTransition({
        ...baseInput,
        model: 'ollama-llama3.3',
        providerType: 'ollama',
      }),
      // An error instance compares the message *exactly*, so a wrapper that
      // merely appends the original in parentheses still fails here.
    ).rejects.toThrow(
      new Error('Ollama model "llama3.3" is not installed on port 11434'),
    );
    expect(mockMaterializeThread).not.toHaveBeenCalled();
  });

  it('surfaces a model capability failure unrewritten', async () => {
    // Also produced by `assertInstalled` against a reachable server: the model
    // is installed but does not advertise `completion` + `tools`. Starting the
    // server is not the remedy; choosing a different model is.
    const capabilityFailure = `Ollama model "llama3.3" must advertise both "completion" and "tools" capabilities to be used in ${BRAND.displayName} (reported capabilities: completion)`;
    mockResolveOllamaInvocation.mockRejectedValue(new Error(capabilityFailure));

    await expect(
      materializeCodexCapabilityTransition({
        ...baseInput,
        model: 'ollama-llama3.3',
        providerType: 'ollama',
      }),
    ).rejects.toThrow(new Error(capabilityFailure));
    expect(mockMaterializeThread).not.toHaveBeenCalled();
  });

  it('surfaces a Responses-API version failure unrewritten', async () => {
    // `assertResponsesCompatibleApi` reached the server and read its version:
    // the server is running, so "Start Ollama" is actively wrong. The remedy
    // named in the original message (upgrade) must survive.
    const versionFailure =
      'Ollama 0.13.2 on port 11434 does not support the OpenAI Responses API required for Codex-harness sessions. Upgrade Ollama to 0.13.3 or newer.';
    mockResolveOllamaInvocation.mockRejectedValue(new Error(versionFailure));

    await expect(
      materializeCodexCapabilityTransition({
        ...baseInput,
        model: 'ollama-llama3.3',
        providerType: 'ollama',
      }),
    ).rejects.toThrow(new Error(versionFailure));
    expect(mockMaterializeThread).not.toHaveBeenCalled();
  });

  it('passes the unsupported-platform failure through unrewritten', async () => {
    // The platform guard is thrown before any probe runs. Rewriting it into
    // "Start Ollama…" tells a Windows or Linux user to start a server that
    // cannot run on their platform at all.
    mockResolveOllamaInvocation.mockRejectedValue(
      new Error('Ollama is only supported on macOS and Windows'),
    );

    await expect(
      materializeCodexCapabilityTransition({
        ...baseInput,
        model: 'ollama-llama3.3',
        providerType: 'ollama',
      }),
      // An error instance compares the message *exactly*, so a wrapper that
      // merely appends the original in parentheses still fails here.
    ).rejects.toThrow(
      new Error('Ollama is only supported on macOS and Windows'),
    );
    expect(mockMaterializeThread).not.toHaveBeenCalled();
  });

  it('passes the non-Ollama-model guard through unrewritten', async () => {
    // Also thrown before any probe: starting the server would not fix it.
    mockResolveOllamaInvocation.mockRejectedValue(
      new Error('Codex-compatible Ollama invocation requires an Ollama model'),
    );

    await expect(
      materializeCodexCapabilityTransition({
        ...baseInput,
        model: 'gpt-5.6-sol',
        providerType: 'ollama',
      }),
    ).rejects.toThrow(
      new Error('Codex-compatible Ollama invocation requires an Ollama model'),
    );
    expect(mockMaterializeThread).not.toHaveBeenCalled();
  });

  it('sanitizes history against the target family when provenance is unknown', async () => {
    mockReadLease.mockResolvedValue(null);

    await materializeCodexCapabilityTransition({
      ...baseInput,
      model: 'gpt-5.6-sol',
    });

    const seedOptions = mockLoadSeedItems.mock.calls[0]?.[0];
    expect(seedOptions).toMatchObject({ targetRouteFamily: 'native' });
    expect(mockLoadSeedItems).toHaveBeenCalledTimes(1);
  });

  it('keeps the gateway family of an idle chat whose routing signal is unavailable', async () => {
    // `aiCreditsRouted` comes from the live session (`isSessionAiCreditsRouted`)
    // and is simply absent when no session is registered — the common case of
    // restarting the app and editing tool selections before sending anything.
    // Treating that absence as "not routed" would downgrade the lease to
    // `native`, strip every reasoning item from the rebuilt thread, and force a
    // second rebuild on the next real turn.
    mockReadLease.mockResolvedValue({
      version: 1,
      threadId: 'thread-existing',
      snapshotId: 'snapshot-old',
      rootContentIds: [],
      kind: 'persisted-chat',
      reasoningRouteFamily: 'gateway:deepseek',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    await materializeCodexCapabilityTransition({
      ...baseInput,
      model: 'deepseek-v4-pro',
      // No `aiCreditsRouted`: the routing signal is unavailable.
    });

    const request = mockMaterializeThread.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      reasoningRouteFamily: 'gateway:deepseek',
    });
    const seedOptions = mockLoadSeedItems.mock.calls[0]?.[0];
    expect(seedOptions).toMatchObject({
      targetRouteFamily: 'gateway:deepseek',
      sourceRouteFamily: 'gateway:deepseek',
    });
  });

  it('still sanitizes an unavailable routing signal when the model changed', async () => {
    // Recovering the routing decision from the lease must not become a blanket
    // "reuse the recorded family". The model is persisted, so a switch to a
    // different upstream provider still resolves to a different target family
    // and its foreign reasoning is dropped.
    mockReadLease.mockResolvedValue({
      version: 1,
      threadId: 'thread-existing',
      snapshotId: 'snapshot-old',
      rootContentIds: [],
      kind: 'persisted-chat',
      reasoningRouteFamily: 'gateway:anthropic',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    await materializeCodexCapabilityTransition({
      ...baseInput,
      model: 'deepseek-v4-pro',
    });

    const request = mockMaterializeThread.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      reasoningRouteFamily: 'gateway:deepseek',
    });
    const seedOptions = mockLoadSeedItems.mock.calls[0]?.[0];
    expect(seedOptions).toMatchObject({
      targetRouteFamily: 'gateway:deepseek',
      sourceRouteFamily: 'gateway:anthropic',
    });
  });

  it('does not recover a gateway route for a model that will run natively', async () => {
    // gateway -> native on an idle chat. The lease records a *family*, never a
    // model, so "the last route was gateway" says nothing about the model the
    // user has since selected. Blindly recovering `true` here resolves
    // `gateway:openai` for a model that will actually run natively: the
    // rebuilt thread gets gateway-shaped dynamic tools and a `gateway:openai`
    // lease, and the next real turn resolves `native`, mismatches, and rebuilds
    // a SECOND time — the exact double rebuild the tri-state signal exists to
    // avoid.
    mockReadLease.mockResolvedValue({
      version: 1,
      threadId: 'thread-existing',
      snapshotId: 'snapshot-old',
      rootContentIds: [],
      kind: 'persisted-chat',
      reasoningRouteFamily: 'gateway:deepseek',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    await materializeCodexCapabilityTransition({
      ...baseInput,
      model: 'gpt-5.6-sol',
      // No `aiCreditsRouted`: restart, then edit tool selections while idle.
    });

    expect(mockMaterializeThread.mock.calls[0]?.[0]).toMatchObject({
      reasoningRouteFamily: 'native',
    });
    // And the foreign DeepSeek reasoning is dropped rather than carried into a
    // natively routed thread.
    expect(mockLoadSeedItems.mock.calls[0]?.[0]).toMatchObject({
      targetRouteFamily: 'native',
      sourceRouteFamily: 'gateway:deepseek',
    });
  });

  it('forces routing for a gateway-only model recorded under a native lease', async () => {
    // native -> gateway-only on an idle chat. Recovering `false` from the
    // `native` lease would make the target family `native` too, so source ===
    // target, sanitization is SKIPPED, and OpenAI-private reasoning is replayed
    // through the gateway. A gateway-only model cannot run natively, so the
    // routed bit is knowable from the model alone.
    mockReadLease.mockResolvedValue({
      version: 1,
      threadId: 'thread-existing',
      snapshotId: 'snapshot-old',
      rootContentIds: [],
      kind: 'persisted-chat',
      reasoningRouteFamily: 'native',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    await materializeCodexCapabilityTransition({
      ...baseInput,
      model: 'deepseek-v4-pro',
    });

    expect(mockMaterializeThread.mock.calls[0]?.[0]).toMatchObject({
      reasoningRouteFamily: 'gateway:deepseek',
    });
    expect(mockLoadSeedItems.mock.calls[0]?.[0]).toMatchObject({
      targetRouteFamily: 'gateway:deepseek',
      sourceRouteFamily: 'native',
    });
  });

  it('honors an explicit not-routed signal over the recorded gateway family', async () => {
    // A live session that reports native routing is authoritative: the next
    // turn really will be native, so the gateway reasoning must be dropped now
    // rather than rejected upstream.
    mockReadLease.mockResolvedValue({
      version: 1,
      threadId: 'thread-existing',
      snapshotId: 'snapshot-old',
      rootContentIds: [],
      kind: 'persisted-chat',
      reasoningRouteFamily: 'gateway:deepseek',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    await materializeCodexCapabilityTransition({
      ...baseInput,
      model: 'gpt-5.6-sol',
      aiCreditsRouted: false,
    });

    expect(mockMaterializeThread.mock.calls[0]?.[0]).toMatchObject({
      reasoningRouteFamily: 'native',
    });
  });

  it('retains reasoning when the source lease already matches the target family', async () => {
    mockReadLease.mockResolvedValue({
      version: 1,
      threadId: 'thread-existing',
      snapshotId: 'snapshot-old',
      rootContentIds: [],
      kind: 'persisted-chat',
      reasoningRouteFamily: 'native',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    await materializeCodexCapabilityTransition({
      ...baseInput,
      model: 'gpt-5.6-sol',
    });

    const seedOptions = mockLoadSeedItems.mock.calls[0]?.[0];
    expect(seedOptions).toMatchObject({
      targetRouteFamily: 'native',
      sourceRouteFamily: 'native',
    });
  });

  it('rebuilds with whatever survived when sanitization empties a real history', async () => {
    // "No chat history" must be measured before sanitization. Sanitization drops
    // every `type: 'reasoning'` item when the source provenance is unknown, so a
    // chat whose legacy lease has no `reasoningRouteFamily` and whose loaded
    // tail is all reasoning sanitizes down to nothing even though history
    // genuinely existed. Failing there would break every tool-selection update
    // on that chat.
    mockLoadSeedItems.mockResolvedValue({ items: [], loadedItemCount: 4 });

    await materializeCodexCapabilityTransition({
      ...baseInput,
      model: 'gpt-5.6-sol',
    });

    expect(mockMaterializeThread).toHaveBeenCalledTimes(1);
    expect(mockMaterializeThread.mock.calls[0]?.[0].items).toEqual([]);
  });

  it('fails only when no persisted history was loaded at all', async () => {
    // The genuine error case survives: nothing was ever persisted, so there is
    // no conversation to carry into the replacement thread.
    mockLoadSeedItems.mockResolvedValue({ items: [], loadedItemCount: 0 });

    await expect(
      materializeCodexCapabilityTransition({
        ...baseInput,
        model: 'gpt-5.6-sol',
      }),
    ).rejects.toThrow('Cannot update Codex capabilities without chat history');
    expect(mockMaterializeThread).not.toHaveBeenCalled();
  });
});

describe('materializeCodexCapabilityTransition Ledger tools', () => {
  const scope: LedgerChatScope = {
    container: {
      kind: 'code_worktree',
      workspaceId: 'project',
      worktreeId: 'worktree',
    },
    containerCreatedAt: '2026-09-01T00:00:00.000Z',
  };

  function dynamicToolOptions(): unknown {
    const [options] = mockBuildCodexSessionDynamicToolSpecs.mock.calls[0] ?? [];
    return options;
  }

  it('rebuilds the thread with the Ledger tools and prompt a new session would get', async () => {
    mockResolveLedgerToolExposure.mockResolvedValue(scope);

    await materializeCodexCapabilityTransition({
      ...baseInput,
      model: 'gpt-5.6-sol',
      selectedRepoId: 'api',
    });

    expect(mockResolveLedgerToolExposure).toHaveBeenCalledWith({
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
    });
    expect(dynamicToolOptions()).toMatchObject({ includeLedger: true });
    const [promptOptions] = mockLedgerToolPromptFor.mock.calls[0] ?? [];
    expect(promptOptions).toEqual({
      target: { projectId: 'project', worktreeId: 'worktree', chatId: 'chat' },
      scope,
      harness: 'codex',
      selectedRepoId: 'api',
    });
    const request = mockMaterializeThread.mock.calls[0]?.[0];
    expect(request?.params.developerInstructions).toBe(
      'worktree\n\nledger-prompt',
    );
  });

  it('rebuilds without the Ledger when a new session would not expose it', async () => {
    await materializeCodexCapabilityTransition({
      ...baseInput,
      model: 'gpt-5.6-sol',
    });

    expect(dynamicToolOptions()).toMatchObject({ includeLedger: false });
    expect(mockLedgerToolPromptFor).not.toHaveBeenCalled();
    const request = mockMaterializeThread.mock.calls[0]?.[0];
    expect(request?.params.developerInstructions).toBe('worktree');
  });

  it('checks exposure for the assistant mode of the chat', async () => {
    await materializeCodexCapabilityTransition({
      ...baseInput,
      model: 'gpt-5.6-sol',
      assistantMode: 'app-advisor',
    });

    expect(mockResolveLedgerToolExposure).toHaveBeenCalledWith({
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      assistantMode: 'app-advisor',
    });
    expect(dynamicToolOptions()).toMatchObject({ includeLedger: false });
  });

  it('rebuilds an App Advisor thread with the Ledger tools and prompt under the Advisor names', async () => {
    const advisorScope: LedgerChatScope = {
      container: {
        kind: 'advisor_entry',
        appWorkspaceId: 'app-advisor',
        entryId: 'entry-1',
      },
      containerCreatedAt: '2026-09-01T00:00:00.000Z',
    };
    mockResolveLedgerToolExposure.mockResolvedValue(advisorScope);

    await materializeCodexCapabilityTransition({
      ...baseInput,
      projectId: 'app-advisor',
      worktreeId: 'entry-1',
      model: 'gpt-5.6-sol',
      assistantMode: 'app-advisor',
    });

    expect(dynamicToolOptions()).toMatchObject({
      assistantMode: 'app-advisor',
      includeLedger: true,
    });
    const [promptOptions] = mockLedgerToolPromptFor.mock.calls[0] ?? [];
    expect(promptOptions).toEqual({
      target: {
        projectId: 'app-advisor',
        worktreeId: 'entry-1',
        chatId: 'chat',
        assistantMode: 'app-advisor',
      },
      scope: advisorScope,
      harness: 'codex',
      toolNames: getAppAdvisorLedgerToolNames('codex'),
    });
  });
});
