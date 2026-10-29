import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  FIELD_LOAD_PROFILES,
  fieldLoadReplayPlan,
} from './chat-storage-field-load.mjs';

const capture = JSON.parse(
  readFileSync(
    new URL(
      './field-loads/2026-10-06-orchestrator-storm.json',
      import.meta.url,
    ),
    'utf8',
  ),
);

function chat(overrides = {}) {
  return {
    provider: 'claude',
    committedBytes: 10_000_000,
    tabIndexBytes: 640_000,
    transcript: {
      rows: 5_000,
      bytes: 10_000_000,
      delegationCards: {
        bytes: { p50: 8_000 },
        liveByteFractions: [],
        lastByteFractions: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6],
      },
    },
    ...overrides,
  };
}

function synthetic(chats, commitsPerMinute = 40) {
  return {
    label: 'synthetic',
    diagnostics: {
      codexStdoutHolds: {
        'stdout-byte-cap': {
          peakQueuedFrames: 4_000,
          peakQueuedBytes: 8_000_000,
        },
      },
    },
    scopes: chats.map((entry, index) => ({
      label: `scope-${String(index + 1).padStart(2, '0')}`,
      commitsPerMinute,
      chats: [entry, { provider: 'claude', committedBytes: 1 }],
    })),
  };
}

test('the plan replays only working-set chats, largest first', () => {
  const plan = fieldLoadReplayPlan(
    synthetic([
      chat({ committedBytes: 2_000_000 }),
      chat({ provider: 'codex', committedBytes: 30_000_000 }),
    ]),
    { byteScale: 1, durationMs: 1_000, maxOwners: 8 },
  );
  assert.deepEqual(
    plan.owners.map((owner) => [owner.scope, owner.provider]),
    [
      ['scope-02', 'codex'],
      ['scope-01', 'claude'],
    ],
  );
  assert.deepEqual(plan.pooledOwners, ['scope-02/1']);
  // 8 MB queued across 4,000 frames at the captured byte-cap peak.
  assert.equal(plan.frameBytes, 2_000);
  assert.equal(plan.owners[0].meanRowBytes, 2_000);
  assert.equal(plan.owners[0].tabIndexBytes, 640_000);
});

test('small active chats join the pool with frames in their captured share', () => {
  const small = {
    provider: 'codex',
    activeTurn: true,
    committedBytes: 500_000,
    committedMessages: 250,
    tabIndexBytes: 4_000,
  };
  const capture = synthetic([chat({ provider: 'codex' }), small]);
  capture.scopes[0].commitsPerMinute = 90;
  capture.scopes[1].commitsPerMinute = 9;
  const plan = fieldLoadReplayPlan(capture, {
    byteScale: 1,
    durationMs: 1_000,
    maxOwners: 8,
  });
  const [busy, quiet] = plan.owners;
  assert.deepEqual(plan.pooledOwners, ['scope-01/1', 'scope-02/1']);
  // No transcript shape: rows come from the tab index, and no card is patched.
  assert.equal(quiet.meanRowBytes, 2_000);
  assert.deepEqual(quiet.cardByteFractions, []);
  assert.equal(quiet.patchShare, 0);
  assert.equal(quiet.frameWeight, 1);
  assert.equal(busy.frameWeight, 10);
});

test('chats of one captured scope stay together in one scope', () => {
  const capture = synthetic([chat({ committedBytes: 9 })]);
  capture.scopes[0].chats.push(
    chat({ provider: 'codex', committedBytes: 5 }),
    chat({ committedBytes: 7 }),
  );
  const plan = fieldLoadReplayPlan(capture, {
    byteScale: 1,
    durationMs: 1_000,
    maxOwners: 8,
  });
  assert.deepEqual(
    plan.owners.map((owner) => [owner.scope, owner.chat, owner.provider]),
    [
      ['scope-01', 1, 'claude'],
      ['scope-01', 2, 'claude'],
      ['scope-01', 3, 'codex'],
    ],
  );
  assert.deepEqual(plan.pooledOwners, ['scope-01/3']);
});

