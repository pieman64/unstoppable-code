import type {
  AgentDelegationSpawnRequest,
  DelegationCapabilitySummary,
} from '@canopy/protocol/delegation';
import type {
  DelegationParentContext,
  ResolvedCapabilityOverlaySnapshot,
  ResolvedDelegationRoute,
} from '../types';
import {
  AgentDelegationBroker,
  type AgentDelegationBrokerOptions,
  type DelegationStorage,
  type StoredDelegation,
} from '../broker';
import { AgentRunnerRegistry } from '../runner-registry';
import { FakeRunner, routeFixture } from './fixtures';
import { retainAgentRoute } from '../route';
import {
  EMPTY_CAPABILITY_OVERLAY_HASH,
  MAX_CAPABILITY_EXTENSIONS_PER_RUN,
  type DelegationCapabilityGrant,
} from '../capability-grant';

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

const task: AgentDelegationSpawnRequest = {
  modelId: 'logical-review-model',
  description: 'Review the supplied task',
  prompt: 'Read src/index.ts and identify missing error handling.',
  executionMode: 'background',
  contextPolicy: 'task_only',
  isolation: 'shared_worktree',
};

class MemoryStorage implements DelegationStorage {
  readonly records = new Map<string, StoredDelegation>();
  readonly commits: StoredDelegation[] = [];
  fail = false;
  load(): Promise<readonly StoredDelegation[]> {
    return Promise.resolve(structuredClone(Array.from(this.records.values())));
  }
  commit(record: StoredDelegation): Promise<void> {
    if (this.fail)
      return Promise.reject(new Error('simulated storage failure'));
    const copy = structuredClone(record);
    this.records.set(copy.state.delegationId, copy);
    this.commits.push(copy);
    return Promise.resolve();
  }
}

