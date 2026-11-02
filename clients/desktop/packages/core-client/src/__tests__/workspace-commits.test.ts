import type { CanopyEvent } from '@canopy/protocol/canopy-core';

import {
  CANOPY_WORKSPACE_BROAD_INVALIDATION,
  createCanopyWorkspaceEventBridge,
  planCanopyWorkspaceInvalidation,
  type CanopyWorkspaceEventBridge,
  type CanopyWorkspaceInvalidationPlan,
} from '../events/workspace-commits';
import type { CanopyEventsConnection } from '../events/types';
import { createEventsCore, type EventsCore } from './fixtures/events-core';

const event = (name: string, payload: CanopyEvent['payload']): CanopyEvent => ({
  cursor: { daemonEpoch: 'e', sequence: 1 },
  eventId: 'e#1',
  name,
  scope: {},
  occurredAt: '2026-10-31T00:00:00.000Z',
  payload,
});
const never = (): boolean => false;
const flush = async (): Promise<void> => {
  for (let i = 0; i < 15; i += 1)
    await new Promise<void>((resolve) => setImmediate(resolve));
};

describe('planCanopyWorkspaceInvalidation', () => {
  it('maps desktop files and changes onto the resources to re-read', () => {
    expect(
      planCanopyWorkspaceInvalidation(
        event('core.workspace.committed', {
          commit: 'w5:1',
          changes: [
            { kind: 'index', revision: 1 },
            { kind: 'workspace', workspaceId: 'a', revision: 2 },
            { kind: 'workspace', workspaceId: 'b', revision: 2 },
            {
              kind: 'worktree',
              workspaceId: 'c',
              worktreeId: 't',
              revision: 1,
            },
          ],
          files: [
            { kind: 'index' },
            { kind: 'index-backup' },
            { kind: 'manifest', workspaceId: 'b' },
            { kind: 'worktrees', workspaceId: 'c' },
          ],
        }),
        never,
      ),
    ).toEqual({
      broad: false,
      index: true,
      workspaces: ['a'],
      manifests: ['b'],
      worktreeLists: ['c'],
    });
  });

  it('plans a web commit from changes alone', () => {
    expect(
      planCanopyWorkspaceInvalidation(
        event('core.workspace.committed', {
          commit: 'web:1',
          changes: [{ kind: 'worktreeList', workspaceId: 'a', revision: 3 }],
        }),
        never,
      ),
    ).toEqual({
      broad: false,
      index: false,
      workspaces: [],
      manifests: [],
      worktreeLists: ['a'],
    });
  });

  it('skips its own commits, unknown events and empty commits', () => {
    const own = event('core.workspace.committed', {
      commit: 'w5:2',
      changes: [{ kind: 'index', revision: 1 }],
      publishedBy: 'me',
    });
    expect(
      planCanopyWorkspaceInvalidation(own, (id) => id === 'me'),
    ).toBeNull();
    expect(planCanopyWorkspaceInvalidation(own, never)).toMatchObject({
      index: true,
    });
    expect(
      planCanopyWorkspaceInvalidation(
        event('core.workspace.renamed', {}),
        never,
      ),
    ).toBeNull();
    expect(
      planCanopyWorkspaceInvalidation(
        event('core.workspace.committed', { commit: 'w5:3', changes: [] }),
        never,
      ),
    ).toBeNull();
  });

  it('invalidates broadly for an invalidation or an unreadable commit', () => {
    for (const unclear of [
      event('core.workspace.invalidated', { reason: 'uncertain' }),
      event('core.workspace.committed', { changes: 'garbled' }),
    ])
      expect(planCanopyWorkspaceInvalidation(unclear, never)).toBe(
        CANOPY_WORKSPACE_BROAD_INVALIDATION,
      );
  });
});

