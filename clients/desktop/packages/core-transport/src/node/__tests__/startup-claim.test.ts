import { execFile } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rmdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import {
  createCanopyStartupClaimPort,
  type CanopyStartupClaimPort,
  type CanopyStartupProcessInspection,
} from '../startup-claim';

let dataRoot: string;
let inspection: CanopyStartupProcessInspection;
const launcher = { pid: 101, startIdentity: 'launcher-start' };
const child = { pid: 202, startIdentity: 'child-start' };
const inspectProcess = jest.fn(() => Promise.resolve(inspection));
function port(owner = launcher, root = dataRoot): CanopyStartupClaimPort {
  return createCanopyStartupClaimPort({
    dataRoot: root,
    owner,
    inspectProcess,
  });
}
async function acquire(target = port()): Promise<object> {
  const result = await target.tryAcquire();
  expect(result.kind).toBe('acquired');
  if (result.kind !== 'acquired') throw new Error('Expected acquisition');
  return result.handle;
}
function serialize(handle: object): Record<string, unknown> {
  const value: unknown = JSON.parse(JSON.stringify(handle));
  return z.record(z.string(), z.unknown()).parse(value);
}
function claim(handle: object): { dataRoot: string; claimId: string } {
  return z.object({ dataRoot: z.string(), claimId: z.string() }).parse(handle);
}
beforeEach(async () => {
  dataRoot = await realpath(await mkdtemp(join(tmpdir(), 'startup-claim-')));
  await mkdir(join(dataRoot, 'runtime'), { mode: 0o700 });
  inspection = { kind: 'alive', startIdentity: launcher.startIdentity };
  inspectProcess.mockClear();
});
afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

