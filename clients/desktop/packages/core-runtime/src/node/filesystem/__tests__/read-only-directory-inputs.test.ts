import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as paths from 'node:path';
import {
  createDirectoryReadPreferenceSource,
  createReadOnlyDirectoryInputs,
  GitIgnoreHostError,
  listFilesystemScopeDirectory,
  listFilesystemScopeRoots,
  readFilesystemDirectory,
  readNativeRootIdentity,
  type DirectoryReadPreferenceSource,
  type FileIndexingMatchPolicy,
  type GitIgnoreCheckRequest,
  type GitIgnoredListingRequest,
  type GitIgnoreHostFailureCode,
  type GitIgnoreHostPort,
} from '../../index';
import { expectNoWrites } from './no-write-proof';

const ROOT = paths.resolve('/canonical/data');
const PRIMARY = paths.join(ROOT, 'preferences.json');
const LAST_GOOD = paths.join(ROOT, 'preferences.last-good.json');

// Mirrors `@canopy/core-platform` `createFileIndexingMatchPolicy`, which
// core-runtime cannot import.
function matchPolicyFor(
  os: 'linux' | 'darwin' | 'win32',
): FileIndexingMatchPolicy {
  return { caseSensitive: os === 'linux' };
}
const POLICY = matchPolicyFor('linux');

function envelope(preferences: unknown): string {
  return JSON.stringify({ version: 1, preferences }, null, 2);
}

const RULES = {
  fileIndexing: {
    disabledBuiltinGlobIds: ['node-modules'],
    customGlobs: [
      { id: 'dist', pattern: 'dist/**', enabled: true },
      { id: 'out', pattern: 'out/**', enabled: false },
    ],
  },
  gitExecutablePath: '  /opt/git/bin/git  ',
};
const ALTERNATE = {
  fileIndexing: {
    disabledBuiltinGlobIds: [],
    customGlobs: [{ id: 'out', pattern: 'out/**', enabled: true }],
  },
  gitExecutablePath: '/usr/local/bin/git',
};

function errorWithCode(code: string): Error {
  return Object.assign(new Error(code), { code });
}

/** Real P2 selection over an in-memory file map; counts reads per path. */
function memoryPreferences(files: Map<string, string>): {
  source: DirectoryReadPreferenceSource;
  reads: string[];
  signals: AbortSignal[];
} {
  const reads: string[] = [];
  const signals: AbortSignal[] = [];
  const source = createDirectoryReadPreferenceSource({
    canonicalDataRoot: ROOT,
    paths,
    readFile: async (absolutePath, readSignal): Promise<string> => {
      reads.push(absolutePath);
      signals.push(readSignal);
      await Promise.resolve();
      const content = files.get(absolutePath);
      if (content === undefined) throw errorWithCode('ENOENT');
      return content;
    },
  });
  return { source, reads, signals };
}

