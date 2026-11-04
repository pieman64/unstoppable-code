import type * as FsPromises from 'node:fs/promises';
import type * as CrashFs from './helpers/local-memory-scope/crash-fs';

let mockCrashPlan: CrashFs.FsCrashPlan | null = null;
jest.mock('node:fs/promises', () =>
  jest
    .requireActual<typeof CrashFs>('./helpers/local-memory-scope/crash-fs')
    .crashableFsPromises(
      jest.requireActual<typeof FsPromises>('node:fs/promises'),
      () => mockCrashPlan,
    ),
);

let mockProjectsDir = '';
let mockWorkspaceScopeDir = '';
jest.mock('../memory/local/policy', () => ({
  resolveLocalMemoryPolicy: (): Promise<unknown> =>
    Promise.resolve({
      kind: 'scoped',
      workspaceId: 'workspace-1',
      privateMemory: false,
    }),
}));
jest.mock('../lib/claude-project-paths', () => ({
  getClaudeCodeProjectsDir: (): string => mockProjectsDir,
  claudeProjectDirCandidates: (): Promise<string[]> =>
    Promise.resolve(['candidate']),
}));
jest.mock('../lib/paths', () => ({
  getUserMemoryDir: (): string => join(mockWorkspaceScopeDir, '..', 'user'),
  getWorkspaceMemoryDir: (): string => mockWorkspaceScopeDir,
}));

import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import {
  isMemoryNoteFileKey,
  MemoryManifestFileSchema,
  memoryUlidTime,
} from '@canopy/protocol/memory-sync';
import { findDuplicateMemoryNoteIds } from '../memory/local/backfill';
import { withMemoryWriteLock } from '../memory/local/edit-coordination';
import { runClaudeMemoryImport } from '../memory/local/import/import-runner';
import { inspectImportState } from '../memory/local/import/ledger';
import {
  memoryNoteFileName,
  memoryNoteId,
  memoryNoteIdAt,
  withMemoryNoteId,
} from '../memory/local/note-identity';
import {
  planConsolidatedSourceRestore,
  restoreConsolidatedSources,
} from '../memory/local/rebuild';
import {
  acquireMemoryScopeLock,
  withMemoryScopeLock,
} from '../memory/local/scope-lock';
import { appendInboxNote } from '../memory/local/store';
import {
  crashPoints,
  FsCrashPlan,
  type CrashPoint,
} from './helpers/local-memory-scope/crash-fs';

/*
 * Each memory write below is cut short at every one of its file system
 * calls in turn, as a process dying there would leave it, and then the next
 * writer recovers: it takes over the dead writer's lock and writes again.
 * After every crash point the scope must hold each note in exactly one
 * complete file under one ID, and no temp file a write left behind.
 */

jest.setTimeout(120_000);

const NOTE_SOURCE = { provider: 'claude', chatId: 'chat-1' };

function noteWithFrontMatter(created: string, body: string): string {
  return [
    '---',
    'source:',
    '  provider: "claude"',
    '  chatId: "chat-1"',
    `created: ${JSON.stringify(created)}`,
    `modified: ${JSON.stringify(created)}`,
    'type: inbox',
    '---',
    '',
    body,
    '',
  ].join('\n');
}

async function writeFixture(
  scopeDir: string,
  fileKey: string,
  content: string,
  mtime: Date,
): Promise<void> {
  const path = join(scopeDir, fileKey);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content, 'utf8');
  await utimes(path, mtime, mtime);
}

async function markdownFiles(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory, { withFileTypes: true }))
      .filter(
        (entry) =>
          entry.isFile() &&
          entry.name.endsWith('.md') &&
          !entry.name.startsWith('.'),
      )
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/** Temp files of writes, in the folders a memory write uses. */
async function leftoverTemps(scopeDir: string): Promise<string[]> {
  const found: string[] = [];
  for (const folder of [
    '',
    'inbox',
    join('inbox', '.consolidated'),
    'imported',
    join('imported', '.consolidated'),
    'topics',
  ]) {
    const names = await readdir(join(scopeDir, folder)).catch(
      (): string[] => [],
    );
    for (const name of names) {
      if (name.endsWith('.tmp')) found.push(join(folder, name));
    }
  }
  return found;
}

