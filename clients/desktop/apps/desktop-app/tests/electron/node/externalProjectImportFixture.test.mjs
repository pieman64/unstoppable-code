import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  claudeProjectSlug,
  IMPORT_FIXTURE_GIT_SESSION_ID,
  seedExternalProjectImportFixture,
} from '../seeders/seedExternalProjectImportFixture.mjs';

test('external import fixture keeps original defaults and timestamps', () => {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'can4674-fixture-'));
  const fixture = seedExternalProjectImportFixture({ userDataDir });
  try {
    const registry = JSON.parse(
      readFileSync(path.join(fixture.claudeDir, '.claude.json'), 'utf8'),
    );
    assert.deepEqual(Object.keys(registry.projects), [
      fixture.gitApp,
      fixture.notes,
    ]);
    assert.equal(path.basename(fixture.gitApp), 'can2439-git-app');
    assert.equal(path.basename(fixture.notes), 'can2439-plain-notes');
    const transcript = readFileSync(
      path.join(
        fixture.claudeDir,
        'projects',
        claudeProjectSlug(fixture.gitApp),
        `${IMPORT_FIXTURE_GIT_SESSION_ID}.jsonl`,
      ),
      'utf8',
    );
    assert.equal(
      JSON.parse(transcript.split('\n')[0]).timestamp,
      '2026-09-01T10:00:00.000Z',
    );
    assert.deepEqual(fixture.extraProjects, []);
  } finally {
    fixture.cleanup();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('opt-in activity dates and extra rules repositories are committed and discoverable', () => {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'can4674-fixture-'));
  const timestamp = '2026-10-19T12:00:00.000Z';
  const fixture = seedExternalProjectImportFixture({
    userDataDir,
    activityTimestamps: { gitApp: timestamp },
    extraGitProjects: [
      {
        name: 'payments-service',
        lastActivityAt: timestamp,
        rules: 'PAYMENTS_RULE\n',
      },
    ],
  });
  try {
    const [project] = fixture.extraProjects;
    assert.equal(
      execFileSync('git', ['show', 'HEAD:.cursorrules'], {
        cwd: project.dir,
        encoding: 'utf8',
      }),
      'PAYMENTS_RULE\n',
    );
    assert.equal(
      execFileSync('git', ['status', '--porcelain'], {
        cwd: project.dir,
        encoding: 'utf8',
      }),
      '',
    );
    const registry = JSON.parse(
      readFileSync(path.join(fixture.claudeDir, '.claude.json'), 'utf8'),
    );
    assert.ok(registry.projects[project.dir]);
    const transcript = readFileSync(
      path.join(
        fixture.claudeDir,
        'projects',
        claudeProjectSlug(project.dir),
        `${project.sessionId}.jsonl`,
      ),
      'utf8',
    );
    assert.equal(JSON.parse(transcript.split('\n')[0]).timestamp, timestamp);
  } finally {
    fixture.cleanup();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
