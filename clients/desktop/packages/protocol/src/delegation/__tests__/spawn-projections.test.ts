import { parseAgentDelegationSpawnRequest } from '../index';
import {
  CLAUDE_DELEGATION_SPAWN_SCHEMA,
  CODEX_DELEGATION_SPAWN_SCHEMA,
  parseClaudeDelegationSpawn,
  parseCodexDelegationSpawn,
} from '../spawn-projections';

describe('independent managed parent projections', () => {
  it('preserves configured Agent identities through both provider projections', () => {
    for (const result of [
      parseClaudeDelegationSpawn({
        model: 'agent_model_reviewer',
        description: 'Review',
        prompt: 'Inspect the change',
      }),
      parseCodexDelegationSpawn({
        model: 'agent_model_reviewer',
        task_name: 'review',
        message: 'Inspect the change',
      }),
    ]) {
      expect(result).toMatchObject({
        ok: true,
        value: { modelId: 'agent_model_reviewer' },
      });
    }
  });

  it.each([true, false])(
    'preserves explicit nested delegation opt-in %s on both surfaces',
    (enabled) => {
      for (const result of [
        parseClaudeDelegationSpawn({
          model: 'logical',
          description: 'review',
          prompt: 'Inspect',
          allow_nested_delegation: enabled,
        }),
        parseCodexDelegationSpawn({
          model: 'logical',
          task_name: 'review',
          message: 'Inspect',
          allow_nested_delegation: enabled,
        }),
      ])
        expect(result).toMatchObject({
          ok: true,
          value: { allowNestedDelegation: enabled },
        });
    },
  );

  it('maps capability and queued-admission grants from both harnesses', () => {
    const capabilities = [`deferred:v1:${'b'.repeat(43)}`];
    for (const result of [
      parseClaudeDelegationSpawn({
        model: 'logical',
        description: 'review',
        prompt: 'Inspect',
        inherit_capabilities: false,
        capabilities,
        allow_capability_discovery: true,
        if_busy: 'reject',
      }),
      parseCodexDelegationSpawn({
        model: 'logical',
        task_name: 'review',
        message: 'Inspect',
        inherit_capabilities: false,
        capabilities,
        allow_capability_discovery: true,
        if_busy: 'reject',
      }),
    ])
      expect(result).toMatchObject({
        ok: true,
        value: {
          inheritCapabilities: false,
          capabilities,
          allowCapabilityDiscovery: true,
          ifBusy: 'reject',
        },
      });
  });

  it('rejects invalid capability and admission grants on both harnesses', () => {
    for (const common of [
      { inherit_capabilities: 'false' },
      { allow_capability_discovery: 1 },
      { capabilities: ['not-a-deferred-id'] },
      { capabilities: [`deferred:v1:${'b'.repeat(64)}`] },
      { if_busy: 'later' },
    ]) {
      expect(
        parseClaudeDelegationSpawn({
          model: 'logical',
          description: 'review',
          prompt: 'Inspect',
          ...common,
        }).ok,
      ).toBe(false);
      expect(
        parseCodexDelegationSpawn({
          model: 'logical',
          task_name: 'review',
          message: 'Inspect',
          ...common,
        }).ok,
      ).toBe(false);
    }
  });

  it.each([null, 1, 'true', {}, []])(
    'rejects invalid nesting opt-in %p',
    (value) => {
      expect(
        parseCodexDelegationSpawn({
          model: 'logical',
          task_name: 'review',
          message: 'Inspect',
          allow_nested_delegation: value,
        }).ok,
      ).toBe(false);
    },
  );

  it('does not grant nesting when omitted and rejects forged lineage', () => {
    const input = {
      modelId: 'logical',
      description: 'review',
      prompt: 'Inspect',
    };
    const result = parseAgentDelegationSpawnRequest(input);
    expect(result.ok && result.value.allowNestedDelegation === true).toBe(
      false,
    );
    for (const field of ['depth', 'parentDelegationId']) {
      expect(
        parseAgentDelegationSpawnRequest({ ...input, [field]: 1 }).ok,
      ).toBe(false);
    }
  });
  const claude = {
    model: 'logical',
    description: 'review',
    prompt: 'Inspect the file',
    name: 'review',
    thinking_level: 'low',
  };
  const codex = {
    model: 'logical',
    task_name: 'review',
    message: 'Inspect the file',
    reasoning_effort: 'low',
  };

  it('exposes explicit thinking aliases and normalizes both surfaces to the same request', () => {
    expect(
      CLAUDE_DELEGATION_SPAWN_SCHEMA.properties.thinking_level.enum,
    ).toContain('low');
    expect(
      CODEX_DELEGATION_SPAWN_SCHEMA.properties.reasoning_effort.enum,
    ).toContain('low');
    expect(parseClaudeDelegationSpawn(claude)).toEqual(
      parseCodexDelegationSpawn(codex),
    );
    expect(parseCodexDelegationSpawn(codex)).toEqual(
      parseAgentDelegationSpawnRequest({
        modelId: 'logical',
        name: 'review',
        description: 'review',
        prompt: 'Inspect the file',
        thinkingLevel: 'low',
      }),
    );
  });

  it.each([
    'harnessId',
    'runtimeModelId',
    'authAccountKey',
    'billingAuthority',
    'cwd',
    'parentChatId',
    'fork_turns',
    'permissionMode',
    'pluginSelections',
    'systemPromptAppend',
    'agentOverlay',
  ])('rejects model-supplied authority %s on both surfaces', (field) => {
    expect(
      parseClaudeDelegationSpawn({ ...claude, [field]: 'forged' }).ok,
    ).toBe(false);
    expect(parseCodexDelegationSpawn({ ...codex, [field]: 'forged' }).ok).toBe(
      false,
    );
  });

  it('accepts optional worktree isolation and rejects unsupported context', () => {
    expect(
      parseClaudeDelegationSpawn({ ...claude, isolation: 'worktree' }),
    ).toMatchObject({ ok: true, value: { isolation: 'worktree' } });
    expect(
      parseCodexDelegationSpawn({ ...codex, context: 'fork' }),
    ).toMatchObject({ ok: false, error: { code: 'capability_unavailable' } });
  });

  it('keeps explicit foreground separate from invalid false-like values', () => {
    expect(
      parseClaudeDelegationSpawn({ ...claude, run_in_background: false }),
    ).toMatchObject({ ok: true, value: { executionMode: 'foreground' } });
    expect(
      parseClaudeDelegationSpawn({ ...claude, run_in_background: null }).ok,
    ).toBe(false);
  });
});

