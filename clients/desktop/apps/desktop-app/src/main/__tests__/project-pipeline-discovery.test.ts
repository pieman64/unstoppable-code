import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  discoverProjectPipelines,
  discoverProjectPipelinesBounded,
  loadProjectPipelineFromDisk,
} from '../pipelines/project-pipeline-discovery';
import {
  clearProjectPipelineRemoteMetadataByRemoteId,
  writeProjectPipelineRemoteMetadata,
} from '../pipelines/pipeline-service';
import { resetResolvedCanopyDataDirForTests } from '@canopy/desktop-shared/canopy-paths';

const GENEROUS_LIMITS = {
  maxEntries: 10_000,
  maxFiles: 1_000,
  maxBytes: 1_000_000,
  maxSerializedBytes: 1_000_000,
};

describe('project pipeline discovery', () => {
  let tempDir: string;
  let repoPath: string;
  let previousDataDir: string | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'canopy-project-pipelines-'),
    );
    repoPath = path.join(tempDir, 'repo');
    previousDataDir = process.env.CANOPY_DATA_DIR;
    process.env.CANOPY_DATA_DIR = path.join(tempDir, 'data');
    resetResolvedCanopyDataDirForTests();
    fs.mkdirSync(repoPath, { recursive: true });
  });

  afterEach(() => {
    if (previousDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
    else process.env.CANOPY_DATA_DIR = previousDataDir;
    resetResolvedCanopyDataDirForTests();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('hydrates and clears durable author-side remote metadata', async () => {
    const pipelinesDir = path.join(repoPath, '.canopy', 'pipelines');
    const pipelineFilePath = path.join(pipelinesDir, 'release.yaml');
    fs.mkdirSync(pipelinesDir, { recursive: true });
    fs.writeFileSync(
      pipelineFilePath,
      [
        'name: Release',
        'on: dispatch',
        'jobs:',
        '  release:',
        '    steps: []',
      ].join('\n'),
      'utf8',
    );
    const remote = {
      accountId: 'account-a',
      remoteId: '11111111-1111-4111-8111-111111111111',
      contentHash: 'content-hash',
      shareScope: 'private' as const,
      sharedAt: '2026-09-25T00:00:00.000Z',
    };

    expect(
      writeProjectPipelineRemoteMetadata(pipelineFilePath, remote),
    ).toEqual({ success: true });
    await expect(discoverProjectPipelines(repoPath)).resolves.toEqual([
      expect.objectContaining({ filePath: pipelineFilePath, remote }),
    ]);
    expect(
      clearProjectPipelineRemoteMetadataByRemoteId(remote.remoteId),
    ).toEqual({ success: true, data: 1 });
    const afterClear = await discoverProjectPipelines(repoPath);
    expect(afterClear).toHaveLength(1);
    expect(afterClear[0]?.remote).toBeUndefined();
  });

  it('keeps durable author metadata when a project pipeline is renamed', async () => {
    const pipelinesDir = path.join(repoPath, '.canopy', 'pipelines');
    const originalPath = path.join(pipelinesDir, 'release.yaml');
    const renamedPath = path.join(pipelinesDir, 'deploy.yaml');
    fs.mkdirSync(pipelinesDir, { recursive: true });
    fs.writeFileSync(
      originalPath,
      ['name: Release', 'on: dispatch', 'jobs: {}'].join('\n'),
      'utf8',
    );
    const remote = {
      remoteId: '11111111-1111-4111-8111-111111111111',
      contentHash: 'content-hash',
      shareScope: 'private' as const,
      sharedAt: '2026-09-25T00:00:00.000Z',
    };
    expect(writeProjectPipelineRemoteMetadata(originalPath, remote)).toEqual({
      success: true,
    });

    fs.renameSync(originalPath, renamedPath);

    await expect(discoverProjectPipelines(repoPath)).resolves.toEqual([
      expect.objectContaining({ filePath: renamedPath, remote }),
    ]);
  });

  it('does not transfer metadata when a project path is deleted and reused', async () => {
    const pipelinesDir = path.join(repoPath, '.canopy', 'pipelines');
    const pipelineFilePath = path.join(pipelinesDir, 'release.yaml');
    fs.mkdirSync(pipelinesDir, { recursive: true });
    fs.writeFileSync(
      pipelineFilePath,
      ['name: Original', 'on: dispatch', 'jobs: {}'].join('\n'),
      'utf8',
    );
    expect(
      writeProjectPipelineRemoteMetadata(pipelineFilePath, {
        remoteId: '11111111-1111-4111-8111-111111111111',
        contentHash: 'content-hash',
        shareScope: 'private',
        sharedAt: '2026-09-25T00:00:00.000Z',
      }),
    ).toEqual({ success: true });

    // Allocate the replacement before deleting the original so Linux cannot
    // reuse its inode and birth time for a different project in this fixture.
    const replacementRepoPath = path.join(tempDir, 'replacement-repo');
    fs.mkdirSync(replacementRepoPath);
    expect(fs.statSync(replacementRepoPath).ino).not.toBe(
      fs.statSync(repoPath).ino,
    );
    fs.rmSync(repoPath, { recursive: true, force: true });
    fs.renameSync(replacementRepoPath, repoPath);
    fs.mkdirSync(pipelinesDir, { recursive: true });
    fs.writeFileSync(
      pipelineFilePath,
      ['name: Unrelated', 'on: dispatch', 'jobs: {}'].join('\n'),
      'utf8',
    );

    const discovered = await discoverProjectPipelines(repoPath);
    expect(discovered).toHaveLength(1);
    expect(discovered[0]).toEqual(
      expect.objectContaining({
        filePath: pipelineFilePath,
        name: 'Unrelated',
      }),
    );
    expect(discovered[0]?.remote).toBeUndefined();
  });

  it('prunes a deleted pipeline binding before the same path is reused', async () => {
    const pipelinesDir = path.join(repoPath, '.canopy', 'pipelines');
    const pipelineFilePath = path.join(pipelinesDir, 'release.yaml');
    fs.mkdirSync(pipelinesDir, { recursive: true });
    fs.writeFileSync(
      pipelineFilePath,
      ['name: Original', 'on: dispatch', 'jobs: {}'].join('\n'),
      'utf8',
    );
    expect(
      writeProjectPipelineRemoteMetadata(pipelineFilePath, {
        remoteId: '11111111-1111-4111-8111-111111111111',
        contentHash: 'content-hash',
        shareScope: 'private',
        sharedAt: '2026-09-25T00:00:00.000Z',
      }),
    ).toEqual({ success: true });

    fs.rmSync(pipelineFilePath);
    await expect(discoverProjectPipelines(repoPath)).resolves.toEqual([]);
    fs.writeFileSync(
      pipelineFilePath,
      ['name: Replacement', 'on: dispatch', 'jobs: {}'].join('\n'),
      'utf8',
    );

    const discovered = await discoverProjectPipelines(repoPath);
    expect(discovered).toHaveLength(1);
    expect(discovered[0]?.remote).toBeUndefined();
  });

  it('keeps a pipeline binding while its existing YAML is temporarily invalid', async () => {
    const pipelinesDir = path.join(repoPath, '.canopy', 'pipelines');
    const pipelineFilePath = path.join(pipelinesDir, 'release.yaml');
    fs.mkdirSync(pipelinesDir, { recursive: true });
    fs.writeFileSync(
      pipelineFilePath,
      ['name: Release', 'on: dispatch', 'jobs: {}'].join('\n'),
      'utf8',
    );
    const remote = {
      remoteId: '11111111-1111-4111-8111-111111111111',
      contentHash: 'content-hash',
      shareScope: 'private' as const,
      sharedAt: '2026-09-25T00:00:00.000Z',
    };
    expect(
      writeProjectPipelineRemoteMetadata(pipelineFilePath, remote),
    ).toEqual({ success: true });

    fs.writeFileSync(pipelineFilePath, 'pipeline: [', 'utf8');
    await expect(discoverProjectPipelines(repoPath)).resolves.toEqual([]);
    fs.writeFileSync(
      pipelineFilePath,
      ['name: Repaired', 'on: dispatch', 'jobs: {}'].join('\n'),
      'utf8',
    );

    await expect(discoverProjectPipelines(repoPath)).resolves.toEqual([
      expect.objectContaining({ filePath: pipelineFilePath, remote }),
    ]);
  });

  it('discovers recursive .yml/.yaml pipelines, skips invalid files, and sorts by relative path', async () => {
    const pipelinesDir = path.join(repoPath, '.canopy', 'pipelines');
    fs.mkdirSync(path.join(pipelinesDir, 'deploy'), { recursive: true });
    fs.mkdirSync(path.join(pipelinesDir, 'ops'), { recursive: true });

    fs.writeFileSync(
      path.join(pipelinesDir, 'deploy', 'staging.yaml'),
      [
        'name: Staging Deploy',
        'description: Deploy staging',
        'icon: 🚀',
        'on: dispatch',
        'jobs:',
        '  deploy:',
        '    steps: []',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(
      path.join(pipelinesDir, 'ops', 'cleanup.yml'),
      [
        'name: Cleanup',
        'on: dispatch',
        'jobs:',
        '  clean:',
        '    steps: []',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(
      path.join(pipelinesDir, 'broken.yaml'),
      'pipeline: [',
      'utf8',
    );

    const discovered = await discoverProjectPipelines(repoPath);

    expect(discovered.map((pipeline) => pipeline.filename)).toEqual([
      'deploy/staging.yaml',
      'ops/cleanup.yml',
    ]);
    expect(discovered.map((pipeline) => pipeline.id)).toEqual([
      'project--deploy/staging.yaml',
      'project--ops/cleanup.yml',
    ]);
    expect(discovered[0]).toMatchObject({
      source: 'project',
      readonly: true,
      name: 'Staging Deploy',
      description: 'Deploy staging',
      icon: '🚀',
      filePath: path.join(pipelinesDir, 'deploy', 'staging.yaml'),
    });
    expect(discovered[1]).toMatchObject({
      source: 'project',
      readonly: true,
      name: 'Cleanup',
      filePath: path.join(pipelinesDir, 'ops', 'cleanup.yml'),
    });
  });

  it('returns an empty list when the project pipelines directory is missing', async () => {
    await expect(discoverProjectPipelines(repoPath)).resolves.toEqual([]);
  });

  it('keeps distinct ids for .yml and .yaml siblings with the same basename', async () => {
    const pipelinesDir = path.join(repoPath, '.canopy', 'pipelines');
    fs.mkdirSync(pipelinesDir, { recursive: true });

    fs.writeFileSync(
      path.join(pipelinesDir, 'deploy.yml'),
      [
        'name: Deploy YML',
        'on: dispatch',
        'jobs:',
        '  build:',
        '    steps: []',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(
      path.join(pipelinesDir, 'deploy.yaml'),
      [
        'name: Deploy YAML',
        'on: dispatch',
        'jobs:',
        '  release:',
        '    steps: []',
      ].join('\n'),
      'utf8',
    );

    const discovered = await discoverProjectPipelines(repoPath);

    expect(discovered.map((pipeline) => pipeline.id)).toEqual([
      'project--deploy.yaml',
      'project--deploy.yml',
    ]);
    expect(new Set(discovered.map((pipeline) => pipeline.id)).size).toBe(2);
  });

  function writeThreePipelines(): string {
    const pipelinesDir = path.join(repoPath, '.canopy', 'pipelines');
    fs.mkdirSync(pipelinesDir, { recursive: true });
    const body = (name: string): string =>
      [`name: ${name}`, 'on: dispatch', 'jobs:', '  j:', '    steps: []'].join(
        '\n',
      );
    for (const name of ['a', 'b', 'c']) {
      fs.writeFileSync(path.join(pipelinesDir, `${name}.yaml`), body(name));
    }
    return pipelinesDir;
  }

  it('bounded discovery reports a complete list when no bound applies', async () => {
    writeThreePipelines();
    const discovered = await discoverProjectPipelinesBounded(
      repoPath,
      GENEROUS_LIMITS,
    );
    expect(discovered.pipelines.map((pipeline) => pipeline.name)).toEqual([
      'a',
      'b',
      'c',
    ]);
    expect(discovered.truncated).toBe(false);
  });

  it('honours the file-count and byte bounds and reports the cut', async () => {
    const pipelinesDir = writeThreePipelines();
    // Unbounded: all three.
    await expect(discoverProjectPipelines(repoPath)).resolves.toHaveLength(3);
    // File-count bound: the third is never read.
    const byCount = await discoverProjectPipelinesBounded(repoPath, {
      ...GENEROUS_LIMITS,
      maxFiles: 2,
    });
    expect(byCount.pipelines.map((pipeline) => pipeline.name)).toEqual([
      'a',
      'b',
    ]);
    expect(byCount.truncated).toBe(true);
    // Byte bound: only what fits under the cumulative budget is parsed.
    const oneFile = fs.statSync(path.join(pipelinesDir, 'a.yaml')).size;
    const byBytes = await discoverProjectPipelinesBounded(repoPath, {
      ...GENEROUS_LIMITS,
      maxBytes: oneFile * 2 + 1,
    });
    expect(byBytes.pipelines).toHaveLength(2);
    expect(byBytes.truncated).toBe(true);
  });

  it('stops enumerating once the entry budget is spent', async () => {
    const pipelinesDir = writeThreePipelines();
    // Deep noise the walk must not materialize before the bound applies.
    let dir = path.join(pipelinesDir, 'z-noise');
    for (let depth = 0; depth < 5; depth += 1) {
      dir = path.join(dir, `level-${depth}`);
      fs.mkdirSync(dir, { recursive: true });
      for (let index = 0; index < 10; index += 1) {
        fs.writeFileSync(path.join(dir, `file-${index}.txt`), '');
      }
    }
    const discovered = await discoverProjectPipelinesBounded(repoPath, {
      ...GENEROUS_LIMITS,
      maxEntries: 4,
    });
    // Breadth-first over sorted entries: a, b, c, then z-noise stops it.
    expect(discovered.pipelines.map((pipeline) => pipeline.name)).toEqual([
      'a',
      'b',
      'c',
    ]);
    expect(discovered.truncated).toBe(true);
  });

  it('shares one entry budget across every candidate pipelines directory', async () => {
    const body = (name: string): string =>
      [`name: ${name}`, 'on: dispatch', 'jobs:', '  j:', '    steps: []'].join(
        '\n',
      );
    for (const dirName of ['.canopy', '.unstoppable-code']) {
      const pipelinesDir = path.join(repoPath, dirName, 'pipelines');
      fs.mkdirSync(pipelinesDir, { recursive: true });
      for (const name of ['a', 'b', 'c']) {
        fs.writeFileSync(
          path.join(pipelinesDir, `${name}.yaml`),
          body(`${dirName}-${name}`),
        );
      }
    }
    const within = await discoverProjectPipelinesBounded(repoPath, {
      ...GENEROUS_LIMITS,
      maxEntries: 6,
    });
    expect(within.pipelines).toHaveLength(6);
    expect(within.truncated).toBe(false);
    // Four entries in total, not four per root.
    const cut = await discoverProjectPipelinesBounded(repoPath, {
      ...GENEROUS_LIMITS,
      maxEntries: 4,
    });
    expect(cut.pipelines).toHaveLength(4);
    expect(cut.truncated).toBe(true);
  });

  it('bounds metadata and skips a pipeline whose name is not a bounded string', async () => {
    const pipelinesDir = path.join(repoPath, '.canopy', 'pipelines');
    fs.mkdirSync(pipelinesDir, { recursive: true });
    // Anchors keep one object referenced many times; a name or description
    // that aliases it would serialize to far more than the file's size.
    fs.writeFileSync(
      path.join(pipelinesDir, 'amplified.yaml'),
      [
        'big: &b',
        '  k: [1, 2, 3, 4, 5, 6, 7, 8]',
        'bigger: &c { a: *b, b: *b, c: *b, d: *b }',
        'name: *c',
        'on: dispatch',
        'jobs:',
        '  j:',
        '    steps: []',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(pipelinesDir, 'clamped.yaml'),
      [
        `name: ${'n'.repeat(300)}`,
        `description: ${'d'.repeat(5_000)}`,
        'on: dispatch',
        'jobs:',
        '  j:',
        '    steps: []',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(pipelinesDir, 'ok.yaml'),
      [
        'name: ok',
        `description: ${'d'.repeat(5_000)}`,
        'icon: { not: a-string }',
        'on: dispatch',
        'jobs:',
        '  j:',
        '    steps: []',
      ].join('\n'),
    );
    const discovered = await discoverProjectPipelinesBounded(
      repoPath,
      GENEROUS_LIMITS,
    );
    expect(discovered.pipelines.map((pipeline) => pipeline.name)).toEqual([
      'ok',
    ]);
    expect(discovered.pipelines[0]?.description).toHaveLength(2_048);
    expect(discovered.pipelines[0]?.icon).toBe('');
    expect(discovered.truncated).toBe(true);
  });

  it('skips an alias-amplified document before normalizing it', async () => {
    const pipelinesDir = path.join(repoPath, '.canopy', 'pipelines');
    fs.mkdirSync(pipelinesDir, { recursive: true });
    // Seven levels of eight-way aliasing: a few hundred bytes of YAML that
    // serialize to 8^7 array elements once anything copies the document.
    const levels = ['l0: &l0 [1, 2, 3, 4, 5, 6, 7, 8]'];
    for (let level = 1; level <= 7; level += 1) {
      const previous = `*l${level - 1}`;
      levels.push(
        `l${level}: &l${level} [${Array(8).fill(previous).join(', ')}]`,
      );
    }
    fs.writeFileSync(
      path.join(pipelinesDir, 'bomb.yaml'),
      [
        ...levels,
        'name: bomb',
        'on:',
        '  task_ready:',
        '    inputs:',
        '      target: { type: choice, options: *l7 }',
        'jobs:',
        '  j:',
        '    steps: []',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(pipelinesDir, 'a.yaml'),
      ['name: a', 'on: dispatch', 'jobs:', '  j:', '    steps: []'].join('\n'),
    );
    fs.writeFileSync(
      path.join(pipelinesDir, 'c.yaml'),
      ['name: c', 'on: dispatch', 'jobs:', '  j:', '    steps: []'].join('\n'),
    );
    const started = Date.now();
    const discovered = await discoverProjectPipelinesBounded(
      repoPath,
      GENEROUS_LIMITS,
    );
    expect(Date.now() - started).toBeLessThan(5_000);
    // One serialized-size budget for the scan: `a` fits, the bomb spends the
    // rest of it, and `c` (sorted after `bomb`) is skipped at no cost.
    expect(discovered.pipelines.map((pipeline) => pipeline.name)).toEqual([
      'a',
    ]);
    expect(discovered.truncated).toBe(true);
  });

  it('refuses a pipelines directory that resolves outside the checkout when bounded', async () => {
    const outside = path.join(tempDir, 'elsewhere');
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(
      path.join(outside, 'leak.yaml'),
      ['name: leak', 'on: dispatch', 'jobs:', '  j:', '    steps: []'].join(
        '\n',
      ),
    );
    fs.mkdirSync(path.join(repoPath, '.canopy'), { recursive: true });
    fs.symlinkSync(outside, path.join(repoPath, '.canopy', 'pipelines'));
    // The live, user-initiated path follows the link as before.
    await expect(discoverProjectPipelines(repoPath)).resolves.toHaveLength(1);
    // Unattended discovery must not scan outside the checkout.
    const bounded = await discoverProjectPipelinesBounded(
      repoPath,
      GENEROUS_LIMITS,
    );
    expect(bounded.pipelines).toEqual([]);
    expect(bounded.truncated).toBe(true);
  });

  it('does not descend into symlinked directories', async () => {
    const pipelinesDir = writeThreePipelines();
    const outside = path.join(tempDir, 'elsewhere');
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(
      path.join(outside, 'leak.yaml'),
      ['name: leak', 'on: dispatch', 'jobs:', '  j:', '    steps: []'].join(
        '\n',
      ),
    );
    fs.symlinkSync(outside, path.join(pipelinesDir, 'linked'));
    const discovered = await discoverProjectPipelinesBounded(
      repoPath,
      GENEROUS_LIMITS,
    );
    expect(discovered.pipelines.map((pipeline) => pipeline.name)).toEqual([
      'a',
      'b',
      'c',
    ]);
    expect(discovered.truncated).toBe(false);
  });

  it('loads a project pipeline directly from disk', async () => {
    const pipelinePath = path.join(
      repoPath,
      '.canopy',
      'pipelines',
      'run.yaml',
    );
    fs.mkdirSync(path.dirname(pipelinePath), { recursive: true });
    fs.writeFileSync(
      pipelinePath,
      [
        'name: Run From Disk',
        'description: Fresh load',
        'on: dispatch',
        'jobs:',
        '  build:',
        '    steps: []',
      ].join('\n'),
      'utf8',
    );

    await expect(
      loadProjectPipelineFromDisk(pipelinePath),
    ).resolves.toMatchObject({
      name: 'Run From Disk',
      description: 'Fresh load',
    });
  });
});
