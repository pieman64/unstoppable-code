import type {
  ChatEvent,
  ChatStateChange,
  ChatStateChangedEvent,
} from '@canopy/desktop-shared/types';
import type { RendererDiagnosticsSummary } from '@canopy/desktop-shared/types/observability';
import {
  FRAME_SAMPLE_LIMIT,
  RENDERER_DIAGNOSTICS_WINDOW_MS,
  createRendererDiagnosticsAggregator,
  type RendererDiagnosticsAggregator,
  type RendererDiagnosticsInterest,
} from '../aggregator';

const ON = { projectId: 'p', worktreeId: 'w', chatId: 'on' };
const WARM = { projectId: 'p', worktreeId: 'w', chatId: 'warm' };
const INTEREST: RendererDiagnosticsInterest = { focused: [ON], warm: [WARM] };

interface Harness {
  readonly aggregator: RendererDiagnosticsAggregator;
  readonly sent: RendererDiagnosticsSummary[];
  advance(ms: number): void;
  setHidden(hidden: boolean): void;
}

function createHarness(
  options: { remoteWindow?: boolean; random?: () => number } = {},
): Harness {
  let now = 1_000;
  let hidden = false;
  const sent: RendererDiagnosticsSummary[] = [];
  const aggregator = createRendererDiagnosticsAggregator({
    now: () => now,
    isHidden: () => hidden,
    remoteWindow: options.remoteWindow ?? false,
    send: (summary) => sent.push(summary),
    random: options.random,
  });
  return {
    aggregator,
    sent,
    advance: (ms): void => {
      now += ms;
    },
    setHidden: (value): void => {
      hidden = value;
    },
  };
}

function transcriptChange(chatId: string): ChatStateChange {
  return { type: 'message.removed', chatId, messageId: 'm' };
}

function stateEvent(
  changes: ChatStateChange[],
  scope = { projectId: 'p', worktreeId: 'w' },
): ChatStateChangedEvent {
  return {
    schemaVersion: 1,
    eventId: 'e',
    occurredAt: '2026-10-14T00:00:00.000Z',
    projectId: scope.projectId,
    worktreeId: scope.worktreeId,
    baseRevision: 0,
    revision: 1,
    changes,
  };
}

function chatEvent(chatId: string, data: unknown = { type: 'x' }): ChatEvent {
  return { projectId: 'p', worktreeId: 'w', chatId, data };
}

function endWindow(harness: Harness): RendererDiagnosticsSummary | null {
  harness.advance(RENDERER_DIAGNOSTICS_WINDOW_MS);
  return harness.aggregator.flush();
}

