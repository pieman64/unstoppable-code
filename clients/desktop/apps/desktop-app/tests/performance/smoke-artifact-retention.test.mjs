import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pruneSmokeDiagnosticArtifacts } from './smoke-artifact-retention.mjs';

async function createArtifact(
  root,
  basename,
  { json = true, diagnostics = true } = {},
) {
  if (json) {
    await writeFile(join(root, `${basename}.json`), '{}\n', 'utf8');
  }
  if (diagnostics) {
    const diagnosticDir = join(root, `${basename}-diagnostics`);
    await mkdir(diagnosticDir, { recursive: true });
    await writeFile(join(diagnosticDir, 'triage.md'), '# Triage\n', 'utf8');
  }
}

test('smoke diagnostic retention keeps the latest two run pairs and removes stale members together', async (t) => {
  const outputDir = await mkdtemp(join(tmpdir(), 'canopy-smoke-retention-'));
  t.after(() => rm(outputDir, { recursive: true, force: true }));

  await createArtifact(outputDir, '2026-08-19T10-00-00.000Z-smoke');
  await createArtifact(outputDir, '2026-08-19T11-00-00.000Z-smoke', {
    diagnostics: false,
  });
  await createArtifact(outputDir, '2026-08-19T12-00-00.000Z-smoke', {
    json: false,
  });
  await createArtifact(outputDir, '2026-08-19T13-00-00.000Z-smoke');
  await writeFile(
    join(outputDir, '2026-08-19T09-00-00.000Z-baseline.json'),
    '{}\n',
  );
  await mkdir(join(outputDir, 'unrelated-diagnostics'));

  const removed = pruneSmokeDiagnosticArtifacts(outputDir, { keep: 2 });

  assert.deepEqual(removed, [
    '2026-08-19T10-00-00.000Z-smoke',
    '2026-08-19T12-00-00.000Z-smoke',
  ]);
  assert.deepEqual((await readdir(outputDir)).sort(), [
    '2026-08-19T09-00-00.000Z-baseline.json',
    '2026-08-19T11-00-00.000Z-smoke.json',
    '2026-08-19T13-00-00.000Z-smoke-diagnostics',
    '2026-08-19T13-00-00.000Z-smoke.json',
    'unrelated-diagnostics',
  ]);
});
