import {
  createDelegationProjection,
  type DelegationCapabilityDiscovery,
  type DelegationProjectionBroker,
  type DelegationTool,
} from '../projections';
import {
  DELEGATION_NOT_DESCENDANT_ERROR,
  type AgentDelegationResult,
  type AgentDelegationSnapshot,
  type DelegationCapabilityChoice,
  type GetDelegateOutputValue,
  type WatchDelegatesValue,
} from '@canopy/protocol/delegation';
import type { DelegationModelDiscovery } from '@canopy/protocol/delegation/discovery';
import type { DelegationParentContext } from '../types';

const parent: DelegationParentContext = {
  harnessId: 'claude',
  projectId: 'project',
  worktreeId: 'worktree',
  chatId: 'chat',
  sessionKey: 'project/worktree/chat',
  turnId: 'turn-1',
  toolCallId: 'call-1',
  runtimeGeneration: 1,
  depth: 0,
};

const snapshot: AgentDelegationSnapshot = {
  delegationId: 'delegation-1',
  status: 'pending',
  outputTruncated: false,
};

const delegationsFixture: readonly AgentDelegationSnapshot[] = [snapshot];

function capabilityId(fill: string): string {
  return `deferred:v1:${fill.repeat(43).slice(0, 43)}`;
}

const capabilitiesFixture: DelegationCapabilityDiscovery = {
  capabilities: [
    {
      id: capabilityId('A'),
      kind: 'skill',
      name: 'Formatting Skill',
      inherited: true,
      assignable: true,
    } satisfies DelegationCapabilityChoice,
  ],
};

const modelsFixture: DelegationModelDiscovery = {
  models: [
    {
      modelId: 'logical-review-model',
      label: 'Review Model',
      harnessId: 'claude',
      runtimeKind: 'local-sdk',
      supportedThinkingLevels: ['low'],
      capabilities: ['read'],
      availability: 'available',
      authState: 'ready',
    },
  ],
  truncated: false,
};

