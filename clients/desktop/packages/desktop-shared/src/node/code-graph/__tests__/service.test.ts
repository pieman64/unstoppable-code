import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { getMetadataValue } from '@canopy/code-graph/store/database';
import { runCodeGraphMigrations } from '@canopy/code-graph/store/migrations';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { tryAcquireCodeGraphWriterLease } from '@canopy/code-graph/store/writer-lease';
import { getCanopyDataDir } from '../../../canopy-paths';
import {
  getWorktreeCodeGraphDbPath,
  getWorktreeCodeGraphDir,
} from '../worktree-paths';
import {
  getCodeGraphWorktreeService,
  resetCodeGraphWorktreeServiceForTests,
  type CodeGraphWorktreeDescriptor,
} from '../service';

const LIB = `export function doWork(): number {
  return 42;
}
`;
const MAIN = `import { doWork } from './lib';

export function run(): number {
  return doWork();
}
`;

describe('CodeGraphWorktreeService', () => {
  const originalCanopyDataDir = process.env.CANOPY_DATA_DIR;
  let dataDirRoot: string;
  let repoDir: string;
  const workspaceId = 'ws-1';
  const worktreeId = 'wt-1';
  let descriptor: CodeGraphWorktreeDescriptor;

  beforeEach(() => {
    dataDirRoot = mkdtempSync(
      path.join(tmpdir(), 'code-graph-worktree-service-'),
    );
    process.env.CANOPY_DATA_DIR = path.join(dataDirRoot, 'data');

    repoDir = mkdtempSync(path.join(tmpdir(), 'code-graph-worktree-repo-'));
    mkdirSync(path.join(repoDir, 'src'), { recursive: true });
    writeFileSync(path.join(repoDir, 'src', 'lib.ts'), LIB);
    writeFileSync(path.join(repoDir, 'src', 'main.ts'), MAIN);

    descriptor = {
      workspaceId,
      worktreeId,
      repositories: [{ repoId: 'fixture', rootPath: repoDir }],
    };
  });

  afterEach(async () => {
    // Awaits closeAll() on the outgoing singleton, so every engine (and its
    // sqlite fds) is closed before the temp dirs below are removed.
    await resetCodeGraphWorktreeServiceForTests();

    rmSync(repoDir, { recursive: true, force: true });
    rmSync(dataDirRoot, { recursive: true, force: true });

    if (originalCanopyDataDir === undefined) {
      delete process.env.CANOPY_DATA_DIR;
    } else {
      process.env.CANOPY_DATA_DIR = originalCanopyDataDir;
    }
  });

  it('builds only while it holds the graph writer lease, waiting for another writer', async () => {
    const dbPath = getWorktreeCodeGraphDbPath(workspaceId, worktreeId);
    mkdirSync(path.dirname(dbPath), { recursive: true });
    const other = tryAcquireCodeGraphWriterLease(dbPath);
    expect(other).not.toBeNull();
    const onWait = jest.fn();
    let built = false;
    const building = getCodeGraphWorktreeService()
      .buildOrUpdate(descriptor, undefined, { onWait })
      .then((result) => {
        built = true;
        return result;
      });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(onWait).toHaveBeenCalledTimes(1);
    expect(built).toBe(false);
    other?.release();
    await expect(building).resolves.toMatchObject({ filesParsed: 2 });
    // Released once the build finished.
    const after = tryAcquireCodeGraphWriterLease(dbPath);
    expect(after).not.toBeNull();
    after?.release();
  });

  it('builds into a graph another writer replaced while the build waited for the lease', async () => {
    const service = getCodeGraphWorktreeService();
    const dbPath = getWorktreeCodeGraphDbPath(workspaceId, worktreeId);
    // A reader opens and caches the engine on an incomplete graph.
    await expect(service.getStatus(descriptor)).resolves.toBeNull();
    const stale = await service.getEngine(descriptor);
    const other = tryAcquireCodeGraphWriterLease(dbPath);
    const building = service.buildOrUpdate(descriptor);
    await new Promise((resolve) => setTimeout(resolve, 100));
    // The other writer (a desktop seed) installs a new database over it.
    const replacement = `${dbPath}.replacement`;
    const fresh = new DatabaseSync(replacement);
    runCodeGraphMigrations(fresh);
    fresh.close();
    rmSync(dbPath, { force: true });
    renameSync(replacement, dbPath);
    other?.release();

    await expect(building).resolves.toMatchObject({ filesParsed: 2 });
    // The build reopened the installed file instead of writing through the
    // stale connection, whose WAL frames belong to the replaced database.
    expect((await service.getEngine(descriptor)) === stale).toBe(false);
    const installed = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect(getMetadataValue(installed, 'completed_build_at')).not.toBeNull();
    } finally {
      installed.close();
    }
  });

  it('keeps a reader that waited for the writer lease behind a close that started meanwhile', async () => {
    const service = getCodeGraphWorktreeService();
    const dbPath = getWorktreeCodeGraphDbPath(workspaceId, worktreeId);
    mkdirSync(path.dirname(dbPath), { recursive: true });
    // The graph is missing, so opening it for reads must create it under the
    // lease, which another writer holds.
    const other = tryAcquireCodeGraphWriterLease(dbPath);
    let opened = false;
    const reading = service.getEngine(descriptor).then((engine) => {
      opened = true;
      return engine;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    let finishReplacement: () => void = () => undefined;
    const replacing = service.withWorktreeClosed(
      workspaceId,
      worktreeId,
      () => new Promise<void>((resolve) => (finishReplacement = resolve)),
    );
    other?.release();
    // The reader finishes preparing the graph while the replacement runs; it
    // must not open until the close lets it.
    const first = await Promise.race([
      reading.then(() => 'opened'),
      new Promise((resolve) => setTimeout(() => resolve('waiting'), 3_000)),
    ]);
    expect(first).toBe('waiting');
    expect(opened).toBe(false);
    finishReplacement();
    await replacing;
    await reading;
    expect(opened).toBe(true);
  }, 15_000);

  it('reads a current graph without waiting for a writer that holds the lease', async () => {
    const service = getCodeGraphWorktreeService();
    await service.buildOrUpdate(descriptor);
    await service.closeWorktree(workspaceId, worktreeId);
    const writer = tryAcquireCodeGraphWriterLease(
      getWorktreeCodeGraphDbPath(workspaceId, worktreeId),
    );
    try {
      await expect(service.getStatus(descriptor)).resolves.not.toBeNull();
    } finally {
      writer?.release();
    }
  });

  it('computes the db path under workspaces/{ws}/worktree-data/{wt}/code-graph/graph.db relative to the real data dir', () => {
    const expectedDir = path.join(
      getCanopyDataDir(),
      'workspaces',
      workspaceId,
      'worktree-data',
      worktreeId,
      'code-graph',
    );
    expect(getWorktreeCodeGraphDir(workspaceId, worktreeId)).toBe(expectedDir);
    expect(getWorktreeCodeGraphDbPath(workspaceId, worktreeId)).toBe(
      path.join(expectedDir, 'graph.db'),
    );
  });

  it('hasGraph is false until a build happens, then true', async () => {
    const service = getCodeGraphWorktreeService();
    expect(service.hasGraph(workspaceId, worktreeId)).toBe(false);

    await service.buildOrUpdate(descriptor);

    expect(service.hasGraph(workspaceId, worktreeId)).toBe(true);
    expect(
      existsSync(getWorktreeCodeGraphDbPath(workspaceId, worktreeId)),
    ).toBe(true);
  });

  it('getStatus is null before any build and reflects state after', async () => {
    const service = getCodeGraphWorktreeService();
    expect(await service.getStatus(descriptor)).toBeNull();

    await service.buildOrUpdate(descriptor);

    const status = await service.getStatus(descriptor);
    expect(status).not.toBeNull();
    expect(status?.repositories[0]?.fileCount).toBe(2);
  });

  it("serializes concurrent buildOrUpdate calls so the second reflects the first's completed state", async () => {
    const service = getCodeGraphWorktreeService();

    const [first, second] = await Promise.all([
      service.buildOrUpdate(descriptor),
      service.buildOrUpdate(descriptor),
    ]);

    expect(first.filesParsed).toBe(2);
    expect(first.filesUnchanged).toBe(0);
    expect(second.filesParsed).toBe(0);
    expect(second.filesUnchanged).toBe(2);
  });

  it('closeWorktree lets the dir be removed, and a later getEngine reopens fresh', async () => {
    const service = getCodeGraphWorktreeService();
    await service.buildOrUpdate(descriptor);
    expect(service.hasGraph(workspaceId, worktreeId)).toBe(true);

    await service.closeWorktree(workspaceId, worktreeId);

    expect(() =>
      rmSync(getWorktreeCodeGraphDir(workspaceId, worktreeId), {
        recursive: true,
        force: true,
      }),
    ).not.toThrow();
    expect(service.hasGraph(workspaceId, worktreeId)).toBe(false);

    // Reopening after close+removal must not resurrect the closed engine or
    // throw — it should transparently create a fresh db in the (recreated)
    // worktree-data dir.
    const rebuilt = await service.buildOrUpdate(descriptor);
    expect(rebuilt.filesParsed).toBe(2);
    expect(service.hasGraph(workspaceId, worktreeId)).toBe(true);

    // closeWorktree is idempotent.
    await expect(
      service.closeWorktree(workspaceId, worktreeId),
    ).resolves.toBeUndefined();
  });

  it('evicts a rejected engine open so the next getEngine retries and succeeds', async () => {
    const service = getCodeGraphWorktreeService();

    // Make openEngine's mkdirSync fail: plant a FILE where the
    // worktree-data/{worktreeId} directory belongs, so creating the
    // code-graph subdirectory throws ENOTDIR.
    const worktreeDataEntry = path.dirname(
      getWorktreeCodeGraphDir(workspaceId, worktreeId),
    );
    mkdirSync(path.dirname(worktreeDataEntry), { recursive: true });
    writeFileSync(worktreeDataEntry, 'not a directory');

    await expect(service.getEngine(descriptor)).rejects.toThrow();

    // The rejected open must have been evicted: after clearing the blocker,
    // the retry opens fresh instead of replaying the cached failure.
    rmSync(worktreeDataEntry);
    const result = await service.buildOrUpdate(descriptor);
    expect(result.filesParsed).toBe(2);
    expect(service.hasGraph(workspaceId, worktreeId)).toBe(true);
  });

  it('a failed buildOrUpdate rejects its caller but does not poison the queue', async () => {
    const service = getCodeGraphWorktreeService();
    const first = await service.buildOrUpdate(descriptor);
    expect(first.filesParsed).toBe(2);

    // Remove the repo root mid-life: the scan's directory walk throws, so
    // this build rejects for its own caller...
    rmSync(repoDir, { recursive: true, force: true });
    await expect(service.buildOrUpdate(descriptor)).rejects.toThrow();

    // ...but the per-key queue tail stays usable: after the repo reappears
    // at the same path, the next build runs and resolves normally.
    mkdirSync(path.join(repoDir, 'src'), { recursive: true });
    writeFileSync(path.join(repoDir, 'src', 'lib.ts'), LIB);
    writeFileSync(path.join(repoDir, 'src', 'main.ts'), MAIN);
    const recovered = await service.buildOrUpdate(descriptor);
    expect(recovered.filesParsed + recovered.filesUnchanged).toBe(2);
  });

  it('closeAll closes every open worktree engine so each dir can be removed', async () => {
    const service = getCodeGraphWorktreeService();
    const descriptorB: CodeGraphWorktreeDescriptor = {
      workspaceId,
      worktreeId: 'wt-2',
      repositories: [{ repoId: 'fixture', rootPath: repoDir }],
    };
    await service.buildOrUpdate(descriptor);
    await service.buildOrUpdate(descriptorB);
    expect(service.hasGraph(workspaceId, worktreeId)).toBe(true);
    expect(service.hasGraph(workspaceId, 'wt-2')).toBe(true);

    await expect(service.closeAll()).resolves.toBeUndefined();

    // Both engines' sqlite fds are released, so both dirs are removable.
    expect(() =>
      rmSync(getWorktreeCodeGraphDir(workspaceId, worktreeId), {
        recursive: true,
        force: true,
      }),
    ).not.toThrow();
    expect(() =>
      rmSync(getWorktreeCodeGraphDir(workspaceId, 'wt-2'), {
        recursive: true,
        force: true,
      }),
    ).not.toThrow();
  });

  it('a buildOrUpdate issued while closeWorktree is in flight runs strictly after the close on a fresh engine', async () => {
    const service = getCodeGraphWorktreeService();

    // Start a build, then close while it is in flight, then immediately queue
    // another build. The second build must be serialized strictly after both
    // the first build and the close: it reopens fresh and sees the first
    // build's fully committed state (0 parsed / 2 unchanged). Any overlap
    // with the first build would surface as parsed (or missing) files here.
    const firstBuild = service.buildOrUpdate(descriptor);
    const closing = service.closeWorktree(workspaceId, worktreeId);
    const secondBuild = service.buildOrUpdate(descriptor);

    const [first, , second] = await Promise.all([
      firstBuild,
      closing,
      secondBuild,
    ]);
    expect(first.filesParsed).toBe(2);
    expect(second.filesParsed).toBe(0);
    expect(second.filesUnchanged).toBe(2);

    // The engine the second build opened survived the close and still works.
    const status = await service.getStatus(descriptor);
    expect(status?.repositories[0]?.fileCount).toBe(2);
  });

  it('keeps readers closed for the full duration of an external database replacement', async () => {
    const service = getCodeGraphWorktreeService();
    const originalEngine = await service.getEngine(descriptor);
    let releaseReplacement: () => void = () => {};
    const replacementBlocked = new Promise<void>((resolve) => {
      releaseReplacement = resolve;
    });
    let replacementStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      replacementStarted = resolve;
    });

    const replacing = service.withWorktreeClosed(
      workspaceId,
      worktreeId,
      async () => {
        replacementStarted();
        await replacementBlocked;
      },
    );
    await started;
    let readerOpened = false;
    const pendingReader = service.getEngine(descriptor).then((engine) => {
      readerOpened = true;
      return engine;
    });
    await Promise.resolve();
    expect(readerOpened).toBe(false);

    releaseReplacement();
    await replacing;
    const reopenedEngine = await pendingReader;
    expect(reopenedEngine).not.toBe(originalEngine);
  });
});
