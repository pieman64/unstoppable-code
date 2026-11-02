/* eslint-disable @typescript-eslint/explicit-function-return-type, @typescript-eslint/require-await -- compact filesystem-backed host fixture */
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentAuditEntry } from '@canopy/desktop-shared/types';
import type { CostScopeRef } from '@canopy/protocol/cost-view';
import { normalizeAuditEntry } from '../../observability/audit-entry-parser';
import { BillingEvidencePass } from '../billing-evidence';
import {
  notifyAuditEntryEnqueued,
  onAuditEntryEnqueued,
} from '../../observability/audit-stream-hooks';
import type { CostIndexHost, CostScopeLocation } from '../types';
import { appendJsonlLines } from '../../observability/jsonl-append';
import { createCostIndexScheduler } from '../scheduler';
import { CostIndexStore } from '../store';
import {
  readChatFile,
  readCheckpointFile,
  readScopeFiles,
  readSummaryFile,
  writeCheckpointFile,
} from '../persistence';

interface StoreRig {
  readonly root: string;
  readonly audit: string;
  readonly checkpoint: string;
  readonly store: CostIndexStore;
  readonly host: CostIndexHost;
  readonly live: Map<string, CostScopeLocation>;
  readonly retained: Map<string, CostScopeLocation>;
  readonly flushCount: () => number;
  readonly slices: number[];
  readonly yields: () => number;
  readonly setNow: (value: string) => void;
  addScope(
    scope: CostScopeRef,
    options?: { retained?: boolean; createdAt?: string },
  ): CostScopeLocation;
  append(entry: Record<string, unknown>, filename?: string): Promise<void>;
}

const projectId = 'project-1';
const worktreeId = 'entry-1';
const chatId = 'chat-1';
const defaultScope: CostScopeRef = { kind: 'entry', projectId, worktreeId };
const initialTime = '2026-10-09T12:00:00.000Z';

function key(scope: CostScopeRef): string {
  return scope.kind === 'entry'
    ? `entry:${scope.projectId}:${scope.worktreeId}`
    : `retained:${scope.projectId}:${scope.containerId}`;
}

async function createRig(): Promise<StoreRig> {
  const root = await mkdtemp(join(tmpdir(), 'cost-index-store-'));
  const audit = join(root, 'audit');
  const checkpoint = join(root, 'index', 'checkpoint.json');
  await mkdir(audit, { recursive: true });
  const live = new Map<string, CostScopeLocation>();
  const retained = new Map<string, CostScopeLocation>();
  const slices: number[] = [];
  let flushCount = 0;
  let yieldCount = 0;
  let nowValue = Date.parse(initialTime);
  let nextLocation = 0;
  const host: CostIndexHost = {
    auditDirectory: () => audit,
    checkpointPath: () => checkpoint,
    resolveScope: async (scope) =>
      live.get(key(scope)) ?? retained.get(key(scope)) ?? null,
    listRetainedScopes: async () => Array.from(retained.values()),
    withRetainedLock: async (_scope, action) => action(),
    readChats: async () => [
      { chatId, label: 'Current chat title', state: 'open' },
    ],
    readPipelineRun: async () => null,
    retentionDays: () => 21,
    flush: async () => {
      flushCount += 1;
    },
    now: () => new Date(nowValue),
    yield: async () => {
      yieldCount += 1;
    },
    onSlice: (_duration, bytes) => slices.push(bytes),
  };
  const store = new CostIndexStore(host);
  return {
    root,
    audit,
    checkpoint,
    store,
    host,
    live,
    retained,
    flushCount: () => flushCount,
    slices,
    yields: () => yieldCount,
    setNow: (value) => {
      nowValue = Date.parse(value);
    },
    addScope: (scope, options = {}) => {
      const location: CostScopeLocation = {
        scope,
        directory: join(root, 'scopes', String(++nextLocation)),
        incarnation: options.createdAt ?? '2026-10-01T00:00:00.000Z',
        createdAt: options.createdAt ?? '2026-10-01T00:00:00.000Z',
      };
      (options.retained ? retained : live).set(key(scope), location);
      return location;
    },
    append: async (entry, filename) => {
      const day = filename ?? `${String(entry.startedAt).slice(0, 10)}.jsonl`;
      await writeFile(join(audit, day), `${JSON.stringify(entry)}\n`, {
        encoding: 'utf8',
        flag: 'a',
      });
    },
  };
}

function auditEntry(
  id: string,
  scope: CostScopeRef = defaultScope,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const scopeIds =
    scope.kind === 'entry'
      ? { projectId: scope.projectId, worktreeId: scope.worktreeId }
      : { projectId: scope.projectId, worktreeId: scope.containerId };
  return {
    id,
    eventType: 'worktree_chat',
    status: 'success',
    provider: 'claude',
    label: 'Chat turn',
    startedAt: '2026-10-08T23:59:00.000Z',
    completedAt: '2026-10-09T00:00:00.000Z',
    durationMs: 60_000,
    model: 'claude-sonnet',
    totalCostUsd: 0.25,
    tokens: { input: 100, output: 20 },
    toolCounts: {},
    projectId: scopeIds.projectId,
    worktreeId: scopeIds.worktreeId,
    chatId,
    ...overrides,
  };
}

function emptyHelperEntry(
  id: string,
  scope: CostScopeRef = defaultScope,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return auditEntry(id, scope, {
    eventType: 'commit_message_generation',
    label: 'Commit message',
    totalCostUsd: undefined,
    tokens: { input: 0, output: 0 },
    ...overrides,
  });
}

async function persistedChat(location: CostScopeLocation, id = chatId) {
  return readChatFile(location.directory, id);
}

function explicitChatEvidence(
  id: string,
  billingBasis: 'subscription' | 'api_key' = 'subscription',
  scope: CostScopeRef = defaultScope,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return auditEntry(id, scope, {
    billingBasis,
    sdkSessionId: 'sdk-session-test',
    providerAccountKey: 'claude:store-test-account',
    providerAccountEmail: 'store-test@example.invalid',
    ...overrides,
  });
}

function explicitUnknownChatEntry(
  id: string,
  scope: CostScopeRef = defaultScope,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return auditEntry(id, scope, {
    billingBasis: 'unknown',
    sdkSessionId: 'sdk-session-test',
    providerAccountKey: 'claude:store-test-account',
    providerAccountEmail: 'store-test@example.invalid',
    ...overrides,
  });
}

