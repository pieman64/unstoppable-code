import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseInitiatedWorkRunRecord,
  type OperationRecord,
} from '@canopy/protocol/canopy-core';

import { OperationService } from '../../operations';
import { OperationLedger } from '../../operations/ledger';
import { InitiatedWorkEngine } from '../engine';
import {
  HookFiring,
  type HookActionRef,
  type HookFirePreparation,
  type HookFireRequest,
  type HookFiringHost,
  type HookProjectOwner,
  type HookRef,
} from '../hook-firing';

let dir: string;
let operations: OperationService;
let engine: InitiatedWorkEngine;
let host: {
  paused: Set<string>;
  owner: HookProjectOwner;
  /** The next owner read waits for this. */
  nextOwnerRead: Promise<void> | null;
  splitLocked: boolean;
  pausedReads: number;
};
let firing: HookFiring;

const HOOK: HookRef = {
  hookKey: 'project:pr:create',
  triggerName: 'pr:create',
  target: 'project',
};

class SplitLocked extends Error {}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hook-firing-'));
  operations = new OperationService({
    openLedger: (): OperationLedger =>
      OperationLedger.open(join(dir, 'operation-ledger.sqlite')),
  });
  engine = new InitiatedWorkEngine({ operations });
  await operations.ready();
  host = {
    paused: new Set(),
    owner: { kind: 'organization', organizationId: 'org-1' },
    nextOwnerRead: null,
    splitLocked: false,
    pausedReads: 0,
  };
  const firingHost: HookFiringHost = {
    pausedHookKeys: () => {
      host.pausedReads += 1;
      return Promise.resolve(new Set(host.paused));
    },
    assertNotSplitLocked: () => {
      if (host.splitLocked) throw new SplitLocked('Split in progress.');
    },
    assertStartAllowed: () => undefined,
    projectOwner: async () => {
      const wait = host.nextOwnerRead;
      host.nextOwnerRead = null;
      await wait;
      return host.owner;
    },
    localAuthorityId: 'local',
  };
  firing = new HookFiring({ engine, host: firingHost });
});

afterEach(() => {
  operations.close();
  rmSync(dir, { recursive: true, force: true });
});

function ready(
  executed: string[],
  label: string,
  actions: readonly HookActionRef[] = [{ type: 'command' }],
): HookFirePreparation<string> {
  return {
    kind: 'ready',
    actions,
    execute: () => {
      executed.push(label);
      return Promise.resolve({
        value: label,
        result: { status: 'succeeded', exitCode: 0, durationMs: 1 },
      });
    },
  };
}

function fire(
  overrides: Partial<HookFireRequest<string>> = {},
): Promise<Awaited<ReturnType<HookFiring['fire']>>> {
  return firing.fire<string>({
    workspaceId: 'p',
    worktreeId: 'w',
    hook: HOOK,
    invocation: 'automatic',
    pause: 'enforce',
    prepare: () => Promise.resolve(ready([], 'run')),
    ...overrides,
  });
}

async function latest(): Promise<OperationRecord> {
  const [operation] = (
    await operations.list({ kinds: ['core.initiatedWork.run'], limit: 10 })
  ).items;
  if (!operation) throw new Error('no run recorded');
  return operation;
}

