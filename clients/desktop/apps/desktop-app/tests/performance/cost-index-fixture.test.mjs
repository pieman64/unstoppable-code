import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import * as classifierModule from '../../src/main/cost-index/classifier.ts';
import { seedCostIndexAudit } from './cost-index-fixture.mjs';

// tsx loads the TypeScript source as CommonJS, behind a default export.
const { classifyAuditEntry } = classifierModule.default ?? classifierModule;

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const NOW = Date.parse('2026-10-11T18:00:00.000Z');

function withDataDir(run) {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'perf-cost-index-'));
  try {
    return run(userDataDir);
  } finally {
    rmSync(userDataDir, { recursive: true, force: true });
  }
}

function seed(userDataDir, overrides = {}) {
  return seedCostIndexAudit({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    days: 3,
    linesPerDay: 2_000,
    turnsPerDay: 40,
    now: NOW,
    ...overrides,
  });
}

function readEntries(filePath) {
  return readFileSync(filePath, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

test('writes one audit file per UTC day, ending today, under the observability audit directory', () => {
  withDataDir((userDataDir) => {
    const seeded = seed(userDataDir);

    assert.equal(
      seeded.auditDir,
      path.join(userDataDir, 'agent-observability', 'audit'),
    );
    assert.deepEqual(readdirSync(seeded.auditDir).sort(), [
      '2026-10-09.jsonl',
      '2026-10-10.jsonl',
      '2026-10-11.jsonl',
    ]);
    // Full days hold every line; today holds the 18 hours already passed.
    assert.equal(readEntries(seeded.files[0]).length, 2_000);
    assert.equal(readEntries(seeded.files[2]).length, 1_500);
    assert.equal(seeded.lines, 5_500);
    assert.ok(seeded.bytes > 5_500 * 600);
  });
});

test('keeps every entry on its own day and none in the future', () => {
  withDataDir((userDataDir) => {
    const seeded = seed(userDataDir);
    for (const file of seeded.files) {
      const day = path.basename(file, '.jsonl');
      for (const entry of readEntries(file)) {
        assert.equal(entry.startedAt.slice(0, 10), day);
        assert.ok(Date.parse(entry.startedAt) < NOW);
        if (entry.completedAt !== undefined) {
          assert.ok(Date.parse(entry.completedAt) < NOW);
        }
      }
    }
  });
});

test('writes each chat turn when it starts and again when it ends, across five scopes', () => {
  withDataDir((userDataDir) => {
    const seeded = seed(userDataDir);
    const entries = readEntries(seeded.files[0]);
    const turns = entries.filter(
      (entry) => entry.eventType === 'worktree_chat',
    );
    const summaries = entries.filter(
      (entry) => entry.eventType === 'worktree_summary',
    );

    assert.equal(turns.length, 80);
    assert.equal(summaries.length, 1_920);
    const byId = Map.groupBy(turns, (entry) => entry.id);
    assert.equal(byId.size, 40);
    for (const writes of byId.values()) {
      assert.deepEqual(
        writes.map((entry) => entry.status),
        ['running', 'success'],
      );
      assert.ok(writes[1].totalCostUsd > 0);
    }
    assert.equal(seeded.scopes, 5);
    assert.equal(new Set(turns.map((entry) => entry.worktreeId)).size, 5);
    assert.ok(new Set(summaries.map((entry) => entry.id)).size <= 200);
  });
});

test('every line is one the cost index admits', () => {
  withDataDir((userDataDir) => {
    const seeded = seed(userDataDir, { days: 1, linesPerDay: 400 });
    const entries = readEntries(seeded.files[0]);
    const records = entries.map((entry) => classifyAuditEntry(entry));

    assert.equal(
      records.filter((record) => record === null).length,
      0,
      'the classifier dropped a fixture line',
    );
    const sources = new Set(records.map((record) => record.source));
    // Summaries are background helper work; turns are chat cost.
    assert.deepEqual([...sources].sort(), ['background', 'chat']);
  });
});

test('refuses more days than the default audit retention keeps', () => {
  withDataDir((userDataDir) => {
    assert.throws(() => seed(userDataDir, { days: 8 }), /1 to 7/);
    assert.throws(
      () => seed(userDataDir, { linesPerDay: 10, turnsPerDay: 6 }),
      /two lines/,
    );
  });
});