it('requires a canonical absolute root and supplied process identity', () => {
  expect(() => port(launcher, 'relative')).toThrow();
  expect(() => port(launcher, `${dataRoot}/../other`)).toThrow();
  expect(() => port({ pid: 0, startIdentity: '' })).toThrow();
});
it('serializes independent contenders and isolates distinct roots', async () => {
  const results = await Promise.all(
    Array.from({ length: 8 }, () => port().tryAcquire()),
  );
  expect(results.filter((result) => result.kind === 'acquired')).toHaveLength(
    1,
  );
  expect(results.filter((result) => result.kind === 'held')).toHaveLength(7);
  expect(await port().tryAcquire()).toEqual({ kind: 'held' });
  await mkdir(join(dataRoot, 'other', 'runtime'), { recursive: true });
  await acquire(port(launcher, join(dataRoot, 'other')));
});
it('has exactly one winner across real Node processes', async () => {
  const modulePath = join(
    process.cwd(),
    'packages/core-transport/src/node/startup-claim.ts',
  );
  const script = `import {createCanopyStartupClaimPort} from ${JSON.stringify(pathToFileURL(modulePath).href)};
    const port=createCanopyStartupClaimPort({dataRoot:process.argv[1],owner:{pid:101,startIdentity:'launcher-start'},
      inspectProcess:async()=>({kind:'alive',startIdentity:'launcher-start'})});
    process.stdout.write((await port.tryAcquire()).kind);`;
  const runs = await Promise.all(
    [1, 2, 3].map(() =>
      promisify(execFile)(process.execPath, [
        '--input-type=module',
        '-e',
        script,
        dataRoot,
      ]),
    ),
  );
  expect(runs.filter((run) => run.stdout === 'acquired')).toHaveLength(1);
  expect(runs.every((run) => ['acquired', 'held'].includes(run.stdout))).toBe(
    true,
  );
});
it.each(['release', 'adopt', 'identity', 'verify'] as const)(
  'waits for a polling claimant before %s',
  async (operation) => {
    const target = port();
    const handle = await acquire(target);
    let entered = (): void => {};
    let finish = (): void => {};
    const inspecting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const resume = new Promise<void>((resolve) => {
      finish = resolve;
    });
    inspectProcess.mockImplementationOnce(async () => {
      entered();
      await resume;
      return inspection;
    });
    const polling = port().tryAcquire();
    await inspecting;
    const waiting =
      operation === 'release'
        ? target.release(handle)
        : operation === 'adopt'
          ? target.adopt(handle)
          : operation === 'identity'
            ? target.identity(handle)
            : target.verify(claim(handle));
    await delay(10);
    finish();
    expect(await polling).toEqual({ kind: 'held' });
    const result = await waiting;
    if (operation === 'release') {
      expect(result).toBe('released');
      await acquire(target);
    } else if (operation === 'adopt') {
      expect(result).toEqual({ kind: 'acquired', handle });
    } else {
      expect(result).toEqual(operation === 'identity' ? claim(handle) : true);
    }
  },
);
it.each(['release', 'adopt', 'acquire', 'identity', 'verify'] as const)(
  'waits through a 150ms filesystem guard before %s',
  async (operation) => {
    const target = port();
    const handle = await acquire(target);
    const guard = join(dataRoot, 'runtime', 'startup-claim.guard');
    await mkdir(guard);
    const pending =
      operation === 'release'
        ? target.release(handle)
        : operation === 'adopt'
          ? target.adopt(handle)
          : operation === 'acquire'
            ? target.tryAcquire()
            : operation === 'identity'
              ? target.identity(handle)
              : target.verify(claim(handle));
    await delay(150);
    await rmdir(guard);
    expect(await pending).toEqual(
      operation === 'release'
        ? 'released'
        : operation === 'adopt'
          ? { kind: 'acquired', handle }
          : operation === 'acquire'
            ? { kind: 'held' }
            : operation === 'identity'
              ? claim(handle)
              : true,
    );
  },
);
it.each(['release', 'adopt', 'acquire'] as const)(
  'does not hold the guard during slow process inspection: %s',
  async (operation) => {
    const target = port();
    const handle = await acquire(target);
    let entered = (): void => {};
    let finish = (): void => {};
    const inspecting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const resume = new Promise<void>((resolve) => {
      finish = resolve;
    });
    inspectProcess.mockImplementationOnce(async () => {
      entered();
      await resume;
      return inspection;
    });
    const polling = target.tryAcquire();
    await inspecting;
    // The poll stays in inspection until the competing operation has completed.
    const result =
      operation === 'release'
        ? await target.release(handle)
        : operation === 'adopt'
          ? await target.adopt(handle)
          : await target.tryAcquire();
    finish();
    expect(await polling).toEqual({ kind: 'held' });
    expect(result).toEqual(
      operation === 'release'
        ? 'released'
        : operation === 'adopt'
          ? { kind: 'acquired', handle }
          : { kind: 'held' },
    );
  },
);
it.each(['identity', 'verify'] as const)(
  'rejects %s inspection of a released and reacquired record',
  async (operation) => {
    const target = port();
    const first = await acquire(target);
    let entered = (): void => {};
    let finish = (): void => {};
    const inspecting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const resume = new Promise<void>((resolve) => {
      finish = resolve;
    });
    inspectProcess.mockImplementationOnce(async () => {
      entered();
      await resume;
      return inspection;
    });
    const checking =
      operation === 'identity'
        ? target.identity(first)
        : target.verify(claim(first));
    await inspecting;
    const released = await target.release(first);
    if (released === 'released') await acquire(target);
    finish();
    const result = await checking;
    expect(released).toBe('released');
    expect(result).toEqual(operation === 'identity' ? null : false);
  },
);
it('makes stale release harmless after release/reacquire with a unique token', async () => {
  const target = port();
  const first = await acquire(target);
  expect(await target.release(first)).toBe('released');
  const second = await acquire(target);
  expect(claim(second).claimId).not.toBe(claim(first).claimId);
  expect(await target.release(first)).toBe('not_owner');
  expect(await target.identity(first)).toBeNull();
  expect(await target.identity(second)).toEqual(claim(second));
  expect(await target.verify(claim(second))).toBe(true);
  expect(await target.release(second)).toBe('released');
  expect(await target.release(second)).toBe('not_owner');
});
it('adopts a serialized handoff after launcher crash, preserving token and updating owner', async () => {
  const original = await acquire();
  const handoff = serialize(original);
  inspection = { kind: 'dead' };
  expect(await port().tryAcquire()).toEqual({ kind: 'ambiguous' });
  const daemon = port(child);
  const adopted = await daemon.adopt(handoff);
  expect(adopted).toEqual({ kind: 'acquired', handle: handoff });
  inspection = { kind: 'alive', startIdentity: child.startIdentity };
  expect(await port().verify(claim(handoff))).toBe(true);
  expect(await daemon.identity(handoff)).toEqual(claim(original));
  expect(inspectProcess).toHaveBeenLastCalledWith(child.pid, undefined);
  expect(
    await port({ pid: 303, startIdentity: 'other' }).adopt(handoff),
  ).toEqual({ kind: 'ambiguous' });
  expect(await daemon.adopt(handoff)).toEqual(adopted);
  inspection = { kind: 'dead' }; // Supervisor has confirmed child exit.
  expect(await port().release(original)).toBe('released');
});
it('rejects foreign, forged and malformed adoption without changing the record', async () => {
  const handle = await acquire();
  const before = await readFile(
    join(dataRoot, 'runtime', 'startup-claim.json'),
    'utf8',
  );
  const serialized = serialize(handle);
  for (const foreign of [
    {},
    { ...serialized, dataRoot: '/foreign' },
    { ...serialized, launcher: child },
    { ...serialized, claimId: 'invalid' },
  ]) {
    expect(await port(child).adopt(foreign)).toEqual({ kind: 'ambiguous' });
    expect(await port().identity(foreign)).toBeNull();
  }
  expect(await port().verify({ ...claim(handle), dataRoot: '/foreign' })).toBe(
    false,
  );
  expect(
    await readFile(join(dataRoot, 'runtime', 'startup-claim.json'), 'utf8'),
  ).toBe(before);
});
it.each<CanopyStartupProcessInspection>([
  { kind: 'dead' },
  { kind: 'unknown' },
  { kind: 'alive', startIdentity: 'reused-pid' },
])('never recovers a crashed/uncertain claim: %j', async (state) => {
  const handle = await acquire();
  inspection = state;
  expect(await port().tryAcquire()).toEqual({ kind: 'ambiguous' });
  expect(await port().verify(claim(handle))).toBe(false);
  expect(await port().identity(handle)).toBeNull();
});
it('leaves crashed guards and malformed records untouched, never unlinking endpoints', async () => {
  const guard = join(dataRoot, 'runtime', 'startup-claim.guard');
  const endpoint = join(dataRoot, 'runtime', 'endpoint.sock');
  const handle = await acquire();
  await writeFile(endpoint, 'endpoint');
  await mkdir(guard);
  expect(
    await Promise.all([
      port().tryAcquire(),
      port().release(handle),
      port(child).adopt(handle),
      port().identity(handle),
      port().verify(claim(handle)),
    ]),
  ).toEqual([
    { kind: 'ambiguous' },
    'ambiguous',
    { kind: 'ambiguous' },
    null,
    false,
  ]);
  await rm(guard, { recursive: true });
  await writeFile(join(dataRoot, 'runtime', 'startup-claim.json'), '{broken');
  expect(await port().tryAcquire()).toEqual({ kind: 'ambiguous' });
  expect(await port().release(handle)).toBe('ambiguous');
  expect(await readFile(endpoint, 'utf8')).toBe('endpoint');
});
it('fails closed on inspection failure, missing private directory and cancellation', async () => {
  const signal = AbortSignal.abort();
  expect(await port().tryAcquire(signal)).toEqual({ kind: 'ambiguous' });
  const handle = await acquire();
  expect(await port(child).adopt(handle, signal)).toEqual({
    kind: 'ambiguous',
  });
  inspectProcess.mockRejectedValueOnce(new Error('inspection unavailable'));
  expect(await port().tryAcquire()).toEqual({ kind: 'ambiguous' });
  expect(await port().release(handle)).toBe('released');
  await rm(join(dataRoot, 'runtime'), { recursive: true });
  expect(await port().tryAcquire()).toEqual({ kind: 'ambiguous' });
});

