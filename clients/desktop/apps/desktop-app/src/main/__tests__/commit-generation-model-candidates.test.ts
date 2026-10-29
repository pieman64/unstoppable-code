import {
  DEFAULT_CREDITS_CODEX_MODEL,
  initAiGatewayModels,
  initClaudeModels,
  initCodexModels,
  initModelAliases,
  resetGatewayCatalogHydrationForTests,
  type AgentProviderType,
  type ModelDefaultsByProvider,
  type PreferencesData,
} from '@canopy/desktop-shared/types';
import { isGatewayRoutableModel } from '@canopy/desktop-shared/lib/gateway-model-availability';
import { resolveCommitGenerationModelCandidates } from '../lib/commit-generation-model-candidates';
import { isProviderQuotaReached } from '../agents/ai-credits-quota-state';
import {
  isModelBlockedByStoredPolicy,
  isStoredModelPolicyReadDegraded,
} from '../lib/model-policy-state';
import { DEFAULT_PREFERENCES } from '../lib/preferences-store';
import { logMainProcessWarn } from '../lib/main-process-logging';
import { resolveHelperWorkOwner } from '../ollama/helper-invocation';

jest.mock('../agents/ai-credits-quota-state', () => ({
  isProviderQuotaReached: jest.fn(),
}));
jest.mock('../lib/model-policy-state', () => ({
  isModelBlockedByStoredPolicy: jest.fn(),
  isStoredModelPolicyReadDegraded: jest.fn(),
}));
jest.mock('../ollama/helper-invocation', () => ({
  resolveHelperWorkOwner: jest.fn(),
}));
jest.mock('../lib/main-process-logging', () => ({
  logMainProcessWarn: jest.fn(),
}));
jest.mock('@canopy/desktop-shared/lib/gateway-model-availability', () => ({
  isGatewayRoutableModel: jest.fn(),
}));

const mockQuota = jest.mocked(isProviderQuotaReached);
const mockBlocked = jest.mocked(isModelBlockedByStoredPolicy);
const mockPolicyDegraded = jest.mocked(isStoredModelPolicyReadDegraded);
const mockRoutable = jest.mocked(isGatewayRoutableModel);
const mockWorkOwner = jest.mocked(resolveHelperWorkOwner);

const CLAUDE_PRIMARY = 'claude-sonnet-4-6';
const CLAUDE_DEFAULT = 'opus[1m]';
const CODEX_PRIMARY = 'gpt-5.4';
const CODEX_DEFAULT = 'gpt-5.5';
// AI Credits lane Codex default; the lane's other candidate
// (`deepseek-v4-pro`) is left out of the registry so it is filtered as unknown.
const HELPER_CREDITS_MODEL = DEFAULT_CREDITS_CODEX_MODEL;

function preferencesFor(
  provider: AgentProviderType,
  overrides: Partial<ModelDefaultsByProvider> = {},
): PreferencesData {
  return {
    ...DEFAULT_PREFERENCES,
    aiCreditsRoutingMode: 'on',
    defaultWorktreeProvider: provider,
    defaultWorktreeModelByProvider: {
      claude: { model: CLAUDE_DEFAULT, thinkingLevel: 'high' },
      codex: { model: CODEX_DEFAULT, thinkingLevel: 'high' },
      ollama: null,
      aiCredits: null,
      ...overrides,
    },
  };
}

