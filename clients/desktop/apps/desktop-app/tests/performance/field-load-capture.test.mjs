import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  captureFieldLoad,
  processCensus,
  rewriteChatKey,
  summarizeDiagnostics,
  transcriptShape,
} from './field-load-capture.mjs';

const SECRET = 'private prompt text';
const CAPTURED_AT = Date.parse('2026-10-06T20:00:00.000Z');

function row(message) {
  return Buffer.from(JSON.stringify(message), 'utf8');
}

function card(id, status) {
  return {
    id,
    role: 'assistant',
    timestamp: 1,
    blocks: [{ type: 'delegated_agent_call', status, prompt: SECRET }],
  };
}

function text(id) {
  return {
    id,
    role: 'assistant',
    timestamp: 1,
    blocks: [{ type: 'text', text: SECRET.repeat(8) }],
  };
}

function seedScope(dataDir, scopeId, { revision, tabs, runtimeByChatId }) {
  const directory = path.join(
    dataDir,
    'workspaces',
    'secret-workspace',
    'chat-storage-v2',
    scopeId,
  );
  mkdirSync(path.join(directory, 'transcripts'), { recursive: true });
  const write = (nextRevision) =>
    writeFileSync(
      path.join(directory, 'live-index.json'),
      JSON.stringify({
        version: 2,
        revision: nextRevision,
        tabs,
        runtimeByChatId,
        pendingQuestions: [
          { requestId: 'answered', answeredAt: 5 },
          { requestId: 'open' },
        ],
      }),
    );
  write(revision);
  writeFileSync(path.join(directory, 'recovery-index.json'), '{"receipts":[]}');
  return { directory, write };
}

test('transcript shape reports row sizes and where running cards sit', async () => {
  const rows = [
    row(text('a')),
    row(card('done', 'completed')),
    row(text('b')),
    row(card('live', 'running')),
    row(text('c')),
  ];
  const shape = await transcriptShape(rows);
  const total = rows.reduce((bytes, entry) => bytes + entry.length + 1, 0);
  const liveOffset = rows
    .slice(0, 3)
    .reduce((bytes, entry) => bytes + entry.length + 1, 0);
  assert.equal(shape.rows, 5);
  assert.equal(shape.bytes, total);
  assert.deepEqual(shape.blockTypes, { text: 3, delegated_agent_call: 2 });
  assert.deepEqual(shape.delegationCards.byStatus, {
    completed: 1,
    running: 1,
  });
  assert.deepEqual(shape.delegationCards.liveByteFractions, [
    Number((liveOffset / total).toFixed(4)),
  ]);
  assert.equal(shape.delegationCards.lastByteFractions.length, 2);
  assert.ok(!JSON.stringify(shape).includes(SECRET));
});

test('diagnostics count suppressed rewrites and summarize stdout holds', () => {
  const at = new Date(CAPTURED_AT - 1_000).toISOString();
  const { summary, rewritesByKey } = summarizeDiagnostics(
    [
      {
        timestamp: new Date(CAPTURED_AT - 10 * 60_000).toISOString(),
        kind: 'codex_app_server_stdout_hold',
        holdKind: 'stdout-byte-cap',
        holdDurationMs: 999_999,
      },
      {
        timestamp: at,
        kind: 'chat_transcript_full_rewrite',
        reason: 'patch',
        chatTranscriptRewriteChatKey: 'key',
        chatTranscriptRewriteCommittedBytes: 1_000,
        chatTranscriptRewriteSuppressedCount: 4,
        chatTranscriptRewritePatchedBlockTypes: ['delegated_agent_call'],
      },
      {
        timestamp: at,
        kind: 'codex_app_server_stdout_hold',
        holdKind: 'stdout-byte-cap',
        holdOutcome: 'released',
        holdDurationMs: 300_000,
        queuedFrameCount: 4_000,
        queuedFrameBytes: 8_400_000,
      },
      {
        timestamp: at,
        kind: 'chat_storage_activity_summary',
        chatStorageWindowMs: 60_000,
        chatStorageCommitCount: 200,
        chatStorageBytesWritten: 900_000_000,
      },
    ],
    CAPTURED_AT - 60_000,
  );
  assert.deepEqual(summary.committedRewrites, {
    count: 5,
    bytes: 5_000,
    chats: 1,
  });
  assert.deepEqual(rewritesByKey.get('key').patchedBlockTypes, {
    delegated_agent_call: 5,
  });
  // The hold before the window is not counted.
  assert.equal(summary.codexStdoutHolds['stdout-byte-cap'].count, 1);
  assert.equal(
    summary.codexStdoutHolds['stdout-byte-cap'].durationMsTotal,
    300_000,
  );
  assert.equal(summary.chatStorage.commits.p50, 200);
  assert.equal(summary.chatStorage.bytesWritten.max, 900_000_000);
});

