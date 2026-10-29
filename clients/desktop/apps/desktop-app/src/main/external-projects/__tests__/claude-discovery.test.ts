import type { Stats } from 'node:fs';
import type * as FsPromises from 'node:fs/promises';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Counts `stat` calls in flight so a test can prove the read pool is the
// bound the limits promise, not a nested product of pools.
const mockStatTracker = { inFlight: 0, peak: 0 };
jest.mock('node:fs/promises', () => {
  const actual = jest.requireActual<typeof FsPromises>('node:fs/promises');
  return {
    ...actual,
    stat: async (...args: Parameters<typeof actual.stat>): Promise<Stats> => {
      mockStatTracker.inFlight += 1;
      mockStatTracker.peak = Math.max(
        mockStatTracker.peak,
        mockStatTracker.inFlight,
      );
      try {
        return await actual.stat(...args);
      } finally {
        mockStatTracker.inFlight -= 1;
      }
    },
  };
});
import {
  discoverClaudeProjects,
  readClaudeTranscriptHeadMetadata,
  summarizeTitle,
} from '../claude-discovery';
import { DEFAULT_DISCOVERY_LIMITS } from '../types';

function jsonl(records: unknown[]): string {
  return records.map((record) => JSON.stringify(record)).join('\n') + '\n';
}

function transcriptRecord(
  cwd: string,
  sessionId: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    parentUuid: null,
    isSidechain: false,
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'text', text: 'Fix the login bug' }],
    },
    uuid: `${sessionId}-u1`,
    timestamp: '2026-08-31T17:15:48.088Z',
    cwd,
    sessionId,
    version: '2.1.235',
    entrypoint: 'cli',
    ...extra,
  };
}

describe('summarizeTitle', () => {
  it('drops XML-ish wrappers and keeps the first meaningful line', () => {
    expect(
      summarizeTitle(
        '<system_instruction>\nYou are inside X\n</system_instruction>\n\nRefactor the parser\nand more',
      ),
    ).toBe('Refactor the parser');
    expect(summarizeTitle('   ')).toBeNull();
    // Only the head of a huge block is scanned; the title still comes out.
    expect(summarizeTitle(`First line\n${'x'.repeat(200_000)}`)).toBe(
      'First line',
    );
    expect(summarizeTitle('x'.repeat(200))?.length).toBe(120);
  });
});

describe('readClaudeTranscriptHeadMetadata', () => {
  it('reads the exact cwd, session id, entrypoint, and title', () => {
    const metadata = readClaudeTranscriptHeadMetadata([
      { type: 'queue-operation', operation: 'enqueue', sessionId: 's1' },
      transcriptRecord('/Users/me/app', 's1'),
      { type: 'ai-title', aiTitle: 'Login bug', sessionId: 's1' },
    ]);
    expect(metadata).toEqual({
      cwd: '/Users/me/app',
      sessionId: 's1',
      native: true,
      startedAt: '2026-08-31T17:15:48.088Z',
      title: 'Login bug',
    });
  });

  it('marks SDK-originated sessions as non-native and falls back to the prompt', () => {
    const metadata = readClaudeTranscriptHeadMetadata([
      transcriptRecord('/Users/me/app', 's2', {
        entrypoint: 'sdk-ts',
        promptSource: 'sdk',
      }),
    ]);
    expect(metadata?.native).toBe(false);
    expect(metadata?.title).toBe('Fix the login bug');
  });

  it('returns null without a cwd', () => {
    expect(
      readClaudeTranscriptHeadMetadata([{ type: 'summary', summary: 'x' }]),
    ).toBeNull();
  });
});

