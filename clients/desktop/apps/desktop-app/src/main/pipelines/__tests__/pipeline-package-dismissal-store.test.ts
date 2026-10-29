import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  listPipelinePackageDismissals,
  replacePipelinePackageDismissals,
} from '../pipeline-package-dismissal-store';

describe('pipeline package dismissal store', () => {
  it('persists and replaces dismissals per pipeline scope', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pipeline-package-dismissals-'));
    const storePath = join(root, 'dismissals.json');
    try {
      await replacePipelinePackageDismissals(storePath, 'pipeline-1', [
        { provider: 'claude', token: '/collect.py' },
        { provider: 'codex', token: '$missing' },
      ]);
      await replacePipelinePackageDismissals(storePath, 'pipeline-2', [
        { provider: 'claude', token: '/other' },
      ]);
      await replacePipelinePackageDismissals(storePath, 'pipeline-1', [
        { provider: 'claude', token: '/collect.py' },
      ]);

      await expect(
        listPipelinePackageDismissals(storePath, 'pipeline-1'),
      ).resolves.toEqual([
        expect.objectContaining({
          scopeKey: 'pipeline-1',
          provider: 'claude',
          token: '/collect.py',
        }),
      ]);
      expect(JSON.parse(await readFile(storePath, 'utf8'))).toMatchObject({
        version: 1,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('accepts a deeply nested command token', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pipeline-package-dismissals-'));
    const storePath = join(root, 'dismissals.json');
    try {
      await replacePipelinePackageDismissals(storePath, 'pipeline-1', [
        { provider: 'claude', token: '/a:b:c' },
      ]);
      await expect(
        listPipelinePackageDismissals(storePath, 'pipeline-1'),
      ).resolves.toEqual([expect.objectContaining({ token: '/a:b:c' })]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