describe('CostIndexStore persistence and replay', () => {
  let rig: StoreRig;

  beforeEach(async () => {
    rig = await createRig();
    rig.addScope(defaultScope);
  });

  afterEach(async () => {
    try {
      await rig.store.waitForIdle();
    } finally {
      await rm(rig.root, { recursive: true, force: true });
    }
  });

  it('leaves partial JSONL lines behind the cursor and consumes them after append', async () => {
    const location = rig.live.get(key(defaultScope));
    if (location === undefined) throw new Error('Test scope missing');
    const auditPath = join(rig.audit, '2026-10-08.jsonl');
    const serialized = JSON.stringify(auditEntry('turn-partial'));
    await writeFile(auditPath, serialized.slice(0, 95), 'utf8');

    await rig.store.refreshInternal('turn', defaultScope);
    expect((await persistedChat(location)).value).toBeNull();
    expect((await readCheckpointFile(rig.checkpoint)).value).toBeNull();

    await writeFile(auditPath, `${serialized.slice(95)}\n`, {
      encoding: 'utf8',
      flag: 'a',
    });
    await rig.store.refreshInternal('turn', defaultScope);
    expect(
      Object.keys((await persistedChat(location)).value?.records ?? {}),
    ).toEqual(['turn-partial']);
    expect((await readCheckpointFile(rig.checkpoint)).value).toBeNull();
  });

  it('upserts last-line-wins IDs across midnight without double-counting the turn', async () => {
    const location = rig.live.get(key(defaultScope));
    if (location === undefined) throw new Error('Test scope missing');
    await rig.append(
      auditEntry('turn-midnight', defaultScope, {
        status: 'running',
        completedAt: undefined,
        startedAt: '2026-10-08T23:59:59.000Z',
        tokens: { input: 12, output: 3 },
      }),
      '2026-10-08.jsonl',
    );
    await rig.append(
      auditEntry('turn-midnight', defaultScope, {
        startedAt: '2026-10-08T23:59:59.000Z',
        completedAt: '2026-10-09T00:00:02.000Z',
        durationMs: 3_000,
        tokens: { input: 42, output: 9 },
      }),
      '2026-10-09.jsonl',
    );

    await rig.store.refreshInternal('turn', defaultScope);
    const file = (await persistedChat(location)).value;
    expect(Object.keys(file?.records ?? {})).toHaveLength(1);
    expect(file?.records['turn-midnight']?.tokens).toEqual({
      input: 42,
      output: 9,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      reasoningOutputTokens: 0,
    });
    const summary = (await readSummaryFile(location.directory)).value;
    expect(summary?.chats[0]?.turnCount).toBe(1);
    expect(summary?.updatedAt).toBe('2026-10-09T00:00:02.000Z');
  });

  it('removes an unsealed chat helper when a scoped refresh sees its empty success', async () => {
    const location = rig.live.get(key(defaultScope));
    if (location === undefined) throw new Error('Test scope missing');
    const entryId = 'helper-empty-chat';
    await rig.append(
      auditEntry(entryId, defaultScope, {
        eventType: 'chat_summary',
        label: 'Chat title',
        status: 'running',
        completedAt: undefined,
        durationMs: undefined,
        tokens: { input: 80, output: 12 },
      }),
    );

    await rig.store.refreshInternal('turn', defaultScope);
    expect(
      (await persistedChat(location)).value?.records[entryId],
    ).toBeDefined();

    await rig.append(
      emptyHelperEntry(entryId, defaultScope, {
        eventType: 'chat_summary',
        label: 'Chat title',
        status: 'success',
        chatId: undefined,
      }),
    );
    await rig.store.refreshInternal('turn', defaultScope);

    expect(
      (await persistedChat(location)).value?.records[entryId],
    ).toBeUndefined();
    const scope = await rig.store.getScope({ scope: defaultScope });
    expect(scope.status === 'ok' ? scope.value.totals.usd : null).toBe(0);
    expect(scope.status === 'ok' ? scope.value.totals.tokens : null).toEqual({
      input: 0,
      output: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      reasoningOutputTokens: 0,
    });
  });

  it('removes an unsealed unattached helper when a global refresh sees its empty success', async () => {
    const location = rig.live.get(key(defaultScope));
    if (location === undefined) throw new Error('Test scope missing');
    const entryId = 'helper-empty-unattached';
    await rig.append(
      auditEntry(entryId, defaultScope, {
        eventType: 'commit_message_generation',
        label: 'Commit message',
        chatId: undefined,
        status: 'running',
        completedAt: undefined,
        durationMs: undefined,
        tokens: { input: 80, output: 12 },
      }),
    );

    await rig.store.refreshInternal('startup');
    expect(
      (await readScopeFiles(location.directory)).unattached.value?.records[
        entryId
      ],
    ).toBeDefined();

    await rig.append(
      emptyHelperEntry(entryId, defaultScope, {
        chatId: undefined,
        status: 'success',
      }),
    );
    await rig.store.refreshInternal('idle');

    expect(
      (await readScopeFiles(location.directory)).unattached.value?.records[
        entryId
      ],
    ).toBeUndefined();
    const summary = (await readSummaryFile(location.directory)).value;
    expect(summary?.totals.usd).toBe(0);
    expect(summary?.totals.tokens).toEqual({
      input: 0,
      output: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      reasoningOutputTokens: 0,
    });
    expect(summary?.unattached).toBeUndefined();
  });

  it('keeps an empty failed helper instead of treating it as a deletion', async () => {
    const location = rig.live.get(key(defaultScope));
    if (location === undefined) throw new Error('Test scope missing');
    const entryId = 'helper-empty-failed';
    await rig.append(
      auditEntry(entryId, defaultScope, {
        eventType: 'commit_message_generation',
        label: 'Commit message',
        chatId: undefined,
        status: 'running',
        completedAt: undefined,
        durationMs: undefined,
        tokens: { input: 80, output: 12 },
      }),
    );
    await rig.store.refreshInternal('startup');

    await rig.append(
      emptyHelperEntry(entryId, defaultScope, {
        chatId: undefined,
        status: 'failure',
      }),
    );
    await rig.store.refreshInternal('idle');

    const failed = (await readScopeFiles(location.directory)).unattached.value
      ?.records[entryId];
    expect(failed).toMatchObject({ entryId, status: 'failure' });
    expect(failed?.tokens).toEqual({
      input: 0,
      output: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      reasoningOutputTokens: 0,
    });
  });

  it('does not remove a same-id helper from another scope or incarnation', async () => {
    const originalLocation = rig.live.get(key(defaultScope));
    if (originalLocation === undefined) throw new Error('Test scope missing');
    const entryId = 'helper-scope-boundary';
    await rig.append(
      auditEntry(entryId, defaultScope, {
        eventType: 'commit_message_generation',
        label: 'Commit message',
        chatId: undefined,
        status: 'running',
        completedAt: undefined,
        tokens: { input: 80, output: 12 },
      }),
    );
    await rig.store.refreshInternal('startup');

    const otherScope: CostScopeRef = {
      kind: 'entry',
      projectId: 'project-2',
      worktreeId: 'entry-2',
    };
    rig.addScope(otherScope);
    await rig.append(
      emptyHelperEntry(entryId, otherScope, { chatId: undefined }),
      '2026-10-09.jsonl',
    );
    await rig.store.refreshInternal('idle');
    expect(
      (await readScopeFiles(originalLocation.directory)).unattached.value
        ?.records[entryId],
    ).toBeDefined();

    const newIncarnation = rig.addScope(defaultScope, {
      createdAt: '2026-10-09T01:00:00.000Z',
    });
    await rig.append(
      emptyHelperEntry(entryId, defaultScope, {
        chatId: undefined,
        startedAt: '2026-10-09T02:00:00.000Z',
      }),
      '2026-10-09.jsonl',
    );
    await rig.store.refreshInternal('idle');

    expect(
      (await readScopeFiles(originalLocation.directory)).unattached.value
        ?.records[entryId],
    ).toBeDefined();
    expect(
      (await readScopeFiles(newIncarnation.directory)).unattached.value
        ?.records[entryId],
    ).toBeUndefined();
  });

  it('leaves sealed aggregates and tombstones unchanged when an empty success arrives', async () => {
    const location = rig.live.get(key(defaultScope));
    if (location === undefined) throw new Error('Test scope missing');
    const entryId = 'helper-sealed-empty';
    await rig.append(
      auditEntry(entryId, defaultScope, {
        eventType: 'chat_summary',
        label: 'Chat title',
        status: 'success',
        tokens: { input: 80, output: 12 },
      }),
      '2026-10-08.jsonl',
    );
    await rig.store.refreshInternal('startup');
    expect(
      await rig.store.catchUpAndSealDay('2026-10-08.jsonl'),
    ).not.toBeNull();
    const before = (await readScopeFiles(location.directory)).chats[0];
    expect(before?.sealedEntryIds).toEqual([entryId]);

    await rig.append(
      emptyHelperEntry(entryId, defaultScope, {
        eventType: 'chat_summary',
        label: 'Chat title',
        status: 'success',
      }),
      '2026-10-08.jsonl',
    );
    await rig.store.refreshInternal('idle');
    const after = (await readScopeFiles(location.directory)).chats[0];

    expect(after?.sealedEntryIds).toEqual([entryId]);
    expect(after?.sealed).toEqual(before?.sealed);
    expect(after?.records).toEqual({});
  });

  it('replays a shrink as upserts and retains consumed IDs omitted by the rewrite', async () => {
    const location = rig.live.get(key(defaultScope));
    if (location === undefined) throw new Error('Test scope missing');
    const auditPath = join(rig.audit, '2026-10-08.jsonl');
    const older = auditEntry('turn-keep', defaultScope, {
      startedAt: '2026-10-08T10:00:00.000Z',
      completedAt: '2026-10-08T10:01:00.000Z',
      tokens: { input: 10, output: 1 },
    });
    const revised = auditEntry('turn-revise', defaultScope, {
      startedAt: '2026-10-08T11:00:00.000Z',
      completedAt: '2026-10-08T11:01:00.000Z',
      tokens: { input: 20, output: 2 },
    });
    await writeFile(
      auditPath,
      `${JSON.stringify(older)}\n${JSON.stringify(revised)}\n`,
    );
    await rig.store.refreshInternal('startup');
    const replacement = auditEntry('turn-revise', defaultScope, {
      startedAt: '2026-10-08T11:00:00.000Z',
      completedAt: '2026-10-08T11:02:00.000Z',
      tokens: { input: 55, output: 5 },
    });
    await writeFile(auditPath, `${JSON.stringify(replacement)}\n`);

    await rig.store.refreshInternal('startup');
    const file = (await persistedChat(location)).value;
    expect(Object.keys(file?.records ?? {}).sort()).toEqual([
      'turn-keep',
      'turn-revise',
    ]);
    expect(file?.records['turn-revise']?.tokens.input).toBe(55);
    expect(file?.records['turn-keep']?.tokens.input).toBe(10);
    expect(
      (await readSummaryFile(location.directory)).value?.chats[0]?.turnCount,
    ).toBe(2);
  });

  it('replays a shrink that stays beyond the committed cursor', async () => {
    const location = rig.live.get(key(defaultScope));
    if (location === undefined) throw new Error('Test scope missing');
    const auditPath = join(rig.audit, '2026-10-08.jsonl');
    const previousLine = `${JSON.stringify(auditEntry('turn-before-partial-shrink'))}\n`;
    const partialTail = `{"partial":"${'x'.repeat(800)}`;
    await writeFile(auditPath, `${previousLine}${partialTail}`, 'utf8');
    await rig.store.refreshInternal('startup');
    await rig.store.waitForIdle();
    const previousCheckpoint = (await readCheckpointFile(rig.checkpoint)).value;
    const cursor = previousCheckpoint?.audit['2026-10-08.jsonl'];
    if (cursor === undefined) throw new Error('Expected initial day cursor');
    expect(cursor.offset).toBeLessThan(cursor.size);

    const replacement = auditEntry('turn-after-partial-shrink', defaultScope, {
      label: 'Replacement line with a longer audit label',
    });
    await writeFile(auditPath, `${JSON.stringify(replacement)}\n`, 'utf8');
    const replacementSize = (await stat(auditPath)).size;
    expect(replacementSize).toBeGreaterThan(cursor.offset);
    expect(replacementSize).toBeLessThan(cursor.size);

    await rig.store.refreshInternal('idle');
    const file = (await persistedChat(location)).value;
    expect(file?.records['turn-before-partial-shrink']).toBeDefined();
    expect(file?.records['turn-after-partial-shrink']).toBeDefined();
  });

  it('rebuilds a corrupt chat from unchanged audit asynchronously and returns empty during the read', async () => {
    const location = rig.live.get(key(defaultScope));
    if (location === undefined) throw new Error('Test scope missing');
    await rig.append(auditEntry('turn-repair'));
    await rig.store.refreshInternal('startup');
    const encodedChatId = Buffer.from(chatId, 'utf8').toString('base64url');
    const chatPath = join(location.directory, 'chats', `${encodedChatId}.json`);
    await writeFile(chatPath, '{bad json', 'utf8');

    const read = await rig.store.getChat({
      scope: defaultScope,
      chatId,
      detail: 'full',
    });
    expect(read.status).toBe('ok');
    if (read.status === 'ok' && read.value.kind === 'full') {
      expect(read.value.breakdown.chat.totals.usd).toBe(0);
    }
    const aside = await readdir(join(location.directory, 'chats'));
    expect(aside.some((name) => name.includes('.corrupt-'))).toBe(true);

    // Public reads only enqueue; draining waits for the scheduled replay.
    await rig.store.waitForIdle();
    await rig.store.refreshInternal('idle');
    const repaired = (await persistedChat(location)).value;
    expect(repaired?.records['turn-repair']).toBeDefined();
  });

  it('reads an empty scope as built after a full scan instead of replaying on every read', async () => {
    // The first build reads every audit line, so missing files mean no cost.
    await rig.store.refreshInternal('startup');
    const lastRefresh = async () =>
      (await readCheckpointFile(rig.checkpoint)).value?.lastRefresh;
    const confirmed = await lastRefresh();

    rig.setNow('2026-10-09T12:30:00.000Z');
    for (let read = 0; read < 3; read += 1) {
      const view = await rig.store.getScope({ scope: defaultScope });
      expect(view.status).toBe('ok');
      if (view.status === 'ok') {
        expect(view.value.building).toBe(false);
        expect(view.value.chats).toEqual([]);
      }
      await rig.store.getPipelineRun({
        scope: defaultScope,
        executionId: 'never-ran',
      });
      await rig.store.waitForIdle();
    }

    expect(await lastRefresh()).toEqual(confirmed);
  });

  it('rebuilds files lost after their audit lines were consumed, once per session', async () => {
    const location = rig.live.get(key(defaultScope));
    if (location === undefined) throw new Error('Test scope missing');
    await rig.append(auditEntry('turn-lost'));
    await rig.store.refreshInternal('startup');
    await rm(location.directory, { recursive: true, force: true });

    // A later session's incremental startup cannot see the consumed line.
    const nextSession = new CostIndexStore(rig.host);
    await nextSession.refreshInternal('startup');
    const during = await nextSession.getScope({ scope: defaultScope });
    expect(during.status === 'ok' && during.value.building).toBe(true);

    await nextSession.waitForIdle();
    const after = await nextSession.getScope({ scope: defaultScope });
    expect(after.status).toBe('ok');
    if (after.status === 'ok') {
      expect(after.value.building).toBe(false);
      expect(after.value.chats.map((chat) => chat.chatId)).toEqual([chatId]);
    }
    await nextSession.waitForIdle();
  });

  it('round-trips records from every provider without rejecting the chat file', async () => {
    const location = rig.live.get(key(defaultScope));
    if (location === undefined) throw new Error('Test scope missing');
    // Every provider the audit parser admits; it does not record Copilot turns.
    const providers = ['claude', 'codex', 'ollama', 'cursor', 'opencode'];
    for (const provider of providers) {
      await rig.append(
        auditEntry(`turn-${provider}`, defaultScope, { provider }),
      );
    }
    await rig.store.refreshInternal('startup');

    const read = await persistedChat(location);
    expect(read.corrupt).toBe(false);
    expect(Object.keys(read.value?.records ?? {}).sort()).toEqual(
      providers.map((provider) => `turn-${provider}`).sort(),
    );
  });

  it('indexes turns that carry the audit ids the observability service writes', async () => {
    const turnId = `chat:${projectId}/${worktreeId}/${chatId}:2026-10-08T23:59:00.000Z`;
    const stepId =
      'pipeline:run-1/review/agent-review/0:2026-10-08T23:58:00.000Z';
    await rig.append(auditEntry(turnId));
    await rig.append(
      auditEntry(stepId, defaultScope, {
        eventType: 'pipeline_agent_turn',
        chatId: undefined,
        pipelineExecutionId: 'run-1',
        pipelineName: 'Release review',
        jobId: 'review',
        stepId: 'agent-review',
        totalCostUsd: 0.5,
      }),
    );
    await rig.store.refreshInternal('startup');

    const scope = await rig.store.getScope({ scope: defaultScope });
    expect(scope.status).toBe('ok');
    if (scope.status === 'ok') {
      expect(scope.value.totals.usd).toBeCloseTo(0.75, 6);
      expect(scope.value.chats.map((chat) => chat.chatId)).toEqual([chatId]);
      expect(scope.value.pipelineRuns.map((run) => run.executionId)).toEqual([
        'run-1',
      ]);
    }
    const chat = await rig.store.getChat({ scope: defaultScope, chatId });
    expect(chat.status === 'ok' && chat.value.kind === 'full').toBe(true);
  });

  it('keeps a queued archive or manual flush when it is folded into a global pass', async () => {
    // A scoped archive request arrives while a global pass is already queued.
    const running = rig.store.refreshInternal('startup');
    void rig.store.refreshInternal('idle');
    const archive = rig.store.refreshInternal('archive', defaultScope);
    await Promise.all([running, archive]);
    await rig.store.waitForIdle();
    expect(rig.flushCount()).toBe(1);

    // A global request arrives while a scoped manual request is queued.
    const next = rig.store.refreshInternal('startup');
    void rig.store.refreshInternal('manual', defaultScope);
    void rig.store.refreshInternal('idle');
    await next;
    await rig.store.waitForIdle();
    expect(rig.flushCount()).toBe(2);
  });

  it('reads a sealed entry with no cost as final, not as still building', async () => {
    await rig.store.refreshInternal('startup');
    await rig.store.sealScope(defaultScope);

    const sealed = await rig.store.getScope({ scope: defaultScope });
    expect(sealed.status === 'ok' && sealed.value.building).toBe(false);

    // An archive that rolls back reopens the entry; it is still not building.
    await rig.store.resumeScope(defaultScope);
    const resumed = await rig.store.getScope({ scope: defaultScope });
    expect(resumed.status === 'ok' && resumed.value.building).toBe(false);
  });

  it('keeps the last activity and coverage start when a pipeline-only entry is sealed', async () => {
    const location = rig.live.get(key(defaultScope));
    if (location === undefined) throw new Error('Test scope missing');
    await rig.append(
      auditEntry('pipeline-only', defaultScope, {
        eventType: 'pipeline_agent_turn',
        chatId: undefined,
        pipelineExecutionId: 'run-1',
        rootPipelineExecutionId: 'run-1',
        pipelineName: 'Build',
        jobId: 'job-1',
        stepId: 'step-1',
      }),
    );
    await rig.store.refreshInternal('startup');
    const before = (await readSummaryFile(location.directory)).value;
    if (before === null) throw new Error('Expected persisted summary');
    expect(before.coverageStart).toBeDefined();

    await rig.store.sealScope(defaultScope);

    const sealed = (await readSummaryFile(location.directory)).value;
    expect(sealed?.sealedAt).toBeDefined();
    expect(sealed?.updatedAt).toBe('2026-10-09T00:00:00.000Z');
    expect(sealed?.coverageStart).toBe(before.coverageStart);
    const view = await rig.store.getScope({ scope: defaultScope });
    expect(view.status === 'ok' && view.value.building).toBe(false);
  });

  it('lists a pipeline run with its root status, as the run view reports it', async () => {
    // The agent step succeeded, but a later script step is still running.
    const hostWithRunState: CostIndexHost = {
      ...rig.host,
      readPipelineRun: async (_scope, executionId) =>
        executionId === 'run-1'
          ? { status: 'running', pipelineName: 'Build' }
          : null,
      readPipelineRunStates: async () =>
        new Map([['run-1', { status: 'running', pipelineName: 'Build' }]]),
    };
    const store = new CostIndexStore(hostWithRunState);
    await rig.append(
      auditEntry('agent-step-done', defaultScope, {
        eventType: 'pipeline_agent_turn',
        chatId: undefined,
        pipelineExecutionId: 'run-1',
        rootPipelineExecutionId: 'run-1',
        pipelineName: 'Build',
        jobId: 'job-1',
        stepId: 'step-1',
      }),
    );
    await store.refreshInternal('startup');

    const scope = await store.getScope({ scope: defaultScope });
    const run = await store.getPipelineRun({
      scope: defaultScope,
      executionId: 'run-1',
    });
    const listed =
      scope.status === 'ok' ? scope.value.pipelineRuns[0]?.status : undefined;
    expect(listed).toBe('running');
    expect(run.status === 'ok' ? run.value.run.status : undefined).toBe(listed);
    await store.waitForIdle();
  });

  it('gives cost to a new entry that reuses a retired id in the same session', async () => {
    await rig.append(auditEntry('turn-before-delete'));
    await rig.store.refreshInternal('startup');
    await rig.store.retireScope(defaultScope);
    const retired = await rig.store.getScope({ scope: defaultScope });
    expect(retired).toMatchObject({ status: 'unavailable' });

    // The id is handed to a new worktree: a new location and incarnation.
    rig.addScope(defaultScope, { createdAt: '2026-10-09T13:00:00.000Z' });
    rig.setNow('2026-10-09T14:00:00.000Z');
    await rig.append(
      auditEntry('turn-in-new-entry', defaultScope, {
        startedAt: '2026-10-09T13:30:00.000Z',
        completedAt: '2026-10-09T13:31:00.000Z',
      }),
      '2026-10-09.jsonl',
    );
    await rig.store.refreshInternal('idle');

    const reused = await rig.store.getScope({ scope: defaultScope });
    expect(reused.status).toBe('ok');
    if (reused.status === 'ok') {
      expect(reused.value.totals.usd).toBeCloseTo(0.25, 6);
    }
  });

  it('reopens a live entry whose archive was interrupted before it could resume', async () => {
    const location = rig.live.get(key(defaultScope));
    if (location === undefined) throw new Error('Test scope missing');
    await rig.append(auditEntry('turn-before-archive'));
    await rig.store.refreshInternal('startup');
    // The archive seals the entry, then the app exits before resumeScope runs.
    await rig.store.sealScope(defaultScope);
    expect(
      (await readSummaryFile(location.directory)).value?.sealedAt,
    ).toBeDefined();

    const afterRestart = new CostIndexStore(rig.host);
    rig.setNow('2026-10-10T12:00:00.000Z');
    await rig.append(
      auditEntry('turn-after-restart', defaultScope, {
        startedAt: '2026-10-10T11:00:00.000Z',
        completedAt: '2026-10-10T11:01:00.000Z',
      }),
      '2026-10-10.jsonl',
    );
    await afterRestart.refreshInternal('startup');

    const view = await afterRestart.getScope({ scope: defaultScope });
    expect(view.status).toBe('ok');
    if (view.status === 'ok') {
      expect(view.value.totals.usd).toBeCloseTo(0.5, 6);
    }
    expect(
      (await readSummaryFile(location.directory)).value?.sealedAt,
    ).toBeUndefined();
    await afterRestart.waitForIdle();
  });

  it('reopens a live entry when the reopen after its archive fails', async () => {
    const location = rig.live.get(key(defaultScope));
    if (location === undefined) throw new Error('Test scope missing');
    await rig.append(auditEntry('turn-before-archive'));
    await rig.store.refreshInternal('startup');
    await rig.store.waitForIdle();
    await rig.store.sealScope(defaultScope);
    const persistence = await import('../persistence');
    const summaryWrite = jest
      .spyOn(persistence, 'writeSummaryFile')
      .mockRejectedValueOnce(new Error('simulated reopen failure'));
    await expect(rig.store.resumeScope(defaultScope)).rejects.toThrow(
      'simulated reopen failure',
    );
    summaryWrite.mockRestore();
    expect(
      (await readSummaryFile(location.directory)).value?.sealedAt,
    ).toBeDefined();

    // The archive rolled back, so the entry carries on in the same session.
    rig.setNow('2026-10-10T12:00:00.000Z');
    await rig.append(
      auditEntry('turn-after-archive', defaultScope, {
        startedAt: '2026-10-10T11:00:00.000Z',
        completedAt: '2026-10-10T11:01:00.000Z',
      }),
      '2026-10-10.jsonl',
    );
    await rig.store.refreshInternal('idle');

    const view = await rig.store.getScope({ scope: defaultScope });
    expect(view.status).toBe('ok');
    if (view.status === 'ok') {
      expect(view.value.totals.usd).toBeCloseTo(0.5, 6);
    }
    expect(
      (await readSummaryFile(location.directory)).value?.sealedAt,
    ).toBeUndefined();
    await rig.store.waitForIdle();
  });

  it('reopens an entry after its archive even when a refresh in flight fails', async () => {
    const location = rig.live.get(key(defaultScope));
    if (location === undefined) throw new Error('Test scope missing');
    await rig.append(auditEntry('turn-before-archive'));
    await rig.store.refreshInternal('startup');
    // The startup pass leaves a background fill that writes the checkpoint;
    // let it finish so the injected failure hits the idle refresh below.
    await rig.store.waitForIdle();
    await rig.store.sealScope(defaultScope);
    rig.setNow('2026-10-10T12:00:00.000Z');
    await rig.append(
      auditEntry('turn-after-archive', defaultScope, {
        startedAt: '2026-10-10T11:00:00.000Z',
        completedAt: '2026-10-10T11:01:00.000Z',
      }),
      '2026-10-10.jsonl',
    );
    const persistence = await import('../persistence');
    const checkpointWrite = jest
      .spyOn(persistence, 'writeCheckpointFile')
      .mockRejectedValueOnce(new Error('simulated checkpoint failure'));
    const failing = rig.store.refreshInternal('idle');
    const reopening = rig.store.resumeScope(defaultScope);
    await expect(failing).rejects.toThrow('simulated checkpoint failure');
    await expect(reopening).resolves.toBeUndefined();
    checkpointWrite.mockRestore();
    expect(
      (await readSummaryFile(location.directory)).value?.sealedAt,
    ).toBeUndefined();

    await rig.store.refreshInternal('idle');
    const view = await rig.store.getScope({ scope: defaultScope });
    expect(view.status).toBe('ok');
    if (view.status === 'ok') {
      expect(view.value.totals.usd).toBeCloseTo(0.5, 6);
    }
    await rig.store.waitForIdle();
  });

  it('keeps a restored entry readable and indexed when its restore fails', async () => {
    const location = rig.live.get(key(defaultScope));
    if (location === undefined) throw new Error('Test scope missing');
    await rig.append(auditEntry('turn-before-restore'));
    await rig.store.refreshInternal('startup');
    await rig.store.waitForIdle();
    const persistence = await import('../persistence');
    const summaryWrite = jest
      .spyOn(persistence, 'writeSummaryFile')
      .mockRejectedValueOnce(new Error('simulated restore failure'));
    await expect(
      rig.store.restoreScope(
        location.directory,
        defaultScope,
        location.incarnation,
      ),
    ).rejects.toThrow('simulated restore failure');
    summaryWrite.mockRestore();

    // The entry was restored without its cost rewrite; it is still an entry.
    const afterFailure = await rig.store.getScope({ scope: defaultScope });
    expect(afterFailure.status).toBe('ok');

    rig.setNow('2026-10-10T12:00:00.000Z');
    await rig.append(
      auditEntry('turn-after-restore', defaultScope, {
        startedAt: '2026-10-10T11:00:00.000Z',
        completedAt: '2026-10-10T11:01:00.000Z',
      }),
      '2026-10-10.jsonl',
    );
    await rig.store.refreshInternal('idle');
    const view = await rig.store.getScope({ scope: defaultScope });
    expect(view.status).toBe('ok');
    if (view.status === 'ok') {
      expect(view.value.totals.usd).toBeCloseTo(0.5, 6);
    }
    await rig.store.waitForIdle();
  });

  it('names proxy accounts when a view is read and never stores their labels', async () => {
    const location = rig.live.get(key(defaultScope));
    if (location === undefined) throw new Error('Test scope missing');
    await rig.append(
      auditEntry('proxy-turn', defaultScope, {
        billingBasis: 'account_proxy',
        accountProxy: {
          connectionId: 'conn-1',
          accounts: [
            {
              authIndex: 'a1f3c2d4a1f3c2d4',
              label: 'sam@example.com',
              provider: 'claude',
              requests: 2,
            },
          ],
        },
      }),
    );
    await rig.store.refreshInternal('startup');
    const accountKey = 'proxy:conn-1:a1f3c2d4a1f3c2d4';

    const files = await Promise.all(
      [
        'summary.json',
        `chats/${Buffer.from(chatId).toString('base64url')}.json`,
      ].map((file) => readFile(join(location.directory, file), 'utf8')),
    );
    for (const file of files) {
      expect(file).toContain('a1f3c2d4a1f3c2d4');
      expect(file).not.toContain('sam@example.com');
    }

    const unnamed = await rig.store.getChat({
      scope: defaultScope,
      chatId,
      detail: 'summary',
    });
    expect(unnamed).toMatchObject({
      status: 'ok',
      value: { chat: { proxyAccounts: [{ accountKey, label: '' }] } },
    });

    const store = new CostIndexStore({
      ...rig.host,
      readProxyAccountLabels: async () =>
        new Map([[accountKey, 'sam@example.com']]),
    });
    const named = await store.getChat({
      scope: defaultScope,
      chatId,
      detail: 'summary',
    });
    expect(named).toMatchObject({
      status: 'ok',
      value: {
        chat: {
          proxyAccounts: [
            { accountKey, label: 'sam@example.com', turnShare: 1 },
          ],
        },
      },
    });
    const scope = await store.getScope({ scope: defaultScope });
    expect(scope).toMatchObject({
      status: 'ok',
      value: {
        chats: [{ proxyAccounts: [{ label: 'sam@example.com' }] }],
      },
    });

    // A label read that fails still shows the cost.
    const failing = new CostIndexStore({
      ...rig.host,
      readProxyAccountLabels: async () => {
        throw new Error('Account list unavailable');
      },
    });
    expect(
      await failing.getChat({ scope: defaultScope, chatId, detail: 'summary' }),
    ).toMatchObject({
      status: 'ok',
      value: { chat: { proxyAccounts: [{ accountKey, label: '' }] } },
    });
  });

  it('answers NOT_FOUND for a subagent the chat never started', async () => {
    await rig.append(auditEntry('turn-with-no-subagent'));
    await rig.store.refreshInternal('startup');

    const read = await rig.store.getChat({
      scope: defaultScope,
      chatId,
      subagentId: 'never-started',
    });

    expect(read).toMatchObject({ status: 'error', reason: 'NOT_FOUND' });
  });

  it('answers NOT_FOUND with workflow copy for a run it never recorded', async () => {
    await rig.store.refreshInternal('startup');

    const read = await rig.store.getPipelineRun({
      scope: defaultScope,
      executionId: 'never-ran',
    });
    await rig.store.waitForIdle();

    expect(read).toMatchObject({
      status: 'error',
      reason: 'NOT_FOUND',
      message: 'Workflow run cost was not found',
    });
  });

  it('writes per-scope archive refreshes without advancing the global cursor or touching other scopes', async () => {
    const secondScope: CostScopeRef = {
      kind: 'entry',
      projectId: 'project-2',
      worktreeId: 'entry-2',
    };
    const secondLocation = rig.addScope(secondScope);
    const firstLocation = rig.live.get(key(defaultScope));
    if (firstLocation === undefined) throw new Error('Test scope missing');
    await rig.append(auditEntry('turn-a', defaultScope));
    await rig.append(auditEntry('turn-b', secondScope));

    await rig.store.refreshInternal('archive', defaultScope);
    expect(rig.flushCount()).toBe(1);
    expect(
      (await persistedChat(firstLocation)).value?.records['turn-a'],
    ).toBeDefined();
    expect((await persistedChat(secondLocation)).value).toBeNull();
    expect((await readCheckpointFile(rig.checkpoint)).value).toBeNull();

    await rig.store.refreshInternal('idle');
    expect(
      (await persistedChat(secondLocation)).value?.records['turn-b'],
    ).toBeDefined();
  });

  it('replays the audit once for an entry with no cost, not on every scoped refresh', async () => {
    const location = rig.live.get(key(defaultScope));
    if (location === undefined) throw new Error('Test scope missing');
    const otherScope: CostScopeRef = {
      kind: 'entry',
      projectId: 'other-project',
      worktreeId: 'other-entry',
    };
    rig.addScope(otherScope);
    await rig.append(
      auditEntry('turn-other-a', otherScope),
      '2026-10-01.jsonl',
    );
    await rig.append(
      auditEntry('turn-other-b', otherScope),
      '2026-10-02.jsonl',
    );
    await rig.store.refreshInternal('startup');
    await rig.store.waitForIdle();
    // No line belongs to this entry, so the global pass wrote nothing for it.
    expect((await readSummaryFile(location.directory)).value).toBeNull();
    const bytesRead = (): number =>
      rig.slices.reduce((total, bytes) => total + bytes, 0);

    rig.slices.length = 0;
    await rig.store.refreshInternal('turn', defaultScope);
    expect(bytesRead()).toBeGreaterThan(0);

    rig.slices.length = 0;
    await rig.store.refreshInternal('turn', defaultScope);
    expect(bytesRead()).toBe(0);

    const empty = await rig.store.getScope({ scope: defaultScope });
    expect(empty.status === 'ok' && empty.value.totals.usd).toBe(0);
    expect(empty.status === 'ok' && empty.value.building).toBe(false);

    // Its first turn is still picked up, by an incremental read.
    await rig.append(auditEntry('turn-first'), '2026-10-09.jsonl');
    await rig.store.refreshInternal('turn', defaultScope);
    const view = await rig.store.getScope({ scope: defaultScope });
    expect(view.status === 'ok' && view.value.totals.usd).toBeCloseTo(0.25, 6);
    await rig.store.waitForIdle();
  });

  it('shows a turn that just ended without a manual refresh', async () => {
    // Observability keeps a finished turn in memory until its next flush.
    const queued: Record<string, unknown>[] = [];
    const host: CostIndexHost = {
      ...rig.host,
      flush: async () => {
        for (const entry of queued.splice(0)) await rig.append(entry);
      },
    };
    const store = new CostIndexStore(host);
    const refreshes: Promise<unknown>[] = [];
    const stop = createCostIndexScheduler({
      refreshInternal: (trigger, scope) => {
        const refresh = store.refreshInternal(trigger, scope);
        refreshes.push(refresh);
        return refresh;
      },
      hasAuditGrowth: () => store.hasAuditGrowth(),
      onAuditEntryEnqueued,
      // A view is showing the entry.
      isCostScopeWatched: () => true,
      markScopeStale: (scope) => store.markScopeStale(scope),
    });
    try {
      await Promise.all(refreshes);
      await store.waitForIdle();
      const before = await store.getScope({ scope: defaultScope });
      expect(before.status === 'ok' && before.value.totals.usd).toBe(0);

      const finished = auditEntry('turn-just-ended');
      const entry: AgentAuditEntry | null = normalizeAuditEntry(finished);
      if (entry === null) throw new Error('Test audit entry is invalid');
      queued.push(finished);
      notifyAuditEntryEnqueued(entry);

      await Promise.all(refreshes);
      await store.waitForIdle();
      const after = await store.getScope({ scope: defaultScope });
      expect(after.status === 'ok' && after.value.totals.usd).toBeCloseTo(
        0.25,
        6,
      );
      expect(queued).toEqual([]);
    } finally {
      stop();
    }
  });

  it('flushes pending audit entries before a turn refresh, so a turn that just ended is read', async () => {
    await rig.store.refreshInternal('startup');
    await rig.store.waitForIdle();
    const flushesBefore = rig.flushCount();

    await rig.store.refreshInternal('turn', defaultScope);

    expect(rig.flushCount()).toBe(flushesBefore + 1);
  });

  it('refreshes a stale scope when a view opens it, inside the open window', async () => {
    await rig.append(auditEntry('turn-seen'));
    await rig.store.refreshInternal('startup');
    await rig.store.waitForIdle();

    // A refresh just ran, so an ordinary open is skipped.
    const skipped = await rig.store.refresh({
      scope: defaultScope,
      trigger: 'open',
    });
    expect(skipped.status === 'ok' && skipped.value.ran).toBe(false);

    // Work finished in the entry while no view was showing it.
    await rig.append(auditEntry('turn-while-hidden'));
    rig.store.markScopeStale(defaultScope);
    const flushesBefore = rig.flushCount();
    const opened = await rig.store.refresh({
      scope: defaultScope,
      trigger: 'open',
    });
    expect(opened.status === 'ok' && opened.value.ran).toBe(true);
    expect(rig.flushCount()).toBe(flushesBefore + 1);
    const view = await rig.store.getScope({ scope: defaultScope });
    expect(view.status === 'ok' && view.value.totals.usd).toBeCloseTo(0.5, 6);

    // The scope is current again, so the next open is skipped as before.
    const again = await rig.store.refresh({
      scope: defaultScope,
      trigger: 'open',
    });
    expect(again.status === 'ok' && again.value.ran).toBe(false);
    await rig.store.waitForIdle();
  });

  it('refreshes a scope a view opens before the scheduler starts, inside the open window', async () => {
    // A read soon after launch queues a replay; the scheduler, which marks
    // scopes stale as their work finishes, has not started yet.
    await rig.append(auditEntry('turn-seen'));
    await rig.store.refreshInternal('idle');
    await rig.store.waitForIdle();

    await rig.append(auditEntry('turn-before-scheduler'));
    const flushesBefore = rig.flushCount();
    const opened = await rig.store.refresh({
      scope: defaultScope,
      trigger: 'open',
    });
    expect(opened.status === 'ok' && opened.value.ran).toBe(true);
    expect(rig.flushCount()).toBe(flushesBefore + 1);
    const view = await rig.store.getScope({ scope: defaultScope });
    expect(view.status === 'ok' && view.value.totals.usd).toBeCloseTo(0.5, 6);
    await rig.store.waitForIdle();
  });

  it('reads an entry with an empty summary as empty, not building, after a restart', async () => {
    const location = rig.live.get(key(defaultScope));
    if (location === undefined) throw new Error('Test scope missing');
    const otherScope: CostScopeRef = {
      kind: 'entry',
      projectId: 'other-project',
      worktreeId: 'other-entry',
    };
    rig.addScope(otherScope);
    await rig.append(auditEntry('turn-other', otherScope), '2026-10-01.jsonl');
    await rig.store.refreshInternal('startup');
    await rig.store.waitForIdle();
    // A scoped replay finds nothing for this entry and records that.
    await rig.store.refreshInternal('turn', defaultScope);
    const written = (await readSummaryFile(location.directory)).value;
    expect(written?.updatedAt).toBeNull();

    // The next app session starts from the saved cursors: no full scan runs.
    const afterRestart = new CostIndexStore(rig.host);
    await afterRestart.refreshInternal('startup');
    await afterRestart.waitForIdle();
    const view = await afterRestart.getScope({ scope: defaultScope });
    expect(view.status === 'ok' && view.value.building).toBe(false);
    expect(view.status === 'ok' && view.value.updatedAt).not.toBeNull();
  });

  it('scans only changed audit files on an incremental scoped turn refresh', async () => {
    const targetLocation = rig.live.get(key(defaultScope));
    if (targetLocation === undefined) throw new Error('Test scope missing');
    await rig.append(
      auditEntry('turn-history-a', defaultScope),
      '2026-10-01.jsonl',
    );
    await rig.append(
      auditEntry('turn-history-b', defaultScope),
      '2026-10-02.jsonl',
    );
    await rig.store.refreshInternal('startup');
    await rig.store.waitForIdle();
    rig.slices.length = 0;

    const unrelatedScope: CostScopeRef = {
      kind: 'entry',
      projectId: 'unrelated-project',
      worktreeId: 'unrelated-entry',
    };
    rig.addScope(unrelatedScope);
    const newPath = join(rig.audit, '2026-10-03.jsonl');
    await rig.append(
      auditEntry('turn-new-unrelated', unrelatedScope),
      '2026-10-03.jsonl',
    );
    const appendedBytes = (await stat(newPath)).size;

    await rig.store.refreshInternal('turn', defaultScope);

    expect(rig.slices.reduce((total, bytes) => total + bytes, 0)).toBe(
      appendedBytes,
    );
    expect(
      (await persistedChat(targetLocation)).value?.records['turn-history-a'],
    ).toBeDefined();
    expect(
      (await readCheckpointFile(rig.checkpoint)).value?.audit[
        '2026-10-03.jsonl'
      ],
    ).toBeUndefined();
  });

  it('repairs a checkpoint crash by replaying idempotently with byte-identical files', async () => {
    const location = rig.live.get(key(defaultScope));
    if (location === undefined) throw new Error('Test scope missing');
    await rig.append(auditEntry('turn-crash'));
    const persistence = await import('../persistence');
    const checkpointWrite = jest
      .spyOn(persistence, 'writeCheckpointFile')
      .mockRejectedValueOnce(new Error('simulated checkpoint crash'));
    await expect(rig.store.refreshInternal('startup')).rejects.toThrow(
      'simulated checkpoint crash',
    );
    checkpointWrite.mockRestore();
    const summaryBefore = await readFile(
      join(location.directory, 'summary.json'),
      'utf8',
    );
    const chatsBefore = await readFile(
      join(
        location.directory,
        'chats',
        `${Buffer.from(chatId).toString('base64url')}.json`,
      ),
      'utf8',
    );

    const restarted = new CostIndexStore(rig.host);
    await restarted.refreshInternal('startup');
    await restarted.waitForIdle();
    expect(
      await readFile(join(location.directory, 'summary.json'), 'utf8'),
    ).toBe(summaryBefore);
    expect(
      await readFile(
        join(
          location.directory,
          'chats',
          `${Buffer.from(chatId).toString('base64url')}.json`,
        ),
        'utf8',
      ),
    ).toBe(chatsBefore);
    expect(
      Object.keys((await persistedChat(location)).value?.records ?? {}),
    ).toEqual(['turn-crash']);
  });

  it('rebuilds a stale summary when a prior refresh crashed after its chat write', async () => {
    const location = rig.live.get(key(defaultScope));
    if (location === undefined) throw new Error('Test scope missing');
    await rig.append(auditEntry('turn-before-summary-crash'));
    await rig.store.refreshInternal('startup');
    await rig.store.waitForIdle();
    await rig.append(auditEntry('turn-after-summary-crash'));

    const persistence = await import('../persistence');
    const summaryWrite = jest
      .spyOn(persistence, 'writeSummaryFile')
      .mockRejectedValueOnce(new Error('simulated summary crash'));
    await expect(rig.store.refreshInternal('idle')).rejects.toThrow(
      'simulated summary crash',
    );
    summaryWrite.mockRestore();
    expect(
      (await readSummaryFile(location.directory)).value?.chats[0]?.turnCount,
    ).toBe(1);
    expect(
      Object.keys((await persistedChat(location)).value?.records ?? {}),
    ).toHaveLength(2);

    const restarted = new CostIndexStore(rig.host);
    await restarted.refreshInternal('startup');
    await restarted.waitForIdle();
    expect(
      (await readSummaryFile(location.directory)).value?.chats[0]?.turnCount,
    ).toBe(2);
  });

  it('discards a mismatched incarnation instead of leaving a stale sibling directory', async () => {
    const location = rig.live.get(key(defaultScope));
    if (location === undefined) throw new Error('Test scope missing');
    await rig.append(
      auditEntry('turn-old', defaultScope, {
        startedAt: '2026-10-09T01:00:00.000Z',
        completedAt: '2026-10-09T01:01:00.000Z',
      }),
      '2026-10-09.jsonl',
    );
    await rig.store.refreshInternal('startup');
    const staleSummary = (await readSummaryFile(location.directory)).value;
    if (staleSummary === null) throw new Error('Expected persisted summary');
    await writeFile(
      join(location.directory, 'summary.json'),
      JSON.stringify({ ...staleSummary, incarnation: 'old-incarnation' }),
    );
    rig.live.set(key(defaultScope), {
      ...location,
      incarnation: '2026-10-09T00:00:00.000Z',
      createdAt: '2026-10-09T00:00:00.000Z',
    });

    await rig.store.refreshInternal('turn', defaultScope);
    expect((await readSummaryFile(location.directory)).value?.incarnation).toBe(
      '2026-10-09T00:00:00.000Z',
    );
    const siblings = await readdir(join(rig.root, 'scopes'));
    expect(siblings.some((name) => name.includes('stale-incarnation'))).toBe(
      false,
    );
  });

  it('preserves coverage and configured retention through later updates', async () => {
    const location = rig.live.get(key(defaultScope));
    if (location === undefined) throw new Error('Test scope missing');
    await rig.append(auditEntry('turn-coverage'));
    await rig.store.refreshInternal('startup');
    const firstSummary = (await readSummaryFile(location.directory)).value;
    if (firstSummary === null) throw new Error('Expected persisted summary');
    rig.setNow('2026-10-20T12:00:00.000Z');
    await rig.append(
      auditEntry('turn-later', defaultScope, {
        startedAt: '2026-10-20T11:00:00.000Z',
        completedAt: '2026-10-20T11:01:00.000Z',
      }),
      '2026-10-20.jsonl',
    );
    await rig.store.refreshInternal('startup');
    const laterSummary = (await readSummaryFile(location.directory)).value;
    expect(laterSummary?.coverageStart).toBe(firstSummary.coverageStart);
    expect(laterSummary?.retentionDays).toBe(21);
  });

  it('catches up and seals retained days before retention can unlink them, without observability flush', async () => {
    const location = rig.live.get(key(defaultScope));
    if (location === undefined) throw new Error('Test scope missing');
    await rig.append(auditEntry('turn-day-seal'), '2026-10-08.jsonl');
    expect(
      await rig.store.catchUpAndSealDay('2026-10-08.jsonl'),
    ).not.toBeNull();
    expect(rig.flushCount()).toBe(0);
    const afterSeal = (await readScopeFiles(location.directory)).chats[0];
    expect(Object.keys(afterSeal?.records ?? {})).toHaveLength(0);
    expect(afterSeal?.sealedEntryIds).toEqual(['turn-day-seal']);
    const summary = (await readSummaryFile(location.directory)).value;
    expect(summary?.chats[0]?.turnCount).toBe(1);

    const restarted = new CostIndexStore(rig.host);
    expect(
      await restarted.catchUpAndSealDay('2026-10-08.jsonl'),
    ).not.toBeNull();
    expect(
      (await readSummaryFile(location.directory)).value?.chats[0]?.turnCount,
    ).toBe(1);
  });

  it('leaves a running turn unsealed on its day so its completion still counts', async () => {
    const location = rig.live.get(key(defaultScope));
    if (location === undefined) throw new Error('Test scope missing');
    await rig.append(auditEntry('turn-done'), '2026-10-08.jsonl');
    await rig.append(
      auditEntry('turn-long', defaultScope, {
        status: 'running',
        completedAt: undefined,
        durationMs: undefined,
        totalCostUsd: 0,
        tokens: { input: 0, output: 0 },
      }),
      '2026-10-08.jsonl',
    );
    // Retention seals the day while the long turn is still running.
    expect(
      await rig.store.catchUpAndSealDay('2026-10-08.jsonl'),
    ).not.toBeNull();
    const afterSeal = (await readScopeFiles(location.directory)).chats[0];
    expect(Object.keys(afterSeal?.records ?? {})).toEqual(['turn-long']);
    expect(afterSeal?.sealedEntryIds).toEqual(['turn-done']);

    // The completion is written to the turn's start-day file.
    await rig.append(
      auditEntry('turn-long', defaultScope, { totalCostUsd: 5 }),
      '2026-10-08.jsonl',
    );
    await rig.store.refreshInternal('idle');
    await rig.store.waitForIdle();
    const completed = (await readSummaryFile(location.directory)).value;
    expect(completed?.totals.usd).toBeCloseTo(5.25, 6);
    expect(completed?.chats[0]?.turnCount).toBe(2);

    // The next retention pass seals it with its final figures.
    expect(
      await rig.store.catchUpAndSealDay('2026-10-08.jsonl'),
    ).not.toBeNull();
    const sealedLater = (await readScopeFiles(location.directory)).chats[0];
    expect(Object.keys(sealedLater?.records ?? {})).toHaveLength(0);
    expect(sealedLater?.sealedEntryIds).toEqual(['turn-done', 'turn-long']);
    const summary = (await readSummaryFile(location.directory)).value;
    expect(summary?.totals.usd).toBeCloseTo(5.25, 6);
    expect(summary?.chats[0]?.turnCount).toBe(2);
  });

  it('rechecks a day after sealing while a queued refresh consumes a concurrent append', async () => {
    const location = rig.live.get(key(defaultScope));
    if (location === undefined) throw new Error('Test scope missing');
    let releaseLock = (): void => undefined;
    let signalLock = (): void => undefined;
    const lockGate = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const lockEntered = new Promise<void>((resolve) => {
      signalLock = resolve;
    });
    const host: CostIndexHost = {
      ...rig.host,
      withRetainedLock: async (_scope, action) => {
        signalLock();
        await lockGate;
        return await action();
      },
    };
    const store = new CostIndexStore(host);
    await rig.append(auditEntry('turn-before-seal'), '2026-10-08.jsonl');

    const catchUp = store.catchUpAndSealDay('2026-10-08.jsonl');
    await lockEntered;
    let releaseWrite = (): void => undefined;
    let signalWrite = (): void => undefined;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const writeEntered = new Promise<void>((resolve) => {
      signalWrite = resolve;
    });
    const persistence = await import('../persistence');
    const realWrite = persistence.writeChatFile;
    const writeChat = jest
      .spyOn(persistence, 'writeChatFile')
      .mockImplementation(async (directory, file) => {
        if (file.records['turn-during-seal'] !== undefined) {
          signalWrite();
          await writeGate;
        }
        await realWrite(directory, file);
      });
    try {
      await rig.append(auditEntry('turn-during-seal'), '2026-10-08.jsonl');
      const queuedRefresh = store.refreshInternal('idle');
      await writeEntered;
      releaseLock();
      releaseWrite();

      expect(await catchUp).toBeNull();
      await queuedRefresh;
      const files = await readScopeFiles(location.directory);
      expect(files.chats[0]?.sealedEntryIds).toEqual([
        'turn-before-seal',
        'turn-during-seal',
      ]);
      expect(files.chats[0]?.sealed?.turnCount).toBe(2);
      expect(
        (await readSummaryFile(location.directory)).value?.chats[0]?.turnCount,
      ).toBe(2);
    } finally {
      releaseLock();
      releaseWrite();
      writeChat.mockRestore();
    }
  });

  it('fills a retained entry once, sealing records with tombstones under its operation lock', async () => {
    const liveLocation = rig.live.get(key(defaultScope));
    if (liveLocation === undefined) throw new Error('Test scope missing');
    rig.live.delete(key(defaultScope));
    const retainedScope: CostScopeRef = {
      kind: 'retained',
      projectId,
      containerId: worktreeId,
    };
    const retainedLocation = rig.addScope(retainedScope, { retained: true });
    await rig.append(auditEntry('turn-retained'));

    await rig.store.refreshInternal('startup');
    await rig.store.waitForIdle();
    const loaded = await readScopeFiles(retainedLocation.directory);
    expect(loaded.summary.value?.sealedAt).toBeDefined();
    expect(loaded.chats[0]?.records).toEqual({});
    expect(loaded.chats[0]?.sealedEntryIds).toEqual(['turn-retained']);
    expect(loaded.summary.value?.chats[0]?.turnCount).toBe(1);
    expect((await stat(retainedLocation.directory)).isDirectory()).toBe(true);
  });

  it('persists exact non-agent pipeline counts before sealing a root run', async () => {
    const location = rig.live.get(key(defaultScope));
    if (location === undefined) throw new Error('Test scope missing');
    const runScope: CostScopeRef = {
      kind: 'entry',
      projectId,
      worktreeId,
    };
    const hostWithPipeline: CostIndexHost = {
      ...rig.host,
      readPipelineRun: async (_scope, executionId) =>
        executionId === 'run-1'
          ? { status: 'succeeded', pipelineName: 'Build', nonAgentStepCount: 4 }
          : null,
    };
    const store = new CostIndexStore(hostWithPipeline);
    await rig.append(
      auditEntry('pipeline-turn', runScope, {
        eventType: 'pipeline_agent_turn',
        chatId: undefined,
        pipelineExecutionId: 'run-1',
        rootPipelineExecutionId: 'run-1',
        pipelineName: 'Build',
        jobId: 'job-1',
        stepId: 'step-1',
      }),
    );
    await store.refreshInternal('archive', runScope);
    await store.sealScope(runScope);
    const unattached = (await readScopeFiles(location.directory)).unattached
      .value;
    expect(unattached?.sealedRuns?.['run-1']?.nonAgentStepCount).toBe(4);
    expect(unattached?.sealedRuns?.['run-1']?.run.status).toBe('succeeded');
  });

  it('routes a chat-linked pipeline delegation to its parent run, not a chat row', async () => {
    const location = rig.live.get(key(defaultScope));
    if (location === undefined) throw new Error('Test scope missing');
    await rig.append(
      auditEntry('pipeline-delegation', defaultScope, {
        eventType: 'managed_delegation',
        pipelineName: 'Parent run',
        delegation: {
          delegationId: 'delegation-1',
          runGeneration: 1,
          parentPipelineExecutionId: 'run-parent',
        },
      }),
    );
    await rig.append(
      auditEntry('pipeline-root-step', defaultScope, {
        eventType: 'pipeline_agent_turn',
        chatId: undefined,
        pipelineExecutionId: 'run-parent',
        rootPipelineExecutionId: 'run-parent',
        jobId: 'job-parent',
        stepId: 'step-parent',
      }),
    );

    await rig.store.refreshInternal('startup');

    const files = await readScopeFiles(location.directory);
    const summary = (await readSummaryFile(location.directory)).value;
    expect(files.chats).toHaveLength(0);
    expect(
      files.unattached.value?.records['pipeline-delegation']?.pipeline
        ?.rootExecutionId,
    ).toBe('run-parent');
    expect(summary?.chats).toHaveLength(0);
    expect(summary?.pipelineRuns).toHaveLength(1);
    expect(summary?.pipelineRuns[0]?.totals.usd).toBe(0.5);
    expect(summary?.totals.usd).toBe(0.5);
  });

  it.each([['subscription'], ['api_key']] as const)(
    'repairs a later explicit unknown from same-pass %s chat evidence while keeping the latest measurements',
    async (billingBasis) => {
      const location = rig.live.get(key(defaultScope));
      if (location === undefined) throw new Error('Test scope missing');
      const entryId = `turn-repair-${billingBasis}`;
      const identity = {
        providerAccountKey: 'claude:store-test-account',
        providerAccountEmail:
          billingBasis === 'subscription'
            ? 'store-test@example.invalid'
            : undefined,
      };
      const auditPath = join(rig.audit, '2026-10-08.jsonl');
      await rig.append(
        explicitChatEvidence(entryId, billingBasis, defaultScope, {
          ...identity,
          aiCreditsRouted: false,
          modelGatewayRouted: false,
          status: 'running',
          completedAt: undefined,
          totalCostUsd: 0.2,
          tokens: { input: 2, output: 1 },
        }),
      );
      await rig.append(
        explicitUnknownChatEntry(entryId, defaultScope, {
          ...identity,
          status: 'failure',
          completedAt: '2026-10-08T23:59:20.000Z',
          durationMs: 20_000,
          totalCostUsd: 1.25,
          observedCost: {
            status: 'partially_priced',
            reason: 'pricing_unavailable',
            currency: 'usd',
            totalUsd: 1.25,
            components: [],
          },
          tokens: {
            input: 100,
            output: 10,
            cacheReadInputTokens: 8,
            cacheCreationInputTokens: 5,
            reasoningOutputTokens: 2,
          },
          toolCounts: { bash: 7, read: 2 },
          context: {
            endTokens: 118,
            windowTokens: 2_000,
            peakTokens: 140,
            categories: [{ name: 'used', tokens: 118, kind: 'used' }],
          },
          subagents: [
            {
              id: 'subagent-test-1',
              kind: 'claude_task',
              model: 'claude-haiku',
              tokens: {
                input: 10,
                output: 4,
                cacheReadInputTokens: 0,
                cacheCreationInputTokens: 0,
                reasoningOutputTokens: 0,
              },
              inclusion: 'included',
            },
          ],
        }),
      );
      const auditBefore = await readFile(auditPath, 'utf8');

      await rig.store.refreshInternal('startup');
      await rig.store.waitForIdle();

      const chat = (await persistedChat(location)).value;
      const record = chat?.records[entryId];
      if (record === undefined) throw new Error('Expected repaired chat turn');
      expect(record.billingBasis).toBe(billingBasis);
      expect(record.status).toBe('failure');
      expect(record.completedAt).toBe('2026-10-08T23:59:20.000Z');
      expect(record.durationMs).toBe(20_000);
      expect(record.costUsd).toBe(1.25);
      expect(record.costStatus).toBe('partial');
      expect(record.tokens).toEqual({
        input: 100,
        output: 10,
        cacheReadInputTokens: 8,
        cacheCreationInputTokens: 5,
        reasoningOutputTokens: 2,
      });
      expect(record.context).toMatchObject({
        endTokens: 118,
        windowTokens: 2_000,
        peakTokens: 140,
      });
      expect(record.toolCounts?.bash).toBe(7);
      expect(record.toolCounts?.read).toBe(2);
      expect(record.subagents).toHaveLength(1);
      expect(record.subagents?.[0]).toMatchObject({
        id: 'subagent-test-1',
        billingBasis,
        costStatus: 'estimated',
        inclusion: 'included',
      });
      expect(record.subagents?.[0]?.usd).toBeGreaterThan(0);
      expect(record.subagents?.[0]?.tokens.input).toBe(10);

      const serializedRecord = JSON.stringify(record);
      for (const privateField of [
        'sdkSessionId',
        'providerAccountKey',
        'providerAccountEmail',
        'providerPlanType',
      ]) {
        expect(serializedRecord.includes(privateField)).toBe(false);
      }
      expect(await readFile(auditPath, 'utf8')).toBe(auditBefore);
    },
  );

  it('uses the latest explicit supported basis in a same-pass chain', async () => {
    const location = rig.live.get(key(defaultScope));
    if (location === undefined) throw new Error('Test scope missing');
    const entryId = 'turn-latest-explicit-basis';
    await rig.append(explicitChatEvidence(entryId, 'api_key'));
    await rig.append(explicitChatEvidence(entryId, 'subscription'));
    await rig.append(explicitUnknownChatEntry(entryId));

    await rig.store.refreshInternal('startup');

    expect(
      (await persistedChat(location)).value?.records[entryId]?.billingBasis,
    ).toBe('subscription');
  });

  it('keeps supported evidence through a chain of explicit unknown updates', async () => {
    const location = rig.live.get(key(defaultScope));
    if (location === undefined) throw new Error('Test scope missing');
    const entryId = 'turn-chained-unknown-updates';
    await rig.append(explicitChatEvidence(entryId));
    await rig.append(
      explicitUnknownChatEntry(entryId, defaultScope, {
        totalCostUsd: 0.3,
      }),
    );
    await rig.append(
      explicitUnknownChatEntry(entryId, defaultScope, {
        totalCostUsd: 0.45,
      }),
    );

    await rig.store.refreshInternal('startup');

    const record = (await persistedChat(location)).value?.records[entryId];
    expect(record?.billingBasis).toBe('subscription');
    expect(record?.costUsd).toBe(0.45);
  });

  it('does not repair when the required session, account identity, or explicit basis is missing', async () => {
    const location = rig.live.get(key(defaultScope));
    if (location === undefined) throw new Error('Test scope missing');
    const cases: {
      readonly entryId: string;
      readonly original: Record<string, unknown>;
      readonly latest: Record<string, unknown>;
    }[] = [
      {
        entryId: 'turn-no-session',
        original: { sdkSessionId: undefined },
        latest: { sdkSessionId: undefined },
      },
      {
        entryId: 'turn-no-original-account-key',
        original: { providerAccountKey: undefined },
        latest: {},
      },
      {
        entryId: 'turn-no-current-account-key',
        original: {},
        latest: { providerAccountKey: undefined },
      },
      {
        entryId: 'turn-no-original-account-email',
        original: { providerAccountEmail: undefined },
        latest: {},
      },
      {
        entryId: 'turn-no-current-account-email',
        original: {},
        latest: { providerAccountEmail: undefined },
      },
      {
        entryId: 'turn-changed-account-email',
        original: {},
        latest: { providerAccountEmail: 'different@example.invalid' },
      },
      {
        entryId: 'turn-changed-account-key',
        original: {},
        latest: { providerAccountKey: 'claude:different-test-account' },
      },
      {
        entryId: 'turn-api-key-no-account-key',
        original: { billingBasis: 'api_key', providerAccountKey: undefined },
        latest: { providerAccountKey: undefined },
      },
      {
        entryId: 'turn-plan-type-only',
        original: {
          billingBasis: undefined,
          providerAccountKey: undefined,
          providerAccountEmail: undefined,
          providerPlanType: 'enterprise',
        },
        latest: {
          providerAccountKey: undefined,
          providerAccountEmail: undefined,
          providerPlanType: 'enterprise',
        },
      },
      {
        entryId: 'turn-fallback-account-inference-only',
        original: { billingBasis: undefined },
        latest: {},
      },
      {
        entryId: 'turn-old-explicit-unknown-only',
        original: { billingBasis: 'unknown' },
        latest: {},
      },
    ];

    for (const item of cases) {
      await rig.append(
        explicitChatEvidence(item.entryId, 'subscription', defaultScope, {
          ...item.original,
        }),
      );
      await rig.append(
        explicitUnknownChatEntry(item.entryId, defaultScope, item.latest),
      );
    }

    await rig.store.refreshInternal('startup');

    const records = (await persistedChat(location)).value?.records;
    for (const item of cases) {
      expect(records?.[item.entryId]?.billingBasis).toBe('unknown');
    }
  });

  it('does not repair across changed scope, chat, event, provider, session, time, or route identity', async () => {
    const location = rig.live.get(key(defaultScope));
    if (location === undefined) throw new Error('Test scope missing');
    const otherScope: CostScopeRef = {
      kind: 'entry',
      projectId: 'project-2',
      worktreeId: 'entry-2',
    };
    rig.addScope(otherScope);
    const cases: {
      readonly entryId: string;
      readonly latestScope?: CostScopeRef;
      readonly latestChatId?: string;
      readonly latest: Record<string, unknown>;
    }[] = [
      {
        entryId: 'turn-changed-scope',
        latestScope: otherScope,
        latest: {},
      },
      {
        entryId: 'turn-changed-chat',
        latestChatId: 'chat-other',
        latest: { chatId: 'chat-other' },
      },
      {
        entryId: 'turn-changed-event',
        latest: { eventType: 'standalone_chat' },
      },
      {
        entryId: 'turn-changed-provider',
        latest: { provider: 'codex' },
      },
      {
        entryId: 'turn-changed-session',
        latest: { sdkSessionId: 'sdk-session-other' },
      },
      {
        entryId: 'turn-changed-start-time',
        latest: { startedAt: '2026-10-08T23:58:00.000Z' },
      },
      {
        entryId: 'turn-changed-route',
        latest: { aiCreditsRouted: true },
      },
      {
        entryId: 'turn-changed-gateway-route',
        latest: { modelGatewayRouted: true },
      },
    ];

    for (const item of cases) {
      await rig.append(explicitChatEvidence(item.entryId));
      await rig.append(
        explicitUnknownChatEntry(
          item.entryId,
          item.latestScope ?? defaultScope,
          item.latest,
        ),
      );
    }

    await rig.store.refreshInternal('startup');

    for (const item of cases) {
      const target = rig.live.get(key(item.latestScope ?? defaultScope));
      if (target === undefined) throw new Error('Test target scope missing');
      const record = (await persistedChat(target, item.latestChatId ?? chatId))
        .value?.records[item.entryId];
      expect(record?.billingBasis).toBe('unknown');
    }
  });

  it('does not repair when raw billing identity fields exceed their limits', async () => {
    const location = rig.live.get(key(defaultScope));
    if (location === undefined) throw new Error('Test scope missing');
    const oversized = 'x'.repeat(1025);
    const cases: {
      readonly entryId: string;
      readonly original: Record<string, unknown>;
      readonly latest: Record<string, unknown>;
    }[] = [
      {
        entryId: 'turn-oversized-original-session',
        original: { sdkSessionId: oversized },
        latest: {},
      },
      {
        entryId: 'turn-oversized-current-session',
        original: {},
        latest: { sdkSessionId: oversized },
      },
      {
        entryId: 'turn-oversized-original-account-key',
        original: { providerAccountKey: oversized },
        latest: {},
      },
      {
        entryId: 'turn-oversized-current-account-key',
        original: {},
        latest: { providerAccountKey: oversized },
      },
      {
        entryId: 'turn-oversized-original-account-email',
        original: { providerAccountEmail: oversized },
        latest: {},
      },
      {
        entryId: 'turn-oversized-current-account-email',
        original: {},
        latest: { providerAccountEmail: oversized },
      },
    ];

    for (const item of cases) {
      await rig.append(
        explicitChatEvidence(item.entryId, 'subscription', defaultScope, {
          ...item.original,
        }),
      );
      await rig.append(
        explicitUnknownChatEntry(item.entryId, defaultScope, item.latest),
      );
    }

    await rig.store.refreshInternal('startup');

    const records = (await persistedChat(location)).value?.records;
    for (const item of cases) {
      expect(records?.[item.entryId]?.billingBasis).toBe('unknown');
    }
  });

  it('does not truncate oversized raw entry, chat, or scope identity fields', () => {
    const oversized = 'x'.repeat(2049);
    const cases: {
      readonly entryId: string;
      readonly overrides: Record<string, unknown>;
    }[] = [
      { entryId: 'turn-oversized-id', overrides: { id: oversized } },
      { entryId: 'turn-oversized-chat-id', overrides: { chatId: oversized } },
      {
        entryId: 'turn-oversized-project-id',
        overrides: { projectId: oversized },
      },
      {
        entryId: 'turn-oversized-worktree-id',
        overrides: { worktreeId: oversized },
      },
    ];

    for (const item of cases) {
      const prior = normalizeAuditEntry(
        explicitChatEvidence(item.entryId, 'subscription', defaultScope, {
          ...item.overrides,
        }),
      );
      const latest = normalizeAuditEntry(
        explicitUnknownChatEntry(item.entryId, defaultScope, item.overrides),
      );
      if (prior === null || latest === null)
        throw new Error('Expected parsed oversized billing identity');
      const evidence = new BillingEvidencePass();
      evidence.apply(prior);
      expect(evidence.apply(latest).billingBasis).toBe('unknown');
    }
  });

  it('invalidates older evidence on an intervening unsupported basis, mismatch, or dropped source', async () => {
    const location = rig.live.get(key(defaultScope));
    if (location === undefined) throw new Error('Test scope missing');
    const cases: {
      readonly entryId: string;
      readonly intervening: Record<string, unknown>;
    }[] = [
      {
        entryId: 'turn-intervening-unsupported-basis',
        intervening: auditEntry(
          'turn-intervening-unsupported-basis',
          defaultScope,
          {
            billingBasis: 'ai_credits',
            sdkSessionId: 'sdk-session-test',
            providerAccountKey: 'claude:store-test-account',
            providerAccountEmail: 'store-test@example.invalid',
          },
        ),
      },
      {
        entryId: 'turn-intervening-session-mismatch',
        intervening: explicitUnknownChatEntry(
          'turn-intervening-session-mismatch',
          defaultScope,
          { sdkSessionId: 'sdk-session-other' },
        ),
      },
      {
        entryId: 'turn-intervening-dropped-source',
        intervening: auditEntry(
          'turn-intervening-dropped-source',
          defaultScope,
          {
            eventType: 'pipeline_editor',
            billingBasis: 'unknown',
            sdkSessionId: 'sdk-session-test',
            providerAccountKey: 'claude:store-test-account',
            providerAccountEmail: 'store-test@example.invalid',
          },
        ),
      },
    ];

    for (const item of cases) {
      await rig.append(explicitChatEvidence(item.entryId));
      await rig.append(item.intervening);
      await rig.append(explicitUnknownChatEntry(item.entryId));
    }

    await rig.store.refreshInternal('startup');

    const records = (await persistedChat(location)).value?.records;
    for (const item of cases) {
      expect(records?.[item.entryId]?.billingBasis).toBe('unknown');
    }
  });

  it('never uses ambiguous account-proxy evidence or a non-chat source to repair a chat', async () => {
    const location = rig.live.get(key(defaultScope));
    if (location === undefined) throw new Error('Test scope missing');
    const proxyId = 'turn-account-proxy-not-repairable';
    await rig.append(
      auditEntry(proxyId, defaultScope, {
        billingBasis: 'account_proxy',
        sdkSessionId: 'sdk-session-test',
        providerAccountKey: 'claude:store-test-account',
        providerAccountEmail: 'store-test@example.invalid',
      }),
    );
    await rig.append(explicitUnknownChatEntry(proxyId));

    const pipelineId = 'turn-pipeline-not-chat-evidence';
    await rig.append(
      explicitChatEvidence(pipelineId, 'subscription', defaultScope, {
        eventType: 'pipeline_agent_turn',
        chatId: undefined,
        pipelineExecutionId: 'run-non-chat-evidence',
      }),
    );
    await rig.append(explicitUnknownChatEntry(pipelineId));

    await rig.store.refreshInternal('startup');

    const chatRecords = (await persistedChat(location)).value?.records;
    expect(chatRecords?.[proxyId]?.billingBasis).toBe('unknown');
    expect(chatRecords?.[pipelineId]?.billingBasis).toBe('unknown');
  });

  it('does not carry explicit evidence across audit-file boundaries in one pass', async () => {
    const location = rig.live.get(key(defaultScope));
    if (location === undefined) throw new Error('Test scope missing');
    const entryId = 'turn-file-boundary';
    // The same start time is deliberately stored under two file names so this
    // isolates evidence lifetime at the existing sequential file boundary.
    await rig.append(explicitChatEvidence(entryId), '2026-10-08.jsonl');
    await rig.append(explicitUnknownChatEntry(entryId), '2026-10-09.jsonl');

    await rig.store.refreshInternal('startup');

    expect(
      (await persistedChat(location)).value?.records[entryId]?.billingBasis,
    ).toBe('unknown');
  });

  it('fails closed after the per-file evidence map exceeds 4096 entries', async () => {
    const location = rig.live.get(key(defaultScope));
    if (location === undefined) throw new Error('Test scope missing');
    const entryId = 'turn-evicted-evidence';
    const lines: string[] = [JSON.stringify(explicitChatEvidence(entryId))];
    for (let index = 0; index < 4096; index += 1) {
      lines.push(
        JSON.stringify(explicitChatEvidence(`turn-evidence-capacity-${index}`)),
      );
    }
    lines.push(JSON.stringify(explicitUnknownChatEntry(entryId)));
    await writeFile(
      join(rig.audit, '2026-10-08.jsonl'),
      `${lines.join('\n')}\n`,
      'utf8',
    );

    await rig.store.refreshInternal('startup');

    expect(
      (await persistedChat(location)).value?.records[entryId]?.billingBasis,
    ).toBe('unknown');
  });

  it('replays generation-1 consumed history in a fresh store and keeps sealed retained data unchanged', async () => {
    const location = rig.live.get(key(defaultScope));
    if (location === undefined) throw new Error('Test scope missing');
    const retainedScope: CostScopeRef = {
      kind: 'retained',
      projectId,
      containerId: 'entry-2',
    };
    const retainedLocation = rig.addScope(retainedScope, { retained: true });
    const entryId = 'turn-generation-repair';
    const retainedId = 'turn-generation-sealed';
    const auditPath = join(rig.audit, '2026-10-08.jsonl');

    await rig.append(explicitChatEvidence(entryId));
    await rig.append(
      explicitChatEvidence(retainedId, 'subscription', retainedScope),
    );
    await rig.store.refreshInternal('startup');
    await rig.store.waitForIdle();
    const retainedChatPath = join(
      retainedLocation.directory,
      'chats',
      `${Buffer.from(chatId, 'utf8').toString('base64url')}.json`,
    );
    const retainedChatBefore = await readFile(retainedChatPath, 'utf8');
    const retainedSummaryBefore = await readFile(
      join(retainedLocation.directory, 'summary.json'),
      'utf8',
    );
    expect(
      (await readSummaryFile(retainedLocation.directory)).value?.sealedAt,
    ).toBeDefined();

    await rig.append(
      explicitUnknownChatEntry(entryId, defaultScope, {
        totalCostUsd: 1.25,
      }),
    );
    await rig.store.refreshInternal('idle');
    await rig.store.waitForIdle();
    expect(
      (await persistedChat(location)).value?.records[entryId]?.billingBasis,
    ).toBe('unknown');
    const consumedCheckpoint = (await readCheckpointFile(rig.checkpoint)).value;
    if (consumedCheckpoint === null)
      throw new Error('Expected consumed audit checkpoint');
    expect(consumedCheckpoint.audit['2026-10-08.jsonl']?.offset).toBe(
      (await stat(auditPath)).size,
    );

    // Model the checkpoint produced by the prior generation, with both audit
    // lines already consumed and the latest unknown projection on disk.
    await writeCheckpointFile(rig.checkpoint, {
      ...consumedCheckpoint,
      generation: 1,
    });
    const auditBeforeReplay = await readFile(auditPath, 'utf8');
    rig.slices.length = 0;
    const restarted = new CostIndexStore(rig.host);
    await restarted.refreshInternal('startup');
    await restarted.waitForIdle();

    expect(
      rig.slices.reduce((total, bytes) => total + bytes, 0),
    ).toBeGreaterThan(0);
    const repaired = (await persistedChat(location)).value?.records[entryId];
    expect(repaired?.billingBasis).toBe('subscription');
    expect(repaired?.costUsd).toBe(1.25);
    const repairedSummary = (await readSummaryFile(location.directory)).value;
    expect(repairedSummary?.incarnation).toBe(location.incarnation);
    const repairedSummaryBytes = await readFile(
      join(location.directory, 'summary.json'),
      'utf8',
    );
    const repairedChatPath = join(
      location.directory,
      'chats',
      `${Buffer.from(chatId, 'utf8').toString('base64url')}.json`,
    );
    const repairedChatBytes = await readFile(repairedChatPath, 'utf8');

    await restarted.refreshInternal('idle');
    await restarted.waitForIdle();

    expect(
      await readFile(join(location.directory, 'summary.json'), 'utf8'),
    ).toBe(repairedSummaryBytes);
    expect(await readFile(repairedChatPath, 'utf8')).toBe(repairedChatBytes);
    expect(await readFile(retainedChatPath, 'utf8')).toBe(retainedChatBefore);
    expect(
      await readFile(join(retainedLocation.directory, 'summary.json'), 'utf8'),
    ).toBe(retainedSummaryBefore);
    expect(await readFile(auditPath, 'utf8')).toBe(auditBeforeReplay);
  });

  it('repairs an unsealed retained initial fill before normal sealing', async () => {
    const retainedScope: CostScopeRef = {
      kind: 'retained',
      projectId,
      containerId: worktreeId,
    };
    rig.live.delete(key(defaultScope));
    const location = rig.addScope(retainedScope, { retained: true });
    const entryId = 'turn-retained-initial-repair';
    await rig.append(
      explicitChatEvidence(entryId, 'subscription', retainedScope),
    );
    await rig.append(
      explicitUnknownChatEntry(entryId, defaultScope, {
        totalCostUsd: 0.75,
      }),
    );

    await rig.store.refreshInternal('startup');
    await rig.store.waitForIdle();

    const sealed = await readScopeFiles(location.directory);
    expect(sealed.summary.value?.sealedAt).toBeDefined();
    expect(sealed.summary.value?.incarnation).toBe(location.incarnation);
    expect(sealed.summary.value?.totals.byBilling.subscription).toBeCloseTo(
      0.75,
      6,
    );
    expect(sealed.summary.value?.totals.byBilling.unknown).toBe(0);
    expect(sealed.chats[0]?.records).toEqual({});
    expect(sealed.chats[0]?.sealedEntryIds).toEqual([entryId]);
  });

  it('leaves a presealed retained archive unchanged when a later audit update arrives', async () => {
    const retainedScope: CostScopeRef = {
      kind: 'retained',
      projectId,
      containerId: worktreeId,
    };
    rig.live.delete(key(defaultScope));
    const location = rig.addScope(retainedScope, { retained: true });
    const entryId = 'turn-retained-already-sealed';
    const auditPath = join(rig.audit, '2026-10-08.jsonl');
    await rig.append(
      explicitUnknownChatEntry(entryId, defaultScope, {
        totalCostUsd: 0.75,
      }),
    );

    await rig.store.refreshInternal('startup');
    await rig.store.waitForIdle();

    const initialSummary = (await readSummaryFile(location.directory)).value;
    expect(initialSummary?.sealedAt).toBeDefined();
    expect(initialSummary?.incarnation).toBe(location.incarnation);
    const retainedChatPath = join(
      location.directory,
      'chats',
      `${Buffer.from(chatId, 'utf8').toString('base64url')}.json`,
    );
    const sealedChatBefore = await readFile(retainedChatPath, 'utf8');
    const sealedSummaryBefore = await readFile(
      join(location.directory, 'summary.json'),
      'utf8',
    );
    await rig.append(
      explicitUnknownChatEntry(entryId, defaultScope, {
        totalCostUsd: 9.5,
      }),
    );
    const auditAfterAppend = await readFile(auditPath, 'utf8');

    const restarted = new CostIndexStore(rig.host);
    await restarted.refreshInternal('startup');
    await restarted.waitForIdle();

    expect(await readFile(retainedChatPath, 'utf8')).toBe(sealedChatBefore);
    expect(
      await readFile(join(location.directory, 'summary.json'), 'utf8'),
    ).toBe(sealedSummaryBefore);
    expect(await readFile(auditPath, 'utf8')).toBe(auditAfterAppend);
  });

  it('does not repair from evidence behind the cursor after a new store starts', async () => {
    const location = rig.live.get(key(defaultScope));
    if (location === undefined) throw new Error('Test scope missing');
    const entryId = 'turn-cursor-boundary';
    const auditPath = join(rig.audit, '2026-10-08.jsonl');
    await rig.append(explicitChatEvidence(entryId));
    await rig.store.refreshInternal('startup');
    await rig.store.waitForIdle();
    const restarted = new CostIndexStore(rig.host);
    await rig.append(explicitUnknownChatEntry(entryId));
    const auditBefore = await readFile(auditPath, 'utf8');
    rig.slices.length = 0;

    await restarted.refreshInternal('startup');

    expect(
      (await persistedChat(location)).value?.records[entryId]?.billingBasis,
    ).toBe('unknown');
    expect(rig.slices.reduce((total, bytes) => total + bytes, 0)).toBe(
      Buffer.byteLength(
        `${JSON.stringify(explicitUnknownChatEntry(entryId))}\n`,
      ),
    );
    expect(await readFile(auditPath, 'utf8')).toBe(auditBefore);
  });
});

