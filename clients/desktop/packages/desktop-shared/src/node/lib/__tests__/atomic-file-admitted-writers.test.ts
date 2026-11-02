import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  writeFileAtomically,
  writeFileAtomicallySync,
  type AdmittedWriterTarget,
} from '../atomic-file';

const PREFERENCES: AdmittedWriterTarget = {
  namespace: 'preferences',
  writer: 'electron_main',
  module: 'main/lib/preferences-store',
};
const APPROVALS: AdmittedWriterTarget = {
  namespace: 'workspace_approvals',
  writer: 'electron_main',
  module: 'main/lib/approvals-persistence',
};

let root = '';
const originalDataDir = process.env.CANOPY_DATA_DIR;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'admitted-writers-'));
  process.env.CANOPY_DATA_DIR = root;
  await mkdir(join(root, 'workspaces', 'ws-1'), { recursive: true });
});

afterEach(async () => {
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  await rm(root, { recursive: true, force: true });
});

const refusal = (namespaceId: string): Record<string, unknown> => ({
  name: 'StorageWriteRefusedError',
  namespaceId,
  reason: 'unadmitted_writer',
});

function thrownBy(write: () => void): unknown {
  try {
    write();
  } catch (error) {
    return error;
  }
  return undefined;
}

it.each([
  ['preferences.json', 'preferences'],
  ['preferences.last-good.json', 'preferences'],
  ['preferences.generation.json', 'preferences'],
  ['preferences.backup-2026-10-30T00-00-00-000Z-x.json', 'preferences'],
  ['migrations.json', 'startup_migrations'],
  [join('workspaces', 'ws-1', 'approvals.json'), 'workspace_approvals'],
])(
  'refuses an undeclared write to %s before touching it or a sibling',
  async (relative, row) => {
    const target = join(root, relative);
    await writeFile(target, 'original');
    const before = await readdir(join(target, '..'));
    await expect(
      writeFileAtomically(target, 'replacement', { durable: true }),
    ).rejects.toMatchObject(refusal(row));
    expect(
      thrownBy(() => writeFileAtomicallySync(target, 'replacement')),
    ).toMatchObject(refusal(row));
    expect(await readFile(target, 'utf8')).toBe('original');
    expect(await readdir(join(target, '..'))).toEqual(before);
  },
);

it('refuses a module outside the row, or another row admitted writer', async () => {
  const target = join(root, 'preferences.json');
  await expect(
    writeFileAtomically(target, 'x', {
      admittedWriter: { ...PREFERENCES, module: 'main/lib/other-store' },
    }),
  ).rejects.toMatchObject({
    ...refusal('preferences'),
    writer: 'electron_main (main/lib/other-store)',
  });
  await expect(
    writeFileAtomically(target, 'x', { admittedWriter: APPROVALS }),
  ).rejects.toMatchObject(refusal('preferences'));
  await expect(
    writeFileAtomically(target, 'x', {
      admittedWriter: { ...PREFERENCES, writer: 'desktop_cli' },
    }),
  ).rejects.toMatchObject({ reason: 'unlisted_writer' });
  await expect(
    writeFileAtomically(target, 'x', {
      storage: { namespace: 'workspace_index', writer: 'electron_main' },
    }),
  ).rejects.toMatchObject(refusal('preferences'));
  await expect(readdir(root)).resolves.toEqual(['workspaces']);
});

it('installs, durably, a write by the admitted module', async () => {
  const preferences = join(root, 'preferences.json');
  const approvals = join(root, 'workspaces', 'ws-1', 'approvals.json');
  await writeFileAtomically(preferences, 'prefs', {
    durable: true,
    admittedWriter: PREFERENCES,
  });
  await writeFileAtomically(approvals, 'rules', {
    durable: true,
    admittedWriter: APPROVALS,
  });
  expect(await readFile(preferences, 'utf8')).toBe('prefs');
  expect(await readFile(approvals, 'utf8')).toBe('rules');
  expect((await readdir(root)).sort()).toEqual([
    'preferences.json',
    'workspaces',
  ]);
});

it('leaves unrelated paths and same-named files outside the data root alone', async () => {
  const elsewhere = await mkdtemp(join(tmpdir(), 'admitted-elsewhere-'));
  try {
    await writeFileAtomically(join(elsewhere, 'preferences.json'), 'x');
    await writeFileAtomically(join(elsewhere, 'migrations.json'), 'y');
    await writeFileAtomically(join(root, 'workspaces', 'index.json'), 'z');
    writeFileAtomicallySync(join(root, 'workspaces', 'other.json'), 'w');
    expect((await readdir(elsewhere)).sort()).toEqual([
      'migrations.json',
      'preferences.json',
    ]);
  } finally {
    await rm(elsewhere, { recursive: true, force: true });
  }
});

it('refuses the rows file shapes in any folder from the synchronous writer', async () => {
  const elsewhere = await mkdtemp(join(tmpdir(), 'admitted-elsewhere-'));
  try {
    expect(
      thrownBy(() =>
        writeFileAtomicallySync(join(elsewhere, 'migrations.json'), 'y'),
      ),
    ).toMatchObject(refusal('startup_migrations'));
    expect(await readdir(elsewhere)).toEqual([]);
  } finally {
    await rm(elsewhere, { recursive: true, force: true });
  }
});

it('refuses a write that is both a W5 write and an admitted write', async () => {
  await expect(
    writeFileAtomically(join(root, 'preferences.json'), 'x', {
      admittedWriter: PREFERENCES,
      storage: { namespace: 'workspace_index', writer: 'electron_main' },
    }),
  ).rejects.toBeInstanceOf(TypeError);
});