describe('discoverClaudeProjects', () => {
  let root: string;
  let configDir: string;
  let projectsDir: string;
  let desktopDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'claude-discovery-'));
    configDir = join(root, 'claude');
    projectsDir = join(configDir, 'projects');
    desktopDir = join(root, 'Claude');
    await mkdir(projectsDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('reports nothing detected when no store exists', async () => {
    const result = await discoverClaudeProjects({
      globalConfigPath: join(root, 'missing.json'),
      projectsDir: join(root, 'missing-projects'),
      desktopDataDir: join(root, 'missing-desktop'),
    });
    expect(result).toEqual({ roots: [], diagnostics: [], detected: false });
  });

  it('ignores Claude Desktop sessions the user archived', async () => {
    const codeSessions = join(desktopDir, 'claude-code-sessions', 'a', 'o');
    await mkdir(codeSessions, { recursive: true });
    await writeFile(
      join(codeSessions, 'local_old.json'),
      JSON.stringify({
        sessionId: 'old',
        cliSessionId: 's-old',
        cwd: '/Users/me/archived',
        title: 'Archived',
        isArchived: true,
        lastActivityAt: '2026-09-02T00:00:00.000Z',
      }),
    );
    const result = await discoverClaudeProjects({
      globalConfigPath: join(root, 'missing.json'),
      projectsDir: join(root, 'missing-projects'),
      desktopDataDir: desktopDir,
    });
    expect(result.roots).toEqual([]);
  });

  it('combines registry keys, transcripts, and desktop titles into roots', async () => {
    const globalConfigPath = join(configDir, '.claude.json');
    await writeFile(
      globalConfigPath,
      JSON.stringify({
        oauthAccount: { secret: 'never-read' },
        projects: {
          '/Users/me/registry-only': { allowedTools: [] },
          'relative/not-absolute': {},
          '/Users/me/app': { lastSessionId: 's1' },
        },
      }),
    );
    const appDir = join(projectsDir, '-Users-me-app');
    await mkdir(appDir, { recursive: true });
    await writeFile(
      join(appDir, 's1.jsonl'),
      jsonl([transcriptRecord('/Users/me/app', 's1')]),
    );
    await writeFile(
      join(appDir, 's2.jsonl'),
      jsonl([
        transcriptRecord('/Users/me/app', 's2', { entrypoint: 'sdk-ts' }),
      ]),
    );
    await writeFile(join(appDir, 'empty.jsonl'), '');
    const older = new Date('2026-01-01T00:00:00.000Z');
    await utimes(join(appDir, 's2.jsonl'), older, older);

    const codeSessions = join(
      desktopDir,
      'claude-code-sessions',
      'acct',
      'org',
    );
    await mkdir(codeSessions, { recursive: true });
    await writeFile(
      join(codeSessions, 'local_abc.json'),
      JSON.stringify({
        sessionId: 'abc',
        cliSessionId: 's1',
        cwd: '/Users/me/app',
        title: 'Desktop title for s1',
        createdAt: '2026-09-01T00:00:00.000Z',
        lastActivityAt: '2026-09-02T00:00:00.000Z',
      }),
    );
    const coworkSessions = join(
      desktopDir,
      'local-agent-mode-sessions',
      'acct',
      'org',
    );
    await mkdir(coworkSessions, { recursive: true });
    await writeFile(
      join(coworkSessions, 'local_def.json'),
      JSON.stringify({
        sessionId: 'def',
        cwd: '/Users/me/notes',
        userSelectedFolders: ['/Users/me/notes', '/Users/me/docs'],
        title: 'Cowork session',
        systemPrompt: 'never surfaced',
        lastActivityAt: '2026-09-03T00:00:00.000Z',
      }),
    );

    const result = await discoverClaudeProjects({
      globalConfigPath,
      projectsDir,
      desktopDataDir: desktopDir,
    });
    expect(result.detected).toBe(true);
    expect(result.diagnostics).toEqual([]);
    const byPath = new Map(result.roots.map((root) => [root.rootPath, root]));
    // One root per path, carrying every surface that reported it.
    expect(byPath.get('/Users/me/app')?.surfaces).toEqual([
      'claude-code',
      'claude-desktop',
    ]);
    expect(Array.from(byPath.keys()).sort()).toEqual([
      '/Users/me/app',
      '/Users/me/docs',
      '/Users/me/notes',
      '/Users/me/registry-only',
    ]);
    const app = byPath.get('/Users/me/app');
    expect(app?.sessions.map((session) => session.id).sort()).toEqual([
      's1',
      's2',
    ]);
    expect(app?.sessions.find((session) => session.id === 's1')).toMatchObject({
      title: 'Desktop title for s1',
      native: true,
      kind: 'claude-jsonl',
      sourcePath: join(appDir, 's1.jsonl'),
    });
    expect(app?.sessions.find((session) => session.id === 's2')?.native).toBe(
      false,
    );
    expect(byPath.get('/Users/me/registry-only')?.sessions).toEqual([]);
    expect(byPath.get('/Users/me/notes')?.surface).toBe('claude-desktop');
    // A folder the user chose keeps its own name.
    expect(byPath.get('/Users/me/notes')?.displayName).toBeUndefined();
  });

  it('dates a transcript by its last message, not by when the file last changed', async () => {
    const appDir = join(projectsDir, '-Users-me-app');
    await mkdir(appDir, { recursive: true });
    await writeFile(
      join(appDir, 's1.jsonl'),
      jsonl([
        transcriptRecord('/Users/me/app', 's1'),
        {
          type: 'assistant',
          message: { role: 'assistant', content: [] },
          timestamp: '2026-09-01T10:00:00.000Z',
          sessionId: 's1',
        },
        // Bookkeeping Claude Code writes later is not the user working.
        {
          type: 'system',
          timestamp: '2026-10-12T14:57:48.039Z',
          sessionId: 's1',
        },
        { type: 'custom-title', customTitle: 'Renamed', sessionId: 's1' },
      ]),
    );
    // Rewritten today without a new message.
    const touched = new Date('2026-10-12T15:19:31.000Z');
    await utimes(join(appDir, 's1.jsonl'), touched, touched);

    const result = await discoverClaudeProjects({
      globalConfigPath: join(root, 'missing.json'),
      projectsDir,
      desktopDataDir: join(root, 'missing-desktop'),
    });
    const [session] = result.roots.flatMap((entry) => entry.sessions);
    expect(session?.lastActivityAt).toBe('2026-09-01T10:00:00.000Z');
    expect(result.roots[0]?.lastActivityAt).toBe('2026-09-01T10:00:00.000Z');
  });

  it('names a Cowork session run in its own scratch folder after the session', async () => {
    const coworkSessions = join(
      desktopDir,
      'local-agent-mode-sessions',
      'acct',
      'org',
    );
    await mkdir(coworkSessions, { recursive: true });
    // Claude Desktop runs a Cowork session without a chosen folder inside a
    // per-session `outputs` directory under its own data root. Dozens of
    // those would otherwise all be called "outputs".
    const scratchCwd = join(coworkSessions, 'local_def', 'outputs');
    await writeFile(
      join(coworkSessions, 'local_def.json'),
      JSON.stringify({
        sessionId: 'local_def',
        cliSessionId: 's-def',
        cwd: scratchCwd,
        userSelectedFolders: [],
        title: 'Car wash transportation',
        lastActivityAt: '2026-09-03T00:00:00.000Z',
      }),
    );
    await writeFile(
      join(coworkSessions, 'local_untitled.json'),
      JSON.stringify({
        sessionId: 'local_untitled',
        cliSessionId: 's-untitled',
        cwd: join(coworkSessions, 'local_untitled', 'outputs'),
        userSelectedFolders: [],
        lastActivityAt: '2026-09-03T00:00:00.000Z',
      }),
    );
    const result = await discoverClaudeProjects({
      globalConfigPath: join(root, 'missing.json'),
      projectsDir: join(root, 'missing-projects'),
      desktopDataDir: desktopDir,
    });
    const byPath = new Map(
      result.roots.map((entry) => [entry.rootPath, entry]),
    );
    expect(byPath.get(scratchCwd)?.displayName).toBe('Car wash transportation');
    expect(
      byPath.get(join(coworkSessions, 'local_untitled', 'outputs'))
        ?.displayName,
    ).toBeUndefined();
  });

  it('skips project directories under the app data roots without spending the scan budget on them', async () => {
    const dataDir = '/Users/me/.canopy';
    const slug = (value: string): string =>
      value.replace(/[^A-Za-z0-9-]/g, '-');
    const own = join(dataDir, 'workspaces', 'x', 'worktrees', 'y');
    // Shares the prefix only: a sibling data dir is not the app's footprint.
    const sibling = `${dataDir}2/app`;
    const external = '/Users/me/app';
    for (const [cwd, id] of [
      [own, 'own'],
      [sibling, 'sibling'],
      [external, 'ext'],
    ] as const) {
      const dir = join(projectsDir, slug(cwd));
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, `${id}.jsonl`),
        jsonl([transcriptRecord(cwd, id)]),
      );
    }
    // Newest directory first, so the app's own directory would take the
    // first slot of the budget if it were scanned at all.
    const newest = new Date('2026-09-10T00:00:00.000Z');
    await utimes(join(projectsDir, slug(own)), newest, newest);
    const result = await discoverClaudeProjects({
      globalConfigPath: join(root, 'missing.json'),
      projectsDir,
      desktopDataDir: null,
      excludedRoots: [dataDir],
      limits: { ...DEFAULT_DISCOVERY_LIMITS, maxSessionFiles: 2 },
    });
    expect(result.roots.map((entry) => entry.rootPath).sort()).toEqual(
      [sibling, external].sort(),
    );
    // Two directories left for a two-file budget: no truncation, so the
    // skipped directory never entered the scan.
    expect(result.diagnostics).toEqual([]);
  });

  it('also skips a sibling that extends an excluded root with a dash, by design', async () => {
    // The slug encoding is lossy: `~/.canopy-notes` and `~/.canopy/notes`
    // share one directory name, so no rule on the name can tell them
    // apart. Every excluded root is a home dot-directory or a temp root,
    // so the trade is accepted; pinned here so a change is deliberate.
    const dataDir = '/Users/me/.canopy';
    const sibling = '/Users/me/.canopy-notes';
    const dir = join(projectsDir, sibling.replace(/[^A-Za-z0-9-]/g, '-'));
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'sib.jsonl'),
      jsonl([transcriptRecord(sibling, 'sib')]),
    );
    const result = await discoverClaudeProjects({
      globalConfigPath: join(root, 'missing.json'),
      projectsDir,
      desktopDataDir: null,
      excludedRoots: [dataDir],
    });
    expect(result.roots).toEqual([]);
  });

  it('matches an excluded root whichever way its path is spelled', async () => {
    const dataDir = '/Users/me/.canopy';
    const slug = (value: string): string =>
      value.replace(/[^A-Za-z0-9-]/g, '-');
    const own = join(dataDir, 'workspaces', 'x');
    const external = '/Users/me/app';
    for (const [cwd, id] of [
      [own, 'own'],
      [external, 'ext'],
    ] as const) {
      const dir = join(projectsDir, slug(cwd));
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, `${id}.jsonl`),
        jsonl([transcriptRecord(cwd, id)]),
      );
    }
    // A trailing slash slugs to a different string; the resolved spelling
    // must still match the app's own directory.
    const result = await discoverClaudeProjects({
      globalConfigPath: join(root, 'missing.json'),
      projectsDir,
      desktopDataDir: null,
      excludedRoots: [`${dataDir}/`],
    });
    expect(result.roots.map((entry) => entry.rootPath)).toEqual([external]);
  });

  it('keeps every stat within the read pool across project directories', async () => {
    for (let dir = 0; dir < 4; dir += 1) {
      const cwd = `/Users/me/app-${dir}`;
      const projectDir = join(projectsDir, cwd.replace(/[^A-Za-z0-9-]/g, '-'));
      await mkdir(projectDir, { recursive: true });
      for (let file = 0; file < 6; file += 1) {
        await writeFile(
          join(projectDir, `s-${dir}-${file}.jsonl`),
          jsonl([transcriptRecord(cwd, `s-${dir}-${file}`)]),
        );
      }
    }
    mockStatTracker.peak = 0;
    const result = await discoverClaudeProjects({
      globalConfigPath: join(root, 'missing.json'),
      projectsDir,
      desktopDataDir: null,
      limits: { ...DEFAULT_DISCOVERY_LIMITS, maxConcurrentReads: 2 },
    });
    expect(result.roots).toHaveLength(4);
    // The pool is one bound for the whole scan: directory stats, file
    // stats, and head reads together, never a product of nested pools.
    expect(mockStatTracker.peak).toBeLessThanOrEqual(2);
  });

  it('bounds the number of transcripts inspected and reports it', async () => {
    const appDir = join(projectsDir, '-Users-me-app');
    await mkdir(appDir, { recursive: true });
    for (let index = 0; index < 4; index += 1) {
      await writeFile(
        join(appDir, `s${index}.jsonl`),
        jsonl([transcriptRecord('/Users/me/app', `s${index}`)]),
      );
    }
    const result = await discoverClaudeProjects({
      globalConfigPath: join(root, 'missing.json'),
      projectsDir,
      desktopDataDir: null,
      limits: { ...DEFAULT_DISCOVERY_LIMITS, maxSessionFiles: 2 },
    });
    expect(result.roots[0]?.sessions).toHaveLength(2);
    expect(result.diagnostics).toEqual([
      {
        source: 'claude-code',
        message:
          'Only 2 Claude Code sessions were scanned, the newest of each project first.',
      },
    ]);
  });

  it('spreads the transcript budget across projects instead of draining it on the newest', async () => {
    for (const name of ['alpha', 'beta']) {
      const dir = join(projectsDir, `-Users-me-${name}`);
      await mkdir(dir, { recursive: true });
      for (let index = 0; index < 3; index += 1) {
        await writeFile(
          join(dir, `${name}-${index}.jsonl`),
          jsonl([transcriptRecord(`/Users/me/${name}`, `${name}-${index}`)]),
        );
      }
    }
    const result = await discoverClaudeProjects({
      globalConfigPath: join(root, 'missing.json'),
      projectsDir,
      desktopDataDir: null,
      limits: { ...DEFAULT_DISCOVERY_LIMITS, maxSessionFiles: 4 },
    });
    const byPath = new Map(
      result.roots.map((entry) => [entry.rootPath, entry]),
    );
    // Two per project, not three from one and one from the other.
    expect(byPath.get('/Users/me/alpha')?.sessions).toHaveLength(2);
    expect(byPath.get('/Users/me/beta')?.sessions).toHaveLength(2);
    expect(result.diagnostics).toHaveLength(1);
  });

  it('skips an oversized settings file with a diagnostic instead of parsing it', async () => {
    const globalConfigPath = join(configDir, '.claude.json');
    await writeFile(
      globalConfigPath,
      JSON.stringify({ projects: { '/Users/me/huge': {} } }),
    );
    const result = await discoverClaudeProjects({
      globalConfigPath,
      projectsDir,
      desktopDataDir: null,
      limits: { ...DEFAULT_DISCOVERY_LIMITS, maxGlobalConfigBytes: 8 },
    });
    expect(result.detected).toBe(true);
    expect(result.roots).toEqual([]);
    expect(result.diagnostics[0]?.message).toMatch(
      /larger than 0 MB and was skipped/,
    );
  });

  it('flags a corrupt settings file instead of failing', async () => {
    const globalConfigPath = join(configDir, '.claude.json');
    await writeFile(globalConfigPath, '{oops');
    const result = await discoverClaudeProjects({
      globalConfigPath,
      projectsDir,
      desktopDataDir: null,
    });
    expect(result.detected).toBe(true);
    expect(result.diagnostics[0]?.message).toMatch(/could not be read as JSON/);
  });
});
