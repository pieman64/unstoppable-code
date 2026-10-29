import { createHash } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as paths from 'node:path';
import { createDirectoryReadPreferenceSource } from '@canopy/core-runtime/node';
import {
  initClaudeModels,
  initCodexModels,
  initOllamaModels,
} from '@canopy/desktop-shared/types';

const mockGetCanopyDataDir = jest.fn<string, []>();

jest.mock('@canopy/desktop-shared/canopy-paths', () => ({
  getCanopyDataDir: (): string => mockGetCanopyDataDir(),
  getCanopySecureDataDir: (): string => `${mockGetCanopyDataDir()}/secure-data`,
  getPrimaryBrandDataDir: (): string => mockGetCanopyDataDir(),
  getResolvedCanopyDataDir: (): {
    path: string;
    source: 'primary';
    allCandidates: string[];
  } => ({
    path: mockGetCanopyDataDir(),
    source: 'primary',
    allCandidates: [mockGetCanopyDataDir()],
  }),
  getUserEnvironmentFilePath: (): string =>
    `${mockGetCanopyDataDir()}/environments.json`,
}));

import {
  peekPreferencesLoadError,
  readPreferencesFile,
  resetPreferencesLoadErrorForTests,
} from '../lib/preferences-store';

initClaudeModels([{ id: 'opus[1m]', label: 'Opus 4.8 1M' }]);
initCodexModels([{ id: 'gpt-6-luna', label: 'GPT 6 Luna' }]);
initOllamaModels([]);

function envelope(preferences: unknown, version: unknown = 1): string {
  return JSON.stringify({ version, preferences }, null, 2);
}

type FileFixture =
  | { kind: 'absent' }
  | { kind: 'unreadable'; content: string }
  | { kind: 'content'; content: string };

const OVERRIDES_SUBSET = {
  fileIndexing: {
    disabledBuiltinGlobIds: ['node-modules', 'bogus', 'node-modules'],
    customGlobs: [
      { id: ' keep ', pattern: '  dist/**  ', enabled: false },
      { pattern: 'dist/**' },
      { pattern: 'coverage/**' },
    ],
  },
  gitExecutablePath: '  /opt/git/bin/git  ',
};
const OVERRIDES = envelope(OVERRIDES_SUBSET);
const ALTERNATE = envelope({
  fileIndexing: { disabledBuiltinGlobIds: ['gradle'] },
  gitExecutablePath: '/usr/local/bin/git',
});
const MALFORMED_SUBSET = envelope({
  fileIndexing: ['node-modules'],
  gitExecutablePath: 42,
});

// Desktop's unreadable branch needs a mode-000 file the reader cannot bypass.
const CAN_DENY_READS = process.platform !== 'win32' && process.getuid?.() !== 0;

const PRIMARY_FIXTURES: Record<string, FileFixture> = {
  'valid overrides': { kind: 'content', content: OVERRIDES },
  'valid malformed subset': { kind: 'content', content: MALFORMED_SUBSET },
  'valid empty subset': { kind: 'content', content: envelope({}) },
  absent: { kind: 'absent' },
  ...(CAN_DENY_READS
    ? { unreadable: { kind: 'unreadable', content: OVERRIDES } }
    : {}),
  corrupt: { kind: 'content', content: '{"version":1,' },
  'version 2': { kind: 'content', content: envelope({}, 2) },
  'version 2 carrying overrides': {
    kind: 'content',
    content: envelope(OVERRIDES_SUBSET, 2),
  },
  'array preferences': {
    kind: 'content',
    content: '{"version":1,"preferences":[]}',
  },
};

const LAST_GOOD_FIXTURES: Record<string, FileFixture> = {
  'valid alternate': { kind: 'content', content: ALTERNATE },
  'valid malformed subset': { kind: 'content', content: MALFORMED_SUBSET },
  'valid empty subset': { kind: 'content', content: envelope({}) },
  absent: { kind: 'absent' },
  ...(CAN_DENY_READS
    ? { unreadable: { kind: 'unreadable', content: ALTERNATE } }
    : {}),
  corrupt: { kind: 'content', content: 'not json' },
  'string version': { kind: 'content', content: envelope({}, '1') },
};

async function seed(
  root: string,
  name: string,
  fixture: FileFixture,
): Promise<void> {
  if (fixture.kind === 'absent') return;
  const target = paths.join(root, name);
  await writeFile(target, fixture.content);
  if (fixture.kind === 'unreadable') await chmod(target, 0o000);
}

/**
 * Desktop reports its selection only through the recovery error: a completed
 * recovery that names last-good restored it; any other error restored
 * defaults; no error means the primary was used or nothing exists.
 */
function desktopSource(
  primary: FileFixture,
): 'primary' | 'last-good' | 'defaults' {
  const error = peekPreferencesLoadError();
  if (!error) return primary.kind === 'absent' ? 'defaults' : 'primary';
  return error.backupPath && error.restoredFromPath ? 'last-good' : 'defaults';
}

async function digest(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const name of (await readdir(root)).sort()) {
    const absolute = paths.join(root, name);
    result[name] = await readFile(absolute)
      .then((bytes) => createHash('sha256').update(bytes).digest('hex'))
      .catch((error: unknown) =>
        error instanceof Error && 'code' in error ? String(error.code) : '?',
      );
  }
  return result;
}

describe('directory read preferences match desktop read selection', () => {
  let parent: string;

  beforeEach(async () => {
    parent = await mkdtemp(paths.join(tmpdir(), 'canopy-dir-prefs-diff-'));
    resetPreferencesLoadErrorForTests();
  });

  afterEach(async () => {
    mockGetCanopyDataDir.mockReset();
    await rm(parent, { recursive: true, force: true });
  });

  const cases = Object.entries(PRIMARY_FIXTURES).flatMap(
    ([primaryName, primary]) =>
      Object.entries(LAST_GOOD_FIXTURES).map(([lastGoodName, lastGood]) => ({
        name: `${primaryName} primary, ${lastGoodName} last-good`,
        primary,
        lastGood,
      })),
  );

  it.each(cases)('$name', async ({ primary, lastGood }) => {
    const proofRoot = paths.join(parent, 'daemon');
    const desktopRoot = paths.join(parent, 'desktop');
    for (const root of [proofRoot, desktopRoot]) {
      await mkdir(root);
      await seed(root, 'preferences.json', primary);
      await seed(root, 'preferences.last-good.json', lastGood);
    }
    const proofBefore = await digest(proofRoot);

    const daemon = await createDirectoryReadPreferenceSource({
      canonicalDataRoot: proofRoot,
      paths,
    }).read(new AbortController().signal);
    // Desktop recovery may write; it runs only against the mirror root.
    mockGetCanopyDataDir.mockReturnValue(desktopRoot);
    const desktop = await readPreferencesFile();

    expect(daemon).toEqual({
      source: desktopSource(primary),
      preferences: {
        fileIndexing: desktop.fileIndexing,
        gitExecutablePath: desktop.gitExecutablePath,
      },
    });
    expect(await digest(proofRoot)).toEqual(proofBefore);
  });
});
