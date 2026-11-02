/**
 * `diagnostics/app-events/` is global: `CLAUDE.md` requires that it never
 * carry a worktree or chat identifier (those diagnostics belong in
 * `diagnostics/session-events/`). This suite enforces the rule instead of
 * leaving it to review:
 *
 * - the record type declares no identifier field;
 * - every app diagnostic reaches disk through one sanitizing choke point;
 * - no call site builds a record with an identifier-named property;
 * - producers that handle scope identifiers emit none of them.
 */
import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';
import type { ChatStorageActivityWindow } from '@canopy/desktop-shared/node/chat-storage-activity';
import type {
  RendererDiagnosticsSummary,
  RemotePushSummary,
} from '@canopy/desktop-shared/types/observability';
import type {
  AppDiagnosticRecord,
  SessionDiagnosticRecord,
} from '../observability/service';
import {
  isAppDiagnosticIdentifierKey,
  sanitizeAppDiagnosticRecord,
} from '../observability/app-diagnostic-privacy';
import {
  formatUnknownError,
  recordMainProcessError,
} from '../observability/main-process-errors';
import {
  reportChatTranscriptFullRewrite,
  setChatTranscriptRewriteDiagnosticsForTests,
} from '../services/chat-transcript-rewrite-diagnostics';
import { startChatStorageActivityDiagnostics } from '../lib/chat-storage-activity-diagnostics';
import { buildMainEventLoopStallDiagnostic } from '../lib/main-event-loop-stall-diagnostic';
import { WakeLockService } from '../power/wake-lock-service';
import {
  CHAT_INPUT_DELIVERY_FAILURES,
  CHAT_INPUT_REFUSALS,
} from '@canopy/protocol/portal/input-delivery';
import {
  recordChatInputDeliveryOutcome,
  type ChatInputDeliveryOutcomeFacts,
} from '../lib/chat-input-delivery-diagnostics';

const MAIN_ROOT = path.resolve(__dirname, '..');
const SERVICE_PATH = path.join(MAIN_ROOT, 'observability', 'service.ts');

// Distinctive sentinels, so a match can only come from a leak.
const WORKSPACE = 'ws-sentinel-7c1';
const WORKTREE = 'wt-sentinel-4be';
const CHAT = 'chat-sentinel-93d';
const SENTINELS = [WORKSPACE, WORKTREE, CHAT];

function expectNoSentinel(value: unknown): void {
  const serialized = JSON.stringify(value);
  for (const sentinel of SENTINELS) {
    expect(serialized).not.toContain(sentinel);
  }
}

function sourceFile(filePath: string): ts.SourceFile {
  return ts.createSourceFile(
    filePath,
    readFileSync(filePath, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
}

function mainSourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__') files.push(...mainSourceFiles(fullPath));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      files.push(fullPath);
    }
  }
  return files;
}

function propertyName(node: ts.PropertyName): string | undefined {
  return ts.isIdentifier(node) ||
    ts.isStringLiteral(node) ||
    ts.isNumericLiteral(node)
    ? node.text
    : undefined;
}