it('preserves explicit bounded write grants independently of scheduling and isolation', () => {
  const permissions = { writePaths: ['src/example.ts'] };
  expect(
    parseClaudeDelegationSpawn({
      model: 'logical',
      description: 'Edit',
      prompt: 'Edit source',
      permissions,
      isolation: 'shared_worktree',
      run_in_background: false,
    }),
  ).toMatchObject({
    ok: true,
    value: { permissions, isolation: 'shared_worktree' },
  });
  expect(
    parseCodexDelegationSpawn({
      model: 'logical',
      task_name: 'edit',
      message: 'Edit source',
      permissions,
      isolation: 'worktree',
    }),
  ).toMatchObject({ ok: true, value: { permissions, isolation: 'worktree' } });
});

it.each([true, false])(
  'accepts explicit fast mode %s from either parent',
  (fastMode) => {
    for (const result of [
      parseClaudeDelegationSpawn({
        model: 'codex',
        description: 'Review',
        prompt: 'Inspect',
        fast_mode: fastMode,
      }),
      parseCodexDelegationSpawn({
        model: 'codex',
        task_name: 'review',
        message: 'Inspect',
        fast_mode: fastMode,
      }),
    ])
      expect(result).toMatchObject({ ok: true, value: { fastMode } });
  },
);
it.each(['true', 1, null])('rejects invalid fast mode %s', (fast_mode) => {
  expect(
    parseCodexDelegationSpawn({
      model: 'codex',
      task_name: 'review',
      message: 'Inspect',
      fast_mode,
    }),
  ).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
});

describe('lifetime refusal copy', () => {
  it('distinguishes the lifetime gate from transient concurrency queueing in both schemas', () => {
    for (const schema of [
      CLAUDE_DELEGATION_SPAWN_SCHEMA,
      CODEX_DELEGATION_SPAWN_SCHEMA,
    ]) {
      expect(schema.properties.if_busy.description).toContain(
        'concurrency limit',
      );
      expect(schema.properties.if_busy.description).toContain(
        'lifetime_limit_reached',
      );
    }
  });
});
