import { spawn, type SpawnOptionsWithoutStdio } from 'node:child_process';
import type * as ChildProcessModule from 'node:child_process';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { existsSync, promises as fsPromises, type BigIntStats } from 'node:fs';
import * as MainProcessLogging from '../lib/main-process-logging';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  materializeCodeRevision,
  type MaterializeCodeDependencies,
  type MaterializeCodeRevisionOptions,
  type MaterializeCodeResult,
} from '../shared-containers/materialize/code';
import { SharedContainerReplicaManager } from '../shared-containers/replica/manager';
import { SharedContainerReconciliationService } from '../shared-containers/reconciliation-service';
import {
  makeReplicaTreeReadOnly,
  makeReplicaTreeWritable,
  SharedContainerReplicaStore,
} from '../shared-containers/replica/store';
import type { SharedContainerReplicaTransport } from '../shared-containers/transport';
import {
  buildSharedContainerReplicaFixture as buildFixture,
  fetchForSharedContainerFixture as fetchFor,
  transportForSharedContainerFixture as transportFor,
} from './fixtures/shared-container-replica-fixture';
import { getWorktreeDataDir } from '../lib/paths';
import { SHARED_CONTAINER_VIEWER_PROJECT_ID } from '@canopy/desktop-shared/types';
import type {
  SharedContainerDetail,
  SharedContainerFetchRevisionResponse,
} from '@canopy/protocol/shared-containers';

jest.mock('node:child_process', () => {
  const actual =
    jest.requireActual<typeof ChildProcessModule>('node:child_process');
  return { ...actual, spawn: jest.fn(actual.spawn) };
});

const actualSpawn =
  jest.requireActual<typeof ChildProcessModule>('node:child_process').spawn;
const mockedSpawn = jest.mocked(spawn);

const STALLED_REPLICA_CLEANUP_SCRIPT = String.raw`
const { lstat } = require('node:fs/promises');

async function main() {
  const identity = await lstat('.', { bigint: true });
  process.stdout.write(JSON.stringify({
    type: 'identity',
    dev: String(identity.dev),
    ino: String(identity.ino),
  }) + '\n');
  for await (const chunk of process.stdin) {
    if (String(chunk).includes('clean')) break;
  }
  setInterval(() => undefined, 1_000);
}

main().catch(() => {
  process.exitCode = 1;
});
`;

type IdentityStoreSeams = {
  lstatIfPresent(path: string): Promise<BigIntStats | null>;
  writeRootMarker(marker: Record<string, unknown>): Promise<void>;
  emptyBoundQuarantine(
    path: string,
    identity: Record<string, string>,
  ): Promise<void>;
};

const identityTestState = {
  status: 'nothing-published' as const,
  containerId: 'identity-test',
  containerType: 'COWORK_WORK_ENTRY' as const,
  updatedAt: '2026-10-14T00:00:00Z',
};

async function identityFixture(
  overrides: Record<string, unknown> = {},
): Promise<{
  parentDir: string;
  rootDir: string;
  markerPath: string;
  marker: Record<string, unknown>;
  info: BigIntStats;
  store: SharedContainerReplicaStore;
  seams: IdentityStoreSeams;
}> {
  const parentDir = await mkdtemp(join(tmpdir(), 'replica-identity-'));
  const rootDir = join(parentDir, 'replica');
  await mkdir(rootDir);
  const info = await lstat(rootDir, { bigint: true });
  const markerPath = join(parentDir, '.replica.identity.json');
  const marker = {
    version: 1,
    state: 'active',
    dev: String(info.dev),
    ino: String(info.ino),
    ...(info.birthtimeNs > 0n ? { birthtime: String(info.birthtimeNs) } : {}),
    ...overrides,
  };
  await writeFile(markerPath, JSON.stringify(marker));
  const store = new SharedContainerReplicaStore(rootDir);
  const seams = store as unknown as IdentityStoreSeams;
  return { parentDir, rootDir, markerPath, marker, info, store, seams };
}

function injectRootStats(
  fixture: Awaited<ReturnType<typeof identityFixture>>,
  fields: Partial<BigIntStats>,
): void {
  const original = fixture.seams.lstatIfPresent.bind(fixture.seams);
  jest
    .spyOn(fixture.seams, 'lstatIfPresent')
    .mockImplementation(async (path) => {
      const info = await original(path);
      return path === fixture.rootDir && info
        ? Object.assign(info, fields)
        : info;
    });
}

// The parent and the real cleanup child must report the same creation time,
// including on filesystems where the native birthtime is zero.
function injectCleanupBirthtime(
  seams: IdentityStoreSeams,
  birthtime: bigint,
): void {
  const original = seams.lstatIfPresent.bind(seams);
  jest.spyOn(seams, 'lstatIfPresent').mockImplementation(async (path) => {
    const info = await original(path);
    return info ? Object.assign(info, { birthtimeNs: birthtime }) : info;
  });
  mockedSpawn.mockImplementationOnce((command, args, options) => {
    const script = String(args?.[2])
      .replace('identity.birthtimeNs > 0n', 'true')
      .replace(
        'String(identity.birthtimeNs)',
        JSON.stringify(String(birthtime)),
      );
    return actualSpawn(
      command,
      ['--input-type=commonjs', '--eval', script],
      options as SpawnOptionsWithoutStdio,
    );
  });
}

describe('replica persisted identity migration', () => {
  it.each([
    ['same', '1', '10', '9007199254740993', '1', '10', '9007199254740993'],
    ['remounted', '1', '10', '9007199254740993', '2', '10', '9007199254740993'],
    ['changed', '1', '10', '9007199254740993', '1', '10', '9007199254740992'],
    ['changed', '1', '10', '20', '2', '10', '21'],
    ['changed', '1', '10', '20', '1', '11', '20'],
    ['changed', '1', '10', undefined, '2', '11', undefined],
    ['same', '1', '10', undefined, '1', '10', '20'],
    ['same', '1', '10', '20', '1', '10', undefined],
    ['same', '1', '10', undefined, '1', '10', undefined],
    ['unconfirmed', '1', '10', undefined, '2', '10', '20'],
    ['unconfirmed', '1', '10', '20', '2', '10', undefined],
    ['unconfirmed', '1', '10', undefined, '2', '10', undefined],
  ])(
    'classifies %s for saved %s/%s/%s and current %s/%s/%s',
    async (
      verdict,
      dev,
      ino,
      birthtime,
      currentDev,
      currentIno,
      currentBirthtime,
    ) => {
      const fixture = await identityFixture({ dev, ino, birthtime });
      injectRootStats(fixture, {
        dev: BigInt(currentDev),
        ino: BigInt(currentIno),
        birthtimeNs: BigInt(currentBirthtime ?? 0),
      });
      const writing = fixture.store.set(identityTestState);
      if (verdict === 'changed' || verdict === 'unconfirmed') {
        await expect(writing).rejects.toMatchObject({
          message: 'Shared-container replica root identity changed',
          verdict,
        });
        expect(JSON.parse(await readFile(fixture.markerPath, 'utf8'))).toEqual(
          fixture.marker,
        );
        await expect(stat(fixture.store.indexPath)).rejects.toMatchObject({
          code: 'ENOENT',
        });
      } else {
        await writing;
        expect(JSON.parse(await readFile(fixture.markerPath, 'utf8'))).toEqual({
          version: 1,
          state: 'active',
          dev: currentDev,
          ino: currentIno,
          ...((currentBirthtime ?? birthtime)
            ? { birthtime: currentBirthtime ?? birthtime }
            : {}),
        });
      }
    },
  );

  it.each([undefined, '0', '', '01', '-1', '1.2', '1\n', 'bad', 123, null])(
    'treats optional birthtime %p as legacy and upgrades it',
    async (birthtime) => {
      const fixture = await identityFixture({ birthtime });
      injectRootStats(fixture, { birthtimeNs: 9007199254740993n });
      await fixture.store.set(identityTestState);
      expect(
        JSON.parse(await readFile(fixture.markerPath, 'utf8')),
      ).toMatchObject({ birthtime: '9007199254740993' });
    },
  );

  it('omits zero birthtime without repeated marker migrations', async () => {
    const fixture = await identityFixture({ birthtime: undefined });
    injectRootStats(fixture, { birthtimeNs: 0n });
    const write = jest.spyOn(fixture.seams, 'writeRootMarker');
    await fixture.store.set(identityTestState);
    await fixture.store.set(identityTestState);
    expect(write).not.toHaveBeenCalled();
    expect(await readFile(fixture.markerPath, 'utf8')).not.toContain(
      'birthtime',
    );
  });

  it.each([{ dev: 'bad' }, { ino: 123 }, { version: 2 }])(
    'still rejects required marker corruption %p',
    async (overrides) => {
      const fixture = await identityFixture(overrides);
      await expect(fixture.store.set(identityTestState)).rejects.toThrow(
        'root marker is invalid',
      );
      await expect(fixture.store.purgeAllBytes()).rejects.toThrow(
        'root marker is invalid',
      );
      expect(JSON.parse(await readFile(fixture.markerPath, 'utf8'))).toEqual(
        fixture.marker,
      );
      expect((await lstat(fixture.rootDir)).isDirectory()).toBe(true);
    },
  );

  it.each(['same', 'remounted'])(
    'does not mutate if %s migration cannot persist',
    async (mode) => {
      const fixture = await identityFixture({
        birthtime: mode === 'same' ? undefined : '20',
      });
      injectRootStats(fixture, {
        birthtimeNs: 20n,
        ...(mode === 'remounted' ? { dev: fixture.info.dev + 1n } : {}),
      });
      jest
        .spyOn(fixture.seams, 'writeRootMarker')
        .mockRejectedValueOnce(new Error('marker write failed'));
      await expect(fixture.store.set(identityTestState)).rejects.toThrow(
        'marker write failed',
      );
      await expect(stat(fixture.store.indexPath)).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await fixture.store.set(identityTestState);
    },
  );

  it('keeps cached contents through confirmed remount sync and warns once', async () => {
    const fixture = await identityFixture({
      dev: '0',
      birthtime: '9007199254740993',
    });
    const contents = join(fixture.rootDir, 'sentinel');
    await writeFile(contents, 'cached');
    const revision = await buildFixture();
    const manager = new SharedContainerReplicaManager({
      rootDir: fixture.rootDir,
      transport: transportFor(revision),
      fetchImpl: fetchFor(revision),
    });
    const managerFixture = {
      ...fixture,
      seams: manager.store as unknown as IdentityStoreSeams,
    };
    injectRootStats(managerFixture, { birthtimeNs: 9007199254740993n });
    const warning = jest.spyOn(MainProcessLogging, 'logMainProcessWarn');
    try {
      await manager.sync('container-1', 'org-1');
      await manager.sync('container-1', 'org-1');
      expect(await readFile(contents, 'utf8')).toBe('cached');
      expect(
        JSON.parse(await readFile(fixture.markerPath, 'utf8')),
      ).toMatchObject({ dev: String(fixture.info.dev) });
      expect(
        warning.mock.calls.filter(([message]) => /remount/i.test(message)),
      ).toHaveLength(1);
    } finally {
      warning.mockRestore();
    }
  });
});

