import { mkdtemp, mkdir, realpath, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createCanopyStartupClaimPort,
  type CanopyStartupProcessInspection,
} from '@canopy/core-transport/node';
import {
  createRecoverableCanopyStartupClaim,
  type CanopyRetainedStartupClaimPort,
} from '../recoverable-startup-claim';

it('retries only after confirmed cleanup, preserves bind evidence, and ignores a late stale release', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'retained-claim-')));
  try {
    await mkdir(join(root, 'runtime'), { mode: 0o700 });
    let state: 'alive' | 'dead' = 'dead';
    const owner = { pid: 101, startIdentity: 'electron-main' };
    const port = createCanopyStartupClaimPort({
      dataRoot: root,
      owner,
      inspectProcess: () =>
        Promise.resolve<CanopyStartupProcessInspection>(
          state === 'dead'
            ? { kind: 'dead' }
            : { kind: 'alive', startIdentity: owner.startIdentity },
        ),
    });
    const departed = await port.tryAcquire();
    if (departed.kind !== 'acquired')
      throw new Error('Expected departed claim');
    await port.markEndpointBind(departed.handle);
    const claim = createRecoverableCanopyStartupClaim(() =>
      Promise.resolve(port),
    );
    const signal = new AbortController().signal;
    const first = await claim.tryAcquire(signal);
    if (first.kind !== 'acquired') throw new Error('Expected recovered claim');
    state = 'alive';
    // Unconfirmed cleanup never calls release, so even its owner cannot retry.
    expect(await claim.tryAcquire(signal)).toEqual({ kind: 'held' });
    await claim.release(first.handle, AbortSignal.abort());
    expect(await claim.tryAcquire(signal)).toEqual({ kind: 'held' });
    const guard = join(root, 'runtime/startup-claim.guard');
    await mkdir(guard);
    expect(await claim.release(first.handle, signal)).toBe('ambiguous');
    await rmdir(guard);
    expect(await claim.tryAcquire(signal)).toEqual({ kind: 'held' });
    expect(await claim.release(first.handle, signal)).toBe('not_owner');
    const second = await claim.tryAcquire(signal);
    expect(second).toMatchObject({
      kind: 'acquired',
      recovered: { endpointBound: true },
    });
    if (second.kind !== 'acquired') throw new Error('Expected own retry');
    await claim.release(first.handle, signal);
    expect(await claim.tryAcquire(signal)).toEqual({ kind: 'held' });
    await claim.release(second.handle, signal);
    const third = await claim.tryAcquire(signal);
    expect(third).toMatchObject({
      kind: 'acquired',
      recovered: { endpointBound: true },
    });
    expect(await port.adopt(first.handle)).toEqual({ kind: 'ambiguous' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.each(['not_owner', 'ambiguous', 'released'] as const)(
  'ignores a late %s release after cancellation',
  async (result) => {
    const handle = {};
    const tryAcquire = jest
      .fn<
        ReturnType<CanopyRetainedStartupClaimPort['tryAcquire']>,
        Parameters<CanopyRetainedStartupClaimPort['tryAcquire']>
      >()
      .mockResolvedValueOnce({ kind: 'acquired', handle })
      .mockResolvedValue({ kind: 'held' });
    let finish: (value: typeof result) => void = () => {};
    const release = new Promise<typeof result>((resolve) => {
      finish = resolve;
    });
    const transport = {
      tryAcquire,
      release: (): Promise<typeof result> => release,
      adopt: jest.fn(),
      identity: jest.fn(),
      verify: jest.fn(),
      markEndpointBind: jest.fn(),
    };
    const claim = createRecoverableCanopyStartupClaim(() =>
      Promise.resolve(transport),
    );
    const controller = new AbortController();
    await claim.tryAcquire(controller.signal);
    const pending = claim.release(handle, controller.signal);
    controller.abort();
    finish(result);
    await pending;
    await claim.tryAcquire(new AbortController().signal);
    expect(tryAcquire.mock.calls[1]?.[1]).toEqual({ recoverDeparted: true });
  },
);
it('never offers an old token after a newer acquisition wins a delayed release', async () => {
  const first = {};
  const second = {};
  const tryAcquire = jest
    .fn<
      ReturnType<CanopyRetainedStartupClaimPort['tryAcquire']>,
      Parameters<CanopyRetainedStartupClaimPort['tryAcquire']>
    >()
    .mockResolvedValueOnce({ kind: 'acquired', handle: first })
    .mockResolvedValueOnce({ kind: 'acquired', handle: second })
    .mockResolvedValue({ kind: 'held' });
  let finish = (): void => {};
  const release = new Promise<'not_owner'>((resolve) => {
    finish = (): void => resolve('not_owner');
  });
  const transport = {
    tryAcquire,
    release: (): Promise<'not_owner'> => release,
    adopt: jest.fn(),
    identity: jest.fn(),
    verify: jest.fn(),
    markEndpointBind: jest.fn(),
  };
  const claim = createRecoverableCanopyStartupClaim(() =>
    Promise.resolve(transport),
  );
  const signal = new AbortController().signal;
  await claim.tryAcquire(signal);
  const pending = claim.release(first, signal);
  await claim.tryAcquire(signal);
  finish();
  await pending;
  await claim.tryAcquire(signal);
  expect(tryAcquire.mock.calls[2]?.[1]).toEqual({ recoverDeparted: true });
});

it('does not arm an acquisition that settles after cancellation through a fresh cleanup release', async () => {
  const handle = {};
  let finish = (): void => {};
  const acquisition = new Promise<{ kind: 'acquired'; handle: object }>(
    (resolve) => {
      finish = (): void => resolve({ kind: 'acquired', handle });
    },
  );
  const tryAcquire = jest
    .fn<
      ReturnType<CanopyRetainedStartupClaimPort['tryAcquire']>,
      Parameters<CanopyRetainedStartupClaimPort['tryAcquire']>
    >()
    .mockReturnValueOnce(acquisition)
    .mockResolvedValue({ kind: 'held' });
  const transport = {
    tryAcquire,
    release: jest.fn().mockResolvedValue('not_owner'),
    adopt: jest.fn(),
    identity: jest.fn(),
    verify: jest.fn(),
    markEndpointBind: jest.fn(),
  };
  const claim = createRecoverableCanopyStartupClaim(() =>
    Promise.resolve(transport),
  );
  const cancelled = new AbortController();
  const pending = claim.tryAcquire(cancelled.signal);
  cancelled.abort();
  finish();
  expect(await pending).toEqual({ kind: 'acquired', handle });
  const cleanup = new AbortController().signal;
  await claim.release(handle, cleanup);
  await claim.tryAcquire(cleanup);
  expect(tryAcquire.mock.calls[1]?.[1]).toEqual({ recoverDeparted: true });
});

it('permits confirmed cleanup on a fresh signal after cancellation of a completed acquisition', async () => {
  const handle = {};
  const tryAcquire = jest
    .fn<
      ReturnType<CanopyRetainedStartupClaimPort['tryAcquire']>,
      Parameters<CanopyRetainedStartupClaimPort['tryAcquire']>
    >()
    .mockResolvedValueOnce({ kind: 'acquired', handle })
    .mockResolvedValue({ kind: 'held' });
  const transport = {
    tryAcquire,
    release: jest.fn().mockResolvedValue('not_owner'),
    adopt: jest.fn(),
    identity: jest.fn(),
    verify: jest.fn(),
    markEndpointBind: jest.fn(),
  };
  const claim = createRecoverableCanopyStartupClaim(() =>
    Promise.resolve(transport),
  );
  const cancelled = new AbortController();
  await claim.tryAcquire(cancelled.signal);
  cancelled.abort();
  const cleanup = new AbortController().signal;
  await claim.release(handle, cleanup);
  await claim.tryAcquire(cleanup);
  expect(tryAcquire.mock.calls[1]?.[1]).toEqual({
    recoverDeparted: true,
    recoverOwnHandle: handle,
  });
});
