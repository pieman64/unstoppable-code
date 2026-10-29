import { AgentRunnerRegistry } from '../runner-registry';
import {
  projectAgentRoute,
  retainAgentRoute,
  validateAgentRoute,
} from '../route';
import { FakeRunner, routeFixture } from './fixtures';

describe('managed route snapshots and runner leases', () => {
  it('builds a public allowlist and detaches it from mutable route inputs', () => {
    const route = routeFixture({
      agentOverlay: {
        agentDefinitionId: 'agent-1',
        agentDefinitionRevision: '2',
        agentDefinitionHash: 'definition-hash',
        pluginProjectionHash: 'projection-hash',
        systemPromptAppend: 'Private agent instructions',
        artifact: {
          artifactId: 'artifact-1',
          formatVersion: 1,
          manifestHash: 'manifest-hash',
        },
      },
    });
    const summary = projectAgentRoute(route);
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain('private-account');
    expect(serialized).not.toContain('Private agent instructions');
    expect(serialized).not.toContain('artifact-1');
    expect(summary.agentOverlay).toEqual({
      agentDefinitionId: 'agent-1',
      agentDefinitionRevision: '2',
      agentDefinitionHash: 'definition-hash',
      pluginProjectionHash: 'projection-hash',
    });
    expect(summary.capabilities).not.toBe(route.capabilities);
    expect(Object.isFrozen(summary)).toBe(true);
    expect(Object.isFrozen(summary.capabilities)).toBe(true);
    expect(Object.isFrozen(summary.agentOverlay)).toBe(true);
  });

  it('keeps capability refs private and omits them from public routes', () => {
    const capabilityOverlay = {
      capabilityProjectionHash: 'a'.repeat(64),
      artifact: {
        artifactId: 'b'.repeat(64),
        formatVersion: 3 as const,
        manifestHash: 'b'.repeat(64),
      },
    };
    const retained = retainAgentRoute(routeFixture({ capabilityOverlay }));
    expect(retained.capabilityOverlay).toEqual(capabilityOverlay);
    expect(Object.isFrozen(retained.capabilityOverlay)).toBe(true);
    expect(Object.isFrozen(retained.capabilityOverlay?.artifact)).toBe(true);
    expect(projectAgentRoute(retained)).not.toHaveProperty('capabilityOverlay');
  });

  it('validates the exact selected route and explicit effort without clamping', () => {
    expect(
      validateAgentRoute('logical-review-model', 'low', routeFixture()),
    ).toEqual({ ok: true, value: 'low' });
    expect(
      validateAgentRoute('logical-review-model', 'medium', routeFixture()),
    ).toMatchObject({
      ok: false,
      error: { code: 'capability_unavailable' },
    });
    expect(
      validateAgentRoute('different-model', 'low', routeFixture()),
    ).toMatchObject({
      ok: false,
      error: { code: 'route_unavailable' },
    });
    expect(
      validateAgentRoute(
        'logical-review-model',
        undefined,
        routeFixture({ capabilities: ['unknown-read-extension'] }),
      ),
    ).toMatchObject({
      ok: false,
      error: { code: 'policy_blocked' },
    });
  });

  it('selects an exact runtime registration without falling back to another mode', () => {
    const registry = new AgentRunnerRegistry();
    const local = new FakeRunner('local-sdk');
    const remote = new FakeRunner('remote');
    registry.register({
      apiVersion: 1,
      registrationId: 'third-local',
      adapter: local,
    });
    registry.register({
      apiVersion: 1,
      registrationId: 'third-remote',
      adapter: remote,
    });
    expect(
      registry.acquire(routeFixture({ runtimeKind: 'remote' })),
    ).toMatchObject({ ok: false, error: { code: 'route_unavailable' } });
    expect(
      registry.acquire(routeFixture({ runnerRegistrationId: 'missing' })),
    ).toMatchObject({ ok: false, error: { code: 'route_unavailable' } });
    const result = registry.acquire(routeFixture());
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.adapter).toBe(local);
    result.value.release();
  });

  it('retains the control adapter after unregister until every lease releases', async () => {
    const registry = new AgentRunnerRegistry();
    const adapter = new FakeRunner('local-sdk');
    registry.register({
      apiVersion: 1,
      registrationId: 'third-local',
      adapter,
    });
    const result = registry.acquire(routeFixture());
    if (!result.ok) throw new Error(result.error.message);
    registry.unregister('third-local');
    expect(registry.acquire(routeFixture())).toMatchObject({ ok: false });
    await result.value.adapter.stop({ runId: 'child' }, 'parent_cancelled');
    await result.value.adapter.close({ runId: 'child' });
    expect(adapter.stopped).toEqual(['child']);
    expect(adapter.closed).toEqual(['child']);
    expect(() =>
      registry.register({
        apiVersion: 1,
        registrationId: 'third-local',
        adapter,
      }),
    ).toThrow();
    result.value.release();
    result.value.release();
    expect(() =>
      registry.register({
        apiVersion: 1,
        registrationId: 'third-local',
        adapter,
      }),
    ).not.toThrow();
  });

  it('rejects ambiguous enabled registrations and stale adapter versions', () => {
    const registry = new AgentRunnerRegistry();
    const adapter = new FakeRunner('local-sdk');
    registry.register({
      apiVersion: 1,
      registrationId: 'third-local',
      adapter,
    });
    expect(() =>
      registry.register({
        apiVersion: 1,
        registrationId: 'competing-local',
        adapter,
      }),
    ).toThrow();
    expect(
      registry.acquire(routeFixture({ adapterVersion: 'old' })),
    ).toMatchObject({ ok: false });
  });
});