describe('HookFiring (CAN-4146)', () => {
  it('records a paused firing as skipped and runs it when the request bypasses the pause', async () => {
    host.paused.add(HOOK.hookKey);
    const prepare = jest.fn(() => Promise.resolve(ready([], 'run')));
    expect(await fire({ prepare })).toMatchObject({
      disposition: 'skipped',
      gate: 'pause',
    });
    expect(prepare).not.toHaveBeenCalled();
    const skipped = await latest();
    expect(skipped.status).toBe('completed');
    expect(skipped.origin.context).toMatchObject({ pause: 'enforce' });
    expect(parseInitiatedWorkRunRecord(skipped.outcome)).toMatchObject({
      disposition: 'skipped',
      gates: [{ gate: 'pause', decision: 'skipped' }],
    });

    const executed: string[] = [];
    const readsBefore = host.pausedReads;
    expect(
      await fire({
        invocation: 'manual',
        pause: 'bypass',
        prepare: () => Promise.resolve(ready(executed, 'manual')),
      }),
    ).toMatchObject({ disposition: 'ran', value: 'manual' });
    expect(executed).toEqual(['manual']);
    expect(host.pausedReads).toBe(readsBefore);
    const bypassed = await latest();
    expect(bypassed.origin.context).toMatchObject({ pause: 'bypass' });
    expect(
      parseInitiatedWorkRunRecord(bypassed.outcome)?.gates.map(
        (outcome) => outcome.gate,
      ),
    ).toEqual(['splitLock', 'deletionFence', 'busyTarget']);
  });

  it('refuses a split-locked worktree for every invocation before reading the hook', async () => {
    host.splitLocked = true;
    for (const invocation of ['automatic', 'manual'] as const) {
      const prepare = jest.fn(() => Promise.resolve(ready([], 'run')));
      const result = await fire({
        invocation,
        pause: invocation === 'manual' ? 'bypass' : 'enforce',
        prepare,
      });
      expect(result).toMatchObject({
        disposition: 'refused',
        gate: 'splitLock',
      });
      expect(result.disposition === 'refused' && result.cause).toBeInstanceOf(
        SplitLocked,
      );
      expect(prepare).not.toHaveBeenCalled();
      expect(await latest()).toMatchObject({
        status: 'failed',
        error: { code: 'core.initiatedWork.gate.splitLock' },
      });
    }
  });

  it('checks the owner each time a hook fires', async () => {
    const orgChat = [{ type: 'chat', executionContext: 'org:org-1' }];
    const executed: string[] = [];
    expect(
      await fire({
        prepare: () => Promise.resolve(ready(executed, 'first', orgChat)),
      }),
    ).toMatchObject({ disposition: 'ran' });
    expect((await latest()).owner).toEqual({
      kind: 'organization',
      id: 'org-1',
    });

    host.owner = { kind: 'organization', organizationId: 'org-2' };
    expect(
      await fire({
        prepare: () => Promise.resolve(ready(executed, 'second', orgChat)),
      }),
    ).toMatchObject({ disposition: 'refused', gate: 'executionContext' });
    expect(executed).toEqual(['first']);
  });

  it('records a source precondition and runs nothing for an unconfigured trigger', async () => {
    const refusal = new Error(
      'No current PR snapshot exists for this worktree.',
    );
    expect(
      await fire({
        invocation: 'manual',
        pause: 'bypass',
        prepare: () =>
          Promise.resolve({
            kind: 'refused',
            gate: 'activePr',
            failure: {
              kind: 'failed_precondition',
              message: refusal.message,
              retry: { kind: 'never' },
            },
            cause: refusal,
          }),
      }),
    ).toMatchObject({
      disposition: 'refused',
      gate: 'activePr',
      cause: refusal,
    });
    expect(await latest()).toMatchObject({
      error: { code: 'core.initiatedWork.gate.activePr' },
    });

    const before = (await operations.list({ limit: 10 })).items.length;
    expect(
      await fire({
        prepare: () => Promise.resolve({ kind: 'unconfigured', value: 'noop' }),
      }),
    ).toEqual({ disposition: 'unconfigured', value: 'noop' });
    expect((await operations.list({ limit: 10 })).items).toHaveLength(before);
  });

  it('admits a target in firing order even when an earlier firing reads slowly', async () => {
    const executed: string[] = [];
    let release = (): void => undefined;
    const slow = new Promise<HookFirePreparation<string>>((resolve) => {
      release = (): void => resolve(ready(executed, 'first'));
    });
    const first = fire({ prepare: () => slow });
    const second = fire({
      hook: { ...HOOK, hookKey: 'project:pr:checks-failed' },
      prepare: () => Promise.resolve(ready(executed, 'second')),
    });
    const other = fire({
      hook: {
        hookKey: 'workspace-repo:a:pr:create',
        triggerName: 'pr:create',
        target: 'workspace-repo',
        repoId: 'a',
      },
      prepare: () => Promise.resolve(ready(executed, 'other target')),
    });
    await other;
    expect(executed).toEqual(['other target']);
    release();
    await Promise.all([first, second]);
    expect(executed).toEqual(['other target', 'first', 'second']);
  });

  it('keeps a PR acceptance behind an earlier firing still deciding its gates', async () => {
    let releaseOwner = (): void => undefined;
    host.nextOwnerRead = new Promise((resolve) => {
      releaseOwner = resolve;
    });
    const executed: string[] = [];
    const first = fire({
      prepare: () => Promise.resolve(ready(executed, 'first')),
    });
    const checksFailed: HookRef = {
      ...HOOK,
      hookKey: 'project:pr:checks-failed',
      triggerName: 'pr:checks-failed',
    };
    const acceptance = firing.acceptOccurrence({
      workspaceId: 'p',
      worktreeId: 'w',
      head: { source: 'github.pr', subject: 's', value: 'h1' },
      firings: [{ hook: checksFailed, occurrenceKey: 'o-1' }],
    });
    await new Promise((resolve) => setImmediate(resolve));
    releaseOwner();
    const [accepted] = await acceptance;
    if (accepted?.status !== 'accepted') throw new Error('not accepted');
    const later = fire({
      hook: checksFailed,
      occurrenceKey: 'o-1',
      acceptedOperationId: accepted.operationId,
      prepare: () => Promise.resolve(ready(executed, 'accepted')),
    });
    await Promise.all([first, later]);
    expect(executed).toEqual(['first', 'accepted']);
  });

  it('never starts a firing cancelled while its gates are being decided', async () => {
    let release = (): void => undefined;
    const executed: string[] = [];
    const run = fire({
      prepare: () =>
        new Promise((resolve) => {
          release = (): void => resolve(ready(executed, 'run'));
        }),
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(firing.liveRuns()).toEqual([
      expect.objectContaining({ hookKey: HOOK.hookKey, started: false }),
    ]);
    await firing.cancelWhere((live) => live.hookKey === HOOK.hookKey, {
      reason: 'Stopped.',
      requestedBy: 'test',
    });
    release();
    expect(await run).toEqual({ disposition: 'cancelled', operationId: null });
    expect(executed).toEqual([]);
  });

  it('records a paused firing as skipped with the state that fired it, and starts the others', async () => {
    host.paused.add('project:pr:checks-failed');
    const acceptances = await firing.acceptOccurrence({
      workspaceId: 'p',
      worktreeId: 'w',
      head: { source: 'github.pr', subject: 's', value: 'h1' },
      firings: [
        { hook: HOOK, occurrenceKey: 'o-1' },
        {
          hook: {
            ...HOOK,
            hookKey: 'project:pr:checks-failed',
            triggerName: 'pr:checks-failed',
          },
          occurrenceKey: 'o-2',
        },
      ],
    });
    expect(acceptances.map((acceptance) => acceptance.status)).toEqual([
      'accepted',
      'stopped',
    ]);
    expect(await engine.sourceHead('github.pr', 's')).toBe('h1');
    const accepted = acceptances[0];
    if (accepted?.status !== 'accepted') throw new Error('not accepted');
    const executed: string[] = [];
    expect(
      await fire({
        occurrenceKey: 'o-1',
        acceptedOperationId: accepted.operationId,
        prepare: () => Promise.resolve(ready(executed, 'accepted')),
      }),
    ).toMatchObject({ disposition: 'ran', operationId: accepted.operationId });
    expect(executed).toEqual(['accepted']);
  });

  it('decides a recovered run under the pause policy it was fired with', async () => {
    host.paused.add(HOOK.hookKey);
    const record = (context: Record<string, unknown>): OperationRecord =>
      ({
        origin: { kind: 'hook', sourceId: HOOK.hookKey, context },
        scope: { workspaceId: 'p', worktreeId: 'w' },
      }) as unknown as OperationRecord;
    const base = {
      triggerName: 'pr:create',
      target: 'project',
      projectOwner: { kind: 'personal' },
    };
    const decided = async (
      context: Record<string, unknown>,
    ): Promise<string[]> =>
      (await firing.recoveredGates(record(context), [{ type: 'command' }])).map(
        (gate) => `${gate.gate}:${gate.check().decision}`,
      );
    expect(await decided({ ...base, invocation: 'automatic' })).toEqual([
      'pause:skipped',
      'splitLock:passed',
      'deletionFence:passed',
    ]);
    // Recorded before the flag: a manual run bypassed the pause.
    expect(await decided({ ...base, invocation: 'manual' })).toEqual([
      'splitLock:passed',
      'deletionFence:passed',
    ]);
    expect(
      await decided({ ...base, invocation: 'manual', pause: 'enforce' }),
    ).toEqual(['pause:skipped', 'splitLock:passed', 'deletionFence:passed']);
  });
});