function stubBroker(): DelegationProjectionBroker {
  return {
    spawn: (): Promise<AgentDelegationResult<AgentDelegationSnapshot>> =>
      Promise.resolve({ ok: true, value: snapshot }),
    watch: (): Promise<AgentDelegationResult<WatchDelegatesValue>> =>
      Promise.resolve({
        ok: true,
        value: {
          watcherId: 'watcher-1',
          mode: 'any',
          deadlineAt: 0,
          targets: [],
        },
      }),
    getOutput: (): AgentDelegationResult<GetDelegateOutputValue> => ({
      ok: true,
      value: {
        delegationId: 'delegation-1',
        currentRunGeneration: 1,
        currentStatus: 'pending',
        latestResultIndex: null,
        result: null,
      },
    }),
    inspect: (): AgentDelegationSnapshot | undefined => snapshot,
    list: (): readonly AgentDelegationSnapshot[] => delegationsFixture,
    stop: (): AgentDelegationResult<AgentDelegationSnapshot> => ({
      ok: true,
      value: snapshot,
    }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function findTool(
  tools: readonly DelegationTool[],
  name: string,
): DelegationTool {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Expected a tool named ${name}`);
  return tool;
}

function schemaProperties(tool: DelegationTool): Record<string, unknown> {
  if (!isRecord(tool.inputSchema))
    throw new Error('Expected an object input schema');
  const properties = tool.inputSchema.properties;
  return isRecord(properties) ? properties : {};
}

const LIST_TOOL_NAME = 'test_list_delegates';
const SPAWN_TOOL_NAME = 'test_delegate_task';

describe('List Delegates capability discovery projection', () => {
  it('returns { delegations, capabilities } when includeCapabilities is requested alone', async () => {
    const projection = createDelegationProjection(
      'claude',
      'test',
      stubBroker(),
      {
        discoverCapabilities: (): Promise<DelegationCapabilityDiscovery> =>
          Promise.resolve(capabilitiesFixture),
      },
    );
    await expect(
      projection.invoke(parent, LIST_TOOL_NAME, { includeCapabilities: true }),
    ).resolves.toEqual({
      ok: true,
      value: {
        delegations: delegationsFixture,
        capabilities: capabilitiesFixture.capabilities,
      },
    });
  });

  it('returns both payloads when includeModels and includeCapabilities are both requested', async () => {
    const projection = createDelegationProjection(
      'claude',
      'test',
      stubBroker(),
      {
        discoverModels: (): Promise<DelegationModelDiscovery> =>
          Promise.resolve(modelsFixture),
        discoverCapabilities: (): Promise<DelegationCapabilityDiscovery> =>
          Promise.resolve(capabilitiesFixture),
      },
    );
    await expect(
      projection.invoke(parent, LIST_TOOL_NAME, {
        includeModels: true,
        includeCapabilities: true,
      }),
    ).resolves.toEqual({
      ok: true,
      value: {
        delegations: delegationsFixture,
        models: modelsFixture.models,
        truncated: modelsFixture.truncated,
        capabilities: capabilitiesFixture.capabilities,
      },
    });
  });

  it('returns the plain list for { includeCapabilities: false } and {}', async () => {
    const projection = createDelegationProjection(
      'claude',
      'test',
      stubBroker(),
      {
        discoverCapabilities: (): Promise<DelegationCapabilityDiscovery> =>
          Promise.resolve(capabilitiesFixture),
      },
    );
    await expect(
      projection.invoke(parent, LIST_TOOL_NAME, { includeCapabilities: false }),
    ).resolves.toEqual({ ok: true, value: delegationsFixture });
    await expect(
      projection.invoke(parent, LIST_TOOL_NAME, {}),
    ).resolves.toEqual({ ok: true, value: delegationsFixture });
  });

  it('rejects includeCapabilities when the discovery option was not supplied', async () => {
    const projection = createDelegationProjection(
      'claude',
      'test',
      stubBroker(),
    );
    await expect(
      projection.invoke(parent, LIST_TOOL_NAME, { includeCapabilities: true }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'invalid_request' } });
  });

  it('rejects an extra key alongside includeCapabilities', async () => {
    const projection = createDelegationProjection(
      'claude',
      'test',
      stubBroker(),
      {
        discoverCapabilities: (): Promise<DelegationCapabilityDiscovery> =>
          Promise.resolve(capabilitiesFixture),
      },
    );
    await expect(
      projection.invoke(parent, LIST_TOOL_NAME, {
        includeCapabilities: true,
        somethingElse: true,
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'invalid_request' } });
  });

  it('rejects a non-boolean includeCapabilities value', async () => {
    const projection = createDelegationProjection(
      'claude',
      'test',
      stubBroker(),
      {
        discoverCapabilities: (): Promise<DelegationCapabilityDiscovery> =>
          Promise.resolve(capabilitiesFixture),
      },
    );
    await expect(
      projection.invoke(parent, LIST_TOOL_NAME, {
        includeCapabilities: 'true',
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'invalid_request' } });
  });

  it('advertises includeCapabilities in the list inputSchema only when the option is given', () => {
    const without = createDelegationProjection('claude', 'test', stubBroker());
    const withCapabilities = createDelegationProjection(
      'claude',
      'test',
      stubBroker(),
      {
        discoverCapabilities: (): Promise<DelegationCapabilityDiscovery> =>
          Promise.resolve(capabilitiesFixture),
      },
    );
    const underDelegationId = { type: 'string', minLength: 1, maxLength: 256 };
    expect(schemaProperties(findTool(without.tools, LIST_TOOL_NAME))).toEqual({
      underDelegationId,
    });
    expect(
      schemaProperties(findTool(withCapabilities.tools, LIST_TOOL_NAME)),
    ).toEqual({ includeCapabilities: { type: 'boolean' }, underDelegationId });
  });
});

describe('delegation tree tools', () => {
  const nested: DelegationParentContext = {
    ...parent,
    depth: 1,
    parentDelegationId: 'delegation-self',
    parentRunGeneration: 1,
    parentDescription: 'Nested caller',
  };

  it('stops through the Stop Delegate tool as the parent, never as the user', async () => {
    const requestStop = jest.fn(
      (): Promise<AgentDelegationResult<AgentDelegationSnapshot>> =>
        Promise.resolve({ ok: true, value: snapshot }),
    );
    const stop = jest.fn(
      (): AgentDelegationResult<AgentDelegationSnapshot> => ({
        ok: true,
        value: snapshot,
      }),
    );
    await createDelegationProjection('claude', 'test', {
      ...stubBroker(),
      requestStop,
    }).invoke(parent, 'test_stop_delegate', { delegationId: 'delegation-1' });
    expect(requestStop).toHaveBeenCalledWith(
      parent,
      'delegation-1',
      'stopped_by_parent',
    );
    await createDelegationProjection('claude', 'test', {
      ...stubBroker(),
      stop,
    }).invoke(parent, 'test_stop_delegate', { delegationId: 'delegation-1' });
    expect(stop).toHaveBeenCalledWith(
      parent,
      'delegation-1',
      'stopped_by_parent',
    );
  });

  it('denies Inspect of an inaccessible delegation with the shared denial', async () => {
    const projection = createDelegationProjection('claude', 'test', {
      ...stubBroker(),
      inspect: (): AgentDelegationSnapshot | undefined => undefined,
    });
    await expect(
      projection.invoke(parent, 'test_inspect_delegate', {
        delegationId: 'delegation-2',
      }),
    ).resolves.toEqual({
      ok: false,
      error: DELEGATION_NOT_DESCENDANT_ERROR,
    });
  });

  it('walks one branch with underDelegationId and validates it strictly', async () => {
    const list = jest.fn(
      (): readonly AgentDelegationSnapshot[] => delegationsFixture,
    );
    const inspect = jest.fn(
      (
        _caller: DelegationParentContext,
        id: string,
      ): AgentDelegationSnapshot | undefined =>
        id === 'delegation-1' ? snapshot : undefined,
    );
    const projection = createDelegationProjection('claude', 'test', {
      ...stubBroker(),
      list,
      inspect,
    });
    await expect(
      projection.invoke(parent, LIST_TOOL_NAME, {
        underDelegationId: 'delegation-1',
      }),
    ).resolves.toEqual({ ok: true, value: delegationsFixture });
    expect(list).toHaveBeenLastCalledWith(parent, {
      underDelegationId: 'delegation-1',
    });
    // A nested caller may walk its own subtree by its own ID.
    await expect(
      projection.invoke(nested, LIST_TOOL_NAME, {
        underDelegationId: 'delegation-self',
      }),
    ).resolves.toEqual({ ok: true, value: delegationsFixture });
    expect(list).toHaveBeenLastCalledWith(nested, {
      underDelegationId: 'delegation-self',
    });
    await expect(
      projection.invoke(nested, LIST_TOOL_NAME, {
        underDelegationId: 'delegation-2',
      }),
    ).resolves.toEqual({ ok: false, error: DELEGATION_NOT_DESCENDANT_ERROR });
    for (const underDelegationId of ['', ' padded ', 'a'.repeat(257), 3, null])
      await expect(
        projection.invoke(parent, LIST_TOOL_NAME, { underDelegationId }),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: 'invalid_request' },
      });
    expect(list).toHaveBeenCalledTimes(2);
  });
});

describe('Spawn Delegate description', () => {
  it('mentions inherit_capabilities: false and includeCapabilities: true', () => {
    const projection = createDelegationProjection(
      'claude',
      'test',
      stubBroker(),
    );
    const spawnTool = findTool(projection.tools, SPAWN_TOOL_NAME);
    expect(spawnTool.description).toContain('inherit_capabilities: false');
    expect(spawnTool.description).toContain('includeCapabilities: true');
  });
});
