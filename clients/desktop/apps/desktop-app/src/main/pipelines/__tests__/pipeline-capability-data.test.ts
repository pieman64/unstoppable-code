import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  getBundledPipelinesDir,
  getUserPipelineIndexPath,
  getUserPipelinesDir,
} from '@canopy/desktop-shared/pipelines/config-paths';
import { parsePipelineText } from '@canopy/desktop-shared/pipelines/parse-pipeline';
import type * as ParsePipelineModule from '@canopy/desktop-shared/pipelines/parse-pipeline';
import { listPipelineCapabilityData } from '../pipeline-capability-data';

jest.mock('@canopy/desktop-shared/pipelines/config-paths', () => ({
  getBundledPipelinesDir: jest.fn(),
  getUserPipelineIndexPath: jest.fn(),
  getUserPipelinesDir: jest.fn(),
}));

jest.mock('@canopy/desktop-shared/pipelines/parse-pipeline', () => {
  const actual = jest.requireActual<typeof ParsePipelineModule>(
    '@canopy/desktop-shared/pipelines/parse-pipeline',
  );
  return {
    ...actual,
    parsePipelineText: jest.fn(actual.parsePipelineText),
  };
});

const mockedGetBundledPipelinesDir = jest.mocked(getBundledPipelinesDir);
const mockedGetUserPipelineIndexPath = jest.mocked(getUserPipelineIndexPath);
const mockedGetUserPipelinesDir = jest.mocked(getUserPipelinesDir);
const mockedParsePipelineText = jest.mocked(parsePipelineText);

function indexEntry(id: string, filename: string): Record<string, string> {
  return {
    id,
    name: id,
    filename,
    createdAt: '2026-08-19T00:00:00.000Z',
    updatedAt: '2026-08-19T00:00:00.000Z',
  };
}

function pipelineYaml(name: string, description = 'test pipeline'): string {
  return [
    `name: ${name}`,
    `description: ${description}`,
    'on: dispatch',
    'jobs:',
    '  main:',
    '    steps:',
    '      - run: echo test',
    '',
  ].join('\n');
}

describe('listPipelineCapabilityData', () => {
  let tempDir: string;
  let bundledDir: string;
  let userDir: string;
  let userIndexPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(
      path.join(os.tmpdir(), 'pipeline-capability-data-'),
    );
    bundledDir = path.join(tempDir, 'bundled');
    userDir = path.join(tempDir, 'user');
    userIndexPath = path.join(userDir, 'index.json');
    await Promise.all([
      mkdir(bundledDir, { recursive: true }),
      mkdir(userDir, { recursive: true }),
    ]);
    await writeFile(
      path.join(bundledDir, 'index.json'),
      JSON.stringify({ pipelines: [] }),
      'utf8',
    );
    mockedGetBundledPipelinesDir.mockReturnValue(bundledDir);
    mockedGetUserPipelinesDir.mockReturnValue(userDir);
    mockedGetUserPipelineIndexPath.mockReturnValue(userIndexPath);
    mockedParsePipelineText.mockClear();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('skips malformed index entries and filenames that escape the pipeline root', async () => {
    await writeFile(
      userIndexPath,
      JSON.stringify({
        pipelines: [
          indexEntry('valid', 'valid.yaml'),
          { id: 'missing-fields' },
          indexEntry('traversal', '../../outside.yaml'),
        ],
      }),
      'utf8',
    );
    await writeFile(
      path.join(userDir, 'valid.yaml'),
      pipelineYaml('Valid pipeline'),
      'utf8',
    );
    await writeFile(
      path.join(tempDir, 'outside.yaml'),
      pipelineYaml('Outside pipeline'),
      'utf8',
    );

    const result = await listPipelineCapabilityData();

    expect(result.success).toBe(true);
    expect(result.data?.map((entry) => entry.info.id)).toEqual(['valid']);
    expect(mockedParsePipelineText).toHaveBeenCalledTimes(1);
  });

  it('reuses unchanged parsed content and reparses after size changes', async () => {
    const filename = 'cached.yaml';
    const pipelinePath = path.join(userDir, filename);
    await writeFile(
      userIndexPath,
      JSON.stringify({ pipelines: [indexEntry('cached', filename)] }),
      'utf8',
    );
    await writeFile(pipelinePath, pipelineYaml('Cached pipeline'), 'utf8');

    await listPipelineCapabilityData();
    await listPipelineCapabilityData();
    expect(mockedParsePipelineText).toHaveBeenCalledTimes(1);

    await writeFile(
      pipelinePath,
      pipelineYaml('Cached pipeline', 'description with a different size'),
      'utf8',
    );
    const refreshed = await listPipelineCapabilityData();

    expect(mockedParsePipelineText).toHaveBeenCalledTimes(2);
    expect(refreshed.success).toBe(true);
    expect(refreshed.data?.[0]?.content.description).toBe(
      'description with a different size',
    );
  });
});
