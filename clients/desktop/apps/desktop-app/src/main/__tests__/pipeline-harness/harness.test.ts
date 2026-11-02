import type * as ChildProcess from 'node:child_process';
import type { query as claudeQuery } from '@anthropic-ai/claude-agent-sdk';
import type * as DynamicTools from '../../codex/canopy-dynamic-tools';
import type { PersistedChatMessage } from '@canopy/desktop-shared/types';
import type { ChatMigrationEntry } from '../../lib/chat-storage-v2';
import type {
  PipelineChatTarget,
  PipelineHost,
  PipelineHarness,
  PipelineProvider,
  ScriptedProviderDriver,
} from './contracts';
import { createPipelineHarness } from './harness';
import { createScriptedClaude, claudeSdkModuleMock } from './scripted-claude';
import {
  createScriptedCodex,
  codexSpawnModuleMock,
  type ScriptedCodex,
  replayScriptedCodexRootTerminal,
} from './scripted-codex';
import type { PipelineStorage } from './storage';
import { SCENARIO_TEST_TIMEOUT_MS } from './scenarios';

type QueryInput = Parameters<typeof claudeQuery>[0];

interface InlineTurn {
  prompt: string;
  finish(creditRefused?: boolean): void;
}

/** Only the SDK stream is synthetic; the provider and every pipeline layer are real. */
function installInlineClaude(): {
  nextTurn(pump?: () => Promise<void>): Promise<InlineTurn>;
  close(): void;
  turnCount(): number;
  useDriver(driver: ScriptedProviderDriver): void;
} {
  const turns: InlineTurn[] = [];
  const gates = new Set<() => void>();
  let closed = false;
  let consumedTurns = 0;
  let scripted: ScriptedProviderDriver | undefined;
  jest.doMock('@anthropic-ai/claude-agent-sdk', () => ({
    ...jest.requireActual<Record<string, unknown>>(
      '@anthropic-ai/claude-agent-sdk',
    ),
    query: ({ prompt, options }: QueryInput): unknown => {
      if (scripted)
        return claudeSdkModuleMock(scripted).query({ prompt, options });
      if (typeof prompt === 'string')
        throw new Error('Expected a streaming prompt');
      const stream = (async function* (): AsyncGenerator<unknown> {
        let turnNumber = 0;
        for await (const input of prompt) {
          if (closed) return;
          turnNumber += 1;
          consumedTurns += 1;
          const text = JSON.stringify(input.message.content);
          let finish = (): void => undefined;
          const gate = new Promise<void>((resolve) => {
            finish = resolve;
          });
          gates.add(finish);
          let creditRefused = false;
          turns.push({
            prompt: text,
            finish(refused = false): void {
              creditRefused = refused;
              finish();
            },
          });
          // The native SDK emits init for every turn in a reused session.
          yield {
            type: 'system',
            subtype: 'init',
            session_id: 'inline-session',
          };
          yield {
            type: 'assistant',
            uuid: `inline-assistant-${turnNumber}`,
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: `answer ${turnNumber}` }],
            },
          };
          await gate;
          gates.delete(finish);
          if (closed) return;
          yield {
            type: 'result',
            subtype: 'success',
            is_error: creditRefused,
            result: creditRefused
              ? 'API Error: 402 AI Credits are unavailable for this request.'
              : `answer ${turnNumber}`,
            ...(creditRefused
              ? { canopy_ai_credits_no_billing_source: true }
              : {}),
            duration_ms: 0,
            duration_api_ms: 0,
            num_turns: 1,
            total_cost_usd: 0,
            usage: { input_tokens: 1, output_tokens: 1 },
          };
        }
      })();
      options?.abortController?.signal.addEventListener(
        'abort',
        () => {
          for (const release of Array.from(gates)) release();
        },
        { once: true },
      );
      return Object.assign(stream, {
        applyFlagSettings: (): Promise<void> => Promise.resolve(),
        setPermissionMode: (): Promise<void> => Promise.resolve(),
        setModel: (): Promise<void> => Promise.resolve(),
        close: (): void => {
          for (const release of Array.from(gates)) release();
        },
        interrupt: (): Promise<void> => {
          for (const release of Array.from(gates)) release();
          return Promise.resolve();
        },
      });
    },
  }));
  return {
    turnCount: (): number => consumedTurns,
    useDriver(driver): void {
      scripted = driver;
    },
    async nextTurn(pump?: () => Promise<void>): Promise<InlineTurn> {
      for (
        let attempt = 0;
        attempt < 2000 && turns.length === 0;
        attempt += 1
      ) {
        await pump?.();
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      await eventually(() => turns.length > 0, 'provider prompt');
      const turn = turns.shift();
      if (!turn) throw new Error('Missing inline turn');
      return turn;
    },
    close(): void {
      closed = true;
      for (const release of Array.from(gates)) release();
    },
  };
}

