import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
  deleteStoredPipeline,
  getStoredPipeline,
  getStoredPipelineText,
  updateStoredPipeline,
} from '../store';

beforeEach(() => {
  mockRoot = mkdtempSync(join(tmpdir(), 'store-errors-'));
  mkdirSync(join(mockRoot, 'bundled'));
  writeFileSync(
    join(mockRoot, 'bundled', 'index.json'),
    JSON.stringify({
      pipelines: [
        {
          id: 'code-review',
          name: 'Code review',
          description: '',
          icon: '',
          filename: 'code-review.yaml',
        },
      ],
    }),
  );
});
afterEach(() => {
  rmSync(mockRoot, { recursive: true, force: true });
});

// The desktop renders these IPC result errors in the editor, the Library and
// the share install review, so they say "workflow" (CAN-4651). The CLI prints
// the same strings.
describe('stored workflow errors', () => {
  it('names a missing workflow', () => {
    expect(getStoredPipeline('missing')).toEqual({
      success: false,
      error: 'Workflow not found: missing',
    });
    expect(deleteStoredPipeline('missing')).toEqual({
      success: false,
      error: 'Workflow not found: missing',
    });
  });

  it('names a missing workflow file', () => {
    expect(getStoredPipelineText('code-review')).toEqual({
      success: false,
      error: 'Workflow file not found: code-review.yaml',
    });
  });

  it('refuses to change bundled workflows', () => {
    expect(deleteStoredPipeline('code-review')).toEqual({
      success: false,
      error: 'Cannot delete bundled workflow: code-review',
    });
    expect(
      updateStoredPipeline('code-review', {
        name: 'Renamed',
        description: '',
        icon: '',
        content: { name: 'Renamed', on: 'dispatch', jobs: {} },
      }),
    ).toEqual({
      success: false,
      error: 'Cannot update bundled workflow: code-review',
    });
  });
});
