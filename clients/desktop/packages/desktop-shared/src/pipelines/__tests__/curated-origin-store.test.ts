import type { PipelineSaveInput } from '../../types/pipeline';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let mockRoot = '';
jest.mock('../config-paths', () => ({
  getUserPipelinesDir: (): string => join(mockRoot, 'pipelines'),
  getUserPipelineIndexPath: (): string =>
    join(mockRoot, 'pipelines', 'index.json'),
  getBundledPipelinesDir: (): string => join(mockRoot, 'bundled'),
}));
import {
  clearStoredPipelineRemoteMetadataByRemoteId,
  duplicateStoredPipeline,
  getStoredPipeline,
  listStoredPipelines,
  saveStoredPipeline,
  writeStoredPipelineRemoteMetadata,
} from '../store';

beforeEach(() => {
  mockRoot = mkdtempSync(join(tmpdir(), 'curated-origin-'));
  mkdirSync(join(mockRoot, 'bundled'));
  writeFileSync(
    join(mockRoot, 'bundled', 'index.json'),
    JSON.stringify({ pipelines: [] }),
  );
});
afterEach(() => {
  rmSync(mockRoot, { recursive: true, force: true });
});

it('preserves provenance through index reads, edits and copies without creating a managed runtime source', () => {
  const origin = {
    key: 'curated-check',
    contentHash: 'a'.repeat(64),
    revision: 1,
    importedAt: '2026-09-10T00:00:00.000Z',
  };
  const input = {
    name: 'Imported',
    description: '',
    icon: '',
    curatedOrigin: origin,
    content: {
      name: 'Imported',
      on: 'dispatch' as const,
      jobs: { check: { steps: [{ run: 'echo reviewed' }] } },
    },
  };
  const created = saveStoredPipeline(input);
  expect(created).toMatchObject({ success: true });
  if (!created.data) throw new Error(created.error ?? 'No saved pipeline');
  const id = created.data.id;
  expect(listStoredPipelines().data).toEqual([
    expect.objectContaining({
      id,
      source: 'user',
      readonly: false,
      curatedOrigin: origin,
    }),
  ]);
  const edit = { ...input, curatedOrigin: undefined };
  const saved = saveStoredPipeline({ ...edit, id, name: 'My changes' });
  expect(saved.data?.curatedOrigin).toEqual(origin);
  expect(getStoredPipeline(id).data?.info.curatedOrigin).toEqual(origin);
  const copy = duplicateStoredPipeline(id);
  expect(copy.data?.id).not.toBe(id);
  expect(copy.data?.curatedOrigin).toEqual(origin);
  expect(listStoredPipelines().data).toHaveLength(2);
});

it('writes supplied validated pipeline bytes without re-serializing them', () => {
  const rawContent =
    '# preserve publisher formatting\npipeline: {name: Imported, on: dispatch, jobs: {check: {steps: []}}}\n';
  const created = saveStoredPipeline({
    name: 'Imported',
    description: '',
    icon: '',
    content: {
      name: 'Imported',
      on: 'dispatch',
      jobs: { check: { steps: [] } },
    },
    rawContent,
  });

  expect(created).toMatchObject({ success: true });
  if (!created.data) throw new Error(created.error ?? 'No saved pipeline');
  expect(
    readFileSync(
      join(mockRoot, 'pipelines', `${created.data.id}.yaml`),
      'utf8',
    ),
  ).toBe(rawContent);
  expect(getStoredPipeline(created.data.id).data?.rawContent).toBe(rawContent);
});

it('persists and clears author-side cloud share metadata', () => {
  const created = saveStoredPipeline({
    name: 'Shared locally',
    description: '',
    icon: '',
    content: { name: 'Shared locally', on: 'dispatch', jobs: {} },
  });
  if (!created.data) throw new Error(created.error ?? 'No saved pipeline');
  const remote = {
    remoteId: '11111111-1111-4111-8111-111111111111',
    contentHash: 'content-hash',
    shareScope: 'team' as const,
    sharedAt: '2026-09-24T16:00:00.000Z',
  };

  const written = writeStoredPipelineRemoteMetadata(created.data.id, remote);
  expect(written.success).toBe(true);
  expect(getStoredPipeline(created.data.id).data?.info.remote).toEqual(remote);
  expect(
    saveStoredPipeline({
      name: 'Edited locally',
      description: '',
      icon: '',
      id: created.data.id,
      content: { name: 'Edited locally', on: 'dispatch', jobs: {} },
    }).data?.remote,
  ).toEqual(remote);
  expect(clearStoredPipelineRemoteMetadataByRemoteId(remote.remoteId)).toEqual({
    success: true,
    data: 1,
  });
  expect(getStoredPipeline(created.data.id).data?.info.remote).toBeUndefined();
});

it('rejects raw pipeline bytes that do not match the parsed save content', () => {
  const result = saveStoredPipeline({
    name: 'Imported',
    description: '',
    icon: '',
    content: { name: 'Imported', on: 'dispatch', jobs: {} },
    rawContent: 'pipeline: {name: Different, on: dispatch, jobs: {}}\n',
  });

  expect(result).toEqual({
    success: false,
    error: 'Raw pipeline document does not match parsed pipeline content.',
  });
});

it('creates a trusted fixed identity once without changing ordinary create semantics', () => {
  const input: PipelineSaveInput = {
    name: 'Fixed',
    description: '',
    icon: '',
    content: {
      name: 'Fixed',
      on: 'dispatch',
      jobs: { check: { steps: [{ run: 'echo ok' }] } },
    },
  };
  expect(saveStoredPipeline(input, { id: 'fixed-id' })).toMatchObject({
    success: true,
    data: { id: 'fixed-id' },
  });
  expect(
    saveStoredPipeline({ ...input, name: 'Overwrite' }, { id: 'fixed-id' }),
  ).toMatchObject({ success: false });
  expect(getStoredPipeline('fixed-id').data?.info.name).toBe('Fixed');
  expect(
    saveStoredPipeline({ ...input, id: 'unallocated-id' }).data?.id,
  ).not.toBe('unallocated-id');
});
