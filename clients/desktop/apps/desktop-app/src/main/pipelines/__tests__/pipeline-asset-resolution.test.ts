import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Pipeline } from '@canopy/desktop-shared/types/pipeline';
import { resolvePipelineAssetExecutionOptions } from '../pipeline-asset-resolution';

function textContaining(text: string): unknown {
  return expect.stringContaining(text);
}

function pipeline(assets?: Pipeline['assets']): Pipeline {
  return {
    name: 'Entry',
    on: 'dispatch',
    ...(assets ? { assets } : {}),
    jobs: {},
  };
}

describe('resolvePipelineAssetExecutionOptions', () => {
  let tempDir: string;
  let dataRoot: string;
  let home: string;

  beforeEach(() => {
    tempDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-asset-resolution-')),
    );
    dataRoot = path.join(tempDir, 'pipeline-data');
    home = path.join(tempDir, 'home');
    fs.mkdirSync(path.join(home, 'specialists'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('prefers the installed copy and reports the installed asset root', async () => {
    const installed = path.join(dataRoot, 'local-id', 'assets', 'specialists');
    fs.mkdirSync(installed, { recursive: true });
    await expect(
      resolvePipelineAssetExecutionOptions({
        pipeline: pipeline([{ id: 'specialists', path: '~/specialists' }]),
        identity: { localPipelineId: 'local-id' },
        dataRoot,
        home,
      }),
    ).resolves.toEqual({
      ok: true,
      options: {
        assetPaths: { specialists: installed },
        pipelineDataDir: path.join(dataRoot, 'local-id', 'state'),
        assetsDir: path.join(dataRoot, 'local-id', 'assets'),
      },
    });
    expect(
      fs.statSync(path.join(dataRoot, 'local-id', 'state')).isDirectory(),
    ).toBe(true);
  });

  it('keys a project pipeline data dir by its source path hash', async () => {
    const source = path.join(tempDir, 'repo', '.canopy', 'pipelines', 'a.yaml');
    const key = createHash('sha256').update(source).digest('hex');
    await expect(
      resolvePipelineAssetExecutionOptions({
        pipeline: pipeline([{ id: 'specialists', path: '~/specialists' }]),
        identity: { sourcePath: source },
        dataRoot,
        home,
      }),
    ).resolves.toEqual({
      ok: true,
      options: {
        assetPaths: { specialists: path.join(home, 'specialists') },
        pipelineDataDir: path.join(dataRoot, key, 'state'),
      },
    });
  });

  it('gives a pipeline without assets only its data dir', async () => {
    await expect(
      resolvePipelineAssetExecutionOptions({
        pipeline: pipeline(),
        identity: { localPipelineId: 'local-id' },
        dataRoot,
        home,
      }),
    ).resolves.toEqual({
      ok: true,
      options: { pipelineDataDir: path.join(dataRoot, 'local-id', 'state') },
    });
  });

  it('creates no data dir for a run with no stable identity', async () => {
    await expect(
      resolvePipelineAssetExecutionOptions({
        pipeline: pipeline([{ id: 'specialists', path: '~/specialists' }]),
        identity: {},
        dataRoot,
        home,
      }),
    ).resolves.toEqual({
      ok: true,
      options: { assetPaths: { specialists: path.join(home, 'specialists') } },
    });
    expect(fs.existsSync(dataRoot)).toBe(false);
  });

  it('fails a missing required asset and a malformed declaration', async () => {
    await expect(
      resolvePipelineAssetExecutionOptions({
        pipeline: pipeline([{ id: 'reports', path: '~/reports' }]),
        identity: { localPipelineId: 'local-id' },
        dataRoot,
        home,
      }),
    ).resolves.toMatchObject({
      ok: false,
      message: textContaining('"reports"'),
    });
    await expect(
      resolvePipelineAssetExecutionOptions({
        pipeline: pipeline([
          { id: 'a', path: '~/a' },
          { id: 'a', path: '~/b' },
        ]),
        identity: {},
        dataRoot,
        home,
      }),
    ).resolves.toEqual({ ok: false, message: 'Duplicate asset id "a"' });
  });
});