/** Readies the scope the way every write does. */
function prepareScope(scopeDir: string): Promise<void> {
  return withMemoryWriteLock(scopeDir, () => Promise.resolve());
}

/** The dead writer's process is gone: the next writer takes its lock over. */
async function takeOverDeadWriter(scopeDir: string): Promise<void> {
  await (await acquireMemoryScopeLock(scopeDir, { staleMs: 0 })).release();
}

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function checkNoDuplicateIds(scopeDir: string): Promise<void> {
  const duplicates = await findDuplicateMemoryNoteIds(scopeDir);
  check(
    duplicates.length === 0,
    `note IDs in more than one file: ${JSON.stringify(duplicates)}`,
  );
}

async function checkNoTemps(scopeDir: string): Promise<void> {
  const temps = await leftoverTemps(scopeDir);
  check(temps.length === 0, `temp files left: ${temps.join(', ')}`);
}

interface CrashScenario {
  hardLinks: boolean;
  setUp(scopeDir: string): Promise<void>;
  run(scopeDir: string): Promise<unknown>;
  recover(scopeDir: string): Promise<void>;
  /** Throws naming what the scope got wrong. */
  verify(scopeDir: string): Promise<void>;
}

function describePoint(point: CrashPoint, root: string): string {
  return `${point.mode} ${point.call} ${relative(root, point.path)} (#${point.index})`;
}

/**
 * Runs the scenario through once to record its calls, then once per crash
 * point, and returns every point after which recovery left the scope wrong.
 */
