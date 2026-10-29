import path from 'node:path';
import {
  externalProjectCandidateId,
  normalizeDiscoveredRoots,
  type ExistingWorkspaceIdentity,
  type NormalizeContext,
  type NormalizeDeps,
} from '../normalize';
import type { DiscoveredRoot, DiscoveredSession } from '../types';

/**
 * Fake filesystem: `directories` exist, `symlinks` resolve to another entry,
 * `repos` maps a directory to its git top level, `commonDirs` maps a top
 * level to its git common dir.
 */
function fakeDeps(world: {
  directories: string[];
  symlinks?: Record<string, string>;
  repos?: Record<string, string>;
  commonDirs?: Record<string, string>;
}): NormalizeDeps {
  const symlinks = world.symlinks ?? {};
  const repos = world.repos ?? {};
  const commonDirs = world.commonDirs ?? {};
  return {
    realpath: (candidate): Promise<string> => {
      const resolved = symlinks[candidate] ?? candidate;
      if (!world.directories.includes(resolved)) {
        return Promise.reject(new Error(`ENOENT ${candidate}`));
      }
      return Promise.resolve(resolved);
    },
    isDirectory: (candidate): Promise<boolean> =>
      Promise.resolve(world.directories.includes(candidate)),
    gitTopLevel: (directory): Promise<string | null> =>
      Promise.resolve(repos[directory] ?? null),
    gitCommonDir: (topLevel): Promise<string | null> =>
      Promise.resolve(commonDirs[topLevel] ?? null),
  };
}

function session(
  id: string,
  cwd: string,
  extra: Partial<DiscoveredSession> = {},
): DiscoveredSession {
  return {
    id,
    provider: 'claude',
    surface: 'claude-code',
    kind: 'claude-jsonl',
    cwd,
    sourcePath: `/claude/projects/x/${id}.jsonl`,
    title: `Title ${id}`,
    startedAt: '2026-09-01T00:00:00.000Z',
    lastActivityAt: '2026-09-02T00:00:00.000Z',
    sizeBytes: 10,
    native: true,
    ...extra,
  };
}

function root(
  rootPath: string,
  extra: Partial<DiscoveredRoot> = {},
): DiscoveredRoot {
  return {
    provider: 'claude',
    surface: 'claude-code',
    rootPath,
    lastActivityAt: null,
    sessions: [],
    ...extra,
  };
}

function context(overrides: Partial<NormalizeContext> = {}): NormalizeContext {
  return {
    excludedRoots: ['/Users/me/.canopy', '/tmp'],
    excludedExact: ['/Users/me'],
    existingWorkspaces: [],
    ledger: { imports: {}, lastScanAt: null, inviteShownAt: null },
    sessionScratchRoots: [],
    maxSessionsPerCandidate: 50,
    maxUnavailableCandidates: 25,
    ...overrides,
  };
}