// Node's built-in consumers can retain their initial spawn binding across
// resetModules. Keep that binding pointed at the current test's transport.
let activeCodexDriver: (() => ScriptedCodex) | undefined;
function installScriptedCodex(resolveDriver: () => ScriptedCodex): void {
  activeCodexDriver = resolveDriver;
  jest.doMock('node:child_process', () => ({
    ...jest.requireActual<typeof ChildProcess>('node:child_process'),
    spawn: (
      ...args: Parameters<ReturnType<typeof codexSpawnModuleMock>['spawn']>
    ): ReturnType<ReturnType<typeof codexSpawnModuleMock>['spawn']> => {
      if (!activeCodexDriver) throw new Error('No active Codex transport');
      return codexSpawnModuleMock(activeCodexDriver()).spawn(...args);
    },
  }));
}

// Wall-clock bound: a turn budget runs out on a loaded CI shard.
async function eventually(
  predicate: () => boolean,
  label: string,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error(`Pipeline did not reach ${label}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

function targetFor(host: PipelineHost, chatId = 'chat'): PipelineChatTarget {
  return {
    projectId: host === 'app-advisor' ? 'app-advisor' : `pipeline-${host}`,
    worktreeId: 'entry',
    chatId,
  };
}

jest.setTimeout(60_000);

describe('real main-process pipeline harness', () => {
  let harness: PipelineHarness | undefined;
  let inline: ReturnType<typeof installInlineClaude>;
  let scripted: ScriptedProviderDriver | undefined;

  beforeEach(async () => {
    jest.resetModules();
    await import('../../../__tests__/jestElectronLogSetup');
    scripted = undefined;
    inline = installInlineClaude();
  });
  afterEach(async () => {
    inline.close();
    await scripted?.dispose();
    const active = harness;
    harness = undefined;
    await active?.dispose();
  });

  it.each(['desktop', 'portal'] as const)(
    'CAN-4450 retries a %s credit-refused queued original at the SDK input boundary once',
    async (origin) => {
      let funded = false;
      harness = await createPipelineHarness({
        readCreditFunding: () => Promise.resolve(funded),
      });
      const target = targetFor('worktree');
      harness.registerChat(target, {
        captureRows: true,
        captureTranscript: 'revision',
      });
      const host = await harness.host('worktree', 'claude', target);
      const { getChatQueueService } =
        await import('../../services/chat-queue-service');
      const queue = getChatQueueService();
      await host.send({
        text: '[Canopy-Mock-Request:starter] Prepare.',
        userMessageId: 'starter',
      });
      const starter = await inline.nextTurn();
      const prompt = '[Canopy-Mock-Request:original] Summarize this project.';
      const { buildExistingTabDispatchOptions } =
        await import('../../services/chat-service');
      const request = {
        ...(await buildExistingTabDispatchOptions(
          target.projectId,
          target.worktreeId,
          target.chatId,
        )),
        ...target,
        text: prompt,
        userMessageId: 'original',
        initiationSource: 'user' as const,
      };
      await queue.submit(request, origin);
      const row = queue.getWorktreeSnapshots(
        target.projectId,
        target.worktreeId,
      )[0]?.queue[0];
      if (!row) throw new Error('Original was not queued behind starter');
      starter.finish();
      await host.drain();
      await harness.advanceLogicalClock(500);
      const refused = await inline.nextTurn(() => host.drain());
      expect(refused.prompt).toContain(prompt);
      refused.finish(true);
      await host.drain();
      await harness.advanceLogicalClock(500);
      expect(
        queue.getWorktreeSnapshots(target.projectId, target.worktreeId)[0]
          ?.queue[0],
      ).toMatchObject({
        id: row.id,
        supersedesUserMessageId: 'original',
        retryBlockedReason: 'insufficient_credits',
      });
      expect(inline.turnCount()).toBe(2);
      funded = true;
      await queue.refreshCreditHolds();
      await harness.advanceLogicalClock(5000);
      expect(inline.turnCount()).toBe(2);
      const results = await Promise.all([
        queue.force(target, row.id),
        queue.force(target, row.id),
      ]);
      expect(results.filter((result) => result === 'applied')).toHaveLength(1);
      await host.drain();
      const retried = await inline.nextTurn(() => host.drain());
      expect(retried.prompt).toContain(prompt);
      expect(inline.turnCount()).toBe(3);
      retried.finish();
      await eventually(() => !queue.isTurnActive(target), 'retry completion');
      await host.drain();
      await harness.advanceLogicalClock(5000);
      expect(inline.turnCount()).toBe(3);
      const { getChatStateService } =
        await import('../../services/chat-state-service');
      const state = await getChatStateService().getState(target);
      expect(
        state.tabsFile.tabs
          .find((tab) => tab.id === target.chatId)
          ?.messages.filter((message) => message.id === 'original'),
      ).toEqual([
        expect.objectContaining({ blocks: [{ type: 'text', text: prompt }] }),
      ]);
      expect(
        queue
          .getWorktreeSnapshots(target.projectId, target.worktreeId)
          .flatMap((snapshot) => snapshot.queue),
      ).toEqual([]);
      expect(queue.isTurnActive(target)).toBe(false);
      expect(
        harness.recorder.events.filter(
          (event) =>
            event.kind === 'effect' && event.effect.name === 'session-created',
        ),
      ).toHaveLength(1);
      if (origin === 'desktop') {
        // Only the explicitly funded credit hold permits reusing an accepted id.
        await queue.submit(request, origin);
        await host.drain();
        expect(inline.turnCount()).toBe(3);
      }
    },
  );

  it('prepares seeded storage before the harness loads a chat scope', async () => {
    const target = targetFor('worktree');
    let preparedStorage: PipelineStorage | undefined;
    const seededRows: PersistedChatMessage[] = Array.from(
      { length: 3 },
      (_, index) => ({
        id: `seed-message-${index}`,
        role: 'assistant',
        timestamp: 1_792_000_000_000 + index,
        blocks: [{ type: 'text', text: `seed row ${index}` }],
      }),
    );

    harness = await createPipelineHarness({
      prepareStorage: async (storage) => {
        preparedStorage = storage;
        const { ChatStorageV2 } = await import('../../lib/chat-storage-v2');
        await ChatStorageV2.fromLegacyPaths(storage.pathsFor(target)).migrate(
          () =>
            Promise.resolve({
              revision: 0,
              index: {
                activeTabId: target.chatId,
                runtimeByChatId: {},
              },
              recovery: {
                receipts: [],
                mutationIds: [],
                removedTabIds: [],
                removedArchiveEntryIds: [],
                removedMessageIds: [],
              },
              chats: (async function* (): AsyncGenerator<ChatMigrationEntry> {
                yield await Promise.resolve({
                  metadata: {
                    id: target.chatId,
                    title: 'Seeded pipeline chat',
                    createdAt: '2026-10-17T00:00:00.000Z',
                    providerType: 'claude',
                  },
                  messages:
                    (async function* (): AsyncGenerator<PersistedChatMessage> {
                      for (const row of seededRows) {
                        yield await Promise.resolve(row);
                      }
                    })(),
                });
              })(),
            }),
        );
      },
    });
    harness.registerChat(target, {
      captureRows: true,
      captureTranscript: 'revision',
    });

    if (!preparedStorage) throw new Error('Harness storage was not prepared');
    const state = await preparedStorage.repository.getState(
      { projectId: target.projectId, worktreeId: target.worktreeId },
      { chatIds: [target.chatId], fullTranscript: true },
    );

    const seededTab = state.tabsFile.tabs.find(
      (tab) => tab.id === target.chatId,
    );
    expect(seededTab?.messages.map((message) => message.id)).toEqual(
      seededRows.map((message) => message.id),
    );
  });

  it.each<PipelineProvider>(['claude', 'codex'])(
    'records every %s chat turn lifecycle observation in the trace',
    async (provider) => {
      const driverRef: { current?: ScriptedCodex } = {};
      if (provider === 'codex') {
        // Install before the harness imports the runtime and captures spawn.
        installScriptedCodex(() => {
          if (!driverRef.current)
            throw new Error('Missing lifecycle trace Codex driver');
          return driverRef.current;
        });
      }
      harness = await createPipelineHarness();
      const target = targetFor('worktree');
      if (provider === 'claude') {
        scripted = createScriptedClaude(harness.recorder, {
          target,
          emulateRootReceipt: true,
        });
        inline.useDriver(scripted);
      } else {
        const driver = createScriptedCodex(harness.recorder, { target });
        driverRef.current = driver;
        scripted = driver;
      }

      harness.registerChat(target, {
        captureRows: true,
        captureTranscript: 'revision',
      });
      const host = await harness.host('worktree', provider, target);
      const sending = host.send({ text: 'ordinary lifecycle trace root' });
      if (!scripted) throw new Error('Lifecycle trace driver was not created');
      const turn = await scripted.nextTurn({ timeoutMs: 15_000 });
      await sending;
      await turn.emitText('ordinary lifecycle trace response');
      await turn.complete();
      await host.drain();
      await harness.advanceLogicalClock(5001);
      await new Promise<void>((resolve) => setImmediate(resolve));

      const lifecycleEvents = harness.recorder.events.filter(
        (event) => Reflect.get(event, 'kind') === 'turn-lifecycle',
      );
      expect(lifecycleEvents).not.toHaveLength(0);
      expect(lifecycleEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'turn-lifecycle', target }),
        ]),
      );
    },
  );

  it.each<PipelineHost>(['worktree', 'cowork', 'app-advisor'])(
    '%s runs a user turn and then a headless queued watcher follow-up',
    async (kind) => {
      harness = await createPipelineHarness();
      const target = targetFor(kind);
      harness.registerChat(target, {
        captureRows: true,
        captureTranscript: 'checkpoint',
      });
      const host = await harness.host(kind, 'claude', target);
      const sent = await host.send({
        text: 'root prompt',
        userMessageId: 'root-user',
      });
      expect(sent.userMessageId).toBeTruthy();
      const first = await inline.nextTurn();
      expect(first.prompt).toContain('root prompt');
      await harness.checkpoint('active', target);
      await host.deliverGenerated({
        kind: 'watcher',
        text: 'watcher follow-up',
        watcherId: 'watcher',
        deliveryId: 'delivery-1',
      });
      expect(
        harness.recorder.events.some(
          (event) => event.kind === 'queue' && event.event.queue.length > 0,
        ),
      ).toBe(true);
      first.finish();
      await host.drain();
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await harness.advanceLogicalClock(100);
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      const clock = harness;
      const followup = await inline
        .nextTurn(async () => {
          await clock.advanceLogicalClock(50);
          await host.drain();
        })
        .catch((error: unknown) => {
          throw new Error(
            `${String(error)}; trace: ${JSON.stringify(clock.recorder.events.slice(-12))}`,
          );
        });
      expect(followup.prompt).toContain('watcher follow-up');
      followup.finish();
      await host.drain();
      await harness.checkpoint('drained', target);
      const events = harness.recorder.events;
      const revisions = events.filter((event) => event.kind === 'revision');
      expect(JSON.stringify(revisions)).toContain('root prompt');
      expect(JSON.stringify(revisions)).toContain('answer 1');
      expect(
        revisions.some((event) =>
          Object.prototype.hasOwnProperty.call(
            event.chats[target.chatId],
            'inputDelivery',
          ),
        ),
      ).toBe(true);
      expect(
        events.some(
          (event) =>
            event.kind === 'effect' && event.effect.name === 'session-created',
        ),
      ).toBe(true);
      expect(
        events.some(
          (event) =>
            event.kind === 'transcript' &&
            event.committedBytes > 0 &&
            /^[a-f0-9]{64}$/.test(event.sha256),
        ),
      ).toBe(true);
      const transcripts = events.filter((event) => event.kind === 'transcript');
      expect(transcripts.length).toBeGreaterThanOrEqual(2);
      expect(
        transcripts
          .filter((event) => event.previous)
          .every(
            (event) => event.previous?.prefixSha256 === event.previous?.sha256,
          ),
      ).toBe(true);
      expect(
        events.find(
          (event) => event.kind === 'checkpoint' && event.label === 'active',
        ),
      ).toMatchObject({
        liveness: { foreground: true },
        sessionTurnActive: true,
        queueTurnActive: true,
      });
      expect(events.every((event, index) => event.seq === index + 1)).toBe(
        true,
      );
      expect(revisions.every((event) => Object.isFrozen(event.chats))).toBe(
        true,
      );
    },
  );

  it('records a native task tool-use id when the task metadata catches up', async () => {
    harness = await createPipelineHarness();
    const target = targetFor('worktree');
    scripted = createScriptedClaude(harness.recorder, { target });
    inline.useDriver(scripted);
    harness.registerChat(target, {
      captureRows: true,
      captureTranscript: 'revision',
    });
    const host = await harness.host('worktree', 'claude', target);
    const sending = host.send({ text: 'native task root' });
    const turn = await scripted.nextTurn();

    await turn.startNativeTask({
      taskId: 'child-task',
      toolUseId: 'child-tool',
      kind: 'agent',
    });
    await host.drain();

    expect(
      harness.recorder.events.some(
        (event) =>
          event.kind === 'effect' &&
          event.effect.name === 'native-task-live' &&
          event.effect.taskId === 'child-task' &&
          event.effect.toolUseId === 'child-tool',
      ),
    ).toBe(true);

    await turn.endNativeTask('child-task');
    await turn.complete();
    await sending;
    await host.drain();
  });

  it('runs a Codex dynamic tool on a full-access tab without prompting', async () => {
    let dynamicToolResult:
      | Awaited<ReturnType<typeof DynamicTools.handleCanopyDynamicToolCall>>
      | undefined;
    const { CANOPY_INJECTED_TOOL_REGISTRY } =
      await import('@canopy/desktop-shared/lib/canopy-injected-tools');
    jest.doMock('../../codex/canopy-dynamic-tools', () => {
      const actual = jest.requireActual<typeof DynamicTools>(
        '../../codex/canopy-dynamic-tools',
      );
      return {
        ...actual,
        handleCanopyDynamicToolCall: async (
          ...args: Parameters<typeof actual.handleCanopyDynamicToolCall>
        ): Promise<
          Awaited<ReturnType<typeof actual.handleCanopyDynamicToolCall>>
        > => {
          const result = await actual.handleCanopyDynamicToolCall(...args);
          if (
            args[0].tool ===
            CANOPY_INJECTED_TOOL_REGISTRY.search_actions.codexToolName
          )
            dynamicToolResult = result;
          return result;
        },
      };
    });

    const codexDriverRef: { current: ScriptedCodex | undefined } = {
      current: undefined,
    };
    installScriptedCodex(() => {
      const driver = codexDriverRef.current;
      if (!driver) throw new Error('Codex driver was not initialized');
      return driver;
    });
    harness = await createPipelineHarness();
    const target = targetFor('worktree');
    const codexDriver = createScriptedCodex(harness.recorder, { target });
    codexDriverRef.current = codexDriver;
    scripted = codexDriver;
    harness.registerChat(target, {
      captureRows: true,
      captureTranscript: 'revision',
    });
    const host = await harness.host('worktree', 'codex', target);
    const { getChatStateService } =
      await import('../../services/chat-state-service');
    await getChatStateService().command({
      schemaVersion: 1,
      commandId: 'codex-full-access',
      ...target,
      command: {
        type: 'chat.set_approval_mode',
        tabId: target.chatId,
        approvalMode: 'full-access',
      },
    });

    const sending = host.send({ text: 'run a dynamic tool' });
    const turn = await scripted.nextTurn().catch((error: unknown) => {
      throw new Error(
        `${String(error)}; trace: ${JSON.stringify(harness?.recorder.events.slice(-12))}`,
      );
    });
    await sending;
    await turn.emitToolCall({
      callId: 'full-access-tool-call',
      name: CANOPY_INJECTED_TOOL_REGISTRY.search_actions.codexToolName,
      input: { query: 'pipeline' },
    });
    await eventually(
      () => dynamicToolResult !== undefined,
      'full-access dynamic tool dispatch',
    );
    expect(dynamicToolResult).toMatchObject({ success: true });
    await turn.emitToolResult('full-access-tool-call', 'tool completed');
    await turn.complete();
    await host.drain();
    expect(
      harness.recorder.events.filter(
        (event) =>
          event.kind === 'provider' &&
          event.provider === 'codex' &&
          event.direction === 'to-canopy' &&
          event.type === 'request:item/tool/call' &&
          event.ids?.callId === 'full-access-tool-call',
      ),
    ).toHaveLength(1);
  });

  it(
    'taps native refusal diagnostics without diagnosing admitted frames',
    async () => {
      const driverRef: { current?: ScriptedCodex } = {};
      installScriptedCodex(() => {
        if (!driverRef.current) throw new Error('Missing diagnostic driver');
        return driverRef.current;
      });
      harness = await createPipelineHarness();
      const target = targetFor('worktree');
      const driver = createScriptedCodex(harness.recorder, { target });
      driverRef.current = driver;
      scripted = driver;
      harness.registerChat(target, {
        captureRows: true,
        captureTranscript: 'revision',
      });
      const host = await harness.host('worktree', 'codex', target);
      // Synthetic stream: ordinary admitted output followed by a duplicate root terminal.
      const sending = host.send({ text: 'diagnostic admission root' });
      const turn = await driver.nextTurn({ timeoutMs: 5000 });
      await sending;
      await turn.emitText('diagnostic admitted output');
      await host.drain();
      expect(harness.dropDiagnostics).toEqual([]);
      expect(harness.dropDiagnosticCalls).toEqual([]);
      await turn.complete();
      await host.drain();
      // The provider's convenience result can itself be refused after the
      // native terminal. Isolate the intentionally replayed native envelope.
      const beforeReplay = harness.dropDiagnostics.length;
      const callsBeforeReplay = harness.dropDiagnosticCalls.length;
      await replayScriptedCodexRootTerminal(driver, turn.turnKey);
      for (
        let elapsed = 0;
        harness.dropDiagnostics.length === beforeReplay && elapsed < 2000;
        elapsed += 25
      ) {
        await harness.advanceLogicalClock(25);
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      const replayDiagnostics = harness.dropDiagnostics.slice(beforeReplay);
      expect(replayDiagnostics).toEqual([
        expect.objectContaining({
          kind: 'chat_event_dropped',
          chatEventDropGate: 'codex_root_completion_stale',
          chatEventDropReason: 'no_active_turn',
          providerTurnId: turn.turnKey,
          eventType: 'turn/completed',
        }),
      ]);
      expect(replayDiagnostics[0]?.providerThreadId).toBeTruthy();
      expect(harness.dropDiagnosticCalls.slice(callsBeforeReplay)).toEqual([
        expect.objectContaining({
          gate: 'codex_root_completion_stale',
          reason: 'no_active_turn',
          providerThreadId: replayDiagnostics[0]?.providerThreadId,
          providerTurnId: turn.turnKey,
        }),
      ]);
    },
    SCENARIO_TEST_TIMEOUT_MS,
  );

  it('records the destruction and creation for a model-triggered session replacement', async () => {
    harness = await createPipelineHarness();
    const target = targetFor('worktree');
    scripted = createScriptedClaude(harness.recorder, { target });
    inline.useDriver(scripted);
    harness.registerChat(target, {
      captureRows: true,
      captureTranscript: 'revision',
    });
    const host = await harness.host('worktree', 'claude', target);

    const firstSending = host.send({ text: 'first model turn' });
    const first = await scripted.nextTurn();
    await firstSending;
    await first.complete();
    await host.drain();

    await host.changeSettings({ model: 'claude-sonnet-4-5' });
    const nextSending = host.send({ text: 'turn after model change' });
    const next = await scripted.nextTurn();
    expect(next.prompt).toContain('turn after model change');
    await nextSending;
    await next.complete();
    await host.drain();

    const lifecycle = harness.recorder.events.filter(
      (event) =>
        event.kind === 'effect' &&
        event.target?.chatId === target.chatId &&
        (event.effect.name === 'session-created' ||
          event.effect.name === 'session-destroyed'),
    );
    expect(
      lifecycle.map((event) => {
        if (event.kind !== 'effect')
          throw new Error('Expected a lifecycle effect');
        return event.effect.name;
      }),
    ).toEqual(['session-created', 'session-destroyed', 'session-created']);
    expect(lifecycle[1]).toMatchObject({ target });
    expect(lifecycle[2]).toMatchObject({ target });
  });

  it('captures the real input-delivery ledger after a refused generated steer', async () => {
    harness = await createPipelineHarness();
    const target = targetFor('worktree');
    scripted = createScriptedClaude(harness.recorder, { target });
    inline.useDriver(scripted);
    harness.registerChat(target, {
      captureRows: true,
      captureTranscript: 'revision',
    });
    const host = await harness.host('worktree', 'claude', target);
    const sending = host.send({ text: 'steer root' });
    const turn = await scripted.nextTurn();
    await turn.emitText('root assistant');
    await sending;
    await host.drain();
    const delivery = host.deliverGenerated({
      kind: 'watcher',
      text: 'refused follow-up',
      watcherId: 'watcher',
      deliveryId: 'refused-delivery',
    });
    const steer = await turn.nextSteer();
    expect(steer.text).toContain('refused follow-up');
    await steer.refuse();
    await delivery;
    await host.drain();
    const revisions = harness.recorder.events.filter(
      (event) => event.kind === 'revision',
    );
    expect(
      revisions.some(
        (event) =>
          (event.chats[target.chatId]?.inputDelivery?.rows.length ?? 0) > 0,
      ),
    ).toBe(true);
    expect(
      harness.recorder.events.some(
        (event) =>
          event.kind === 'effect' &&
          event.effect.name === 'steer-settled' &&
          event.effect.outcome === 'refused',
      ),
    ).toBe(true);
    await turn.complete();
    await host.drain();
    await harness.advanceLogicalClock(0);
    await host.drain();
    const followup = await scripted.nextTurn();
    expect(followup.prompt).toContain('refused follow-up');
    expect(
      harness.recorder.events.filter(
        (event) =>
          event.kind === 'provider' &&
          event.direction === 'to-provider' &&
          event.type === 'prompt' &&
          event.turnKey === followup.turnKey &&
          event.text?.includes('refused follow-up'),
      ),
    ).toHaveLength(1);
    await followup.complete();
    await host.drain();
  });

  it('observes the real watcher registration sink and idempotent retry', async () => {
    harness = await createPipelineHarness();
    const target = targetFor('worktree');
    await harness.host('worktree', 'claude', target);
    const { getAppAdvisorWatcherService } =
      await import('../../app-advisor/watchers');
    const watchers = getAppAdvisorWatcherService();
    const wakeup = {
      kind: 'scheduled_wakeup' as const,
      delaySeconds: 60,
      scheduledFor: '',
    };
    const first = await watchers.createLocalWatcher(
      wakeup,
      target,
      'wake-call',
    );
    const retry = await watchers.createLocalWatcher(
      wakeup,
      target,
      'wake-call',
    );
    expect(retry.id).toBe(first.id);
    const registrations = harness.recorder.events
      .filter((event) => event.kind === 'effect')
      .map((event) => event.effect)
      .filter((effect) => effect.name === 'watcher-registered');
    expect(registrations.map((effect) => effect.created)).toEqual([
      true,
      false,
    ]);
    expect(registrations[0]?.naturalKey).toBe(registrations[1]?.naturalKey);
    expect(
      harness.recorder.events.filter(
        (event) =>
          event.kind === 'effect' && event.effect.name === 'tool-side-effect',
      ),
    ).toHaveLength(1);
    const controller = new AbortController();
    controller.abort();
    await expect(
      watchers.createLocalWatcher(
        wakeup,
        target,
        'aborted-call',
        undefined,
        undefined,
        {
          signal: controller.signal,
        },
      ),
    ).rejects.toThrow(/aborted/);
    expect(
      harness.recorder.events.some(
        (event) =>
          event.kind === 'effect' &&
          'callId' in event.effect &&
          event.effect.callId === 'aborted-call',
      ),
    ).toBe(false);
  });

  it('captures metadata for both tabs without touching an unselected transcript getter', async () => {
    harness = await createPipelineHarness();
    const first = targetFor('worktree', 'first');
    const second = targetFor('worktree', 'second');
    for (const target of [first, second]) {
      harness.registerChat(target, {
        captureRows: true,
        captureTranscript: 'off',
      });
      await harness.host('worktree', 'claude', target);
    }
    const { getChatStateService } =
      await import('../../services/chat-state-service');
    await getChatStateService().command({
      schemaVersion: 1,
      commandId: 'select-first',
      ...first,
      command: {
        type: 'chat.commit_terminal_initial_prompt',
        chatId: first.chatId,
        userMessageId: 'selected-user',
        turnTimerMessageId: 'selected-timer',
        text: 'selected transcript prompt',
      },
    });
    const revisions = harness.recorder.events.filter(
      (event) => event.kind === 'revision',
    );
    expect(
      revisions.some(
        (event) =>
          event.chats[first.chatId]?.rows !== undefined &&
          event.chats[second.chatId]?.rows === undefined &&
          second.chatId in event.chats,
      ),
    ).toBe(true);
  });

  it('contains a throwing tap, preserves publication and reports it from dispose', async () => {
    harness = await createPipelineHarness({
      tap: (event) => {
        if (event.kind === 'revision')
          throw new Error('deliberate trace tap failure');
      },
    });
    const target = targetFor('worktree');
    harness.registerChat(target, {
      captureRows: true,
      captureTranscript: 'off',
    });
    await harness.host('worktree', 'claude', target);
    const { getChatStateService } =
      await import('../../services/chat-state-service');
    let published = 0;
    const unsubscribe = getChatStateService().subscribe(() => {
      published += 1;
    });
    await getChatStateService().command({
      schemaVersion: 1,
      commandId: 'publish-with-failed-tap',
      ...target,
      command: {
        type: 'chat.patch_tab_settings',
        tabId: target.chatId,
        patch: { planMode: true },
      },
    });
    unsubscribe();
    expect(published).toBeGreaterThan(0);
    const active = harness;
    harness = undefined;
    await expect(active.dispose()).rejects.toThrow(
      /deliberate trace tap failure/,
    );
  });

  it('holds durable commits until released', async () => {
    harness = await createPipelineHarness({ now: 1234 });
    await harness.checkpoint('clock-start');
    await harness.advanceLogicalClock(37);
    await harness.checkpoint('clock-advanced');
    expect(
      harness.recorder.events
        .filter((event) => event.kind === 'checkpoint')
        .map((event) => event.logicalAt),
    ).toEqual([1234, 1271]);
    const target = targetFor('worktree');
    harness.registerChat(target, {
      captureRows: true,
      captureTranscript: 'off',
    });
    await harness.host('worktree', 'claude', target);
    const { getChatStateService } =
      await import('../../services/chat-state-service');
    const before = harness.recorder.events.filter(
      (event) => event.kind === 'revision',
    ).length;
    harness.holdCommits();
    const command = getChatStateService().command({
      schemaVersion: 1,
      commandId: 'held-setting',
      ...target,
      command: {
        type: 'chat.patch_tab_settings',
        tabId: target.chatId,
        patch: { planMode: true },
      },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(
      harness.recorder.events.filter((event) => event.kind === 'revision'),
    ).toHaveLength(before);
    harness.releaseCommits();
    await command;
    expect(
      harness.recorder.events.filter((event) => event.kind === 'revision')
        .length,
    ).toBeGreaterThan(before);
  });

  it('holds a generated follow-up at the provider-event drain barrier', async () => {
    harness = await createPipelineHarness();
    const target = targetFor('worktree');
    harness.registerChat(target, {
      captureRows: true,
      captureTranscript: 'checkpoint',
    });
    const host = await harness.host('worktree', 'claude', target);
    await host.send({ text: 'barrier root' });
    const first = await inline.nextTurn();
    harness.holdDrainBarrier(target);
    await host.deliverGenerated({
      kind: 'watcher',
      text: 'after barrier',
      deliveryId: 'barrier-delivery',
      watcherId: 'watcher',
    });
    first.finish();
    const { drainCurrentSessionEvents } =
      await import('../../agents/session-event-router');
    await drainCurrentSessionEvents(target);
    await harness.advanceLogicalClock(1000);
    await harness.checkpoint('barrier-held', target);
    expect(inline.turnCount()).toBe(1);
    expect(
      JSON.stringify(
        harness.recorder.events.filter((event) => event.kind === 'revision'),
      ),
    ).not.toContain('answer 2');
    harness.releaseDrainBarrier(target);
    await harness.advanceLogicalClock(1000);
    const clock = harness;
    const second = await inline.nextTurn(async () => {
      await clock.advanceLogicalClock(50);
      await host.drain();
    });
    expect(second.prompt).toContain('after barrier');
    second.finish();
    await host.drain();
  });
});