async function crashAtEveryStep(scenario: CrashScenario): Promise<{
  points: number;
  failures: string[];
}> {
  const root = await mkdtemp(join(tmpdir(), 'local-memory-crash-'));
  try {
    const dry = join(root, 'dry');
    await scenario.setUp(dry);
    const recording = new FsCrashPlan(null, scenario.hardLinks);
    mockCrashPlan = recording;
    try {
      await scenario.run(dry);
    } finally {
      mockCrashPlan = null;
    }
    await scenario.recover(dry);
    await scenario.verify(dry);
    const points = crashPoints(recording.steps);
    const failures: string[] = [];
    for (const point of points) {
      const scopeDir = join(root, `crash-${point.index}-${point.mode}`);
      const label = describePoint(point, dry);
      try {
        await scenario.setUp(scopeDir);
        const plan = new FsCrashPlan(point, scenario.hardLinks);
        mockCrashPlan = plan;
        try {
          await scenario.run(scopeDir).catch(() => undefined);
        } finally {
          mockCrashPlan = null;
        }
        if (!plan.crashed) {
          failures.push(`${label}: the run took another path`);
          continue;
        }
        await takeOverDeadWriter(scopeDir);
        await scenario.recover(scopeDir);
        await scenario.verify(scopeDir);
      } catch (error) {
        failures.push(
          `${label}: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        await rm(scopeDir, { recursive: true, force: true });
      }
    }
    return { points: points.length, failures };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const LINK_MODES = [
  ['with hard links', true],
  ['without hard links', false],
] as const;

describe('local memory crash recovery', () => {
  let warning: jest.SpyInstance;

  beforeEach(() => {
    warning = jest
      .spyOn(process, 'emitWarning')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    mockCrashPlan = null;
    warning.mockRestore();
  });

  describe.each(LINK_MODES)('%s', (_label, hardLinks) => {
    it('resumes a backfill cut short at any step with every note once, whole, under one ID', async () => {
      const keptId = memoryNoteIdAt(Date.parse('2026-09-03T00:00:00.000Z'));
      const fixtures = [
        {
          // Gets an ID and a name a replica can carry.
          fileKey: 'inbox/legacy note.md',
          content: noteWithFrontMatter('2026-09-01T00:00:00.000Z', 'Legacy'),
          mtime: new Date('2026-09-01T00:00:30.000Z'),
          created: '2026-09-01T00:00:00.000Z',
        },
        {
          // Gets an ID; its name is kept.
          fileKey: 'inbox/2026-09-02T00-00-00-plain.md',
          content: noteWithFrontMatter('2026-09-02T00:00:00.000Z', 'Plain'),
          mtime: new Date('2026-09-02T00:00:30.000Z'),
          created: '2026-09-02T00:00:00.000Z',
        },
        {
          // Keeps its ID and is renamed.
          fileKey: 'inbox/has id.md',
          content: withMemoryNoteId(
            noteWithFrontMatter('2026-09-03T00:00:00.000Z', 'Has an ID'),
            keptId,
          ),
          mtime: new Date('2026-09-03T00:00:30.000Z'),
          created: '2026-09-03T00:00:00.000Z',
        },
        {
          // No front matter: its ID's time is its modification time.
          fileKey: 'inbox/bare.md',
          content: 'A bare note\n',
          mtime: new Date('2026-09-04T00:00:00.000Z'),
          created: '2026-09-04T00:00:00.000Z',
        },
        {
          fileKey: 'inbox/.consolidated/2026-08-01T00-00-00-archived.md',
          content: noteWithFrontMatter('2026-08-01T00:00:00.000Z', 'Archived'),
          mtime: new Date('2026-08-01T00:00:30.000Z'),
          created: '2026-08-01T00:00:00.000Z',
        },
      ];
      const staged = 'imported/claude-notes-0123456789abcdef.md';
      const importedAt = '2026-07-01T00:00:00.000Z';
      const sourcePath = '/home/me/.claude/notes.md';

      const { points, failures } = await crashAtEveryStep({
        hardLinks,
        async setUp(scopeDir) {
          for (const fixture of fixtures) {
            await writeFixture(
              scopeDir,
              fixture.fileKey,
              fixture.content,
              fixture.mtime,
            );
          }
          await writeFixture(
            scopeDir,
            staged,
            '# Imported\n\nVerbatim.\n',
            new Date(importedAt),
          );
          await writeFile(
            join(scopeDir, 'import-state.json'),
            JSON.stringify({
              version: 1,
              sources: {
                [sourcePath]: {
                  fileHash: 'a'.repeat(64),
                  importedAt,
                  stagedAs: staged,
                },
              },
            }),
          );
          await writeFile(
            join(scopeDir, 'manifest.json'),
            '{ "version": 1 }\n',
          );
        },
        run: prepareScope,
        recover: prepareScope,
        async verify(scopeDir) {
          const manifest = MemoryManifestFileSchema.parse(
            JSON.parse(await readFile(join(scopeDir, 'manifest.json'), 'utf8')),
          );
          check(manifest.backfilledAt !== null, 'backfill not finished');
          const files: Record<string, string> = {};
          for (const folder of ['inbox', 'inbox/.consolidated']) {
            for (const name of await markdownFiles(join(scopeDir, folder))) {
              files[`${folder}/${name}`] = await readFile(
                join(scopeDir, folder, name),
                'utf8',
              );
            }
          }
          check(
            Object.keys(files).length === fixtures.length,
            `expected ${fixtures.length} notes, found ${Object.keys(files).join(', ')}`,
          );
          for (const fixture of fixtures) {
            const archived = fixture.fileKey.startsWith('inbox/.consolidated/');
            const holders = Object.entries(files).filter(([fileKey, text]) => {
              const id = memoryNoteId(text);
              return (
                id !== null &&
                fileKey.startsWith('inbox/.consolidated/') === archived &&
                (text === fixture.content ||
                  text === withMemoryNoteId(fixture.content, id))
              );
            });
            check(
              holders.length === 1,
              `${fixture.fileKey} is in ${holders.length} whole files`,
            );
            const [fileKey, text] = holders[0] ?? ['', ''];
            const id = memoryNoteId(text) ?? '';
            check(
              memoryUlidTime(id) === Date.parse(fixture.created),
              `${fileKey} has an ID from another time`,
            );
            if (fixture.content.includes(keptId)) {
              check(id === keptId, `${fileKey} lost its ID`);
            }
            if (!archived) {
              check(
                isMemoryNoteFileKey(fileKey, 'inbox'),
                `${fileKey} is not a name a replica can carry`,
              );
            }
            check(
              (await stat(join(scopeDir, fileKey))).mtimeMs ===
                fixture.mtime.getTime(),
              `${fileKey} lost its modification time`,
            );
          }
          const ledger = await inspectImportState(scopeDir);
          const entry =
            ledger.kind === 'present' ? ledger.state.sources[sourcePath] : null;
          check(
            entry !== null &&
              entry !== undefined &&
              'stagedAs' in entry &&
              memoryUlidTime(entry.noteId ?? '') === Date.parse(importedAt),
            'the staged import has no note ID',
          );
          check(
            (await readFile(join(scopeDir, staged), 'utf8')) ===
              '# Imported\n\nVerbatim.\n',
            'the staged import changed',
          );
          await checkNoDuplicateIds(scopeDir);
          await checkNoTemps(scopeDir);
        },
      });

      expect(points).toBeGreaterThan(20);
      expect(failures).toEqual([]);
    });

    it('saves a note cut short at any step whole or not at all', async () => {
      const text = 'Ports move as a pair. '.repeat(20).trim();
      const { failures } = await crashAtEveryStep({
        hardLinks,
        setUp: prepareScope,
        run: (scopeDir) =>
          appendInboxNote(scopeDir, { text, source: NOTE_SOURCE }),
        recover: prepareScope,
        async verify(scopeDir) {
          const names = await markdownFiles(join(scopeDir, 'inbox'));
          check(names.length <= 1, `saved as ${names.join(', ')}`);
          for (const name of names) {
            const content = await readFile(
              join(scopeDir, 'inbox', name),
              'utf8',
            );
            check(memoryNoteId(content) !== null, `${name} has no ID`);
            check(content.endsWith(`\n${text}\n`), `${name} is cut short`);
          }
          await checkNoTemps(scopeDir);
        },
      });

      expect(failures).toEqual([]);
    });

    it('restores archived notes cut short at any step to one whole file each', async () => {
      const notes = ['First archived', 'Second archived'].map((body, index) => {
        const created = Date.parse('2026-09-01T00:00:00.000Z') + index * 60_000;
        const id = memoryNoteIdAt(created);
        return {
          id,
          name: memoryNoteFileName(created, body, id),
          content: withMemoryNoteId(
            noteWithFrontMatter(new Date(created).toISOString(), body),
            id,
          ),
        };
      });
      const restore = (scopeDir: string): Promise<void> =>
        withMemoryWriteLock(scopeDir, async () => {
          const plan = await planConsolidatedSourceRestore(scopeDir);
          if (!plan.ok) throw new Error(plan.reason);
          await restoreConsolidatedSources(scopeDir, plan.imports);
        });

      const { failures } = await crashAtEveryStep({
        hardLinks,
        async setUp(scopeDir) {
          await prepareScope(scopeDir);
          for (const note of notes) {
            await writeFixture(
              scopeDir,
              `inbox/.consolidated/${note.name}`,
              note.content,
              new Date('2026-09-02T00:00:00.000Z'),
            );
          }
        },
        run: restore,
        recover: restore,
        async verify(scopeDir) {
          check(
            (await markdownFiles(join(scopeDir, 'inbox', '.consolidated')))
              .length === 0,
            'a note is still archived',
          );
          const pending = await markdownFiles(join(scopeDir, 'inbox'));
          check(
            pending.join() === notes.map((note) => note.name).join(),
            `pending: ${pending.join(', ')}`,
          );
          for (const note of notes) {
            check(
              (await readFile(join(scopeDir, 'inbox', note.name), 'utf8')) ===
                note.content,
              `${note.name} is not whole`,
            );
          }
          await checkNoDuplicateIds(scopeDir);
          await checkNoTemps(scopeDir);
        },
      });

      expect(failures).toEqual([]);
    });
  });

  it('stages and records an import cut short at any step once, keeping its note ID', async () => {
    const root = await mkdtemp(join(tmpdir(), 'local-memory-crash-import-'));
    try {
      mockProjectsDir = join(root, 'projects');
      const sourcePath = join(
        mockProjectsDir,
        'candidate',
        'memory',
        'MEMORY.md',
      );
      await mkdir(join(sourcePath, '..'), { recursive: true });
      await writeFile(sourcePath, '# Deploys\n\nShip on Tuesdays.\n', 'utf8');
      const runImport = (scopeDir: string): Promise<unknown> => {
        mockWorkspaceScopeDir = scopeDir;
        return runClaudeMemoryImport({
          workspaceId: 'workspace-1',
          repoPath: '/repo/path',
        });
      };
      let stagedContent: string | null = null;
      const recordedNoteIds = new Map<string, string | undefined>();
      const noteIdIn = async (
        scopeDir: string,
      ): Promise<string | undefined> => {
        const ledger = await inspectImportState(scopeDir);
        const entry =
          ledger.kind === 'present' ? ledger.state.sources[sourcePath] : null;
        return entry && 'stagedAs' in entry ? entry.noteId : undefined;
      };

      const { failures } = await crashAtEveryStep({
        hardLinks: true,
        async setUp(scopeDir) {
          await mkdir(scopeDir, { recursive: true });
        },
        run: runImport,
        async recover(scopeDir) {
          recordedNoteIds.set(scopeDir, await noteIdIn(scopeDir));
          await runImport(scopeDir);
        },
        async verify(scopeDir) {
          const ledger = await inspectImportState(scopeDir);
          const entry =
            ledger.kind === 'present' ? ledger.state.sources[sourcePath] : null;
          if (!entry || !('stagedAs' in entry) || entry.noteId === undefined) {
            throw new Error('the import is not recorded with a note ID');
          }
          const recorded = recordedNoteIds.get(scopeDir);
          check(
            recorded === undefined || recorded === entry.noteId,
            'the import’s recorded note ID changed',
          );
          const staged = await markdownFiles(join(scopeDir, 'imported'));
          check(
            staged.join() === entry.stagedAs.slice('imported/'.length),
            `staged: ${staged.join(', ')}`,
          );
          const content = await readFile(
            join(scopeDir, entry.stagedAs),
            'utf8',
          );
          stagedContent ??= content;
          check(content === stagedContent, 'the staged import is not whole');
          await checkNoDuplicateIds(scopeDir);
          await checkNoTemps(scopeDir);
        },
      });

      expect(failures).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('leaves nothing a lock taken over, held and released, cut short at any step, keeps', async () => {
    const elevenMinutesOn = (): number => Date.now() + 11 * 60_000;
    const { failures } = await crashAtEveryStep({
      hardLinks: true,
      async setUp(scopeDir) {
        // Held by a process on another host that stopped an hour ago.
        const heartbeatAt = new Date(Date.now() - 3_600_000).toISOString();
        await mkdir(join(scopeDir, '.lock'), { recursive: true });
        await writeFile(
          join(scopeDir, '.lock', 'owner.json'),
          JSON.stringify({
            version: 1,
            token: '6f3c3c43-62f1-4a65-8e7e-2c1a8e1f3b7a',
            pid: 1,
            hostname: 'another-host',
            processKind: 'app',
            acquiredAt: heartbeatAt,
            heartbeatAt,
          }),
        );
      },
      run: (scopeDir) => withMemoryScopeLock(scopeDir, () => Promise.resolve()),
      recover: async (scopeDir) => {
        await withMemoryScopeLock(scopeDir, () => Promise.resolve());
        // Once their retention has passed, the next writer removes the rest.
        await withMemoryScopeLock(scopeDir, () => Promise.resolve(), {
          now: elevenMinutesOn,
        });
      },
      async verify(scopeDir) {
        const left = await readdir(scopeDir);
        check(left.length === 0, `left: ${left.join(', ')}`);
      },
    });

    expect(failures).toEqual([]);
  });
});
