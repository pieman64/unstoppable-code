import type { LedgerScopeSyncRecord } from '@canopy/desktop-shared/node/ledger';
import type {
  LedgerCommandReceipt,
  LedgerContainer,
  LedgerGlobalOwner,
} from '@canopy/protocol/canopy-core';
import type {
  LedgerSyncPushRequest,
  LedgerSyncPushResponse,
  LedgerWriterSession,
} from '@canopy/protocol/ledger-sync';
import type { LedgerSyncResult } from '../sync-client';
import type { LedgerSyncAccount, LedgerWorkspaceOwner } from '../sync-policy';
import {
  LEDGER_SYNC_LOCAL_CHANGE_DELAY_MS,
  LEDGER_SYNC_PERIODIC_CHECK_MS,
  LEDGER_SYNC_POLICY_CHANGE_DELAY_MS,
  LEDGER_SYNC_STARTUP_DELAY_MS,
  LedgerSyncService,
  type LedgerSyncDiagnostic,
  type LedgerSyncTimer,
} from '../sync-service';
import {
  FAKE_MIRROR_ORGANIZATION_ID,
  FakeLedgerMirror,
} from './fixtures/fake-ledger-mirror';
import {
  TEST_CONTAINER,
  TEST_CONTAINER_CREATED_AT,
  createLedgerServiceHarness,
  type LedgerServiceHarness,
} from './fixtures/in-process-ledger-store-client';

const ACCOUNT_ID = '00000000-0000-4000-8000-0000000000c1';
const OTHER_ACCOUNT_ID = '00000000-0000-4000-8000-0000000000c2';
const GUEST_ACCOUNT_ID = '00000000-0000-4000-8000-0000000000c3';
const PROJECT_ID = '00000000-0000-4000-8000-0000000000b2';
const START_MS = Date.parse('2026-10-01T12:00:00.000Z');
const HOUR_MS = 60 * 60 * 1000;
/**
 * Two batches take 101 events, written an entry at a time through the core
 * service: on a loaded machine, more than the default 5 seconds.
 */
const TWO_BATCH_TIMEOUT_MS = 30_000;

const SESSION: LedgerWriterSession = {
  deviceId: 'device-1',
  installationGeneration: 1,
  nonce: '00000000-0000-4000-8000-0000000000d1',
};
const NEXT_LAUNCH: LedgerWriterSession = {
  ...SESSION,
  nonce: '00000000-0000-4000-8000-0000000000d2',
};
const OTHER_DEVICE: LedgerWriterSession = {
  deviceId: 'device-2',
  installationGeneration: 1,
  nonce: '00000000-0000-4000-8000-0000000000d3',
};

const SECOND_CONTAINER: LedgerContainer = {
  kind: 'code_worktree',
  workspaceId: 'workspace-2',
  worktreeId: 'worktree-2',
};
const SECOND_CONTAINER_CREATED_AT = '2026-09-02T08:00:00.000Z';

const ORGANIZATION_PROJECT: LedgerWorkspaceOwner = {
  kind: 'organization',
  organizationId: FAKE_MIRROR_ORGANIZATION_ID,
  projectId: PROJECT_ID,
};

function account(
  overrides: Partial<LedgerSyncAccount> = {},
): LedgerSyncAccount {
  return {
    id: ACCOUNT_ID,
    organizationIds: new Set([FAKE_MIRROR_ORGANIZATION_ID]),
    lapsedOrganizationIds: new Set(),
    summaries: 'private',
    summariesProhibited: false,
    ...overrides,
  };
}

interface ScheduledTimer {
  readonly id: number;
  readonly dueAt: number;
  readonly run: () => void;
}

/** A clock and a timer queue the test moves by hand. */
class ManualTimers {
  now = START_MS;
  private nextId = 1;
  private readonly scheduled = new Map<number, ScheduledTimer>();

  readonly setTimer = (run: () => void, delayMs: number): LedgerSyncTimer => {
    const id = this.nextId;
    this.nextId += 1;
    this.scheduled.set(id, { id, dueAt: this.now + delayMs, run });
    return {
      cancel: (): void => {
        this.scheduled.delete(id);
      },
    };
  };

  /** How long until each scheduled timer fires, soonest first. */
  delays(): number[] {
    return Array.from(this.scheduled.values())
      .map((timer) => timer.dueAt - this.now)
      .sort((left, right) => left - right);
  }

  /** Fires the soonest timer due by `until`; false when there is none. */
  fireNext(until: number): boolean {
    let soonest: ScheduledTimer | null = null;
    for (const timer of Array.from(this.scheduled.values())) {
      if (
        timer.dueAt <= until &&
        (soonest === null || timer.dueAt < soonest.dueAt)
      ) {
        soonest = timer;
      }
    }
    if (soonest === null) return false;
    this.scheduled.delete(soonest.id);
    this.now = Math.max(this.now, soonest.dueAt);
    soonest.run();
    return true;
  }
}

