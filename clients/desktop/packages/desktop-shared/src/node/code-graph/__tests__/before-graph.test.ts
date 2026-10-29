import { DatabaseSync } from 'node:sqlite';
import {
  BEFORE_CACHE_MAX_ENTRIES,
  readBeforeCache,
  writeBeforeCache,
  beforeCacheIdentity,
} from '../impact/before-cache';
import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  cpSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { getBundledCodeGraphDir } from '../../../pipelines/config-paths';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { getDiffRanges, type ChangedFileRanges } from '../git/diff';
import { CodeGraphParserRuntime } from '../parser/runtime';
import { CodeGraphEngine } from '../engine';
import {
  BEFORE_GRAPH_MAX_SCOPED_FILES,
  BEFORE_GRAPH_TEMP_PREFIX,
  buildBeforeGraphForChanges,
  getBeforeGraphRuntimeForTests,
  resetBeforeGraphRuntimeForTests,
} from '../impact/before-graph';

function git(root: string, args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
  }).trim();
}

function commitAll(root: string, message: string): string {
  git(root, ['add', '-A']);
  git(root, [
    '-c',
    'user.email=t@t',
    '-c',
    'user.name=t',
    'commit',
    '--quiet',
    '-m',
    message,
  ]);
  return git(root, ['rev-parse', 'HEAD']);
}

// `buildBeforeGraphForChanges`'s temp workspace has no public escape hatch
// for its path (by design — see before-graph.ts's contract), so cleanup is
// verified by diffing os.tmpdir()'s `BEFORE_GRAPH_TEMP_PREFIX*` entries
// before and after a call rather than by capturing `fs.promises.mkdtemp`'s
// resolved path. A `jest.spyOn(fsPromises, 'mkdtemp')` return-value read was
// tried first, but `mkdtemp`'s overloaded signature makes
// `.mock.results[0].value` come back as `any`, and satisfying that without a
// disallowed `as` cast (see CLAUDE.md's no-type-casting rule) would mean
// adding test-only plumbing to the module just to smuggle the path out.
// Comparing directory listings avoids all of that while still proving the
// temp dir is really gone on both the success and failure paths.
//
// The prefix itself is process-pid-unique (see before-graph.ts) precisely so
// this diff-based check stays correct now that a SECOND test file
// (change-impact.test.ts's `assembleChangeImpact` end-to-end test) also
// calls into `buildBeforeGraphForChanges` — without the pid, two jest worker
// processes running concurrently could each observe the OTHER's in-flight
// (not-yet-cleaned-up) temp workspace and misreport a leftover.
function tempWorkspaceEntries(): string[] {
  return readdirSync(tmpdir()).filter((name) =>
    name.startsWith(BEFORE_GRAPH_TEMP_PREFIX),
  );
}

const REPO = 'fixture';

