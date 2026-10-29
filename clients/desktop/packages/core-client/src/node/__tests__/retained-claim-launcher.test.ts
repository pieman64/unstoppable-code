import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCanopyStartupClaimPort } from '@canopy/core-transport/node';
import { attachOrStartCanopyDaemon } from '../launcher';
import { createRecoverableCanopyStartupClaim } from '../recoverable-startup-claim';
import { ScriptedDaemon } from './fixtures/scripted-daemon';

it.each([true, false])(
  'arms bound recovery only after confirmed group cleanup (%s)',
  async (confirmed) => {
    const dataRoot = await realpath(
      await mkdtemp(join(tmpdir(), 'retained-launch-')),
    );
    try {
      await mkdir(join(dataRoot, 'runtime'), { mode: 0o700 });
      const departed = { pid: 101, startIdentity: 'departed' };
      const owner = { pid: 202, startIdentity: 'launcher' };
      const inspection = (
        pid: number,
      ): Promise<{ kind: 'alive'; startIdentity: string } | { kind: 'dead' }> =>
        Promise.resolve(
          pid === owner.pid
            ? { kind: 'alive', startIdentity: owner.startIdentity }
            : { kind: 'dead' },
        );
      const old = createCanopyStartupClaimPort({
        dataRoot,
        owner: departed,
        inspectProcess: inspection,
      });
      const first = await old.tryAcquire();
      if (first.kind !== 'acquired') throw new Error('Expected departed claim');
      await old.markEndpointBind(first.handle);
      const port = createCanopyStartupClaimPort({
        dataRoot,
        owner,
        inspectProcess: inspection,
      });
      const claim = createRecoverableCanopyStartupClaim(() =>
        Promise.resolve(port),
      );
      const release = jest.spyOn(claim, 'release');
      const signal = new AbortController().signal;
      for (let attempt = 0; attempt < (confirmed ? 3 : 1); attempt++) {
        const world = new ScriptedDaemon();
        world.child = (pid): void => world.exit(pid);
        if (!confirmed)
          world.gates.set('terminate', () =>
            Promise.reject(new Error('Unconfirmed cleanup')),
          );
        await expect(
          attachOrStartCanopyDaemon({
            dataRoot,
            dataRootHash: 'a'.repeat(64),
            runtimeMode: 'production',
            daemon: { executable: '/private/daemon' },
            ports: {
              descriptor: world.descriptor,
              supervisor: world.supervisor,
              claim,
            },
            attach: world.attach,
            dispose: () => {},
            platform: 'darwin',
            timeoutMs: 2_000,
            probeIntervalMs: 1,
          }),
        ).rejects.toThrow(
          confirmed
            ? 'Core exited before it was ready.'
            : 'Core cleanup failed.',
        );
        expect(world.count('spawn')).toBe(1);
        if (confirmed) {
          const handle = release.mock.calls[attempt]?.[0];
          expect(handle).toBeDefined();
          expect(release.mock.calls[attempt]?.[1]?.aborted).toBe(false);
          const competitor = createCanopyStartupClaimPort({
            dataRoot,
            owner: departed,
            inspectProcess: inspection,
          });
          expect(
            await competitor.tryAcquire(signal, { recoverDeparted: true }),
          ).toEqual({ kind: 'held' });
          if (attempt > 0)
            expect(handle).not.toEqual(release.mock.calls[attempt - 1]?.[0]);
        }
      }
      if (confirmed) {
        const next = await claim.tryAcquire(signal);
        expect(next).toMatchObject({
          kind: 'acquired',
          recovered: { endpointBound: true },
        });
        for (const [handle] of release.mock.calls)
          expect(await old.adopt(handle)).toEqual({ kind: 'ambiguous' });
      } else {
        expect(release).not.toHaveBeenCalled();
        expect(await claim.tryAcquire(signal)).toEqual({ kind: 'held' });
      }
    } finally {
      await rm(dataRoot, { recursive: true, force: true });
    }
  },
);