describe('resolveCommitGenerationModelCandidates', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetGatewayCatalogHydrationForTests();
    initClaudeModels([
      { id: CLAUDE_PRIMARY, label: 'Sonnet' },
      { id: CLAUDE_DEFAULT, label: 'Opus' },
    ]);
    initCodexModels([
      { id: CODEX_PRIMARY, label: 'GPT 5.4' },
      { id: CODEX_DEFAULT, label: 'GPT 5.5' },
      { id: HELPER_CREDITS_MODEL, label: 'Luna' },
    ]);
    initAiGatewayModels([], []);
    mockQuota.mockReturnValue(false);
    mockBlocked.mockResolvedValue(false);
    mockPolicyDegraded.mockReturnValue(false);
    mockRoutable.mockReturnValue(false);
    mockWorkOwner.mockResolvedValue(undefined);
  });

  it('prefers the primary, then the selected provider default, then the other native default', async () => {
    await expect(
      resolveCommitGenerationModelCandidates({
        preferences: preferencesFor('codex'),
        primaryModel: CLAUDE_PRIMARY,
      }),
    ).resolves.toMatchObject({
      model: CLAUDE_PRIMARY,
      fallbackModels: [CODEX_DEFAULT, CLAUDE_DEFAULT, HELPER_CREDITS_MODEL],
    });
  });

  it('mirrors the ordering when Claude is the selected provider', async () => {
    await expect(
      resolveCommitGenerationModelCandidates({
        preferences: preferencesFor('claude'),
        primaryModel: CODEX_PRIMARY,
      }),
    ).resolves.toMatchObject({
      model: CODEX_PRIMARY,
      fallbackModels: [CLAUDE_DEFAULT, CODEX_DEFAULT, HELPER_CREDITS_MODEL],
    });
  });

  it('demotes quota-limited native candidates behind the rest, keeping their order', async () => {
    mockQuota.mockImplementation((provider) => provider === 'claude');

    await expect(
      resolveCommitGenerationModelCandidates({
        preferences: preferencesFor('codex'),
        primaryModel: CLAUDE_PRIMARY,
      }),
    ).resolves.toMatchObject({
      model: CODEX_DEFAULT,
      fallbackModels: [HELPER_CREDITS_MODEL, CLAUDE_PRIMARY, CLAUDE_DEFAULT],
    });
  });

  it('keeps a quota-limited model in place when the gateway can route it', async () => {
    mockQuota.mockImplementation((provider) => provider === 'claude');
    mockRoutable.mockImplementation((model) => model === CLAUDE_PRIMARY);

    await expect(
      resolveCommitGenerationModelCandidates({
        preferences: preferencesFor('codex'),
        primaryModel: CLAUDE_PRIMARY,
      }),
    ).resolves.toMatchObject({
      model: CLAUDE_PRIMARY,
      fallbackModels: [CODEX_DEFAULT, HELPER_CREDITS_MODEL, CLAUDE_DEFAULT],
    });
  });

  it('demotes a quota-limited gateway-routable model when AI Credits routing is off', async () => {
    mockQuota.mockImplementation((provider) => provider === 'claude');
    mockRoutable.mockImplementation((model) => model === CLAUDE_PRIMARY);

    await expect(
      resolveCommitGenerationModelCandidates({
        preferences: {
          ...preferencesFor('codex'),
          aiCreditsRoutingMode: 'off',
        },
        primaryModel: CLAUDE_PRIMARY,
      }),
    ).resolves.toEqual({
      model: CODEX_DEFAULT,
      fallbackModels: [CLAUDE_PRIMARY, CLAUDE_DEFAULT],
      aiCreditsRoutingMode: 'off',
    });
  });

  it('drops policy-blocked candidates unless the policy read is degraded', async () => {
    mockBlocked.mockImplementation((model) =>
      Promise.resolve(model === CODEX_DEFAULT),
    );

    await expect(
      resolveCommitGenerationModelCandidates({
        preferences: preferencesFor('codex'),
        primaryModel: CLAUDE_PRIMARY,
      }),
    ).resolves.toMatchObject({
      model: CLAUDE_PRIMARY,
      fallbackModels: [CLAUDE_DEFAULT, HELPER_CREDITS_MODEL],
    });

    mockPolicyDegraded.mockReturnValue(true);
    await expect(
      resolveCommitGenerationModelCandidates({
        preferences: preferencesFor('codex'),
        primaryModel: CLAUDE_PRIMARY,
      }),
    ).resolves.toMatchObject({
      model: CLAUDE_PRIMARY,
      fallbackModels: [CODEX_DEFAULT, CLAUDE_DEFAULT, HELPER_CREDITS_MODEL],
    });
  });

  it('leaves the primary to the owner-scoped per-attempt policy gate', async () => {
    mockBlocked.mockImplementation((model) =>
      Promise.resolve(model === CLAUDE_PRIMARY || model === CODEX_DEFAULT),
    );

    await expect(
      resolveCommitGenerationModelCandidates({
        preferences: preferencesFor('codex'),
        primaryModel: CLAUDE_PRIMARY,
      }),
    ).resolves.toMatchObject({
      model: CLAUDE_PRIMARY,
      fallbackModels: [CLAUDE_DEFAULT, HELPER_CREDITS_MODEL],
    });
    expect(mockBlocked).not.toHaveBeenCalledWith(CLAUDE_PRIMARY);
  });

  it('checks fallback policy against the workspace owner', async () => {
    const owner = { kind: 'personal' } as const;
    mockWorkOwner.mockResolvedValue(owner);

    await resolveCommitGenerationModelCandidates({
      preferences: preferencesFor('codex'),
      primaryModel: CLAUDE_PRIMARY,
      workspaceId: 'project-a',
    });

    expect(mockWorkOwner).toHaveBeenCalledWith({ workspaceId: 'project-a' });
    expect(mockBlocked).toHaveBeenCalledWith(CODEX_DEFAULT, owner);
  });

  it('never throws: a failed policy read falls back to the primary alone', async () => {
    mockBlocked.mockRejectedValue(new Error('policy store unavailable'));

    await expect(
      resolveCommitGenerationModelCandidates({
        preferences: preferencesFor('codex'),
        primaryModel: CLAUDE_PRIMARY,
      }),
    ).resolves.toMatchObject({ model: CLAUDE_PRIMARY, fallbackModels: [] });
  });

  it('leaves out the AI Credits lane until the user has opted into AI Credits', async () => {
    await expect(
      resolveCommitGenerationModelCandidates({
        preferences: {
          ...preferencesFor('codex'),
          aiCreditsRoutingMode: 'off',
        },
        primaryModel: CLAUDE_PRIMARY,
      }),
    ).resolves.toMatchObject({
      model: CLAUDE_PRIMARY,
      fallbackModels: [CODEX_DEFAULT, CLAUDE_DEFAULT],
    });
  });

  it('adds the AI Credits lane in on-quota mode only once a native lane is exhausted', async () => {
    const onQuota: PreferencesData = {
      ...preferencesFor('codex'),
      aiCreditsRoutingMode: 'on-quota',
    };
    await expect(
      resolveCommitGenerationModelCandidates({
        preferences: onQuota,
        primaryModel: CLAUDE_PRIMARY,
      }),
    ).resolves.toMatchObject({
      model: CLAUDE_PRIMARY,
      fallbackModels: [CODEX_DEFAULT, CLAUDE_DEFAULT],
    });

    mockQuota.mockImplementation((provider) => provider === 'codex');
    const plan = await resolveCommitGenerationModelCandidates({
      preferences: onQuota,
      primaryModel: CLAUDE_PRIMARY,
    });
    expect(plan.fallbackModels).toContain(HELPER_CREDITS_MODEL);
  });

  it('keeps a local Ollama primary local, even before discovery', async () => {
    await expect(
      resolveCommitGenerationModelCandidates({
        preferences: preferencesFor('claude'),
        primaryModel: 'ollama-llama3',
      }),
    ).resolves.toMatchObject({ model: 'ollama-llama3', fallbackModels: [] });
  });

  it('skips the default of a selected provider that cannot run helpers', async () => {
    initClaudeModels([
      { id: CLAUDE_PRIMARY, label: 'Sonnet' },
      { id: CLAUDE_DEFAULT, label: 'Opus' },
      { id: 'cursor-composer-test', label: 'Cursor test' },
    ]);

    await expect(
      resolveCommitGenerationModelCandidates({
        preferences: preferencesFor('cursor', {
          cursor: { model: 'cursor-composer-test', thinkingLevel: 'high' },
        }),
        primaryModel: CLAUDE_PRIMARY,
      }),
    ).resolves.toMatchObject({
      model: CLAUDE_PRIMARY,
      fallbackModels: [CLAUDE_DEFAULT, CODEX_DEFAULT, HELPER_CREDITS_MODEL],
    });
  });

  it('warns when the configured primary is dropped as unknown', async () => {
    await expect(
      resolveCommitGenerationModelCandidates({
        preferences: preferencesFor('codex'),
        primaryModel: 'claude-removed-model',
      }),
    ).resolves.toMatchObject({
      model: CODEX_DEFAULT,
      fallbackModels: [CLAUDE_DEFAULT, HELPER_CREDITS_MODEL],
    });
    expect(jest.mocked(logMainProcessWarn)).toHaveBeenCalledWith(
      expect.stringContaining('claude-removed-model'),
    );
  });

  it('drops unknown ids and dedupes repeated candidates', async () => {
    await expect(
      resolveCommitGenerationModelCandidates({
        preferences: preferencesFor('codex', {
          claude: { model: 'claude-removed-model', thinkingLevel: 'high' },
        }),
        primaryModel: CODEX_DEFAULT,
      }),
    ).resolves.toMatchObject({
      model: CODEX_DEFAULT,
      fallbackModels: [HELPER_CREDITS_MODEL],
    });
  });

  it('dedupes an alias and its canonical id into one slot', async () => {
    initModelAliases({ 'codex-legacy-alias': CODEX_DEFAULT });
    try {
      await expect(
        resolveCommitGenerationModelCandidates({
          preferences: preferencesFor('codex', {
            claude: { model: 'claude-removed-model', thinkingLevel: 'high' },
          }),
          primaryModel: 'codex-legacy-alias',
        }),
      ).resolves.toMatchObject({
        model: 'codex-legacy-alias',
        fallbackModels: [HELPER_CREDITS_MODEL],
      });
    } finally {
      initModelAliases({});
    }
  });

  it('adds Claude then Codex defaults when Ollama is selected without a default', async () => {
    await expect(
      resolveCommitGenerationModelCandidates({
        preferences: preferencesFor('ollama'),
        primaryModel: CODEX_PRIMARY,
      }),
    ).resolves.toMatchObject({
      model: CODEX_PRIMARY,
      fallbackModels: [CLAUDE_DEFAULT, CODEX_DEFAULT, HELPER_CREDITS_MODEL],
    });
  });

  it('applies the cap after filtering so dropped candidates do not use slots', async () => {
    initCodexModels([
      { id: CODEX_PRIMARY, label: 'GPT 5.4' },
      { id: CODEX_DEFAULT, label: 'GPT 5.5' },
      { id: 'gpt-5.3-codex', label: 'GPT 5.3 Codex' },
      { id: HELPER_CREDITS_MODEL, label: 'Luna' },
      { id: 'deepseek-v4-pro', label: 'DeepSeek' },
    ]);
    mockBlocked.mockImplementation((model) =>
      Promise.resolve(model === CLAUDE_PRIMARY),
    );

    // Collected (6): gpt-5.4, sonnet (blocked), opus, gpt-5.3-codex,
    // deepseek, credits Codex default. Five survive; the cap keeps four, so
    // the blocked candidate ahead of them did not consume a slot.
    const plan = await resolveCommitGenerationModelCandidates({
      preferences: preferencesFor('ollama', {
        ollama: { model: CLAUDE_PRIMARY, thinkingLevel: 'high' },
        codex: { model: 'gpt-5.3-codex', thinkingLevel: 'high' },
      }),
      primaryModel: CODEX_PRIMARY,
    });

    expect(plan).toMatchObject({
      model: CODEX_PRIMARY,
      fallbackModels: [CLAUDE_DEFAULT, 'gpt-5.3-codex', 'deepseek-v4-pro'],
    });
    expect([plan.model, ...plan.fallbackModels]).not.toContain(CLAUDE_PRIMARY);
    // Lane members past the cap are routine and stay quiet.
    expect(jest.mocked(logMainProcessWarn)).not.toHaveBeenCalled();
  });

  it('warns when a quota-demoted configured model falls past the cap', async () => {
    initCodexModels([
      { id: CODEX_DEFAULT, label: 'GPT 5.5' },
      { id: 'gpt-5.3-codex', label: 'GPT 5.3 Codex' },
      { id: HELPER_CREDITS_MODEL, label: 'Luna' },
      { id: 'deepseek-v4-pro', label: 'DeepSeek' },
    ]);
    mockQuota.mockImplementation((provider) => provider === 'claude');

    const plan = await resolveCommitGenerationModelCandidates({
      preferences: preferencesFor('ollama', {
        ollama: { model: 'gpt-5.3-codex', thinkingLevel: 'high' },
      }),
      primaryModel: CLAUDE_PRIMARY,
    });

    expect([plan.model, ...plan.fallbackModels]).not.toContain(CLAUDE_PRIMARY);
    expect(jest.mocked(logMainProcessWarn)).toHaveBeenCalledWith(
      expect.stringContaining(
        `Configured commit model ${CLAUDE_PRIMARY} was quota-demoted past the candidate cap`,
      ),
    );
  });

  it('returns the primary alone when every candidate is filtered out', async () => {
    mockBlocked.mockResolvedValue(true);

    await expect(
      resolveCommitGenerationModelCandidates({
        preferences: preferencesFor('codex'),
        primaryModel: CLAUDE_PRIMARY,
      }),
    ).resolves.toMatchObject({ model: CLAUDE_PRIMARY, fallbackModels: [] });

    await expect(
      resolveCommitGenerationModelCandidates({
        preferences: preferencesFor('codex'),
        primaryModel: 'claude-removed-model',
      }),
    ).resolves.toMatchObject({
      model: 'claude-removed-model',
      fallbackModels: [],
    });
  });
});
