import { buildPersonalCatalogPayload } from '../services/personal-catalog-payload';
it('constructs the exact allowlisted wire payload and removes remote credentials', (): void => {
  const source = {
    personalCatalogId: '11111111-1111-4111-8111-111111111111',
    name: 'Example',
    type: 'single-repo' as const,
    remotes: [
      'https://secret:password@github.com/example/app.git?token=secret',
      '/private/local/repo',
    ],
    deviceId: '22222222-2222-4222-8222-222222222222',
    installationGeneration: 2,
    localWorkspaceId: 'project-1',
    paths: ['/private'],
    scripts: { setup: 'secret' },
    branches: ['secret'],
    chats: ['secret'],
    env: { SECRET: 'secret' },
  };
  expect(buildPersonalCatalogPayload(source)).toEqual({
    personalCatalogId: source.personalCatalogId,
    name: 'Example',
    kind: 'CODE',
    topology: 'SINGLE_REPO',
    location: 'LOCAL',
    repositories: [
      { host: 'github.com', ownerLogin: 'example', repoName: 'app' },
    ],
    deviceId: source.deviceId,
    installationGeneration: 2,
    localWorkspaceId: 'project-1',
  });
});

it('maps an over-long workspace id to a stable 128-character identifier', (): void => {
  const long = `w${'a'.repeat(200)}`;
  const first = buildPersonalCatalogPayload({
    personalCatalogId: '11111111-1111-4111-8111-111111111111',
    name: 'Long',
    type: 'cowork',
    remotes: [],
    deviceId: '22222222-2222-4222-8222-222222222222',
    installationGeneration: 0,
    localWorkspaceId: long,
  });
  expect(first?.localWorkspaceId).toHaveLength(128);
  expect(first?.localWorkspaceId).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/);
  expect(first?.localWorkspaceId.startsWith(long.slice(0, 63))).toBe(true);
  expect(
    buildPersonalCatalogPayload({
      personalCatalogId: '11111111-1111-4111-8111-111111111111',
      name: 'Long',
      type: 'cowork',
      remotes: [],
      deviceId: '22222222-2222-4222-8222-222222222222',
      installationGeneration: 0,
      localWorkspaceId: `${long}b`,
    })?.localWorkspaceId,
  ).not.toBe(first?.localWorkspaceId);
});

