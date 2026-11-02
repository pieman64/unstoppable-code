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
import { listStoredPipelines, saveStoredPipeline } from '../store';

beforeEach(() => {
  mockRoot = mkdtempSync(join(tmpdir(), 'step-count-cache-'));
  mkdirSync(join(mockRoot, 'bundled'));
  writeFileSync(
    join(mockRoot, 'bundled', 'index.json'),
    JSON.stringify({ pipelines: [] }),
  );
});
afterEach(() => {
  rmSync(mockRoot, { recursive: true, force: true });
});

it('reads the cached step count back from the index instead of reparsing each definition', () => {
  const created = saveStoredPipeline({
    name: 'Two steps',
    description: '',
    icon: '',
    content: {
      name: 'Two steps',
      on: 'dispatch',
      jobs: { check: { steps: [{ run: 'echo one' }, { run: 'echo two' }] } },
    },
  });
  if (!created.data) throw new Error(created.error ?? 'No saved pipeline');
  expect(listStoredPipelines().data?.[0]?.stepCount).toBe(2);

  const indexPath = join(mockRoot, 'pipelines', 'index.json');
  const indexBefore = readFileSync(indexPath, 'utf8');
  // An unreadable definition proves the second read came from the index.
  writeFileSync(
    join(mockRoot, 'pipelines', created.data.filename),
    'not: [valid',
  );

  expect(listStoredPipelines().data?.[0]?.stepCount).toBe(2);
  expect(readFileSync(indexPath, 'utf8')).toBe(indexBefore);
});