describe('buildBeforeGraphForChanges', () => {
  let root: string;

  beforeEach(() => {
    // Deliberately disjoint from BEFORE_GRAPH_TEMP_PREFIX
    // (`code-graph-before-<pid>-`) so this fixture's own repo directory never
    // shows up in `tempWorkspaceEntries()` and confuses the before/after
    // comparison.
    root = mkdtempSync(path.join(tmpdir(), 'code-graph-bg-fixture-'));
    git(root, ['init', '--quiet']);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  it('bounds cache retention, expires old entries and ignores malformed payloads', () => {
    const cachePath = path.join(root, 'cache', 'before.db');
    for (let i = 0; i < BEFORE_CACHE_MAX_ENTRIES + 3; i += 1)
      writeBeforeCache(cachePath, String(i), {
        symbols: new Map(),
        filesBuilt: 1,
        filesSkipped: 0,
      });
    const db = new DatabaseSync(cachePath);
    try {
      expect(
        db.prepare('SELECT count(*) AS n FROM before_facts_v1').get()?.n,
      ).toBe(BEFORE_CACHE_MAX_ENTRIES);
      db.prepare('UPDATE before_facts_v1 SET created_at = 0').run();
      expect(readBeforeCache(cachePath, '1')).toBeNull();
      expect(
        db.prepare('SELECT count(*) AS n FROM before_facts_v1').get()?.n,
      ).toBe(0);
      db.prepare('INSERT INTO before_facts_v1 VALUES (?, ?, ?)').run(
        'bad',
        '{',
        Date.now(),
      );
      expect(readBeforeCache(cachePath, 'bad')).toBeNull();
    } finally {
      db.close();
    }
  });

  it('keys the scope and repository as well as the resolved commit', async () => {
    writeFileSync(path.join(root, 'lib.ts'), 'export function oldName() {}');
    commitAll(root, 'first');
    const input = { rootPath: root, repoId: REPO, baseRef: 'HEAD' };
    const identity = await beforeCacheIdentity(input, ['lib.ts']);
    expect(identity).not.toBeNull();
    expect(
      (
        await beforeCacheIdentity(
          { ...input, baseRef: git(root, ['rev-parse', 'HEAD']) },
          ['lib.ts'],
        )
      )?.key,
    ).toBe(identity?.key);
    expect(
      (await beforeCacheIdentity({ ...input, repoId: 'other' }, ['lib.ts']))
        ?.key,
    ).not.toBe(identity?.key);
    expect((await beforeCacheIdentity(input, ['other.ts']))?.key).not.toBe(
      identity?.key,
    );
  });

  it('reuses immutable before facts and invalidates when a branch moves', async () => {
    writeFileSync(path.join(root, 'lib.ts'), 'export function oldName() {}');
    commitAll(root, 'first');
    const cachePath = path.join(root, '.test-cache', 'before.db');
    const input = {
      rootPath: root,
      repoId: REPO,
      baseRef: 'HEAD',
      cachePath,
      changes: [
        { relativePath: 'lib.ts', status: 'modified' as const, ranges: [] },
      ],
    };
    const build = jest.spyOn(CodeGraphEngine.prototype, 'buildOrUpdate');
    const first = await buildBeforeGraphForChanges(input);
    build.mockClear();
    const second = await buildBeforeGraphForChanges(input);
    expect(second.symbols).toEqual(first.symbols);
    expect(build).not.toHaveBeenCalled();
    writeFileSync(path.join(root, 'lib.ts'), 'export function newName() {}');
    git(root, ['add', 'lib.ts']);
    git(root, [
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@t',
      'commit',
      '--quiet',
      '-m',
      'second',
    ]);
    const moved = await buildBeforeGraphForChanges(input);
    expect(moved.symbols.has('lib.ts::newName')).toBe(true);
    expect(moved.symbols.has('lib.ts::oldName')).toBe(false);
    expect(build).toHaveBeenCalledTimes(1);
    build.mockRestore();
  });

  it('invalidates cached facts when extraction asset bytes change in place', async () => {
    writeFileSync(path.join(root, 'lib.ts'), 'export function oldName() {}');
    commitAll(root, 'first');
    const resourcesDir = path.join(root, '.test-resources');
    cpSync(getBundledCodeGraphDir(), resourcesDir, { recursive: true });
    const input = {
      rootPath: root,
      repoId: REPO,
      baseRef: 'HEAD',
      resourcesDir,
    };
    const first = await beforeCacheIdentity(input, ['lib.ts']);
    expect(first).not.toBeNull();
    appendFileSync(
      path.join(resourcesDir, 'queries/swift.tags.scm'),
      '\n; changed local extraction resource\n',
    );
    const changed = await beforeCacheIdentity(input, ['lib.ts']);
    expect(changed).not.toBeNull();
    expect(changed?.commit).toBe(first?.commit);
    expect(changed?.key).not.toBe(first?.key);
  });

  it('captures the OLD signature and the deleted file’s symbols at the base ref, and cleans up the temp project', async () => {
    writeFileSync(
      path.join(root, 'lib.ts'),
      'export function alpha(a: string): void {}\n',
    );
    writeFileSync(
      path.join(root, 'gone.ts'),
      'export function goneFn(): void {}\n',
    );
    const baseRef = commitAll(root, 'v1');

    writeFileSync(
      path.join(root, 'lib.ts'),
      'export function alpha(a: string, b: number): void {}\n',
    );
    rmSync(path.join(root, 'gone.ts'));
    commitAll(root, 'v2');

    const changes = await getDiffRanges(root, baseRef);
    const entriesBefore = tempWorkspaceEntries();

    const result = await buildBeforeGraphForChanges({
      rootPath: root,
      repoId: REPO,
      baseRef,
      changes,
    });

    expect(result.filesBuilt).toBe(2);
    expect(result.filesSkipped).toBe(0);

    const alpha = result.symbols.get('lib.ts::alpha');
    expect(alpha).toBeDefined();
    expect(alpha?.kind).toBe('function');
    expect(alpha?.filePath).toBe('lib.ts');
    expect(alpha?.signature).toBe('function alpha(a: string): void {}');
    // The OLD (v1) signature must not carry the NEW (v2) parameter.
    expect(alpha?.signature).not.toContain('b: number');

    const goneFn = result.symbols.get('gone.ts::goneFn');
    expect(goneFn).toBeDefined();
    expect(goneFn?.kind).toBe('function');
    expect(goneFn?.filePath).toBe('gone.ts');

    // Cleanup happens on the success path too: no leftover temp workspace.
    expect(tempWorkspaceEntries()).toEqual(entriesBefore);
  });

  it('counts filesSkipped for a scoped path with no content at the base ref', async () => {
    writeFileSync(path.join(root, 'a.ts'), 'export const a = 1;\n');
    const baseRef = commitAll(root, 'v1');

    const changes: ChangedFileRanges[] = [
      { relativePath: 'a.ts', ranges: [], status: 'modified' },
      { relativePath: 'never-existed.ts', ranges: [], status: 'modified' },
    ];

    const result = await buildBeforeGraphForChanges({
      rootPath: root,
      repoId: REPO,
      baseRef,
      changes,
    });

    expect(result.filesBuilt).toBe(1);
    expect(result.filesSkipped).toBe(1);
    expect(result.symbols.has('a.ts')).toBe(true);
  });

  it('builds the ephemeral graph with derived computation disabled (Phase 6 Task 6: ephemeral graphs never pay that cost)', async () => {
    writeFileSync(
      path.join(root, 'lib.ts'),
      'export function alpha(): void {}\n',
    );
    const baseRef = commitAll(root, 'v1');
    writeFileSync(
      path.join(root, 'lib.ts'),
      'export function alpha(x: number): void {}\n',
    );
    commitAll(root, 'v2');
    const changes = await getDiffRanges(root, baseRef);

    const buildSpy = jest.spyOn(CodeGraphEngine.prototype, 'buildOrUpdate');
    try {
      const result = await buildBeforeGraphForChanges({
        rootPath: root,
        repoId: REPO,
        baseRef,
        changes,
      });
      expect(result.filesBuilt).toBe(1);
      expect(buildSpy).toHaveBeenCalledTimes(1);
      expect(buildSpy).toHaveBeenCalledWith({ computeDerived: false });
    } finally {
      buildSpy.mockRestore();
    }
  });

  it('returns an empty result for an add-only diff without creating a temp project', async () => {
    writeFileSync(path.join(root, 'a.ts'), 'export const a = 1;\n');
    const baseRef = commitAll(root, 'v1');

    const changes: ChangedFileRanges[] = [
      { relativePath: 'new-1.ts', ranges: [], status: 'added' },
      { relativePath: 'new-2.ts', ranges: [], status: 'added' },
    ];

    const entriesBefore = tempWorkspaceEntries();

    const result = await buildBeforeGraphForChanges({
      rootPath: root,
      repoId: REPO,
      baseRef,
      changes,
    });

    expect(result.symbols.size).toBe(0);
    expect(result.filesBuilt).toBe(0);
    expect(result.filesSkipped).toBe(0);
    // The empty-scope short-circuit runs BEFORE mkdtemp, so no temp
    // workspace (and therefore no engine / before.db) is ever created —
    // an unchanged tmpdir listing proves both at once.
    expect(tempWorkspaceEntries()).toEqual(entriesBefore);
  });

  it('returns an empty result with filesSkipped = N when every scoped path has no base-ref content', async () => {
    writeFileSync(path.join(root, 'a.ts'), 'export const a = 1;\n');
    const baseRef = commitAll(root, 'v1');

    const changes: ChangedFileRanges[] = [
      { relativePath: 'ghost-1.ts', ranges: [], status: 'modified' },
      { relativePath: 'ghost-2.ts', ranges: [], status: 'deleted' },
    ];

    const entriesBefore = tempWorkspaceEntries();

    const result = await buildBeforeGraphForChanges({
      rootPath: root,
      repoId: REPO,
      baseRef,
      changes,
    });

    expect(result.symbols.size).toBe(0);
    expect(result.filesBuilt).toBe(0);
    expect(result.filesSkipped).toBe(2);
    // The temp workspace WAS created here (scope is non-empty), so this
    // asserts the finally-block cleanup instead of the mkdtemp skip.
    expect(tempWorkspaceEntries()).toEqual(entriesBefore);
  });

  it('rejects a scoped path containing a `..` segment, counting it as skipped', async () => {
    writeFileSync(path.join(root, 'a.ts'), 'export const a = 1;\n');
    const baseRef = commitAll(root, 'v1');

    const changes: ChangedFileRanges[] = [
      { relativePath: 'a.ts', ranges: [], status: 'modified' },
      { relativePath: '../escape.ts', ranges: [], status: 'modified' },
    ];

    const result = await buildBeforeGraphForChanges({
      rootPath: root,
      repoId: REPO,
      baseRef,
      changes,
    });

    expect(result.filesBuilt).toBe(1);
    expect(result.filesSkipped).toBe(1);
    expect(result.symbols.has('a.ts')).toBe(true);
  });

  it('excludes added files and non-graph-eligible extensions from scope', async () => {
    writeFileSync(path.join(root, 'a.ts'), 'export const a = 1;\n');
    const baseRef = commitAll(root, 'v1');

    const changes: ChangedFileRanges[] = [
      { relativePath: 'a.ts', ranges: [], status: 'modified' },
      { relativePath: 'new.ts', ranges: [], status: 'added' },
      { relativePath: 'image.png', ranges: [], status: 'modified' },
    ];

    const result = await buildBeforeGraphForChanges({
      rootPath: root,
      repoId: REPO,
      baseRef,
      changes,
    });

    // Only a.ts is in scope: 'added' has no before-ref content by definition,
    // and image.png has neither a grammar nor a non-code extractor.
    expect(result.filesBuilt).toBe(1);
    expect(result.filesSkipped).toBe(0);
  });

  it('includes a renamed entry’s previousPath in scope', async () => {
    writeFileSync(path.join(root, 'old.ts'), 'export const x = 1;\n');
    const baseRef = commitAll(root, 'v1');

    const changes: ChangedFileRanges[] = [
      {
        relativePath: 'new.ts',
        ranges: [],
        status: 'renamed',
        previousPath: 'old.ts',
      },
    ];

    const result = await buildBeforeGraphForChanges({
      rootPath: root,
      repoId: REPO,
      baseRef,
      changes,
    });

    expect(result.filesBuilt).toBe(1);
    expect(result.symbols.has('old.ts')).toBe(true);
  });

  it('aborts before creating a temp project when the scoped set exceeds the file limit', async () => {
    const changes: ChangedFileRanges[] = Array.from(
      { length: BEFORE_GRAPH_MAX_SCOPED_FILES + 1 },
      (_, index) => ({
        relativePath: `src/file-${index}.ts`,
        ranges: [],
        status: 'modified' as const,
      }),
    );

    const entriesBefore = tempWorkspaceEntries();

    await expect(
      buildBeforeGraphForChanges({
        rootPath: root,
        repoId: REPO,
        baseRef: 'HEAD',
        changes,
      }),
    ).rejects.toThrow();

    // The abort happens BEFORE any filesystem side effects.
    expect(tempWorkspaceEntries()).toEqual(entriesBefore);
  });

  it('reuses one shared parser runtime across sequential before-graph builds', async () => {
    writeFileSync(path.join(root, 'a.ts'), 'export function fa(): void {}\n');
    writeFileSync(path.join(root, 'b.ts'), 'export function fb(): void {}\n');
    const baseRef = commitAll(root, 'v1');

    writeFileSync(
      path.join(root, 'a.ts'),
      'export function fa(x: number): void {}\n',
    );
    writeFileSync(
      path.join(root, 'b.ts'),
      'export function fb(x: number): void {}\n',
    );
    commitAll(root, 'v2');

    const changes = await getDiffRanges(root, baseRef);

    // Reset the memo so the create-count assertion is deterministic regardless
    // of earlier tests having already warmed the shared runtime.
    resetBeforeGraphRuntimeForTests();
    const createSpy = jest.spyOn(CodeGraphParserRuntime, 'create');
    // Prototype-level dispose spy, installed BEFORE the first build: each
    // build's throwaway engine is closed inside buildBeforeGraphForChanges's
    // own finally, so a wrongly-disposing close() would fire before any
    // instance handle is reachable from out here. Identity/create-count alone
    // would NOT catch that regression — the memo still holds the same (now
    // disposed) instance and simply self-heals by reloading grammar wasm on
    // the next build, which is exactly the leak this test exists to prevent.
    const disposeSpy = jest.spyOn(CodeGraphParserRuntime.prototype, 'dispose');
    try {
      await buildBeforeGraphForChanges({
        rootPath: root,
        repoId: REPO,
        baseRef,
        changes,
      });
      const runtimeAfterFirst = await getBeforeGraphRuntimeForTests();
      expect(runtimeAfterFirst).not.toBeNull();
      // The first build's engine.close() must NOT have disposed the injected
      // shared runtime — ownership stays with before-graph.ts.
      expect(disposeSpy).not.toHaveBeenCalled();

      await buildBeforeGraphForChanges({
        rootPath: root,
        repoId: REPO,
        baseRef,
        changes,
      });
      const runtimeAfterSecond = await getBeforeGraphRuntimeForTests();

      // Same instance both times, and the runtime was constructed exactly
      // once across the two builds: the throwaway engines received the
      // injected shared runtime instead of each creating (and leaking grammar
      // wasm for) its own. Still zero dispose calls after the second build.
      expect(runtimeAfterSecond).toBe(runtimeAfterFirst);
      expect(createSpy).toHaveBeenCalledTimes(1);
      expect(disposeSpy).not.toHaveBeenCalled();
    } finally {
      createSpy.mockRestore();
      disposeSpy.mockRestore();
    }
  });

  it('removes the temp project even when the build throws mid-way (unsafe base ref)', async () => {
    writeFileSync(path.join(root, 'a.ts'), 'export const a = 1;\n');
    commitAll(root, 'v1');

    const changes: ChangedFileRanges[] = [
      { relativePath: 'a.ts', ranges: [], status: 'modified' },
    ];

    const entriesBefore = tempWorkspaceEntries();

    await expect(
      buildBeforeGraphForChanges({
        rootPath: root,
        repoId: REPO,
        // Shaped like a git option: readFileAtRef throws before the engine
        // is ever created, so the parser-init singleton is never touched.
        baseRef: '--upload-pack=x',
        changes,
      }),
    ).rejects.toThrow();

    expect(tempWorkspaceEntries()).toEqual(entriesBefore);
  });
});