describe('replica purge identity recovery', () => {
  it.each(['purging', 'purged'] as const)(
    'rejects invalid quarantine names before %s journal recovery',
    async (state) => {
      for (const quarantine of [
        '',
        '.',
        '..',
        '../outside',
        '/outside',
        '\\outside',
        '\0',
        123,
      ]) {
        const fixture = await identityFixture({ state, quarantine, ino: '0' });
        const sentinel = join(fixture.rootDir, 'sentinel');
        await writeFile(sentinel, 'survives malformed marker');
        const cleanup = jest.spyOn(fixture.seams, 'emptyBoundQuarantine');
        await expect(fixture.store.purgeAllBytes()).rejects.toThrow(
          'root marker is invalid',
        );
        expect(cleanup).not.toHaveBeenCalled();
        expect(await readFile(sentinel, 'utf8')).toBe(
          'survives malformed marker',
        );
        expect(JSON.parse(await readFile(fixture.markerPath, 'utf8'))).toEqual(
          fixture.marker,
        );
      }
    },
  );

  it.each(['direct', 'sign-out', 'purging', 'purged'] as const)(
    'confirms a remount during %s cleanup even without native creation time',
    async (mode) => {
      const birthtime = 9007199254740993n;
      const fixture = await identityFixture({ birthtime: String(birthtime) });
      const quarantine = '.replica.purge-confirmed-remount';
      const interrupted = mode === 'purging' || mode === 'purged';
      const previousDevice = String(fixture.info.dev + 1n);
      await writeFile(join(fixture.rootDir, 'discard'), 'cached bytes');
      if (interrupted)
        await rename(fixture.rootDir, join(fixture.parentDir, quarantine));
      await writeFile(
        fixture.markerPath,
        JSON.stringify({
          ...fixture.marker,
          dev: previousDevice,
          ...(interrupted ? { state: mode, quarantine } : {}),
        }),
      );
      const revision = await buildFixture();
      const transport = transportFor(revision);
      const manager = new SharedContainerReplicaManager({
        rootDir: fixture.rootDir,
        transport,
        fetchImpl: fetchFor(revision),
      });
      const store = mode === 'sign-out' ? manager.store : fixture.store;
      const seams = store as unknown as IdentityStoreSeams;
      injectCleanupBirthtime(seams, birthtime);
      const write = jest.spyOn(seams, 'writeRootMarker');
      const warning = jest.spyOn(MainProcessLogging, 'logMainProcessWarn');
      try {
        if (mode === 'sign-out') {
          const service = new SharedContainerReconciliationService(
            manager,
            transport,
          );
          let accountPersisted = false;
          await service.withReplicaPurgeFence(async () => {
            await expect(lstat(fixture.rootDir)).rejects.toMatchObject({
              code: 'ENOENT',
            });
            expect(
              JSON.parse(await readFile(fixture.markerPath, 'utf8')),
            ).toEqual({
              version: 1,
              state: 'absent',
            });
            accountPersisted = true;
          });
          expect(accountPersisted).toBe(true);
        } else {
          await store.purgeAllBytes();
        }
        expect(
          warning.mock.calls.filter(([message]) => /remount/i.test(message)),
        ).toEqual([
          [
            interrupted
              ? 'Shared-container purge journal remounted'
              : 'Shared-container replica root remounted',
            { previousDevice, currentDevice: String(fixture.info.dev) },
          ],
        ]);
        expect(
          warning.mock.calls.filter(([message]) => /discarding/i.test(message)),
        ).toEqual([]);
        expect(
          write.mock.calls.filter(([marker]) => marker.state !== 'absent'),
        ).not.toHaveLength(0);
        for (const [marker] of write.mock.calls) {
          if (marker.state !== 'absent') {
            expect(marker).toMatchObject({
              dev: String(fixture.info.dev),
              ino: String(fixture.info.ino),
              birthtime: String(birthtime),
            });
          }
        }
        expect(await readdir(fixture.parentDir)).toEqual([
          '.replica.identity.json',
        ]);
      } finally {
        warning.mockRestore();
      }
    },
  );

  it.each(['remounted', 'unconfirmed', 'changed', 'absent'])(
    'discards a %s real root through explicit purge',
    async (mode) => {
      const fixture = await identityFixture();
      const originalPath = join(fixture.parentDir, 'original');
      await writeFile(join(fixture.rootDir, 'sentinel'), 'original');
      if (mode === 'changed') {
        await rename(fixture.rootDir, originalPath);
        await mkdir(fixture.rootDir);
      }
      await writeFile(join(fixture.rootDir, 'discard'), 'cache');
      await writeFile(
        fixture.markerPath,
        JSON.stringify({
          ...fixture.marker,
          ...(mode === 'absent' ? { state: 'absent' } : {}),
          ...(mode === 'remounted' || mode === 'unconfirmed'
            ? { dev: String(fixture.info.dev + 1n) }
            : {}),
          ...(mode === 'unconfirmed' ? { birthtime: undefined } : {}),
        }),
      );
      await fixture.store.purgeAllBytes();
      expect(JSON.parse(await readFile(fixture.markerPath, 'utf8'))).toEqual({
        version: 1,
        state: 'absent',
      });
      await expect(stat(fixture.rootDir)).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect(
        (await readdir(fixture.parentDir)).filter((name) =>
          name.includes('.purge-'),
        ),
      ).toEqual([]);
      if (mode === 'changed')
        expect(await readFile(join(originalPath, 'sentinel'), 'utf8')).toBe(
          'original',
        );
    },
  );

  it('rejects stale legacy sync, recovers integrity, and rebuilds on the next sync', async () => {
    const fixture = await identityFixture({ dev: '0', birthtime: undefined });
    const revision = await buildFixture();
    const manager = new SharedContainerReplicaManager({
      rootDir: fixture.rootDir,
      transport: transportFor(revision),
      fetchImpl: fetchFor(revision),
    });
    await expect(manager.sync('container-1', 'org-1')).rejects.toThrow(
      'root identity changed',
    );
    expect(JSON.parse(await readFile(fixture.markerPath, 'utf8'))).toEqual(
      fixture.marker,
    );
    await manager.ensureReplicaStoreIntegrity();
    await expect(stat(fixture.rootDir)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await manager.sync('container-1', 'org-1');
    const info = await lstat(fixture.rootDir, { bigint: true });
    expect(JSON.parse(await readFile(fixture.markerPath, 'utf8'))).toEqual({
      version: 1,
      state: 'active',
      dev: String(info.dev),
      ino: String(info.ino),
      ...(info.birthtimeNs > 0n ? { birthtime: String(info.birthtimeNs) } : {}),
    });
  });

  it.each(['purging', 'purged'] as const)(
    'resumes %s journals across saved identity drift',
    async (phase) => {
      for (const drift of ['remounted', 'unconfirmed', 'changed', 'legacy']) {
        const fixture = await identityFixture();
        const quarantine = '.replica.purge-interrupted';
        const quarantinePath = join(fixture.parentDir, quarantine);
        await rename(fixture.rootDir, quarantinePath);
        await writeFile(join(quarantinePath, 'discard'), 'cache');
        await writeFile(
          fixture.markerPath,
          JSON.stringify({
            ...fixture.marker,
            state: phase,
            quarantine,
            ...(drift === 'remounted' || drift === 'unconfirmed'
              ? { dev: String(fixture.info.dev + 1n) }
              : {}),
            ...(drift === 'changed'
              ? { ino: String(fixture.info.ino + 1n) }
              : {}),
            ...(drift === 'unconfirmed' || drift === 'legacy'
              ? { birthtime: undefined }
              : {}),
          }),
        );
        const originalWrite = fixture.seams.writeRootMarker.bind(fixture.seams);
        const writes: Record<string, unknown>[] = [];
        jest
          .spyOn(fixture.seams, 'writeRootMarker')
          .mockImplementation(async (marker) => {
            writes.push(marker);
            await originalWrite(marker);
          });
        await fixture.store.purgeAllBytes();
        const refreshed = writes.find((marker) => marker.state === phase);
        // A zero-birthtime filesystem need not refresh an otherwise matching legacy marker.
        if (drift !== 'legacy' || fixture.info.birthtimeNs > 0n) {
          expect(refreshed).toMatchObject({
            state: phase,
            quarantine,
            dev: String(fixture.info.dev),
            ino: String(fixture.info.ino),
          });
          expect(refreshed?.birthtime).toBe(
            fixture.info.birthtimeNs > 0n
              ? String(fixture.info.birthtimeNs)
              : undefined,
          );
        }
        expect(await readdir(fixture.parentDir)).toEqual([
          '.replica.identity.json',
        ]);
      }
    },
  );

  it('rebinds a purging journal whose rename has not happened', async () => {
    const fixture = await identityFixture({
      state: 'purging',
      quarantine: '.replica.purge-before-rename',
      dev: '0',
      birthtime: undefined,
    });
    await writeFile(join(fixture.rootDir, 'discard'), 'cache');
    await fixture.store.purgeAllBytes();
    expect(await readdir(fixture.parentDir)).toEqual([
      '.replica.identity.json',
    ]);
  });

  it.each(['purging', 'purged'] as const)(
    'keeps an unrelated root when both paths exist in %s',
    async (state) => {
      const quarantine = '.replica.purge-both';
      const fixture = await identityFixture({ state, quarantine, ino: '0' });
      await rename(fixture.rootDir, join(fixture.parentDir, quarantine));
      await mkdir(fixture.rootDir);
      const sentinel = join(fixture.rootDir, 'replacement');
      await writeFile(sentinel, 'survives');
      await expect(fixture.store.purgeAllBytes()).rejects.toThrow(
        'root identity changed',
      );
      expect(await readFile(sentinel, 'utf8')).toBe('survives');
    },
  );

  it.each(['purging', 'purged'] as const)(
    'preserves missing-path semantics in %s',
    async (state) => {
      const fixture = await identityFixture({
        state,
        quarantine: '.replica.purge-missing',
      });
      await rm(fixture.rootDir, { recursive: true });
      if (state === 'purging')
        await expect(fixture.store.purgeAllBytes()).rejects.toThrow(
          'root identity changed',
        );
      else {
        await fixture.store.purgeAllBytes();
        expect(
          JSON.parse(await readFile(fixture.markerPath, 'utf8')),
        ).toMatchObject({ state: 'absent' });
      }
    },
  );

  it('does not delete a new root when a purged quarantine is already missing', async () => {
    const fixture = await identityFixture({
      state: 'purged',
      quarantine: '.replica.purge-gone',
      ino: '0',
    });
    const sentinel = join(fixture.rootDir, 'replacement');
    await writeFile(sentinel, 'survives');
    await expect(fixture.store.purgeAllBytes()).rejects.toThrow(
      'root identity changed',
    );
    expect(await readFile(sentinel, 'utf8')).toBe('survives');
  });

  it('persists journal rebind before cleanup and retries an interrupted rebind', async () => {
    const quarantine = '.replica.purge-rebind';
    const fixture = await identityFixture({
      state: 'purging',
      quarantine,
      ino: '0',
    });
    const quarantinePath = join(fixture.parentDir, quarantine);
    await rename(fixture.rootDir, quarantinePath);
    const sentinel = join(quarantinePath, 'cache');
    await writeFile(sentinel, 'retained until commit');
    const cleanup = jest.spyOn(fixture.seams, 'emptyBoundQuarantine');
    const write = jest
      .spyOn(fixture.seams, 'writeRootMarker')
      .mockRejectedValueOnce(new Error('journal failed'));
    await expect(fixture.store.purgeAllBytes()).rejects.toThrow(
      'journal failed',
    );
    expect(cleanup).not.toHaveBeenCalled();
    expect(await readFile(sentinel, 'utf8')).toBe('retained until commit');
    cleanup.mockRejectedValueOnce(new Error('interrupted after rebind'));
    await expect(fixture.store.purgeAllBytes()).rejects.toThrow(
      'interrupted after rebind',
    );
    expect(
      JSON.parse(await readFile(fixture.markerPath, 'utf8')),
    ).toMatchObject({ state: 'purging', ino: String(fixture.info.ino) });
    write.mockRestore();
    cleanup.mockRestore();
    await new SharedContainerReplicaStore(fixture.rootDir).purgeAllBytes();
    expect(await readdir(fixture.parentDir)).toEqual([
      '.replica.identity.json',
    ]);
  });

  it.each([
    ['purging', 'before-worker'],
    ['purging', 'before-removal'],
    ['purged', 'before-worker'],
    ['purged', 'before-removal'],
  ])(
    'aborts a second swap in %s %s after journal rebind',
    async (state, stage) => {
      const quarantine = '.replica.purge-swap';
      const fixture = await identityFixture({
        state,
        quarantine,
        ino: '0',
      });
      const quarantinePath = join(fixture.parentDir, quarantine);
      const outside = join(fixture.parentDir, 'outside');
      await rename(fixture.rootDir, quarantinePath);
      const swap = async (): Promise<void> => {
        await rename(quarantinePath, outside);
        await mkdir(quarantinePath);
        await writeFile(join(quarantinePath, 'replacement'), 'survives');
      };
      if (stage === 'before-worker') {
        const original = fixture.seams.writeRootMarker.bind(fixture.seams);
        jest
          .spyOn(fixture.seams, 'writeRootMarker')
          .mockImplementationOnce(async (marker) => {
            await original(marker);
            await swap();
          });
      } else {
        const original = fixture.seams.emptyBoundQuarantine.bind(fixture.seams);
        jest
          .spyOn(fixture.seams, 'emptyBoundQuarantine')
          .mockImplementationOnce(async (...args) => {
            await original(...args);
            await swap();
          });
      }
      await expect(fixture.store.purgeAllBytes()).rejects.toThrow(
        'root identity changed',
      );
      expect(await readFile(join(quarantinePath, 'replacement'), 'utf8')).toBe(
        'survives',
      );
    },
  );

  it.each(['device', 'birthtime'])(
    'rejects live worker %s drift and rolls back safely',
    async (field) => {
      const fixture = await identityFixture({ birthtime: '9007199254740993' });
      injectRootStats(fixture, { birthtimeNs: 9007199254740993n });
      await writeFile(join(fixture.rootDir, 'sentinel'), 'survives');
      mockedSpawn.mockImplementationOnce((command, args, options) => {
        let script = String(args?.[2])
          .replace('identity.birthtimeNs > 0n', 'true')
          .replace(
            'String(identity.birthtimeNs)',
            field === 'device' ? "'9007199254740993'" : "'9007199254740992'",
          );
        if (field === 'device') {
          script = script.replace(
            'String(identity.dev)',
            'String(identity.dev + 1n)',
          );
        }
        return actualSpawn(
          command,
          ['--input-type=commonjs', '--eval', script],
          options as SpawnOptionsWithoutStdio,
        );
      });
      await expect(fixture.store.purgeAllBytes()).rejects.toMatchObject({
        code: 'ERR_SHARED_CONTAINER_QUARANTINE_BINDING_MISMATCH',
      });
      expect(await readFile(join(fixture.rootDir, 'sentinel'), 'utf8')).toBe(
        'survives',
      );
    },
  );

  it.each([undefined, '0', 'bad', 123])(
    'accepts legacy or invalid optional worker birthtime %p',
    async (birthtime) => {
      const fixture = await identityFixture();
      mockedSpawn.mockImplementationOnce((command, args, options) => {
        const script = String(args?.[2])
          .replace('identity.birthtimeNs > 0n', 'true')
          .replace(
            'String(identity.birthtimeNs)',
            birthtime === undefined ? 'undefined' : JSON.stringify(birthtime),
          );
        return actualSpawn(
          command,
          ['--input-type=commonjs', '--eval', script],
          options as SpawnOptionsWithoutStdio,
        );
      });
      await fixture.store.purgeAllBytes();
      expect(await readdir(fixture.parentDir)).toEqual([
        '.replica.identity.json',
      ]);
    },
  );

  it.each(['fresh', 'purging', 'purged'])(
    'retains known birthtime in a %s journal when stats cannot report it',
    async (phase) => {
      const quarantine = '.replica.purge-no-birthtime';
      const fixture = await identityFixture({
        birthtime: '9007199254740993',
        ...(phase === 'fresh' ? {} : { state: phase, quarantine, dev: '0' }),
      });
      if (phase !== 'fresh')
        await rename(fixture.rootDir, join(fixture.parentDir, quarantine));
      const original = fixture.seams.lstatIfPresent.bind(fixture.seams);
      jest
        .spyOn(fixture.seams, 'lstatIfPresent')
        .mockImplementation(async (path) => {
          const info = await original(path);
          return info ? Object.assign(info, { birthtimeNs: 0n }) : info;
        });
      const write = jest.spyOn(fixture.seams, 'writeRootMarker');
      const cleanup = jest
        .spyOn(fixture.seams, 'emptyBoundQuarantine')
        .mockRejectedValueOnce(new Error('inspect journal'));
      await expect(fixture.store.purgeAllBytes()).rejects.toThrow(
        'inspect journal',
      );
      expect(write.mock.calls[0]?.[0].birthtime).toBe('9007199254740993');
      expect(cleanup.mock.calls[0]?.[1].birthtime).toBe('9007199254740993');
    },
  );

  it.each(['purging', 'purged'])(
    'normalizes optional birthtime on %s journal reload',
    async (state) => {
      for (const birthtime of [undefined, '0', 'bad', 123]) {
        const quarantine = '.replica.purge-legacy';
        const fixture = await identityFixture({ state, quarantine, birthtime });
        await rename(fixture.rootDir, join(fixture.parentDir, quarantine));
        await fixture.store.purgeAllBytes();
        expect(JSON.parse(await readFile(fixture.markerPath, 'utf8'))).toEqual({
          version: 1,
          state: 'absent',
        });
      }
    },
  );

  it('aborts if an adopted purged quarantine disappears before worker binding', async () => {
    const quarantine = '.replica.purge-disappeared';
    const fixture = await identityFixture({
      state: 'purged',
      quarantine,
      ino: '0',
    });
    const quarantinePath = join(fixture.parentDir, quarantine);
    const outside = join(fixture.parentDir, 'outside');
    await rename(fixture.rootDir, quarantinePath);
    await writeFile(
      join(quarantinePath, 'sentinel'),
      'must not be reported purged',
    );
    const original = fixture.seams.writeRootMarker.bind(fixture.seams);
    jest
      .spyOn(fixture.seams, 'writeRootMarker')
      .mockImplementationOnce(async (marker) => {
        await original(marker);
        await rename(quarantinePath, outside);
      });
    await expect(fixture.store.purgeAllBytes()).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(
      JSON.parse(await readFile(fixture.markerPath, 'utf8')),
    ).toMatchObject({ state: 'purged' });
    expect(await readFile(join(outside, 'sentinel'), 'utf8')).toBe(
      'must not be reported purged',
    );
  });

  it.each(['root', 'quarantine'])(
    'rejects %s links without following them',
    async (target) => {
      const quarantine = '.replica.purge-linked';
      const fixture = await identityFixture(
        target === 'quarantine'
          ? { state: 'purging', quarantine, ino: '0' }
          : { dev: '0' },
      );
      const outside = join(fixture.parentDir, 'outside');
      await rename(fixture.rootDir, outside);
      const sentinel = join(outside, 'sentinel');
      await writeFile(sentinel, 'survives');
      const link =
        target === 'root'
          ? fixture.rootDir
          : join(fixture.parentDir, quarantine);
      await symlink(
        outside,
        link,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      await expect(fixture.store.purgeAllBytes()).rejects.toThrow(
        /symbolic link|junction/,
      );
      expect(await readFile(sentinel, 'utf8')).toBe('survives');
      await expect(lstat(link)).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it.each(['root', 'quarantine'])(
    'rejects %s files without destructive recovery',
    async (target) => {
      const quarantine = '.replica.purge-file';
      const fixture = await identityFixture(
        target === 'quarantine'
          ? { state: 'purging', quarantine, ino: '0' }
          : { dev: '0' },
      );
      const path =
        target === 'root'
          ? fixture.rootDir
          : join(fixture.parentDir, quarantine);
      if (target === 'root') await rm(path, { recursive: true });
      await writeFile(path, 'survives');
      await expect(fixture.store.purgeAllBytes()).rejects.toThrow(
        /not a directory/,
      );
      expect(await readFile(path, 'utf8')).toBe('survives');
    },
  );

  it('keeps active-root-missing behavior if the root disappears before mismatch recovery', async () => {
    const fixture = await identityFixture({ dev: '0', birthtime: undefined });
    const original = fixture.seams.lstatIfPresent.bind(fixture.seams);
    jest
      .spyOn(fixture.seams, 'lstatIfPresent')
      .mockImplementationOnce(async (path) => {
        const info = await original(path);
        await rm(fixture.rootDir, { recursive: true });
        return info;
      });
    await expect(fixture.store.purgeAllBytes()).rejects.toThrow(
      'root is unexpectedly missing',
    );
    expect(JSON.parse(await readFile(fixture.markerPath, 'utf8'))).toEqual(
      fixture.marker,
    );
  });

  it('does not recover unrelated validation errors', async () => {
    const fixture = await identityFixture({ dev: '0' });
    const error = Object.assign(new Error('permission denied'), {
      code: 'EACCES',
    });
    jest.spyOn(fixture.seams, 'lstatIfPresent').mockRejectedValueOnce(error);
    await expect(fixture.store.purgeAllBytes()).rejects.toBe(error);
    expect(await lstat(fixture.rootDir)).toBeDefined();
    expect(JSON.parse(await readFile(fixture.markerPath, 'utf8'))).toEqual(
      fixture.marker,
    );
  });
});

describe('shared-container replica manager', () => {
  it('forwards missing-access repository identity and retains it across restart and retry', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'shared-replica-'));
    const fixture = await buildFixture({
      containerType: 'CODE_WORKTREE',
      repoIds: ['repo-1', 'repo-2'],
    });
    let repository = 'acme/repo-1';
    let accessible = false;
    const options = {
      rootDir,
      transport: transportFor(fixture),
      fetchImpl: fetchFor(fixture),
      materializeCodeRevision: (): Promise<MaterializeCodeResult> =>
        Promise.resolve(
          accessible
            ? { ok: true }
            : {
                ok: false,
                block: {
                  reason: 'repository-access-missing',
                  repository,
                  message: `${repository}: repository access is missing`,
                },
              },
        ),
    };
    const manager = new SharedContainerReplicaManager(options);
    const blocked = await manager.sync('container-1', 'org-1');
    expect(blocked).toMatchObject({
      status: 'blocked',
      reason: 'repository-access-missing',
      repository: 'acme/repo-1',
      message: 'acme/repo-1: repository access is missing',
    });
    expect(await manager.getState('container-1')).toEqual(blocked);

    const restarted = new SharedContainerReplicaManager(options);
    expect(await restarted.getState('container-1')).toEqual(blocked);

    repository = 'acme/repo-2';
    const retried = await restarted.sync('container-1', 'org-1', {
      force: true,
    });
    expect(retried).toMatchObject({
      status: 'blocked',
      repository: 'acme/repo-2',
    });
    expect(await restarted.getState('container-1')).toEqual(retried);

    accessible = true;
    const available = await restarted.sync('container-1', 'org-1', {
      force: true,
    });
    expect(available).toMatchObject({ status: 'available' });
    expect(available).not.toHaveProperty('repository');
    expect(await restarted.getState('container-1')).not.toHaveProperty(
      'repository',
    );
  });

  it.each([
    'unsupported-remote-host',
    'github-not-connected',
    'commit-unavailable',
    'lfs-unsupported',
    'symlink-unsupported',
    'git-credentials-missing',
  ] as const)(
    'omits repository context for %s from the materializer',
    async (reason) => {
      const rootDir = await mkdtemp(join(tmpdir(), 'shared-replica-'));
      const fixture = await buildFixture({ containerType: 'CODE_WORKTREE' });
      const manager = new SharedContainerReplicaManager({
        rootDir,
        transport: transportFor(fixture),
        fetchImpl: fetchFor(fixture),
        materializeCodeRevision: (): Promise<MaterializeCodeResult> =>
          Promise.resolve({
            ok: false,
            block: {
              reason,
              repository: 'snapshot-label',
              message: 'diagnostic',
            },
          }),
      });

      const blocked = await manager.sync('container-1', 'org-1');
      expect(blocked).toMatchObject({ status: 'blocked', reason });
      expect(blocked).not.toHaveProperty('repository');
      expect(await manager.getState('container-1')).not.toHaveProperty(
        'repository',
      );
    },
  );

  it.each([
    [
      'canonical',
      { repository: 'acme/tower-defense' },
      { repository: 'acme/tower-defense' },
    ],
    ['legacy', {}, {}],
    ['null', { repository: null }, {}],
    ['empty', { repository: '' }, {}],
    ['blank', { repository: ' \t\n' }, {}],
    ['number', { repository: 7 }, {}],
    ['object', { repository: {} }, {}],
  ])(
    'normalizes persisted blocked state with %s repository context',
    async (_label, context, expected) => {
      const rootDir = await mkdtemp(join(tmpdir(), 'shared-replica-'));
      const state = {
        containerId: 'container-1',
        organizationId: 'org-1',
        containerType: 'CODE_WORKTREE',
        status: 'blocked',
        reason: 'repository-access-missing',
        message: 'legacy diagnostic',
        updatedAt: '2026-10-05T00:00:00.000Z',
      };
      await writeFile(
        join(rootDir, 'index.json'),
        JSON.stringify({
          version: 1,
          containers: {
            'container-1': { ...state, ...context, undeclared: 'discard me' },
          },
          artifacts: {},
          promotionCommits: {},
        }),
      );
      const fixture = await buildFixture();
      const manager = new SharedContainerReplicaManager({
        rootDir,
        transport: transportFor(fixture),
        fetchImpl: fetchFor(fixture),
      });
      expect(await manager.getState('container-1')).toEqual({
        ...state,
        ...expected,
      });
    },
  );

  it('blocks an unknown future layout version with an update-required reason', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'shared-replica-'));
    const fixture = await buildFixture();
    fixture.detail.latestRevision.schemaVersion = 6;
    fixture.revision.revision.schemaVersion = 6;
    const fetchImpl = jest.fn(fetchFor(fixture));
    const manager = new SharedContainerReplicaManager({
      rootDir,
      transport: transportFor(fixture),
      fetchImpl,
    });

    const state = await manager.sync('container-1', 'org-1');
    expect(state).toMatchObject({
      status: 'blocked',
      reason: 'update-required',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(state).not.toHaveProperty('repository');
  });

  it('carries authenticated withheld-file disclosure into recipient state', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'shared-replica-'));
    const fixture = await buildFixture({
      layout: {
        schemaVersion: 1,
        containerType: 'COWORK_WORK_ENTRY',
        title: 'Work Entry',
        repositories: [],
        files: [],
        notes: [],
        prompts: [],
        attachmentPaths: {},
        withheldFileCount: 2,
        withheldFileReasons: ['credential-shaped', 'oversized'],
      },
      plaintextArtifacts: [],
    });
    const manager = new SharedContainerReplicaManager({
      rootDir,
      transport: transportFor(fixture),
      fetchImpl: fetchFor(fixture),
    });

    await expect(manager.sync('container-1', 'org-1')).resolves.toMatchObject({
      status: 'available',
      withheldFileCount: 2,
      withheldFileReasons: ['credential-shaped', 'oversized'],
    });
  });

  it('captures replica root filesystem identity without numeric precision loss', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'shared-replica-'));
    const fixture = await buildFixture();
    const manager = new SharedContainerReplicaManager({
      rootDir,
      transport: transportFor(fixture),
      fetchImpl: fetchFor(fixture),
    });
    const store = manager.store as unknown as {
      lstatIfPresent(
        path: string,
      ): Promise<{ dev: unknown; ino: unknown } | null>;
    };
    const originalLstat = store.lstatIfPresent.bind(store);
    let observedIdentity: { dev: unknown; ino: unknown } | null = null;
    jest.spyOn(store, 'lstatIfPresent').mockImplementation(async (path) => {
      const info = await originalLstat(path);
      if (path === rootDir && info) observedIdentity = info;
      return info;
    });

    await manager.sync('container-1', 'org-1');

    expect(typeof observedIdentity?.dev).toBe('bigint');
    expect(typeof observedIdentity?.ino).toBe('bigint');
  });

  it('distinguishes adjacent replica inode identities above the safe integer limit', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'shared-replica-'));
    const fixture = await buildFixture();
    const initialManager = new SharedContainerReplicaManager({
      rootDir,
      transport: transportFor(fixture),
      fetchImpl: fetchFor(fixture),
    });
    await initialManager.sync('container-1', 'org-1');
    const markerPath = join(
      dirname(rootDir),
      `.${basename(rootDir)}.identity.json`,
    );
    await writeFile(
      markerPath,
      `${JSON.stringify({
        version: 1,
        state: 'active',
        dev: '1',
        ino: '9007199254740992',
      })}\n`,
    );
    const restartedManager = new SharedContainerReplicaManager({
      rootDir,
      transport: transportFor(fixture),
      fetchImpl: fetchFor(fixture),
    });
    const store = restartedManager.store as unknown as {
      lstatIfPresent(path: string): Promise<Record<string, unknown> | null>;
    };
    const originalLstat = store.lstatIfPresent.bind(store);
    jest.spyOn(store, 'lstatIfPresent').mockImplementation(async (path) => {
      const info = await originalLstat(path);
      if (path !== rootDir || !info) return info;
      return Object.assign(info, {
        dev: BigInt(1),
        ino: BigInt('9007199254740993'),
      }) as Record<string, unknown>;
    });

    await expect(
      restartedManager.store.set({
        status: 'nothing-published',
        containerId: 'container-1',
        containerType: 'COWORK_WORK_ENTRY',
        updatedAt: '2026-10-14T00:00:00Z',
      }),
    ).rejects.toThrow(/replica root identity changed/i);
  });

  it('resumes root cleanup after interruption immediately after quarantine rename', async () => {
    const parentDir = await mkdtemp(join(tmpdir(), 'shared-replica-parent-'));
    const rootDir = join(parentDir, 'replica');
    const fixture = await buildFixture();
    const manager = new SharedContainerReplicaManager({
      rootDir,
      transport: transportFor(fixture),
      fetchImpl: fetchFor(fixture),
    });
    await manager.sync('container-1', 'org-1');
    const store = manager.store as unknown as {
      lstatIfPresent(path: string): Promise<unknown>;
    };
    const originalLstat = store.lstatIfPresent.bind(store);
    let interrupted = false;
    jest.spyOn(store, 'lstatIfPresent').mockImplementation(async (path) => {
      if (!interrupted && path.startsWith(join(parentDir, '.replica.purge-'))) {
        interrupted = true;
        throw new Error('interrupted after quarantine rename');
      }
      return originalLstat(path);
    });

    await expect(manager.purgeAll()).rejects.toThrow(
      'interrupted after quarantine rename',
    );
    expect(await readdir(parentDir)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^\.replica\.purge-/),
        '.replica.identity.json',
      ]),
    );

    const restarted = new SharedContainerReplicaManager({
      rootDir,
      transport: transportFor(fixture),
      fetchImpl: fetchFor(fixture),
    });
    await restarted.purgeAll();

    expect(await readdir(parentDir)).toEqual(['.replica.identity.json']);
    await expect(stat(rootDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('finishes root cleanup after interruption before the absent marker commit', async () => {
    const parentDir = await mkdtemp(join(tmpdir(), 'shared-replica-parent-'));
    const rootDir = join(parentDir, 'replica');
    const fixture = await buildFixture();
    const manager = new SharedContainerReplicaManager({
      rootDir,
      transport: transportFor(fixture),
      fetchImpl: fetchFor(fixture),
    });
    await manager.sync('container-1', 'org-1');
    const store = manager.store as unknown as {
      writeRootMarker(marker: { state: string }): Promise<void>;
    };
    const originalWriteMarker = store.writeRootMarker.bind(store);
    let interrupted = false;
    jest.spyOn(store, 'writeRootMarker').mockImplementation((marker) => {
      if (!interrupted && marker.state === 'absent') {
        interrupted = true;
        throw new Error('interrupted before absent marker commit');
      }
      return originalWriteMarker(marker);
    });

    await expect(manager.purgeAll()).rejects.toThrow(
      'interrupted before absent marker commit',
    );
    await expect(stat(rootDir)).rejects.toMatchObject({ code: 'ENOENT' });

    const restarted = new SharedContainerReplicaManager({
      rootDir,
      transport: transportFor(fixture),
      fetchImpl: fetchFor(fixture),
    });
    await restarted.purgeAll();

    expect(await readdir(parentDir)).toEqual(['.replica.identity.json']);
  });

  it('keeps the replica root absent when purging an unopened container after purge-all', async () => {
    const parentDir = await mkdtemp(join(tmpdir(), 'shared-replica-parent-'));
    const rootDir = join(parentDir, 'replica');
    const fixture = await buildFixture();
    const manager = new SharedContainerReplicaManager({
      rootDir,
      transport: transportFor(fixture),
      fetchImpl: fetchFor(fixture),
    });
    await manager.sync('container-1', 'org-1');
    await manager.purgeAll();

    await expect(manager.purge('unopened-container')).resolves.toBe(true);
    await expect(stat(rootDir)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(manager.sync('container-1', 'org-1')).resolves.toMatchObject({
      status: 'available',
    });
  });

  it('clears recipient view state when a container is purged', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'shared-replica-'));
    const fixture = await buildFixture();
    const cleanupViewState = jest.fn().mockResolvedValue(undefined);
    const manager = new SharedContainerReplicaManager({
      rootDir,
      transport: transportFor(fixture),
      fetchImpl: fetchFor(fixture),
      cleanupViewState,
    });
    await manager.sync('container-1', 'org-1');

    await manager.purge('container-1');

    expect(cleanupViewState).toHaveBeenCalledWith('container-1');
  });

  it('lets an authorization-lock holder finish while a container snapshot waits on another', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'shared-replica-'));
    const fixture = await buildFixture();
    // A purge holds the authorization lock across this hook, as an open's
    // sync does across its file I/O. The timer makes the release need a
    // macrotask, which a microtask spin would never let run.
    const cleanupViewState = jest.fn(
      () => new Promise<void>((resolve) => setTimeout(resolve, 20)),
    );
    const manager = new SharedContainerReplicaManager({
      rootDir,
      transport: transportFor(fixture),
      fetchImpl: fetchFor(fixture),
      cleanupViewState,
    });
    const firstGeneration =
      await manager.beginContainerSnapshotListing('org-1');
    const secondGeneration =
      await manager.beginContainerSnapshotListing('org-2');

    // Intercepts the private fence field on purpose; a rename must follow
    // here. The first fence installed starts the lock holder, so the
    // snapshot's cleanup has to queue behind it. Bounding fence reads turns a spin on a
    // settled fence into a failure instead of a hung worker.
    let fence: Promise<void> | null = null;
    let fenceReads = 0;
    let lockHolder: Promise<boolean> | undefined;
    Object.defineProperty(manager, 'containerSnapshotFencePromise', {
      configurable: true,
      get: () => {
        fenceReads += 1;
        if (fenceReads > 10_000) {
          throw new Error('Container snapshot fence never yielded');
        }
        return fence;
      },
      set: (value: Promise<void> | null) => {
        fence = value;
        lockHolder ??= manager.purge('unrelated-container');
      },
    });

    await expect(
      Promise.all([
        manager.reconcileContainerSnapshot('org-1', [], firstGeneration),
        manager.reconcileContainerSnapshot('org-2', [], secondGeneration),
      ]),
    ).resolves.toEqual([undefined, undefined]);
    await expect(lockHolder).resolves.toBe(true);
    expect(cleanupViewState).toHaveBeenCalledWith('unrelated-container');
  });

  it('still purges replica bytes when recipient view-state cleanup fails', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'shared-replica-'));
    const fixture = await buildFixture();
    const manager = new SharedContainerReplicaManager({
      rootDir,
      transport: transportFor(fixture),
      fetchImpl: fetchFor(fixture),
      cleanupViewState: (): Promise<void> =>
        Promise.reject(new Error('view cleanup failed')),
    });
    await manager.sync('container-1', 'org-1');

    await expect(manager.purge('container-1')).rejects.toThrow(
      'view cleanup failed',
    );
    await expect(stat(join(rootDir, 'container-1'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(manager.getState('container-1')).resolves.toBeNull();
  });

  it('stops runtime view state before deleting replica bytes', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'shared-replica-'));
    const fixture = await buildFixture();
    const cleanupViewState = jest.fn(async () => {
      await expect(
        stat(join(rootDir, 'container-1', 'revisions', 'revision-1')),
      ).resolves.toBeDefined();
    });
    const manager = new SharedContainerReplicaManager({
      rootDir,
      transport: transportFor(fixture),
      fetchImpl: fetchFor(fixture),
      cleanupViewState,
    });
    await manager.sync('container-1', 'org-1');

    await manager.purge('container-1');

    expect(cleanupViewState).toHaveBeenCalledWith('container-1');
    await expect(stat(join(rootDir, 'container-1'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('discovers run-copy view state during purge-all even with a corrupt index', async () => {
    const priorDataDir = process.env.CANOPY_DATA_DIR;
    const dataDir = await mkdtemp(join(tmpdir(), 'shared-run-purge-all-'));
    process.env.CANOPY_DATA_DIR = dataDir;
    try {
      const rootDir = await mkdtemp(join(tmpdir(), 'shared-replica-'));
      const fixture = await buildFixture();
      const runDir = join(
        getWorktreeDataDir(
          SHARED_CONTAINER_VIEWER_PROJECT_ID,
          'orphan-container',
        ),
        'run',
      );
      await mkdir(runDir, { recursive: true });
      await writeFile(join(runDir, 'recipient-file'), 'bytes');
      const cleanupViewState = jest.fn(async (containerId: string) => {
        await rm(
          getWorktreeDataDir(SHARED_CONTAINER_VIEWER_PROJECT_ID, containerId),
          { recursive: true, force: true },
        );
      });
      const manager = new SharedContainerReplicaManager({
        rootDir,
        transport: transportFor(fixture),
        fetchImpl: fetchFor(fixture),
        cleanupViewState,
      });
      await manager.store.prepareContainerForSync('indexed-container');
      await writeFile(join(rootDir, 'index.json'), '{not json', 'utf8');

      await manager.purgeAll();

      expect(cleanupViewState).toHaveBeenCalledWith('orphan-container');
      await expect(stat(runDir)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      if (priorDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
      else process.env.CANOPY_DATA_DIR = priorDataDir;
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('still purges replica bytes when one purge-all view cleanup fails', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'shared-replica-'));
    const fixture = await buildFixture();
    const manager = new SharedContainerReplicaManager({
      rootDir,
      transport: transportFor(fixture),
      fetchImpl: fetchFor(fixture),
      cleanupViewState: (): Promise<void> =>
        Promise.reject(new Error('run-copy cleanup failed')),
    });
    await manager.sync('container-1', 'org-1');

    await expect(manager.purgeAll()).rejects.toThrow('run-copy cleanup failed');
    await expect(stat(rootDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('contains cleanup stdin EOF and retains the purge journal for recovery', async () => {
    const parentDir = await mkdtemp(join(tmpdir(), 'shared-replica-pipe-'));
    const rootDir = join(parentDir, 'replica');
    const store = new SharedContainerReplicaStore(rootDir);
    await store.prepareContainerForSync('container-1');
    await mkdir(join(rootDir, 'container-1'), { recursive: true });
    await writeFile(join(rootDir, 'container-1', 'plaintext'), 'secret');
    let injected = false;
    mockedSpawn.mockImplementationOnce((_command, _args, options) => {
      const spawnOptions: SpawnOptionsWithoutStdio = {
        ...options,
        stdio: 'pipe',
      };
      const child = actualSpawn(
        process.execPath,
        ['--input-type=commonjs', '--eval', STALLED_REPLICA_CLEANUP_SCRIPT],
        spawnOptions,
      );
      child.stdin.once('finish', () => {
        injected = true;
        child.stdin.destroy(
          Object.assign(new Error('write EOF'), {
            code: 'EOF',
            syscall: 'write',
          }),
        );
      });
      return child;
    });
    try {
      await expect(store.purgeAllBytes()).rejects.toThrow('write EOF');
      expect(injected).toBe(true);
      await expect(
        readFile(join(parentDir, '.replica.identity.json'), 'utf8'),
      ).resolves.toMatch('"state": "purging"');
      await store.purgeAllBytes();
      await expect(
        readFile(join(parentDir, '.replica.identity.json'), 'utf8'),
      ).resolves.toMatch('"state": "absent"');
    } finally {
      await rm(parentDir, { recursive: true, force: true });
    }
  });

  it('times out a stalled root cleanup worker without discarding its purge journal', async () => {
    const parentDir = await mkdtemp(join(tmpdir(), 'shared-replica-parent-'));
    const rootDir = join(parentDir, 'replica');
    const store = new SharedContainerReplicaStore(rootDir);
    await store.prepareContainerForSync('container-1');
    await mkdir(join(rootDir, 'container-1'), { recursive: true });
    await writeFile(join(rootDir, 'container-1', 'plaintext'), 'secret');
    (
      store as unknown as {
        cleanupWorkerTimeoutMs: number;
      }
    ).cleanupWorkerTimeoutMs = 100;

    let stopStalledChild: (() => void) | null = null;
    mockedSpawn.mockImplementationOnce((_command, _args, options) => {
      const child = actualSpawn(
        process.execPath,
        ['--input-type=commonjs', '--eval', STALLED_REPLICA_CLEANUP_SCRIPT],
        options as SpawnOptionsWithoutStdio,
      );
      stopStalledChild = (): void => {
        child.kill();
      };
      return child;
    });

    const purge = store.purgeAllBytes();
    const outcome = await Promise.race([
      purge.then(
        () => ({ status: 'fulfilled' as const, message: '' }),
        (error: unknown) => ({
          status: 'rejected' as const,
          message: String(error),
        }),
      ),
      new Promise<{ status: 'pending'; message: string }>((resolve) => {
        setTimeout(() => resolve({ status: 'pending', message: '' }), 1_000);
      }),
    ]);
    if (outcome.status === 'pending') stopStalledChild?.();
    await purge.catch(() => undefined);

    expect(outcome.status).toBe('rejected');
    expect(outcome.message).toMatch(/cleanup process timed out/i);
    await expect(
      readFile(join(parentDir, '.replica.identity.json'), 'utf8'),
    ).resolves.toMatch('"state": "purging"');
    await expect(stat(rootDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reserves aggregate root capacity before starting a sync', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'shared-replica-'));
    const fixture = await buildFixture();
    const transport = transportFor(fixture);
    const originalResolveLatest = transport.resolveLatest.bind(transport);
    const resolveLatest = jest.fn(
      (
        input: Parameters<SharedContainerReplicaTransport['resolveLatest']>[0],
      ) => originalResolveLatest(input),
    );
    transport.resolveLatest = resolveLatest;
    const manager = new SharedContainerReplicaManager({
      rootDir,
      transport,
      fetchImpl: fetchFor(fixture),
      maxReplicaRootBytes: BigInt(0),
      syncReservationBytes: BigInt(1),
    });

    await expect(manager.sync('container-1', 'org-1')).rejects.toThrow(
      'replica storage quota exceeded',
    );
    expect(resolveLatest).not.toHaveBeenCalled();
  });

  it('measures the replica root around a sibling replica purged mid-walk', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'shared-replica-'));
    const fixture = await buildFixture();
    const manager = new SharedContainerReplicaManager({
      rootDir,
      transport: transportFor(fixture),
      fetchImpl: fetchFor(fixture),
    });
    const siblingDir = join(rootDir, 'container-2');
    await mkdir(join(siblingDir, 'revisions', 'revision-1', 'content'), {
      recursive: true,
    });
    // A listing snapshot purges another share between the reservation walk's
    // readdir of the root and its lstat of that share's directory.
    const lstat = fsPromises.lstat;
    let purgedMidWalk = false;
    const lstatSpy = jest
      .spyOn(fsPromises, 'lstat')
      .mockImplementation(async (path, options) => {
        if (path === siblingDir && options === undefined && !purgedMidWalk) {
          purgedMidWalk = true;
          await rm(siblingDir, { recursive: true, force: true });
        }
        return lstat(path, options);
      });
    try {
      await expect(manager.sync('container-1', 'org-1')).resolves.toMatchObject(
        { status: 'available' },
      );
    } finally {
      lstatSpy.mockRestore();
    }
    expect(purgedMidWalk).toBe(true);
  });

  it('rejects a completed staging tree that exceeds its storage reservation', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'shared-replica-'));
    const fixture = await buildFixture();
    const reservation = BigInt(1);
    const manager = new SharedContainerReplicaManager({
      rootDir,
      transport: transportFor(fixture),
      fetchImpl: fetchFor(fixture),
      maxReplicaRootBytes: reservation,
      syncReservationBytes: reservation,
    });

    await expect(manager.sync('container-1', 'org-1')).rejects.toThrow(
      'replica storage quota exceeded',
    );
    await expect(
      stat(
        join(rootDir, 'container-1', 'revisions', fixture.revision.revision.id),
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('charges allocation units for empty staged files and directories', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'shared-replica-'));
    const fixture = await buildFixture({
      plaintextArtifacts: Array.from({ length: 100 }, (_, index) => ({
        artifactId: `empty-${index}`,
        path: `chats/empty-${index}.json`,
        bytes: Buffer.alloc(0),
      })),
    });
    const reservation = BigInt(128 * 1024);
    const manager = new SharedContainerReplicaManager({
      rootDir,
      transport: transportFor(fixture),
      fetchImpl: fetchFor(fixture),
      maxReplicaRootBytes: reservation,
      syncReservationBytes: reservation,
    });

    await expect(manager.sync('container-1', 'org-1')).rejects.toThrow(
      'replica storage quota exceeded',
    );
  });

  it('counts an in-flight reservation against concurrent container syncs', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'shared-replica-'));
    const fixture = await buildFixture();
    const transport = transportFor(fixture);
    const originalResolveLatest = transport.resolveLatest.bind(transport);
    let releaseFirst!: () => void;
    const firstPaused = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    transport.resolveLatest = jest.fn(async (input) => {
      await firstPaused;
      return originalResolveLatest(input);
    });
    const reservation = BigInt(10 * 1024 * 1024);
    const manager = new SharedContainerReplicaManager({
      rootDir,
      transport,
      fetchImpl: fetchFor(fixture),
      maxReplicaRootBytes: reservation,
      syncReservationBytes: reservation,
    });
    const first = manager.sync('container-1', 'org-1');
    await new Promise((resolve) => setImmediate(resolve));

    await expect(manager.sync('container-2', 'org-1')).rejects.toThrow(
      'replica storage quota exceeded',
    );
    releaseFirst();
    await expect(first).resolves.toMatchObject({ containerId: 'container-1' });
  });

  it('rejects unsafe revision ids before touching paths outside the replica root', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'shared-replica-'));
    const outsideDir = join(dirname(rootDir), `${basename(rootDir)}-escape`);
    const sentinelPath = join(outsideDir, 'sentinel.txt');
    await mkdir(outsideDir, { recursive: true });
    await writeFile(sentinelPath, 'must survive');
    const fixture = await buildFixture({
      revisionId: `../../../${basename(outsideDir)}`,
    });
    const manager = new SharedContainerReplicaManager({
      rootDir,
      transport: transportFor(fixture),
      fetchImpl: fetchFor(fixture),
    });

    await expect(manager.sync('container-1', 'org-1')).rejects.toThrow(
      'Shared-container revision has an invalid id',
    );
    await expect(readFile(sentinelPath, 'utf8')).resolves.toBe('must survive');
  });

  it.each([
    '',
    '/absolute-revision',
    'nested/revision',
    'nested\\revision',
    '.',
    '..',
  ])(
    'rejects non-leaf revision id %j before fetching it',
    async (revisionId) => {
      const rootDir = await mkdtemp(join(tmpdir(), 'shared-replica-'));
      const fixture = await buildFixture({ revisionId });
      const transport = transportFor(fixture);
      const fetchRevision = jest.spyOn(transport, 'fetchRevision');
      const manager = new SharedContainerReplicaManager({
        rootDir,
        transport,
        fetchImpl: fetchFor(fixture),
      });

      await expect(manager.sync('container-1', 'org-1')).rejects.toThrow(
        'Shared-container revision has an invalid id',
      );
      expect(fetchRevision).not.toHaveBeenCalled();
    },
  );

  it.each(['container', 'staging'] as const)(
    'rejects and unlinks an existing %s directory link without touching its target',
    async (linkedDirectory) => {
      const rootDir = await mkdtemp(join(tmpdir(), 'shared-replica-'));
      const outsideDir = await mkdtemp(join(tmpdir(), 'shared-outside-'));
      const fixture = await buildFixture();
      const revisionId = fixture.detail.latestRevision?.id;
      if (!revisionId) throw new Error('Expected a published fixture revision');
      const linkPath =
        linkedDirectory === 'container'
          ? join(rootDir, 'container-1')
          : join(rootDir, 'container-1', 'staging');
      const outsideRevisionDir =
        linkedDirectory === 'container'
          ? join(outsideDir, 'staging', revisionId)
          : join(outsideDir, revisionId);
      const sentinelPath = join(outsideRevisionDir, 'sentinel.txt');
      await mkdir(outsideRevisionDir, { recursive: true });
      await writeFile(sentinelPath, 'must survive');
      await mkdir(dirname(linkPath), { recursive: true });
      await symlink(
        outsideDir,
        linkPath,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      const manager = new SharedContainerReplicaManager({
        rootDir,
        transport: transportFor(fixture),
        fetchImpl: fetchFor(fixture),
      });

      await expect(manager.sync('container-1', 'org-1')).rejects.toThrow(
        /symbolic link|junction/i,
      );
      await expect(readFile(sentinelPath, 'utf8')).resolves.toBe(
        'must survive',
      );
      await expect(stat(linkPath)).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it.each(['close', 'denial'] as const)(
    'unlinks a symbolic replica root and fails %s cleanup without touching its target',
    async (cleanupPath) => {
      const parentDir = await mkdtemp(join(tmpdir(), 'shared-replica-parent-'));
      const rootDir = join(parentDir, 'replica');
      const outsideDir = join(parentDir, 'outside');
      const fixture = await buildFixture();
      const manager = new SharedContainerReplicaManager({
        rootDir,
        transport: transportFor(fixture),
        fetchImpl: fetchFor(fixture),
      });
      await manager.sync('container-1', 'org-1');
      await rename(rootDir, outsideDir);
      const sentinelPath = join(outsideDir, 'container-1', 'sentinel.txt');
      await writeFile(sentinelPath, 'must survive');
      await symlink(
        outsideDir,
        rootDir,
        process.platform === 'win32' ? 'junction' : 'dir',
      );

      const cleanup =
        cleanupPath === 'close'
          ? manager.close('container-1')
          : manager.purge('container-1', {
              expectedOrganizationId: 'org-1',
            });

      await expect(cleanup).rejects.toThrow(/symbolic link|junction/i);
      await expect(readFile(sentinelPath, 'utf8')).resolves.toBe(
        'must survive',
      );
      await expect(stat(rootDir)).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it('does not write through a pre-existing replica-index temporary-file link', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'shared-replica-'));
    const outsideDir = await mkdtemp(join(tmpdir(), 'shared-outside-'));
    const sentinelPath = join(outsideDir, 'sentinel.txt');
    await writeFile(sentinelPath, 'must survive');
    const fixture = await buildFixture();
    const manager = new SharedContainerReplicaManager({
      rootDir,
      transport: transportFor(fixture),
      fetchImpl: fetchFor(fixture),
    });
    await manager.sync('container-1', 'org-1');
    await symlink(sentinelPath, join(rootDir, 'index.json.tmp'), 'file');

    await expect(
      manager.sync('container-1', 'org-1', { force: true }),
    ).resolves.toMatchObject({ containerId: 'container-1' });

    await expect(readFile(sentinelPath, 'utf8')).resolves.toBe('must survive');
  });

  it('normalizes corrupt index entries instead of returning undeclared fields', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'shared-replica-'));
    await mkdir(rootDir, { recursive: true });
    await writeFile(
      join(rootDir, 'index.json'),
      JSON.stringify({
        version: 1,
        containers: {
          'container-1': {
            status: 'available',
            containerId: 'container-1',
            organizationId: 'org-1',
            containerType: 'COWORK_WORK_ENTRY',
            revisionId: 'revision-1',
            revision: 1,
            revisionCreatedAt: '2026-08-28T00:00:00.000Z',
            updatedAt: '2026-08-28T00:00:00.000Z',
            dataKey: 'must-not-survive-normalization',
          },
        },
        artifacts: {
          'container-1': {
            'chat-artifact': {
              artifactId: 'chat-artifact',
              revisionId: 'revision-1',
              path: 'chats/chat-1.json',
              representation: 'BLOB',
              hash: `sha256:${'a'.repeat(64)}`,
              objectSizeBytes: '1',
              dataKey: 'must-not-survive-normalization',
            },
          },
        },
      }),
    );
    const fixture = await buildFixture();
    const manager = new SharedContainerReplicaManager({
      rootDir,
      transport: transportFor(fixture),
      fetchImpl: fetchFor(fixture),
    });

    const state = await manager.getState('container-1');
    expect(state).toEqual({
      status: 'available',
      containerId: 'container-1',
      organizationId: 'org-1',
      containerType: 'COWORK_WORK_ENTRY',
      revisionId: 'revision-1',
      revision: 1,
      revisionCreatedAt: '2026-08-28T00:00:00.000Z',
      withheldFileCount: 0,
      withheldFileReasons: [],
      updatedAt: '2026-08-28T00:00:00.000Z',
    });
    expect(JSON.stringify(state)).not.toContain('dataKey');
    expect(JSON.stringify(await manager.store.readIndex())).not.toContain(
      'dataKey',
    );
  });

  it('authenticates, decrypts, verifies, and atomically promotes a revision', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'shared-replica-'));
    const fixture = await buildFixture();
    const manager = new SharedContainerReplicaManager({
      rootDir,
      transport: transportFor(fixture),
      fetchImpl: fetchFor(fixture),
    });

    const state = await manager.sync('container-1', 'org-1');

    expect(state.status).toBe('available');
    expect(
      await readFile(
        join(
          rootDir,
          'container-1',
          'revisions',
          'revision-1',
          'artifacts',
          'chats',
          'chat-1.json',
        ),
        'utf8',
      ),
    ).toContain('chat-1');
    await expect(
      stat(join(rootDir, 'container-1', 'staging', 'revision-1')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    const indexText = await readFile(join(rootDir, 'index.json'), 'utf8');
    expect(indexText).not.toContain('dataKey');
    expect(indexText).not.toContain('https://fixture');
    expect(
      (await stat(join(rootDir, 'container-1', 'revisions', 'revision-1')))
        .mode & 0o222,
    ).toBe(0);
  });

  it('fails closed when the REST artifact list diverges from the authenticated manifest', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'shared-replica-'));
    const fixture = await buildFixture();
    fixture.revision.revision.artifacts =
      fixture.revision.revision.artifacts?.slice(0, 1);
    const manager = new SharedContainerReplicaManager({
      rootDir,
      transport: transportFor(fixture),
      fetchImpl: fetchFor(fixture),
    });

    await expect(manager.sync('container-1', 'org-1')).rejects.toThrow(
      'artifact list does not match',
    );
    await expect(
      stat(join(rootDir, 'container-1', 'revisions', 'revision-1')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps the previous revision intact after tampered ciphertext and purges bytes from disk', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'shared-replica-'));
    const fixture = await buildFixture();
    const manager = new SharedContainerReplicaManager({
      rootDir,
      transport: transportFor(fixture),
      fetchImpl: fetchFor(fixture),
    });
    await manager.sync('container-1', 'org-1');
    const manifestCiphertext = fixture.responses.get(
      'https://fixture/revision-1/manifest',
    );
    if (!manifestCiphertext) throw new Error('Fixture manifest is missing');
    const tampered = Buffer.from(manifestCiphertext);
    tampered[tampered.length - 1] ^= 1;
    fixture.responses.set('https://fixture/revision-1/manifest', tampered);

    await expect(
      manager.sync('container-1', 'org-1', { force: true }),
    ).rejects.toThrow('ciphertext hash');
    expect(await manager.getState('container-1')).toMatchObject({
      status: 'available',
      revisionId: 'revision-1',
    });

    await manager.purge('container-1');
    await expect(stat(join(rootDir, 'container-1'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await manager.getState('container-1')).toBeNull();
  });

  it.each(['sealing', 'index commit'] as const)(
    'restores a verified same-revision tree when %s fails',
    async (failureStage) => {
      const rootDir = await mkdtemp(join(tmpdir(), 'shared-replica-'));
      let fixture = await buildFixture({ chatContents: 'previous verified' });
      let failSealing = false;
      const transport: SharedContainerReplicaTransport = {
        resolveLatest: () => Promise.resolve(fixture.detail),
        fetchRevision: () => Promise.resolve(fixture.revision),
        requestDownloadUrls: (_containerId, _revisionId, _orgId, artifactIds) =>
          Promise.resolve({
            downloads: fixture.downloads.downloads.filter((download) =>
              artifactIds.includes(download.artifactId),
            ),
          }),
      };
      const manager = new SharedContainerReplicaManager({
        rootDir,
        transport,
        fetchImpl: ((input) => {
          const url =
            typeof input === 'string'
              ? input
              : input instanceof URL
                ? input.href
                : input.url;
          return Promise.resolve(new Response(fixture.responses.get(url)));
        }) as typeof fetch,
        sealReplicaTree: async (revisionDir): Promise<void> => {
          if (failSealing) throw new Error('sealing unavailable');
          await makeReplicaTreeReadOnly(revisionDir);
        },
      });
      const chatPath = join(
        rootDir,
        'container-1',
        'revisions',
        'revision-1',
        'artifacts',
        'chats',
        'chat-1.json',
      );
      await manager.sync('container-1', 'org-1');
      await expect(readFile(chatPath, 'utf8')).resolves.toBe(
        'previous verified',
      );
      fixture = await buildFixture({ chatContents: 'replacement' });
      if (failureStage === 'sealing') {
        failSealing = true;
      } else {
        jest
          .spyOn(manager.store, 'commitRevision')
          .mockRejectedValueOnce(new Error('index commit unavailable'));
      }

      await expect(
        manager.sync('container-1', 'org-1', { force: true }),
      ).rejects.toThrow(`${failureStage} unavailable`);

      await expect(readFile(chatPath, 'utf8')).resolves.toBe(
        'previous verified',
      );
      await expect(
        stat(join(rootDir, 'container-1', 'revisions', 'revision-1.previous')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it('rolls back an interrupted same-revision promotion before trusting the index after restart', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'shared-replica-'));
    const fixture = await buildFixture({ chatContents: 'previous verified' });
    const transport = transportFor(fixture);
    const manager = new SharedContainerReplicaManager({
      rootDir,
      transport,
      fetchImpl: fetchFor(fixture),
    });
    await manager.sync('container-1', 'org-1');
    const revisionDir = join(rootDir, 'container-1', 'revisions', 'revision-1');
    const chatPath = join(revisionDir, 'artifacts', 'chats', 'chat-1.json');
    await rename(revisionDir, `${revisionDir}.previous`);
    await mkdir(dirname(chatPath), { recursive: true });
    await writeFile(chatPath, 'interrupted replacement');

    const restarted = new SharedContainerReplicaManager({
      rootDir,
      transport,
      fetchImpl: fetchFor(fixture),
    });
    await restarted.sync('container-1', 'org-1');

    await expect(readFile(chatPath, 'utf8')).resolves.toBe('previous verified');
    await expect(stat(`${revisionDir}.previous`)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('keeps a committed replacement when restart finds its cleanup journal', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'shared-replica-'));
    const fixture = await buildFixture({ chatContents: 'previous verified' });
    const transport = transportFor(fixture);
    const manager = new SharedContainerReplicaManager({
      rootDir,
      transport,
      fetchImpl: fetchFor(fixture),
    });
    await manager.sync('container-1', 'org-1');
    const revisionDir = join(rootDir, 'container-1', 'revisions', 'revision-1');
    const chatPath = join(revisionDir, 'artifacts', 'chats', 'chat-1.json');
    await rename(revisionDir, `${revisionDir}.previous`);
    await mkdir(dirname(chatPath), { recursive: true });
    await writeFile(chatPath, 'committed replacement');
    await makeReplicaTreeReadOnly(revisionDir);
    await writeFile(
      `${revisionDir}.promotion`,
      `${JSON.stringify({
        version: 1,
        hadPrevious: true,
        phase: 'committed',
      })}\n`,
    );

    const restarted = new SharedContainerReplicaManager({
      rootDir,
      transport,
      fetchImpl: fetchFor(fixture),
    });
    await restarted.sync('container-1', 'org-1');

    await expect(readFile(chatPath, 'utf8')).resolves.toBe(
      'committed replacement',
    );
    await expect(stat(`${revisionDir}.previous`)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(stat(`${revisionDir}.promotion`)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('recovers the committed replacement when index commit returns an error and the journal phase write fails', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'shared-replica-'));
    let fixture = await buildFixture({ chatContents: 'previous verified' });
    const transport: SharedContainerReplicaTransport = {
      resolveLatest: () => Promise.resolve(fixture.detail),
      fetchRevision: () => Promise.resolve(fixture.revision),
      requestDownloadUrls: (_containerId, _revisionId, _orgId, artifactIds) =>
        Promise.resolve({
          downloads: fixture.downloads.downloads.filter((download) =>
            artifactIds.includes(download.artifactId),
          ),
        }),
    };
    const manager = new SharedContainerReplicaManager({
      rootDir,
      transport,
      fetchImpl: ((input) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        return Promise.resolve(new Response(fixture.responses.get(url)));
      }) as typeof fetch,
    });
    await manager.sync('container-1', 'org-1');
    fixture = await buildFixture({ chatContents: 'committed replacement' });

    const originalCommit = manager.store.commitRevision.bind(manager.store);
    jest
      .spyOn(manager.store, 'commitRevision')
      .mockImplementationOnce(async (...args): Promise<void> => {
        await originalCommit(...args);
        throw new Error('interrupted after index commit');
      });
    const markerWriter = manager as unknown as {
      writePromotionMarker(
        path: string,
        marker: { phase: 'prepared' | 'committed' },
      ): Promise<void>;
    };
    const originalWriteMarker =
      markerWriter.writePromotionMarker.bind(markerWriter);
    jest
      .spyOn(markerWriter, 'writePromotionMarker')
      .mockImplementation(async (path, marker): Promise<void> => {
        if (marker.phase === 'committed') {
          throw new Error('committed phase unavailable');
        }
        await originalWriteMarker(path, marker);
      });
    jest
      .spyOn(manager.store, 'pruneRevisions')
      .mockRejectedValue(new Error('cleanup unavailable'));

    await expect(
      manager.sync('container-1', 'org-1', { force: true }),
    ).resolves.toMatchObject({ status: 'available' });

    const revisionDir = join(rootDir, 'container-1', 'revisions', 'revision-1');
    const chatPath = join(revisionDir, 'artifacts', 'chats', 'chat-1.json');
    await expect(readFile(chatPath, 'utf8')).resolves.toBe(
      'committed replacement',
    );
    await expect(
      readFile(`${revisionDir}.promotion`, 'utf8'),
    ).resolves.toContain('"phase":"prepared"');

    const restarted = new SharedContainerReplicaManager({
      rootDir,
      transport,
      fetchImpl: fetchFor(fixture),
    });
    await restarted.sync('container-1', 'org-1');

    await expect(readFile(chatPath, 'utf8')).resolves.toBe(
      'committed replacement',
    );
    await expect(stat(`${revisionDir}.previous`)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(stat(`${revisionDir}.promotion`)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('rematerializes after an interrupted purge removes bytes but leaves the index', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'shared-replica-'));
    const fixture = await buildFixture();
    const transport = transportFor(fixture);
    const manager = new SharedContainerReplicaManager({
      rootDir,
      transport,
      fetchImpl: fetchFor(fixture),
    });
    await manager.sync('container-1', 'org-1');
    const originalPurgeBytes = manager.store.purgeBytes.bind(manager.store);
    jest
      .spyOn(manager.store, 'purgeBytes')
      .mockImplementationOnce(async (...args): Promise<void> => {
        await originalPurgeBytes(...args);
        throw new Error('interrupted after byte removal');
      });

    await expect(manager.purge('container-1')).rejects.toThrow(
      'interrupted after byte removal',
    );
    await expect(stat(join(rootDir, 'container-1'))).rejects.toMatchObject({
      code: 'ENOENT',
    });

    const restartedTransport = transportFor(fixture);
    const fetchRevision = jest.spyOn(restartedTransport, 'fetchRevision');
    const restarted = new SharedContainerReplicaManager({
      rootDir,
      transport: restartedTransport,
      fetchImpl: fetchFor(fixture),
    });
    await restarted.sync('container-1', 'org-1');

    expect(fetchRevision).toHaveBeenCalledTimes(1);
    await expect(
      stat(
        join(
          rootDir,
          'container-1',
          'revisions',
          'revision-1',
          'artifacts',
          'container.json',
        ),
      ),
    ).resolves.toBeDefined();
  });

  it('reuses verified logical artifacts only for a direct parent and falls back on a fork', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'shared-replica-'));
    let fixture = await buildFixture();
    const requestDownloadUrls = jest.fn<
      ReturnType<SharedContainerReplicaTransport['requestDownloadUrls']>,
      Parameters<SharedContainerReplicaTransport['requestDownloadUrls']>
    >((_containerId, _revisionId, _orgId, artifactIds: string[]) =>
      Promise.resolve({
        downloads: fixture.downloads.downloads.filter((download) =>
          artifactIds.includes(download.artifactId),
        ),
      }),
    );
    const transport: SharedContainerReplicaTransport = {
      resolveLatest: () => Promise.resolve(fixture.detail),
      fetchRevision: () => Promise.resolve(fixture.revision),
      requestDownloadUrls,
    };
    const responses = new Map(fixture.responses);
    const manager = new SharedContainerReplicaManager({
      rootDir,
      transport,
      fetchImpl: ((input) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        return Promise.resolve(new Response(responses.get(url)));
      }) as typeof fetch,
    });
    await manager.sync('container-1', 'org-1');

    fixture = await buildFixture({
      revisionId: 'revision-2',
      revision: 2,
      parentRevisionId: 'revision-1',
    });
    fixture.responses.forEach((value, key) => responses.set(key, value));
    requestDownloadUrls.mockClear();
    await manager.sync('container-1', 'org-1');
    expect(
      requestDownloadUrls.mock.calls.map((call) => call.slice(0, 4)),
    ).toEqual([['container-1', 'revision-2', 'org-1', ['revision-2']]]);
    expect(
      JSON.parse(await readFile(join(rootDir, 'index.json'), 'utf8')),
    ).toMatchObject({
      artifacts: {
        'container-1': {
          'chat-artifact': { revisionId: 'revision-2' },
          'layout-artifact': { revisionId: 'revision-2' },
        },
      },
    });

    fixture = await buildFixture({
      revisionId: 'revision-3',
      revision: 3,
      parentRevisionId: 'revision-1',
    });
    fixture.responses.forEach((value, key) => responses.set(key, value));
    requestDownloadUrls.mockClear();
    await manager.sync('container-1', 'org-1');
    expect(
      requestDownloadUrls.mock.calls.map((call) => call.slice(0, 4)),
    ).toEqual([
      ['container-1', 'revision-3', 'org-1', ['revision-3']],
      [
        'container-1',
        'revision-3',
        'org-1',
        ['chat-artifact', 'layout-artifact'],
      ],
    ]);
  });

  it('never replaces a cached higher revision with an older checkpoint', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'shared-replica-'));
    let fixture = await buildFixture({ revisionId: 'revision-2', revision: 2 });
    const fetchRevision = jest.fn(() => Promise.resolve(fixture.revision));
    const transport: SharedContainerReplicaTransport = {
      resolveLatest: () => Promise.resolve(fixture.detail),
      fetchRevision,
      requestDownloadUrls: (_containerId, _revisionId, _orgId, artifactIds) =>
        Promise.resolve({
          downloads: fixture.downloads.downloads.filter((download) =>
            artifactIds.includes(download.artifactId),
          ),
        }),
    };
    const responses = new Map(fixture.responses);
    const manager = new SharedContainerReplicaManager({
      rootDir,
      transport,
      fetchImpl: ((input) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        return Promise.resolve(new Response(responses.get(url)));
      }) as typeof fetch,
    });
    await manager.sync('container-1', 'org-1');

    fixture = await buildFixture({ revisionId: 'revision-1', revision: 1 });
    fetchRevision.mockClear();
    await expect(manager.sync('container-1', 'org-1')).resolves.toMatchObject({
      revisionId: 'revision-2',
      revision: 2,
    });
    expect(fetchRevision).not.toHaveBeenCalled();
  });

  it.each(['truncated-ciphertext', 'wrong-plaintext-hash', 'reordered-rest'])(
    'fails closed for the reusable %s fixture variant',
    async (variant) => {
      const rootDir = await mkdtemp(join(tmpdir(), 'shared-replica-'));
      const fixture = await buildFixture(
        variant === 'wrong-plaintext-hash'
          ? { chatHash: `sha256:${'0'.repeat(64)}` }
          : {},
      );
      if (variant === 'truncated-ciphertext') {
        const url = 'https://fixture/revision-1/chat';
        const ciphertext = fixture.responses.get(url);
        if (!ciphertext) throw new Error('Fixture chat ciphertext is missing');
        fixture.responses.set(
          url,
          ciphertext.subarray(0, ciphertext.length - 1),
        );
      } else if (variant === 'reordered-rest') {
        fixture.revision.revision.artifacts = [
          ...(fixture.revision.revision.artifacts ?? []),
        ].reverse();
      }
      const manager = new SharedContainerReplicaManager({
        rootDir,
        transport: transportFor(fixture),
        fetchImpl: fetchFor(fixture),
      });

      await expect(manager.sync('container-1', 'org-1')).rejects.toThrow();
      await expect(
        stat(join(rootDir, 'container-1', 'revisions', 'revision-1')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it('aborts and settles an in-flight fetch before purging replica bytes', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'shared-replica-'));
    const fixture = await buildFixture();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let aborted = false;
    const manager = new SharedContainerReplicaManager({
      rootDir,
      transport: transportFor(fixture),
      fetchImpl: ((_input, init) => {
        markStarted();
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => {
              aborted = true;
              reject(new DOMException('Aborted', 'AbortError'));
            },
            { once: true },
          );
        });
      }) as typeof fetch,
    });

    const syncing = manager.sync('container-1', 'org-1');
    const syncOutcome = syncing.catch((error: unknown) => error);
    await started;
    await manager.purge('container-1');

    await expect(syncOutcome).resolves.toMatchObject({ name: 'AbortError' });
    expect(aborted).toBe(true);
    await expect(stat(join(rootDir, 'container-1'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('aborts and settles an in-flight sync before closing an unpinned replica', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'shared-replica-'));
    const fixture = await buildFixture();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let aborted = false;
    const transport: SharedContainerReplicaTransport = {
      resolveLatest: (_containerId, _organizationId, signal) => {
        markStarted();
        return new Promise((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () => {
              aborted = true;
              reject(new DOMException('Aborted', 'AbortError'));
            },
            { once: true },
          );
        });
      },
      fetchRevision: () => Promise.resolve(fixture.revision),
      requestDownloadUrls: () => Promise.resolve(fixture.downloads),
    };
    const manager = new SharedContainerReplicaManager({
      rootDir,
      transport,
      fetchImpl: fetchFor(fixture),
    });

    const syncing = manager.sync('container-1', 'org-1');
    const syncOutcome = syncing.catch((error: unknown) => error);
    await started;
    await manager.close('container-1');

    await expect(syncOutcome).resolves.toMatchObject({ name: 'AbortError' });
    expect(aborted).toBe(true);
    await expect(stat(join(rootDir, 'container-1'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('removes a blocked replica and its retained prior revision when closing', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'shared-replica-'));
    const fixture = await buildFixture();
    const manager = new SharedContainerReplicaManager({
      rootDir,
      transport: transportFor(fixture),
      fetchImpl: fetchFor(fixture),
    });
    const available = await manager.sync('container-1', 'org-1');
    if (available.status !== 'available') {
      throw new Error('Expected the fixture replica to be available');
    }
    const revisionDir = join(
      rootDir,
      'container-1',
      'revisions',
      available.revisionId,
    );
    await expect(stat(revisionDir)).resolves.toBeDefined();
    await manager.store.set({
      status: 'blocked',
      containerId: 'container-1',
      organizationId: 'org-1',
      containerType: available.containerType,
      reason: 'lfs-unsupported',
      message: 'Git LFS repositories are not supported',
      updatedAt: new Date().toISOString(),
    });

    await manager.close('container-1');

    await expect(manager.getState('container-1')).resolves.toBeNull();
    await expect(stat(join(rootDir, 'container-1'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('retains a pinned replica when closing', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'shared-replica-'));
    const fixture = await buildFixture();
    const manager = new SharedContainerReplicaManager({
      rootDir,
      transport: transportFor(fixture),
      fetchImpl: fetchFor(fixture),
    });
    await manager.sync('container-1', 'org-1');
    await manager.pin('container-1');

    await expect(manager.close('container-1')).resolves.toBe(false);

    await expect(manager.getState('container-1')).resolves.toMatchObject({
      status: 'pinned',
    });
    await expect(stat(join(rootDir, 'container-1'))).resolves.toBeDefined();
  });

  it('waits for a different-organization sync before conditionally purging denied state', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'shared-replica-'));
    const fixture = await buildFixture();
    const transport = transportFor(fixture);
    const originalResolveLatest = transport.resolveLatest.bind(transport);
    let markOrg2Started!: () => void;
    const org2Started = new Promise<void>((resolve) => {
      markOrg2Started = resolve;
    });
    let releaseOrg2!: () => void;
    const org2Gate = new Promise<void>((resolve) => {
      releaseOrg2 = resolve;
    });
    transport.resolveLatest = jest.fn(
      async (containerId, organizationId, signal) => {
        if (organizationId === 'org-2') {
          markOrg2Started();
          await org2Gate;
          throw new Error('org-2 sync failed before authentication');
        }
        return originalResolveLatest(containerId, organizationId, signal);
      },
    );
    const manager = new SharedContainerReplicaManager({
      rootDir,
      transport,
      fetchImpl: fetchFor(fixture),
    });
    await manager.sync('container-1', 'org-1');
    await manager.pin('container-1');

    const org2Sync = manager.sync('container-1', 'org-2');
    await org2Started;
    const purge = manager.purge('container-1', {
      expectedOrganizationId: 'org-1',
    });
    releaseOrg2();

    await expect(org2Sync).rejects.toThrow(
      'org-2 sync failed before authentication',
    );
    await expect(purge).resolves.toBe(true);
    await expect(manager.getState('container-1')).resolves.toBeNull();
    await expect(stat(join(rootDir, 'container-1'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('cleans recipient runtime state on an authenticated organization change', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'shared-replica-'));
    const fixture = await buildFixture();
    const transport = transportFor(fixture);
    const originalResolveLatest = transport.resolveLatest.bind(transport);
    const originalFetchRevision = transport.fetchRevision.bind(transport);
    transport.resolveLatest = async (
      containerId,
      organizationId,
      signal,
    ): Promise<SharedContainerDetail> => ({
      ...(await originalResolveLatest(containerId, 'org-1', signal)),
      organizationId,
    });
    transport.fetchRevision = (
      containerId,
      revisionId,
      _organizationId,
      signal,
    ): Promise<SharedContainerFetchRevisionResponse> =>
      originalFetchRevision(containerId, revisionId, 'org-1', signal);
    const cleanupViewState = jest.fn().mockResolvedValue(undefined);
    const manager = new SharedContainerReplicaManager({
      rootDir,
      transport,
      fetchImpl: fetchFor(fixture),
      cleanupViewState,
    });
    await manager.sync('container-1', 'org-1');

    await expect(manager.sync('container-1', 'org-2')).resolves.toMatchObject({
      organizationId: 'org-2',
    });

    expect(cleanupViewState).toHaveBeenCalledWith('container-1');
  });

  it('keeps the prior replica indexed when organization-change view cleanup fails', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'shared-replica-'));
    const fixture = await buildFixture();
    const transport = transportFor(fixture);
    const originalResolveLatest = transport.resolveLatest.bind(transport);
    transport.resolveLatest = async (
      containerId,
      organizationId,
      signal,
    ): Promise<SharedContainerDetail> => ({
      ...(await originalResolveLatest(containerId, 'org-1', signal)),
      organizationId,
    });
    const cleanupViewState = jest
      .fn()
      .mockRejectedValue(new Error('view cleanup failed'));
    const manager = new SharedContainerReplicaManager({
      rootDir,
      transport,
      fetchImpl: fetchFor(fixture),
      cleanupViewState,
    });
    await manager.sync('container-1', 'org-1');

    await expect(manager.sync('container-1', 'org-2')).rejects.toThrow(
      'view cleanup failed',
    );

    await expect(manager.getState('container-1')).resolves.toMatchObject({
      organizationId: 'org-1',
    });
    await expect(stat(join(rootDir, 'container-1'))).resolves.toBeDefined();
  });

  it('does not restore stale state when pin races an authenticated organization transition', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'shared-replica-'));
    const fixture = await buildFixture();
    const transport = transportFor(fixture);
    const originalResolveLatest = transport.resolveLatest.bind(transport);
    const originalFetchRevision = transport.fetchRevision.bind(transport);
    let markOrg2FetchStarted!: () => void;
    const org2FetchStarted = new Promise<void>((resolve) => {
      markOrg2FetchStarted = resolve;
    });
    let releaseOrg2Fetch!: () => void;
    const org2FetchGate = new Promise<void>((resolve) => {
      releaseOrg2Fetch = resolve;
    });
    transport.resolveLatest = jest.fn(
      async (containerId, organizationId, signal) => {
        const detail = await originalResolveLatest(
          containerId,
          'org-1',
          signal,
        );
        return { ...detail, organizationId };
      },
    );
    transport.fetchRevision = jest.fn(
      async (containerId, revisionId, organizationId, signal) => {
        if (organizationId === 'org-2') {
          markOrg2FetchStarted();
          await org2FetchGate;
        }
        return originalFetchRevision(containerId, revisionId, 'org-1', signal);
      },
    );
    const manager = new SharedContainerReplicaManager({
      rootDir,
      transport,
      fetchImpl: fetchFor(fixture),
    });
    await manager.sync('container-1', 'org-1');

    const originalGet = manager.store.get.bind(manager.store);
    let markPinPaused!: () => void;
    const pinPaused = new Promise<void>((resolve) => {
      markPinPaused = resolve;
    });
    let releasePin!: () => void;
    const pinGate = new Promise<void>((resolve) => {
      releasePin = resolve;
    });
    jest.spyOn(manager.store, 'get').mockImplementationOnce(async (id) => {
      const state = await originalGet(id);
      markPinPaused();
      await pinGate;
      return state;
    });
    const pinning = manager.pin('container-1', 'org-1');
    await pinPaused;

    const org2Sync = manager.sync('container-1', 'org-2');
    let org2AuthenticatedBeforePinRelease = false;
    void org2FetchStarted.then(() => {
      org2AuthenticatedBeforePinRelease = true;
    });
    for (
      let attempt = 0;
      attempt < 8 && !org2AuthenticatedBeforePinRelease;
      attempt += 1
    ) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    const transitionWonRace = org2AuthenticatedBeforePinRelease;
    releasePin();
    const pinResult = await pinning;
    releaseOrg2Fetch();
    await expect(org2Sync).resolves.toMatchObject({
      organizationId: 'org-2',
    });

    if (transitionWonRace) {
      expect(pinResult).toBeNull();
    } else {
      expect(pinResult).toMatchObject({
        status: 'pinned',
        organizationId: 'org-1',
      });
    }
    await expect(manager.getState('container-1')).resolves.toMatchObject({
      status: 'available',
      organizationId: 'org-2',
    });
  });

  it('fences an in-flight pin before deciding whether close should retain the replica', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'shared-replica-'));
    const fixture = await buildFixture();
    const manager = new SharedContainerReplicaManager({
      rootDir,
      transport: transportFor(fixture),
      fetchImpl: fetchFor(fixture),
    });
    await manager.sync('container-1', 'org-1');
    const originalGet = manager.store.get.bind(manager.store);
    let markPinPaused!: () => void;
    const pinPaused = new Promise<void>((resolve) => {
      markPinPaused = resolve;
    });
    let releasePin!: () => void;
    const pinGate = new Promise<void>((resolve) => {
      releasePin = resolve;
    });
    jest.spyOn(manager.store, 'get').mockImplementationOnce(async (id) => {
      const state = await originalGet(id);
      markPinPaused();
      await pinGate;
      return state;
    });
    const pinning = manager.pin('container-1');
    await pinPaused;

    const closing = manager.close('container-1');
    releasePin();

    await expect(pinning).rejects.toMatchObject({ name: 'AbortError' });
    await expect(closing).resolves.toBe(true);
    await expect(manager.getState('container-1')).resolves.toBeNull();
    await expect(stat(join(rootDir, 'container-1'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it.each([
    ['retained', ['org-1']],
    ['removed', []],
  ] as const)(
    'waits for a %s organization snapshot before closing an ordinary replica',
    async (_outcome, authorizedOrganizationIds) => {
      const rootDir = await mkdtemp(join(tmpdir(), 'shared-replica-'));
      const fixture = await buildFixture();
      const manager = new SharedContainerReplicaManager({
        rootDir,
        transport: transportFor(fixture),
        fetchImpl: fetchFor(fixture),
      });
      await manager.sync('container-1', 'org-1');
      let markSnapshotEntered!: () => void;
      const snapshotEntered = new Promise<void>((resolve) => {
        markSnapshotEntered = resolve;
      });
      let releaseSnapshot!: () => void;
      const snapshotGate = new Promise<void>((resolve) => {
        releaseSnapshot = resolve;
      });
      const snapshot = manager.withOrganizationSnapshotFence(
        authorizedOrganizationIds,
        async () => {
          markSnapshotEntered();
          await snapshotGate;
          if (authorizedOrganizationIds.length === 0) {
            await manager.purge('container-1', {
              allowDuringAuthorizationTransition: true,
            });
          }
        },
      );
      await snapshotEntered;

      const closing = manager.close('container-1');
      releaseSnapshot();

      await snapshot;
      await expect(closing).resolves.toBe(true);
      await expect(manager.getState('container-1')).resolves.toBeNull();
      await expect(stat(join(rootDir, 'container-1'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    },
  );

  it('threads cancellation into resolve-latest so purge cannot wait on response headers or body', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'shared-replica-'));
    const fixture = await buildFixture();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let receivedSignal: AbortSignal | undefined;
    const transport: SharedContainerReplicaTransport = {
      resolveLatest: (_containerId, _organizationId, signal) => {
        receivedSignal = signal;
        markStarted();
        if (!signal) {
          return Promise.reject(
            new Error('resolveLatest did not receive a signal'),
          );
        }
        return new Promise((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
        });
      },
      fetchRevision: () => Promise.resolve(fixture.revision),
      requestDownloadUrls: () => Promise.resolve(fixture.downloads),
    };
    const manager = new SharedContainerReplicaManager({
      rootDir,
      transport,
      fetchImpl: fetchFor(fixture),
    });

    const syncing = manager.sync('container-1', 'org-1');
    const syncOutcome = syncing.catch((error: unknown) => error);
    await started;
    await manager.purge('container-1');

    await expect(syncOutcome).resolves.toMatchObject({ name: 'AbortError' });
    expect(receivedSignal?.aborted).toBe(true);
  });

  it('fences a new sync until container-scoped purge finishes', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'shared-replica-'));
    const fixture = await buildFixture();
    const manager = new SharedContainerReplicaManager({
      rootDir,
      transport: transportFor(fixture),
      fetchImpl: fetchFor(fixture),
    });
    await manager.sync('container-1', 'org-1');
    const originalDelete = manager.store.delete.bind(manager.store);
    let markDeletePaused!: () => void;
    const deletePaused = new Promise<void>((resolve) => {
      markDeletePaused = resolve;
    });
    let releaseDelete!: () => void;
    const deleteGate = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });
    jest.spyOn(manager.store, 'delete').mockImplementationOnce(async (id) => {
      markDeletePaused();
      await deleteGate;
      await originalDelete(id);
    });

    const purging = manager.purge('container-1');
    await deletePaused;
    const syncing = manager.sync('container-1', 'org-1');
    releaseDelete();
    await purging;

    await expect(syncing).rejects.toMatchObject({ name: 'AbortError' });
    await expect(stat(join(rootDir, 'container-1'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('prevents an in-flight pin from recreating state after container purge', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'shared-replica-'));
    const fixture = await buildFixture();
    const manager = new SharedContainerReplicaManager({
      rootDir,
      transport: transportFor(fixture),
      fetchImpl: fetchFor(fixture),
    });
    await manager.sync('container-1', 'org-1');
    const originalGet = manager.store.get.bind(manager.store);
    let markPinPaused!: () => void;
    const pinPaused = new Promise<void>((resolve) => {
      markPinPaused = resolve;
    });
    let releasePin!: () => void;
    const pinGate = new Promise<void>((resolve) => {
      releasePin = resolve;
    });
    jest.spyOn(manager.store, 'get').mockImplementationOnce(async (id) => {
      const state = await originalGet(id);
      markPinPaused();
      await pinGate;
      return state;
    });
    const pinning = manager.pin('container-1');
    await pinPaused;

    const purging = manager.purge('container-1');
    releasePin();

    await expect(pinning).rejects.toMatchObject({ name: 'AbortError' });
    await purging;
    await expect(stat(join(rootDir, 'container-1'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(manager.getState('container-1')).resolves.toBeNull();
  });

  it('promotes code repositories inside the verified revision tree', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'shared-replica-'));
    const fixture = await buildFixture({
      containerType: 'CODE_WORKTREE',
      repoIds: ['repo-1'],
    });
    const syncReservationBytes = BigInt(10 * 1024 * 1024);
    const materializeCode = jest.fn(
      async ({ reposDir }: MaterializeCodeRevisionOptions) => {
        await mkdir(reposDir, { recursive: true });
        await writeFile(join(reposDir, 'marker.txt'), 'verified');
        return { ok: true as const };
      },
    );
    const manager = new SharedContainerReplicaManager({
      rootDir,
      transport: transportFor(fixture),
      fetchImpl: fetchFor(fixture),
      materializeCodeRevision: materializeCode,
      syncReservationBytes,
    });

    await manager.sync('container-1', 'org-1');

    expect(materializeCode).toHaveBeenCalledWith(
      expect.objectContaining({
        reposDir: join(
          rootDir,
          'container-1',
          'staging',
          'revision-1',
          'repos',
        ),
      }),
    );
    await expect(
      readFile(
        join(
          rootDir,
          'container-1',
          'revisions',
          'revision-1',
          'repos',
          'marker.txt',
        ),
        'utf8',
      ),
    ).resolves.toBe('verified');
    await expect(
      stat(join(rootDir, 'container-1', 'repos')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps the base checkout out of the sync storage reservation', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'shared-replica-'));
    const fixture = await buildFixture({
      containerType: 'CODE_WORKTREE',
      repoIds: ['repo-1'],
    });
    // Deliberately smaller than the checkout the fake materializer writes: a
    // base checkout is the recipient's own authenticated Git content, not
    // container storage, so it must not be charged against the reservation.
    const syncReservationBytes = BigInt(1024 * 1024);
    const manager = new SharedContainerReplicaManager({
      rootDir,
      transport: transportFor(fixture),
      fetchImpl: fetchFor(fixture),
      syncReservationBytes,
      materializeCodeRevision: async ({
        reposDir,
      }: MaterializeCodeRevisionOptions): Promise<{ ok: true }> => {
        await mkdir(join(reposDir, 'repo-1'), { recursive: true });
        await writeFile(
          join(reposDir, 'repo-1', 'big.bin'),
          Buffer.alloc(4 * 1024 * 1024, 1),
        );
        return { ok: true as const };
      },
    });

    await expect(manager.sync('container-1', 'org-1')).resolves.toMatchObject({
      status: 'available',
    });
    await expect(
      stat(
        join(
          rootDir,
          'container-1',
          'revisions',
          'revision-1',
          'repos',
          'repo-1',
          'big.bin',
        ),
      ),
    ).resolves.toMatchObject({ size: 4 * 1024 * 1024 });
  });

  it('returns a blocked code state after removing read-only staging', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'shared-replica-'));
    const fixture = await buildFixture({
      containerType: 'CODE_WORKTREE',
      repoIds: ['repo-1'],
    });
    const manager = new SharedContainerReplicaManager({
      rootDir,
      transport: transportFor(fixture),
      fetchImpl: fetchFor(fixture),
      materializeCodeRevision: async ({
        reposDir,
      }: MaterializeCodeRevisionOptions): Promise<{
        ok: false;
        block: {
          reason: 'lfs-unsupported';
          repository: string;
          message: string;
        };
      }> => {
        const repoDir = join(reposDir, 'repo-1');
        await mkdir(repoDir, { recursive: true });
        await writeFile(join(repoDir, 'README.md'), 'blocked');
        await chmod(join(repoDir, 'README.md'), 0o400);
        await chmod(repoDir, 0o500);
        return {
          ok: false,
          block: {
            reason: 'lfs-unsupported',
            repository: 'acme/repo',
            message: 'Git LFS repositories are not supported',
          },
        };
      },
    });

    await expect(manager.sync('container-1', 'org-1')).resolves.toMatchObject({
      status: 'blocked',
      reason: 'lfs-unsupported',
    });
    await expect(
      stat(join(rootDir, 'container-1', 'staging', 'revision-1')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('aborts a paused repository clone before purging decrypted staging', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'shared-replica-'));
    const fixture = await buildFixture({
      layout: {
        schemaVersion: 1,
        containerType: 'CODE_WORKTREE',
        title: 'Feature branch',
        repositories: [
          {
            repoId: 'repo-1',
            repoName: 'repo',
            remoteUrl: 'https://github.com/acme/repo.git',
            owner: 'acme',
            repository: 'repo',
            baseCommitSha: 'a'.repeat(40),
            files: [],
          },
        ],
        files: [],
        notes: [],
        prompts: [],
        attachmentPaths: {},
      },
    });
    let markCloneStarted!: () => void;
    const cloneStarted = new Promise<void>((resolve) => {
      markCloneStarted = resolve;
    });
    let cloneAborted = false;
    const dependencies: MaterializeCodeDependencies = {
      resolveGitHubToken: () => Promise.resolve('recipient-token'),
      probeRepository: () => Promise.resolve(),
      probeCommit: () => Promise.resolve('b'.repeat(40)),
      inspectRepositoryTree: () =>
        Promise.resolve({
          fileCount: 0,
          allocationEntryCount: 0,
          totalBytes: BigInt(0),
        }),
      cloneRepo: (_remoteUrl, _destination, options) => {
        expect(options?.timeoutMs).toBeGreaterThan(0);
        markCloneStarted();
        return new Promise<void>((_resolve, reject) => {
          options?.signal?.addEventListener(
            'abort',
            () => {
              cloneAborted = true;
              reject(new DOMException('Aborted', 'AbortError'));
            },
            { once: true },
          );
        });
      },
      fetchOrigin: () => Promise.resolve(),
      materializeRawCommit: () =>
        Promise.resolve({ fileCount: 0, totalBytes: BigInt(0) }),
    };
    const manager = new SharedContainerReplicaManager({
      rootDir,
      transport: transportFor(fixture),
      fetchImpl: fetchFor(fixture),
      materializeCodeRevision: (
        options,
      ): ReturnType<typeof materializeCodeRevision> =>
        materializeCodeRevision(options, dependencies),
    });

    const syncing = manager.sync('container-1', 'org-1');
    const syncOutcome = syncing.catch((error: unknown) => error);
    await cloneStarted;
    await manager.purge('container-1');

    await expect(syncOutcome).resolves.toMatchObject({ name: 'AbortError' });
    expect(cloneAborted).toBe(true);
    await expect(stat(join(rootDir, 'container-1'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('removes superseded revision trees after committing an update', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'shared-replica-'));
    let fixture = await buildFixture();
    const manager = new SharedContainerReplicaManager({
      rootDir,
      transport: {
        resolveLatest: (): Promise<typeof fixture.detail> =>
          Promise.resolve(fixture.detail),
        fetchRevision: (): Promise<typeof fixture.revision> =>
          Promise.resolve(fixture.revision),
        requestDownloadUrls: (
          _containerId,
          _revisionId,
          _orgId,
          artifactIds,
        ): Promise<typeof fixture.downloads> =>
          Promise.resolve({
            downloads: fixture.downloads.downloads.filter((download) =>
              artifactIds.includes(download.artifactId),
            ),
          }),
      },
      fetchImpl: ((input) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        return Promise.resolve(new Response(fixture.responses.get(url)));
      }) as typeof fetch,
    });
    await manager.sync('container-1', 'org-1');
    fixture = await buildFixture({
      revisionId: 'revision-2',
      revision: 2,
      parentRevisionId: 'revision-1',
    });

    await manager.sync('container-1', 'org-1');

    await expect(
      stat(join(rootDir, 'container-1', 'revisions', 'revision-2')),
    ).resolves.toBeDefined();
    await expect(
      stat(join(rootDir, 'container-1', 'revisions', 'revision-1')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps the current revision available and retries a failed superseded-revision prune', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'shared-replica-'));
    let fixture = await buildFixture();
    const manager = new SharedContainerReplicaManager({
      rootDir,
      transport: {
        resolveLatest: (): Promise<typeof fixture.detail> =>
          Promise.resolve(fixture.detail),
        fetchRevision: (): Promise<typeof fixture.revision> =>
          Promise.resolve(fixture.revision),
        requestDownloadUrls: (
          _containerId,
          _revisionId,
          _orgId,
          artifactIds,
        ): Promise<typeof fixture.downloads> =>
          Promise.resolve({
            downloads: fixture.downloads.downloads.filter((download) =>
              artifactIds.includes(download.artifactId),
            ),
          }),
      },
      fetchImpl: ((input) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        return Promise.resolve(new Response(fixture.responses.get(url)));
      }) as typeof fetch,
    });
    await manager.sync('container-1', 'org-1');
    const pruneRevisions = jest
      .spyOn(manager.store, 'pruneRevisions')
      .mockRejectedValueOnce(new Error('cleanup unavailable'));
    fixture = await buildFixture({
      revisionId: 'revision-2',
      revision: 2,
      parentRevisionId: 'revision-1',
    });

    await expect(manager.sync('container-1', 'org-1')).resolves.toMatchObject({
      status: 'available',
      revisionId: 'revision-2',
    });
    await expect(
      stat(join(rootDir, 'container-1', 'revisions', 'revision-1')),
    ).resolves.toBeDefined();

    await expect(manager.sync('container-1', 'org-1')).resolves.toMatchObject({
      status: 'available',
      revisionId: 'revision-2',
    });
    expect(pruneRevisions).toHaveBeenCalledTimes(2);
    await expect(
      stat(join(rootDir, 'container-1', 'revisions', 'revision-1')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('aborts active syncs and removes the bounded replica root during purge-all', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'shared-replica-'));
    const fixture = await buildFixture();
    await mkdir(join(rootDir, 'orphan-container'), { recursive: true });
    await writeFile(join(rootDir, 'orphan-container', 'plaintext'), 'secret');
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const manager = new SharedContainerReplicaManager({
      rootDir,
      transport: transportFor(fixture),
      fetchImpl: ((_input, init) => {
        markStarted();
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
        });
      }) as typeof fetch,
    });

    const syncing = manager.sync('container-1', 'org-1');
    await started;
    await manager.purgeAll();

    await expect(syncing).rejects.toMatchObject({ name: 'AbortError' });
    await expect(stat(rootDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('propagates a failed root purge to concurrent container cleanup', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'shared-replica-'));
    const fixture = await buildFixture();
    const manager = new SharedContainerReplicaManager({
      rootDir,
      transport: transportFor(fixture),
      fetchImpl: fetchFor(fixture),
    });
    await manager.sync('container-1', 'org-1');
    let markPurgeEntered!: () => void;
    const purgeEntered = new Promise<void>((resolve) => {
      markPurgeEntered = resolve;
    });
    let releasePurge!: () => void;
    const purgeGate = new Promise<void>((resolve) => {
      releasePurge = resolve;
    });
    jest
      .spyOn(manager.store, 'purgeAllBytes')
      .mockImplementationOnce(async () => {
        markPurgeEntered();
        await purgeGate;
        throw new Error('root purge failed');
      });

    const purging = manager.purgeAll();
    void purging.catch(() => undefined);
    await purgeEntered;
    const closing = manager.close('container-1');
    releasePurge();

    await expect(purging).rejects.toThrow('root purge failed');
    await expect(closing).rejects.toThrow('root purge failed');
  });

  it('prevents an in-flight pin from recreating the replica index after purge-all', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'shared-replica-'));
    const fixture = await buildFixture();
    const manager = new SharedContainerReplicaManager({
      rootDir,
      transport: transportFor(fixture),
      fetchImpl: fetchFor(fixture),
    });
    await manager.sync('container-1', 'org-1');

    const originalGet = manager.store.get.bind(manager.store);
    let signalPinPaused!: () => void;
    const pinPaused = new Promise<void>((resolve) => {
      signalPinPaused = resolve;
    });
    let releasePin!: () => void;
    const pinGate = new Promise<void>((resolve) => {
      releasePin = resolve;
    });
    jest.spyOn(manager.store, 'get').mockImplementationOnce(async (id) => {
      const state = await originalGet(id);
      signalPinPaused();
      await pinGate;
      return state;
    });
    const pinning = manager.pin('container-1');
    await pinPaused;

    const purging = manager.purgeAll();
    releasePin();

    await expect(pinning).resolves.toMatchObject({ status: 'pinned' });
    await purging;
    await expect(stat(rootDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps new syncs fenced after root purge until an identity transition commits', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'shared-replica-'));
    const fixture = await buildFixture();
    const manager = new SharedContainerReplicaManager({
      rootDir,
      transport: transportFor(fixture),
      fetchImpl: fetchFor(fixture),
    });
    await manager.sync('container-1', 'org-1');
    let enterTransition!: () => void;
    const transitionEntered = new Promise<void>((resolve) => {
      enterTransition = resolve;
    });
    let releaseTransition!: () => void;
    const transitionGate = new Promise<void>((resolve) => {
      releaseTransition = resolve;
    });

    const transition = manager.withPurgeAllFence(async () => {
      enterTransition();
      await transitionGate;
    });
    await transitionEntered;

    await expect(stat(rootDir)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(manager.sync('container-1', 'org-1')).rejects.toMatchObject({
      name: 'AbortError',
    });

    releaseTransition();
    await transition;
    await expect(manager.sync('container-1', 'org-1')).resolves.toMatchObject({
      status: 'available',
    });
  });

  it('does not let an authorization transition overtake a sync revision commit', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'shared-replica-'));
    const fixture = await buildFixture();
    const manager = new SharedContainerReplicaManager({
      rootDir,
      transport: transportFor(fixture),
      fetchImpl: fetchFor(fixture),
    });
    const originalCommit = manager.store.commitRevision.bind(manager.store);
    let markCommitEntered!: () => void;
    const commitEntered = new Promise<void>((resolve) => {
      markCommitEntered = resolve;
    });
    let releaseCommit!: () => void;
    const commitGate = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    jest
      .spyOn(manager.store, 'commitRevision')
      .mockImplementationOnce(async (...args): Promise<void> => {
        markCommitEntered();
        await commitGate;
        await originalCommit(...args);
      });
    const syncing = manager.sync('container-1', 'org-1');
    await commitEntered;

    let transitionCompleted = false;
    const transition = manager
      .withOrganizationSnapshotFence(['org-1'], () => Promise.resolve())
      .then(() => {
        transitionCompleted = true;
      });
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
    const completedBeforeCommit = transitionCompleted;
    releaseCommit();

    await syncing;
    await transition;
    expect(completedBeforeCommit).toBe(false);
  });

  it('does not let a root authorization transition overtake a pin commit', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'shared-replica-'));
    const fixture = await buildFixture();
    const manager = new SharedContainerReplicaManager({
      rootDir,
      transport: transportFor(fixture),
      fetchImpl: fetchFor(fixture),
    });
    await manager.sync('container-1', 'org-1');
    const originalSet = manager.store.set.bind(manager.store);
    let markSetEntered!: () => void;
    const setEntered = new Promise<void>((resolve) => {
      markSetEntered = resolve;
    });
    let releaseSet!: () => void;
    const setGate = new Promise<void>((resolve) => {
      releaseSet = resolve;
    });
    jest
      .spyOn(manager.store, 'set')
      .mockImplementationOnce(async (...args): Promise<void> => {
        markSetEntered();
        await setGate;
        await originalSet(...args);
      });
    const pinning = manager.pin('container-1');
    await setEntered;

    let transitionCompleted = false;
    const transition = manager
      .withPurgeAllFence(() => Promise.resolve())
      .then(() => {
        transitionCompleted = true;
      });
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
    const completedBeforePin = transitionCompleted;
    releaseSet();

    await pinning;
    await transition;
    expect(completedBeforePin).toBe(false);
    await expect(stat(rootDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not let an authorization transition overtake a container purge commit', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'shared-replica-'));
    const fixture = await buildFixture();
    const manager = new SharedContainerReplicaManager({
      rootDir,
      transport: transportFor(fixture),
      fetchImpl: fetchFor(fixture),
    });
    await manager.sync('container-1', 'org-1');
    const originalPurgeBytes = manager.store.purgeBytes.bind(manager.store);
    let markPurgeEntered!: () => void;
    const purgeEntered = new Promise<void>((resolve) => {
      markPurgeEntered = resolve;
    });
    let releasePurge!: () => void;
    const purgeGate = new Promise<void>((resolve) => {
      releasePurge = resolve;
    });
    jest
      .spyOn(manager.store, 'purgeBytes')
      .mockImplementationOnce(async (...args): Promise<void> => {
        markPurgeEntered();
        await purgeGate;
        await originalPurgeBytes(...args);
      });
    const purging = manager.purge('container-1');
    await purgeEntered;

    let transitionCompleted = false;
    const transition = manager
      .withOrganizationSnapshotFence(['org-1'], () => Promise.resolve())
      .then(() => {
        transitionCompleted = true;
      });
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
    const completedBeforePurge = transitionCompleted;
    releasePurge();

    await purging;
    await transition;
    expect(completedBeforePurge).toBe(false);
  });
  // CAN-2551: every open was a cold start. These lock in the two halves of the
  // fix — the same-revision fast path is reachable now that close() retains the
  // replica, and a revision bump reuses the previous checkout instead of
  // re-cloning.
  it('reuses the previous revision checkout across a revision bump instead of re-cloning', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'shared-replica-'));
    let fixture = await buildFixture({
      containerType: 'CODE_WORKTREE',
      repoIds: ['repo-1'],
    });
    const clonedInto: string[] = [];
    const fetchedInto: string[] = [];
    const materializeCode = jest.fn(
      async ({ reposDir }: MaterializeCodeRevisionOptions) => {
        const repoDir = join(reposDir, 'repo-1');
        if (existsSync(join(repoDir, '.git'))) {
          fetchedInto.push(repoDir);
        } else {
          clonedInto.push(repoDir);
          await mkdir(join(repoDir, '.git'), { recursive: true });
          await writeFile(join(repoDir, '.git', 'HEAD'), 'ref: refs/heads/x\n');
          await writeFile(join(repoDir, 'checkout.txt'), 'expensive clone');
        }
        return { ok: true as const };
      },
    );
    const manager = new SharedContainerReplicaManager({
      rootDir,
      transport: {
        resolveLatest: (): Promise<typeof fixture.detail> =>
          Promise.resolve(fixture.detail),
        fetchRevision: (): Promise<typeof fixture.revision> =>
          Promise.resolve(fixture.revision),
        requestDownloadUrls: (
          _containerId,
          _revisionId,
          _orgId,
          artifactIds,
        ): Promise<typeof fixture.downloads> =>
          Promise.resolve({
            downloads: fixture.downloads.downloads.filter((download) =>
              artifactIds.includes(download.artifactId),
            ),
          }),
      },
      fetchImpl: ((input) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        return Promise.resolve(new Response(fixture.responses.get(url)));
      }) as typeof fetch,
      materializeCodeRevision: materializeCode,
      syncReservationBytes: BigInt(10 * 1024 * 1024),
    });

    await manager.sync('container-1', 'org-1');
    expect(clonedInto).toHaveLength(1);

    fixture = await buildFixture({
      containerType: 'CODE_WORKTREE',
      repoIds: ['repo-1'],
      revisionId: 'revision-2',
      revision: 2,
      parentRevisionId: 'revision-1',
    });
    await manager.sync('container-1', 'org-1');

    expect(clonedInto).toHaveLength(1);
    expect(fetchedInto).toHaveLength(1);
    // The carried-forward checkout is the same bytes, promoted under the new
    // revision rather than downloaded again.
    await expect(
      readFile(
        join(
          rootDir,
          'container-1',
          'revisions',
          'revision-2',
          'repos',
          'repo-1',
          'checkout.txt',
        ),
        'utf8',
      ),
    ).resolves.toBe('expensive clone');
  });

  it('serves a repeat open at the same revision with no transport or checkout work', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'shared-replica-'));
    const fixture = await buildFixture({
      containerType: 'CODE_WORKTREE',
      repoIds: ['repo-1'],
    });
    const fetchRevision = jest.fn(() => Promise.resolve(fixture.revision));
    const requestDownloadUrls = jest.fn(
      (_containerId, _revisionId, _orgId, artifactIds: readonly string[]) =>
        Promise.resolve({
          downloads: fixture.downloads.downloads.filter((download) =>
            artifactIds.includes(download.artifactId),
          ),
        }),
    );
    const materializeCode = jest.fn(
      async ({ reposDir }: MaterializeCodeRevisionOptions) => {
        await mkdir(reposDir, { recursive: true });
        return { ok: true as const };
      },
    );
    // `resolveLatest` is the *first* transport call of a cold open, so it has
    // to be a spy too: asserting only the later two would let a fast path that
    // still round-trips for the revision pointer pass as "no transport work".
    const resolveLatest = jest.fn(() => Promise.resolve(fixture.detail));
    const manager = new SharedContainerReplicaManager({
      rootDir,
      transport: {
        resolveLatest,
        fetchRevision,
        requestDownloadUrls,
      },
      fetchImpl: fetchFor(fixture),
      materializeCodeRevision: materializeCode,
      syncReservationBytes: BigInt(10 * 1024 * 1024),
    });

    await manager.sync('container-1', 'org-1');
    resolveLatest.mockClear();
    fetchRevision.mockClear();
    requestDownloadUrls.mockClear();
    materializeCode.mockClear();

    await expect(manager.sync('container-1', 'org-1')).resolves.toMatchObject({
      status: 'available',
      revisionId: 'revision-1',
    });

    expect(fetchRevision).not.toHaveBeenCalled();
    expect(requestDownloadUrls).not.toHaveBeenCalled();
    expect(materializeCode).not.toHaveBeenCalled();
    // One pointer resolution is the whole cost of a repeat open: it is what
    // proves the revision is unchanged. Anything beyond it is the cold path.
    expect(resolveLatest).toHaveBeenCalledTimes(1);
  });

  // CAN-2551: the plan's retention decision is deliberately open-ended — no
  // size cap, no quota, no LRU. This pins the consequence: navigating in and
  // out repeatedly must never re-materialize, and never evict.
  it('keeps the replica across repeated open/close cycles without re-materializing', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'shared-replica-'));
    const fixture = await buildFixture({
      containerType: 'CODE_WORKTREE',
      repoIds: ['repo-1'],
    });
    const materializeCode = jest.fn(
      async ({ reposDir }: MaterializeCodeRevisionOptions) => {
        const repoDir = join(reposDir, 'repo-1');
        await mkdir(repoDir, { recursive: true });
        await writeFile(join(repoDir, 'checkout.txt'), 'expensive clone');
        return { ok: true as const };
      },
    );
    const manager = new SharedContainerReplicaManager({
      rootDir,
      transport: transportFor(fixture),
      fetchImpl: fetchFor(fixture),
      materializeCodeRevision: materializeCode,
      syncReservationBytes: BigInt(10 * 1024 * 1024),
    });
    const service = new SharedContainerReconciliationService(
      manager,
      transportFor(fixture),
    );

    const checkoutPath = join(
      rootDir,
      'container-1',
      'revisions',
      'revision-1',
      'repos',
      'repo-1',
      'checkout.txt',
    );

    for (let cycle = 0; cycle < 3; cycle += 1) {
      await manager.sync('container-1', 'org-1');
      // The viewer closing is ordinary navigation away.
      await service.close('container-1');
      await expect(readFile(checkoutPath, 'utf8')).resolves.toBe(
        'expensive clone',
      );
    }

    // Only the very first open paid for materialization; the other two were
    // served from the retained replica.
    expect(materializeCode).toHaveBeenCalledTimes(1);
  });

  it('reports each open phase so a slow checkout is narrated rather than silent', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'shared-replica-'));
    const fixture = await buildFixture({
      containerType: 'CODE_WORKTREE',
      repoIds: ['repo-1'],
    });
    const phases: string[] = [];
    const manager = new SharedContainerReplicaManager({
      rootDir,
      transport: transportFor(fixture),
      fetchImpl: fetchFor(fixture),
      materializeCodeRevision: async ({
        reposDir,
      }: MaterializeCodeRevisionOptions): Promise<{ ok: true }> => {
        await mkdir(reposDir, { recursive: true });
        return { ok: true as const };
      },
      syncReservationBytes: BigInt(10 * 1024 * 1024),
      onPhase: (event): void => {
        expect(event.containerId).toBe('container-1');
        phases.push(event.phase);
      },
    });

    await manager.sync('container-1', 'org-1');

    expect(phases).toEqual([
      'checking-access',
      'downloading',
      'checking-out',
      'sealing',
    ]);
  });

  it('never lets a progress listener fault a sync', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'shared-replica-'));
    const fixture = await buildFixture();
    const manager = new SharedContainerReplicaManager({
      rootDir,
      transport: transportFor(fixture),
      fetchImpl: fetchFor(fixture),
      onPhase: (): never => {
        throw new Error('listener exploded');
      },
    });

    await expect(manager.sync('container-1', 'org-1')).resolves.toMatchObject({
      status: 'available',
    });
  });
  it('puts a borrowed checkout back when the revision bump fails', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'shared-replica-'));
    let fixture = await buildFixture({
      containerType: 'CODE_WORKTREE',
      repoIds: ['repo-1'],
    });
    let failMaterialization = false;
    const manager = new SharedContainerReplicaManager({
      rootDir,
      transport: {
        resolveLatest: (): Promise<typeof fixture.detail> =>
          Promise.resolve(fixture.detail),
        fetchRevision: (): Promise<typeof fixture.revision> =>
          Promise.resolve(fixture.revision),
        requestDownloadUrls: (
          _containerId,
          _revisionId,
          _orgId,
          artifactIds,
        ): Promise<typeof fixture.downloads> =>
          Promise.resolve({
            downloads: fixture.downloads.downloads.filter((download) =>
              artifactIds.includes(download.artifactId),
            ),
          }),
      },
      fetchImpl: ((input) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        return Promise.resolve(new Response(fixture.responses.get(url)));
      }) as typeof fetch,
      materializeCodeRevision: async ({
        reposDir,
      }: MaterializeCodeRevisionOptions): Promise<{ ok: true }> => {
        if (failMaterialization) {
          throw new Error('checkout failed');
        }
        const repoDir = join(reposDir, 'repo-1');
        await mkdir(join(repoDir, '.git'), { recursive: true });
        await writeFile(join(repoDir, '.git', 'HEAD'), 'ref: refs/heads/x\n');
        await writeFile(join(repoDir, 'checkout.txt'), 'expensive clone');
        return { ok: true as const };
      },
      syncReservationBytes: BigInt(10 * 1024 * 1024),
    });

    await manager.sync('container-1', 'org-1');
    const checkoutPath = join(
      rootDir,
      'container-1',
      'revisions',
      'revision-1',
      'repos',
      'repo-1',
      'checkout.txt',
    );
    await expect(readFile(checkoutPath, 'utf8')).resolves.toBe(
      'expensive clone',
    );

    failMaterialization = true;
    fixture = await buildFixture({
      containerType: 'CODE_WORKTREE',
      repoIds: ['repo-1'],
      revisionId: 'revision-2',
      revision: 2,
      parentRevisionId: 'revision-1',
    });
    await expect(manager.sync('container-1', 'org-1')).rejects.toThrow(
      'checkout failed',
    );

    // revision-1 is still what replica state points at, so the checkout the
    // bump borrowed has to be back where the reader expects it.
    await expect(manager.getState('container-1')).resolves.toMatchObject({
      status: 'available',
      revisionId: 'revision-1',
    });
    await expect(readFile(checkoutPath, 'utf8')).resolves.toBe(
      'expensive clone',
    );
  });

  // CAN-2551: the seed is only reversible before materialization touches it.
  // `materializeGitCommitRaw` rewrites the borrowed working tree in place and
  // the overlay lands on top, so putting that tree back would leave the
  // retained revision serving the NEW revision's files under the OLD layout —
  // silently, because its index entry still reads `available`. Dropping the
  // entry is the honest outcome; the next open rematerializes.
  it('invalidates the retained revision when a bump failed after mutating the borrowed checkout', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'shared-replica-'));
    let fixture = await buildFixture({
      containerType: 'CODE_WORKTREE',
      repoIds: ['repo-1'],
    });
    let mutateThenFail = false;
    const manager = new SharedContainerReplicaManager({
      rootDir,
      transport: {
        resolveLatest: (): Promise<typeof fixture.detail> =>
          Promise.resolve(fixture.detail),
        fetchRevision: (): Promise<typeof fixture.revision> =>
          Promise.resolve(fixture.revision),
        requestDownloadUrls: (
          _containerId,
          _revisionId,
          _orgId,
          artifactIds,
        ): Promise<typeof fixture.downloads> =>
          Promise.resolve({
            downloads: fixture.downloads.downloads.filter((download) =>
              artifactIds.includes(download.artifactId),
            ),
          }),
      },
      fetchImpl: ((input) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        return Promise.resolve(new Response(fixture.responses.get(url)));
      }) as typeof fetch,
      materializeCodeRevision: async ({
        reposDir,
        onRepositoryMutating,
      }: MaterializeCodeRevisionOptions): Promise<{ ok: true }> => {
        const repoDir = join(reposDir, 'repo-1');
        // The real materializer announces the repository before its first
        // write; the borrowed checkout stops being restorable from here.
        onRepositoryMutating?.('repo-1');
        await mkdir(join(repoDir, '.git'), { recursive: true });
        await writeFile(join(repoDir, '.git', 'HEAD'), 'ref: refs/heads/x\n');
        if (mutateThenFail) {
          // Rewrite the working tree in place, then fail on a later step.
          await writeFile(join(repoDir, 'checkout.txt'), 'revision-2 content');
          throw new Error('sealing failed');
        }
        await writeFile(join(repoDir, 'checkout.txt'), 'expensive clone');
        return { ok: true as const };
      },
      syncReservationBytes: BigInt(10 * 1024 * 1024),
    });

    await manager.sync('container-1', 'org-1');
    const checkoutPath = join(
      rootDir,
      'container-1',
      'revisions',
      'revision-1',
      'repos',
      'repo-1',
      'checkout.txt',
    );
    await expect(readFile(checkoutPath, 'utf8')).resolves.toBe(
      'expensive clone',
    );

    mutateThenFail = true;
    fixture = await buildFixture({
      containerType: 'CODE_WORKTREE',
      repoIds: ['repo-1'],
      revisionId: 'revision-2',
      revision: 2,
      parentRevisionId: 'revision-1',
    });
    await expect(manager.sync('container-1', 'org-1')).rejects.toThrow(
      'sealing failed',
    );

    // The mutated tree must NOT be restored under revision-1's layout. The
    // index entry is dropped instead, so nothing serves mismatched content.
    await expect(manager.getState('container-1')).resolves.toBeNull();
  });

  // CAN-2551: seeding runs after the manifest is validated and borrows only the
  // repositories the new revision still declares. Borrowing everything on disk
  // carried a repository the publisher had dropped from the share into the
  // promoted revision, where it was re-borrowed forever — off the storage
  // budget's books, since `repos/` is excluded from it.
  it('does not carry a dropped repository into the promoted revision', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'shared-replica-'));
    let fixture = await buildFixture({
      containerType: 'CODE_WORKTREE',
      repoIds: ['repo-1', 'dropped-repo'],
    });
    const manager = new SharedContainerReplicaManager({
      rootDir,
      transport: {
        resolveLatest: (): Promise<typeof fixture.detail> =>
          Promise.resolve(fixture.detail),
        fetchRevision: (): Promise<typeof fixture.revision> =>
          Promise.resolve(fixture.revision),
        requestDownloadUrls: (
          _containerId,
          _revisionId,
          _orgId,
          artifactIds,
        ): Promise<typeof fixture.downloads> =>
          Promise.resolve({
            downloads: fixture.downloads.downloads.filter((download) =>
              artifactIds.includes(download.artifactId),
            ),
          }),
      },
      fetchImpl: ((input) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        return Promise.resolve(new Response(fixture.responses.get(url)));
      }) as typeof fetch,
      materializeCodeRevision: async ({
        layout,
        reposDir,
        onRepositoryMutating,
      }: MaterializeCodeRevisionOptions): Promise<{ ok: true }> => {
        // Only what the manifest declares, exactly like the real materializer.
        for (const repository of layout.repositories) {
          onRepositoryMutating?.(repository.repoId);
          const repoDir = join(reposDir, repository.repoId);
          await mkdir(join(repoDir, '.git'), { recursive: true });
          await writeFile(join(repoDir, '.git', 'HEAD'), 'ref: refs/heads/x\n');
        }
        return { ok: true as const };
      },
      syncReservationBytes: BigInt(10 * 1024 * 1024),
    });

    await manager.sync('container-1', 'org-1');
    await expect(
      readdir(join(rootDir, 'container-1', 'revisions', 'revision-1', 'repos')),
    ).resolves.toEqual(expect.arrayContaining(['dropped-repo', 'repo-1']));

    // The publisher removes `dropped-repo` from the share.
    fixture = await buildFixture({
      containerType: 'CODE_WORKTREE',
      repoIds: ['repo-1'],
      revisionId: 'revision-2',
      revision: 2,
      parentRevisionId: 'revision-1',
    });
    await manager.sync('container-1', 'org-1');

    await expect(
      readdir(join(rootDir, 'container-1', 'revisions', 'revision-2', 'repos')),
    ).resolves.toEqual(['repo-1']);
  });

  // CAN-2551 regression: the blocked branch sets replica state and *then*
  // discards staging. A failed restore must not delete the entry the caller
  // just committed and is about to return, or the recipient sees the block
  // reason once and then pays a full cold materialize on every later open to
  // re-derive the same block.
  it('keeps a blocked result that was committed before staging was discarded', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'shared-replica-'));
    let fixture = await buildFixture({
      containerType: 'CODE_WORKTREE',
      repoIds: ['repo-1'],
    });
    let blockNextMaterialization = false;
    const manager = new SharedContainerReplicaManager({
      rootDir,
      transport: {
        resolveLatest: (): Promise<typeof fixture.detail> =>
          Promise.resolve(fixture.detail),
        fetchRevision: (): Promise<typeof fixture.revision> =>
          Promise.resolve(fixture.revision),
        requestDownloadUrls: (
          _containerId,
          _revisionId,
          _orgId,
          artifactIds,
        ): Promise<typeof fixture.downloads> =>
          Promise.resolve({
            downloads: fixture.downloads.downloads.filter((download) =>
              artifactIds.includes(download.artifactId),
            ),
          }),
      },
      fetchImpl: ((input) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        return Promise.resolve(new Response(fixture.responses.get(url)));
      }) as typeof fetch,
      materializeCodeRevision: async ({
        reposDir,
        onRepositoryMutating,
      }: MaterializeCodeRevisionOptions): Promise<
        { ok: true } | { ok: false; block: { reason: string; message: string } }
      > => {
        onRepositoryMutating?.('repo-1');
        const repoDir = join(reposDir, 'repo-1');
        await mkdir(join(repoDir, '.git'), { recursive: true });
        await writeFile(join(repoDir, '.git', 'HEAD'), 'ref: refs/heads/x\n');
        if (blockNextMaterialization) {
          // A block fires after the materializer has already written into the
          // borrowed checkout, which is exactly when the restore refuses.
          return {
            ok: false as const,
            block: {
              reason: 'lfs-unsupported',
              message: 'Git LFS repositories are not supported',
            },
          };
        }
        await writeFile(join(repoDir, 'checkout.txt'), 'expensive clone');
        return { ok: true as const };
      },
      syncReservationBytes: BigInt(10 * 1024 * 1024),
    });

    await manager.sync('container-1', 'org-1');

    blockNextMaterialization = true;
    fixture = await buildFixture({
      containerType: 'CODE_WORKTREE',
      repoIds: ['repo-1'],
      revisionId: 'revision-2',
      revision: 2,
      parentRevisionId: 'revision-1',
    });
    const blocked = await manager.sync('container-1', 'org-1');
    expect(blocked).toMatchObject({ status: 'blocked' });

    // The state the caller just returned must still be readable.
    await expect(manager.getState('container-1')).resolves.toMatchObject({
      status: 'blocked',
      reason: 'lfs-unsupported',
    });
  });

  // CAN-2551: mutation is tracked per repository, not per materialization call.
  // A repository the materializer never reached — a newly added one that fails
  // to clone, say — says nothing about a borrowed checkout sitting untouched
  // beside it, and condemning the whole previous revision for that would force
  // a full re-clone of every repository for an unrelated failure.
  it('restores an untouched borrowed checkout when an unrelated repository fails', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'shared-replica-'));
    let fixture = await buildFixture({
      containerType: 'CODE_WORKTREE',
      repoIds: ['repo-1'],
    });
    let failUnrelatedRepo = false;
    const manager = new SharedContainerReplicaManager({
      rootDir,
      transport: {
        resolveLatest: (): Promise<typeof fixture.detail> =>
          Promise.resolve(fixture.detail),
        fetchRevision: (): Promise<typeof fixture.revision> =>
          Promise.resolve(fixture.revision),
        requestDownloadUrls: (
          _containerId,
          _revisionId,
          _orgId,
          artifactIds,
        ): Promise<typeof fixture.downloads> =>
          Promise.resolve({
            downloads: fixture.downloads.downloads.filter((download) =>
              artifactIds.includes(download.artifactId),
            ),
          }),
      },
      fetchImpl: ((input) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        return Promise.resolve(new Response(fixture.responses.get(url)));
      }) as typeof fetch,
      materializeCodeRevision: async ({
        reposDir,
        onRepositoryMutating,
      }: MaterializeCodeRevisionOptions): Promise<{ ok: true }> => {
        if (failUnrelatedRepo) {
          // A repository that is not in the previous revision, so nothing was
          // borrowed for it. It is announced and written, then fails — without
          // `repo-1` ever being reached.
          onRepositoryMutating?.('repo-2');
          const otherDir = join(reposDir, 'repo-2');
          await mkdir(otherDir, { recursive: true });
          throw new Error('unrelated clone failed');
        }
        onRepositoryMutating?.('repo-1');
        const repoDir = join(reposDir, 'repo-1');
        await mkdir(join(repoDir, '.git'), { recursive: true });
        await writeFile(join(repoDir, '.git', 'HEAD'), 'ref: refs/heads/x\n');
        await writeFile(join(repoDir, 'checkout.txt'), 'expensive clone');
        return { ok: true as const };
      },
      syncReservationBytes: BigInt(10 * 1024 * 1024),
    });

    await manager.sync('container-1', 'org-1');
    const checkoutPath = join(
      rootDir,
      'container-1',
      'revisions',
      'revision-1',
      'repos',
      'repo-1',
      'checkout.txt',
    );
    await expect(readFile(checkoutPath, 'utf8')).resolves.toBe(
      'expensive clone',
    );

    failUnrelatedRepo = true;
    fixture = await buildFixture({
      containerType: 'CODE_WORKTREE',
      repoIds: ['repo-1'],
      revisionId: 'revision-2',
      revision: 2,
      parentRevisionId: 'revision-1',
    });
    await expect(manager.sync('container-1', 'org-1')).rejects.toThrow(
      'unrelated clone failed',
    );

    // `repo-1` was borrowed but never written to, so the retained revision
    // keeps both its index entry and its checkout.
    await expect(manager.getState('container-1')).resolves.toMatchObject({
      status: 'available',
      revisionId: 'revision-1',
    });
    await expect(readFile(checkoutPath, 'utf8')).resolves.toBe(
      'expensive clone',
    );
  });

  // CAN-2551: seeding moves checkouts rather than copying them, so a crash
  // between the move and the discard leaves the retained revision indexed as
  // `available` with its checkouts gone. The revision directory still exists,
  // which is all the pre-existing integrity check proves — hence the marker.
  it('rematerializes a revision whose checkouts were on loan when the app died', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'shared-replica-'));
    const fixture = await buildFixture({
      containerType: 'CODE_WORKTREE',
      repoIds: ['repo-1'],
    });
    let materializeCount = 0;
    const manager = new SharedContainerReplicaManager({
      rootDir,
      transport: {
        resolveLatest: (): Promise<typeof fixture.detail> =>
          Promise.resolve(fixture.detail),
        fetchRevision: (): Promise<typeof fixture.revision> =>
          Promise.resolve(fixture.revision),
        requestDownloadUrls: (
          _containerId,
          _revisionId,
          _orgId,
          artifactIds,
        ): Promise<typeof fixture.downloads> =>
          Promise.resolve({
            downloads: fixture.downloads.downloads.filter((download) =>
              artifactIds.includes(download.artifactId),
            ),
          }),
      },
      fetchImpl: ((input) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        return Promise.resolve(new Response(fixture.responses.get(url)));
      }) as typeof fetch,
      materializeCodeRevision: async ({
        reposDir,
      }: MaterializeCodeRevisionOptions): Promise<{ ok: true }> => {
        materializeCount += 1;
        const repoDir = join(reposDir, 'repo-1');
        await mkdir(join(repoDir, '.git'), { recursive: true });
        await writeFile(join(repoDir, '.git', 'HEAD'), 'ref: refs/heads/x\n');
        await writeFile(join(repoDir, 'checkout.txt'), 'expensive clone');
        return { ok: true as const };
      },
      syncReservationBytes: BigInt(10 * 1024 * 1024),
    });

    await manager.sync('container-1', 'org-1');
    expect(materializeCount).toBe(1);

    // Simulate the crash: the checkouts were moved out to staging and the
    // breadcrumb was never cleared.
    const reposDir = join(
      rootDir,
      'container-1',
      'revisions',
      'revision-1',
      'repos',
    );
    await makeReplicaTreeWritable(reposDir);
    await rm(join(reposDir, 'repo-1'), { recursive: true, force: true });
    await writeFile(join(reposDir, '.canopy-borrowed'), '');

    // The revision directory still exists, so only the marker distinguishes
    // this from a healthy cache. Without it the same-revision fast path would
    // return the entry and serve a missing checkout.
    await manager.sync('container-1', 'org-1');
    expect(materializeCount).toBe(2);
    await expect(
      readFile(join(reposDir, 'repo-1', 'checkout.txt'), 'utf8'),
    ).resolves.toBe('expensive clone');
  });

  describe('viewer layout mode', () => {
    async function buildManager(): Promise<{
      manager: SharedContainerReplicaManager;
      projectViewerChats: jest.Mock<Promise<void>, unknown[]>;
      modes: () => unknown[];
    }> {
      const rootDir = await mkdtemp(join(tmpdir(), 'shared-replica-mode-'));
      const fixture = await buildFixture();
      const projectViewerChats = jest.fn<Promise<void>, unknown[]>(() =>
        Promise.resolve(),
      );
      const manager = new SharedContainerReplicaManager({
        rootDir,
        transport: transportFor(fixture),
        fetchImpl: fetchFor(fixture),
        projectViewerChats,
      });
      return {
        manager,
        projectViewerChats,
        modes: () =>
          projectViewerChats.mock.calls.map(
            ([, , options]) => (options as { mode?: string }).mode,
          ),
      };
    }

    it('passes reset on the new-revision and same-revision paths of an open', async () => {
      const { manager, modes } = await buildManager();

      await manager.sync('container-1', 'org-1', { viewerLayoutMode: 'reset' });
      await manager.sync('container-1', 'org-1', { viewerLayoutMode: 'reset' });

      expect(modes()).toEqual(['reset', 'reset']);
    });

    it('seeds on both paths when no mode is given', async () => {
      const { manager, modes } = await buildManager();

      await manager.sync('container-1', 'org-1');
      await manager.sync('container-1', 'org-1');

      expect(modes()).toEqual(['seed', 'seed']);
    });

    it('does not let an open adopt a seeding sync already in flight', async () => {
      const { manager, modes } = await buildManager();

      const background = manager.sync('container-1', 'org-1');
      const opened = manager.sync('container-1', 'org-1', {
        viewerLayoutMode: 'reset',
      });
      await Promise.all([background, opened]);

      // The background sync seeds; the open then runs its own sync and resets.
      expect(modes()).toEqual(['seed', 'reset']);
    });

    it('lets a background sync join an open already in flight', async () => {
      const { manager, modes } = await buildManager();

      const opened = manager.sync('container-1', 'org-1', {
        viewerLayoutMode: 'reset',
      });
      const background = manager.sync('container-1', 'org-1');
      await Promise.all([opened, background]);

      expect(modes()).toEqual(['reset']);
    });
  });
});