test('running cards are patched at the captured rewrite share', () => {
  const live = [0.9, 0.95];
  const [running, settled, none] = fieldLoadReplayPlan(
    synthetic([
      chat({
        committedBytes: 3,
        committedRewrites: { perMinute: { p50: 10 } },
        transcript: {
          ...chat().transcript,
          delegationCards: {
            ...chat().transcript.delegationCards,
            liveByteFractions: live,
          },
        },
      }),
      // Cards settled before the capture: the latest ones stand in.
      chat({
        committedBytes: 2,
        committedRewrites: { perMinute: { p50: 60 } },
      }),
      chat({ committedBytes: 1 }),
    ]),
    { byteScale: 1, durationMs: 1_000, maxOwners: 8 },
  ).owners;
  assert.deepEqual(running.cardByteFractions, live);
  assert.equal(running.patchShare, 0.25);
  assert.deepEqual(settled.cardByteFractions, [0.3, 0.4, 0.5, 0.6]);
  // More rewrites than sampled commits: every event patches a card.
  assert.equal(settled.patchShare, 1);
  assert.deepEqual(none.cardByteFractions, []);
  assert.equal(none.patchShare, 0);
});

test('the smoke profile scales bytes and bounds the owner count', () => {
  const smoke = fieldLoadReplayPlan(capture, FIELD_LOAD_PROFILES.smoke);
  const field = fieldLoadReplayPlan(capture, FIELD_LOAD_PROFILES.field);
  assert.equal(smoke.owners.length, FIELD_LOAD_PROFILES.smoke.maxOwners);
  assert.ok(field.owners.length > smoke.owners.length);
  for (const [index, owner] of smoke.owners.entries()) {
    const full = field.owners[index];
    assert.equal(owner.scope, full.scope);
    assert.equal(owner.chat, full.chat);
    assert.ok(owner.committedBytes < full.committedBytes);
    assert.ok(owner.committedBytes >= 64 * 1024);
    // Row and card sizes are not scaled: they set the per-event cost.
    assert.equal(owner.meanRowBytes, full.meanRowBytes);
    assert.equal(owner.cardBytes, full.cardBytes);
  }
});

test('the 2026-10-06 capture keeps the load it was taken for', () => {
  const plan = fieldLoadReplayPlan(capture, FIELD_LOAD_PROFILES.field);
  assert.equal(capture.schemaVersion, 1);
  assert.ok(capture.totals.activeTurns >= 10);
  assert.ok(plan.pooledOwners.length >= 2, 'several Codex chats share a pool');
  assert.ok(
    plan.owners.some((owner) => owner.provider === 'claude'),
    'Claude chats run beside them',
  );
  assert.ok(
    plan.owners.some((owner) => owner.committedBytes > 64 * 1024 * 1024),
    'a transcript above 64 MiB',
  );
  assert.ok(
    plan.owners.some(
      (owner) => owner.patchShare === 1 && owner.cardByteFractions.length >= 10,
    ),
    'a chat whose every commit patches one of many running cards',
  );
  for (const owner of plan.owners) {
    assert.ok(owner.patchShare >= 0 && owner.patchShare <= 1);
    for (const fraction of owner.cardByteFractions)
      assert.ok(fraction >= 0 && fraction < 1);
  }
});

test('the persisted-projection card policy patches no card during a replay', () => {
  const legacy = fieldLoadReplayPlan(capture, FIELD_LOAD_PROFILES.field);
  const logged = fieldLoadReplayPlan(capture, {
    ...FIELD_LOAD_PROFILES.field,
    cardPolicy: 'persisted-projection',
  });
  assert.equal(legacy.cardPolicy, 'legacy');
  assert.equal(logged.cardPolicy, 'persisted-projection');
  assert.ok(legacy.owners.some((owner) => owner.patchShare > 0));
  assert.ok(logged.owners.every((owner) => owner.patchShare === 0));
});
