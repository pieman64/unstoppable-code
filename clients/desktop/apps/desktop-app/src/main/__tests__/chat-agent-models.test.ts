import {
  initClaudeModels,
  initCodexModels,
  initModelAliases,
} from '@canopy/desktop-shared/types';
import {
  AGENT_DEFAULT_BASE_MODEL,
  formatAgentRouteModelId,
} from '@canopy/protocol/agents';
import type { AgentModelDefinition } from '@canopy/desktop-shared/types/agent-models';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentArtifactStore } from '@canopy/desktop-shared/node/delegation/agent-artifacts';
import { projectAgentRoute } from '@canopy/desktop-shared/node/delegation';
import { routeFixture } from '@canopy/desktop-shared/node/delegation/__tests__/fixtures';
import { DelegationCapabilityAssignmentError } from '../agents/delegation/capability-grant';
import {
  resolveDelegationModel,
  resumeDelegationModel,
  type DelegationModelRuntimeHost,
} from '../agents/delegation-model-runtime';

const getAgentModel = jest.fn();

jest.mock('../agents/agent-model-store', () => ({
  getAgentModel: (...args: unknown[]): unknown =>
    getAgentModel(...args) as unknown,
}));

const resolveAgentDestinationDefaultModel = jest.fn();

jest.mock('../agents/agent-default-model', () => ({
  resolveAgentDestinationDefaultModel: (...args: unknown[]): unknown =>
    resolveAgentDestinationDefaultModel(...args) as unknown,
}));

import { resolveAgentModelRuntime } from '../agents/agent-model-runtime';

const BASE_MODEL = 'claude-agent-runtime-test';
const CODEX_MODEL = 'codex-agent-runtime-test';