describe('createCanopyWorkspaceEventBridge', () => {
  let core: EventsCore;
  let bridge: CanopyWorkspaceEventBridge | undefined;
  afterEach(async () => {
    await bridge?.close();
    bridge = undefined;
    await core.close();
  });

  const start = (
    applied: CanopyWorkspaceInvalidationPlan[],
  ): CanopyWorkspaceEventBridge =>
    (bridge = createCanopyWorkspaceEventBridge({
      isOwnOrigin: (id) => id === 'me',
      apply: (plan) => {
        applied.push(plan);
        return Promise.resolve();
      },
    }));

  it('re-reads broadly once open, then applies others’ commits but not its own', async () => {
    core = createEventsCore();
    const applied: CanopyWorkspaceInvalidationPlan[] = [];
    const subscriber = start(applied);
    const client = await core.connect();
    await subscriber.attach(client);
    await core.append('core.workspace.committed', {
      commit: 'w5:1',
      changes: [{ kind: 'worktreeList', workspaceId: 'a', revision: 1 }],
      publishedBy: 'me',
    });
    await core.append('core.workspace.committed', {
      commit: 'w5:2',
      changes: [{ kind: 'worktreeList', workspaceId: 'a', revision: 2 }],
      publishedBy: 'cli',
    });
    await flush();
    expect(applied).toEqual([
      CANOPY_WORKSPACE_BROAD_INVALIDATION,
      expect.objectContaining({ broad: false, worktreeLists: ['a'] }),
    ]);
    expect(core.subscriptions).toEqual([
      { families: ['core.workspace'], cursor: null },
    ]);
    // Attaching the same open connection again changes nothing.
    await subscriber.attach(client);
    expect(core.subscriptions).toHaveLength(1);
  });

  it('remembers a connection whose daemon cannot acknowledge events', async () => {
    core = createEventsCore();
    const client = await core.connect();
    const without: CanopyEventsConnection = {
      identity: client.identity,
      manifest: { ...client.manifest, has: () => false },
      signal: client.signal,
      openStream: (...args) => client.openStream(...args),
      instruction: (...args) => client.instruction(...args),
    };
    const has = jest.spyOn(without.manifest, 'has');
    const subscriber = start([]);
    await subscriber.attach(without);
    await subscriber.attach(without);
    expect(has).toHaveBeenCalledTimes(1);
    expect(core.subscriptions).toEqual([]);
  });

  it('resumes a new connection after a reconnect without re-reading', async () => {
    core = createEventsCore();
    const applied: CanopyWorkspaceInvalidationPlan[] = [];
    const subscriber = start(applied);
    const first = await core.connect();
    await subscriber.attach(first);
    await core.append('core.workspace.committed', {
      commit: 'w5:1',
      changes: [{ kind: 'index', revision: 1 }],
    });
    await flush();
    await first.close();
    const second = await core.connect();
    await subscriber.attach(second);
    await flush();
    // One broad re-read at the first open, one commit, nothing more.
    expect(applied).toHaveLength(2);
    expect(core.subscriptions.at(-1)?.cursor).toEqual(core.cursor());
  });

  describe('when a plan fails to apply', () => {
    afterEach(() => jest.useRealTimers());

    /** A host whose re-reads fail while `failing` says so. */
    function failingHost(
      failing: (plan: CanopyWorkspaceInvalidationPlan) => boolean,
    ): {
      applied: string[];
      errors: unknown[];
      bridge: CanopyWorkspaceEventBridge;
    } {
      const applied: string[] = [];
      const errors: unknown[] = [];
      bridge = createCanopyWorkspaceEventBridge({
        isOwnOrigin: never,
        apply: (plan) => {
          const name = plan.broad ? 'broad' : plan.worktreeLists.join(',');
          if (failing(plan)) {
            applied.push(`${name} failed`);
            return Promise.reject(new Error(`${name} failed`));
          }
          applied.push(name);
          return Promise.resolve();
        },
        onError: (error) => void errors.push(error),
      });
      return { applied, errors, bridge };
    }
    const listCommit = (workspaceId: string): Promise<CanopyEvent> =>
      core.append('core.workspace.committed', {
        commit: `w5:${workspaceId}`,
        changes: [{ kind: 'worktreeList', workspaceId, revision: 1 }],
      });
    const acked = (): number[] =>
      core.acknowledgements.map((ack) => ack.cursor.sequence);
    const useFakeTimers = (): void =>
      void jest.useFakeTimers({
        doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'],
      });

    it('covers a failed targeted plan with a broad re-read before acknowledging', async () => {
      core = createEventsCore();
      const host = failingHost((plan) => !plan.broad);
      await host.bridge.attach(await core.connect());
      await flush();
      await listCommit('a');
      await flush();
      expect(host.applied).toEqual(['broad', 'a failed', 'broad']);
      expect(acked()).toEqual([1]);
      expect(core.subscriptions).toHaveLength(1);
    });

    it('holds a delivery, and those behind it, unacknowledged until a broad re-read applies', async () => {
      core = createEventsCore();
      let failing = false;
      const host = failingHost(() => failing);
      await host.bridge.attach(await core.connect());
      await flush();
      await listCommit('a');
      await flush();
      expect(acked()).toEqual([1]);
      useFakeTimers();
      failing = true;
      await listCommit('b');
      await listCommit('c');
      await flush();
      // Neither b nor a broad re-read applied: nothing past a is acknowledged.
      expect(host.applied.slice(-2)).toEqual(['b failed', 'broad failed']);
      expect(acked()).toEqual([1]);
      expect(host.errors).toHaveLength(2);
      failing = false;
      await jest.advanceTimersByTimeAsync(249);
      await flush();
      expect(acked()).toEqual([1]);
      await jest.advanceTimersByTimeAsync(1);
      await flush();
      // The re-read covers b; c then applies after it, in order.
      expect(host.applied.slice(-2)).toEqual(['broad', 'c']);
      expect(acked()).toEqual([1, 2, 3]);
      expect(core.subscriptions).toHaveLength(1);
      expect(host.bridge.state('authority-1')).toBe('open');
      expect(jest.getTimerCount()).toBe(0);
    });

    it('moves past a delivery that keeps failing and retries a broad recovery until it applies', async () => {
      core = createEventsCore();
      let failing = false;
      const host = failingHost(() => failing);
      await host.bridge.attach(await core.connect());
      await flush();
      useFakeTimers();
      failing = true;
      await listCommit('a');
      await flush();
      expect(acked()).toEqual([]);
      // Broad re-reads at once, after 250 ms, then 500 ms; then it moves on.
      await jest.advanceTimersByTimeAsync(749);
      await flush();
      expect(host.applied).toEqual([
        'broad',
        'a failed',
        'broad failed',
        'broad failed',
      ]);
      expect(acked()).toEqual([]);
      await jest.advanceTimersByTimeAsync(1);
      await flush();
      expect(host.applied.at(-1)).toBe('broad failed');
      expect(acked()).toEqual([1]);
      // While the recovery is owed it covers a failed delivery at once.
      host.applied.length = 0;
      await listCommit('b');
      await core.append('core.workspace.invalidated', { reason: 'uncertain' });
      await flush();
      expect(host.applied).toEqual(['b failed']);
      expect(acked()).toEqual([1, 2, 3]);
      await jest.advanceTimersByTimeAsync(2_000);
      await flush();
      expect(host.applied).toEqual(['b failed', 'broad failed']);
      failing = false;
      await jest.advanceTimersByTimeAsync(4_000);
      await flush();
      expect(host.applied).toEqual(['b failed', 'broad failed', 'broad']);
      expect(jest.getTimerCount()).toBe(0);
      await listCommit('c');
      await flush();
      expect(host.applied.at(-1)).toBe('c');
      expect(acked()).toEqual([1, 2, 3, 4]);
    });

    it('backs a failing broad recovery off to a 32 s ceiling, and restarts at 2 s', async () => {
      core = createEventsCore();
      let failing = false;
      const host = failingHost(() => failing);
      await host.bridge.attach(await core.connect());
      await flush();
      useFakeTimers();
      /** Milliseconds from now until the next broad re-read, to 250 ms. */
      const nextBroadIn = async (limit: number): Promise<number> => {
        const before = host.applied.length;
        for (let elapsed = 250; elapsed <= limit; elapsed += 250) {
          await jest.advanceTimersByTimeAsync(250);
          await flush();
          if (host.applied.length > before) return elapsed;
        }
        return Number.NaN;
      };
      const owe = async (): Promise<void> => {
        failing = true;
        await listCommit('a');
        await flush();
        // The three re-reads before the delivery moves on.
        await jest.advanceTimersByTimeAsync(750);
        await flush();
      };
      await owe();
      const delays: number[] = [];
      for (let attempt = 0; attempt < 6; attempt += 1)
        delays.push(await nextBroadIn(40_000));
      expect(delays).toEqual([2_000, 4_000, 8_000, 16_000, 32_000, 32_000]);
      failing = false;
      expect(await nextBroadIn(40_000)).toBe(32_000);
      expect(host.applied.at(-1)).toBe('broad');
      expect(jest.getTimerCount()).toBe(0);

      // A recovery owed after one applied starts from the first delay again.
      await owe();
      failing = false;
      expect(await nextBroadIn(40_000)).toBe(2_000);
      expect(host.applied.at(-1)).toBe('broad');
    });

    it('re-reads again when a delivery arrives while an owed recovery is reading', async () => {
      core = createEventsCore();
      let canonical = 0;
      let cached = 0;
      let failing = false;
      let hold = false;
      const read: { release?: () => void } = {};
      const reads: string[] = [];
      bridge = createCanopyWorkspaceEventBridge({
        isOwnOrigin: never,
        apply: async () => {
          if (failing) {
            reads.push('failed');
            throw new Error('read failed');
          }
          // A read samples canonical state when it starts.
          const seen = canonical;
          reads.push('read');
          if (hold) {
            hold = false;
            await new Promise<void>((resolve) => (read.release = resolve));
          }
          cached = seen;
        },
      });
      await bridge.attach(await core.connect());
      await flush();
      useFakeTimers();
      failing = true;
      await listCommit('a');
      await flush();
      await jest.advanceTimersByTimeAsync(750);
      await flush();
      expect(acked()).toEqual([1]);
      // The owed recovery starts its read after 2 s and holds it open.
      failing = false;
      hold = true;
      await jest.advanceTimersByTimeAsync(2_000);
      await flush();
      expect(reads.at(-1)).toBe('read');
      expect(read.release).toBeDefined();
      // Another process commits after the read sampled canonical state.
      canonical = 2;
      await core.append('core.workspace.invalidated', { reason: 'uncertain' });
      await flush();
      expect(acked()).toEqual([1, 2]);
      const before = reads.length;
      failing = true;
      read.release?.();
      await flush();
      // The finished read predates the invalidation, so another one runs at
      // once; when it fails, the recovery stays owed and backs off.
      expect(reads.slice(before)).toEqual(['failed']);
      expect(cached).toBe(0);
      failing = false;
      await jest.advanceTimersByTimeAsync(4_000);
      await flush();
      expect(reads.slice(before)).toEqual(['failed', 'read']);
      expect(cached).toBe(canonical);
      await jest.advanceTimersByTimeAsync(40_000);
      await flush();
      expect(reads.slice(before)).toEqual(['failed', 'read']);
      expect(jest.getTimerCount()).toBe(0);
    });

    it('closes without waiting out a pending retry or leaving a timer', async () => {
      core = createEventsCore();
      let failing = false;
      const host = failingHost(() => failing);
      await host.bridge.attach(await core.connect());
      await flush();
      useFakeTimers();
      failing = true;
      await listCommit('a');
      await flush();
      expect(jest.getTimerCount()).toBe(1);
      await host.bridge.close();
      bridge = undefined;
      expect(jest.getTimerCount()).toBe(0);
      expect(acked()).toEqual([]);
    });
  });
});