const recover = { recoverDeparted: true } as const;
it('recovers its retained bound claim by token while the launcher remains live', async () => {
  const departed = await acquire();
  await port().markEndpointBind(departed);
  inspection = { kind: 'dead' };
  const target = port(child);
  const recovered = await target.tryAcquire(undefined, recover);
  if (recovered.kind !== 'acquired') throw new Error('Expected recovery');
  expect(
    await target.release(recovered.handle, { preserveEndpointBind: true }),
  ).toBe('not_owner');
  inspection = { kind: 'alive', startIdentity: child.startIdentity };
  // Only the supervisor retains this capability after confirmed child cleanup.
  const retry = { ...recover, recoverOwnHandle: recovered.handle };
  expect(await port().tryAcquire(undefined, retry)).toEqual({ kind: 'held' });
  const next = await target.tryAcquire(undefined, retry);
  expect(next).toMatchObject({
    kind: 'acquired',
    recovered: { endpointBound: true },
  });
  if (next.kind !== 'acquired') throw new Error('Expected own recovery');
  expect(claim(next.handle).claimId).not.toBe(claim(recovered.handle).claimId);
  expect(await target.release(recovered.handle)).toBe('not_owner');
  expect(await port(launcher).adopt(recovered.handle)).toEqual({
    kind: 'ambiguous',
  });
  expect(await target.tryAcquire(undefined, retry)).toEqual({ kind: 'held' });
  expect(
    await target.tryAcquire(undefined, {
      ...recover,
      recoverOwnHandle: next.handle,
    }),
  ).toMatchObject({ recovered: { endpointBound: true } });
});
it('admits one own recovery contender and refuses unknown state and cancellation', async () => {
  const handle = await acquire();
  await port().markEndpointBind(handle);
  const retry = { ...recover, recoverOwnHandle: handle };
  inspection = { kind: 'unknown' };
  expect(await port().tryAcquire(undefined, retry)).toEqual({
    kind: 'ambiguous',
  });
  inspection = { kind: 'alive', startIdentity: launcher.startIdentity };
  expect(await port().tryAcquire(AbortSignal.abort(), retry)).toEqual({
    kind: 'ambiguous',
  });
  const results = await Promise.all([
    port().tryAcquire(undefined, retry),
    port().tryAcquire(undefined, retry),
  ]);
  expect(results.filter((result) => result.kind === 'acquired')).toHaveLength(
    1,
  );
  expect(results.filter((result) => result.kind === 'held')).toHaveLength(1);
});
it('never lets a launcher recover the claim of a live adopting child by token', async () => {
  const handle = await acquire();
  await port(child).adopt(handle);
  await port(child).markEndpointBind(handle);
  inspection = { kind: 'alive', startIdentity: child.startIdentity };
  const retry = { ...recover, recoverOwnHandle: handle };
  const before = await record();
  expect(await port().tryAcquire(undefined, retry)).toEqual({ kind: 'held' });
  expect(await record()).toEqual(before);
});
it('refuses own recovery when adoption wins during inspection or cancellation arrives', async () => {
  const handle = await acquire();
  await port().markEndpointBind(handle);
  const retry = { ...recover, recoverOwnHandle: handle };
  inspectProcess.mockImplementationOnce(async () => {
    await port(child).adopt(handle);
    return { kind: 'alive', startIdentity: launcher.startIdentity };
  });
  expect(await port().tryAcquire(undefined, retry)).toEqual({ kind: 'held' });
  expect(await record()).toMatchObject({ owner: child, endpointBound: true });
  inspection = { kind: 'dead' };
  const recovered = await port().tryAcquire(undefined, recover);
  if (recovered.kind !== 'acquired') throw new Error('Expected recovery');
  const controller = new AbortController();
  inspectProcess.mockImplementationOnce(() => {
    controller.abort();
    return Promise.resolve({
      kind: 'alive',
      startIdentity: launcher.startIdentity,
    });
  });
  expect(
    await port().tryAcquire(controller.signal, {
      ...recover,
      recoverOwnHandle: recovered.handle,
    }),
  ).toEqual({ kind: 'ambiguous' });
  expect(await record()).toMatchObject({
    claimId: claim(recovered.handle).claimId,
    endpointBound: true,
  });
});
async function record(): Promise<Record<string, unknown>> {
  return z
    .record(z.string(), z.unknown())
    .parse(
      JSON.parse(
        await readFile(join(dataRoot, 'runtime', 'startup-claim.json'), 'utf8'),
      ),
    );
}
it.each<CanopyStartupProcessInspection>([
  { kind: 'dead' },
  { kind: 'alive', startIdentity: 'reused-pid' },
])(
  'replaces a departed owner only on request, voiding its token: %j',
  async (state) => {
    const handle = await acquire();
    inspection = state;
    expect(await port(child).tryAcquire()).toEqual({ kind: 'ambiguous' });
    const recovered = await port(child).tryAcquire(undefined, recover);
    expect(recovered).toMatchObject({
      kind: 'acquired',
      recovered: { endpointBound: false },
    });
    if (recovered.kind !== 'acquired') throw new Error('Expected recovery');
    expect(claim(recovered.handle).claimId).not.toBe(claim(handle).claimId);
    expect(await record()).toMatchObject({
      claimId: claim(recovered.handle).claimId,
      launcher: child,
      owner: child,
    });
    expect(await record()).not.toHaveProperty('endpointBound');
    expect(await port().release(handle)).toBe('not_owner');
    expect(await port(child).release(recovered.handle)).toBe('released');
  },
);
it.each<[CanopyStartupProcessInspection, string]>([
  [{ kind: 'unknown' }, 'ambiguous'],
  [{ kind: 'alive', startIdentity: launcher.startIdentity }, 'held'],
])('never replaces a live or unprovable owner: %j', async (state, kind) => {
  await acquire();
  const before = await record();
  inspection = state;
  expect(await port(child).tryAcquire(undefined, recover)).toEqual({ kind });
  expect(await record()).toEqual(before);
});
it('carries a bind marker from the departed owner into the recovered claim', async () => {
  const handle = await acquire();
  expect(await port().markEndpointBind(handle)).toBe(true);
  expect(await port().markEndpointBind(handle)).toBe(true);
  expect(await record()).toMatchObject({ endpointBound: true });
  inspection = { kind: 'dead' };
  const recovered = await port(child).tryAcquire(undefined, recover);
  expect(recovered).toMatchObject({ recovered: { endpointBound: true } });
  expect(await record()).toMatchObject({ owner: child, endpointBound: true });
  // A second departure keeps the evidence: the socket is still a dead holder's.
  const next = await port().tryAcquire(undefined, recover);
  expect(next).toMatchObject({ recovered: { endpointBound: true } });
});
it('hands a departed bind marker to the adopting child, even after launcher crash', async () => {
  expect(await port().markEndpointBind(await acquire())).toBe(true);
  inspection = { kind: 'dead' };
  const recovered = await port(child).tryAcquire(undefined, recover);
  if (recovered.kind !== 'acquired') throw new Error('Expected recovery');
  const handoff = serialize(recovered.handle);
  const before = await record();
  const daemon = { pid: 404, startIdentity: 'daemon-start' };
  // Wrong root, forged launcher and a third process are refused unchanged.
  await mkdir(join(dataRoot, 'other', 'runtime'), { recursive: true });
  for (const [owner, root, handle] of [
    [daemon, join(dataRoot, 'other'), handoff],
    [daemon, dataRoot, { ...handoff, launcher: daemon }],
  ] as const)
    expect(await port(owner, root).adopt(handle)).toEqual({
      kind: 'ambiguous',
    });
  expect(await record()).toEqual(before);
  // The launcher (child) has crashed; token proof alone permits adoption.
  expect(await port(daemon).adopt(handoff)).toEqual({
    kind: 'acquired',
    handle: handoff,
    recovered: { endpointBound: true },
  });
  expect(await record()).toMatchObject({ owner: daemon, endpointBound: true });
  // Re-adoption by the new owner: the marker may now be its own bind.
  expect(await port(daemon).adopt(handoff)).toEqual({
    kind: 'acquired',
    handle: handoff,
  });
  expect(
    await port({ pid: 505, startIdentity: 'other' }).adopt(handoff),
  ).toEqual({ kind: 'ambiguous' });
});
it('retains the adopted child bind evidence through launcher release and the next startup', async () => {
  const handle = await acquire();
  await port(child).adopt(handle);
  expect(await port(child).markEndpointBind(handle)).toBe(true);
  inspection = { kind: 'dead' };
  expect(await port().release(handle)).toBe('not_owner');
  expect(await record()).toMatchObject({ owner: child, endpointBound: true });
  const nextLauncher = { pid: 303, startIdentity: 'next-launcher' };
  const next = await port(nextLauncher).tryAcquire(undefined, recover);
  if (next.kind !== 'acquired') throw new Error('Expected recovered claim');
  expect(next.recovered).toEqual({ endpointBound: true });
  expect(
    await port({ pid: 404, startIdentity: 'next-child' }).adopt(next.handle),
  ).toMatchObject({ recovered: { endpointBound: true } });
});
it('retains recovered bind evidence when the next launcher fails before adoption', async () => {
  expect(await port().markEndpointBind(await acquire())).toBe(true);
  inspection = { kind: 'dead' };
  const recovered = await port(child).tryAcquire(undefined, recover);
  if (recovered.kind !== 'acquired')
    throw new Error('Expected recovered claim');
  expect(
    await port(child).release(recovered.handle, { preserveEndpointBind: true }),
  ).toBe('not_owner');
  expect(await port().tryAcquire(undefined, recover)).toMatchObject({
    recovered: { endpointBound: true },
  });
});
it('marks a bind only for the current owner of a matching claim', async () => {
  const handle = await acquire();
  const before = await record();
  expect(await port(child).markEndpointBind(handle)).toBe(false);
  expect(await port().markEndpointBind({})).toBe(false);
  expect(await port().markEndpointBind(serialize(handle))).toBe(true);
  expect(await port().release(handle)).toBe('released');
  expect(await port().markEndpointBind(handle)).toBe(false);
  expect(before).not.toHaveProperty('endpointBound');
});
it('never replaces a claim that changed while its owner was inspected', async () => {
  const handle = await acquire();
  const successor = { pid: 303, startIdentity: 'successor-start' };
  inspectProcess.mockImplementationOnce(async () => {
    expect(await port().release(handle)).toBe('released');
    await acquire(port(successor));
    return { kind: 'dead' };
  });
  expect(await port(child).tryAcquire(undefined, recover)).toEqual({
    kind: 'held',
  });
  expect(await record()).toMatchObject({ owner: successor });
});