describe('CostIndexStore checkpoint compatibility and audit file identity', () => {
  let rig: StoreRig;

  beforeEach(async () => {
    rig = await createRig();
    rig.addScope(defaultScope);
  });

  afterEach(async () => {
    try {
      await rig.store.waitForIdle();
    } finally {
      await rm(rig.root, { recursive: true, force: true });
    }
  });

  function auditBytesRead(): number {
    return rig.slices.reduce((total, bytes) => total + bytes, 0);
  }

  async function writtenCheckpoint() {
    const checkpoint = (await readCheckpointFile(rig.checkpoint)).value;
    if (checkpoint === null) throw new Error('Expected a written checkpoint');
    return checkpoint;
  }

  it("keeps a version 1 checkpoint's cursors, coverage and fill state through a new store's idle refresh", async () => {
    await rig.append(auditEntry('turn-v1-a'), '2026-10-07.jsonl');
    await rig.append(auditEntry('turn-v1-b'), '2026-10-08.jsonl');
    await rig.store.refreshInternal('startup');
    await rig.store.waitForIdle();
    const written = await writtenCheckpoint();
    expect(
      Object.values(written.audit).every(
        (cursor) => cursor.ino !== undefined && cursor.ino > 0,
      ),
    ).toBe(true);
    const versionOne = {
      ...written,
      firstBuild: {
        at: '2026-09-01T00:00:00.000Z',
        coverageStart: '2026-09-01',
      },
      retainedFillComplete: true,
    };
    await writeFile(rig.checkpoint, `${JSON.stringify(versionOne)}\n`, 'utf8');
    rig.slices.length = 0;

    const restarted = new CostIndexStore(rig.host);
    expect(await restarted.hasAuditGrowth()).toBe(false);
    await restarted.refreshInternal('idle');
    await restarted.waitForIdle();

    expect(auditBytesRead()).toBe(0);
    const after = await writtenCheckpoint();
    expect(after.version).toBe(1);
    expect(after.generation).toBe(versionOne.generation);
    expect(after.audit).toEqual(versionOne.audit);
    expect(after.firstBuild).toEqual(versionOne.firstBuild);
    expect(after.retainedFillComplete).toBe(true);
    expect(await readdir(join(rig.root, 'index'))).toEqual(['checkpoint.json']);
  });

  it('reads a checkpoint from a later release as newer: no corrupt copy, one preserved original and the same coverage start', async () => {
    const location = rig.live.get(key(defaultScope));
    if (location === undefined) throw new Error('Test scope missing');
    const auditPath = join(rig.audit, '2026-10-08.jsonl');
    await rig.append(auditEntry('turn-after-downgrade'), '2026-10-08.jsonl');
    const newer = {
      version: 2,
      generation: 9,
      firstBuild: {
        at: '2026-09-01T00:00:00.000Z',
        coverageStart: '2026-09-01',
      },
      retainedFillComplete: true,
      audit: { '2026-10-08.jsonl': { position: 4096, shard: 'a' } },
      shards: ['written-by-a-later-release'],
    };
    const original = `${JSON.stringify(newer)}\n`;
    await mkdir(join(rig.root, 'index'), { recursive: true });
    await writeFile(rig.checkpoint, original, 'utf8');

    expect(await rig.store.hasAuditGrowth()).toBe(true);
    await rig.store.refreshInternal('startup');
    await rig.store.waitForIdle();

    const names = await readdir(join(rig.root, 'index'));
    expect(names.filter((name) => name.includes('.corrupt-'))).toEqual([]);
    const preserved = names.filter((name) =>
      name.startsWith('checkpoint.json.v2-'),
    );
    expect(preserved).toHaveLength(1);
    expect(
      await readFile(join(rig.root, 'index', preserved[0] ?? ''), 'utf8'),
    ).toBe(original);
    const after = await writtenCheckpoint();
    expect(after.version).toBe(1);
    expect(after.firstBuild).toEqual(newer.firstBuild);
    expect(after.retainedFillComplete).toBe(true);
    expect(after.audit['2026-10-08.jsonl']?.offset).toBe(
      (await stat(auditPath)).size,
    );
    expect(
      (await persistedChat(location)).value?.records['turn-after-downgrade'],
    ).toBeDefined();
    // The entry was created after the preserved coverage start.
    expect(
      (await readSummaryFile(location.directory)).value?.coverageStart,
    ).toBeUndefined();
  });

  it('drops the cursor of a day file that no longer exists at the end of a full pass', async () => {
    await rig.append(auditEntry('turn-old-day'), '2026-10-07.jsonl');
    await rig.append(auditEntry('turn-new-day'), '2026-10-08.jsonl');
    await rig.store.refreshInternal('startup');
    await rig.store.waitForIdle();
    expect(Object.keys((await writtenCheckpoint()).audit).sort()).toEqual([
      '2026-10-07.jsonl',
      '2026-10-08.jsonl',
    ]);

    await rm(join(rig.audit, '2026-10-07.jsonl'));
    await rig.store.refreshInternal('idle');
    await rig.store.waitForIdle();

    expect(Object.keys((await writtenCheckpoint()).audit)).toEqual([
      '2026-10-08.jsonl',
    ]);
  });

  it('reads a zero inode as an unknown identity, not as a replaced file', async () => {
    await rig.append(auditEntry('turn-zero-inode'), '2026-10-08.jsonl');
    await rig.store.refreshInternal('startup');
    await rig.store.waitForIdle();
    const written = await writtenCheckpoint();
    await writeCheckpointFile(rig.checkpoint, {
      ...written,
      audit: Object.fromEntries(
        Object.entries(written.audit).map(([filename, cursor]) => [
          filename,
          { ...cursor, ino: 0 },
        ]),
      ),
    });
    rig.slices.length = 0;

    const restarted = new CostIndexStore(rig.host);
    await restarted.refreshInternal('idle');
    await restarted.waitForIdle();

    expect(auditBytesRead()).toBe(0);
    expect(
      await restarted.catchUpAndSealDay('2026-10-08.jsonl'),
    ).not.toBeNull();
  });

  it('indexes the entry appended after a torn audit fragment', async () => {
    const location = rig.live.get(key(defaultScope));
    if (location === undefined) throw new Error('Test scope missing');
    const auditPath = join(rig.audit, '2026-10-08.jsonl');
    await writeFile(
      auditPath,
      `${JSON.stringify(auditEntry('turn-before-tear'))}\n{"id":"turn-torn","eventTy`,
      'utf8',
    );
    await rig.store.refreshInternal('startup');
    await rig.store.waitForIdle();

    await appendJsonlLines(
      auditPath,
      `${JSON.stringify(auditEntry('turn-after-tear'))}\n`,
    );
    await rig.store.refreshInternal('idle');
    await rig.store.waitForIdle();

    expect(
      Object.keys((await persistedChat(location)).value?.records ?? {}).sort(),
    ).toEqual(['turn-after-tear', 'turn-before-tear']);
  });

  it('preserves a corrupt archived summary once and schedules no audit replay for it', async () => {
    const retainedScope: CostScopeRef = {
      kind: 'retained',
      projectId,
      containerId: 'entry-archived',
    };
    const retainedLocation = rig.addScope(retainedScope, { retained: true });
    await mkdir(retainedLocation.directory, { recursive: true });
    await writeFile(
      join(retainedLocation.directory, 'summary.json'),
      '{"version":1,"projectId":',
      'utf8',
    );

    for (let read = 0; read < 2; read += 1) {
      const view = await rig.store.getScope({ scope: retainedScope });
      expect(view.status).toBe('ok');
      await rig.store.waitForIdle();
    }

    const names = await readdir(retainedLocation.directory);
    expect(
      names.filter((name) => name.startsWith('summary.json.corrupt-')),
    ).toHaveLength(1);
    expect((await readCheckpointFile(rig.checkpoint)).value).toBeNull();
  });
});