test('diagnostics join renderer frame and remote push summaries', () => {
  const at = new Date(CAPTURED_AT - 1_000).toISOString();
  const renderer = (overrides) => ({
    windowMs: 30_000,
    remoteWindow: false,
    frames: {
      count: 2,
      p95Ms: 120,
      maxMs: 180,
      blockingMs: 90,
      invokers: { userCallback: 1, eventListener: 1, promise: 0, script: 0 },
    },
    chatState: {
      onScreenChanges: 10,
      offScreenChanges: 30,
      scopeChanges: 1,
      onScreenMessages: 4,
      offScreenMessages: 8,
      mixedMessages: 2,
      onScreenApplyMs: 5,
      offScreenApplyMs: 15,
      mixedApplyMs: 5,
    },
    chatEvent: {
      onScreenEvents: 20,
      offScreenEvents: 60,
      delegationEvents: 7,
      onScreenApplyMs: 5,
      offScreenApplyMs: 20,
      delegationApplyMs: 3,
    },
    terminal: { deliveries: 5, applyMs: 1 },
    ...overrides,
  });
  const push = {
    windowMs: 30_000,
    interestDeclared: true,
    chatState: {
      pushes: 10,
      bytes: 1_000,
      onScreenPushes: 2,
      offScreenPushes: 7,
      mixedPushes: 1,
      onScreenBytes: 200,
      offScreenBytes: 700,
      mixedBytes: 100,
    },
    chatEvent: {
      pushes: 20,
      bytes: 2_000,
      onScreenPushes: 5,
      offScreenPushes: 15,
      onScreenBytes: 500,
      offScreenBytes: 1_500,
    },
    terminal: { pushes: 3, bytes: 300 },
    other: { pushes: 1, bytes: 50 },
    duplicateDrops: 2,
  };
  const { summary } = summarizeDiagnostics(
    [
      {
        timestamp: at,
        kind: 'renderer_frame_summary',
        rendererSummary: renderer({}),
      },
      {
        timestamp: at,
        kind: 'renderer_frame_summary',
        rendererSummary: renderer({
          remoteWindow: true,
          frames: { ...renderer({}).frames, p95Ms: 300, maxMs: 400 },
        }),
      },
      { timestamp: at, kind: 'remote_push_summary', remotePushSummary: push },
      {
        timestamp: at,
        kind: 'remote_push_summary',
        remotePushSummary: { ...push, interestDeclared: false },
      },
    ],
    CAPTURED_AT - 60_000,
  );
  assert.deepEqual(summary.rendererFrames, {
    count: 2,
    remoteWindowCount: 1,
    longFrames: 4,
    worstFrameP95Ms: 300,
    worstFrameMaxMs: 400,
    terminalDeliveries: 10,
    delegationEvents: 14,
    // Changes: 60 off screen of 80 attributed.
    offScreenChangeShare: 0.75,
    // Apply ms: 70 off screen of 100 (on 20, mixed 10); delegation apart.
    offScreenApplyShare: 0.7,
  });
  assert.deepEqual(summary.remotePushes, {
    count: 2,
    pushes: 68,
    bytes: 6_700,
    duplicateDrops: 4,
    // Only sessions that declared an interest split chat bytes: 2,200 off
    // screen of 3,000 attributed (the mixed 100 counts as attributed).
    offScreenChatByteShare: 2_200 / 3_000,
  });
});

test('process census classifies only the descendants of the app', () => {
  const census = processCensus(
    [
      { pid: 1, parentPid: 0, cpuPercent: 80, rssKb: 1024, command: 'App' },
      {
        pid: 2,
        parentPid: 1,
        cpuPercent: 90,
        rssKb: 2048,
        command: '/x/Helper --type=renderer --secret',
      },
      {
        pid: 3,
        parentPid: 1,
        cpuPercent: 5,
        rssKb: 10,
        command: '/x/bin/codex app-server -c a=b',
      },
      {
        pid: 4,
        parentPid: 3,
        cpuPercent: 1,
        rssKb: 10,
        command: '/usr/bin/git status',
      },
      { pid: 9, parentPid: 0, cpuPercent: 99, rssKb: 99, command: 'unrelated' },
    ],
    1,
  );
  assert.equal(census.processes, 4);
  assert.deepEqual(Object.keys(census.classes).sort(), [
    'app-main',
    'codex-app-server',
    'electron-renderer',
    'git',
  ]);
  assert.equal(census.classes['electron-renderer'].rssBytes, 2048 * 1024);
  assert.equal(processCensus([], 1), undefined);
});