describe('app-events privacy', () => {
  it('declares no worktree, chat, session or scope identifier on app diagnostics', () => {
    const file = sourceFile(SERVICE_PATH);
    const declared: string[] = [];
    const visit = (node: ts.Node): void => {
      if (
        ts.isInterfaceDeclaration(node) &&
        node.name.text === 'AppDiagnosticRecord'
      ) {
        for (const member of node.members) {
          const name =
            member.name === undefined ? undefined : propertyName(member.name);
          if (name !== undefined) declared.push(name);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);

    expect(declared.length).toBeGreaterThan(20);
    expect(declared.filter(isAppDiagnosticIdentifierKey)).toEqual([]);
  });

  it('routes every app diagnostic through the sanitizing recorder', () => {
    const file = sourceFile(SERVICE_PATH);
    const pushes: string[] = [];
    const visit = (node: ts.Node, method: string | undefined): void => {
      const nextMethod =
        ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)
          ? node.name.text
          : method;
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'push' &&
        ts.isPropertyAccessExpression(node.expression.expression) &&
        node.expression.expression.name.text === 'pendingAppDiagnostics'
      ) {
        const argument = node.arguments[0];
        pushes.push(
          `${nextMethod ?? '<top>'}:${argument ? argument.getText(file) : ''}`,
        );
      }
      ts.forEachChild(node, (child) => visit(child, nextMethod));
    };
    visit(file, undefined);

    expect(pushes).toEqual(['recordAppDiagnostic:sanitized']);
    expect(readFileSync(SERVICE_PATH, 'utf8')).toMatch(
      /const sanitized = sanitizeAppDiagnosticRecord\(event\);/,
    );
  });

  it('builds no app diagnostic with an identifier-named property', () => {
    const offenders: string[] = [];
    for (const filePath of mainSourceFiles(MAIN_ROOT)) {
      const file = sourceFile(filePath);
      const visit = (node: ts.Node): void => {
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === 'recordAppDiagnostic'
        ) {
          const argument = node.arguments[0];
          if (argument && ts.isObjectLiteralExpression(argument)) {
            for (const property of argument.properties) {
              const name =
                ts.isShorthandPropertyAssignment(property) ||
                ts.isPropertyAssignment(property)
                  ? propertyName(property.name)
                  : undefined;
              if (name !== undefined && isAppDiagnosticIdentifierKey(name)) {
                offenders.push(`${path.relative(MAIN_ROOT, filePath)}:${name}`);
              }
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(file);
    }

    expect(offenders).toEqual([]);
  });

  it('records main-process crashes in app-events only through recordMainProcessError', () => {
    const direct: string[] = [];
    for (const filePath of mainSourceFiles(MAIN_ROOT)) {
      const file = sourceFile(filePath);
      const visit = (node: ts.Node): void => {
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === 'recordAppDiagnostic'
        ) {
          const argument = node.arguments[0];
          const kind =
            argument && ts.isObjectLiteralExpression(argument)
              ? argument.properties.find(
                  (property) =>
                    ts.isPropertyAssignment(property) &&
                    propertyName(property.name) === 'kind',
                )
              : undefined;
          const kindText =
            kind && ts.isPropertyAssignment(kind)
              ? kind.initializer.getText(file)
              : '';
          if (/main_(?:unhandled_rejection|uncaught_exception)/.test(kindText))
            direct.push(`${path.relative(MAIN_ROOT, filePath)}:${kindText}`);
        }
        ts.forEachChild(node, visit);
      };
      visit(file);
    }

    expect(direct).toEqual([]);
  });

  it('strips identifier fields and identifier-bearing path segments before a record is kept', () => {
    // A record assembled from a wider object is how a field can slip past the
    // type: structural typing does not check properties a spread copies in.
    const smuggled = {
      version: 1 as const,
      timestamp: '2026-09-29T12:00:00.000Z',
      kind: 'startup_background_task_failed' as const,
      worktreeId: WORKTREE,
      chatId: CHAT,
      sessionKey: `${WORKSPACE}/${WORKTREE}/${CHAT}`,
      projectId: WORKSPACE,
      reason: `spawn /Users/u/.canopy/workspaces/${WORKSPACE}/worktrees/${WORKTREE}/bin/claude ENOENT`,
      error: `C:\\Users\\u\\.canopy\\workspaces\\${WORKSPACE}\\chat-storage-v2\\${WORKTREE}\\live-index.json: EPERM`,
      sourceId: `file:///Users/u/.canopy/workspaces/${WORKSPACE}/worktree-data/${WORKTREE}/panel.html`,
    };
    const record: AppDiagnosticRecord = smuggled;

    const sanitized = sanitizeAppDiagnosticRecord(record);

    expectNoSentinel(sanitized);
    expect(sanitized).toMatchObject({
      kind: 'startup_background_task_failed',
      reason:
        'spawn /Users/u/.canopy/workspaces/<redacted>/worktrees/<redacted>/bin/claude ENOENT',
    });
    expect(Object.keys(sanitized)).not.toContain('worktreeId');
  });

  it('keeps the one-way chat key of a full-rewrite record, and nothing that locates the chat', () => {
    const records: AppDiagnosticRecord[] = [];
    setChatTranscriptRewriteDiagnosticsForTests({
      sink: (record): void => {
        records.push(sanitizeAppDiagnosticRecord(record));
      },
    });
    try {
      reportChatTranscriptFullRewrite({
        chatId: CHAT,
        reason: 'patch',
        committedRows: 3,
        committedBytes: 300,
        patchedRows: 1,
        removedRows: 0,
        patchedBlockTypes: ['text'],
        activeTail: false,
      });
    } finally {
      setChatTranscriptRewriteDiagnosticsForTests();
    }

    expect(records).toHaveLength(1);
    const [record] = records;
    expectNoSentinel(record);
    // The key survives the sanitizer, and is a short one-way digest.
    expect(record.chatTranscriptRewriteChatKey).toMatch(/^[0-9a-f]{16}$/);
    expect(isAppDiagnosticIdentifierKey('chatTranscriptRewriteChatKey')).toBe(
      false,
    );
    // Every other chat-named key is still an identifier.
    expect(isAppDiagnosticIdentifierKey('chatKey')).toBe(true);
    expect(isAppDiagnosticIdentifierKey('rewriteChatId')).toBe(true);
  });

  it('keeps a main-process error message, which can quote identifiers, out of app-events', () => {
    // The code-graph worker's timeout message quotes its engine key, a bare
    // `<workspaceId>/<worktreeId>` pair no path rule can recognize.
    const timeout = Object.assign(
      new Error(
        `Code graph build for ${WORKSPACE}/${WORKTREE} timed out (chat ${CHAT})`,
      ),
      { code: 'ETIMEDOUT' },
    );
    const apps: AppDiagnosticRecord[] = [];
    const sessions: SessionDiagnosticRecord[] = [];
    const recorder = {
      recordAppDiagnostic: (record: AppDiagnosticRecord): void => {
        apps.push(sanitizeAppDiagnosticRecord(record));
      },
      recordSessionDiagnostic: (record: SessionDiagnosticRecord): void => {
        sessions.push(record);
      },
    };

    recordMainProcessError(recorder, 'main_uncaught_exception', timeout);
    recordMainProcessError(
      recorder,
      'main_unhandled_rejection',
      `rejected for ${WORKSPACE}/${WORKTREE}`,
    );

    expectNoSentinel(apps);
    expect(apps.map((record) => record.kind)).toEqual([
      'main_uncaught_exception',
      'main_unhandled_rejection',
    ]);
    // The global copy keeps the error's name, code and stack frames.
    expect(apps[0]?.error).toMatch(/^Error \[ETIMEDOUT\]\n\s+at /);
    expect(apps[1]?.error).toBe('non-error string value');
    // The full text, identifiers included, is kept where they may appear.
    expect(
      sessions.map((record) => [record.kind, record.mainErrorKind]),
    ).toEqual([
      ['main_error_detail', 'main_uncaught_exception'],
      ['main_error_detail', 'main_unhandled_rejection'],
    ]);
    expect(sessions[0]?.error).toContain(`${WORKSPACE}/${WORKTREE}`);
    expect(sessions[1]?.error).toBe(`rejected for ${WORKSPACE}/${WORKTREE}`);
  });

  it('records any rejection value without throwing, even one that cannot be coerced', () => {
    const throwingCoercion = {
      toString: (): string => {
        throw new Error('toString');
      },
      valueOf: (): string => {
        throw new Error('valueOf');
      },
    };
    const throwingToPrimitive = {
      [Symbol.toPrimitive]: (): string => {
        throw new Error('toPrimitive');
      },
    };
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const throwingStack = new Error('boom');
    Object.defineProperty(throwingStack, 'stack', {
      get: (): string => {
        throw new Error('stack');
      },
    });
    const throwingName = new Error('boom');
    Object.defineProperty(throwingName, 'name', {
      get: (): string => {
        throw new Error('name');
      },
    });
    const hostile: unknown[] = [
      throwingCoercion,
      throwingToPrimitive,
      Object.create(null),
      revoked.proxy,
      throwingStack,
      throwingName,
      Symbol('rejected'),
    ];
    const apps: AppDiagnosticRecord[] = [];
    const sessions: SessionDiagnosticRecord[] = [];
    const recorder = {
      recordAppDiagnostic: (record: AppDiagnosticRecord): void => {
        apps.push(record);
      },
      recordSessionDiagnostic: (record: SessionDiagnosticRecord): void => {
        sessions.push(record);
      },
    };

    for (const value of hostile) {
      expect(() =>
        recordMainProcessError(recorder, 'main_unhandled_rejection', value),
      ).not.toThrow();
    }

    expect(apps).toHaveLength(hostile.length);
    expect(sessions).toHaveLength(hostile.length);
    expect(sessions[0]?.error).toBe('[unformattable object]');
    expect(sessions[2]?.error).toBe('[unformattable object]');
    expect(sessions[3]?.error).toBe('[unformattable object]');
    expect(sessions[6]?.error).toBe('Symbol(rejected)');
    expect(apps[0]?.error).toBe('non-error object value');
    expect(apps[3]?.error).toBe('[unformattable object]');
    for (const record of [...apps, ...sessions]) {
      expect(typeof record.error).toBe('string');
    }
  });

  it('formats ordinary rejection values unchanged', () => {
    const withStack = new Error('boom');
    const withoutStack = new Error('no stack');
    withoutStack.stack = undefined;

    expect(formatUnknownError(withStack)).toBe(withStack.stack);
    expect(formatUnknownError(withoutStack)).toBe('no stack');
    expect(formatUnknownError('text')).toBe('text');
    expect(formatUnknownError(42)).toBe('42');
    expect(formatUnknownError(undefined)).toBe('undefined');
    expect(formatUnknownError({ a: 1 })).toBe('[object Object]');
  });

  it('returns records without identifiers unchanged', () => {
    const record: AppDiagnosticRecord = {
      version: 1,
      timestamp: '2026-09-29T12:00:00.000Z',
      kind: 'main_event_loop_stall',
      eventLoopWindowMs: 30_000,
      reason: 'renderer at /Applications/App.app/Contents/Resources',
    };

    expect(sanitizeAppDiagnosticRecord(record)).toBe(record);
  });

  it('keeps renderer and host push summaries scope-free and content-free', () => {
    const rendererSummary: RendererDiagnosticsSummary = {
      windowMs: 30_000,
      remoteWindow: true,
      frames: {
        count: 1,
        p95Ms: 40,
        maxMs: 40,
        blockingMs: 5,
        invokers: { userCallback: 1, eventListener: 0, promise: 0, script: 0 },
      },
      chatState: {
        onScreenChanges: 1,
        offScreenChanges: 1,
        scopeChanges: 0,
        onScreenMessages: 0,
        offScreenMessages: 0,
        mixedMessages: 1,
        onScreenApplyMs: 0,
        offScreenApplyMs: 0,
        mixedApplyMs: 3,
      },
      chatEvent: {
        onScreenEvents: 1,
        offScreenEvents: 0,
        delegationEvents: 0,
        onScreenApplyMs: 2,
        offScreenApplyMs: 0,
        delegationApplyMs: 0,
      },
      terminal: { deliveries: 1, applyMs: 1 },
    };
    const remotePushSummary: RemotePushSummary = {
      windowMs: 30_000,
      interestDeclared: true,
      chatState: {
        pushes: 2,
        bytes: 200,
        onScreenPushes: 1,
        offScreenPushes: 0,
        mixedPushes: 1,
        onScreenBytes: 80,
        offScreenBytes: 0,
        mixedBytes: 120,
      },
      chatEvent: {
        pushes: 1,
        bytes: 50,
        onScreenPushes: 1,
        offScreenPushes: 0,
        onScreenBytes: 50,
        offScreenBytes: 0,
      },
      terminal: { pushes: 1, bytes: 20 },
      other: { pushes: 0, bytes: 0 },
      duplicateDrops: 1,
    };
    const records: AppDiagnosticRecord[] = [
      {
        version: 1,
        timestamp: '2026-10-14T00:00:00.000Z',
        kind: 'renderer_frame_summary',
        rendererSummary,
      },
      {
        version: 1,
        timestamp: '2026-10-14T00:00:00.000Z',
        kind: 'remote_push_summary',
        remotePushSummary,
      },
    ];
    for (const record of records) {
      expect(Object.keys(record).sort()).toEqual(
        [
          'kind',
          record.kind === 'renderer_frame_summary'
            ? 'rendererSummary'
            : 'remotePushSummary',
          'timestamp',
          'version',
        ].sort(),
      );
      expectNoSentinel(sanitizeAppDiagnosticRecord(record));
      expect(JSON.stringify(record)).not.toMatch(
        /(?:chatId|worktreeId|projectId|sessionId|sourceUrl|path|content)/,
      );
    }
  });

  it('keeps wake-lock holder keys free of session identifiers', () => {
    const recorded: AppDiagnosticRecord[] = [];
    const service = new WakeLockService({
      platform: 'darwin',
      powerSaveBlocker: {
        start: (): number => 1,
        stop: (): void => undefined,
        isStarted: (): boolean => true,
      },
      recordDiagnostic: (record): void => {
        recorded.push(record);
      },
      now: (): number => 0,
    });
    const chatKey = `chat:${WORKSPACE}/${WORKTREE}/${CHAT}`;
    const delegationKey = `delegation:${WORKSPACE}/${WORKTREE}/${CHAT}/child`;

    service.acquire(chatKey, 'agent chat turn');
    service.acquire(delegationKey, 'delegated task');
    service.release(chatKey);
    service.release(delegationKey);

    expect(recorded.length).toBeGreaterThanOrEqual(4);
    expectNoSentinel(recorded);
    const holders = recorded
      .filter((record) => record.holderKey !== undefined)
      .map((record) => `${record.kind}:${record.holderKey}`);
    // Acquire and release still pair up by holder within a session.
    expect(holders).toEqual([
      'wake_lock_acquired:chat#1',
      'wake_lock_acquired:delegation#2',
      'wake_lock_released:chat#1',
      'wake_lock_released:delegation#2',
    ]);
  });

  it('keeps chat-storage aggregates and stall records free of scope identifiers', () => {
    jest.useFakeTimers();
    try {
      const window: ChatStorageActivityWindow = {
        scopes: [
          {
            scopeKey: 'opaque-scope-key',
            identity: { projectId: WORKSPACE, worktreeId: WORKTREE },
            activity: {
              commits: 1,
              mutations: 1,
              bytesWritten: 10,
              transcriptBytesWritten: 10,
              fileSyncs: 1,
              directorySyncs: 1,
              commitMsTotal: 5,
              commitMsMax: 5,
              queueWaitMsMax: 0,
            },
          },
        ],
        total: {
          commits: 1,
          mutations: 1,
          bytesWritten: 10,
          transcriptBytesWritten: 10,
          fileSyncs: 1,
          directorySyncs: 1,
          commitMsTotal: 5,
          commitMsMax: 5,
          queueWaitMsMax: 0,
        },
      };
      const apps: AppDiagnosticRecord[] = [];
      const stop = startChatStorageActivityDiagnostics({
        intervalMs: 1_000,
        take: () => window,
        recordSession: () => undefined,
        recordApp: (record) => apps.push(record),
      });
      jest.advanceTimersByTime(1_000);
      stop();

      expect(apps).toHaveLength(1);
      expectNoSentinel(apps);
    } finally {
      jest.useRealTimers();
    }

    const stall = buildMainEventLoopStallDiagnostic(
      { windowMs: 30_000, maxDelayMs: 1_500, p99DelayMs: 90, p50DelayMs: 1 },
      {
        timestamp: '2026-09-29T12:00:00.000Z',
        runningCodeGraphBuildCount: 1,
        queuedCodeGraphBuildCount: 0,
        activeTurnCount: 2,
      },
    );
    expect(Object.keys(stall).filter(isAppDiagnosticIdentifierKey)).toEqual([]);
  });

  it('keeps payload, provider and error text out of input delivery outcomes, which reach session diagnostics only', async () => {
    const PAYLOAD = 'payload-sentinel-5f2';
    // What a careless producer could spread from an attempt or request.
    const attemptLike = {
      submittedText: PAYLOAD,
      displayText: PAYLOAD,
      payloadSnapshot: { text: PAYLOAD },
      text: PAYLOAD,
    };
    const base: ChatInputDeliveryOutcomeFacts = {
      ...attemptLike,
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      provider: 'codex',
      attemptId: 'attempt',
      generation: 'generation',
      origin: 'typed',
      outcome: 'picked-up',
      createdAt: 0,
      pickedUpAt: 5,
      nowMs: 0,
    };
    const error = new Error(PAYLOAD, { cause: PAYLOAD });
    error.name = PAYLOAD;
    error.stack = PAYLOAD;
    const cases: ChatInputDeliveryOutcomeFacts[] = [
      { ...base, refusal: error, failure: error },
      { ...base, outcome: 'rejected-requeued', refusal: error },
      {
        ...base,
        outcome: 'rejected-final',
        refusal: { code: 'no-active-turn', summary: PAYLOAD },
      },
      { ...base, outcome: 'unknown-transport', failure: error },
      {
        ...base,
        outcome: 'unknown-timeout',
        failure: {
          code: 'delivery-deadline',
          class: 'timeout',
          summary: PAYLOAD,
        },
      },
    ];

    const records: SessionDiagnosticRecord[] = [];
    for (const facts of cases) {
      recordChatInputDeliveryOutcome(facts, (record) => records.push(record));
    }

    expect(records).toHaveLength(cases.length);
    for (const record of records) {
      expect(JSON.stringify(record)).not.toContain(PAYLOAD);
    }
    expect(
      records.map((record) => [
        record.inputErrorClass,
        record.inputErrorCode,
        record.inputErrorSummary,
      ]),
    ).toEqual([
      [undefined, undefined, undefined],
      ['refusal', undefined, undefined],
      ['refusal', 'no-active-turn', CHAT_INPUT_REFUSALS['no-active-turn']],
      [
        'transport',
        'transport-error',
        CHAT_INPUT_DELIVERY_FAILURES['transport-error'].summary,
      ],
      [
        'timeout',
        'delivery-deadline',
        CHAT_INPUT_DELIVERY_FAILURES['delivery-deadline'].summary,
      ],
    ]);

    const service = {
      recordSessionDiagnostic: jest.fn(),
      recordAppDiagnostic: jest.fn(),
      recordUsageMetricEvent: jest.fn(),
    };
    // Scoped to this case: the default sink imports observability lazily,
    // so registering the mock now leaves earlier static imports untouched.
    jest.doMock('../observability', () => ({
      getObservabilityService: (): typeof service => service,
    }));
    try {
      recordChatInputDeliveryOutcome(cases[4]);
      await new Promise(setImmediate);
    } finally {
      jest.dontMock('../observability');
    }

    expect(service.recordSessionDiagnostic).toHaveBeenCalledTimes(1);
    expect(service.recordSessionDiagnostic).toHaveBeenCalledWith(records[4]);
    expect(service.recordAppDiagnostic).not.toHaveBeenCalled();
    expect(service.recordUsageMetricEvent).not.toHaveBeenCalled();
    // PostHog and app events have no path from this module.
    expect(
      readFileSync(
        path.join(MAIN_ROOT, 'lib', 'chat-input-delivery-diagnostics.ts'),
        'utf8',
      ),
    ).not.toMatch(/posthog|recordAppDiagnostic|recordMainProcessError/i);
  });
});
