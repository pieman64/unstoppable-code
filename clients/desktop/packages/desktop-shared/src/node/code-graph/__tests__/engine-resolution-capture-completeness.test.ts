import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { CodeGraphEngine } from '../engine';
import {
  openCodeGraphDatabase,
  withImmediateTransaction,
} from '../store/database';
import { CodeGraphStore } from '../store/graph-store';
import { runCapturedRepositoryResolution } from '../resolve/captured-resolution-passes';
import { SqliteResolutionDependencyWriter } from '../resolve/resolution-dependency-store';
import type { ResolutionDependencyCaptureMetadata } from '../resolve/resolution-dependency-capture';

async function captureNamedImport(invalidDefaultLocal?: number): Promise<{
  metadata: ResolutionDependencyCaptureMetadata;
  compatible: boolean;
}> {
  const temporary = mkdtempSync(path.join(tmpdir(), 'graph-capture-complete-'));
  const rootPath = path.join(temporary, 'checkout');
  mkdirSync(rootPath);
  writeFileSync(
    path.join(rootPath, 'lib.ts'),
    'export function run() { return 1; }\n',
  );
  writeFileSync(
    path.join(rootPath, 'main.ts'),
    "import { run } from './lib'; export function main() { return run(); }\n",
  );
  const dbPath = path.join(temporary, 'graph.db');
  const engine = await CodeGraphEngine.open({
    dbPath,
    repositories: [{ repoId: 'fixture', rootPath }],
  });
  try {
    await engine.buildOrUpdate({
      resolutionMode: 'full-diff',
      captureResolutionDependencies: true,
      computeDerived: false,
    });
    const db = openCodeGraphDatabase(dbPath);
    try {
      if (invalidDefaultLocal !== undefined) {
        withImmediateTransaction(db, () => {
          const store = new CodeGraphStore(db);
          const imported = store.listEdges({
            repoId: 'fixture',
            kind: 'IMPORTS_FROM',
          })[0];
          if (imported === undefined)
            throw new Error('Missing extracted import');
          store.updateEdgeEvidence(imported.id, {
            ...imported.evidence,
            defaultLocal: invalidDefaultLocal,
          });
          store.resetResolutions();
          runCapturedRepositoryResolution({
            db,
            store,
            repoId: 'fixture',
            rootPath,
          });
        });
      }
      const writer = new SqliteResolutionDependencyWriter(db);
      const metadata = writer.readMetadata('fixture');
      if (metadata === null)
        throw new Error('Capture metadata was not published');
      return {
        metadata,
        compatible: writer.isCompatible({ repoId: 'fixture', rootPath }),
      };
    } finally {
      db.close();
    }
  } finally {
    engine.close();
    rmSync(temporary, { recursive: true, force: true });
  }
}

describe('actual extracted named-import dependency completeness', () => {
  it('keeps malformed binding values incomplete and incompatible', async () => {
    const { metadata, compatible } = await captureNamedImport(42);
    expect(metadata.reasonsByResolver['call-resolution']).toContain(
      'call-import-local-not-string',
    );
    expect(metadata.complete).toBe(false);
    expect(compatible).toBe(false);
  });
  it('accepts null absent default and namespace bindings from the production extractor', async () => {
    const { metadata } = await captureNamedImport();
    expect(metadata.reasonsByResolver['call-resolution'] ?? []).toEqual([]);
  });
  it('records each TypeScript module candidate with one consistent observation', async () => {
    const { metadata, compatible } = await captureNamedImport();
    expect(metadata.reasonsByResolver['ts-module-resolution'] ?? []).toEqual(
      [],
    );
    expect(metadata.complete).toBe(true);
    expect(compatible).toBe(true);
  });
});