it.each(['missing', 'token', 'root', 'launcher'] as const)(
  'rejects a %s own capability against a live bound claim',
  async (mutation) => {
    const handle = await acquire();
    await port().markEndpointBind(handle);
    const copy = { ...serialize(handle) };
    if (mutation === 'token')
      copy.claimId = '00000000-0000-4000-8000-000000000000';
    if (mutation === 'root') copy.dataRoot = '/foreign';
    if (mutation === 'launcher') copy.launcher = child;
    const before = await record();
    expect(
      await port().tryAcquire(undefined, {
        recoverOwnHandle: mutation === 'missing' ? {} : copy,
      }),
    ).toEqual({ kind: 'held' });
    expect(await record()).toEqual(before);
  },
);
it('requires departed recovery opt-in even with the current token', async () => {
  const handle = await acquire();
  await port().markEndpointBind(handle);
  const before = await record();
  inspection = { kind: 'alive', startIdentity: 'replacement-launcher' };
  expect(
    await port().tryAcquire(undefined, { recoverOwnHandle: handle }),
  ).toEqual({ kind: 'ambiguous' });
  expect(await record()).toEqual(before);
});

it('accepts launcher cancellation without mistaking the signal for release options', async () => {
  const handle = await acquire();
  const before = await record();
  expect(await port().release(handle, AbortSignal.abort())).toBe('ambiguous');
  expect(await record()).toEqual(before);
  expect(await port().release(handle, new AbortController().signal)).toBe(
    'released',
  );
});

it.each(['matching', 'changed', 'unknown'] as const)(
  'Windows claim incarnation protection: %s',
  async (state) => {
    const owner = {
      pid: 4242,
      startIdentity: 'win32:v1:4242:20261008062326123456',
    };
    const held = port(owner);
    inspection = { kind: 'alive', startIdentity: owner.startIdentity };
    const handle = await acquire(held);
    const before = await record();
    inspection =
      state === 'unknown'
        ? { kind: 'unknown' }
        : {
            kind: 'alive',
            startIdentity:
              state === 'matching'
                ? owner.startIdentity
                : 'win32:v1:4242:20261008062326123457',
          };
    const result = await port(child).tryAcquire(undefined, recover);
    if (state === 'changed') {
      expect(result.kind).toBe('acquired');
      if (result.kind !== 'acquired') throw new Error('Expected replacement');
      expect(await held.release(handle)).toBe('not_owner');
      expect(await port(child).release(result.handle)).toBe('released');
    } else {
      expect(result.kind).toBe(state === 'matching' ? 'held' : 'ambiguous');
      expect(await record()).toEqual(before);
    }
  },
);