describe('normalizeDiscoveredRoots', () => {
  it('drops excluded, missing-without-chats, and home roots', async () => {
    const deps = fakeDeps({
      directories: [
        '/Users/me',
        '/Users/me/.canopy/workspaces/x',
        '/tmp/scratch',
        '/Users/me/app',
      ],
    });
    const result = await normalizeDiscoveredRoots(
      [
        root('/Users/me'),
        root('/Users/me/.canopy/workspaces/x'),
        root('/tmp/scratch'),
        root('/Users/me/gone'),
        root('/Users/me/app'),
      ],
      context(),
      deps,
    );
    expect(result.candidates.map((candidate) => candidate.rootPath)).toEqual([
      '/Users/me/app',
    ]);
    expect(result.candidates[0]).toMatchObject({
      id: externalProjectCandidateId('/Users/me/app'),
      kind: 'folder',
      status: 'available',
      providers: ['claude'],
      displayName: 'app',
    });
  });

  it('attaches subdirectory sessions to the repository root and merges providers', async () => {
    const deps = fakeDeps({
      directories: ['/Users/me/repo', '/Users/me/repo/backend'],
      repos: {
        '/Users/me/repo': '/Users/me/repo',
        '/Users/me/repo/backend': '/Users/me/repo',
      },
      commonDirs: { '/Users/me/repo': '/Users/me/repo/.git' },
    });
    const result = await normalizeDiscoveredRoots(
      [
        root('/Users/me/repo/backend', {
          sessions: [session('s-sub', '/Users/me/repo/backend')],
        }),
        root('/Users/me/repo', {
          provider: 'codex',
          surface: 'codex-desktop',
          displayName: 'Repo (desktop)',
          sessions: [
            session('t-1', '/Users/me/repo', {
              provider: 'codex',
              surface: 'codex-cli',
              kind: 'codex-rollout',
              lastActivityAt: '2026-09-05T00:00:00.000Z',
            }),
          ],
        }),
      ],
      context(),
      deps,
    );
    expect(result.candidates).toHaveLength(1);
    const candidate = result.candidates[0];
    expect(candidate).toMatchObject({
      rootPath: '/Users/me/repo',
      kind: 'git',
      displayName: 'Repo (desktop)',
      providers: ['claude', 'codex'],
      surfaces: ['claude-code', 'codex-cli', 'codex-desktop'],
      sessionCount: 2,
      importableSessionCount: 2,
      lastActivityAt: '2026-09-05T00:00:00.000Z',
    });
    expect(candidate?.sessions.map((entry) => entry.id)).toEqual([
      't-1',
      's-sub',
    ]);
  });

  it('gives a picked folder no provider of its own, even when it is also a Codex root', async () => {
    const deps = fakeDeps({
      directories: ['/Users/me/notes', '/Users/me/odd'],
    });
    const result = await normalizeDiscoveredRoots(
      [
        root('/Users/me/notes', {
          provider: 'codex',
          surface: 'codex-cli',
          sessions: [
            session('t-1', '/Users/me/notes', {
              provider: 'codex',
              surface: 'codex-cli',
              kind: 'codex-rollout',
            }),
          ],
        }),
        // The picker tags its roots with a placeholder provider.
        root('/Users/me/notes', {
          provider: 'claude',
          surface: 'custom-folder',
        }),
        root('/Users/me/odd', { provider: 'claude', surface: 'custom-folder' }),
      ],
      context(),
      deps,
    );
    const byPath = new Map(
      result.candidates.map((candidate) => [candidate.rootPath, candidate]),
    );
    expect(byPath.get('/Users/me/notes')).toMatchObject({
      providers: ['codex'],
      surfaces: ['codex-cli', 'custom-folder'],
    });
    expect(byPath.get('/Users/me/odd')?.providers).toEqual([]);
  });

  it('folds linked worktrees into the main checkout family', async () => {
    const deps = fakeDeps({
      directories: ['/Users/me/repo', '/Users/me/repo-wt'],
      repos: {
        '/Users/me/repo': '/Users/me/repo',
        '/Users/me/repo-wt': '/Users/me/repo-wt',
      },
      commonDirs: {
        '/Users/me/repo': '/Users/me/repo/.git',
        '/Users/me/repo-wt': '/Users/me/repo/.git',
      },
    });
    const result = await normalizeDiscoveredRoots(
      [
        root('/Users/me/repo-wt', {
          sessions: [session('wt', '/Users/me/repo-wt')],
        }),
      ],
      context(),
      deps,
    );
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      rootPath: '/Users/me/repo',
      linkedWorktreePaths: ['/Users/me/repo-wt'],
      sessionCount: 1,
    });
  });

  it('marks tracked, same-repository, nested, and containing roots', async () => {
    const existing: ExistingWorkspaceIdentity[] = [
      {
        id: 'site',
        name: 'Site',
        type: 'single-repo',
        rootPaths: ['/Users/me/site'],
        gitCommonDirs: ['/Users/me/site/.git'],
      },
      {
        id: 'notes',
        name: 'Notes',
        type: 'cowork',
        rootPaths: ['/Users/me/notes'],
        gitCommonDirs: [],
      },
    ];
    const deps = fakeDeps({
      directories: [
        '/Users/me/site',
        '/Users/me/site-clone-wt',
        '/Users/me/notes/sub',
        '/Users/me/parent',
        '/Users/me/other',
      ],
      repos: {
        '/Users/me/site': '/Users/me/site',
        '/Users/me/site-clone-wt': '/Users/me/site-clone-wt',
      },
      commonDirs: {
        '/Users/me/site': '/Users/me/site/.git',
        '/Users/me/site-clone-wt': '/Users/me/site/.git',
      },
    });
    const result = await normalizeDiscoveredRoots(
      [
        root('/Users/me/site'),
        root('/Users/me/notes/sub'),
        root('/Users/me/parent'),
        root('/Users/me/other'),
      ],
      context({
        existingWorkspaces: [
          ...existing,
          {
            id: 'child',
            name: 'Child',
            type: 'cowork',
            rootPaths: ['/Users/me/parent/child'],
            gitCommonDirs: [],
          },
        ],
      }),
      deps,
    );
    const byPath = new Map(
      result.candidates.map((candidate) => [candidate.rootPath, candidate]),
    );
    expect(byPath.get('/Users/me/site')).toMatchObject({
      status: 'already-tracked',
      trackedWorkspaceId: 'site',
      statusReason: 'Already in your projects as "Site"',
    });
    expect(byPath.get('/Users/me/notes/sub')).toMatchObject({
      status: 'already-tracked',
      trackedWorkspaceId: 'notes',
      statusReason: 'Inside your project "Notes"',
    });
    expect(byPath.get('/Users/me/parent')).toMatchObject({
      status: 'unavailable',
      statusReason:
        'Contains your project "Child", so it cannot be added as one project',
    });
    expect(byPath.get('/Users/me/other')?.status).toBe('available');
  });

  it('reports ledger imports and already-imported sessions', async () => {
    const id = externalProjectCandidateId('/Users/me/app');
    const deps = fakeDeps({ directories: ['/Users/me/app'] });
    const result = await normalizeDiscoveredRoots(
      [
        root('/Users/me/app', {
          sessions: [
            session('s1', '/Users/me/app'),
            session('s2', '/Users/me/app'),
          ],
        }),
      ],
      context({
        existingWorkspaces: [
          {
            id: 'app',
            name: 'App',
            type: 'cowork',
            rootPaths: ['/Users/me/app'],
            gitCommonDirs: [],
          },
        ],
        ledger: {
          imports: {
            [id]: {
              workspaceId: 'app',
              rootPath: '/Users/me/app',
              providers: ['claude'],
              importedAt: '2026-09-01T00:00:00.000Z',
              sessions: {
                s1: {
                  chatId: 'chat-1',
                  worktreeId: 'entry-1',
                  importedAt: '2026-09-01T00:00:00.000Z',
                },
              },
            },
          },
          lastScanAt: null,
          inviteShownAt: null,
        },
      }),
      deps,
    );
    expect(result.candidates[0]).toMatchObject({
      status: 'already-imported',
      trackedWorkspaceId: 'app',
      sessionCount: 2,
      importableSessionCount: 1,
    });
    expect(
      result.candidates[0]?.sessions.find((entry) => entry.id === 's1')
        ?.importedChatId,
    ).toBe('chat-1');
  });

  it('keeps missing folders with chats as bounded unavailable candidates', async () => {
    const deps = fakeDeps({ directories: [] });
    const roots = ['a', 'b', 'c'].map((name) =>
      root(`/Users/me/${name}`, {
        sessions: [session(`s-${name}`, `/Users/me/${name}`)],
        lastActivityAt: `2026-09-0${name === 'a' ? 3 : name === 'b' ? 2 : 1}T00:00:00.000Z`,
      }),
    );
    // A deleted worktree under the data dir is Canopy's own footprint even
    // though it can no longer be canonicalized; it must not be offered.
    roots.push(
      root('/Users/me/.canopy/workspaces/x/worktrees/gone', {
        sessions: [
          session('s-gone', '/Users/me/.canopy/workspaces/x/worktrees/gone', {
            lastActivityAt: '2026-09-09T00:00:00.000Z',
          }),
        ],
        lastActivityAt: '2026-09-09T00:00:00.000Z',
      }),
    );
    const result = await normalizeDiscoveredRoots(
      roots,
      context({ maxUnavailableCandidates: 2 }),
      deps,
    );
    expect(result.candidates.map((candidate) => candidate.rootPath)).toEqual([
      '/Users/me/a',
      '/Users/me/b',
    ]);
    expect(result.candidates[0]).toMatchObject({
      status: 'unavailable',
      sessionCount: 1,
      importableSessionCount: 0,
    });
    expect(result.diagnostics).toEqual([
      {
        source: 'discovery',
        message: '1 more folders with chats no longer exist and were left out.',
      },
    ]);
  });

  it('drops non-native sessions from the listing but keeps the root', async () => {
    const deps = fakeDeps({ directories: ['/Users/me/app'] });
    const result = await normalizeDiscoveredRoots(
      [
        root('/Users/me/app', {
          sessions: [session('sdk', '/Users/me/app', { native: false })],
        }),
      ],
      context(),
      deps,
    );
    expect(result.candidates[0]).toMatchObject({
      sessionCount: 0,
      status: 'available',
    });
  });

  it('resolves symlinked roots to one candidate', async () => {
    const deps = fakeDeps({
      directories: ['/Users/me/real'],
      symlinks: { '/Users/me/link': '/Users/me/real' },
    });
    const result = await normalizeDiscoveredRoots(
      [root('/Users/me/link'), root('/Users/me/real')],
      context(),
      deps,
    );
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.id).toBe(
      externalProjectCandidateId(path.resolve('/Users/me/real')),
    );
  });

  it('caps the listed sessions but keeps every native session importable', async () => {
    const deps = fakeDeps({ directories: ['/Users/me/app'] });
    const sessions = Array.from({ length: 5 }, (_value, index) =>
      session(`s${index}`, '/Users/me/app', {
        lastActivityAt: `2026-09-0${index + 1}T00:00:00.000Z`,
      }),
    );
    const result = await normalizeDiscoveredRoots(
      [root('/Users/me/app', { sessions })],
      context({ maxSessionsPerCandidate: 2 }),
      deps,
    );
    const candidate = result.candidates[0];
    expect(candidate?.sessions.map((entry) => entry.id)).toEqual(['s4', 's3']);
    expect(candidate).toMatchObject({
      sessionCount: 5,
      importableSessionCount: 5,
    });
    expect(result.nativeSessionIdsByCandidate.get(candidate?.id ?? '')).toEqual(
      ['s4', 's3', 's2', 's1', 's0'],
    );
  });

  it('names a provider scratch folder after its newest titled chat', async () => {
    // Claude Desktop runs folder-less Cowork sessions in a per-session
    // `outputs` directory, and Codex can re-import those sessions with the
    // same cwd, so neither provider's evidence may carry a project name.
    const scratch =
      '/Users/me/Library/Application Support/Claude/local-agent-mode-sessions';
    const a = `${scratch}/acct/org/local_a/outputs`;
    const b = `${scratch}/acct/org/local_b/outputs`;
    const deps = fakeDeps({ directories: [a, b] });
    const codex: Partial<DiscoveredSession> = {
      provider: 'codex',
      surface: 'codex-cli',
      kind: 'codex-rollout',
    };
    const result = await normalizeDiscoveredRoots(
      [
        root(a, {
          provider: 'codex',
          surface: 'codex-cli',
          sessions: [
            session('t-old', a, {
              ...codex,
              title: 'Older chat',
              lastActivityAt: '2026-09-01T00:00:00.000Z',
            }),
            session('t-new', a, {
              ...codex,
              title: 'Car wash transportation',
              lastActivityAt: '2026-09-05T00:00:00.000Z',
            }),
          ],
        }),
        root(b, { sessions: [session('s-b', b, { title: null })] }),
      ],
      context({ sessionScratchRoots: [scratch] }),
      deps,
    );
    const byPath = new Map(
      result.candidates.map((candidate) => [candidate.rootPath, candidate]),
    );
    expect(byPath.get(a)?.displayName).toBe('Car wash transportation');
    // No title anywhere: the folder still gets enough path to be told apart.
    expect(byPath.get(b)?.displayName).toBe('local_b/outputs');
    // The id stays derived from the path, never from the display name.
    expect(byPath.get(a)?.id).toBe(externalProjectCandidateId(a));
  });

  it('tells apart folders that share a name by their parent folders', async () => {
    const paths = [
      '/Users/me/work/a/notes',
      '/Users/me/work/b/notes',
      '/Users/me/x/p/notes',
      '/Users/me/y/p/notes',
      '/Users/me/other',
    ];
    const deps = fakeDeps({ directories: paths });
    const result = await normalizeDiscoveredRoots(
      paths.map((rootPath) => root(rootPath)),
      context(),
      deps,
    );
    const names = new Map(
      result.candidates.map((candidate) => [
        candidate.rootPath,
        candidate.displayName,
      ]),
    );
    expect(names.get('/Users/me/work/a/notes')).toBe('a/notes');
    expect(names.get('/Users/me/work/b/notes')).toBe('b/notes');
    // Still tied after one parent: keep adding parents until distinct.
    expect(names.get('/Users/me/x/p/notes')).toBe('x/p/notes');
    expect(names.get('/Users/me/y/p/notes')).toBe('y/p/notes');
    // A unique name stays a plain folder name.
    expect(names.get('/Users/me/other')).toBe('other');
  });

  it('keeps widening colliding scratch names past their starting two folders', async () => {
    // Two untitled scratch folders whose names already start at two
    // segments; the widening must escalate to three instead of stopping
    // because the first pass changed nothing.
    const a = '/A/local_x/outputs';
    const b = '/B/local_x/outputs';
    const deps = fakeDeps({ directories: [a, b] });
    const result = await normalizeDiscoveredRoots(
      [
        root(a, { sessions: [session('s-a', a, { title: null })] }),
        root(b, { sessions: [session('s-b', b, { title: null })] }),
      ],
      context({ sessionScratchRoots: ['/A', '/B'] }),
      deps,
    );
    expect(
      result.candidates.map((candidate) => candidate.displayName).sort(),
    ).toEqual(['A/local_x/outputs', 'B/local_x/outputs']);
  });

  it('keeps provider project names as the source wrote them, even when they repeat', async () => {
    const deps = fakeDeps({
      directories: ['/Users/me/site', '/Users/me/site-copy'],
    });
    const result = await normalizeDiscoveredRoots(
      [
        root('/Users/me/site', {
          provider: 'codex',
          surface: 'codex-desktop',
          displayName: 'Website',
        }),
        root('/Users/me/site-copy', {
          provider: 'codex',
          surface: 'codex-desktop',
          displayName: 'Website',
        }),
      ],
      context(),
      deps,
    );
    expect(result.candidates.map((candidate) => candidate.displayName)).toEqual(
      ['Website', 'Website'],
    );
  });

  it('names missing folders the same way as present ones', async () => {
    const scratch =
      '/Users/me/Library/Application Support/Claude/local-agent-mode-sessions';
    const gone = `${scratch}/acct/org/local_gone/outputs`;
    const deps = fakeDeps({ directories: [] });
    const result = await normalizeDiscoveredRoots(
      [
        root(gone, {
          sessions: [session('s-gone', gone, { title: null })],
        }),
        // Both providers report the missing scratch folder; only one of them
        // knows the title.
        root(gone, {
          provider: 'codex',
          surface: 'codex-cli',
          sessions: [
            session('t-gone', gone, {
              provider: 'codex',
              surface: 'codex-cli',
              kind: 'codex-rollout',
              title: 'Trip planning',
            }),
          ],
        }),
        root('/Users/me/a/notes', {
          sessions: [session('s-a', '/Users/me/a/notes', { title: null })],
        }),
        root('/Users/me/b/notes', {
          sessions: [session('s-b', '/Users/me/b/notes', { title: null })],
        }),
      ],
      context({ sessionScratchRoots: [scratch] }),
      deps,
    );
    const names = new Map(
      result.candidates.map((candidate) => [
        candidate.rootPath,
        candidate.displayName,
      ]),
    );
    expect(
      result.candidates.every(
        (candidate) => candidate.status === 'unavailable',
      ),
    ).toBe(true);
    expect(names.get(gone)).toBe('Trip planning');
    expect(names.get('/Users/me/a/notes')).toBe('a/notes');
    expect(names.get('/Users/me/b/notes')).toBe('b/notes');
  });

  it('keeps a provider name for a missing folder whichever adapter reports it first', async () => {
    const deps = fakeDeps({ directories: [] });
    const named = root('/Users/me/gone', {
      provider: 'codex',
      surface: 'codex-desktop',
      displayName: 'Website',
      sessions: [
        session('t-1', '/Users/me/gone', {
          provider: 'codex',
          surface: 'codex-cli',
          kind: 'codex-rollout',
          title: null,
        }),
      ],
    });
    const unnamed = root('/Users/me/gone', {
      sessions: [session('s-1', '/Users/me/gone', { title: null })],
    });
    // Adapters run concurrently, so either root can be recorded first.
    for (const roots of [
      [named, unnamed],
      [unnamed, named],
    ]) {
      const result = await normalizeDiscoveredRoots(roots, context(), deps);
      expect(
        result.candidates.map((candidate) => candidate.displayName),
      ).toEqual(['Website']);
      expect(result.candidates[0]?.status).toBe('unavailable');
    }
  });

  it('names a present folder the same whichever adapter reports it first', async () => {
    // Both providers can name the same folder: Claude Desktop's session
    // title for its scratch folder, and the Codex thread name for a chat
    // re-imported there. The merge keeps the first non-empty name, so the
    // roots are ordered before grouping and the name does not flip between
    // scans as the adapters race.
    const deps = fakeDeps({ directories: ['/Users/me/site'] });
    const claudeNamed = root('/Users/me/site', {
      displayName: 'Landing page',
      sessions: [session('s-1', '/Users/me/site', { title: null })],
    });
    const codexNamed = root('/Users/me/site', {
      provider: 'codex',
      surface: 'codex-desktop',
      displayName: 'Website',
      sessions: [
        session('t-1', '/Users/me/site', {
          provider: 'codex',
          surface: 'codex-cli',
          kind: 'codex-rollout',
          title: null,
        }),
      ],
    });
    const names = new Set<string>();
    for (const roots of [
      [claudeNamed, codexNamed],
      [codexNamed, claudeNamed],
    ]) {
      const result = await normalizeDiscoveredRoots(roots, context(), deps);
      expect(result.candidates).toHaveLength(1);
      names.add(result.candidates[0]?.displayName ?? '');
    }
    expect(names.size).toBe(1);
  });

  it('groups two spellings of one missing folder into one row', async () => {
    // A provider can record a cwd with a trailing separator or a `.`
    // segment; grouping, naming, and the id all use one normalized form,
    // so the spellings never become two rows sharing an id.
    const deps = fakeDeps({ directories: [] });
    const result = await normalizeDiscoveredRoots(
      [
        root('/Users/me/gone/', {
          sessions: [session('s-1', '/Users/me/gone/', { title: null })],
        }),
        root('/Users/me/./gone', {
          provider: 'codex',
          surface: 'codex-desktop',
          sessions: [
            session('t-1', '/Users/me/./gone', {
              provider: 'codex',
              surface: 'codex-cli',
              kind: 'codex-rollout',
              title: null,
            }),
          ],
        }),
      ],
      context(),
      deps,
    );
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.rootPath).toBe('/Users/me/gone');
    expect(result.candidates[0]?.providers).toEqual(['claude', 'codex']);
  });

  it('lists folders without activity in one order whichever adapter finishes first', async () => {
    const deps = fakeDeps({
      directories: ['/Users/me/alpha', '/Users/me/Beta'],
    });
    const alpha = root('/Users/me/alpha', {
      sessions: [],
      lastActivityAt: null,
    });
    const beta = root('/Users/me/Beta', {
      provider: 'codex',
      surface: 'codex-desktop',
      sessions: [],
      lastActivityAt: null,
    });
    for (const roots of [
      [alpha, beta],
      [beta, alpha],
    ]) {
      const result = await normalizeDiscoveredRoots(roots, context(), deps);
      // Alphabetical regardless of case, and the same on every machine.
      expect(result.candidates.map((c) => c.rootPath)).toEqual([
        '/Users/me/alpha',
        '/Users/me/Beta',
      ]);
    }
  });

  it('resolves the git common dir once per repository top level', async () => {
    const deps = fakeDeps({
      directories: ['/Users/me/repo', '/Users/me/repo/a', '/Users/me/repo/b'],
      repos: {
        '/Users/me/repo': '/Users/me/repo',
        '/Users/me/repo/a': '/Users/me/repo',
        '/Users/me/repo/b': '/Users/me/repo',
      },
      commonDirs: { '/Users/me/repo': '/Users/me/repo/.git' },
    });
    const gitCommonDir = jest.fn((topLevel: string) =>
      deps.gitCommonDir(topLevel),
    );
    await normalizeDiscoveredRoots(
      [
        root('/Users/me/repo/a'),
        root('/Users/me/repo/b'),
        root('/Users/me/repo'),
      ],
      context(),
      { ...deps, gitCommonDir },
    );
    expect(gitCommonDir).toHaveBeenCalledTimes(1);
  });
});
