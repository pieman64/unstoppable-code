import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
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
