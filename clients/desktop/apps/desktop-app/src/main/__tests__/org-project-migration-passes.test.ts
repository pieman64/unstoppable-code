/** @jest-environment node */
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createOrgProjectMigrationPassStore,
  normalizeOrgProjectMigrationPasses,
  type OrgProjectMigrationPassesFile,
} from '../lib/org-project-migration-passes';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const STARTED = '2026-10-02T00:00:00.000Z';

let root: string;
let file: string;

beforeEach(async (): Promise<void> => {
  root = await mkdtemp(join(tmpdir(), 'org-migration-passes-'));
  file = join(root, 'nested', 'org-project-migration-passes.json');
});

afterEach(async (): Promise<void> => {
  await rm(root, { recursive: true, force: true });
});

describe('normalizeOrgProjectMigrationPasses', (): void => {
  it('keeps well-formed passes, lower-cases organization ids and de-duplicates workspaces', (): void => {
    expect(
      normalizeOrgProjectMigrationPasses({
        version: 1,
        organizations: {
          [ORG_A.toUpperCase()]: {
            startedAt: STARTED,
            eligibleWorkspaceIds: ['alpha', 'beta', 'alpha'],
            completedAt: '2026-10-02T01:00:00.000Z',
          },
          [ORG_B]: { startedAt: STARTED, eligibleWorkspaceIds: [] },
        },
      }),
    ).toEqual({
      version: 1,
      organizations: {
        [ORG_A]: {
          startedAt: STARTED,
          eligibleWorkspaceIds: ['alpha', 'beta'],
          completedAt: '2026-10-02T01:00:00.000Z',
        },
        [ORG_B]: { startedAt: STARTED, eligibleWorkspaceIds: [] },
      },
    });
  });

  // Dropping a malformed entry would start that organization's pass again
  // and move projects created since, so any malformed entry or field makes
  // the whole ledger unreadable instead (fail closed).
  it.each<[string, Record<string, unknown>]>([
    [
      'an organization id that is not one',
      { 'not an id': { startedAt: STARTED, eligibleWorkspaceIds: [] } },
    ],
    [
      'a reserved key',
      { constructor: { startedAt: STARTED, eligibleWorkspaceIds: [] } },
    ],
    [
      'an oversized organization id',
      { ['a'.repeat(300)]: { startedAt: STARTED, eligibleWorkspaceIds: [] } },
    ],
    [
      'a malformed start time',
      { [ORG_A]: { startedAt: 'yesterday', eligibleWorkspaceIds: [] } },
    ],
    ['a missing eligible list', { [ORG_A]: { startedAt: STARTED } }],
    [
      'a malformed workspace id',
      { [ORG_A]: { startedAt: STARTED, eligibleWorkspaceIds: ['../bad'] } },
    ],
    [
      'a workspace id that is not a string',
      { [ORG_A]: { startedAt: STARTED, eligibleWorkspaceIds: [7] } },
    ],
    [
      'an oversized workspace id',
      {
        [ORG_A]: {
          startedAt: STARTED,
          eligibleWorkspaceIds: ['w'.repeat(300)],
        },
      },
    ],
    [
      'a malformed completion time',
      {
        [ORG_A]: {
          startedAt: STARTED,
          eligibleWorkspaceIds: [],
          completedAt: 42,
        },
      },
    ],
    ['an entry that is not an object', { [ORG_A]: 'done' }],
  ])('reads %s as unreadable', (_label, organizations): void => {
    expect(
      normalizeOrgProjectMigrationPasses({
        version: 1,
        organizations: {
          [ORG_B]: { startedAt: STARTED, eligibleWorkspaceIds: ['kept'] },
          ...organizations,
        },
      }),
    ).toBeNull();
  });

  it('reads a __proto__ entry as unreadable', (): void => {
    const organizations: Record<string, unknown> = {};
    Object.defineProperty(organizations, '__proto__', {
      value: { startedAt: STARTED, eligibleWorkspaceIds: [] },
      enumerable: true,
    });
    expect(
      normalizeOrgProjectMigrationPasses({ version: 1, organizations }),
    ).toBeNull();
  });

  it('reads a pass with more eligible workspaces than it can hold as unreadable', (): void => {
    const ids = Array.from({ length: 10_001 }, (_, index) => `w-${index}`);
    expect(
      normalizeOrgProjectMigrationPasses({
        version: 1,
        organizations: {
          [ORG_A]: { startedAt: STARTED, eligibleWorkspaceIds: ids },
        },
      }),
    ).toBeNull();
    expect(
      normalizeOrgProjectMigrationPasses({
        version: 1,
        organizations: {
          [ORG_A]: { startedAt: STARTED, eligibleWorkspaceIds: ids.slice(1) },
        },
      })?.organizations[ORG_A]?.eligibleWorkspaceIds,
    ).toHaveLength(10_000);
  });

  it('rejects another version or shape', (): void => {
    expect(normalizeOrgProjectMigrationPasses({ version: 2 })).toBeNull();
    expect(normalizeOrgProjectMigrationPasses([])).toBeNull();
    expect(
      normalizeOrgProjectMigrationPasses({ version: 1, organizations: [] }),
    ).toBeNull();
  });
});