function fakeGit(
  behavior: (request: GitIgnoreCheckRequest) => Promise<Set<string>> = () =>
    Promise.resolve(new Set()),
  listing: (request: GitIgnoredListingRequest) => Promise<string[]> = () =>
    Promise.resolve([]),
): GitIgnoreHostPort & {
  requests: GitIgnoreCheckRequest[];
  listings: GitIgnoredListingRequest[];
} {
  const requests: GitIgnoreCheckRequest[] = [];
  const listings: GitIgnoredListingRequest[] = [];
  return {
    requests,
    listings,
    checkIgnoredPaths: (request): Promise<Set<string>> => {
      requests.push(request);
      return behavior(request);
    },
    listIgnoredPathEntries: (request): Promise<string[]> => {
      listings.push(request);
      return listing(request);
    },
  };
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

describe('createReadOnlyDirectoryInputs matching rules', () => {
  it('applies a disabled built-in and an enabled custom rule', async () => {
    const { source } = memoryPreferences(new Map([[PRIMARY, envelope(RULES)]]));
    const { matchingRules } = await createReadOnlyDirectoryInputs({
      preferences: source,
      matchPolicy: POLICY,
      git: fakeGit(),
    }).readOptions(signal());

    expect(matchingRules.isIndexExcluded('node_modules', 'directory')).toBe(
      false,
    );
    expect(matchingRules.isIndexExcluded('pkg/node_modules/a.js', 'file')).toBe(
      false,
    );
    expect(matchingRules.isIndexExcluded('dist', 'directory')).toBe(true);
    expect(matchingRules.isIndexExcluded('dist/a.js', 'file')).toBe(true);
    expect(matchingRules.isIndexExcluded('out/a.js', 'file')).toBe(false);
    expect(matchingRules.isIndexExcluded('.gradle', 'directory')).toBe(true);
    expect(matchingRules.isIndexExcluded('src/a.ts', 'file')).toBe(false);
  });

  it.each<['linux' | 'darwin' | 'win32', boolean]>([
    ['linux', true],
    ['darwin', false],
    ['win32', false],
  ])('matches with %s case policy', async (os, caseSensitive) => {
    const { source } = memoryPreferences(
      new Map([
        [
          PRIMARY,
          envelope({
            fileIndexing: {
              customGlobs: [{ id: 'build', pattern: 'Build/**' }],
            },
          }),
        ],
      ]),
    );
    const { matchingRules } = await createReadOnlyDirectoryInputs({
      preferences: source,
      matchPolicy: matchPolicyFor(os),
      git: fakeGit(),
    }).readOptions(signal());

    expect(matchingRules.isIndexExcluded('Build/a', 'file')).toBe(true);
    expect(matchingRules.isIndexExcluded('build/a', 'file')).toBe(
      !caseSensitive,
    );
    expect(matchingRules.isIndexExcluded('NODE_MODULES', 'directory')).toBe(
      !caseSensitive,
    );
    expect(matchingRules.isIndexExcluded('node_modules', 'directory')).toBe(
      true,
    );
  });

  it.each<{
    name: string;
    files: [string, string][];
    source: 'primary' | 'last-good' | 'defaults';
    distExcluded: boolean;
    outExcluded: boolean;
    nodeModulesExcluded: boolean;
    gitExecutablePath: string;
  }>([
    {
      name: 'a valid primary',
      files: [
        [PRIMARY, envelope(RULES)],
        [LAST_GOOD, envelope(ALTERNATE)],
      ],
      source: 'primary',
      distExcluded: true,
      outExcluded: false,
      nodeModulesExcluded: false,
      gitExecutablePath: RULES.gitExecutablePath,
    },
    {
      name: 'a corrupt primary with a valid last-good',
      files: [
        [PRIMARY, '{"version":1,"preferences":'],
        [LAST_GOOD, envelope(ALTERNATE)],
      ],
      source: 'last-good',
      distExcluded: false,
      outExcluded: true,
      nodeModulesExcluded: true,
      gitExecutablePath: ALTERNATE.gitExecutablePath,
    },
    {
      name: 'neither file',
      files: [],
      source: 'defaults',
      distExcluded: false,
      outExcluded: false,
      nodeModulesExcluded: true,
      gitExecutablePath: '',
    },
  ])(
    'composes the $source snapshot from $name',
    async ({
      files,
      source: expectedSource,
      distExcluded,
      outExcluded,
      nodeModulesExcluded,
      gitExecutablePath,
    }) => {
      const preferences = memoryPreferences(new Map(files));
      const read = jest.spyOn(preferences.source, 'read');
      const git = fakeGit(async (request) => {
        expect(await request.readSavedExecutablePath(request.signal)).toBe(
          gitExecutablePath,
        );
        return new Set();
      });
      const options = await createReadOnlyDirectoryInputs({
        preferences: preferences.source,
        matchPolicy: POLICY,
        git,
      }).readOptions(signal());

      await expect(read.mock.results[0]?.value).resolves.toMatchObject({
        source: expectedSource,
      });
      expect(options.matchingRules.isIndexExcluded('dist/a', 'file')).toBe(
        distExcluded,
      );
      expect(options.matchingRules.isIndexExcluded('out/a', 'file')).toBe(
        outExcluded,
      );
      expect(
        options.matchingRules.isIndexExcluded('node_modules', 'directory'),
      ).toBe(nodeModulesExcluded);
      await options.gitIgnore.checkIgnoredPaths('/repo', ['a']);
      expect(git.requests).toHaveLength(1);
      // The first selection reused the snapshot instead of rereading.
      expect(read).toHaveBeenCalledTimes(1);
    },
  );

  it('leaves readBoundary unset', async () => {
    const options = await createReadOnlyDirectoryInputs({
      preferences: memoryPreferences(new Map()).source,
      matchPolicy: POLICY,
      git: fakeGit(),
    }).readOptions(signal());
    expect(Object.keys(options).sort()).toEqual(['gitIgnore', 'matchingRules']);
    expect('readBoundary' in options).toBe(false);
  });
});

describe('createReadOnlyDirectoryInputs per-request reads', () => {
  it('reads preferences once per request and sees an edit on the next request', async () => {
    const files = new Map([[PRIMARY, envelope(RULES)]]);
    const preferences = memoryPreferences(files);
    const inputs = createReadOnlyDirectoryInputs({
      preferences: preferences.source,
      matchPolicy: POLICY,
      git: fakeGit(),
    });

    const first = await inputs.readOptions(signal());
    expect(preferences.reads).toEqual([PRIMARY]);
    files.set(PRIMARY, envelope(ALTERNATE));
    expect(first.matchingRules.isIndexExcluded('dist/a', 'file')).toBe(true);
    expect(first.matchingRules.isIndexExcluded('out/a', 'file')).toBe(false);

    const second = await inputs.readOptions(signal());
    expect(preferences.reads).toEqual([PRIMARY, PRIMARY]);
    expect(second.matchingRules.isIndexExcluded('dist/a', 'file')).toBe(false);
    expect(second.matchingRules.isIndexExcluded('out/a', 'file')).toBe(true);
    // The earlier request keeps its own snapshot.
    expect(first.matchingRules.isIndexExcluded('dist/a', 'file')).toBe(true);
  });

  it('returns the snapshot Git path first, then a fresh read on each later call', async () => {
    const files = new Map([[PRIMARY, envelope(RULES)]]);
    const preferences = memoryPreferences(files);
    const seen: string[] = [];
    const readsBeforeEachCall: number[] = [];
    const git = fakeGit(async (request) => {
      for (const next of ['/edited/one', '  /edited/two  ', null]) {
        readsBeforeEachCall.push(preferences.reads.length);
        seen.push(await request.readSavedExecutablePath(request.signal));
        if (next === null) files.delete(PRIMARY);
        else files.set(PRIMARY, envelope({ gitExecutablePath: next }));
      }
      readsBeforeEachCall.push(preferences.reads.length);
      seen.push(await request.readSavedExecutablePath(request.signal));
      return new Set();
    });
    const options = await createReadOnlyDirectoryInputs({
      preferences: preferences.source,
      matchPolicy: POLICY,
      git,
    }).readOptions(signal());
    files.set(PRIMARY, envelope({ gitExecutablePath: '/after/snapshot' }));

    await options.gitIgnore.checkIgnoredPaths('/repo', ['a']);

    expect(seen).toEqual([
      RULES.gitExecutablePath,
      '/edited/one',
      '  /edited/two  ',
      '',
    ]);
    // One request read, no read for the snapshot call, then one P2 read per
    // later call (the last falls back through last-good to defaults).
    expect(readsBeforeEachCall).toEqual([1, 1, 2, 3]);
    expect(preferences.reads).toEqual([
      PRIMARY,
      PRIMARY,
      PRIMARY,
      PRIMARY,
      LAST_GOOD,
    ]);
  });

  it('reads fresh Git paths with the request signal when the host passes it', async () => {
    const preferences = memoryPreferences(new Map());
    const git = fakeGit(async (request) => {
      await request.readSavedExecutablePath(request.signal);
      await request.readSavedExecutablePath(request.signal);
      return new Set();
    });
    const request = signal();
    const options = await createReadOnlyDirectoryInputs({
      preferences: preferences.source,
      matchPolicy: POLICY,
      git,
    }).readOptions(request);
    await options.gitIgnore.checkIgnoredPaths('/repo', ['a']);

    // Identity: distinct unaborted signals are deep-equal.
    expect(
      preferences.signals.map((readSignal) => readSignal === request),
    ).toEqual([true, true, true, true]);
  });

  it.each<['request' | 'selection']>([['request'], ['selection']])(
    'cancels an in-flight fresh read when the %s signal aborts',
    async (aborted) => {
      const request = new AbortController();
      const selection = new AbortController();
      const reason = new Error(`${aborted} cancelled`);
      let freshReadStarted = (): void => {};
      const started = new Promise<void>((resolve) => {
        freshReadStarted = resolve;
      });
      let readCount = 0;
      const source = createDirectoryReadPreferenceSource({
        canonicalDataRoot: ROOT,
        paths,
        // Like `fs.readFile`, settles only through its own signal.
        readFile: (_path, readSignal): Promise<string> => {
          readCount += 1;
          if (readCount === 1) return Promise.reject(errorWithCode('ENOENT'));
          if (readCount === 2) return Promise.resolve(envelope(RULES));
          freshReadStarted();
          return new Promise<void>((resolve) => {
            readSignal.addEventListener('abort', () => resolve(), {
              once: true,
            });
          }).then((): string => {
            readSignal.throwIfAborted();
            return '';
          });
        },
      });
      let outcome: unknown;
      const git = fakeGit(async (request) => {
        await request.readSavedExecutablePath(selection.signal);
        outcome = await request
          .readSavedExecutablePath(selection.signal)
          .catch((error: unknown) => error);
        return new Set();
      });
      const options = await createReadOnlyDirectoryInputs({
        preferences: source,
        matchPolicy: POLICY,
        git,
      }).readOptions(request.signal);

      const listing = options.gitIgnore
        .checkIgnoredPaths('/repo', ['a'])
        .catch((error: unknown) => error);
      await started;
      (aborted === 'request' ? request : selection).abort(reason);

      if (aborted === 'request') expect(await listing).toBe(reason);
      else expect(await listing).toEqual(new Set());
      expect(outcome).toBe(reason);
      expect(readCount).toBe(3);
    },
  );

  it('shares one snapshot use across listings of the same request', async () => {
    const files = new Map([[PRIMARY, envelope(RULES)]]);
    const preferences = memoryPreferences(files);
    const seen: string[] = [];
    const git = fakeGit(async (request) => {
      seen.push(await request.readSavedExecutablePath(request.signal));
      return new Set();
    });
    const options = await createReadOnlyDirectoryInputs({
      preferences: preferences.source,
      matchPolicy: POLICY,
      git,
    }).readOptions(signal());
    files.set(PRIMARY, envelope(ALTERNATE));

    await options.gitIgnore.checkIgnoredPaths('/repo', ['a']);
    await options.gitIgnore.checkIgnoredPaths('/repo', ['b']);

    expect(seen).toEqual([
      RULES.gitExecutablePath,
      ALTERNATE.gitExecutablePath,
    ]);
  });

  it('binds the port to the request signal, root and paths', async () => {
    const git = fakeGit(() => Promise.resolve(new Set(['b'])));
    const request = signal();
    const options = await createReadOnlyDirectoryInputs({
      preferences: memoryPreferences(new Map()).source,
      matchPolicy: POLICY,
      git,
    }).readOptions(request);

    await expect(
      options.gitIgnore.checkIgnoredPaths('/repo', ['a', 'b']),
    ).resolves.toEqual(new Set(['b']));
    expect(git.requests).toHaveLength(1);
    expect(git.requests[0]?.root).toBe('/repo');
    expect(git.requests[0]?.relativePaths).toEqual(['a', 'b']);
    expect(typeof git.requests[0]?.readSavedExecutablePath).toBe('function');
    expect(git.requests[0]?.signal).toBe(request);
  });
});

describe('createReadOnlyDirectoryInputs cancellation', () => {
  function inputs(
    git: GitIgnoreHostPort = fakeGit(),
    files = new Map([[PRIMARY, envelope(RULES)]]),
  ): {
    inputs: ReturnType<typeof createReadOnlyDirectoryInputs>;
    reads: string[];
  } {
    const preferences = memoryPreferences(files);
    return {
      inputs: createReadOnlyDirectoryInputs({
        preferences: preferences.source,
        matchPolicy: POLICY,
        git,
      }),
      reads: preferences.reads,
    };
  }

  it('rejects an aborted request with its reason without reading', async () => {
    const controller = new AbortController();
    const reason = new Error('cancelled');
    controller.abort(reason);
    const subject = inputs();

    await expect(subject.inputs.readOptions(controller.signal)).rejects.toBe(
      reason,
    );
    expect(subject.reads).toEqual([]);
  });

  it('rejects with the reason when the abort lands during the preference read', async () => {
    const controller = new AbortController();
    const reason = new Error('cancelled');
    const pending = inputs().inputs.readOptions(controller.signal);
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
  });

  it('rejects with the reason when the abort lands as the preference read settles', async () => {
    const controller = new AbortController();
    const reason = new Error('cancelled');
    const source: DirectoryReadPreferenceSource = {
      read: async () => {
        const snapshot = await memoryPreferences(new Map()).source.read(
          signal(),
        );
        controller.abort(reason);
        return snapshot;
      },
    };
    await expect(
      createReadOnlyDirectoryInputs({
        preferences: source,
        matchPolicy: POLICY,
        git: fakeGit(),
      }).readOptions(controller.signal),
    ).rejects.toBe(reason);
  });

  async function abortedAfterOptions(git: GitIgnoreHostPort): Promise<{
    options: Awaited<
      ReturnType<
        ReturnType<typeof createReadOnlyDirectoryInputs>['readOptions']
      >
    >;
    controller: AbortController;
    reason: Error;
    reads: string[];
  }> {
    const controller = new AbortController();
    const reason = new Error('cancelled');
    const subject = inputs(git);
    const options = await subject.inputs.readOptions(controller.signal);
    return { options, controller, reason, reads: subject.reads };
  }

  it('rejects the port with the reason without calling Git after an abort', async () => {
    const git = fakeGit();
    const { options, controller, reason } = await abortedAfterOptions(git);
    controller.abort(reason);

    await expect(
      options.gitIgnore.checkIgnoredPaths('/repo', ['a']),
    ).rejects.toBe(reason);
    expect(git.requests).toEqual([]);
  });

  it.each<[string, (reason: Error) => Promise<Set<string>>]>([
    [
      'a host code',
      (): Promise<Set<string>> =>
        Promise.reject(new GitIgnoreHostError('stopped')),
    ],
    ['the reason', (reason): Promise<Set<string>> => Promise.reject(reason)],
    ['a result', (): Promise<Set<string>> => Promise.resolve(new Set(['a']))],
  ])(
    'rejects with the reason when Git settles with %s after an abort',
    async (_name, settle) => {
      let abort = (): void => {};
      const reason = new Error('cancelled');
      const git = fakeGit(() => {
        abort();
        return settle(reason);
      });
      const subject = await abortedAfterOptions(git);
      abort = (): void => subject.controller.abort(reason);

      await expect(
        subject.options.gitIgnore.checkIgnoredPaths('/repo', ['a']),
      ).rejects.toBe(reason);
    },
  );

  it('rejects snapshot and fresh Git path reads with the reason after an abort', async () => {
    const outcomes: unknown[] = [];
    let abort = (): void => {};
    const git = fakeGit(async (request) => {
      abort();
      for (let call = 0; call < 2; call += 1) {
        outcomes.push(
          await request
            .readSavedExecutablePath(request.signal)
            .catch((error: unknown) => error),
        );
      }
      return new Set();
    });
    const subject = await abortedAfterOptions(git);
    abort = (): void => subject.controller.abort(subject.reason);

    await expect(
      subject.options.gitIgnore.checkIgnoredPaths('/repo', ['a']),
    ).rejects.toBe(subject.reason);
    expect(outcomes).toEqual([subject.reason, subject.reason]);
    expect(subject.reads).toEqual([PRIMARY]);
  });

  it('rejects a fresh Git path read with the reason when the abort lands mid-read', async () => {
    const reason = new Error('cancelled');
    const controller = new AbortController();
    const outcomes: unknown[] = [];
    const git = fakeGit(async (request) => {
      outcomes.push(await request.readSavedExecutablePath(request.signal));
      const fresh = request.readSavedExecutablePath(request.signal);
      controller.abort(reason);
      outcomes.push(await fresh.catch((error: unknown) => error));
      return new Set();
    });
    const subject = inputs(git);
    const options = await subject.inputs.readOptions(controller.signal);

    await expect(
      options.gitIgnore.checkIgnoredPaths('/repo', ['a']),
    ).rejects.toBe(reason);
    expect(outcomes).toEqual([RULES.gitExecutablePath, reason]);
  });

  it('rejects a Git path read when only the selection signal is aborted', async () => {
    const selection = new AbortController();
    const reason = new Error('chunk cancelled');
    selection.abort(reason);
    const git = fakeGit(async (request) => {
      await expect(
        request.readSavedExecutablePath(selection.signal),
      ).rejects.toBe(reason);
      return new Set();
    });
    const subject = inputs(git);
    const options = await subject.inputs.readOptions(signal());
    await options.gitIgnore.checkIgnoredPaths('/repo', ['a']);
    expect(git.requests).toHaveLength(1);
  });

  it('rejects a fresh Git path read when only the selection signal aborts as the read settles', async () => {
    const selection = new AbortController();
    const reason = new Error('chunk cancelled');
    const memory = memoryPreferences(new Map([[PRIMARY, envelope(RULES)]]));
    let readCount = 0;
    const source: DirectoryReadPreferenceSource = {
      read: async (readSignal) => {
        readCount += 1;
        const snapshot = await memory.source.read(readSignal);
        if (readCount === 2) selection.abort(reason);
        return snapshot;
      },
    };
    const outcomes: unknown[] = [];
    const git = fakeGit(async (request) => {
      for (let call = 0; call < 2; call += 1) {
        outcomes.push(
          await request
            .readSavedExecutablePath(selection.signal)
            .catch((error: unknown) => error),
        );
      }
      return new Set();
    });
    const options = await createReadOnlyDirectoryInputs({
      preferences: source,
      matchPolicy: POLICY,
      git,
    }).readOptions(signal());

    await expect(
      options.gitIgnore.checkIgnoredPaths('/repo', ['a']),
    ).resolves.toEqual(new Set());
    expect(outcomes).toEqual([RULES.gitExecutablePath, reason]);
    expect(readCount).toBe(2);
  });

  it('prefers the request reason when both signals abort during a fresh read', async () => {
    const request = new AbortController();
    const selection = new AbortController();
    const requestReason = new Error('request cancelled');
    const selectionReason = new Error('chunk cancelled');
    const memory = memoryPreferences(new Map([[PRIMARY, envelope(RULES)]]));
    let readCount = 0;
    const source: DirectoryReadPreferenceSource = {
      read: async (readSignal) => {
        readCount += 1;
        const snapshot = await memory.source.read(readSignal);
        if (readCount === 2) {
          selection.abort(selectionReason);
          request.abort(requestReason);
        }
        return snapshot;
      },
    };
    const outcomes: unknown[] = [];
    const git = fakeGit(async (gitRequest) => {
      for (let call = 0; call < 2; call += 1) {
        outcomes.push(
          await gitRequest
            .readSavedExecutablePath(selection.signal)
            .catch((error: unknown) => error),
        );
      }
      return new Set();
    });
    const options = await createReadOnlyDirectoryInputs({
      preferences: source,
      matchPolicy: POLICY,
      git,
    }).readOptions(request.signal);

    await expect(
      options.gitIgnore.checkIgnoredPaths('/repo', ['a']),
    ).rejects.toBe(requestReason);
    expect(outcomes).toEqual([RULES.gitExecutablePath, requestReason]);
  });

  it('prefers the request reason when the fresh read rejects after both signals abort', async () => {
    const request = new AbortController();
    const selection = new AbortController();
    const requestReason = new Error('request cancelled');
    const selectionReason = new Error('chunk cancelled');
    const memory = memoryPreferences(new Map([[PRIMARY, envelope(RULES)]]));
    let readCount = 0;
    const source: DirectoryReadPreferenceSource = {
      read: (readSignal) => {
        readCount += 1;
        if (readCount === 2) {
          selection.abort(selectionReason);
          request.abort(requestReason);
        }
        // P2 rejects with the combined signal's first reason: the selection's.
        return memory.source.read(readSignal);
      },
    };
    const outcomes: unknown[] = [];
    const git = fakeGit(async (gitRequest) => {
      for (let call = 0; call < 2; call += 1) {
        outcomes.push(
          await gitRequest
            .readSavedExecutablePath(selection.signal)
            .catch((error: unknown) => error),
        );
      }
      return new Set();
    });
    const options = await createReadOnlyDirectoryInputs({
      preferences: source,
      matchPolicy: POLICY,
      git,
    }).readOptions(request.signal);

    await expect(
      options.gitIgnore.checkIgnoredPaths('/repo', ['a']),
    ).rejects.toBe(requestReason);
    expect(outcomes).toEqual([RULES.gitExecutablePath, requestReason]);
  });
});

describe('GitIgnoreHostError', () => {
  const CODES: GitIgnoreHostFailureCode[] = [
    'git_unavailable',
    'selection_rejected',
    'invalid_request',
    'unsupported_command',
    'timeout',
    'deadline_exceeded',
    'output_limit',
    'exit_status',
    'cleanup_unconfirmed',
    'stopped',
  ];

  it('carries its code with fixed, distinct text', () => {
    const errors = CODES.map((code) => new GitIgnoreHostError(code));
    expect(errors.map((error) => error.code)).toEqual(CODES);
    for (const error of errors) {
      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe('GitIgnoreHostError');
      expect(error.message).not.toBe('');
      expect(new GitIgnoreHostError(error.code).message).toBe(error.message);
    }
    expect(new Set(errors.map((error) => error.message)).size).toBe(
      CODES.length,
    );
  });
});

describe('createReadOnlyDirectoryInputs with the directory reader', () => {
  let parent: string;
  let tree: string;

  beforeEach(async () => {
    parent = await mkdtemp(paths.join(tmpdir(), 'canopy-dir-inputs-'));
    tree = paths.join(parent, 'tree');
    for (const directory of ['node_modules', 'dist', 'out', '.gradle', 'src']) {
      await mkdir(paths.join(tree, directory), { recursive: true });
    }
    await writeFile(paths.join(tree, 'README.md'), 'readme');
  });

  afterEach(async () => {
    await rm(parent, { recursive: true, force: true });
  });

  const catalogRoot = (): {
    absolutePath: string;
    gitAware: boolean;
    excludedDescendantRoots: string[];
  } => ({ absolutePath: tree, gitAware: true, excludedDescendantRoots: [] });

  it('lists with the composed rules and the host ignore set', async () => {
    const git = fakeGit(() => Promise.resolve(new Set(['out', 'README.md'])));
    const options = await createReadOnlyDirectoryInputs({
      preferences: memoryPreferences(new Map([[PRIMARY, envelope(RULES)]]))
        .source,
      matchPolicy: POLICY,
      git,
    }).readOptions(signal());

    const entries = await readFilesystemDirectory(catalogRoot(), '', options);

    expect(
      entries.map(({ name, isIgnored, isIndexExcluded }) => [
        name,
        isIgnored,
        isIndexExcluded,
      ]),
    ).toEqual([
      ['.gradle', false, true],
      ['dist', false, true],
      ['node_modules', false, false],
      ['out', true, false],
      ['src', false, false],
      ['README.md', true, false],
    ]);
    expect(git.requests).toHaveLength(1);
    expect(git.requests[0]).toMatchObject({ root: tree });
    expect([...(git.requests[0]?.relativePaths ?? [])].sort()).toEqual(
      ['.gradle', 'README.md', 'dist', 'node_modules', 'out', 'src'].sort(),
    );
  });

  it.each<[string, () => Promise<Set<string>>]>([
    ...(
      [
        'git_unavailable',
        'selection_rejected',
        'invalid_request',
        'unsupported_command',
        'timeout',
        'deadline_exceeded',
        'output_limit',
        'exit_status',
        'cleanup_unconfirmed',
        'stopped',
      ] satisfies GitIgnoreHostFailureCode[]
    ).map((code): [string, () => Promise<Set<string>>] => [
      code,
      (): Promise<Set<string>> => Promise.reject(new GitIgnoreHostError(code)),
    ]),
    [
      'an untyped error',
      (): Promise<Set<string>> => Promise.reject(new Error('boom')),
    ],
  ])(
    'leaves entries unignored when Git fails with %s',
    async (_name, failure) => {
      const git = fakeGit(failure);
      const options = await createReadOnlyDirectoryInputs({
        preferences: memoryPreferences(new Map()).source,
        matchPolicy: POLICY,
        git,
      }).readOptions(signal());

      const entries = await readFilesystemDirectory(catalogRoot(), '', options);

      expect(entries).toHaveLength(6);
      expect(entries.every((entry) => !entry.isIgnored)).toBe(true);
      expect(git.requests).toHaveLength(1);
    },
  );
});

describe('createReadOnlyDirectoryInputs with scope listings', () => {
  let dataRoot: string;
  const scope = { workspaceId: 'project', worktreeId: 'task' };

  async function json(relative: string, document: unknown): Promise<void> {
    const target = paths.join(dataRoot, relative);
    await mkdir(paths.dirname(target), { recursive: true });
    await writeFile(target, JSON.stringify(document));
  }

  beforeEach(async () => {
    dataRoot = await mkdtemp(paths.join(tmpdir(), 'canopy-dir-inputs-scope-'));
    await json('workspaces/index.json', {
      version: 1,
      workspaces: [
        { id: 'project', name: 'Project', type: 'single-repo', color: '#fff' },
      ],
    });
    await json('workspaces/project/workspace.json', {
      version: 1,
      type: 'single-repo',
      repos: [],
    });
    await json('workspaces/project/worktrees.json', {
      version: 1,
      worktrees: [{ id: 'task', branchName: 'topic', createdAt: 'now' }],
    });
    await mkdir(
      paths.join(dataRoot, 'workspaces/project/worktrees/task/dist'),
      { recursive: true },
    );
    await writeFile(paths.join(dataRoot, 'preferences.json'), envelope(RULES));
  });

  afterEach(async () => {
    await rm(dataRoot, { recursive: true, force: true });
  });

  it('reads no inputs for roots and one snapshot per directory listing', async () => {
    const preferences = createDirectoryReadPreferenceSource({
      canonicalDataRoot: dataRoot,
      paths,
    });
    const read = jest.spyOn(preferences, 'read');
    const git = fakeGit(() => Promise.resolve(new Set(['dist'])));
    const inputs = createReadOnlyDirectoryInputs({
      preferences,
      matchPolicy: POLICY,
      git,
    });
    const dependencies = {
      dataRoot,
      authorityId: 'local',
      targetId: 'worker',
      paths,
      coworkManagedDirName: '.canopy',
      rootIdentity: readNativeRootIdentity,
    };

    // Roots take no directory options, so the composer is never consulted.
    expect(listFilesystemScopeRoots).toHaveLength(2);
    const roots = await listFilesystemScopeRoots({ scope }, dependencies);
    expect(roots.roots).toMatchObject([{ fileRootId: 'project' }]);
    expect(read).not.toHaveBeenCalled();
    expect(git.requests).toEqual([]);

    const request = signal();
    const options = await inputs.readOptions(request);
    const result = await listFilesystemScopeDirectory(
      { scope, fileRootId: 'project', relativePath: '' },
      dependencies,
      options,
    );
    request.throwIfAborted();

    expect(result.entries).toMatchObject([
      { name: 'dist', isIgnored: true, isIndexExcluded: true },
    ]);
    expect(read).toHaveBeenCalledTimes(1);
    expect(git.requests).toHaveLength(1);
    expect(git.requests[0]).toMatchObject({
      root: paths.join(dataRoot, 'workspaces/project/worktrees/task'),
      relativePaths: ['dist'],
    });
    expect(git.requests[0]?.signal).toBe(request);
  });
});

describe('createReadOnlyDirectoryInputs no-write proof', () => {
  const OLD_TIME = new Date('2024-01-02T03:04:05.000Z');
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(paths.join(tmpdir(), 'canopy-dir-inputs-nowrite-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function seed(
    files: Record<string, { content: string; mode: number }>,
  ): Promise<void> {
    const all = {
      ...files,
      'preferences.backup-2026-01-01T00-00-00-000Z.json': {
        content: envelope(ALTERNATE),
        mode: 0o600,
      },
      'preferences.backup-2026-02-01T00-00-00-000Z.json': {
        content: '{"__error":{"reason":"parse"},"rawContent":"{"}',
        mode: 0o640,
      },
      '.preferences.json.123.456-1.tmp': { content: 'partial', mode: 0o600 },
    };
    for (const [relative, { content, mode }] of Object.entries(all)) {
      const absolute = paths.join(root, relative);
      await writeFile(absolute, content);
      await chmod(absolute, mode);
      await utimes(absolute, OLD_TIME, OLD_TIME);
    }
    await utimes(root, OLD_TIME, OLD_TIME);
  }

  it.each<[string, Record<string, { content: string; mode: number }>]>([
    [
      'a valid primary',
      {
        'preferences.json': { content: envelope(RULES), mode: 0o600 },
        'preferences.last-good.json': {
          content: envelope(ALTERNATE),
          mode: 0o640,
        },
      },
    ],
    [
      'a corrupt primary with a valid last-good',
      {
        'preferences.json': { content: '{"version":', mode: 0o644 },
        'preferences.last-good.json': {
          content: envelope(ALTERNATE),
          mode: 0o600,
        },
      },
    ],
    ['absent primary and last-good', {}],
  ])(
    'leaves preferences, last-good and backups unchanged with %s',
    async (_name, files) => {
      await seed(files);
      const git = fakeGit(async (request) => {
        for (let chunk = 0; chunk < 3; chunk += 1) {
          await request.readSavedExecutablePath(request.signal);
        }
        return new Set();
      });
      const inputs = createReadOnlyDirectoryInputs({
        preferences: createDirectoryReadPreferenceSource({
          canonicalDataRoot: root,
          paths,
        }),
        matchPolicy: POLICY,
        git,
      });

      await expectNoWrites(root, async () => {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const options = await inputs.readOptions(signal());
          await options.gitIgnore.checkIgnoredPaths(root, ['a']);
          options.matchingRules.isIndexExcluded('dist/a', 'file');
        }
      });
      expect(git.requests).toHaveLength(2);
    },
  );
});

it('imports no host, platform, writer or desktop module', async () => {
  const source = await readFile(
    paths.join(__dirname, '..', 'read-only-directory-inputs.ts'),
    'utf8',
  );
  const specifiers = Array.from(
    source.matchAll(/^import\s+[\s\S]*?\s+from\s+'([^']+)';$/gm),
    ([, specifier]) => specifier,
  );
  expect(specifiers).toEqual([
    './directory-reader',
    './directory-read-preferences',
    './file-indexing',
    // Type-only: the search engine's input shape (CAN-5037).
    './file-search',
  ]);
  expect(source.match(/^\s*import\b/gm)).toHaveLength(specifiers.length);
  expect(source).not.toMatch(/\b(?:require|import)\s*\(|process\.platform/);
});

describe('createReadOnlyDirectoryInputs search options', () => {
  it('builds the mentions and explorer matchers from one preference read', async () => {
    const files = new Map([[PRIMARY, envelope(RULES)]]);
    const preferences = memoryPreferences(files);
    const inputs = createReadOnlyDirectoryInputs({
      preferences: preferences.source,
      matchPolicy: POLICY,
      git: fakeGit(),
    });
    const mentions = await inputs.searchOptions(signal(), 'mentions');
    expect(preferences.reads).toEqual([PRIMARY]);
    expect(mentions.policy).toBe(POLICY);
    expect(mentions.matcher.isIndexExcluded('dist/a', 'file')).toBe(true);
    // RULES disables the node_modules built-in for mentions.
    expect(mentions.matcher.isIndexExcluded('node_modules/a', 'file')).toBe(
      false,
    );
    expect(mentions.matcher.isTraversalDeferred).toBeUndefined();
    const explorer = await inputs.searchOptions(signal(), 'file-explorer');
    expect(explorer.matcher.isIndexExcluded('dist/a', 'file')).toBe(false);
    expect(explorer.matcher.isIndexExcluded('.git/config', 'file')).toBe(true);
    expect(explorer.matcher.isTraversalDeferred?.('node_modules')).toBe(true);
    expect('readBoundary' in explorer).toBe(false);
  });

  it('lists ignored paths with the snapshot Git path, then a fresh read', async () => {
    const files = new Map([[PRIMARY, envelope(RULES)]]);
    const preferences = memoryPreferences(files);
    const seen: string[] = [];
    const git = fakeGit(undefined, async (request) => {
      seen.push(await request.readSavedExecutablePath(request.signal));
      return ['dist/', 'debug.log'];
    });
    const { listIgnoredPathEntries } = await createReadOnlyDirectoryInputs({
      preferences: preferences.source,
      matchPolicy: POLICY,
      git,
    }).searchOptions(signal(), 'mentions');
    if (!listIgnoredPathEntries) throw new Error('Expected a listing.');
    await expect(listIgnoredPathEntries('/repo')).resolves.toEqual([
      'dist/',
      'debug.log',
    ]);
    files.set(PRIMARY, envelope(ALTERNATE));
    await listIgnoredPathEntries('/repo');
    expect(seen).toEqual([
      RULES.gitExecutablePath,
      ALTERNATE.gitExecutablePath,
    ]);
    expect(git.listings.map(({ root }) => root)).toEqual(['/repo', '/repo']);
    expect(git.requests).toEqual([]);
  });

  it('reports the request abort instead of a racing listing failure', async () => {
    const controller = new AbortController();
    const reason = new Error('request aborted');
    const git = fakeGit(undefined, () => {
      controller.abort(reason);
      return Promise.reject(new GitIgnoreHostError('timeout'));
    });
    const { listIgnoredPathEntries } = await createReadOnlyDirectoryInputs({
      preferences: memoryPreferences(new Map()).source,
      matchPolicy: POLICY,
      git,
    }).searchOptions(controller.signal, 'mentions');
    if (!listIgnoredPathEntries) throw new Error('Expected a listing.');
    await expect(listIgnoredPathEntries('/repo')).rejects.toBe(reason);
    // An aborted request never reaches the host again.
    await expect(listIgnoredPathEntries('/repo')).rejects.toBe(reason);
    expect(git.listings).toHaveLength(1);
  });
});
