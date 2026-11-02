import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  evaluateD11Replay,
  runD11FeasibilityScenario,
} from './d11-card-replay.mjs';
import {
  FIELD_LOAD_PROFILES,
  fieldLoadReplayPlan,
  runFieldLoadReplay,
} from './chat-storage-field-load.mjs';

// Independent literals: never derive the expected contract from the evaluator.
function completedEvidence() {
  return {
    policy: 'd11-cards',
    insideMeasuredReplay: true,
    counts: {
      'parent-stop': 1,
      continuation: 2,
      draft: 1,
      fail: 1,
      start: 2,
      settle: 3,
      apply: 1,
      discard: 1,
      stop: 1,
      'foreground-resume': 1,
    },
    delegatedCardRewrites: 0,
    statusForcedCheckpoints: 0,
    rawCardsUnchanged: true,
    rawReferencesUnchanged: true,
    continuationTailOnly: true,
    independentMergedReaderPassed: true,
    missingOutcomes: [],
    admissionWindowMs: 120_000,
    lifecycleCompletedDuringForeground: true,
  };
}

test('the evaluator accepts the complete correctness contract', () => {
  assert.equal(evaluateD11Replay(completedEvidence()).passed, true);
});

for (const [label, change] of [
  ['legacy-style delegated-card patch', { delegatedCardRewrites: 1 }],
  ['status-forced checkpoint', { statusForcedCheckpoints: 1 }],
  ['changed creation bytes', { rawCardsUnchanged: false }],
  ['changed reference bytes', { rawReferencesUnchanged: false }],
  ['non-tail or duplicate continuation', { continuationTailOnly: false }],
  [
    'failed independent merged reader',
    { independentMergedReaderPassed: false },
  ],
  ['missing durable outcome', { missingOutcomes: ['result:1'] }],
  ['post-replay auxiliary scenario', { insideMeasuredReplay: false }],
  ['stream-descriptor report', { policy: 'stream-descriptor' }],
]) {
  test(`the same evaluator rejects ${label}`, () => {
    assert.equal(
      evaluateD11Replay({ ...completedEvidence(), ...change }).passed,
      false,
    );
  });
}

test('a field-length window must hold every lifecycle outcome', () => {
  const late = { lifecycleCompletedDuringForeground: false };
  assert.equal(
    evaluateD11Replay({
      ...completedEvidence(),
      ...late,
      admissionWindowMs: 120_000,
    }).passed,
    false,
  );
  assert.equal(
    evaluateD11Replay({
      ...completedEvidence(),
      ...late,
      admissionWindowMs: 6_000,
    }).passed,
    true,
  );
});

test('a missing lifecycle category cannot pass', () => {
  const evidence = completedEvidence();
  evidence.counts.draft = 0;
  assert.equal(evaluateD11Replay(evidence).passed, false);
});

test('the captured smoke completes every durable lifecycle inside its foreground replay', async () => {
  const root = await mkdtemp(join(tmpdir(), 'd11-measured-'));
  try {
    const capture = JSON.parse(
      readFileSync(
        new URL(
          './field-loads/2026-10-06-orchestrator-storm.json',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    const plan = fieldLoadReplayPlan(capture, {
      ...FIELD_LOAD_PROFILES.smoke,
      cardPolicy: 'd11-cards',
    });
    const result = await runFieldLoadReplay(plan, {
      root,
      storageFormat: 'v4',
    });
    await writeFile(
      join(tmpdir(), 'd11-runtime-evidence.json'),
      `${JSON.stringify(result, null, 2)}\n`,
    );
    assert.ok(
      result.d11Cards,
      'the measured replay must return actual D11 evidence',
    );
    assert.equal(result.d11Cards.syntheticCardSeeds, 0);
    assert.equal(
      result.d11Cards.genuineSeedCards,
      plan.owners.reduce(
        (sum, owner) => sum + owner.cardByteFractions.length,
        0,
      ),
    );
    assert.equal(
      result.d11Cards.correctness.passed,
      true,
      JSON.stringify(result.d11Cards.correctness),
    );
    assert.deepEqual(result.d11Cards.counts, {
      'parent-stop': 1,
      continuation: 2,
      draft: 1,
      fail: 1,
      start: 2,
      settle: 3,
      apply: 1,
      discard: 1,
      stop: 1,
      'foreground-resume': 1,
    });
    assert.ok(
      result.d11Cards.outcomes.every(
        (entry) =>
          entry.foregroundCommits > 0 &&
          entry.completedMs <= result.d11Cards.measurementMs,
      ),
    );
    assert.ok(result.owners.every((owner) => owner.commitsPerMinute > 0));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('G7: actual D11 composition durably creates and settles a card without Jest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'd11-feasibility-'));
  try {
    let result;
    let failure;
    try {
      result = await runD11FeasibilityScenario(root);
    } catch (error) {
      failure = error;
    }
    assert.equal(
      failure,
      undefined,
      `Actual D11 composition must load and run under tsx without Jest: ${failure?.stack ?? ''}`,
    );
    assert.deepEqual(result.errors, []);
    assert.ok(result.card, 'ordinary provider ingestion must persist the card');
    assert.equal(result.records.length, 1);
    assert.equal(result.records[0].version, 3);
    assert.equal(result.notification.id, result.target.delegationId);
    assert.equal(result.notification.result.runGeneration, 1);
    assert.equal(result.notification.result.status, 'completed');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