describe('org project migration pass store', (): void => {
  it('serializes scheduler and promotion stores sharing the same file', async (): Promise<void> => {
    const scheduler = createOrgProjectMigrationPassStore(() => file);
    const promotion = createOrgProjectMigrationPassStore(() => file);
    await Promise.all(
      [scheduler, promotion].map((store, index) =>
        store.update((current) => ({
          ...current,
          organizations: {
            ...current.organizations,
            [index === 0 ? ORG_A : ORG_B]: {
              startedAt: STARTED,
              eligibleWorkspaceIds: [],
            },
          },
        })),
      ),
    );
    const read = await scheduler.read();
    expect(
      read.status === 'ok' && Object.keys(read.file.organizations),
    ).toEqual([ORG_A, ORG_B]);
  });
  it('reads a missing file as an empty ledger', async (): Promise<void> => {
    const store = createOrgProjectMigrationPassStore(() => file);
    expect(await store.read()).toEqual({
      status: 'ok',
      file: { version: 1, organizations: {} },
    });
  });

  it('reads a corrupt or foreign file as unreadable, and refuses to overwrite it', async (): Promise<void> => {
    const path = join(root, 'org-project-migration-passes.json');
    const store = createOrgProjectMigrationPassStore(() => path);
    for (const content of ['{not json', JSON.stringify({ version: 2 })]) {
      await writeFile(path, content);
      expect(await store.read()).toEqual({ status: 'unreadable' });
      await expect(
        store.update((current) => ({
          ...current,
          organizations: {
            [ORG_A]: { startedAt: STARTED, eligibleWorkspaceIds: [] },
          },
        })),
      ).rejects.toThrow('migration-passes-unreadable');
      expect(await readFile(path, 'utf8')).toBe(content);
    }
  });

  it('reads a file it cannot open as unreadable', async (): Promise<void> => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return;
    const path = join(root, 'org-project-migration-passes.json');
    await writeFile(path, JSON.stringify({ version: 1, organizations: {} }));
    await chmod(path, 0o000);
    try {
      expect(
        await createOrgProjectMigrationPassStore(() => path).read(),
      ).toEqual({ status: 'unreadable' });
    } finally {
      await chmod(path, 0o600);
    }
  });

  it('writes the normalized ledger atomically with owner-only permissions', async (): Promise<void> => {
    const store = createOrgProjectMigrationPassStore(() => file);
    await store.update((current) => ({
      ...current,
      organizations: {
        ...current.organizations,
        [ORG_A]: {
          startedAt: STARTED,
          eligibleWorkspaceIds: ['alpha', 'alpha', 'beta'],
        },
      },
    }));
    const expected: OrgProjectMigrationPassesFile = {
      version: 1,
      organizations: {
        [ORG_A]: {
          startedAt: STARTED,
          eligibleWorkspaceIds: ['alpha', 'beta'],
        },
      },
    };
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(expected);
    expect(await store.read()).toEqual({ status: 'ok', file: expected });
    if (process.platform !== 'win32') {
      expect((await stat(file)).mode & 0o777).toBe(0o600);
    }
  });

  it('serializes concurrent updates so none is lost', async (): Promise<void> => {
    const store = createOrgProjectMigrationPassStore(() => file);
    await Promise.all(
      [ORG_A, ORG_B].map((organizationId) =>
        store.update((current) => ({
          ...current,
          organizations: {
            ...current.organizations,
            [organizationId]: { startedAt: STARTED, eligibleWorkspaceIds: [] },
          },
        })),
      ),
    );
    const read = await store.read();
    expect(
      read.status === 'ok' && Object.keys(read.file.organizations),
    ).toEqual([ORG_A, ORG_B]);
  });

  it('keeps serving after a failed update', async (): Promise<void> => {
    const store = createOrgProjectMigrationPassStore(() => file);
    await expect(
      store.update((): OrgProjectMigrationPassesFile => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await store.update((current) => ({
      ...current,
      organizations: {
        [ORG_A]: { startedAt: STARTED, eligibleWorkspaceIds: [] },
      },
    }));
    expect(await store.read()).toMatchObject({ status: 'ok' });
  });
});