function agent(
  overrides: Partial<AgentModelDefinition> = {},
): AgentModelDefinition {
  return {
    id: 'agent_model_reviewer',
    name: 'Reviewer',
    baseModel: BASE_MODEL,
    instructions: 'Review carefully.',
    pluginSelections: {
      collectionIds: ['agent-collection'],
      skillRefs: [{ sourceId: 'builtin', skillName: 'review' }],
      pluginRefs: [],
      mcpServerRefs: [{ serverId: 'server', configId: 'default' }],
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } satisfies AgentModelDefinition;
}

describe('resolveAgentModelRuntime', () => {
  beforeAll(() => {
    initClaudeModels([{ id: BASE_MODEL, label: 'Claude Agent Runtime Test' }]);
    initCodexModels([{ id: CODEX_MODEL, label: 'Codex Agent Runtime Test' }]);
  });

  beforeEach(() => {
    getAgentModel.mockReset();
    resolveAgentDestinationDefaultModel.mockReset();
  });

  it.each(['pinned', 'inherited'])(
    'migrates a retired %s Agent base before execution',
    async (kind) => {
      initCodexModels([{ id: 'gpt-6.1-sol', label: 'GPT 6.1 Sol' }]);
      initModelAliases({ 'gpt-5.5': 'gpt-6.1-sol' });
      getAgentModel.mockResolvedValue(
        agent({
          baseModel: kind === 'pinned' ? 'gpt-5.5' : AGENT_DEFAULT_BASE_MODEL,
        }),
      );
      const model =
        kind === 'pinned'
          ? 'agent_model_reviewer'
          : formatAgentRouteModelId('agent_model_reviewer', 'gpt-5.5');
      try {
        await expect(
          resolveAgentModelRuntime({ model }),
        ).resolves.toMatchObject({
          selectedModel: model,
          runtimeModel: 'gpt-6.1-sol',
          providerType: 'codex',
          executionHarness: 'codex',
        });
      } finally {
        initCodexModels([
          { id: CODEX_MODEL, label: 'Codex Agent Runtime Test' },
        ]);
        initModelAliases({});
      }
    },
  );

  it('leaves provider-native models unchanged', async () => {
    await expect(
      resolveAgentModelRuntime({ model: BASE_MODEL }),
    ).resolves.toMatchObject({
      selectedModel: BASE_MODEL,
      runtimeModel: BASE_MODEL,
      providerType: 'claude',
    });
    expect(getAgentModel).not.toHaveBeenCalled();
  });

  it('resolves agent models to the base model and merges prompt/plugins', async () => {
    getAgentModel.mockResolvedValue(agent());

    const resolved = await resolveAgentModelRuntime({
      model: 'agent_model_reviewer',
      systemPromptAppend: 'Existing prompt.',
      pluginSelections: {
        collectionIds: ['caller-collection'],
        skillRefs: [{ sourceId: 'builtin', skillName: 'lint' }],
        pluginRefs: [],
      },
    });

    expect(resolved.runtimeModel).toBe(BASE_MODEL);
    expect(resolved.providerType).toBe('claude');
    expect(resolved.systemPromptAppend).toBe(
      'Existing prompt.\n\nYou are now a user defined agent with these additional instructions: Review carefully.',
    );
    expect(resolved.pluginSelections).toEqual({
      collectionIds: ['caller-collection', 'agent-collection'],
      skillRefs: [
        { sourceId: 'builtin', skillName: 'lint' },
        { sourceId: 'builtin', skillName: 'review' },
      ],
      pluginRefs: [],
      mcpServerRefs: [{ serverId: 'server', configId: 'default' }],
      mcpHttpAuthPreferences: [],
    });
  });

  it('propagates main context denial before injecting agent instructions or selections', async () => {
    getAgentModel.mockRejectedValueOnce(
      new Error('Agent unavailable (context-mismatch)'),
    );
    await expect(
      resolveAgentModelRuntime({
        model: 'agent_model_reviewer',
        projectId: 'org-b-workspace',
      }),
    ).rejects.toThrow('context-mismatch');
    expect(getAgentModel).toHaveBeenCalledWith(
      'agent_model_reviewer',
      'org-b-workspace',
    );
  });

  it.each(['cursor-default', 'cursor:review-model%5B%5D'])(
    'preserves custom instructions and plugins on the Cursor route: %s',
    async (baseModel) => {
      const definition = agent({ baseModel });
      getAgentModel.mockResolvedValue(definition);
      const resolved = await resolveAgentModelRuntime({
        model: definition.id,
        systemPromptAppend: 'Existing instructions.',
      });
      expect(resolved).toMatchObject({
        selectedModel: definition.id,
        runtimeModel: baseModel,
        providerType: 'cursor',
        executionHarness: 'cursor',
        pluginSelections: definition.pluginSelections,
      });
      expect(resolved.systemPromptAppend).toBe(
        'Existing instructions.\n\nYou are now a user defined agent with these additional instructions: Review carefully.',
      );
    },
  );

  it('fails clearly when the selected agent is missing', async () => {
    getAgentModel.mockResolvedValue(null);

    await expect(
      resolveAgentModelRuntime({ model: 'agent_model_missing' }),
    ).rejects.toThrow(
      'Agent model "agent_model_missing" is not defined. Open Agents to create or import it, or choose another model.',
    );
  });

  it('fails clearly when the agent base model is stale', async () => {
    getAgentModel.mockResolvedValue(agent({ baseModel: 'missing-model' }));

    await expect(
      resolveAgentModelRuntime({ model: 'agent_model_reviewer' }),
    ).rejects.toThrow(
      'Agent "Reviewer" uses unavailable base model "missing-model". Edit the Agent or choose another model.',
    );
  });
});

describe('resolveAgentModelRuntime with an inherited default model', () => {
  const inheriting = (): AgentModelDefinition =>
    agent({ baseModel: AGENT_DEFAULT_BASE_MODEL });

  beforeEach(() => {
    getAgentModel.mockReset();
    resolveAgentDestinationDefaultModel.mockReset();
  });

  it('runs a bare inheriting Agent on its destination default', async () => {
    getAgentModel.mockResolvedValue(inheriting());
    resolveAgentDestinationDefaultModel.mockResolvedValue(CODEX_MODEL);

    const resolved = await resolveAgentModelRuntime({
      model: 'agent_model_reviewer',
      inheritDefaultFrom: { projectId: 'workspace-a' },
      systemPromptAppend: 'Existing prompt.',
      providerType: 'claude',
    });

    expect(resolveAgentDestinationDefaultModel).toHaveBeenCalledWith(
      'workspace-a',
    );
    expect(resolved).toMatchObject({
      selectedModel: 'agent_model_reviewer',
      runtimeModel: CODEX_MODEL,
      providerType: 'codex',
      executionHarness: 'codex',
      pluginSelections: inheriting().pluginSelections,
    });
    expect(resolved.systemPromptAppend).toBe(
      'Existing prompt.\n\nYou are now a user defined agent with these additional instructions: Review carefully.',
    );
  });

  it('never re-resolves the default for a chat turn', async () => {
    getAgentModel.mockResolvedValue(inheriting());
    await expect(
      resolveAgentModelRuntime({
        model: 'agent_model_reviewer',
        projectId: 'workspace-a',
      }),
    ).rejects.toThrow(
      'Agent "Reviewer" uses the default model, but this chat has no model yet. Choose the Agent again or choose another model.',
    );
    expect(resolveAgentDestinationDefaultModel).not.toHaveBeenCalled();
  });

  it('keeps a chat route on its retained base after the default changes', async () => {
    getAgentModel.mockResolvedValue(inheriting());
    resolveAgentDestinationDefaultModel.mockResolvedValue(CODEX_MODEL);
    const route = formatAgentRouteModelId('agent_model_reviewer', BASE_MODEL);

    const resolved = await resolveAgentModelRuntime({ model: route });

    expect(resolveAgentDestinationDefaultModel).not.toHaveBeenCalled();
    expect(getAgentModel).toHaveBeenCalledWith(
      'agent_model_reviewer',
      undefined,
    );
    expect(resolved).toMatchObject({
      selectedModel: route,
      runtimeModel: BASE_MODEL,
      providerType: 'claude',
      executionHarness: 'claude',
    });
    expect(resolved.agent?.id).toBe('agent_model_reviewer');
  });

  it("runs a route id for a pinned Agent on the Agent's own base", async () => {
    getAgentModel.mockResolvedValue(agent());
    const resolved = await resolveAgentModelRuntime({
      model: formatAgentRouteModelId('agent_model_reviewer', CODEX_MODEL),
    });
    expect(resolved).toMatchObject({
      runtimeModel: BASE_MODEL,
      providerType: 'claude',
    });
  });

  it('fails when the retained route base is no longer available', async () => {
    getAgentModel.mockResolvedValue(inheriting());
    await expect(
      resolveAgentModelRuntime({
        model: formatAgentRouteModelId('agent_model_reviewer', 'gone-model'),
      }),
    ).rejects.toThrow(
      'Agent "Reviewer" uses unavailable base model "gone-model". Edit the Agent or choose another model.',
    );
  });

  it('propagates a missing destination default instead of picking a provider', async () => {
    getAgentModel.mockResolvedValue(inheriting());
    resolveAgentDestinationDefaultModel.mockRejectedValue(
      new Error('No dispatchable model is available (billing-lane).'),
    );
    await expect(
      resolveAgentModelRuntime({
        model: 'agent_model_reviewer',
        inheritDefaultFrom: {},
      }),
    ).rejects.toThrow('No dispatchable model is available (billing-lane).');
  });

  it('refuses a destination default that is itself an Agent', async () => {
    getAgentModel.mockResolvedValue(inheriting());
    resolveAgentDestinationDefaultModel.mockResolvedValue('agent_model_other');
    await expect(
      resolveAgentModelRuntime({
        model: 'agent_model_reviewer',
        inheritDefaultFrom: {},
      }),
    ).rejects.toThrow(
      'Agent "Reviewer" uses the default model, but the default model is an Agent. Choose a provider model as the default in Settings, or choose a base model for this Agent.',
    );
  });
});

// Delegation captures a private route and retained projection at launch. Resume
// must not depend on the mutable Agent store or the current picker assignment.
describe('delegated Agent launch and resume', () => {
  let artifactDirectory: string;
  let host: DelegationModelRuntimeHost;

  beforeEach(async () => {
    initClaudeModels([{ id: BASE_MODEL, label: 'Claude Agent Runtime Test' }]);
    getAgentModel.mockReset();
    artifactDirectory = await mkdtemp(join(tmpdir(), 'delegated-agent-model-'));
    host = {
      artifacts: new AgentArtifactStore(artifactDirectory),
      lookupModel: jest.fn(() => ({
        id: BASE_MODEL,
        label: 'Hidden model',
        modelSource: 'claude-managed',
        defaultHarness: 'codex',
        enabled: true,
        selectable: false,
        supportedThinkingLevels: ['low', 'high'],
      })),
      captureRoute: jest.fn((runtime) =>
        Promise.resolve({
          ok: true,
          value: routeFixture({
            selectedModelId: runtime.selectedModel,
            runtimeModelId: runtime.runtimeModel,
            harnessId: runtime.executionHarness,
            providerType: runtime.providerType,
          }),
        }),
      ),
      authorize: jest.fn().mockResolvedValue({ ok: true, value: undefined }),
      materializeCapabilities: jest.fn().mockResolvedValue({
        pluginFiles: {
          'skills/review/SKILL.md': 'Original review instructions.',
        },
        capabilities: {
          claudePluginRoots: ['skills/review'],
          claudeSkillNames: ['review:review'],
          codexCapabilityRoots: ['skills/review'],
          mcpSelections: [],
          mcpHttpAuthPreferences: [],
          hookDeclarations: [],
        },
        provenance: {
          roots: { 'skills/review': 'agent' },
          mcpSelections: [],
        },
        items: [],
      }),
    };
    getAgentModel.mockResolvedValue(
      agent({
        contentHash: 'a'.repeat(64),
        pluginSelections: { collectionIds: [], skillRefs: [], pluginRefs: [] },
      }),
    );
  });

  afterEach(async () => {
    await rm(artifactDirectory, { recursive: true, force: true });
  });

  // Phase 0 (docs/planning/2026-09-25-delegation-capabilities/02-capability-grant.md):
  // capabilities separate from Agent identity, so a plain (non-Agent) model
  // can also carry a capability overlay.
  it('resumes a version 3 capability-only overlay on a plain-model route', async () => {
    host.materializeCapabilities = jest.fn().mockResolvedValue({
      pluginFiles: {
        'skills/tools/SKILL.md': 'Standalone capability instructions.',
      },
      capabilities: {
        claudePluginRoots: ['skills/tools'],
        claudeSkillNames: ['tools:tools'],
        codexCapabilityRoots: [],
        mcpSelections: [],
        mcpHttpAuthPreferences: [],
        hookDeclarations: [],
      },
      provenance: {
        roots: { 'skills/tools': 'inherited' },
        mcpSelections: [],
      },
      items: [],
    });

    const launched = await resolveDelegationModel(BASE_MODEL, undefined, host);
    expect(launched.ok).toBe(true);
    if (!launched.ok) return;
    expect(getAgentModel).not.toHaveBeenCalled();
    expect(launched.value.route.agentOverlay).toBeUndefined();
    expect(launched.value.route.capabilityOverlay).toBeDefined();
    expect(launched.value.projection).toBeUndefined();
    expect(launched.value.capabilities?.pluginFiles).toEqual({
      'skills/tools/SKILL.md': 'Standalone capability instructions.',
    });
    expect(launched.value.capabilities?.capabilities.claudePluginRoots).toEqual(
      ['skills/tools'],
    );
    expect(launched.value.capabilities?.provenance.roots).toEqual({
      'skills/tools': 'inherited',
    });

    const resumedHost = {
      ...host,
      artifacts: new AgentArtifactStore(artifactDirectory),
    };
    const resumed = await resumeDelegationModel(
      launched.value.route,
      resumedHost,
    );
    expect(resumed).toEqual(launched);
  });

  it('resumes a legacy v2 Agent route whose capabilities are embedded in the Agent artifact, with provenance "agent"', async () => {
    const legacyOverlay = await host.artifacts.retain({
      agentDefinitionId: 'agent_model_reviewer',
      agentDefinitionRevision: 'legacy-1',
      agentDefinitionHash: 'b'.repeat(64),
      systemPromptAppend: 'Legacy embedded instructions.',
      pluginFiles: { 'skills/legacy/SKILL.md': 'Legacy skill body.' },
      toolNames: ['read', 'search'],
      capabilities: {
        claudePluginRoots: ['skills/legacy'],
        claudeSkillNames: ['legacy:legacy'],
        codexCapabilityRoots: [],
        mcpSelections: [],
        mcpHttpAuthPreferences: [],
        hookDeclarations: [],
      },
    });
    const legacyRoute = routeFixture({
      selectedModelId: 'agent_model_reviewer',
      runtimeModelId: BASE_MODEL,
      harnessId: 'claude',
      providerType: 'claude',
      agentOverlay: legacyOverlay,
    });

    const resumed = await resumeDelegationModel(legacyRoute, host);

    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.value.route.capabilityOverlay).toBeUndefined();
    expect(resumed.value.projection?.pluginFiles).toEqual({
      'skills/legacy/SKILL.md': 'Legacy skill body.',
    });
    expect(resumed.value.capabilities?.pluginFiles).toEqual({
      'skills/legacy/SKILL.md': 'Legacy skill body.',
    });
    expect(resumed.value.capabilities?.capabilities.claudePluginRoots).toEqual([
      'skills/legacy',
    ]);
    expect(resumed.value.capabilities?.provenance.roots).toEqual({
      'skills/legacy': 'agent',
    });
    expect(host.materializeCapabilities).not.toHaveBeenCalled();
  });

  // Phase 2 (docs/planning/2026-09-25-delegation-capabilities/02-capability-grant.md
  // §"An explicit assignment is bounded..."): an ungrantable or unusable
  // capability layer fails the spawn with capability_unavailable and the
  // item's own safe public message, never a raw ID or path.
  it('fails the spawn with capability_unavailable and no leaked ID when a capability layer cannot be assigned', async () => {
    const rejection = new DelegationCapabilityAssignmentError(
      'The plugin "Reviewer Tools" can\'t be given to this delegate: you can only assign plugins, skills and MCP servers you have yourself.',
    );
    host.materializeCapabilities = jest.fn().mockRejectedValue(rejection);

    const result = await resolveDelegationModel(BASE_MODEL, undefined, host);

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'capability_unavailable',
        message: rejection.publicMessage,
      },
    });
    expect(getAgentModel).not.toHaveBeenCalled();
  });

  it('launches and resumes from the verified artifact after Agent deletion and assignment changes', async () => {
    const launched = await resolveDelegationModel(
      'agent_model_reviewer',
      'low',
      host,
    );
    expect(launched.ok).toBe(true);
    if (!launched.ok) return;
    expect(launched.value.route).toMatchObject({
      selectedModelId: 'agent_model_reviewer',
      runtimeModelId: BASE_MODEL,
      harnessId: 'claude',
      requestedThinkingLevel: 'low',
      effectiveThinkingLevel: 'low',
    });
    expect(launched.value.projection?.pluginFiles).toEqual({});
    expect(launched.value.capabilities?.pluginFiles).toEqual({
      'skills/review/SKILL.md': 'Original review instructions.',
    });
    expect(launched.value.capabilities?.capabilities.claudePluginRoots).toEqual(
      ['skills/review'],
    );
    expect(Object.isFrozen(launched.value.route)).toBe(true);
    getAgentModel.mockResolvedValue(null);
    initClaudeModels([]);
    const resumedHost = {
      ...host,
      artifacts: new AgentArtifactStore(artifactDirectory),
    };
    const resumed = await resumeDelegationModel(
      launched.value.route,
      resumedHost,
    );
    expect(resumed).toEqual(launched);
    expect(getAgentModel).toHaveBeenCalledTimes(1);
    expect(host.captureRoute).toHaveBeenCalledTimes(1);
    expect(host.materializeCapabilities).toHaveBeenCalledTimes(1);
    expect(host.authorize).toHaveBeenCalledTimes(2);
    expect(host.authorize).toHaveBeenLastCalledWith(launched.value.route);
    expect(
      JSON.stringify(projectAgentRoute(launched.value.route)),
    ).not.toContain('Original review');
  });

  it('launches an inheriting Agent on the parent default and resumes that route', async () => {
    getAgentModel.mockResolvedValue(
      agent({
        baseModel: AGENT_DEFAULT_BASE_MODEL,
        contentHash: 'a'.repeat(64),
        pluginSelections: { collectionIds: [], skillRefs: [], pluginRefs: [] },
      }),
    );
    resolveAgentDestinationDefaultModel
      .mockReset()
      .mockResolvedValue(BASE_MODEL);
    const launched = await resolveDelegationModel(
      'agent_model_reviewer',
      'low',
      host,
      'cowork-parent',
    );
    expect(resolveAgentDestinationDefaultModel).toHaveBeenCalledWith(
      'cowork-parent',
    );
    expect(launched.ok).toBe(true);
    if (!launched.ok) return;
    expect(launched.value.route).toMatchObject({
      selectedModelId: 'agent_model_reviewer',
      runtimeModelId: BASE_MODEL,
      harnessId: 'claude',
    });
    // Resume replays the retained route; a changed default is never consulted.
    resolveAgentDestinationDefaultModel.mockResolvedValue(CODEX_MODEL);
    await expect(
      resumeDelegationModel(launched.value.route, host),
    ).resolves.toEqual(launched);
    expect(resolveAgentDestinationDefaultModel).toHaveBeenCalledTimes(1);
  });

  it('fails closed when a retained projection is missing or changed', async () => {
    const launched = await resolveDelegationModel(
      'agent_model_reviewer',
      'high',
      host,
    );
    expect(launched.ok).toBe(true);
    if (!launched.ok || !launched.value.route.agentOverlay) return;
    const artifact = launched.value.route.agentOverlay.artifact;
    await writeFile(
      join(artifactDirectory, `${artifact.artifactId}.json`),
      '{}',
    );
    expect(
      await resumeDelegationModel(launched.value.route, host),
    ).toMatchObject({
      ok: false,
      error: { code: 'route_unavailable' },
    });
    expect(host.materializeCapabilities).toHaveBeenCalledTimes(1);
    expect(host.authorize).toHaveBeenCalledTimes(1);
  });

  it('rechecks current authority and denies a revoked account without re-resolving billing', async () => {
    const launched = await resolveDelegationModel(
      'agent_model_reviewer',
      undefined,
      host,
    );
    expect(launched.ok).toBe(true);
    if (!launched.ok) return;
    const authorize = jest.fn().mockResolvedValue({
      ok: false as const,
      error: {
        code: 'auth_required' as const,
        message: 'Account is unavailable.',
        retryable: false,
      },
    });
    expect(
      await resumeDelegationModel(launched.value.route, { ...host, authorize }),
    ).toMatchObject({
      ok: false,
      error: { code: 'auth_required' },
    });
    expect(authorize).toHaveBeenCalledWith(launched.value.route);
    expect(host.captureRoute).toHaveBeenCalledTimes(1);
  });

  it('rejects unsupported thinking levels and inconsistent captured model identities', async () => {
    expect(
      await resolveDelegationModel('agent_model_reviewer', 'ultra', host),
    ).toMatchObject({
      ok: false,
      error: { code: 'capability_unavailable' },
    });
    const captureRoute: DelegationModelRuntimeHost['captureRoute'] = () =>
      Promise.resolve({
        ok: true,
        value: routeFixture({ selectedModelId: 'different-model' }),
      });
    expect(
      await resolveDelegationModel('agent_model_reviewer', 'low', {
        ...host,
        captureRoute,
      }),
    ).toMatchObject({
      ok: false,
      error: { code: 'route_unavailable' },
    });
    expect(host.authorize).not.toHaveBeenCalled();
  });

  it('blocks a disabled historical base model while preserving its stored route', async () => {
    const launched = await resolveDelegationModel(
      'agent_model_reviewer',
      undefined,
      host,
    );
    expect(launched.ok).toBe(true);
    if (!launched.ok) return;
    const model = host.lookupModel(BASE_MODEL);
    const lookupModel = jest.fn(() => model && { ...model, enabled: false });
    expect(
      await resumeDelegationModel(launched.value.route, {
        ...host,
        lookupModel,
      }),
    ).toMatchObject({
      ok: false,
      error: { code: 'route_unavailable' },
    });
    expect(host.captureRoute).toHaveBeenCalledTimes(1);
  });
});