/** Lets every pending microtask and I/O callback run. */
function settleTasks(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

interface SyncHarness {
  readonly ledger: LedgerServiceHarness;
  readonly mirror: FakeLedgerMirror;
  readonly timers: ManualTimers;
  account: LedgerSyncAccount | null;
  session: LedgerWriterSession | null;
  enabled: boolean;
  databaseExists: boolean;
  /** Workspace owners by workspace ID; Personal when absent. */
  readonly owners: Map<string, LedgerWorkspaceOwner>;
  readonly changed: LedgerContainer[];
  readonly diagnostics: LedgerSyncDiagnostic[];
  prohibitedReports: number;
  /** Whether the mirror advertises `ledger-global-v1`. */
  globalSupported: boolean;
  /** Each capability check, by whether it asked the mirror afresh. */
  readonly globalChecks: boolean[];
  service: LedgerSyncService;
  /** Runs every timer due within `ms`, letting the service settle after each. */
  advance(ms: number): Promise<void>;
  /** Fires the timers due within `ms` without waiting for the service. */
  fireTimers(ms: number): void;
  /** Stops the service and starts a new one on the same store and mirror. */
  restart(): Promise<void>;
  addEntry(container?: LedgerContainer, title?: string | null): Promise<string>;
  /** Adds an entry as a pipeline agent of the owner's global Ledger. */
  addGlobalEntry(owner: LedgerGlobalOwner): Promise<string>;
  scopeSync(ledgerId: string): Promise<LedgerScopeSyncRecord>;
  dispose(): Promise<void>;
}

const CONTAINER_CREATED_AT = new Map<string, string>([
  [JSON.stringify(TEST_CONTAINER), TEST_CONTAINER_CREATED_AT],
  [JSON.stringify(SECOND_CONTAINER), SECOND_CONTAINER_CREATED_AT],
]);

function createSyncHarness(): SyncHarness {
  const timers = new ManualTimers();
  const ledger = createLedgerServiceHarness({
    accountId: ACCOUNT_ID,
    store: { now: (): Date => new Date(timers.now) },
  });
  const mirror = new FakeLedgerMirror();
  mirror.now = (): number => timers.now;
  const principals = new Map<string, string>();
  let requestKeys = 0;

  const createService = (): LedgerSyncService =>
    new LedgerSyncService({
      store: () => ledger.store.client,
      mirror,
      isEnabled: () => harness.enabled,
      databaseExists: () => Promise.resolve(harness.databaseExists),
      readAccount: () => Promise.resolve(harness.account),
      readSession: () => Promise.resolve(harness.session),
      readWorkspaceOwner: (container) =>
        Promise.resolve(
          container.kind === 'global'
            ? { kind: 'unknown' }
            : (harness.owners.get(
                container.kind === 'advisor_entry'
                  ? container.appWorkspaceId
                  : container.workspaceId,
              ) ?? { kind: 'personal' }),
        ),
      supportsGlobalScopes: ({ live }): Promise<boolean> => {
        harness.globalChecks.push(live);
        // Asked afresh, a mirror that rolled back no longer advertises it.
        return Promise.resolve(
          harness.globalSupported &&
            !(live && harness.mirror.refusesGlobalScopes),
        );
      },
      onScopeSyncChanged: (container): void => {
        harness.changed.push(container);
      },
      onProhibited: (): void => {
        harness.prohibitedReports += 1;
      },
      recordDiagnostic: (diagnostic): void => {
        harness.diagnostics.push(diagnostic);
      },
      now: () => timers.now,
      random: () => 0,
      setTimer: timers.setTimer,
    });

  const harness: SyncHarness = {
    ledger,
    mirror,
    timers,
    account: account(),
    session: SESSION,
    enabled: true,
    databaseExists: true,
    owners: new Map(),
    changed: [],
    diagnostics: [],
    prohibitedReports: 0,
    globalSupported: true,
    globalChecks: [],
    service: createService(),
    async advance(ms: number): Promise<void> {
      const until = timers.now + ms;
      while (timers.fireNext(until)) {
        await harness.service.whenIdle();
      }
      timers.now = until;
    },
    fireTimers(ms: number): void {
      const until = timers.now + ms;
      while (timers.fireNext(until)) {
        // Fired; the service is not waited for.
      }
      timers.now = until;
    },
    async restart(): Promise<void> {
      await harness.service.stop();
      harness.service = createService();
    },
    async addEntry(
      container: LedgerContainer = TEST_CONTAINER,
      title: string | null = 'Plan the storage work',
    ): Promise<string> {
      const key = JSON.stringify(container);
      let principal = principals.get(key);
      if (principal === undefined) {
        principal = ledger.register({
          container,
          containerCreatedAt:
            CONTAINER_CREATED_AT.get(key) ?? TEST_CONTAINER_CREATED_AT,
        });
        principals.set(key, principal);
      }
      requestKeys += 1;
      const receipt: LedgerCommandReceipt = await ledger.service.addEntry(
        {
          type: 'TASK',
          ...(title === null ? {} : { title }),
          content: 'Write the plan.',
          _meta: { idempotencyKey: `key-${String(requestKeys)}` },
        },
        ledger.context(principal, `key-${String(requestKeys)}`),
      );
      return receipt.entry.scope.ledgerId;
    },
    async addGlobalEntry(owner: LedgerGlobalOwner): Promise<string> {
      const scope = await ledger.service.scopes.resolveGlobal(owner);
      const principal = ledger.register({
        container: scope.container,
        containerCreatedAt: scope.containerCreatedAt,
        role: 'pipeline_agent',
        actor: {
          kind: 'pipeline_agent',
          originKey: 'session-global',
          displayName: 'Triage · Nightly',
        },
        origin: {
          kind: 'pipeline_agent',
          executionId: 'execution-global',
          physicalJobId: 'triage',
          logicalJobId: 'triage',
          stepId: 'triage',
          attempt: 1,
          iteration: 1,
          agentSessionId: 'session-global',
        },
      });
      requestKeys += 1;
      const receipt = await ledger.service.addEntry(
        {
          type: 'OBSERVATION',
          title: 'Nightly triage',
          content: 'Three flaky specs.',
          _meta: { idempotencyKey: `key-${String(requestKeys)}` },
        },
        ledger.context(principal, `key-${String(requestKeys)}`),
      );
      return receipt.entry.scope.ledgerId;
    },
    async scopeSync(ledgerId: string): Promise<LedgerScopeSyncRecord> {
      const record = await ledger.store.client.getScopeSync(ledgerId);
      if (record === null) throw new Error(`No scope ${ledgerId}`);
      return record;
    },
    async dispose(): Promise<void> {
      await harness.service.stop();
      ledger.dispose();
    },
  };
  return harness;
}

describe('LedgerSyncService', () => {
  let harness: SyncHarness;

  beforeEach(() => {
    harness = createSyncHarness();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  /** Starts the service and runs its first pass. */
  async function startAndSync(): Promise<void> {
    harness.service.start();
    await harness.advance(LEDGER_SYNC_STARTUP_DELAY_MS);
  }

  async function syncAfterPolicyChange(): Promise<void> {
    harness.service.requestSync('policy');
    await harness.advance(LEDGER_SYNC_POLICY_CHANGE_DELAY_MS);
  }

  async function syncAfterLocalChange(): Promise<void> {
    harness.service.requestSync('local_change');
    await harness.advance(LEDGER_SYNC_LOCAL_CHANGE_DELAY_MS);
  }

  /**
   * An organization project's scope with 101 events to send, so two batches,
   * shared with the organization.
   */
  async function addTwoBatchesForTheOrganization(): Promise<string> {
    harness.account = account({ summaries: 'organization' });
    harness.owners.set('workspace-1', ORGANIZATION_PROJECT);
    // The first entry writes 4 events, and each one after it 1.
    const ledgerId = await harness.addEntry();
    for (let index = 0; index < 97; index += 1) {
      await harness.addEntry(TEST_CONTAINER, `Task ${String(index)}`);
    }
    return ledgerId;
  }

  describe('scheduling', () => {
    it('reads and sends nothing until its first scheduled check', async () => {
      await harness.addEntry();
      harness.service.start();
      // Changes during startup wait for the startup check.
      harness.service.requestSync('policy');
      harness.service.requestSync('local_change');

      expect(harness.timers.delays()).toEqual([LEDGER_SYNC_STARTUP_DELAY_MS]);
      expect(harness.ledger.store.client.callCount('listSyncScopes')).toBe(0);
      expect(harness.mirror.calls).toEqual([]);
    });

    it('does nothing while the flag is off or before the database exists', async () => {
      const ledgerId = await harness.addEntry();
      harness.enabled = false;
      await startAndSync();
      harness.enabled = true;
      harness.databaseExists = false;
      await syncAfterPolicyChange();

      expect(harness.ledger.store.client.callCount('listSyncScopes')).toBe(0);
      expect(harness.mirror.calls).toEqual([]);

      harness.databaseExists = true;
      await syncAfterPolicyChange();

      expect(harness.mirror.heldSequences(ledgerId)).toEqual([1, 2, 3, 4]);
    });

    it('cancels a push in flight when it stops, keeping the outbox', async () => {
      const ledgerId = await harness.addEntry();
      harness.mirror.holdPushes();
      harness.service.start();
      harness.fireTimers(LEDGER_SYNC_STARTUP_DELAY_MS);
      await settleTasks();
      expect(harness.mirror.pushes).toHaveLength(1);

      await harness.service.stop();

      expect((await harness.scopeSync(ledgerId)).acknowledgedSequence).toBe(
        '0',
      );
      expect(
        (await harness.ledger.store.client.getStorageCounts()).outbox,
      ).toBe(4);
      expect(harness.timers.delays()).toEqual([]);
    });
  });

  describe('pending titles', () => {
    it('holds a contiguous scope suffix without retrying or blocking another scope, then pushes the final title at revision one', async () => {
      const ledgerId = await harness.addEntry(TEST_CONTAINER, null);
      await harness.addEntry(TEST_CONTAINER, 'Later task');
      const otherLedgerId = await harness.addEntry(SECOND_CONTAINER);
      const [pending] = await harness.ledger.store.client.listPendingTitles();
      if (pending === undefined) throw new Error('Expected pending title');

      await startAndSync();

      expect(harness.mirror.heldSequences(ledgerId)).toEqual([1, 2, 3]);
      expect(harness.mirror.heldSequences(otherLedgerId)).toEqual([1, 2, 3, 4]);
      expect((await harness.scopeSync(ledgerId)).repairReason).toBeNull();
      expect(harness.diagnostics).toEqual([]);
      expect(harness.timers.delays()).toEqual([LEDGER_SYNC_PERIODIC_CHECK_MS]);
      const pushes = harness.mirror.pushes.length;
      await harness.advance(LEDGER_SYNC_PERIODIC_CHECK_MS);
      expect(harness.mirror.pushes).toHaveLength(pushes);
      expect(harness.diagnostics).toEqual([]);

      await harness.ledger.store.client.resolvePendingTitle({
        entryId: pending.entryId,
        title: 'A generated plan',
      });
      await syncAfterLocalChange();

      expect(harness.mirror.heldSequences(ledgerId)).toEqual([1, 2, 3, 4, 5]);
      const revisions = harness.mirror.pushes
        .filter((request) => request.ledgerId === ledgerId)
        .flatMap((request) => request.events)
        .filter((event) => event.kind === 'entry_revision');
      expect(revisions).toHaveLength(2);
      expect(revisions[0]?.payload).toMatchObject({
        entry: {
          entryId: pending.entryId,
          title: 'A generated plan',
          revision: 1,
        },
      });
      expect((await harness.scopeSync(ledgerId)).repairReason).toBeNull();
    });

    it('releases the scope with the provisional title after null resolution', async () => {
      const ledgerId = await harness.addEntry(TEST_CONTAINER, null);
      const [pending] = await harness.ledger.store.client.listPendingTitles();
      if (pending === undefined) throw new Error('Expected pending title');
      await startAndSync();
      expect(harness.mirror.heldSequences(ledgerId)).toEqual([1, 2, 3]);

      await harness.ledger.store.client.resolvePendingTitle({
        entryId: pending.entryId,
        title: null,
      });
      await syncAfterLocalChange();

      expect(harness.mirror.heldSequences(ledgerId)).toEqual([1, 2, 3, 4]);
      const revisionEvent = harness.mirror.pushes
        .flatMap((request) => request.events)
        .find((event) => event.kind === 'entry_revision');
      expect(revisionEvent?.payload).toMatchObject({
        entry: { title: 'Write the plan.', revision: 1 },
      });
    });
  });

  describe('audience (LD01, LD02)', () => {
    it('registers a Personal workspace privately even with organization sharing', async () => {
      harness.account = account({ summaries: 'organization' });
      const ledgerId = await harness.addEntry();

      await startAndSync();

      expect(harness.mirror.registrations).toHaveLength(1);
      const [registration] = harness.mirror.registrations;
      expect(registration).toEqual({
        schemaVersion: 1,
        ledgerId,
        accountId: ACCOUNT_ID,
        scopeKind: 'code_worktree',
        session: SESSION,
        audience: { kind: 'private' },
      });
      expect(harness.mirror.heldSequences(ledgerId)).toEqual([1, 2, 3, 4]);
      const record = await harness.scopeSync(ledgerId);
      expect(record.acknowledgedSequence).toBe('4');
      expect(record.mirrorAudience).toEqual({ kind: 'private' });
      expect(
        (await harness.ledger.store.client.getStorageCounts()).outbox,
      ).toBe(0);
      expect(harness.changed).toContainEqual(TEST_CONTAINER);
    });

    it('registers an organization project with its organization', async () => {
      harness.account = account({ summaries: 'organization' });
      harness.owners.set('workspace-1', ORGANIZATION_PROJECT);
      const ledgerId = await harness.addEntry();

      await startAndSync();

      expect(harness.mirror.registrations[0]?.audience).toEqual({
        kind: 'organization',
        trackedWorkspaceId: PROJECT_ID,
      });
      expect((await harness.scopeSync(ledgerId)).mirrorAudience).toEqual({
        kind: 'organization',
        organizationId: FAKE_MIRROR_ORGANIZATION_ID,
        trackedWorkspaceId: PROJECT_ID,
        expiresAt: new Date(
          START_MS + LEDGER_SYNC_STARTUP_DELAY_MS + 72 * HOUR_MS,
        ).toISOString(),
      });
    });

    it('keeps a scope on this device while sharing is off', async () => {
      harness.account = account({ summaries: 'off' });
      await harness.addEntry();

      await startAndSync();

      expect(harness.mirror.calls).toEqual([]);
      await expect(harness.service.holdFor(ACCOUNT_ID)).resolves.toBe(
        'local_only',
      );
    });

    it('never uploads under a prohibition', async () => {
      harness.account = account({
        summaries: 'organization',
        summariesProhibited: true,
      });
      await harness.addEntry();

      await startAndSync();

      expect(harness.mirror.calls).toEqual([]);
      await expect(harness.service.holdFor(ACCOUNT_ID)).resolves.toBe(
        'policy_restricted',
      );
    });

    it('narrows an organization audience before any further push', async () => {
      harness.account = account({ summaries: 'organization' });
      harness.owners.set('workspace-1', ORGANIZATION_PROJECT);
      const ledgerId = await harness.addEntry();
      await startAndSync();
      harness.mirror.calls.length = 0;

      harness.account = account({ summaries: 'private' });
      await harness.addEntry(TEST_CONTAINER, 'Second task');
      await expect(
        harness.service.isAudienceChangePending({
          ledgerId,
          accountId: ACCOUNT_ID,
          container: TEST_CONTAINER,
        }),
      ).resolves.toBe(true);
      harness.service.requestSync('local_change');
      await syncAfterPolicyChange();

      expect(harness.mirror.calls).toEqual([
        { kind: 'register', ledgerId, audience: 'private' },
        { kind: 'push', ledgerId, sequences: [5, 5] },
      ]);
      await expect(
        harness.service.isAudienceChangePending({
          ledgerId,
          accountId: ACCOUNT_ID,
          container: TEST_CONTAINER,
        }),
      ).resolves.toBe(false);
    });

    it('narrows first after an offline restart', async () => {
      harness.account = account({ summaries: 'organization' });
      harness.owners.set('workspace-1', ORGANIZATION_PROJECT);
      const ledgerId = await harness.addEntry();
      await startAndSync();

      // Narrowed while offline: the change cannot be sent.
      harness.account = account({ summaries: 'private' });
      await harness.addEntry(TEST_CONTAINER, 'Second task');
      harness.mirror.failNextRegister({ kind: 'retry' });
      await syncAfterPolicyChange();
      expect(harness.mirror.pushes).toHaveLength(1);

      harness.session = NEXT_LAUNCH;
      await harness.restart();
      harness.mirror.calls.length = 0;
      await startAndSync();

      expect(harness.mirror.calls).toEqual([
        { kind: 'register', ledgerId, audience: 'private' },
        { kind: 'push', ledgerId, sequences: [5, 5] },
      ]);
    });

    it('narrows a held scope that an organization can still read', async () => {
      harness.account = account({ summaries: 'organization' });
      harness.owners.set('workspace-1', ORGANIZATION_PROJECT);
      const ledgerId = await harness.addEntry();
      await startAndSync();
      harness.mirror.calls.length = 0;

      harness.account = account({ summaries: 'off' });
      await harness.addEntry(TEST_CONTAINER, 'Second task');
      await syncAfterPolicyChange();

      expect(harness.mirror.calls).toEqual([
        { kind: 'register', ledgerId, audience: 'private' },
      ]);
      expect((await harness.scopeSync(ledgerId)).acknowledgedSequence).toBe(
        '4',
      );
    });

    it('reconfirms an organization audience every 6 hours while online', async () => {
      harness.account = account({ summaries: 'organization' });
      harness.owners.set('workspace-1', ORGANIZATION_PROJECT);
      const ledgerId = await harness.addEntry();
      await startAndSync();
      harness.mirror.calls.length = 0;

      await harness.advance(6 * HOUR_MS - 1);
      expect(harness.mirror.calls).toEqual([]);

      await harness.advance(1);
      expect(harness.mirror.calls).toEqual([
        { kind: 'register', ledgerId, audience: 'organization' },
      ]);
      expect((await harness.scopeSync(ledgerId)).audienceConfirmedAt).toBe(
        new Date(
          START_MS + LEDGER_SYNC_STARTUP_DELAY_MS + 6 * HOUR_MS,
        ).toISOString(),
      );
    });

    it('syncs privately when the mirror refuses the project', async () => {
      harness.account = account({ summaries: 'organization' });
      harness.owners.set('workspace-1', ORGANIZATION_PROJECT);
      harness.mirror.forbiddenProjects.add(PROJECT_ID);
      const ledgerId = await harness.addEntry();

      await startAndSync();

      expect(harness.mirror.calls).toEqual([
        { kind: 'register', ledgerId, audience: 'organization' },
        { kind: 'register', ledgerId, audience: 'private' },
        { kind: 'push', ledgerId, sequences: [1, 4] },
      ]);
      await expect(
        harness.service.isAudienceChangePending({
          ledgerId,
          accountId: ACCOUNT_ID,
          container: TEST_CONTAINER,
        }),
      ).resolves.toBe(false);
    });

    describe('when sharing narrows during a push', () => {
      let ledgerId: string;
      let release: () => void;

      beforeEach(async () => {
        ledgerId = await addTwoBatchesForTheOrganization();
        release = harness.mirror.holdPushes();
        harness.service.start();
        harness.fireTimers(LEDGER_SYNC_STARTUP_DELAY_MS);
        await settleTasks();
        expect(harness.mirror.calls).toEqual([
          { kind: 'register', ledgerId, audience: 'organization' },
          { kind: 'push', ledgerId, sequences: [1, 100] },
        ]);
      }, TWO_BATCH_TIMEOUT_MS);

      it('sends the narrower audience before the next batch', async () => {
        harness.account = account({ summaries: 'private' });
        harness.service.requestSync('policy');
        release();
        await harness.service.whenIdle();
        await harness.advance(LEDGER_SYNC_POLICY_CHANGE_DELAY_MS);

        expect(harness.mirror.calls).toEqual([
          { kind: 'register', ledgerId, audience: 'organization' },
          { kind: 'push', ledgerId, sequences: [1, 100] },
          { kind: 'register', ledgerId, audience: 'private' },
          { kind: 'push', ledgerId, sequences: [101, 101] },
        ]);
      });

      it('stops before the host has reported the change', async () => {
        harness.account = account({ summaries: 'off' });
        release();
        await harness.service.whenIdle();
        expect(harness.mirror.calls).toHaveLength(2);

        await harness.advance(LEDGER_SYNC_POLICY_CHANGE_DELAY_MS);

        // Off: the organization is shut out, and nothing more is sent.
        expect(harness.mirror.calls).toEqual([
          { kind: 'register', ledgerId, audience: 'organization' },
          { kind: 'push', ledgerId, sequences: [1, 100] },
          { kind: 'register', ledgerId, audience: 'private' },
        ]);
        expect((await harness.scopeSync(ledgerId)).acknowledgedSequence).toBe(
          '100',
        );
      });
    });

    it('holds and narrows every scope once the mirror reports a prohibition', async () => {
      harness.account = account({ summaries: 'organization' });
      harness.owners.set('workspace-1', ORGANIZATION_PROJECT);
      harness.owners.set('workspace-2', ORGANIZATION_PROJECT);
      const first = await harness.addEntry();
      const second = await harness.addEntry(SECOND_CONTAINER);
      await startAndSync();
      harness.mirror.calls.length = 0;

      harness.mirror.prohibited = true;
      await harness.addEntry(TEST_CONTAINER, 'Second task');
      await syncAfterLocalChange();

      expect(harness.prohibitedReports).toBe(1);
      expect(harness.mirror.calls).toEqual([
        { kind: 'push', ledgerId: first, sequences: [5, 5] },
        { kind: 'register', ledgerId: second, audience: 'private' },
      ]);
      expect((await harness.scopeSync(first)).mirrorAudience).toEqual({
        kind: 'private',
      });
      expect((await harness.scopeSync(second)).mirrorAudience).toEqual({
        kind: 'private',
      });
      await expect(harness.service.holdFor(ACCOUNT_ID)).resolves.toBe(
        'policy_restricted',
      );
    });
  });

  describe('global (workflow) scopes', () => {
    const ORGANIZATION_OWNER: LedgerGlobalOwner = {
      kind: 'organization',
      organizationId: FAKE_MIRROR_ORGANIZATION_ID,
    };

    it('waits for a mirror without global scopes, and keeps task scopes syncing', async () => {
      harness.globalSupported = false;
      const taskLedgerId = await harness.addEntry();
      const globalLedgerId = await harness.addGlobalEntry({ kind: 'personal' });

      await startAndSync();

      expect(harness.mirror.heldSequences(taskLedgerId)).toEqual([1, 2, 3, 4]);
      expect(
        harness.mirror.calls.filter((call) => call.ledgerId === globalLedgerId),
      ).toEqual([]);
      const waiting = await harness.scopeSync(globalLedgerId);
      expect(waiting.repairReason).toBeNull();
      expect(waiting.acknowledgedSequence).toBe('0');
      expect(harness.diagnostics).toEqual([]);
    });

    it('never asks the mirror about global scopes the account cannot send', async () => {
      harness.ledger.accountId = null;
      await harness.addGlobalEntry({ kind: 'personal' });
      harness.ledger.accountId = GUEST_ACCOUNT_ID;
      await harness.addGlobalEntry(ORGANIZATION_OWNER);

      await startAndSync();

      expect(harness.globalChecks).toEqual([]);
      expect(harness.mirror.calls).toEqual([]);
    });

    it('flushes a waiting global scope in order once the mirror holds them', async () => {
      harness.globalSupported = false;
      const ledgerId = await harness.addGlobalEntry({ kind: 'personal' });
      await startAndSync();
      expect(harness.mirror.registrations).toEqual([]);

      // A reconnect or an account refresh asks the mirror again.
      harness.globalSupported = true;
      harness.service.requestSync('account');
      await harness.advance(LEDGER_SYNC_POLICY_CHANGE_DELAY_MS);

      expect(harness.mirror.registrations).toEqual([
        {
          schemaVersion: 2,
          ledgerId,
          accountId: ACCOUNT_ID,
          scopeKind: 'global',
          globalOwner: { kind: 'personal' },
          session: SESSION,
          audience: { kind: 'private' },
        },
      ]);
      expect(harness.mirror.heldSequences(ledgerId)).toEqual([1, 2, 3, 4]);
      expect(harness.mirror.pushes.map((push) => push.schemaVersion)).toEqual([
        2,
      ]);
    });

    it("shares an organization's global scope with its members, and a Personal one with no one", async () => {
      harness.account = account({ summaries: 'organization' });
      const organizationLedgerId =
        await harness.addGlobalEntry(ORGANIZATION_OWNER);
      const personalLedgerId = await harness.addGlobalEntry({
        kind: 'personal',
      });

      await startAndSync();

      const audienceOf = (ledgerId: string): unknown =>
        harness.mirror.registrations.find(
          (registration) => registration.ledgerId === ledgerId,
        )?.audience;
      expect(audienceOf(organizationLedgerId)).toEqual({
        kind: 'organization_global',
        organizationId: FAKE_MIRROR_ORGANIZATION_ID,
      });
      expect(audienceOf(personalLedgerId)).toEqual({ kind: 'private' });
      expect(
        (await harness.scopeSync(organizationLedgerId)).mirrorAudience,
      ).toMatchObject({
        kind: 'organization_global',
        organizationId: FAKE_MIRROR_ORGANIZATION_ID,
      });
    });

    it('narrows an organization global scope once its member leaves', async () => {
      harness.account = account({ summaries: 'organization' });
      const ledgerId = await harness.addGlobalEntry(ORGANIZATION_OWNER);
      await startAndSync();

      harness.account = account({
        summaries: 'organization',
        organizationIds: new Set(),
      });
      await syncAfterPolicyChange();

      expect(harness.mirror.registrations.at(-1)?.audience).toEqual({
        kind: 'private',
      });
      expect((await harness.scopeSync(ledgerId)).mirrorAudience).toEqual({
        kind: 'private',
      });
    });

    it('sends a global scope back to waiting when a mirror that advertised it refuses it', async () => {
      const taskLedgerId = await harness.addEntry();
      const globalLedgerId = await harness.addGlobalEntry({ kind: 'personal' });
      // The mirror rolled back after it advertised global scopes.
      harness.mirror.refusesGlobalScopes = true;

      await startAndSync();

      const record = await harness.scopeSync(globalLedgerId);
      expect(record.repairReason).toBeNull();
      expect(record.acknowledgedSequence).toBe('0');
      expect(harness.mirror.heldSequences(taskLedgerId)).toEqual([1, 2, 3, 4]);
      expect(harness.diagnostics).toEqual([
        { code: 'global_waiting', detail: 'register' },
      ]);
      // It is asked afresh at the next periodic check, and syncs once the
      // mirror holds global scopes again.
      harness.mirror.refusesGlobalScopes = false;
      await harness.advance(LEDGER_SYNC_PERIODIC_CHECK_MS);
      expect(harness.globalChecks.at(-1)).toBe(true);
      expect(harness.mirror.heldSequences(globalLedgerId)).toEqual([
        1, 2, 3, 4,
      ]);
    });

    it('keeps asking a rolled-back mirror afresh, sending no global scope until it answers yes', async () => {
      const globalLedgerId = await harness.addGlobalEntry({ kind: 'personal' });
      // The account still stores the capability; only a live answer is current.
      harness.mirror.refusesGlobalScopes = true;
      await startAndSync();
      const registrationsOf = (): number =>
        harness.mirror.registrations.filter(
          (registration) => registration.ledgerId === globalLedgerId,
        ).length;
      const refused = registrationsOf();

      await harness.advance(LEDGER_SYNC_PERIODIC_CHECK_MS);
      await harness.advance(LEDGER_SYNC_PERIODIC_CHECK_MS);

      expect(registrationsOf()).toBe(refused);
      expect(harness.globalChecks.slice(-2)).toEqual([true, true]);
    });

    it('marks only the refused global scope for repair while the mirror still advertises global scopes', async () => {
      harness.account = account({ summaries: 'organization' });
      const refusedLedgerId = await harness.addGlobalEntry({
        kind: 'personal',
      });
      const laterLedgerId = await harness.addGlobalEntry(ORGANIZATION_OWNER);
      harness.mirror.failNextRegister({
        kind: 'repair',
        reason: 'invalid_request',
      });

      await startAndSync();

      expect(harness.globalChecks).toContain(true);
      expect((await harness.scopeSync(refusedLedgerId)).repairReason).toBe(
        'invalid_request',
      );
      expect(harness.mirror.heldSequences(laterLedgerId)).toEqual([1, 2, 3, 4]);
      expect(harness.diagnostics).not.toContainEqual(
        expect.objectContaining({ code: 'global_waiting' }),
      );
    });
  });

  describe('delivery (T11)', () => {
    it('replays a batch whose response was lost, exactly', async () => {
      const ledgerId = await harness.addEntry();
      harness.mirror.loseNextPushResponse();

      await startAndSync();
      expect((await harness.scopeSync(ledgerId)).acknowledgedSequence).toBe(
        '0',
      );
      await harness.advance(500);

      const [first, second] = harness.mirror.pushes;
      expect(second?.acknowledgedSequence).toBe('0');
      expect(second?.events).toEqual(first?.events);
      expect(harness.mirror.heldSequences(ledgerId)).toEqual([1, 2, 3, 4]);
      expect((await harness.scopeSync(ledgerId)).acknowledgedSequence).toBe(
        '4',
      );
    });

    it('marks a scope for repair on a gap and keeps syncing the others', async () => {
      const first = await harness.addEntry();
      const second = await harness.addEntry(SECOND_CONTAINER);
      await startAndSync();
      // The mirror lost what it acknowledged, as after a restore.
      const mirrored = harness.mirror.scopes.get(first);
      if (mirrored === undefined) throw new Error('Expected the scope');
      mirrored.acknowledged = 1;
      mirrored.events.delete(2);
      mirrored.events.delete(3);
      mirrored.events.delete(4);
      harness.mirror.calls.length = 0;

      await harness.addEntry(TEST_CONTAINER, 'Second task');
      await harness.addEntry(SECOND_CONTAINER, 'Second task');
      await syncAfterLocalChange();

      expect(harness.mirror.calls).toEqual([
        { kind: 'push', ledgerId: first, sequences: [5, 5] },
        { kind: 'push', ledgerId: second, sequences: [5, 5] },
      ]);
      expect((await harness.scopeSync(first)).repairReason).toBe(
        'sequence_gap',
      );
      expect((await harness.scopeSync(second)).acknowledgedSequence).toBe('5');
      expect(harness.diagnostics).toContainEqual({
        code: 'repair',
        detail: 'sequence_gap',
      });

      // Nothing more is sent for it this launch, and nothing is skipped.
      harness.mirror.calls.length = 0;
      await harness.addEntry(TEST_CONTAINER, 'Third task');
      await syncAfterPolicyChange();
      expect(harness.mirror.calls).toEqual([]);
      expect((await harness.scopeSync(first)).acknowledgedSequence).toBe('4');
    });

    it('marks a scope for repair when another writer took it, and takes it back next launch', async () => {
      const ledgerId = await harness.addEntry();
      await startAndSync();
      // Another device, with a copy of this data directory, takes the scope.
      await harness.mirror.register({
        schemaVersion: 1,
        ledgerId,
        accountId: ACCOUNT_ID,
        scopeKind: 'code_worktree',
        session: OTHER_DEVICE,
        audience: { kind: 'private' },
      });
      harness.mirror.calls.length = 0;

      await harness.addEntry(TEST_CONTAINER, 'Second task');
      await syncAfterLocalChange();
      expect((await harness.scopeSync(ledgerId)).repairReason).toBe(
        'stale_writer',
      );
      await harness.addEntry(TEST_CONTAINER, 'Third task');
      await syncAfterPolicyChange();
      expect(harness.mirror.calls).toEqual([
        { kind: 'push', ledgerId, sequences: [5, 5] },
      ]);

      harness.session = NEXT_LAUNCH;
      await harness.restart();
      harness.mirror.calls.length = 0;
      await startAndSync();

      expect(harness.mirror.calls).toEqual([
        { kind: 'register', ledgerId, audience: 'private' },
        { kind: 'push', ledgerId, sequences: [5, 6] },
      ]);
      const record = await harness.scopeSync(ledgerId);
      expect(record.repairReason).toBeNull();
      expect(record.acknowledgedSequence).toBe('6');
    });

    it('marks a scope for repair when the mirror holds events this device never wrote', async () => {
      const ledgerId = await harness.addEntry();
      await startAndSync();
      const mirrored = harness.mirror.scopes.get(ledgerId);
      if (mirrored === undefined) throw new Error('Expected the scope');
      mirrored.acknowledged = 6;
      mirrored.events.set(5, 'a'.repeat(64));
      mirrored.events.set(6, 'b'.repeat(64));

      await harness.addEntry(TEST_CONTAINER, 'Second task');
      harness.session = NEXT_LAUNCH;
      await harness.restart();
      await startAndSync();

      expect((await harness.scopeSync(ledgerId)).repairReason).toBe(
        'mirror_ahead',
      );
      expect(harness.mirror.pushes).toHaveLength(1);
    });

    it('backs off with jitter, honors Retry-After and resumes', async () => {
      const ledgerId = await harness.addEntry();
      harness.mirror.failNextPush({ kind: 'retry' });
      harness.mirror.failNextPush({ kind: 'retry' });
      harness.mirror.failNextPush({ kind: 'retry', retryAfterMs: 30_000 });

      await startAndSync();
      expect(harness.timers.delays()).toEqual([500]);
      await harness.advance(500);
      expect(harness.timers.delays()).toEqual([1_000]);
      await harness.advance(1_000);
      expect(harness.timers.delays()).toEqual([30_000]);
      // A local change does not jump the queue.
      harness.service.requestSync('local_change');
      expect(harness.timers.delays()).toEqual([30_000]);
      await harness.advance(30_000);

      expect(harness.mirror.pushes).toHaveLength(4);
      expect((await harness.scopeSync(ledgerId)).acknowledgedSequence).toBe(
        '4',
      );
      expect(harness.timers.delays()).toEqual([LEDGER_SYNC_PERIODIC_CHECK_MS]);
    });

    it('pauses on a refused account until the account changes', async () => {
      const ledgerId = await harness.addEntry();
      harness.mirror.failNextRegister({ kind: 'paused' });

      await startAndSync();
      expect(harness.diagnostics).toContainEqual({
        code: 'paused',
        detail: 'paused',
      });
      expect(harness.timers.delays()).toEqual([LEDGER_SYNC_PERIODIC_CHECK_MS]);

      harness.service.requestSync('account');
      await harness.advance(LEDGER_SYNC_POLICY_CHANGE_DELAY_MS);
      expect((await harness.scopeSync(ledgerId)).acknowledgedSequence).toBe(
        '4',
      );
    });

    it('never acknowledges past what a batch carried or what the mirror holds', async () => {
      const ledgerId = await harness.addEntry();
      const answers: string[] = ['9', '0'];
      const push = harness.mirror.push.bind(harness.mirror);
      harness.mirror.push = async (
        request: LedgerSyncPushRequest,
        signal?: AbortSignal,
      ): Promise<LedgerSyncResult<LedgerSyncPushResponse>> => {
        const result = await push(request, signal);
        const answer = answers.shift();
        return result.ok && answer !== undefined
          ? {
              ok: true,
              value: { ...result.value, acknowledgedSequence: answer },
            }
          : result;
      };

      await startAndSync();
      expect((await harness.scopeSync(ledgerId)).acknowledgedSequence).toBe(
        '4',
      );

      await harness.addEntry(TEST_CONTAINER, 'Second task');
      await syncAfterLocalChange();
      // Nothing held: tried again later, and nothing dropped meanwhile.
      expect((await harness.scopeSync(ledgerId)).acknowledgedSequence).toBe(
        '4',
      );
      expect(harness.timers.delays()).toEqual([500]);
      await harness.advance(500);
      expect((await harness.scopeSync(ledgerId)).acknowledgedSequence).toBe(
        '5',
      );
    });
  });

  describe('accounts (T12, T13)', () => {
    it('pauses a scope while another account is signed in', async () => {
      const ledgerId = await harness.addEntry();
      harness.account = account({ id: OTHER_ACCOUNT_ID });

      await startAndSync();
      expect(harness.mirror.calls).toEqual([]);
      await expect(harness.service.holdFor(ACCOUNT_ID)).resolves.toBe(
        'local_only',
      );

      harness.account = account();
      harness.service.requestSync('account');
      await harness.advance(LEDGER_SYNC_POLICY_CHANGE_DELAY_MS);
      expect(harness.mirror.registrations[0]?.accountId).toBe(ACCOUNT_ID);
      expect(harness.mirror.heldSequences(ledgerId)).toEqual([1, 2, 3, 4]);
    });

    it('keeps an offline queue across a restart', async () => {
      const ledgerId = await harness.addEntry();
      harness.mirror.failNextRegister({ kind: 'retry' });
      await startAndSync();
      expect(harness.mirror.heldSequences(ledgerId)).toEqual([]);

      harness.session = NEXT_LAUNCH;
      await harness.restart();
      await startAndSync();

      expect(harness.mirror.heldSequences(ledgerId)).toEqual([1, 2, 3, 4]);
    });

    it('never uploads a scope first used signed out', async () => {
      harness.ledger.accountId = null;
      await harness.addEntry();

      await startAndSync();
      await syncAfterPolicyChange();

      expect(harness.mirror.calls).toEqual([]);
      await expect(harness.service.holdFor(null)).resolves.toBe('local_only');
    });

    it('resumes a guest scope under the account it merged into', async () => {
      harness.ledger.accountId = GUEST_ACCOUNT_ID;
      const first = await harness.addEntry();
      const second = await harness.addEntry(SECOND_CONTAINER);
      await startAndSync();
      expect(harness.mirror.calls).toEqual([]);

      await expect(
        harness.service.rebindMergedGuest(GUEST_ACCOUNT_ID, ACCOUNT_ID),
      ).resolves.toBe(2);
      await harness.advance(LEDGER_SYNC_POLICY_CHANGE_DELAY_MS);

      expect(
        harness.mirror.registrations.map((registration) => [
          registration.ledgerId,
          registration.accountId,
        ]),
      ).toEqual([
        [first, ACCOUNT_ID],
        [second, ACCOUNT_ID],
      ]);
      expect(harness.mirror.heldSequences(second)).toEqual([1, 2, 3, 4]);
    });

    it('keeps a guest scope paused when an unrelated account signs in', async () => {
      harness.ledger.accountId = GUEST_ACCOUNT_ID;
      await harness.addEntry();
      harness.account = account({ id: OTHER_ACCOUNT_ID });

      await startAndSync();
      harness.service.requestSync('account');
      await harness.advance(LEDGER_SYNC_POLICY_CHANGE_DELAY_MS);

      expect(harness.mirror.calls).toEqual([]);
    });
  });

  describe('drain before purge (LD10)', () => {
    async function retire(ledgerId: string): Promise<void> {
      await harness.ledger.store.client.setScopeLifecycle({
        ledgerId,
        state: 'retirement_pending',
      });
    }

    it("sends a retiring scope's outbox, which passes leave alone", async () => {
      const ledgerId = await harness.addEntry();
      await retire(ledgerId);
      await startAndSync();
      expect(harness.mirror.calls).toEqual([]);

      await expect(harness.service.drainScope(ledgerId)).resolves.toBe(
        'drained',
      );

      expect(harness.mirror.heldSequences(ledgerId)).toEqual([1, 2, 3, 4]);
    });

    it(
      'drains under the narrower audience when sharing narrows meanwhile',
      async () => {
        const ledgerId = await addTwoBatchesForTheOrganization();
        await retire(ledgerId);
        const release = harness.mirror.holdPushes();
        harness.service.start();

        const draining = harness.service.drainScope(ledgerId);
        await settleTasks();
        expect(harness.mirror.pushes).toHaveLength(1);
        harness.account = account({ summaries: 'private' });
        harness.service.requestSync('policy');
        release();

        await expect(draining).resolves.toBe('drained');
        expect(harness.mirror.calls).toEqual([
          { kind: 'register', ledgerId, audience: 'organization' },
          { kind: 'push', ledgerId, sequences: [1, 100] },
          { kind: 'register', ledgerId, audience: 'private' },
          { kind: 'push', ledgerId, sequences: [101, 101] },
        ]);
      },
      TWO_BATCH_TIMEOUT_MS,
    );

    it('reports a scope that may not sync as held', async () => {
      const ledgerId = await harness.addEntry();
      harness.account = null;

      await expect(harness.service.drainScope(ledgerId)).resolves.toBe('held');
      expect(harness.mirror.calls).toEqual([]);
    });

    it('stops waiting at the timeout, and later drains answer at once', async () => {
      const first = await harness.addEntry();
      const second = await harness.addEntry(SECOND_CONTAINER);
      const release = harness.mirror.holdPushes();
      harness.service.start();

      const draining = harness.service.drainScope(first, 1_000);
      await settleTasks();
      expect(harness.mirror.pushes).toHaveLength(1);
      harness.fireTimers(1_000);

      await expect(draining).resolves.toBe('timed_out');
      await expect(harness.service.drainScope(second, 1_000)).resolves.toBe(
        'incomplete',
      );
      expect(harness.diagnostics).toEqual([
        { code: 'drain_timeout', detail: '1' },
        { code: 'drain_incomplete', detail: '1' },
      ]);

      release();
      await harness.service.whenIdle();
      expect(harness.mirror.heldSequences(first)).toEqual([1, 2, 3, 4]);
    });
  });
});
