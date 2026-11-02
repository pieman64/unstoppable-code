import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import yaml from 'js-yaml';
import { STORAGE_OWNERSHIP } from '@canopy/core-runtime/storage';
import { admittedStorageRowForPath } from '../admitted-storage-paths';

// Reads the planning census, so the desktop public export excludes this suite.
const MANIFEST = resolve(
  __dirname,
  '../../../../../../docs/planning/2026-07-31-desktop-core-daemon/artifacts/storage-ownership.yaml',
);
const ROOT = resolve('/data/canopy');

interface ManifestRow {
  id: string;
  admittedWriters?: string[];
  patterns?: string[];
  pathPatterns?: string[];
}

function manifestRows(): ManifestRow[] {
  const document: unknown = yaml.load(readFileSync(MANIFEST, 'utf8'));
  if (
    typeof document !== 'object' ||
    document === null ||
    !('rows' in document) ||
    !Array.isArray(document.rows)
  )
    throw new Error('storage-ownership.yaml has no rows');
  const rows: unknown[] = document.rows;
  return rows.filter(isAdmittedManifestRow);
}

function isAdmittedManifestRow(row: unknown): row is ManifestRow {
  return (
    typeof row === 'object' &&
    row !== null &&
    'id' in row &&
    typeof row.id === 'string' &&
    'admittedWriters' in row &&
    Array.isArray(row.admittedWriters)
  );
}

it('classifies every manifest pattern of each admitted row, and only those rows', () => {
  const rows = manifestRows();
  expect(rows.map((row) => row.id).sort()).toEqual(
    STORAGE_OWNERSHIP.filter((row) => 'admittedWriters' in row)
      .map((row) => row.id)
      .sort(),
  );
  for (const row of rows) {
    const patterns = [...(row.patterns ?? []), ...(row.pathPatterns ?? [])];
    expect(patterns.length).toBeGreaterThan(0);
    for (const pattern of patterns) {
      const path = join(
        ROOT,
        ...pattern
          .replace(/^<data>\//, '')
          .replaceAll('{}', 'id-1')
          .split('/'),
      );
      expect(admittedStorageRowForPath(path, ROOT)).toBe(row.id);
    }
  }
});