test('a capture is content-free and orders scopes by commit rate', async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'field-load-capture-'));
  try {
    const busyChat = 'chat-secret-busy';
    const busy = seedScope(dataDir, 'secret-busy-scope', {
      revision: 100,
      tabs: [
        {
          id: busyChat,
          title: SECRET,
          providerType: 'codex',
          executionHarness: 'codex',
          model: 'secret-model',
          inputDelivery: { padding: 'x'.repeat(20_000) },
          transcript: {
            committedMessageCount: 3,
            committedByteLength: 4_096,
            transcriptRevision: 9,
            userMessageCount: 1,
          },
        },
        { id: 'chat-hook-1', transcript: {} },
      ],
      runtimeByChatId: {
        [busyChat]: {
          status: 'streaming',
          activeTurn: { userMessageId: 'u' },
          queuedMessageIds: [],
        },
      },
    });
    writeFileSync(
      path.join(busy.directory, 'transcripts', `${busyChat}.jsonl`),
      `${[text('a'), card('live', 'running'), text('b')]
        .map((message) => JSON.stringify(message))
        .join('\n')}\n`,
    );
    seedScope(dataDir, 'secret-idle-scope', {
      revision: 7,
      tabs: [{ id: 'chat-idle', providerType: 'claude', transcript: {} }],
      runtimeByChatId: {},
    });
    seedScope(dataDir, 'secret-empty-scope', {
      revision: 0,
      tabs: [],
      runtimeByChatId: {},
    });
    const runs = path.join(
      dataDir,
      'workspaces',
      'secret-workspace',
      'worktree-data',
      'secret-busy-scope',
      'delegation',
      'runs',
    );
    mkdirSync(runs, { recursive: true });
    writeFileSync(
      path.join(runs, 'run.json'),
      JSON.stringify({ state: { status: 'running' }, task: SECRET }),
    );
    const diagnostics = path.join(
      dataDir,
      'agent-observability',
      'diagnostics',
      'app-events',
    );
    mkdirSync(diagnostics, { recursive: true });
    writeFileSync(
      path.join(diagnostics, '2026-10-06.jsonl'),
      `${JSON.stringify({
        timestamp: new Date(CAPTURED_AT - 5_000).toISOString(),
        kind: 'chat_transcript_full_rewrite',
        reason: 'patch',
        chatTranscriptRewriteChatKey: rewriteChatKey(busyChat),
        chatTranscriptRewriteCommittedBytes: 4_096,
        chatTranscriptRewriteSuppressedCount: 2,
        chatTranscriptRewritePatchedBlockTypes: ['delegated_agent_call'],
      })}\n{"torn`,
    );

    let clock = CAPTURED_AT;
    const capture = await captureFieldLoad({
      dataDir,
      label: 'unit',
      windowMs: 30_000,
      minTranscriptBytes: 1,
      now: () => clock,
      // 50 commits land on the busy scope during the 30-second window.
      wait: (ms) => {
        clock += ms;
        busy.write(150);
        return Promise.resolve();
      },
    });

    assert.equal(capture.schemaVersion, 1);
    assert.equal(capture.windowMs, 30_000);
    assert.deepEqual(capture.totals, {
      scopes: 2,
      emptyScopes: 1,
      chats: 3,
      activeTurns: 1,
      committedBytes: 4_096,
      commitsPerMinute: 100,
      runningDelegationCards: 1,
    });
    assert.deepEqual(
      capture.scopes.map((scope) => [scope.label, scope.commitsPerMinute]),
      [
        ['scope-01', 100],
        ['scope-02', 0],
      ],
    );
    const [scope] = capture.scopes;
    assert.equal(scope.pendingQuestions, 2);
    assert.equal(scope.answeredPendingQuestions, 1);
    assert.deepEqual(scope.delegationRuns.byStatus, { running: 1 });
    const [chat, hook] = scope.chats;
    assert.equal(chat.provider, 'codex');
    assert.equal(chat.runtimeStatus, 'streaming');
    assert.equal(chat.activeTurn, true);
    assert.deepEqual(Object.keys(chat.largeTabFields), ['inputDelivery']);
    assert.equal(chat.committedRewrites.count, 3);
    assert.equal(chat.transcript.delegationCards.liveByteFractions.length, 1);
    assert.equal(hook.hook, true);
    assert.equal(hook.transcript, undefined);

    const serialized = JSON.stringify(capture);
    for (const forbidden of [
      SECRET,
      'secret',
      busyChat,
      dataDir,
      rewriteChatKey(busyChat),
    ])
      assert.ok(!serialized.includes(forbidden), `leaked ${forbidden}`);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