function setup(
  storage = new MemoryStorage(),
  options: Partial<AgentDelegationBrokerOptions> = {},
): {
  broker: AgentDelegationBroker;
  runner: FakeRunner;
  storage: MemoryStorage;
} {
  const runner = new FakeRunner('local-sdk');
  const registry = new AgentRunnerRegistry();
  registry.register({
    apiVersion: 1,
    registrationId: 'third-local',
    adapter: runner,
  });
  const broker = new AgentDelegationBroker({
    storage,
    registry,
    cwd: '/test/worktree',
    capacity: 2,
    resolveRoute: (): Promise<{
      ok: true;
      value: ReturnType<typeof routeFixture>;
    }> => Promise.resolve({ ok: true, value: routeFixture() }),
    authorize: (): Promise<{ ok: true; value: undefined }> =>
      Promise.resolve({ ok: true, value: undefined }),
    ...options,
  });
  return { broker, runner, storage };
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

/** `deferred:v1:` plus 43 base64url characters — never hex. */
function capabilityId(fill: string): string {
  return `deferred:v1:${fill.repeat(43).slice(0, 43)}`;
}

function summaryFixture(
  overrides: Partial<DelegationCapabilitySummary> = {},
): DelegationCapabilitySummary {
  return {
    inherit: true,
    discovery: false,
    items: [],
    skipped: [],
    ...overrides,
  };
}

function grantFixture(
  overrides: Partial<DelegationCapabilityGrant> = {},
): DelegationCapabilityGrant {
  return {
    inherit: true,
    explicit: [],
    discovery: false,
    loaded: [],
    skipped: [],
    overlayHash: EMPTY_CAPABILITY_OVERLAY_HASH,
    summary: summaryFixture(),
    ...overrides,
  };
}

function overlayFixture(
  overrides: Partial<ResolvedCapabilityOverlaySnapshot> = {},
): ResolvedCapabilityOverlaySnapshot {
  return {
    capabilityProjectionHash: 'b'.repeat(64),
    artifact: {
      artifactId: 'overlay-artifact',
      formatVersion: 3,
      manifestHash: 'c'.repeat(64),
    },
    ...overrides,
  };
}

/** A running delegation with a persisted grant, ready for extendCapabilityGrant. */
async function setupRunningGrant(
  options: {
    grantOverrides?: Partial<DelegationCapabilityGrant>;
    brokerOverrides?: Partial<AgentDelegationBrokerOptions>;
  } = {},
): Promise<{
  broker: AgentDelegationBroker;
  runner: FakeRunner;
  storage: MemoryStorage;
  id: string;
  grant: DelegationCapabilityGrant;
  overlay: ResolvedCapabilityOverlaySnapshot;
}> {
  const overlay = overlayFixture();
  const grant = grantFixture({
    overlayHash: overlay.capabilityProjectionHash,
    ...options.grantOverrides,
  });
  const storage = new MemoryStorage();
  const { broker, runner } = setup(storage, {
    resolveRoute: (): Promise<{
      ok: true;
      value: ResolvedDelegationRoute;
    }> =>
      Promise.resolve({
        ok: true,
        value: {
          ...routeFixture(),
          capabilityOverlay: overlay,
          capabilityGrant: grant,
        },
      }),
    ...options.brokerOverrides,
  });
  await broker.initialize();
  const spawned = await broker.spawn(parent, task);
  if (!spawned.ok) throw new Error('Expected reservation');
  const id = spawned.value.delegationId;
  await flush();
  await runner.sink?.({
    delegationId: id,
    runGeneration: 1,
    sequence: 1,
    occurredAt: 1,
    event: { type: 'started', nativeSessionId: 'native-child' },
  });
  return { broker, runner, storage, id, grant, overlay };
}

describe('capability grant persistence and projection', () => {
  it.each([false, true])(
    'persists a resolved grant, projects only its summary, and drops it from the retained route (asyncAdmission: %s)',
    async (asyncAdmission) => {
      const secretExplicitId = capabilityId('1');
      const secretLoadedId = capabilityId('2');
      const secretSkippedId = capabilityId('3');
      const secretOverlayHash = 'a'.repeat(64);
      const grant = grantFixture({
        explicit: [secretExplicitId],
        discovery: true,
        loaded: [secretLoadedId],
        skipped: [{ id: secretSkippedId, reason: 'missing_selection' }],
        overlayHash: secretOverlayHash,
        summary: summaryFixture({
          discovery: true,
          items: [
            { kind: 'skill', name: 'Formatting Skill', source: 'explicit' },
          ],
          skipped: [
            {
              kind: 'plugin',
              name: 'Blocked Plugin',
              reason: 'missing_selection',
            },
          ],
        }),
      });
      const { broker, storage } = setup(new MemoryStorage(), {
        asyncAdmission,
        resolveRoute: (): Promise<{
          ok: true;
          value: ResolvedDelegationRoute;
        }> =>
          Promise.resolve({
            ok: true,
            value: { ...routeFixture(), capabilityGrant: grant },
          }),
      });
      await broker.initialize();
      try {
        const spawned = await broker.spawn(parent, task);
        if (!spawned.ok) throw new Error('Expected reservation');
        const id = spawned.value.delegationId;
        await flush();

        const record = storage.records.get(id);
        if (!record) throw new Error('Expected a persisted record');
        expect(record.capabilityGrant).toEqual(grant);
        if (!record.route) throw new Error('Expected a persisted route');
        expect('capabilityGrant' in record.route).toBe(false);

        const inspected = broker.inspect(parent, id);
        expect(inspected?.capabilities).toEqual(grant.summary);
        const listed = broker
          .list(parent)
          .find((entry) => entry.delegationId === id);
        expect(listed?.capabilities).toEqual(grant.summary);

        const serialized = JSON.stringify(inspected);
        for (const secret of [
          secretExplicitId,
          secretLoadedId,
          secretSkippedId,
          secretOverlayHash,
        ])
          expect(serialized).not.toContain(secret);
        expect(serialized).toContain('Formatting Skill');
      } finally {
        await broker.close();
      }
    },
  );

  it('leaves the record and snapshot unchanged when resolveRoute returns no grant', async () => {
    const { broker, storage } = setup();
    await broker.initialize();
    try {
      const spawned = await broker.spawn(parent, task);
      if (!spawned.ok) throw new Error('Expected reservation');
      const id = spawned.value.delegationId;
      await flush();

      const record = storage.records.get(id);
      if (!record) throw new Error('Expected a persisted record');
      expect('capabilityGrant' in record).toBe(false);

      const inspected = broker.inspect(parent, id);
      if (!inspected) throw new Error('Expected an inspectable snapshot');
      expect('capabilities' in inspected).toBe(false);
    } finally {
      await broker.close();
    }
  });
});

describe('follow-up continuation', () => {
  it('keeps the original grant even when resolveRoute returns a different one for the continuation', async () => {
    const grant1 = grantFixture({ explicit: [capabilityId('1')] });
    const grant2 = grantFixture({ explicit: [capabilityId('2')] });
    let calls = 0;
    const { broker, runner, storage } = setup(new MemoryStorage(), {
      resolveRoute: (): Promise<{
        ok: true;
        value: ResolvedDelegationRoute;
      }> => {
        calls += 1;
        return Promise.resolve({
          ok: true,
          value: {
            ...routeFixture({ capabilities: ['read', 'resume'] }),
            capabilityGrant: calls === 1 ? grant1 : grant2,
          },
        });
      },
    });
    await broker.initialize();
    try {
      const spawned = await broker.spawn(parent, task);
      if (!spawned.ok) throw new Error('Expected reservation');
      const id = spawned.value.delegationId;
      await flush();
      await runner.sink?.({
        delegationId: id,
        runGeneration: 1,
        sequence: 1,
        occurredAt: 1,
        event: { type: 'started', nativeSessionId: 'native-child' },
      });
      await runner.sink?.({
        delegationId: id,
        runGeneration: 1,
        sequence: 2,
        occurredAt: 2,
        event: { type: 'terminal', status: 'completed', finalText: 'Done' },
      });
      expect(storage.records.get(id)?.capabilityGrant).toEqual(grant1);

      expect(
        await broker.manage(
          { ...parent, toolCallId: 'follow-up' },
          {
            delegationId: id,
            operation: 'follow_up',
            message: 'Continue explicitly.',
          },
        ),
      ).toMatchObject({
        ok: true,
        value: { control: { status: 'completed' } },
      });
      await flush();

      expect(calls).toBe(2);
      expect(runner.starts).toHaveLength(2);
      expect(storage.records.get(id)?.capabilityGrant).toEqual(grant1);
    } finally {
      await broker.close();
    }
  });
});

describe('spawn requestHash sensitivity to capability fields', () => {
  it('produces a different requestHash for each distinct capability field', async () => {
    const { broker, storage } = setup(new MemoryStorage(), { capacity: 8 });
    await broker.initialize();
    try {
      const baseline = await broker.spawn(
        { ...parent, turnId: 't-base', toolCallId: 'c-base' },
        task,
      );
      const withoutInherit = await broker.spawn(
        { ...parent, turnId: 't-inherit', toolCallId: 'c-inherit' },
        { ...task, inheritCapabilities: false },
      );
      const withCapabilities = await broker.spawn(
        { ...parent, turnId: 't-capabilities', toolCallId: 'c-capabilities' },
        { ...task, capabilities: [capabilityId('9')] },
      );
      const withDiscovery = await broker.spawn(
        { ...parent, turnId: 't-discovery', toolCallId: 'c-discovery' },
        { ...task, allowCapabilityDiscovery: true },
      );
      if (
        !baseline.ok ||
        !withoutInherit.ok ||
        !withCapabilities.ok ||
        !withDiscovery.ok
      )
        throw new Error('Expected every reservation to succeed');

      const hashes = [
        baseline,
        withoutInherit,
        withCapabilities,
        withDiscovery,
      ].map((result) => {
        const record = storage.records.get(result.value.delegationId);
        if (!record) throw new Error('Expected a persisted record');
        return record.requestHash;
      });
      expect(new Set(hashes).size).toBe(hashes.length);
    } finally {
      await broker.close();
    }
  });

  it('rejects a retry of the same tool call identity that changes a capability field', async () => {
    const { broker } = setup();
    await broker.initialize();
    try {
      const caller = {
        ...parent,
        turnId: 'stable-turn',
        toolCallId: 'stable-call',
      };
      const first = await broker.spawn(caller, task);
      expect(first.ok).toBe(true);
      expect(
        await broker.spawn(caller, { ...task, inheritCapabilities: false }),
      ).toMatchObject({
        ok: false,
        error: {
          code: 'invalid_request',
          message: 'A delegation call cannot change its arguments.',
        },
      });
    } finally {
      await broker.close();
    }
  });
});

describe('capabilityContext', () => {
  it('returns the grant and retained route for a known delegation', async () => {
    const grant = grantFixture({ explicit: [capabilityId('7')] });
    const { broker } = setup(new MemoryStorage(), {
      resolveRoute: (): Promise<{
        ok: true;
        value: ResolvedDelegationRoute;
      }> =>
        Promise.resolve({
          ok: true,
          value: { ...routeFixture(), capabilityGrant: grant },
        }),
    });
    await broker.initialize();
    try {
      const spawned = await broker.spawn(parent, task);
      if (!spawned.ok) throw new Error('Expected reservation');
      const id = spawned.value.delegationId;
      await flush();

      const context = broker.capabilityContext(id);
      expect(context?.delegationId).toBe(id);
      expect(context?.runGeneration).toBe(1);
      expect(context?.grant).toEqual(grant);
      expect(context?.route).toEqual(retainAgentRoute(routeFixture()));
    } finally {
      await broker.close();
    }
  });

  it('returns undefined for an unknown delegation id', async () => {
    const { broker } = setup();
    await broker.initialize();
    try {
      expect(broker.capabilityContext('does-not-exist')).toBeUndefined();
    } finally {
      await broker.close();
    }
  });
});

describe('extendCapabilityGrant', () => {
  it('extends the grant while running: appends and dedupes loaded ids, replaces the overlay/hash/summary, bumps transcriptRevision, notifies the transcript, writes exactly once, and does not settle', async () => {
    const existingLoaded = capabilityId('4');
    const onTranscript = jest.fn();
    const onSettled = jest.fn(() => Promise.resolve());
    const { broker, storage, id } = await setupRunningGrant({
      grantOverrides: { loaded: [existingLoaded] },
      brokerOverrides: { onTranscript, onSettled },
    });
    try {
      const before = storage.records.get(id);
      if (!before) throw new Error('Expected a persisted record');
      const beforeRevision = before.transcriptRevision ?? 0;
      const commitsBefore = storage.commits.length;
      const newOverlay = overlayFixture({
        capabilityProjectionHash: 'd'.repeat(64),
      });
      const newLoaded = capabilityId('5');
      const newSummary = summaryFixture({
        discovery: true,
        items: [{ kind: 'skill', name: 'Reload Skill', source: 'loaded' }],
      });

      const result = await broker.extendCapabilityGrant({
        delegationId: id,
        runGeneration: 1,
        loaded: [existingLoaded, newLoaded],
        capabilityOverlay: newOverlay,
        overlayHash: newOverlay.capabilityProjectionHash,
        summary: newSummary,
      });

      expect(result).toMatchObject({ ok: true, extensions: 1 });
      if (!result.ok) throw new Error('Expected the extension to succeed');
      expect(result.grant.loaded).toEqual([existingLoaded, newLoaded]);
      expect(result.grant.overlayHash).toBe(
        newOverlay.capabilityProjectionHash,
      );
      expect(result.grant.summary).toEqual(newSummary);
      expect(result.route.capabilityOverlay).toEqual({
        capabilityProjectionHash: newOverlay.capabilityProjectionHash,
        artifact: newOverlay.artifact,
      });

      const record = storage.records.get(id);
      if (!record) throw new Error('Expected a persisted record');
      expect(record.state.runGeneration).toBe(1);
      expect(record.capabilityGrant?.loaded).toEqual([
        existingLoaded,
        newLoaded,
      ]);
      expect(record.transcriptRevision ?? 0).toBeGreaterThan(beforeRevision);
      expect(storage.commits.length).toBe(commitsBefore + 1);
      expect(onTranscript).toHaveBeenCalled();
      expect(onSettled).not.toHaveBeenCalled();
    } finally {
      await broker.close();
    }
  });

  it('removes the overlay when capabilityOverlay is undefined with the empty hash', async () => {
    const { broker, id } = await setupRunningGrant();
    try {
      const result = await broker.extendCapabilityGrant({
        delegationId: id,
        runGeneration: 1,
        loaded: [],
        capabilityOverlay: undefined,
        overlayHash: EMPTY_CAPABILITY_OVERLAY_HASH,
        summary: summaryFixture(),
      });
      expect(result).toMatchObject({ ok: true });
      if (!result.ok) throw new Error('Expected the extension to succeed');
      expect('capabilityOverlay' in result.route).toBe(false);
      expect(result.grant.overlayHash).toBe(EMPTY_CAPABILITY_OVERLAY_HASH);
    } finally {
      await broker.close();
    }
  });

  it('refuses an unknown delegation id', async () => {
    const { broker } = await setupRunningGrant();
    try {
      expect(
        await broker.extendCapabilityGrant({
          delegationId: 'does-not-exist',
          runGeneration: 1,
          loaded: [],
          capabilityOverlay: undefined,
          overlayHash: EMPTY_CAPABILITY_OVERLAY_HASH,
          summary: summaryFixture(),
        }),
      ).toEqual({ ok: false, reason: 'unknown_delegation' });
    } finally {
      await broker.close();
    }
  });

  it('refuses a delegation that has no grant', async () => {
    const { broker, runner } = setup();
    await broker.initialize();
    try {
      const spawned = await broker.spawn(parent, task);
      if (!spawned.ok) throw new Error('Expected reservation');
      const id = spawned.value.delegationId;
      await flush();
      await runner.sink?.({
        delegationId: id,
        runGeneration: 1,
        sequence: 1,
        occurredAt: 1,
        event: { type: 'started', nativeSessionId: 'native-child' },
      });
      expect(
        await broker.extendCapabilityGrant({
          delegationId: id,
          runGeneration: 1,
          loaded: [],
          capabilityOverlay: undefined,
          overlayHash: EMPTY_CAPABILITY_OVERLAY_HASH,
          summary: summaryFixture(),
        }),
      ).toEqual({ ok: false, reason: 'no_grant' });
    } finally {
      await broker.close();
    }
  });

  it('refuses a stale run generation', async () => {
    const { broker, id } = await setupRunningGrant();
    try {
      expect(
        await broker.extendCapabilityGrant({
          delegationId: id,
          runGeneration: 2,
          loaded: [],
          capabilityOverlay: undefined,
          overlayHash: EMPTY_CAPABILITY_OVERLAY_HASH,
          summary: summaryFixture(),
        }),
      ).toEqual({ ok: false, reason: 'generation_mismatch' });
    } finally {
      await broker.close();
    }
  });

  it('refuses once the delegation has settled', async () => {
    const { broker, runner, id } = await setupRunningGrant();
    try {
      await runner.sink?.({
        delegationId: id,
        runGeneration: 1,
        sequence: 2,
        occurredAt: 2,
        event: { type: 'terminal', status: 'completed', finalText: 'Done' },
      });
      expect(
        await broker.extendCapabilityGrant({
          delegationId: id,
          runGeneration: 1,
          loaded: [],
          capabilityOverlay: undefined,
          overlayHash: EMPTY_CAPABILITY_OVERLAY_HASH,
          summary: summaryFixture(),
        }),
      ).toEqual({ ok: false, reason: 'not_running' });
    } finally {
      await broker.close();
    }
  });

  it('refuses a malformed loaded capability id as invalid_request', async () => {
    const { broker, id } = await setupRunningGrant();
    try {
      expect(
        await broker.extendCapabilityGrant({
          delegationId: id,
          runGeneration: 1,
          loaded: ['not-a-valid-id'],
          capabilityOverlay: undefined,
          overlayHash: EMPTY_CAPABILITY_OVERLAY_HASH,
          summary: summaryFixture(),
        }),
      ).toEqual({ ok: false, reason: 'invalid_request' });
    } finally {
      await broker.close();
    }
  });

  it('refuses an overlayHash that does not match the supplied overlay as invalid_request', async () => {
    const { broker, id, overlay } = await setupRunningGrant();
    try {
      expect(
        await broker.extendCapabilityGrant({
          delegationId: id,
          runGeneration: 1,
          loaded: [],
          capabilityOverlay: overlay,
          overlayHash: 'f'.repeat(64),
          summary: summaryFixture(),
        }),
      ).toEqual({ ok: false, reason: 'invalid_request' });
    } finally {
      await broker.close();
    }
  });

  it('refuses an invalid summary as invalid_request', async () => {
    const { broker, id } = await setupRunningGrant();
    try {
      const invalidSummary: DelegationCapabilitySummary = {
        inherit: true,
        discovery: false,
        items: [{ kind: 'skill', name: 'bad\nname', source: 'agent' }],
        skipped: [],
      };
      expect(
        await broker.extendCapabilityGrant({
          delegationId: id,
          runGeneration: 1,
          loaded: [],
          capabilityOverlay: undefined,
          overlayHash: EMPTY_CAPABILITY_OVERLAY_HASH,
          summary: invalidSummary,
        }),
      ).toEqual({ ok: false, reason: 'invalid_request' });
    } finally {
      await broker.close();
    }
  });

  it('refuses a fourth successful extension in one run generation with reload_limit', async () => {
    const { broker, id } = await setupRunningGrant();
    try {
      for (
        let attempt = 1;
        attempt <= MAX_CAPABILITY_EXTENSIONS_PER_RUN;
        attempt += 1
      ) {
        const result = await broker.extendCapabilityGrant({
          delegationId: id,
          runGeneration: 1,
          loaded: [capabilityId(String(attempt))],
          capabilityOverlay: undefined,
          overlayHash: EMPTY_CAPABILITY_OVERLAY_HASH,
          summary: summaryFixture(),
        });
        expect(result).toMatchObject({ ok: true, extensions: attempt });
      }
      expect(
        await broker.extendCapabilityGrant({
          delegationId: id,
          runGeneration: 1,
          loaded: [capabilityId('9')],
          capabilityOverlay: undefined,
          overlayHash: EMPTY_CAPABILITY_OVERLAY_HASH,
          summary: summaryFixture(),
        }),
      ).toEqual({ ok: false, reason: 'reload_limit' });
    } finally {
      await broker.close();
    }
  });

  it('reports write_failed on a storage commit failure without consuming an extension slot', async () => {
    const { broker, storage, id } = await setupRunningGrant();
    try {
      storage.fail = true;
      expect(
        await broker.extendCapabilityGrant({
          delegationId: id,
          runGeneration: 1,
          loaded: [capabilityId('1')],
          capabilityOverlay: undefined,
          overlayHash: EMPTY_CAPABILITY_OVERLAY_HASH,
          summary: summaryFixture(),
        }),
      ).toEqual({ ok: false, reason: 'write_failed' });
      storage.fail = false;
      for (
        let attempt = 1;
        attempt <= MAX_CAPABILITY_EXTENSIONS_PER_RUN;
        attempt += 1
      ) {
        const result = await broker.extendCapabilityGrant({
          delegationId: id,
          runGeneration: 1,
          loaded: [capabilityId(String(attempt + 1))],
          capabilityOverlay: undefined,
          overlayHash: EMPTY_CAPABILITY_OVERLAY_HASH,
          summary: summaryFixture(),
        });
        expect(result).toMatchObject({ ok: true, extensions: attempt });
      }
    } finally {
      await broker.close();
    }
  });
});