describe('renderer diagnostics aggregator', () => {
  it('sends nothing for an empty window', () => {
    const harness = createHarness();
    expect(endWindow(harness)).toBeNull();
    expect(harness.sent).toEqual([]);
  });

  it('sends one summary per window and starts each window empty', () => {
    const harness = createHarness({ remoteWindow: true });
    harness.aggregator.recordChatEvent(chatEvent('on'), 2);
    const first = endWindow(harness);
    expect(first).toEqual({
      windowMs: RENDERER_DIAGNOSTICS_WINDOW_MS,
      remoteWindow: true,
      frames: {
        count: 0,
        p95Ms: 0,
        maxMs: 0,
        blockingMs: 0,
        invokers: { userCallback: 0, eventListener: 0, promise: 0, script: 0 },
      },
      chatState: {
        onScreenChanges: 0,
        offScreenChanges: 0,
        scopeChanges: 0,
        onScreenMessages: 0,
        offScreenMessages: 0,
        mixedMessages: 0,
        onScreenApplyMs: 0,
        offScreenApplyMs: 0,
        mixedApplyMs: 0,
      },
      chatEvent: {
        onScreenEvents: 1,
        offScreenEvents: 0,
        delegationEvents: 0,
        onScreenApplyMs: 2,
        offScreenApplyMs: 0,
        delegationApplyMs: 0,
      },
      terminal: { deliveries: 0, applyMs: 0 },
    });
    expect(endWindow(harness)).toBeNull();
    harness.aggregator.recordChatEvent(chatEvent('on'), 1);
    harness.advance(5_000);
    expect(harness.aggregator.flush()?.windowMs).toBe(5_000);
    expect(harness.sent).toHaveLength(2);
  });

  it('drops a window that ends while the document is hidden', () => {
    const harness = createHarness();
    harness.aggregator.recordChatEvent(chatEvent('on'), 1);
    harness.setHidden(true);
    expect(endWindow(harness)).toBeNull();
    harness.setHidden(false);
    // The hidden window's data does not carry into the next one.
    expect(endWindow(harness)).toBeNull();
    expect(harness.sent).toEqual([]);
  });

  it('drops a window far longer than the timer (a suspended computer)', () => {
    const harness = createHarness();
    harness.aggregator.recordChatEvent(chatEvent('on'), 1);
    harness.advance(10 * 60_000);
    expect(harness.aggregator.flush()).toBeNull();
  });

  it('splits chat events by the window interest and keeps delegation events apart', () => {
    const harness = createHarness();
    harness.aggregator.setInterest(INTEREST);
    harness.aggregator.recordChatEvent(chatEvent('on'), 1);
    harness.aggregator.recordChatEvent(chatEvent('warm'), 2);
    harness.aggregator.recordChatEvent(chatEvent('off'), 4);
    harness.aggregator.recordChatEvent(
      chatEvent('on', { type: 'canopy_delegation', delegation: {} }),
      8,
    );
    harness.aggregator.recordChatEvent(
      chatEvent('off', { type: 'canopy_delegation' }),
      16,
    );
    harness.aggregator.recordChatEvent(chatEvent('on', null), 32);
    expect(endWindow(harness)?.chatEvent).toEqual({
      onScreenEvents: 3,
      offScreenEvents: 1,
      delegationEvents: 2,
      onScreenApplyMs: 35,
      offScreenApplyMs: 4,
      delegationApplyMs: 24,
    });
  });

  it('matches project, worktree and chat for the on-screen split', () => {
    const harness = createHarness();
    harness.aggregator.setInterest(INTEREST);
    harness.aggregator.recordChatEvent(
      { projectId: 'p', worktreeId: 'other', chatId: 'on', data: null },
      1,
    );
    harness.aggregator.recordChatEvent(
      { projectId: 'other', worktreeId: 'w', chatId: 'on', data: null },
      1,
    );
    expect(endWindow(harness)?.chatEvent.offScreenEvents).toBe(2);
  });

  it('counts every chat as on screen while no interest is known', () => {
    const harness = createHarness();
    harness.aggregator.setInterest(INTEREST);
    harness.aggregator.setInterest(null);
    harness.aggregator.recordChatEvent(chatEvent('anything'), 1);
    harness.aggregator.recordChatState(
      stateEvent([transcriptChange('anything')]),
      1,
    );
    const summary = endWindow(harness);
    expect(summary?.chatEvent.onScreenEvents).toBe(1);
    expect(summary?.chatState.onScreenChanges).toBe(1);
  });

  it('counts state changes by chat and buckets each message', () => {
    const harness = createHarness();
    harness.aggregator.setInterest(INTEREST);
    // One message with changes for an on-screen and an off-screen chat.
    harness.aggregator.recordChatState(
      stateEvent([
        transcriptChange('on'),
        transcriptChange('off'),
        { type: 'tab.order_changed', tabIds: [] },
      ]),
      3,
    );
    harness.aggregator.recordChatState(
      stateEvent([transcriptChange('on'), transcriptChange('warm')]),
      5,
    );
    harness.aggregator.recordChatState(
      stateEvent([transcriptChange('off'), transcriptChange('off2')]),
      7,
    );
    // Only scope-level changes: the on-screen bucket.
    harness.aggregator.recordChatState(
      stateEvent([{ type: 'tab.removed', tabId: 't' }]),
      11,
    );
    expect(endWindow(harness)?.chatState).toEqual({
      onScreenChanges: 3,
      offScreenChanges: 3,
      scopeChanges: 2,
      onScreenMessages: 2,
      offScreenMessages: 1,
      mixedMessages: 1,
      onScreenApplyMs: 16,
      offScreenApplyMs: 7,
      mixedApplyMs: 3,
    });
  });

  it('follows interest changes', () => {
    const harness = createHarness();
    harness.aggregator.setInterest(INTEREST);
    harness.aggregator.recordChatEvent(chatEvent('later'), 1);
    harness.aggregator.setInterest({
      focused: [{ projectId: 'p', worktreeId: 'w', chatId: 'later' }],
      warm: [],
    });
    harness.aggregator.recordChatEvent(chatEvent('later'), 1);
    harness.aggregator.recordChatEvent(chatEvent('on'), 1);
    const summary = endWindow(harness);
    expect(summary?.chatEvent.onScreenEvents).toBe(1);
    expect(summary?.chatEvent.offScreenEvents).toBe(2);
  });

  it('counts a terminal delivery once across subscribers and adds their apply time', () => {
    const harness = createHarness();
    harness.aggregator.recordTerminalOutput('t1', 1, 1);
    harness.aggregator.recordTerminalOutput('t1', 1, 2);
    harness.aggregator.recordTerminalOutput('t1', 1, 3);
    harness.aggregator.recordTerminalOutput('t1', 2, 1);
    harness.aggregator.recordTerminalOutput('t2', 2, 1);
    expect(endWindow(harness)?.terminal).toEqual({
      deliveries: 3,
      applyMs: 8,
    });
  });

  it('aggregates long animation frames without attribution', () => {
    const harness = createHarness();
    const entries: unknown[] = [];
    for (let index = 1; index <= 100; index += 1) {
      entries.push({
        entryType: 'long-animation-frame',
        name: 'long-animation-frame',
        duration: index,
        blockingDuration: 1,
        scripts:
          index === 1
            ? [
                { invokerType: 'user-callback', sourceURL: 'secret.js' },
                { invokerType: 'event-listener', invoker: 'BUTTON.onclick' },
                { invokerType: 'resolve-promise' },
                { invokerType: 'reject-promise' },
                { invokerType: 'classic-script' },
                { invokerType: 'module-script' },
                { invokerType: 'unknown' },
                null,
              ]
            : [],
      });
    }
    entries.push(null, 'noise', { name: 'no duration' });
    harness.aggregator.recordFrameEntries(entries);
    const summary = endWindow(harness);
    expect(summary?.frames).toEqual({
      count: 100,
      p95Ms: 95,
      maxMs: 100,
      blockingMs: 100,
      invokers: { userCallback: 1, eventListener: 1, promise: 2, script: 2 },
    });
    expect(JSON.stringify(summary)).not.toMatch(/secret|BUTTON/);
  });

  it('keeps a bounded frame sample and an exact maximum', () => {
    // A `random` of 0.999… never replaces a kept sample, so the sample is
    // the first FRAME_SAMPLE_LIMIT frames: 1..256 ms.
    const harness = createHarness({ random: () => 0.999_999 });
    const total = FRAME_SAMPLE_LIMIT * 4;
    for (let index = 1; index <= total; index += 1) {
      harness.aggregator.recordFrameEntries([
        { duration: index, blockingDuration: 0 },
      ]);
    }
    const summary = endWindow(harness);
    expect(summary?.frames.count).toBe(total);
    expect(summary?.frames.maxMs).toBe(total);
    expect(summary?.frames.p95Ms).toBe(Math.ceil(FRAME_SAMPLE_LIMIT * 0.95));
  });

  it('replaces kept samples so later frames reach the p95', () => {
    // A `random` of 0 always replaces slot 0, which then holds the last frame.
    const harness = createHarness({ random: () => 0 });
    const total = FRAME_SAMPLE_LIMIT + 10;
    for (let index = 1; index <= total; index += 1) {
      harness.aggregator.recordFrameEntries([{ duration: index }]);
    }
    expect(endWindow(harness)?.frames.p95Ms).toBe(
      // Samples are 2..256 plus 266.
      Math.ceil(FRAME_SAMPLE_LIMIT * 0.95) + 1,
    );
  });

  it('keeps every duration within the bounds main accepts', () => {
    const harness = createHarness();
    harness.aggregator.recordFrameEntries([
      { duration: 500_000, blockingDuration: 10_000_000 },
      { duration: Number.NaN, blockingDuration: -5 },
    ]);
    harness.aggregator.recordChatEvent(chatEvent('on'), 10_000_000);
    const summary = endWindow(harness);
    expect(summary?.frames.maxMs).toBe(120_000);
    expect(summary?.frames.p95Ms).toBe(120_000);
    expect(summary?.frames.blockingMs).toBe(
      RENDERER_DIAGNOSTICS_WINDOW_MS * 10,
    );
    expect(summary?.chatEvent.onScreenApplyMs).toBe(
      RENDERER_DIAGNOSTICS_WINDOW_MS * 10,
    );
  });

  it('records a delivery cheaply (prints ns per message)', () => {
    const harness = createHarness();
    harness.aggregator.setInterest(INTEREST);
    const state = stateEvent([transcriptChange('on')]);
    const event = chatEvent('off');
    const iterations = 100_000;
    // Warm up so the measurement is of optimized code.
    for (let index = 0; index < 10_000; index += 1) {
      harness.aggregator.recordChatState(state, 0.1);
    }
    const measure = (record: () => void): number => {
      const startedAt = process.hrtime.bigint();
      for (let index = 0; index < iterations; index += 1) record();
      return Number(process.hrtime.bigint() - startedAt) / iterations;
    };
    const stateNs = measure(() => {
      const startedAt = performance.now();
      harness.aggregator.recordChatState(state, performance.now() - startedAt);
    });
    const eventNs = measure(() => {
      const startedAt = performance.now();
      harness.aggregator.recordChatEvent(event, performance.now() - startedAt);
    });
    const terminalNs = measure(() => {
      const startedAt = performance.now();
      harness.aggregator.recordTerminalOutput(
        't',
        1,
        performance.now() - startedAt,
      );
    });
    // eslint-disable-next-line no-console
    console.log(
      `renderer diagnostics per message (incl. 2x performance.now): ` +
        `chat:state-changed ${stateNs.toFixed(0)} ns, ` +
        `chat:event ${eventNs.toFixed(0)} ns, terminal ${terminalNs.toFixed(0)} ns`,
    );
    // Loose bound only: a regression to per-message work in the
    // microseconds, not a timing assertion.
    expect(Math.max(stateNs, eventNs, terminalNs)).toBeLessThan(20_000);
  });
});
