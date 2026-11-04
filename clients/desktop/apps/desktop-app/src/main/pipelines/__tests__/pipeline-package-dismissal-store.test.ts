import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as atomicFile from '../../lib/atomic-file';
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
  it('reads a damaged store as empty and copies it aside before replacing it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pipeline-package-dismissals-'));
    const storePath = join(root, 'dismissals.json');
    try {
      await writeFile(storePath, '{"version":1,"records":[TRUNC', 'utf8');
      await expect(
        listPipelinePackageDismissals(storePath, 'pipeline-1'),
      ).resolves.toEqual([]);
      await expect(
        replacePipelinePackageDismissals(storePath, 'pipeline-1', [
          { provider: 'claude', token: '/collect.py' },
        ]),
      ).resolves.toBe('replaced');
      const aside = (await readdir(root)).filter((name) =>
        name.startsWith('dismissals.json.damaged-'),
      );
      expect(aside).toHaveLength(1);
      await expect(readFile(join(root, aside[0] ?? ''), 'utf8')).resolves.toBe(
        '{"version":1,"records":[TRUNC',
      );
      expect(
        (await listPipelinePackageDismissals(storePath, 'pipeline-1')).map(
          ({ token }) => token,
        ),
      ).toEqual(['/collect.py']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps valid records and carries rows it cannot read through a replacement', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pipeline-package-dismissals-'));
    const storePath = join(root, 'dismissals.json');
    const future = {
      scopeKey: 'pipeline-2',
      provider: 'cursor',
      token: '/later',
      dismissedAt: '2026-10-01T00:00:00.000Z',
    };
    const kept = {
      scopeKey: 'pipeline-2',
      provider: 'claude',
      token: '/kept',
      dismissedAt: '2026-10-01T00:00:00.000Z',
    };
    try {
      await writeFile(
        storePath,
        JSON.stringify({ version: 1, records: [future, kept] }),
        'utf8',
      );
      await expect(
        listPipelinePackageDismissals(storePath, 'pipeline-2'),
      ).resolves.toEqual([kept]);
      await replacePipelinePackageDismissals(storePath, 'pipeline-1', [
        { provider: 'codex', token: '$skill' },
      ]);
      const stored: unknown = JSON.parse(await readFile(storePath, 'utf8'));
      expect(stored).toEqual({
        version: 1,
        records: [
          kept,
          expect.objectContaining({ scopeKey: 'pipeline-1', token: '$skill' }),
          future,
        ],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('never writes over a store from a newer version', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pipeline-package-dismissals-'));
    const storePath = join(root, 'dismissals.json');
    const newer = JSON.stringify({ version: 2, records: [], scopes: {} });
    try {
      await writeFile(storePath, newer, 'utf8');
      await expect(
        listPipelinePackageDismissals(storePath, 'pipeline-1'),
      ).resolves.toEqual([]);
      await expect(
        replacePipelinePackageDismissals(storePath, 'pipeline-1', [
          { provider: 'claude', token: '/collect.py' },
        ]),
      ).resolves.toBe('refused');
      await expect(readFile(storePath, 'utf8')).resolves.toBe(newer);
      expect(await readdir(root)).toEqual(['dismissals.json']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('installs replacements atomically and durably', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pipeline-package-dismissals-'));
    const storePath = join(root, 'dismissals.json');
    const write = jest.spyOn(atomicFile, 'writeFileAtomically');
    try {
      await replacePipelinePackageDismissals(storePath, 'pipeline-1', [
        { provider: 'claude', token: '/collect.py' },
      ]);
      expect(write).toHaveBeenCalledTimes(1);
      expect(write.mock.calls[0]?.[0]).toBe(storePath);
      expect(write.mock.calls[0]?.[2]).toMatchObject({ durable: true });
    } finally {
      write.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });
});
