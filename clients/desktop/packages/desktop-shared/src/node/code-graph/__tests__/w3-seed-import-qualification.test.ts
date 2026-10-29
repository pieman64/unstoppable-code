import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { CodeGraphEngine } from '../engine';
import { cloneCompletedCodeGraphDatabase } from '../base-graph';
import { openCodeGraphDatabase, getMetadataValue } from '../store/database';
import { CodeGraphStore } from '../store/graph-store';
import { SqliteResolutionDependencyWriter } from '../resolve/resolution-dependency-store';
import { buildCodeGraphSnapshot } from '../snapshot/export';
import { applyCodeGraphSnapshot } from '../snapshot/import';

/** Actual clone/import paths; source is an immutable completed FIXTURE only. */
describe('W3 legacy/seed/snapshot qualification', () => {
  it('never qualifies missing or transplanted capture and never modifies the published source', async () => {
    const temporary = mkdtempSync(path.join(tmpdir(), 'w3-seed-private-'));
    const sourceRoot = path.join(temporary, 'source');
    const targetRoot = path.join(temporary, 'deeper', 'target');
    for (const root of [sourceRoot, targetRoot]) {
      mkdirSync(root, { recursive: true });
      writeFileSync(
        path.join(root, 'lib.ts'),
        'export function run() { return 1; }',
      );
    }
    const sourceDb = path.join(temporary, 'source.db');
    const targetDb = path.join(temporary, 'target.db');
    const source = await CodeGraphEngine.open({
      dbPath: sourceDb,
      repositories: [{ repoId: 'r', rootPath: sourceRoot }],
    });
    try {
      await source.buildOrUpdate({
        resolutionMode: 'full-reset',
        captureResolutionDependencies: true,
        computeDerived: false,
      });
    } finally {
      source.close();
    }
    let sourceMarker: string | null;
    const readonlyObservation = new DatabaseSync(sourceDb, { readOnly: true });
    try {
      sourceMarker = getMetadataValue(
        readonlyObservation,
        'resolution_dependency_capture:r',
      );
    } finally {
      readonlyObservation.close();
    }
    try {
      await cloneCompletedCodeGraphDatabase({
        sourceDbPath: sourceDb,
        targetDbPath: targetDb,
        repositories: [{ repoId: 'r', rootPath: targetRoot }],
      });
      const cloned = openCodeGraphDatabase(targetDb);
      try {
        expect(
          new SqliteResolutionDependencyWriter(cloned).isCompatible({
            repoId: 'r',
            rootPath: targetRoot,
          }),
        ).toBe(false);
      } finally {
        cloned.close();
      }
      const target = await CodeGraphEngine.open({
        dbPath: targetDb,
        repositories: [{ repoId: 'r', rootPath: targetRoot }],
      });
      try {
        await target.buildOrUpdate({
          resolutionMode: 'incremental',
          computeDerived: false,
        });
      } finally {
        target.close();
      }
      const built = openCodeGraphDatabase(targetDb);
      try {
        const writer = new SqliteResolutionDependencyWriter(built);
        expect(writer.isCompatible({ repoId: 'r', rootPath: targetRoot })).toBe(
          true,
        );
        const store = new CodeGraphStore(built);
        const snapshot = await buildCodeGraphSnapshot({
          store,
          repoId: 'r',
          generatedAt: '2026-10-08T00:00:00.000Z',
        });
        await applyCodeGraphSnapshot({
          store,
          db: built,
          repoId: 'r',
          rootPath: targetRoot,
          envelope: snapshot.envelope,
        });
        expect(writer.isCompatible({ repoId: 'r', rootPath: targetRoot })).toBe(
          false,
        );
        expect(
          built.prepare('SELECT * FROM resolution_dependencies').all(),
        ).toEqual([]);
      } finally {
        built.close();
      }
      const imported = await CodeGraphEngine.open({
        dbPath: targetDb,
        repositories: [{ repoId: 'r', rootPath: targetRoot }],
      });
      try {
        await imported.buildOrUpdate({
          resolutionMode: 'incremental',
          computeDerived: false,
        });
      } finally {
        imported.close();
      }
      const unchanged = new DatabaseSync(sourceDb, { readOnly: true });
      try {
        expect(
          getMetadataValue(unchanged, 'resolution_dependency_capture:r'),
        ).toBe(sourceMarker);
      } finally {
        unchanged.close();
      }
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }, 60_000);
});