import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PersonalCatalogSyncService,
  markPersonalCatalogRestore,
  type PersonalCatalogSyncDependencies,
} from '../services/personal-catalog-sync-service';
import * as cloudClient from '../canopy-cloud/client';
import * as workspacePersistence from '../lib/workspace-persistence';
import { broadcastPreferencesSynced } from '../lib/preferences-broadcast';
jest.mock('../lib/preferences-broadcast', () => ({
  broadcastPreferencesSynced: jest.fn(),
}));
import { createHash } from 'node:crypto';
import { CanopyCloudClientError } from '../canopy-cloud/client';
jest.mock('../lib/main-process-logging', () => ({
  logMainProcessError: jest.fn(),
}));
import { logMainProcessError } from '../lib/main-process-logging';
import type { PersonalCatalogPayload } from '../services/personal-catalog-payload';
const payload: PersonalCatalogPayload = {
  personalCatalogId: '11111111-1111-4111-8111-111111111111',
  name: 'Example',
  kind: 'CODE',
  topology: 'SINGLE_REPO',
  location: 'LOCAL',
  repositories: [],
  deviceId: '22222222-2222-4222-8222-222222222222',
  installationGeneration: 0,
  localWorkspaceId: 'project-1',
};
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
describe('Personal catalog outbox', (): void => {
  let directory: string;
  let deps: PersonalCatalogSyncDependencies;
  const send = jest.fn<Promise<unknown>, [unknown, AbortSignal]>();
  const notice = jest.fn();
  beforeEach(async (): Promise<void> => {
    directory = await mkdtemp(join(tmpdir(), 'can-2963-'));
    send.mockReset();
    notice.mockReset();
    send.mockResolvedValue({
      catalogGeneration: 0,
      registrations: [
        { personalCatalogId: payload.personalCatalogId, revision: 1 },
      ],
    });
    deps = {
      file: join(directory, 'outbox.json'),
      accountId: 'owner-a',
      allowed: (): Promise<boolean> => Promise.resolve(true),
      send,
      generation: (): ReturnType<
        PersonalCatalogSyncDependencies['generation']
      > => Promise.resolve({ catalogGeneration: 0, revisions: {} }),
      bumpInstallation: (): Promise<number> => Promise.resolve(1),
      notice,
    };
  });
  afterEach(async (): Promise<void> => {
    await rm(directory, { recursive: true, force: true });
  });
  it.each(['not_restorable', 'catalog_limit', 'conflict'])(
    'fails the transactional batch on %s without revision progress and sends later entries',
    async (serverCode): Promise<void> => {
      deps.generation = (): ReturnType<
        PersonalCatalogSyncDependencies['generation']
      > =>
        Promise.resolve({
          catalogGeneration: 1,
          revisions: { [payload.personalCatalogId]: 2 },
        });
      await markPersonalCatalogRestore(deps.file, deps.accountId, 1);
      const service = new PersonalCatalogSyncService(deps);
      const later = {
        ...payload,
        personalCatalogId: '33333333-3333-4333-8333-333333333333',
      };
      const batch = [payload];
      for (let index = 1; index < 20; index += 1) {
        batch.push({
          ...payload,
          personalCatalogId: `44444444-4444-4444-8444-${String(index).padStart(12, '0')}`,
        });
      }
      await service.enqueue([...batch, later]);
      send.mockRejectedValueOnce(
        new CanopyCloudClientError(
          'http-error',
          'Permanent conflict',
          409,
          serverCode,
        ),
      );
      await service.flush();
      expect(notice).toHaveBeenCalledWith('failed');
      expect(JSON.parse(await readFile(deps.file, 'utf8'))).toMatchObject({
        queue: [{ payload: { personalCatalogId: later.personalCatalogId } }],
      });
      service.dispose();
      const restarted = new PersonalCatalogSyncService(deps);
      await restarted.enqueue([...batch, later]);
      expect(JSON.parse(await readFile(deps.file, 'utf8'))).toMatchObject({
        queue: [{ payload: { personalCatalogId: later.personalCatalogId } }],
      });
      send.mockResolvedValueOnce({
        catalogGeneration: 1,
        registrations: [
          { personalCatalogId: later.personalCatalogId, revision: 1 },
        ],
      });
      await restarted.flush();
      expect(send).toHaveBeenCalledTimes(2);
      expect(send.mock.calls[1]?.[0]).toMatchObject({
        registrations: [{ personalCatalogId: later.personalCatalogId }],
      });
      restarted.dispose();
    },
  );
  it.each(['payload change', 'disable/re-enable'])(
    'clears a rejected fingerprint after %s',
    async (change): Promise<void> => {
      const service = new PersonalCatalogSyncService(deps);
      await service.enqueue([payload]);
      send.mockRejectedValueOnce(
        new CanopyCloudClientError(
          'http-error',
          'Permanent conflict',
          409,
          'not_restorable',
        ),
      );
      await service.flush();
      expect(JSON.parse(await readFile(deps.file, 'utf8'))).toMatchObject({
        rejected: {
          [payload.personalCatalogId]: createHash('sha256')
            .update(JSON.stringify(payload))
            .digest('hex'),
        },
        queue: [],
      });
      const next =
        change === 'payload change' ? { ...payload, name: 'Changed' } : payload;
      let active = service;
      if (change === 'disable/re-enable') {
        await service.disable();
        await markPersonalCatalogRestore(deps.file, deps.accountId, 0);
        active = new PersonalCatalogSyncService(deps);
      }
      await active.enqueue([next]);
      expect(JSON.parse(await readFile(deps.file, 'utf8'))).toMatchObject({
        rejected: {},
        queue: [{ payload: next }],
      });
      await active.flush();
      expect(send).toHaveBeenCalledTimes(2);
      expect(send.mock.calls[1]?.[0]).toMatchObject({ registrations: [next] });
      active.dispose();
    },
  );
  it.each([1, 2])(
    'binds restore intent to observed generation (current=%s)',
    async (current): Promise<void> => {
      await writeFile(
        `${deps.file}.restore.json`,
        JSON.stringify({
          version: 2,
          accountId: deps.accountId,
          catalogGeneration: 1,
        }),
      );
      deps.generation = (): ReturnType<
        PersonalCatalogSyncDependencies['generation']
      > =>
        Promise.resolve({
          catalogGeneration: current,
          revisions: { [payload.personalCatalogId]: 2 },
        });
      const service = new PersonalCatalogSyncService(deps);
      await service.enqueue([payload]);
      await service.flush();
      const expected: unknown =
        current === 1
          ? expect.objectContaining({ restorePersonalCatalog: true })
          : expect.not.objectContaining({ restorePersonalCatalog: true });
      expect(send.mock.calls[0]?.[0]).toMatchObject({
        registrations: [expected],
      });
      if (current !== 1)
        await expect(
          readFile(`${deps.file}.restore.json`),
        ).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );
  it('invalidates restore intent when the initial generation cannot be read', async (): Promise<void> => {
    await writeFile(
      `${deps.file}.restore.json`,
      JSON.stringify({
        version: 2,
        accountId: deps.accountId,
        catalogGeneration: 1,
      }),
    );
    deps.generation = (): ReturnType<
      PersonalCatalogSyncDependencies['generation']
    > => {
      return Promise.reject(new Error('offline'));
    };
    await expect(
      new PersonalCatalogSyncService(deps).enqueue([payload]),
    ).rejects.toThrow('offline');
    await expect(readFile(`${deps.file}.restore.json`)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
  it('invalidates legacy account-only restore markers', async (): Promise<void> => {
    await writeFile(
      `${deps.file}.restore.json`,
      JSON.stringify({ version: 1, accountId: deps.accountId }),
    );
    deps.generation = (): ReturnType<
      PersonalCatalogSyncDependencies['generation']
    > =>
      Promise.resolve({
        catalogGeneration: 1,
        revisions: { [payload.personalCatalogId]: 2 },
      });
    const service = new PersonalCatalogSyncService(deps);
    await service.enqueue([payload]);
    await expect(readFile(`${deps.file}.restore.json`)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await service.flush();
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      registrations: [
        expect.not.objectContaining({ restorePersonalCatalog: true }),
      ],
    });
  });
  it('bounds maximum-shape registration batches by UTF-8 bytes', async (): Promise<void> => {
    const rows = Array.from(
      { length: 20 },
      (_, index): PersonalCatalogPayload => ({
        ...payload,
        personalCatalogId: `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`,
        name: '\u0001'.repeat(256),
        kind: 'COWORK',
        localWorkspaceId: 'w'.repeat(128),
        installationGeneration: 2147483646,
        repositories: Array.from({ length: 100 }, () => ({
          host: 'h'.repeat(255),
          ownerLogin: 'o'.repeat(255),
          repoName: 'r'.repeat(255),
        })),
      }),
    );
    await writeFile(
      `${deps.file}.restore.json`,
      JSON.stringify({
        version: 2,
        accountId: deps.accountId,
        catalogGeneration: 2147483646,
      }),
    );
    deps.generation = (): ReturnType<
      PersonalCatalogSyncDependencies['generation']
    > =>
      Promise.resolve({
        catalogGeneration: 2147483646,
        revisions: Object.fromEntries(
          rows.map((row) => [row.personalCatalogId, 2147483646]),
        ),
      });
    send.mockImplementation((body): Promise<unknown> => {
      expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThanOrEqual(
        256 * 1024,
      );
      if (!isRecord(body) || !Array.isArray(body.registrations))
        throw new Error('Invalid batch');
      return Promise.resolve({
        catalogGeneration: 2147483646,
        registrations: body.registrations.map((row: unknown) => {
          if (!isRecord(row)) throw new Error('Invalid registration');
          return {
            personalCatalogId: row.personalCatalogId,
            revision: 2147483646,
          };
        }),
      });
    });
    const service = new PersonalCatalogSyncService(deps);
    await service.enqueue(rows);
    await service.flush();
    expect(await readFile(`${deps.file}.restore.json`, 'utf8')).toContain(
      deps.accountId,
    );
    for (let index = 0; index < 6; index += 1) await service.flush();
    await expect(readFile(`${deps.file}.restore.json`)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    for (const [body] of send.mock.calls)
      expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThanOrEqual(
        256 * 1024,
      );
    expect(send).toHaveBeenCalledTimes(7);
    expect(JSON.parse(await readFile(deps.file, 'utf8'))).toMatchObject({
      queue: [],
    });
  });
  it('aborts a pending generation read when disposed', async (): Promise<void> => {
    let observed: AbortSignal | undefined;
    let started: (() => void) | undefined;
    let finish: (() => void) | undefined;
    const pending = new Promise<void>((resolve): void => {
      started = resolve;
    });
    const done = new Promise<void>((resolve): void => {
      finish = resolve;
    });
    const generation = jest.fn(
      async (
        signal?: AbortSignal,
      ): ReturnType<PersonalCatalogSyncDependencies['generation']> => {
        observed = signal;
        started?.();
        await done;
        return { catalogGeneration: 0, revisions: {} };
      },
    );
    const service = new PersonalCatalogSyncService({ ...deps, generation });
    const work = service.enqueue([payload]);
    await pending;
    service.dispose();
    finish?.();
    await work;
    expect(observed?.aborted).toBe(true);
  });
  it('skips one malformed workspace and enqueues the remaining rows', async (): Promise<void> => {
    jest.mocked(logMainProcessError).mockClear();
    const service = new PersonalCatalogSyncService(deps);
    await expect(
      service.enqueue([
        { ...payload, personalCatalogId: '-'.repeat(36) },
        payload,
      ]),
    ).resolves.toBeUndefined();
    await service.flush();
    expect(send).toHaveBeenCalledTimes(1);
    expect(logMainProcessError).toHaveBeenCalledTimes(1);
  });
  it.each(['missing', 'corrupt'])(
    'does not restore removed rows when the outbox is %s without enrollment intent',
    async (state): Promise<void> => {
      if (state === 'corrupt') await writeFile(deps.file, 'broken');
      deps.generation = (): ReturnType<
        PersonalCatalogSyncDependencies['generation']
      > =>
        Promise.resolve({
          catalogGeneration: 1,
          revisions: { [payload.personalCatalogId]: 2 },
        });
      const service = new PersonalCatalogSyncService(deps);
      await service.enqueue([payload]);
      await service.flush();
      expect(send.mock.calls[0]?.[0]).toMatchObject({
        registrations: [
          expect.not.objectContaining({ restorePersonalCatalog: true }),
        ],
      });
    },
  );
  it('consumes first-time enrollment intent after acceptance before a later recovery', async (): Promise<void> => {
    await writeFile(
      `${deps.file}.restore.json`,
      JSON.stringify({
        version: 2,
        accountId: deps.accountId,
        catalogGeneration: 0,
      }),
    );
    const service = new PersonalCatalogSyncService(deps);
    await service.enqueue([payload]);
    await service.flush();
    await expect(readFile(`${deps.file}.restore.json`)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
  it('snapshots the exact wire shape and drops queued traffic on disable', async (): Promise<void> => {
    const service = new PersonalCatalogSyncService(deps);
    await service.enqueue([payload]);
    await service.flush();
    expect(send.mock.calls[0]?.[0]).toMatchSnapshot();
    await service.enqueue([{ ...payload, name: 'Changed' }]);
    await service.disable();
    await service.flush();
    expect(send).toHaveBeenCalledTimes(1);
    await expect(readFile(deps.file)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it.each([
    ['malformed JSON', 'not json'],
    [
      'a foreign account',
      JSON.stringify({
        version: 1,
        accountId: 'owner-b',
        catalogGeneration: 0,
        revisions: {},
        accepted: {},
        queue: [],
      }),
    ],
    ['an unsupported version', JSON.stringify({ version: 2 })],
    ['an oversized file', `{"pad":"${'x'.repeat(2 * 1024 * 1024)}"}`],
  ])(
    'recovers from %s by resetting the outbox and preserving the file',
    async (_label, contents): Promise<void> => {
      await writeFile(deps.file, contents);
      const service = new PersonalCatalogSyncService(deps);
      await service.enqueue([payload]);
      await service.flush();
      expect(send).toHaveBeenCalledTimes(1);
      const preserved = (await readdir(directory)).filter((name) =>
        name.startsWith('outbox.json.corrupt-'),
      );
      expect(preserved).toHaveLength(1);
      expect(await readFile(join(directory, preserved[0]), 'utf8')).toBe(
        contents,
      );
      const reset: unknown = JSON.parse(await readFile(deps.file, 'utf8'));
      expect(reset).toMatchObject({ accountId: 'owner-a', queue: [] });
    },
  );
  it('still surfaces I/O errors other than a missing outbox', async (): Promise<void> => {
    await mkdir(deps.file);
    const service = new PersonalCatalogSyncService(deps);
    await expect(service.enqueue([payload])).rejects.toMatchObject({
      code: 'EISDIR',
    });
    expect(send).not.toHaveBeenCalled();
  });
  it('keeps queuedAt for an unchanged registration, expires it once, and re-queues only a change', async (): Promise<void> => {
    const start = Date.parse('2026-09-24T00:00:00Z');
    const eightDays = 8 * 24 * 60 * 60 * 1000;
    const now = jest.spyOn(Date, 'now').mockReturnValue(start);
    try {
      const service = new PersonalCatalogSyncService(deps);
      await service.enqueue([payload]);
      now.mockReturnValue(start + 60_000);
      await service.enqueue([payload]);
      const read = async (): Promise<unknown> => {
        const parsed: unknown = JSON.parse(await readFile(deps.file, 'utf8'));
        return parsed;
      };
      expect(await read()).toMatchObject({
        queue: [{ queuedAt: start }],
      });
      now.mockReturnValue(start + eightDays);
      await service.enqueue([payload]);
      await service.flush();
      expect(send).not.toHaveBeenCalled();
      const expired = await read();
      expect(expired).toMatchObject({ queue: [] });
      expect(
        isRecord(expired) &&
          isRecord(expired.expired) &&
          typeof expired.expired[payload.personalCatalogId] === 'string',
      ).toBe(true);
      await service.enqueue([{ ...payload, name: 'Changed' }]);
      expect(await read()).toMatchObject({
        queue: [{ queuedAt: start + eightDays, payload: { name: 'Changed' } }],
        expired: {},
      });
    } finally {
      now.mockRestore();
    }
  });
  it.each(['personal_catalog_device_collision', 'conflict'])(
    'refreshes accepted project revisions outside the queue after %s',
    async (serverCode): Promise<void> => {
      const other = {
        ...payload,
        personalCatalogId: '33333333-3333-4333-8333-333333333333',
        localWorkspaceId: 'project-2',
      };
      const generation = jest.fn().mockResolvedValue({
        catalogGeneration: 1,
        revisions: { [other.personalCatalogId]: 2 },
      });
      const service = new PersonalCatalogSyncService({ ...deps, generation });
      send.mockResolvedValueOnce({
        catalogGeneration: 1,
        registrations: [
          { personalCatalogId: payload.personalCatalogId, revision: 1 },
        ],
      });
      await service.enqueue([payload]);
      await service.flush();
      await writeFile(
        `${deps.file}.restore.json`,
        JSON.stringify({
          version: 2,
          accountId: deps.accountId,
          catalogGeneration: 1,
        }),
      );
      await service.enqueue([other]);
      generation.mockResolvedValue({
        catalogGeneration: 1,
        revisions: {
          [payload.personalCatalogId]: 7,
          [other.personalCatalogId]: 3,
        },
      });
      send.mockRejectedValueOnce(
        new CanopyCloudClientError('http-error', 'Changed', 409, serverCode),
      );
      await service.flush();
      const now = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 600_000);
      try {
        send.mockResolvedValueOnce({
          catalogGeneration: 1,
          registrations: [
            { personalCatalogId: other.personalCatalogId, revision: 4 },
          ],
        });
        await service.flush();
        service.dispose();
        const restarted = new PersonalCatalogSyncService({
          ...deps,
          generation,
        });
        await restarted.enqueue([{ ...payload, name: 'Renamed' }]);
        send.mockImplementationOnce((body): Promise<unknown> => {
          if (
            !isRecord(body) ||
            !Array.isArray(body.registrations) ||
            !isRecord(body.registrations[0]) ||
            body.registrations[0].revision !== 7
          ) {
            throw new CanopyCloudClientError(
              'http-error',
              'Stale revision',
              409,
              'conflict',
            );
          }
          return Promise.resolve({
            catalogGeneration: 1,
            registrations: [
              { personalCatalogId: payload.personalCatalogId, revision: 8 },
            ],
          });
        });
        await restarted.flush();
        expect(send.mock.calls[3]?.[0]).toMatchObject({
          registrations: [{ revision: 7 }],
        });
        expect(JSON.parse(await readFile(deps.file, 'utf8'))).toMatchObject({
          queue: [],
          revisions: { [payload.personalCatalogId]: 8 },
        });
        restarted.dispose();
      } finally {
        now.mockRestore();
      }
    },
  );
  it('bumps the installation on a typed backup collision', async (): Promise<void> => {
    send.mockRejectedValue(
      new CanopyCloudClientError(
        'http-error',
        'Collision',
        409,
        'personal_catalog_device_collision',
      ),
    );
    const service = new PersonalCatalogSyncService(deps);
    await service.enqueue([payload]);
    await service.flush();
    expect(notice).toHaveBeenCalledWith('collision');
    const state: unknown = JSON.parse(await readFile(deps.file, 'utf8'));
    expect(state).toMatchObject({
      queue: [{ payload: { installationGeneration: 1 } }],
    });
  });
  it('persists the removed fence when the outbox directory disappears', async (): Promise<void> => {
    const service = new PersonalCatalogSyncService(deps);
    await service.enqueue([payload]);
    await rm(directory, { recursive: true, force: true });
    send.mockRejectedValueOnce(
      new CanopyCloudClientError(
        'http-error',
        'Removed',
        409,
        'personal_catalog_removed',
      ),
    );
    await expect(service.flush()).resolves.toBeUndefined();
    const state: unknown = JSON.parse(await readFile(deps.file, 'utf8'));
    expect(state).toMatchObject({ catalogGeneration: 0, queue: [] });
    expect(notice).toHaveBeenCalledWith('removed');
  });
  it('does not refresh the removal fence after restart or resurrect a removed list', async (): Promise<void> => {
    const first = new PersonalCatalogSyncService(deps);
    await first.enqueue([payload]);
    first.dispose();
    const generation = jest.fn(
      (): ReturnType<PersonalCatalogSyncDependencies['generation']> =>
        Promise.resolve({ catalogGeneration: 1, revisions: {} }),
    );
    send.mockRejectedValue(
      new CanopyCloudClientError(
        'http-error',
        'Removed',
        409,
        'personal_catalog_removed',
      ),
    );
    const second = new PersonalCatalogSyncService({ ...deps, generation });
    await second.flush();
    await second.enqueue([payload]);
    await second.flush();
    expect(generation).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
    expect(notice).toHaveBeenCalledWith('removed');
  });
  it('restores after remove, disable, and re-enable and refreshes a conflicting revision', async (): Promise<void> => {
    const first = new PersonalCatalogSyncService(deps);
    await first.enqueue([payload]);
    send.mockRejectedValueOnce(
      new CanopyCloudClientError(
        'http-error',
        'Removed',
        409,
        'personal_catalog_removed',
      ),
    );
    await first.flush();
    await first.disable();
    const generation = jest.fn().mockResolvedValue({
      catalogGeneration: 1,
      revisions: { [payload.personalCatalogId]: 2 },
    });
    await writeFile(
      `${deps.file}.restore.json`,
      JSON.stringify({
        version: 2,
        accountId: deps.accountId,
        catalogGeneration: 1,
      }),
    );
    const second = new PersonalCatalogSyncService({ ...deps, generation });
    await second.enqueue([payload]);
    send.mockRejectedValueOnce(
      new CanopyCloudClientError('http-error', 'Changed', 409, 'conflict'),
    );
    generation.mockResolvedValue({
      catalogGeneration: 1,
      revisions: { [payload.personalCatalogId]: 3 },
    });
    await second.flush();
    expect(send.mock.calls[1]?.[0]).toMatchObject({
      catalogGeneration: 1,
      registrations: [{ revision: 2, restorePersonalCatalog: true }],
    });
    const now = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 600_000);
    try {
      send.mockResolvedValue({
        catalogGeneration: 1,
        registrations: [
          { personalCatalogId: payload.personalCatalogId, revision: 4 },
        ],
      });
      await second.flush();
      expect(send.mock.calls[2]?.[0]).toMatchObject({
        registrations: [{ revision: 3, restorePersonalCatalog: true }],
      });
      await expect(readFile(`${deps.file}.restore.json`)).rejects.toMatchObject(
        { code: 'ENOENT' },
      );
      expect(notice).not.toHaveBeenCalledWith('failed');
      expect(JSON.parse(await readFile(deps.file, 'utf8'))).toMatchObject({
        queue: [],
        revisions: { [payload.personalCatalogId]: 4 },
      });
    } finally {
      now.mockRestore();
    }
  });

  it('retains the exact queue when a middle replacement would exceed the byte bound', async (): Promise<void> => {
    const queue = [1, 2, 3].map((id) => ({
      payload: {
        ...payload,
        personalCatalogId: `11111111-1111-4111-8111-${String(id).padStart(12, '0')}`,
      },
      revision: 0,
      queuedAt: Date.now(),
    }));
    const state = {
      version: 1,
      accountId: deps.accountId,
      catalogGeneration: 0,
      revisions: {},
      accepted: {},
      queue,
    };
    const accepted: Record<string, string> = {};
    state.accepted = accepted;
    // Fill valid acknowledged hashes up to just below the on-disk bound.
    for (let i = 0; i < 28000; i += 1) accepted[String(i)] = 'x'.repeat(64);
    while (Buffer.byteLength(JSON.stringify(state)) > 2 * 1024 * 1024 - 1000)
      delete accepted[String(Object.keys(accepted).length - 1)];
    const before = JSON.stringify(state);
    await writeFile(deps.file, before);
    const service = new PersonalCatalogSyncService(deps);
    const replacement = {
      ...queue[1].payload,
      repositories: Array.from({ length: 100 }, () => ({
        host: 'h'.repeat(255),
        ownerLogin: 'o'.repeat(255),
        repoName: 'r'.repeat(255),
      })),
    };
    await expect(service.enqueue([replacement])).resolves.toBeUndefined();
    const after = await readFile(deps.file, 'utf8');
    const saved: unknown = JSON.parse(after);
    expect(saved).toMatchObject({ queue });
    expect(Buffer.byteLength(after)).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(notice).toHaveBeenCalledWith('full');
  });
  it.each([
    'collision',
    'advancing restore conflict',
    'stale restore conflict',
  ])(
    'keeps a near-capacity outbox bounded and draining after a %s recovery',
    async (recovery): Promise<void> => {
      const repositories = Array.from({ length: 100 }, () => ({
        host: 'h'.repeat(255),
        ownerLogin: 'o'.repeat(255),
        repoName: 'r'.repeat(255),
      }));
      const queue = Array.from({ length: 10 }, (_, id) => ({
        payload: {
          ...payload,
          personalCatalogId: `11111111-1111-4111-8111-${String(id).padStart(12, '0')}`,
          repositories,
        },
        revision: 1,
        queuedAt: Date.now(),
        restorePersonalCatalog: true,
      }));
      const accepted: Record<string, string> = {};
      const state = {
        version: 1,
        accountId: deps.accountId,
        catalogGeneration: 1,
        revisions: Object.fromEntries(
          queue.map((entry) => [entry.payload.personalCatalogId, 1]),
        ),
        accepted,
        queue,
      };
      // Admitted just below the on-disk bound, as enqueue allows.
      let size = Buffer.byteLength(JSON.stringify(state));
      for (let i = 0; ; i += 1) {
        const row = Buffer.byteLength(`"${i}":"${'x'.repeat(64)}",`);
        if (size + row > 2 * 1024 * 1024 - 1000) break;
        accepted[String(i)] = 'x'.repeat(64);
        size += row;
      }
      await writeFile(deps.file, JSON.stringify(state));
      await markPersonalCatalogRestore(deps.file, deps.accountId, 1);
      // The server reports revisions for many more catalog rows than are queued.
      const revisions: Record<string, number> = {};
      for (let i = 0; i < 400; i += 1)
        revisions[`55555555-5555-4555-8555-${String(i).padStart(12, '0')}`] = 1;
      if (recovery === 'advancing restore conflict')
        revisions[queue[0].payload.personalCatalogId] = 2;
      deps.generation = (): ReturnType<
        PersonalCatalogSyncDependencies['generation']
      > => Promise.resolve({ catalogGeneration: 1, revisions });
      send.mockRejectedValueOnce(
        recovery === 'collision'
          ? new CanopyCloudClientError(
              'http-error',
              'Collision',
              409,
              'personal_catalog_device_collision',
            )
          : new CanopyCloudClientError(
              'http-error',
              'Changed',
              409,
              'conflict',
            ),
      );
      const service = new PersonalCatalogSyncService(deps);
      await expect(service.flush()).resolves.toBeUndefined();
      const recovered = await readFile(deps.file, 'utf8');
      expect(Buffer.byteLength(recovered)).toBeLessThanOrEqual(2 * 1024 * 1024);
      expect(JSON.parse(recovered)).toMatchObject({ revisions });
      const now = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 600_000);
      try {
        await expect(service.enqueue([payload])).resolves.toBeUndefined();
        send.mockImplementation((body): Promise<unknown> => {
          const registrations =
            isRecord(body) && Array.isArray(body.registrations)
              ? body.registrations
              : [];
          return Promise.resolve({
            catalogGeneration: 1,
            registrations: registrations.map((row: unknown) => ({
              personalCatalogId:
                isRecord(row) && typeof row.personalCatalogId === 'string'
                  ? row.personalCatalogId
                  : '',
              revision: 3,
            })),
          });
        });
        await service.flush();
        expect(send).toHaveBeenCalledTimes(2);
        const drained = await readFile(deps.file, 'utf8');
        expect(Buffer.byteLength(drained)).toBeLessThan(
          Buffer.byteLength(recovered),
        );
      } finally {
        now.mockRestore();
        service.dispose();
      }
    },
  );
  it('honors Retry-After and never drains for a disallowed account', async (): Promise<void> => {
    send.mockRejectedValue(
      new CanopyCloudClientError(
        'http-error',
        'Limited',
        429,
        undefined,
        undefined,
        true,
        60_000,
      ),
    );
    const service = new PersonalCatalogSyncService(deps);
    await service.enqueue([payload]);
    await service.flush();
    await service.flush();
    expect(send).toHaveBeenCalledTimes(1);
    const other = new PersonalCatalogSyncService({
      ...deps,
      allowed: (): Promise<boolean> => Promise.resolve(false),
    });
    await other.flush();
    expect(send).toHaveBeenCalledTimes(1);
  });
});

it('refreshes CAS revisions after a backup collision without adopting a new removal fence', async (): Promise<void> => {
  const directory = await mkdtemp(join(tmpdir(), 'can-2963-collision-'));
  let generationReads = 0;
  const deps: PersonalCatalogSyncDependencies = {
    file: join(directory, 'queue.json'),
    accountId: 'a',
    allowed: (): Promise<boolean> => Promise.resolve(true),
    send: (): Promise<unknown> =>
      Promise.reject(
        new CanopyCloudClientError(
          'http-error',
          'Collision',
          409,
          'personal_catalog_device_collision',
        ),
      ),
    generation: (): ReturnType<PersonalCatalogSyncDependencies['generation']> =>
      Promise.resolve({
        catalogGeneration: 0,
        revisions:
          ++generationReads === 1 ? {} : { [payload.personalCatalogId]: 5 },
      }),
    bumpInstallation: (): Promise<number> => Promise.resolve(1),
    notice: (): void => {},
  };
  try {
    const service = new PersonalCatalogSyncService(deps);
    await service.enqueue([payload]);
    await service.flush();
    await service.enqueue([{ ...payload, installationGeneration: 1 }]);
    const state: unknown = JSON.parse(await readFile(deps.file, 'utf8'));
    expect(state).toMatchObject({
      catalogGeneration: 0,
      queue: [{ revision: 5, payload: { installationGeneration: 1 } }],
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

jest.mock('../feature-flags', () => {
  const service = { isEnabled: jest.fn() };
  return { getFeatureFlagService: (): typeof service => service };
});
jest.mock('../lib/canopy-cloud-account-store', () => ({
  getCanopyCloudCredentials: jest.fn(),
  subscribeCanopyCloudAccountChanges: jest.fn(),
}));
jest.mock('../lib/preferences-store', () => ({
  readPreferencesFile: jest.fn(),
  readPreferencesFileDetailed: jest.fn(),
  updatePreferencesFile: jest.fn(),
  projectPreferencesForRuntime: (value: unknown): unknown => value,
}));
jest.mock('../lib/paths', () => ({
  getDataDir: jest.fn(),
  getWorkspaceConfigPath: jest.fn(),
}));
jest.mock('../lib/sidebar-items', () => ({ readAllSidebarItems: jest.fn() }));
jest.mock('../lib/installation-generation', () => ({
  readInstallationGeneration: jest.fn().mockResolvedValue(0),
  bumpInstallationGeneration: jest.fn(),
}));
jest.mock('../portal/portal-state-store', () => ({
  readPortalStateStore: jest.fn().mockResolvedValue({
    clientDeviceId: '22222222-2222-4222-8222-222222222222',
  }),
}));
jest.mock('../lib/git', () => ({
  getRemoteUrlStrict: jest.fn().mockResolvedValue(null),
}));

import { mkdir, writeFile } from 'node:fs/promises';
import { getFeatureFlagService } from '../feature-flags';
import {
  getCanopyCloudCredentials,
  subscribeCanopyCloudAccountChanges,
} from '../lib/canopy-cloud-account-store';
import { settleDetachedWork } from '@canopy/desktop-shared/node/lib/detached-work';
import {
  updatePreferencesFile,
  readPreferencesFile,
  readPreferencesFileDetailed,
} from '../lib/preferences-store';
import { getDataDir, getWorkspaceConfigPath } from '../lib/paths';
import { readAllSidebarItems } from '../lib/sidebar-items';
import {
  readWorkspaceConfig,
  writeWorkspaceConfig,
} from '../lib/workspace-persistence';
import {
  personalCatalogSyncHostTestExports,
  startPersonalCatalogSync,
  stopPersonalCatalogSync,
  refreshPersonalCatalogSync,
  personalCatalogPreferenceChanged,
} from '../services/personal-catalog-sync-host';

describe('Personal catalog workspace enrollment', (): void => {
  let directory: string;
  const config = { version: 1, type: 'cowork', repos: [] } as const;
  const enqueue = jest.spyOn(PersonalCatalogSyncService.prototype, 'enqueue');
  const originalEnqueue = enqueue.getMockImplementation();
  const flush = jest.spyOn(PersonalCatalogSyncService.prototype, 'flush');
  const originalFlush = flush.getMockImplementation();

  beforeEach(async (): Promise<void> => {
    directory = await mkdtemp(join(tmpdir(), 'can-2963-enrollment-'));
    jest.mocked(getDataDir).mockReturnValue(directory);
    jest
      .mocked(getWorkspaceConfigPath)
      .mockImplementation((id): string =>
        join(directory, id, 'workspace.json'),
      );
    jest.spyOn(getFeatureFlagService(), 'isEnabled').mockReturnValue(true);
    jest.mocked(readPreferencesFile).mockResolvedValue({
      version: 1,
      personalWorkspaceCatalogSync: 'private',
    });
    jest.mocked(readPreferencesFileDetailed).mockImplementation(
      async (): ReturnType<typeof readPreferencesFileDetailed> => ({
        preferences: await readPreferencesFile(),
        authority: 'ok',
      }),
    );
    jest.mocked(getCanopyCloudCredentials).mockResolvedValue({
      baseUrl: 'https://example.test',
      apiKey: 'test-key',
      account: {
        id: 'owner-a',
        email: 'owner@example.test',
        name: 'Owner',
        role: 'DEVELOPER',
      },
      capabilities: ['org-projects-v1'],
    });
    jest.mocked(readAllSidebarItems).mockResolvedValue({
      version: 1,
      items: [
        {
          id: 'personal',
          name: 'Example',
          type: 'cowork',
          color: 'blue',
          collapsed: false,
          order: 0,
        },
      ],
    });
    enqueue.mockReset().mockImplementation(async (payloads): Promise<void> => {
      const persisted = await readWorkspaceConfig('personal');
      expect(persisted.personalCatalogId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(payloads[0]?.personalCatalogId).toBe(persisted.personalCatalogId);
    });
    flush.mockReset().mockResolvedValue(undefined);
    await mkdir(join(directory, 'personal'));
    await writeFile(getWorkspaceConfigPath('personal'), JSON.stringify(config));
  });
  afterEach(async (): Promise<void> => {
    stopPersonalCatalogSync();
    await rm(directory, { recursive: true, force: true });
  });

  it('limits eligible Personal workspaces instead of sidebar entries', async (): Promise<void> => {
    const { items } = await readAllSidebarItems();
    const item = items[0];
    if (!item) throw new Error('Missing sidebar fixture');
    const skipped = Array.from({ length: 1000 }, (_, index) => ({
      ...item,
      id: `temporary-${index}`,
    }));
    const eligible = Array.from({ length: 1001 }, (_, index) => ({
      ...item,
      id: `personal-${index}`,
    }));
    jest.mocked(readAllSidebarItems).mockResolvedValue({
      version: 1,
      items: [...skipped, ...eligible],
    });
    const read = jest.spyOn(
      workspacePersistence,
      'readWorkspaceConfigDetailed',
    );
    read.mockImplementation(
      (
        id,
      ): ReturnType<typeof workspacePersistence.readWorkspaceConfigDetailed> =>
        Promise.resolve({
          authority: 'ok',
          ownerMalformed: false,
          config: {
            ...config,
            temporary: id.startsWith('temporary-'),
            personalCatalogId: payload.personalCatalogId,
          },
        }),
    );
    enqueue.mockResolvedValue(undefined);
    try {
      await personalCatalogSyncHostTestExports.sync();
      expect(enqueue).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ localWorkspaceId: 'personal-999' }),
        ]),
      );
      expect(enqueue.mock.calls[0]?.[0]).toHaveLength(1000);
      expect(read).toHaveBeenCalledTimes(2000);
      expect(read).not.toHaveBeenCalledWith('personal-1000');
    } finally {
      read.mockRestore();
    }
  });

  it.each(['resolve', 'reject', 'stop'])(
    'coalesces active refresh requests after %s, unless stopped',
    async (outcome): Promise<void> => {
      let release: (() => void) | undefined;
      const blocked = new Promise<void>((resolve): void => {
        release = resolve;
      });
      const detail = jest.mocked(readPreferencesFileDetailed);
      detail.mockClear();
      detail.mockImplementationOnce(
        async (): ReturnType<typeof readPreferencesFileDetailed> => {
          await blocked;
          if (outcome === 'reject') throw new Error('Read failed');
          return { authority: 'unreadable', preferences: { version: 1 } };
        },
      );
      detail.mockResolvedValue({
        authority: 'unreadable',
        preferences: { version: 1 },
      });
      void refreshPersonalCatalogSync();
      void refreshPersonalCatalogSync();
      void refreshPersonalCatalogSync();
      expect(detail).toHaveBeenCalledTimes(1);
      if (outcome === 'stop') stopPersonalCatalogSync();
      release?.();
      await new Promise<void>((resolve): void => {
        setImmediate(resolve);
      });
      expect(detail).toHaveBeenCalledTimes(outcome === 'stop' ? 1 : 2);
    },
  );

  describe('detached refresh tracking', (): void => {
    const unreadable = {
      authority: 'unreadable',
      preferences: { version: 1 },
    } satisfies Awaited<ReturnType<typeof readPreferencesFileDetailed>>;
    let onAccountChange: (() => void) | undefined;
    let onInterval: (() => void) | undefined;
    let setIntervalSpy: jest.SpyInstance | undefined;
    const releases: Array<() => void> = [];

    beforeEach((): void => {
      onAccountChange = undefined;
      onInterval = undefined;
      jest
        .mocked(subscribeCanopyCloudAccountChanges)
        .mockImplementation((listener): (() => void) => {
          onAccountChange = (): void => {
            listener(null);
          };
          return (): void => {};
        });
      setIntervalSpy = jest
        .spyOn(global, 'setInterval')
        .mockImplementation((callback): NodeJS.Timeout => {
          onInterval = (): void => {
            callback();
          };
          const handle = setTimeout((): void => {}, 0);
          clearTimeout(handle);
          return handle;
        });
      jest.mocked(readPreferencesFileDetailed).mockResolvedValue(unreadable);
    });
    afterEach(async (): Promise<void> => {
      // A failed hold assertion must not leave the module's sync running.
      for (const release of releases.splice(0)) release();
      await settleDetachedWork();
      setIntervalSpy?.mockRestore();
    });

    function holdNextSync(): () => void {
      let release: (() => void) | undefined;
      const blocked = new Promise<void>((resolve): void => {
        release = resolve;
      });
      jest
        .mocked(readPreferencesFileDetailed)
        .mockImplementationOnce(
          async (): ReturnType<typeof readPreferencesFileDetailed> => {
            await blocked;
            return unreadable;
          },
        );
      const releaseHeld = (): void => release?.();
      releases.push(releaseHeld);
      return releaseHeld;
    }

    async function drain(): Promise<void> {
      for (let turn = 0; turn < 5; turn += 1)
        await new Promise<void>((resolve): void => {
          setImmediate(resolve);
        });
    }

    it.each(['startup', 'account change', 'interval'])(
      'tracks the %s refresh until its sync settles',
      async (trigger): Promise<void> => {
        const detail = jest.mocked(readPreferencesFileDetailed);
        let release = holdNextSync();
        startPersonalCatalogSync();
        if (trigger !== 'startup') {
          release();
          await settleDetachedWork();
          release = holdNextSync();
          if (trigger === 'account change') onAccountChange?.();
          else onInterval?.();
        }
        const callsWhileHeld = detail.mock.calls.length;
        let settled = false;
        const settling = settleDetachedWork().then((): void => {
          settled = true;
        });
        await drain();
        expect(settled).toBe(false);
        release();
        await settling;
        expect(settled).toBe(true);
        expect(detail).toHaveBeenCalledTimes(callsWhileHeld);
        expect(await detail.mock.results.at(-1)?.value).toBe(unreadable);
      },
    );

    it('tracks a refresh requested while a sync runs until its rerun settles', async (): Promise<void> => {
      const detail = jest.mocked(readPreferencesFileDetailed);
      detail.mockClear();
      const releaseFirst = holdNextSync();
      const releaseRerun = holdNextSync();
      startPersonalCatalogSync();
      void refreshPersonalCatalogSync();
      let settled = false;
      const settling = settleDetachedWork().then((): void => {
        settled = true;
      });
      releaseFirst();
      await drain();
      expect(detail).toHaveBeenCalledTimes(2);
      expect(settled).toBe(false);
      releaseRerun();
      await settling;
      expect(settled).toBe(true);
      expect(await detail.mock.results[1]?.value).toBe(unreadable);
    });
  });

  it('supersedes an enrollment follow-up blocked before a later disable', async (): Promise<void> => {
    let release: (() => void) | undefined;
    let entered: (() => void) | undefined;
    const started = new Promise<void>((resolve): void => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve): void => {
      release = resolve;
    });
    jest
      .mocked(readPreferencesFile)
      .mockImplementationOnce(
        async (): ReturnType<typeof readPreferencesFile> => {
          entered?.();
          await blocked;
          return { version: 1, personalWorkspaceCatalogSync: 'private' };
        },
      );
    const credentials = await getCanopyCloudCredentials();
    jest
      .mocked(getCanopyCloudCredentials)
      .mockResolvedValue({ ...credentials, account: null, capabilities: [] });
    jest.mocked(getCanopyCloudCredentials).mockClear();
    const first = personalCatalogPreferenceChanged();
    await started;
    jest
      .mocked(readPreferencesFile)
      .mockResolvedValue({ version: 1, personalWorkspaceCatalogSync: 'off' });
    const latest = personalCatalogPreferenceChanged();
    release?.();
    await Promise.all([first, latest]);
    await expect(
      readFile(
        join(directory, 'personal-catalog-outbox', 'restore-pending.json'),
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(getCanopyCloudCredentials).not.toHaveBeenCalled();
  });

  it.each(['unreadable', 'ok'] satisfies Array<'unreadable' | 'ok'>)(
    'preserves outboxes only when the off preference read is %s',
    async (authority): Promise<void> => {
      const outboxRoot = join(directory, 'personal-catalog-outbox');
      await mkdir(outboxRoot);
      const files = [
        'owner.json',
        'owner.json.restore.json',
        'restore-pending.json',
      ];
      for (const file of files) await writeFile(join(outboxRoot, file), file);
      const preferences = {
        version: 1,
        personalWorkspaceCatalogSync: 'off',
      } satisfies Awaited<ReturnType<typeof readPreferencesFile>>;
      jest.mocked(readPreferencesFile).mockResolvedValue(preferences);
      jest
        .mocked(readPreferencesFileDetailed)
        .mockResolvedValue({ preferences, authority });
      await personalCatalogSyncHostTestExports.sync();
      if (authority === 'unreadable') {
        for (const file of files)
          expect(await readFile(join(outboxRoot, file), 'utf8')).toBe(file);
      } else {
        await expect(readdir(outboxRoot)).rejects.toMatchObject({
          code: 'ENOENT',
        });
      }
      expect(enqueue).not.toHaveBeenCalled();
      expect(flush).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['workspace read', 'preference'],
    ['workspace read', 'epoch'],
    ['workspace read', 'flag'],
    ['serialized read', 'preference'],
    ['serialized read', 'epoch'],
    ['serialized read', 'flag'],
  ])(
    'does not mint after the %s invalidates enrollment via %s',
    async (stage, invalidation): Promise<void> => {
      const file = join(directory, 'personal', 'workspace.json');
      const before = await readFile(file, 'utf8');
      const invalidate = (): void => {
        if (invalidation === 'preference') {
          jest.mocked(readPreferencesFile).mockResolvedValue({
            version: 1,
            personalWorkspaceCatalogSync: 'off',
          });
        } else if (invalidation === 'epoch') {
          stopPersonalCatalogSync();
        } else {
          jest
            .spyOn(getFeatureFlagService(), 'isEnabled')
            .mockReturnValue(false);
        }
      };
      const read = workspacePersistence.readWorkspaceConfigDetailed;
      const spy = jest.spyOn(
        workspacePersistence,
        'readWorkspaceConfigDetailed',
      );
      if (stage === 'workspace read') {
        spy.mockImplementationOnce(async (id): ReturnType<typeof read> => {
          const detail = await read(id);
          invalidate();
          return detail;
        });
      } else {
        let reads = 0;
        jest.mocked(getWorkspaceConfigPath).mockImplementation((id): string => {
          reads += 1;
          if (reads === 2) invalidate();
          return join(directory, id, 'workspace.json');
        });
      }
      enqueue.mockResolvedValue(undefined);
      try {
        await personalCatalogSyncHostTestExports.sync();
        expect(await readFile(file, 'utf8')).toBe(before);
        expect(enqueue).not.toHaveBeenCalled();
        expect(flush).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    },
  );

  it('preserves a concurrent repo save during catalog ID minting', async (): Promise<void> => {
    const read = workspacePersistence.readWorkspaceConfigDetailed;
    const spy = jest
      .spyOn(workspacePersistence, 'readWorkspaceConfigDetailed')
      .mockImplementationOnce(async (id): ReturnType<typeof read> => {
        const stale = await read(id);
        await writeWorkspaceConfig(id, {
          version: 1,
          type: 'multi-repo',
          repos: [{ id: 'new', name: 'New', repoPath: '/new' }],
        });
        return stale;
      });
    try {
      await personalCatalogSyncHostTestExports.sync();
      const persisted = await readWorkspaceConfig('personal');
      expect(persisted.personalCatalogId).toEqual(expect.any(String));
      expect(persisted.repos).toMatchObject([{ id: 'new' }]);
    } finally {
      spy.mockRestore();
    }
  });
  it('broadcasts a persisted sync notice', async (): Promise<void> => {
    if (!originalEnqueue || !originalFlush)
      throw new Error('Missing service methods');
    enqueue.mockImplementation(originalEnqueue);
    flush.mockImplementation(originalFlush);
    const request = jest
      .spyOn(cloudClient, 'requestCanopyCloudJson')
      .mockImplementation((_route, options): Promise<unknown> => {
        if (options?.method === 'PUT')
          return Promise.reject(
            new CanopyCloudClientError(
              'http-error',
              'Removed',
              409,
              'personal_catalog_removed',
            ),
          );
        return Promise.resolve({ catalogGeneration: 0, revisions: {} });
      });
    jest
      .mocked(updatePreferencesFile)
      .mockResolvedValue({ personalCatalogNotice: 'removed' });
    try {
      await personalCatalogSyncHostTestExports.sync();
      expect(broadcastPreferencesSynced).toHaveBeenCalledWith(
        expect.objectContaining({ personalCatalogNotice: 'removed' }),
        expect.any(Function),
      );
    } finally {
      request.mockRestore();
    }
  });
  it('restores removed rows after enabling while signed out then signing in', async (): Promise<void> => {
    const credentials = await getCanopyCloudCredentials();
    const id = payload.personalCatalogId;
    await writeWorkspaceConfig('personal', {
      ...config,
      repos: [],
      personalCatalogId: id,
    });
    jest
      .mocked(getCanopyCloudCredentials)
      .mockResolvedValue({ ...credentials, account: null, capabilities: [] });
    await personalCatalogPreferenceChanged();
    await new Promise<void>((resolve): void => {
      setImmediate(resolve);
    });
    jest.mocked(getCanopyCloudCredentials).mockResolvedValue(credentials);
    if (!originalEnqueue || !originalFlush)
      throw new Error('Missing service methods');
    enqueue.mockImplementation(originalEnqueue);
    flush.mockImplementation(originalFlush);
    const request = jest
      .spyOn(cloudClient, 'requestCanopyCloudJson')
      .mockImplementation((_route, options): Promise<unknown> => {
        if (options?.method === 'PUT')
          return Promise.resolve({
            catalogGeneration: 1,
            registrations: [{ personalCatalogId: id, revision: 3 }],
          });
        return Promise.resolve({
          catalogGeneration: 1,
          revisions: { [id]: 2 },
        });
      });
    try {
      await personalCatalogSyncHostTestExports.sync();
      const put = request.mock.calls.find((call) => call[1]?.method === 'PUT');
      expect(JSON.parse(put?.[1]?.body ?? '{}')).toMatchObject({
        registrations: [{ restorePersonalCatalog: true }],
      });
    } finally {
      request.mockRestore();
    }
  });
  it('clears signed-out pending restore intent on disable', async (): Promise<void> => {
    const credentials = await getCanopyCloudCredentials();
    jest
      .mocked(getCanopyCloudCredentials)
      .mockResolvedValue({ ...credentials, account: null, capabilities: [] });
    await personalCatalogPreferenceChanged();
    const file = join(
      directory,
      'personal-catalog-outbox',
      'restore-pending.json',
    );
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      version: 1,
      pending: true,
    });
    jest
      .mocked(readPreferencesFile)
      .mockResolvedValue({ version: 1, personalWorkspaceCatalogSync: 'off' });
    await personalCatalogPreferenceChanged();
    await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' });
    await new Promise<void>((resolve): void => {
      setImmediate(resolve);
    });
  });
  it('does not hand signed-in enrollment restore intent to the next account', async (): Promise<void> => {
    let entered: (() => void) | undefined;
    let release: (() => void) | undefined;
    const started = new Promise<void>((resolve): void => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve): void => {
      release = resolve;
    });
    const pending = jest
      .spyOn(cloudClient, 'requestCanopyCloudJson')
      .mockImplementation(async (): Promise<unknown> => {
        entered?.();
        await gate;
        return { catalogGeneration: 1, revisions: {} };
      });
    const change = personalCatalogPreferenceChanged();
    await started;
    // An account change fences the in-flight generation read for owner-a.
    stopPersonalCatalogSync();
    release?.();
    await change;
    pending.mockRestore();
    jest.mocked(getCanopyCloudCredentials).mockResolvedValue({
      baseUrl: 'https://example.test',
      apiKey: 'test-key',
      account: {
        id: 'owner-b',
        email: 'other@example.test',
        name: 'Other',
        role: 'DEVELOPER',
      },
      capabilities: ['org-projects-v1'],
    });
    const request = jest
      .spyOn(cloudClient, 'requestCanopyCloudJson')
      .mockResolvedValue({ catalogGeneration: 1, revisions: {} });
    try {
      await personalCatalogSyncHostTestExports.sync();
    } finally {
      request.mockRestore();
    }
    const outbox = join(directory, 'personal-catalog-outbox');
    await expect(
      readFile(
        join(
          outbox,
          `${createHash('sha256').update('owner-b').digest('hex')}.json.restore.json`,
        ),
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      readFile(join(outbox, 'restore-pending.json')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('forwards cancellation to a pending host generation request', async (): Promise<void> => {
    let observed: AbortSignal | undefined;
    let entered: (() => void) | undefined;
    let finish: (() => void) | undefined;
    const started = new Promise<void>((resolve): void => {
      entered = resolve;
    });
    const done = new Promise<void>((resolve): void => {
      finish = resolve;
    });
    const request = jest
      .spyOn(cloudClient, 'requestCanopyCloudJson')
      .mockImplementation(async (_route, options): Promise<unknown> => {
        observed = options?.signal;
        entered?.();
        await done;
        return { catalogGeneration: 0, revisions: {} };
      });
    if (!originalEnqueue)
      throw new Error('Missing original enqueue implementation');
    enqueue.mockImplementation(originalEnqueue);
    try {
      const work = personalCatalogSyncHostTestExports.sync();
      await started;
      stopPersonalCatalogSync();
      finish?.();
      await work;
      expect(observed?.aborted).toBe(true);
    } finally {
      request.mockRestore();
    }
  });
  it('persists account-bound restore intent when sharing is explicitly enabled', async (): Promise<void> => {
    let published: (() => void) | undefined;
    const done = new Promise<void>((resolve): void => {
      published = resolve;
    });
    flush.mockImplementation((): Promise<void> => {
      published?.();
      return Promise.resolve();
    });
    const request = jest
      .spyOn(cloudClient, 'requestCanopyCloudJson')
      .mockResolvedValue({ catalogGeneration: 1, revisions: {} });
    await personalCatalogPreferenceChanged();
    await done;
    request.mockRestore();
    const file = join(
      directory,
      'personal-catalog-outbox',
      `${createHash('sha256').update('owner-a').digest('hex')}.json.restore.json`,
    );
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      version: 2,
      accountId: 'owner-a',
      catalogGeneration: 1,
    });
  });
  it('persists a UUID before first publish and reuses it on the next publish', async (): Promise<void> => {
    expect(
      (await readWorkspaceConfig('personal')).personalCatalogId,
    ).toBeUndefined();
    await personalCatalogSyncHostTestExports.sync();
    const id = (await readWorkspaceConfig('personal')).personalCatalogId;
    await personalCatalogSyncHostTestExports.sync();
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(flush).toHaveBeenCalledTimes(2);
    expect((await readWorkspaceConfig('personal')).personalCatalogId).toBe(id);
  });

  it.each([
    { flag: false, preference: 'private' as const },
    { flag: true, preference: 'off' as const },
  ])(
    'does not write an ID with flag=$flag and preference=$preference',
    async ({ flag, preference }): Promise<void> => {
      jest.spyOn(getFeatureFlagService(), 'isEnabled').mockReturnValue(flag);
      jest.mocked(readPreferencesFile).mockResolvedValue({
        version: 1,
        personalWorkspaceCatalogSync: preference,
      });
      await writeWorkspaceConfig('personal', { ...config, repos: [] });
      const before = await readFile(getWorkspaceConfigPath('personal'), 'utf8');
      expect(JSON.parse(before)).not.toHaveProperty('personalCatalogId');
      await personalCatalogSyncHostTestExports.sync();
      expect(await readFile(getWorkspaceConfigPath('personal'), 'utf8')).toBe(
        before,
      );
      expect(enqueue).not.toHaveBeenCalled();
      expect(flush).not.toHaveBeenCalled();
    },
  );
});

it.each([
  '/Users/alice/Client<Acquisition',
  '/Users/alice/Client>Acquisition',
  '/Users/alice/Client|Acquisition',
  '/Users/Jane Smith/Secret Project',
  "/Users/x/it's mine/repo",
  '/Users/x/a"quoted" name/repo',
  'C:\\Users\\Jane Smith\\Secret Project',
  'C:/Users/Jane Smith/Secret Project',
  '\\\\server\\Private Share\\Secret Project',
])('scrubs complete project-name paths: %s', (path): void => {
  expect(
    buildPersonalCatalogPayload({
      ...payload,
      name: `Project ${path}`,
      type: 'single-repo',
      remotes: [],
    })?.name,
  ).toBe('Project [path]');
});

it('preserves plain project names with POSIX filename characters', (): void => {
  expect(
    buildPersonalCatalogPayload({
      ...payload,
      name: 'Client<Acquisition>|Draft',
      type: 'cowork',
      remotes: [],
    })?.name,
  ).toBe('Client<Acquisition>|Draft');
});
