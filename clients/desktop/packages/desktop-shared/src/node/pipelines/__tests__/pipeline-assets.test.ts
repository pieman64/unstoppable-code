import { createHash } from 'node:crypto';
import * as path from 'node:path';
import type { NormalizedPipelineAssetDeclaration } from '@canopy/desktop-shared/types/pipeline';
import {
  expandPipelineAssetPath,
  pipelineAssetsDir,
  pipelineAssetsManifestPath,
  pipelineDataDir,
  pipelineDataKey,
  resolvePipelineAssets,
} from '../pipeline-assets';

const dataRoot = path.resolve('/data/pipeline-data');
const home = path.resolve('/home/author');

function asset(
  overrides: Partial<NormalizedPipelineAssetDeclaration> = {},
): NormalizedPipelineAssetDeclaration {
  return {
    id: 'specialists',
    path: '~/.canopy/journey-specialists/specialists',
    required: true,
    install: 'seed',
    ...overrides,
  };
}

function existing(...dirs: string[]): (dir: string) => Promise<boolean> {
  const known = new Set(dirs);
  return (dir) => Promise.resolve(known.has(dir));
}

describe('pipeline data keys and layout', () => {
  it('uses the local pipeline id when there is one', () => {
    expect(
      pipelineDataKey({
        localPipelineId: '0f8c7a52-1f9a-4d3c-9b0e-3a1c2d4e5f60',
        sourcePath: '/repo/.canopy/pipelines/entry.yaml',
      }),
    ).toBe('0f8c7a52-1f9a-4d3c-9b0e-3a1c2d4e5f60');
  });

  it('hashes the absolute source path for a project pipeline', () => {
    const source = path.resolve('/repo/.canopy/pipelines/entry.yaml');
    const key = pipelineDataKey({ sourcePath: source });
    expect(key).toBe(createHash('sha256').update(source).digest('hex'));
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(
      pipelineDataKey({
        sourcePath: path.join(path.dirname(source), '.', 'entry.yaml'),
      }),
    ).toBe(key);
  });

  it('lays out state, assets and the install manifest under the key', () => {
    expect(pipelineDataDir(dataRoot, 'k')).toBe(
      path.join(dataRoot, 'k', 'state'),
    );
    expect(pipelineAssetsDir(dataRoot, 'k')).toBe(
      path.join(dataRoot, 'k', 'assets'),
    );
    expect(pipelineAssetsManifestPath(dataRoot, 'k')).toBe(
      path.join(dataRoot, 'k', 'assets.json'),
    );
  });

  it('expands ~ and refuses unanchored paths', () => {
    expect(expandPipelineAssetPath('~', home)).toBe(home);
    expect(expandPipelineAssetPath('~/a/b', home)).toBe(
      path.join(home, 'a', 'b'),
    );
    expect(expandPipelineAssetPath(path.resolve('/abs/dir'), home)).toBe(
      path.resolve('/abs/dir'),
    );
    expect(expandPipelineAssetPath('relative/dir', home)).toBeUndefined();
  });
});

describe('resolvePipelineAssets', () => {
  const installed = path.join(dataRoot, 'key', 'assets', 'specialists');
  const declared = path.join(
    home,
    '.canopy',
    'journey-specialists',
    'specialists',
  );

  it('prefers the installed asset dir', async () => {
    await expect(
      resolvePipelineAssets({
        assets: [asset()],
        dataRoot,
        dataKey: 'key',
        homedir: home,
        directoryExists: existing(installed, declared),
      }),
    ).resolves.toEqual({
      ok: true,
      assetPaths: { specialists: installed },
      assetsDir: path.join(dataRoot, 'key', 'assets'),
    });
  });

  it('falls back to the declared path with ~ expanded', async () => {
    await expect(
      resolvePipelineAssets({
        assets: [asset()],
        dataRoot,
        dataKey: 'key',
        homedir: home,
        directoryExists: existing(declared),
      }),
    ).resolves.toMatchObject({
      ok: true,
      assetPaths: { specialists: declared },
    });
  });

  it('uses only the declared path when the run has no data key', async () => {
    await expect(
      resolvePipelineAssets({
        assets: [asset()],
        dataRoot,
        homedir: home,
        directoryExists: existing(installed, declared),
      }),
    ).resolves.toEqual({ ok: true, assetPaths: { specialists: declared } });
  });

  it('fails a missing required asset, naming it', async () => {
    const result = await resolvePipelineAssets({
      assets: [asset()],
      dataRoot,
      dataKey: 'key',
      homedir: home,
      directoryExists: existing(),
    });
    expect(result).toMatchObject({ ok: false, assetId: 'specialists' });
    if (result.ok) throw new Error('Expected a failure');
    expect(result.message).toContain('"specialists"');
  });

  it('fails a required asset whose path has no anchor', async () => {
    const result = await resolvePipelineAssets({
      assets: [asset({ path: 'specialists' })],
      dataRoot,
      homedir: home,
      directoryExists: existing(),
    });
    expect(result).toMatchObject({ ok: false, assetId: 'specialists' });
  });

  it('resolves a missing optional asset to an empty path', async () => {
    await expect(
      resolvePipelineAssets({
        assets: [
          asset({ required: false }),
          asset({ id: 'notes', path: '~/notes' }),
        ],
        dataRoot,
        dataKey: 'key',
        homedir: home,
        directoryExists: existing(path.join(home, 'notes')),
      }),
    ).resolves.toMatchObject({
      ok: true,
      assetPaths: { specialists: '', notes: path.join(home, 'notes') },
    });
  });
});
