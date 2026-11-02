import {
  ManagedDelegationLifetimeStatusService,
  type LifetimeSnapshot,
} from '../agents/delegation/lifetime-status';

const scope = { projectId: 'project', worktreeId: 'worktree' };
const full: LifetimeSnapshot = {
  kind: 'available',
  occupied: 512,
  retained: 511,
  limit: 512,
  cap: 1024,
  atLimit: true,
  extension: 'possible',
};

describe('session lifetime observation', () => {
  it('remembers only capacity refusals for the refused chat before any consumer mounts', async () => {
    const service = new ManagedDelegationLifetimeStatusService(() =>
      Promise.resolve(full),
    );
    service.refuse({ ...scope, chatId: 'refused' }, 'capacity');
    service.refuse({ ...scope, chatId: 'policy' }, 'policy_unavailable');
    expect(await service.getLifetimeStatus(scope)).toEqual({
      kind: 'available',
      occupied: 512,
      retained: 511,
      limit: 512,
      cap: 1024,
      atLimit: true,
      canExtend: true,
      atCap: false,
      refusedChatIds: ['refused'],
    });
    expect(
      await service.getLifetimeStatus({ ...scope, worktreeId: 'other' }),
    ).toMatchObject({ refusedChatIds: [] });
  });

  it('preserves markers across uncertainty, retires on restored capacity, and never resurrects on refill', async () => {
    let snapshot: LifetimeSnapshot = full;
    const service = new ManagedDelegationLifetimeStatusService(() =>
      Promise.resolve(snapshot),
    );
    service.refuse({ ...scope, chatId: 'refused' }, 'capacity');
    snapshot = { kind: 'unavailable', reason: 'uncertain' };
    service.changed(scope);
    expect(await service.getLifetimeStatus(scope)).toEqual({
      kind: 'unavailable',
      reason: 'uncertain',
    });
    snapshot = full;
    service.changed(scope);
    expect(await service.getLifetimeStatus(scope)).toMatchObject({
      refusedChatIds: ['refused'],
    });
    snapshot = { ...full, occupied: 511, atLimit: false };
    service.observe(scope, snapshot);
    snapshot = full;
    service.changed(scope);
    expect(await service.getLifetimeStatus(scope)).toMatchObject({
      refusedChatIds: [],
    });
  });

  it('coalesces count, release, refusal, preference and extension invalidations per scope', async () => {
    const service = new ManagedDelegationLifetimeStatusService(() =>
      Promise.resolve(full),
    );
    const events: unknown[] = [];
    const close = service.subscribe((target) => events.push(target));
    service.observe(scope, full);
    service.refuse({ ...scope, chatId: 'chat' }, 'capacity');
    service.changed(scope);
    service.changedAll();
    await Promise.resolve();
    expect(events).toEqual([scope]);
    service.observe(scope, { ...full, occupied: 511, atLimit: false });
    service.observe(scope, { ...full, occupied: 511, atLimit: false });
    await Promise.resolve();
    expect(events).toEqual([scope, scope]);
    close();
  });

  it('deduplicates readers and fences results invalidated during dormant I/O', async () => {
    let release: (value: LifetimeSnapshot) => void = () => undefined;
    let calls = 0;
    const service = new ManagedDelegationLifetimeStatusService(() => {
      calls++;
      return calls === 1
        ? new Promise((resolve) => {
            release = resolve;
          })
        : Promise.resolve({ ...full, occupied: 511, atLimit: false });
    });
    const first = service.getLifetimeStatus(scope);
    expect(service.getLifetimeStatus(scope)).toBe(first);
    await Promise.resolve();
    service.changed(scope);
    release(full);
    expect(await first).toMatchObject({ occupied: 511, atLimit: false });
    expect(calls).toBe(2);
  });

  it('never turns read failure into a zero count', async () => {
    const service = new ManagedDelegationLifetimeStatusService(() =>
      Promise.reject(new Error('failed')),
    );
    expect(await service.getLifetimeStatus(scope)).toEqual({
      kind: 'error',
      reason: 'read_failed',
    });
  });
});
