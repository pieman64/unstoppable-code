import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePipelineText } from '../../../pipelines/parse-pipeline';
import type { PipelineDefinitionWrite } from '@canopy/core-runtime/node/pipeline';

let mockRoot = '';
jest.mock('../../../pipelines/config-paths', () => ({
  getUserPipelinesDir: (): string => join(mockRoot, 'pipelines'),
  getUserPipelineIndexPath: (): string =>
    join(mockRoot, 'pipelines', 'index.json'),
  getBundledPipelinesDir: (): string => join(mockRoot, 'bundled'),
}));
import * as store from '../../../pipelines/store';
import {
  readStoredPipelineRevision,
  writeStoredPipelineRemoteMetadata,
} from '../../../pipelines/store';
import { createStoredPipelineDefinitionWriter } from '../definition-sources';

const TEXT = [
  'pipeline:',
  '  name: Review',
  '  on: dispatch',
  '  jobs:',
  '    build:',
  '      steps:',
  '        - run: echo ok',
  '',
].join('\n');

const context = { scope: {}, signal: new AbortController().signal };

function write(
  overrides: Partial<PipelineDefinitionWrite> = {},
): PipelineDefinitionWrite {
  const text = overrides.text ?? TEXT;
  return {
    definitionId: null,
    expectedRevision: null,
    name: 'Review',
    description: '',
    icon: '',
    text,
    pipeline: parsePipelineText(text ?? TEXT),
    ...overrides,
  };
}

beforeEach(() => {
  mockRoot = mkdtempSync(join(tmpdir(), 'definition-writer-'));
  mkdirSync(join(mockRoot, 'bundled'));
  writeFileSync(join(mockRoot, 'bundled', 'review.yaml'), TEXT);
  writeFileSync(
    join(mockRoot, 'bundled', 'index.json'),
    JSON.stringify({
      pipelines: [
        {
          id: 'bundled-review',
          name: 'Review',
          filename: 'review.yaml',
          description: '',
          icon: '',
          createdAt: '2026-10-27T00:00:00.000Z',
          updatedAt: '2026-10-27T00:00:00.000Z',
        },
      ],
    }),
  );
});
afterEach(() => {
  rmSync(mockRoot, { recursive: true, force: true });
});

describe('stored pipeline definition writer', () => {
  it('raises the revision on every save and refuses a stale one', async () => {
    const writer = createStoredPipelineDefinitionWriter();
    const created = await writer.upsert(write(), context);
    expect(created).toMatchObject({ source: 'user', revision: 1, text: TEXT });
    const id = created.definitionId;
    const edited = TEXT.replace('echo ok', 'echo edited');
    expect(
      await writer.upsert(
        write({ definitionId: id, expectedRevision: 1, text: edited }),
        context,
      ),
    ).toMatchObject({ revision: 2, text: edited });
    await expect(
      writer.upsert(write({ definitionId: id, expectedRevision: 1 }), context),
    ).rejects.toMatchObject({
      code: 'core.pipeline.revisionConflict',
      message: `Workflow changed since it was loaded: ${id}`,
    });
    expect(
      readFileSync(join(mockRoot, 'pipelines', `${id}.yaml`), 'utf8'),
    ).toBe(edited);
    await expect(writer.delete(id, 1, context)).rejects.toMatchObject({
      code: 'core.pipeline.revisionConflict',
    });
    expect(await writer.delete(id, 2, context)).toBe(2);
    expect(readStoredPipelineRevision(id)).toBeNull();
  });

  it('keeps the revision through a share link and reads a legacy entry as 0', async () => {
    const writer = createStoredPipelineDefinitionWriter();
    const { definitionId: id } = await writer.upsert(write(), context);
    writeStoredPipelineRemoteMetadata(id, {
      remoteId: '7f1c2d3e-4b5a-4c6d-8e9f-0a1b2c3d4e5f',
      contentHash: 'a'.repeat(64),
      shareScope: 'private',
      sharedAt: '2026-10-27T00:00:00.000Z',
    });
    expect(readStoredPipelineRevision(id)).toEqual({
      source: 'user',
      revision: 1,
    });
    const indexPath = join(mockRoot, 'pipelines', 'index.json');
    const index = JSON.parse(readFileSync(indexPath, 'utf8')) as {
      pipelines: Record<string, unknown>[];
    };
    delete index.pipelines[0].revision;
    writeFileSync(indexPath, JSON.stringify(index));
    expect(readStoredPipelineRevision(id)).toEqual({
      source: 'user',
      revision: 0,
    });
    expect(
      (
        await writer.upsert(
          write({ definitionId: id, expectedRevision: 0 }),
          context,
        )
      ).revision,
    ).toBe(1);
  });

  it('refuses bundled and unknown ids with the store messages', async () => {
    const writer = createStoredPipelineDefinitionWriter();
    await expect(
      writer.upsert(write({ definitionId: 'bundled-review' }), context),
    ).rejects.toMatchObject({
      code: 'core.pipeline.definitionReadOnly',
      message: 'Cannot update bundled workflow: bundled-review',
    });
    await expect(
      writer.delete('bundled-review', null, context),
    ).rejects.toMatchObject({
      code: 'core.pipeline.definitionReadOnly',
      message: 'Cannot delete bundled workflow: bundled-review',
    });
    await expect(
      writer.upsert(write({ definitionId: 'missing' }), context),
    ).rejects.toMatchObject({
      code: 'core.pipeline.definitionNotFound',
      message: 'Workflow not found: missing',
    });
  });

  it('refuses an update whose owner it cannot read before saving anything', async () => {
    const created = await createStoredPipelineDefinitionWriter().upsert(
      write(),
      context,
    );
    const writer = createStoredPipelineDefinitionWriter({
      owner: (): string | null => {
        throw new Error('owner metadata unreadable');
      },
    });
    await expect(
      writer.upsert(
        write({ definitionId: created.definitionId, expectedRevision: 1 }),
        context,
      ),
    ).rejects.toThrow('owner metadata unreadable');
    expect(readStoredPipelineRevision(created.definitionId)).toEqual({
      source: 'user',
      revision: 1,
    });
  });

  it('answers a committed save without reading it back', async () => {
    const read = jest
      .spyOn(store, 'readStoredPipelineDocument')
      .mockReturnValue({ kind: 'missing' });
    try {
      const created = await createStoredPipelineDefinitionWriter().upsert(
        write(),
        context,
      );
      expect(created).toMatchObject({ revision: 1, text: TEXT });
      expect(read).not.toHaveBeenCalled();
    } finally {
      read.mockRestore();
    }
  });
});
