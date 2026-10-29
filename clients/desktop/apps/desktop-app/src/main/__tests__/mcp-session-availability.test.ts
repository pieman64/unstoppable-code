import {
  McpSessionAvailability,
  type McpSessionBinding,
} from '../mcp/session-availability';
import type { McpCapabilityIdentity } from '@canopy/protocol/mcp-servers';

const target: McpCapabilityIdentity = {
  kind: 'standalone',
  serverId: 'server',
  configId: 'config',
};
const binding: McpSessionBinding = {
  ownerId: 'owner',
  scope: { projectId: 'project', worktreeId: 'worktree', chatId: 'chat' },
  sessionId: 'session',
  provider: 'claude',
  generation: 1,
};
const facts = {
  identity: target,
  selected: true,
  enabled: true,
  permitted: true,
  authRequirement: 'unknown' as const,
};
const ready = {
  kind: 'tools' as const,
  identity: target,
  initialized: true as const,
  complete: true as const,
  toolCount: 1,
};

describe('McpSessionAvailability', () => {
  let availability: McpSessionAvailability;
  beforeEach(() => {
    availability = new McpSessionAvailability();
    availability.begin(binding, [facts]);
  });

  it('does not infer readiness or authentication from selection', () => {
    expect(availability.snapshot(binding)).toMatchObject([
      {
        availability: 'connecting',
        authRequirement: 'unknown',
        reasonCode: 'unchecked',
      },
    ]);
  });

  it.each([
    { ...binding, ownerId: 'other' },
    { ...binding, sessionId: 'other' },
    { ...binding, provider: 'codex' as const },
    { ...binding, generation: 0 },
    { ...binding, scope: { ...binding.scope, chatId: 'other' } },
  ])(
    'rejects evidence belonging to another owner/session/generation/chat',
    (other) => {
      expect(availability.observe(other, ready)).toBe(false);
      expect(availability.snapshot(binding)[0]?.availability).toBe(
        'connecting',
      );
    },
  );

  it('waits for all required targets and ignores unrelated startup failures', async () => {
    const plugin: McpCapabilityIdentity = {
      kind: 'plugin',
      marketplaceId: 'marketplace',
      pluginName: 'plugin',
      serverName: 'server',
    };
    const account: McpCapabilityIdentity = {
      kind: 'account',
      connectionId: 'connection',
      configId: 'config',
    };
    const next = { ...binding, generation: 2 };
    availability.begin(next, [
      facts,
      { ...facts, identity: plugin },
      { ...facts, identity: account },
    ]);
    availability.observe(next, {
      kind: 'unavailable',
      identity: account,
      reasonCode: 'startup_failed',
    });
    const pending = availability.waitForRequiredTargets(
      next,
      [target, plugin],
      { timeoutMs: 1000 },
    );
    availability.observe(next, ready);
    availability.observe(next, { ...ready, identity: plugin });
    await expect(pending).resolves.toMatchObject({
      kind: 'ready',
      statuses: [{ identity: target }, { identity: plugin }],
    });
  });

  it('treats a tools-only server as ready and zero tools as unavailable', async () => {
    availability.observe(binding, { ...ready, toolCount: 0 });
    await expect(
      availability.waitForRequiredTargets(binding, [target], {
        timeoutMs: 100,
      }),
    ).resolves.toMatchObject({ kind: 'failed', reasonCode: 'no_tools' });
    availability.observe(binding, ready);
    expect(availability.snapshot(binding)[0]?.availability).toBe('ready');
  });

  it('invalidates evidence and cancels waits when generation changes', async () => {
    const pending = availability.waitForRequiredTargets(binding, [target], {
      timeoutMs: 1000,
    });
    const next = { ...binding, generation: 2 };
    availability.begin(next, [facts]);
    await expect(pending).resolves.toMatchObject({ kind: 'cancelled' });
    expect(availability.observe(binding, ready)).toBe(false);
    expect(availability.snapshot(next)[0]?.availability).toBe('connecting');
    expect(availability.begin(binding, [facts])).toBe(false);
  });

  it('makes auth waiting explicit without changing provider-managed auth', async () => {
    const next = { ...binding, generation: 2 };
    availability.begin(next, [
      { ...facts, authRequirement: 'provider_managed' },
    ]);
    availability.observe(next, { kind: 'auth_required', identity: target });
    await expect(
      availability.waitForRequiredTargets(next, [target], { timeoutMs: 100 }),
    ).resolves.toMatchObject({
      kind: 'awaiting_auth',
      statuses: [{ authRequirement: 'provider_managed' }],
    });
  });

  it('bounds waits and releases subscriptions on Stop and session cleanup', async () => {
    const controller = new AbortController();
    const pending = availability.waitForRequiredTargets(binding, [target], {
      timeoutMs: 1000,
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).resolves.toMatchObject({ kind: 'cancelled' });
    await expect(
      availability.waitForRequiredTargets(binding, [target], { timeoutMs: 0 }),
    ).resolves.toMatchObject({ kind: 'failed', reasonCode: 'timeout' });
    expect(availability.clear(binding)).toBe(true);
    expect(availability.observe(binding, ready)).toBe(false);
  });

  it('never exposes mutable evidence to consumers', () => {
    availability.observe(binding, ready);
    const snapshot = availability.snapshot(binding);
    snapshot[0].availability = 'connecting';
    expect(availability.snapshot(binding)[0]?.availability).toBe('ready');
  });
});
