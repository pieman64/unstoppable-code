import type { ChatInterestDeclaration } from '@canopy/desktop-shared/types';
import type { RemotePushSummary } from '@canopy/desktop-shared/types/observability';
import { createPushForwarder } from '../push-forwarder';
import { RemotePushSummaryAccumulator } from '../push-summary';

const focused: ChatInterestDeclaration = {
  focused: [{ projectId: 'project', worktreeId: 'tree', chatId: 'visible' }],
  warm: [{ projectId: 'project', worktreeId: 'tree', chatId: 'warm' }],
};

function chatEvent(chatId: string): unknown[] {
  return [{ projectId: 'project', worktreeId: 'tree', chatId, data: {} }];
}

function chatState(...chatIds: string[]): unknown[] {
  return [
    {
      projectId: 'project',
      worktreeId: 'tree',
      changes: [
        { type: 'tab.order_changed', tabIds: [] },
        ...chatIds.map((chatId) => ({ type: 'runtime.patched', chatId })),
      ],
    },
  ];
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(0);
});

afterEach(() => {
  jest.useRealTimers();
});

describe('RemotePushSummaryAccumulator', () => {
  it('records channel counts and serialized bytes per 30-second window', () => {
    const records: RemotePushSummary[] = [];
    const getInterest = jest.fn(() => focused);
    const summary = new RemotePushSummaryAccumulator(getInterest, (record) =>
      records.push(record),
    );
    summary.forwarded('chat:state-changed', chatState('visible'), 100);
    summary.forwarded('chat:event', chatEvent('warm'), 200);
    summary.forwarded('terminal:output', [{ text: 'not recorded' }], 300);
    summary.forwarded('auth-terminal:output', [], 40);
    summary.forwarded('other:event', [], 50);
    jest.advanceTimersByTime(30_000);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      windowMs: 30_000,
      chatState: { pushes: 1, bytes: 100 },
      chatEvent: { pushes: 1, bytes: 200 },
      terminal: { pushes: 2, bytes: 340 },
      other: { pushes: 1, bytes: 50 },
    });
    jest.advanceTimersByTime(30_000);
    expect(records).toHaveLength(1);
    summary.close();
  });

  it('splits chat pushes into on, off, and mixed from this session interest', () => {
    const records: RemotePushSummary[] = [];
    const summary = new RemotePushSummaryAccumulator(
      () => focused,
      (record) => records.push(record),
    );
    summary.forwarded('chat:event', chatEvent('visible'), 10);
    summary.forwarded('chat:event', chatEvent('warm'), 20);
    summary.forwarded('chat:event', chatEvent('hidden'), 30);
    summary.forwarded('chat:state-changed', chatState('visible'), 40);
    summary.forwarded('chat:state-changed', chatState('hidden'), 50);
    summary.forwarded('chat:state-changed', chatState('visible', 'hidden'), 60);
    // A state push with only scope-level changes is on screen.
    summary.forwarded('chat:state-changed', chatState(), 70);
    summary.close();
    expect(records[0]).toMatchObject({
      interestDeclared: true,
      chatEvent: {
        pushes: 3,
        bytes: 60,
        onScreenPushes: 2,
        onScreenBytes: 30,
        offScreenPushes: 1,
        offScreenBytes: 30,
      },
      chatState: {
        pushes: 4,
        bytes: 220,
        onScreenPushes: 2,
        onScreenBytes: 110,
        offScreenPushes: 1,
        offScreenBytes: 50,
        mixedPushes: 1,
        mixedBytes: 60,
      },
    });
  });

  it('attributes each surface using its own declaration, including undeclared windows', () => {
    const records: RemotePushSummary[] = [];
    const summary = new RemotePushSummaryAccumulator(
      () => focused,
      (record) => records.push(record),
    );
    summary.forwarded('chat:event', chatEvent('hidden'), 10, {
      focused: [{ projectId: 'project', worktreeId: 'tree', chatId: 'hidden' }],
      warm: [],
    });
    summary.forwarded('chat:event', chatEvent('hidden'), 20, null);
    summary.close();
    expect(records[0]?.chatEvent).toMatchObject({
      pushes: 2,
      bytes: 30,
      onScreenPushes: 1,
      onScreenBytes: 10,
      offScreenPushes: 0,
    });
  });

  it('attributes chat-bearing nested state changes without treating scope changes as off-screen', () => {
    const records: RemotePushSummary[] = [];
    const summary = new RemotePushSummaryAccumulator(
      () => focused,
      (record) => records.push(record),
    );
    summary.forwarded(
      'chat:state-changed',
      [
        {
          projectId: 'project',
          worktreeId: 'tree',
          changes: [
            { type: 'tab.order_changed', tabIds: [] },
            { type: 'tab.upserted', tab: { id: 'hidden' } },
          ],
        },
      ],
      12,
    );
    summary.close();
    expect(records[0]?.chatState).toMatchObject({
      pushes: 1,
      offScreenPushes: 1,
      mixedPushes: 0,
      offScreenBytes: 12,
    });
  });

  it('fills totals only without declared interest and re-reads on the next window', () => {
    const records: RemotePushSummary[] = [];
    let interest: ChatInterestDeclaration | undefined;
    const summary = new RemotePushSummaryAccumulator(
      () => interest,
      (record) => records.push(record),
    );
    summary.forwarded('chat:event', chatEvent('visible'), 10);
    summary.forwarded('chat:state-changed', chatState('hidden'), 20);
    jest.advanceTimersByTime(30_000);
    expect(records[0]).toMatchObject({
      interestDeclared: false,
      chatEvent: {
        pushes: 1,
        bytes: 10,
        onScreenPushes: 0,
        offScreenPushes: 0,
      },
      chatState: {
        pushes: 1,
        bytes: 20,
        onScreenPushes: 0,
        offScreenPushes: 0,
      },
    });
    interest = focused;
    summary.forwarded('chat:event', chatEvent('visible'), 30);
    jest.advanceTimersByTime(30_000);
    interest = { focused: [], warm: [] };
    summary.forwarded('chat:event', chatEvent('visible'), 40);
    summary.close();
    expect(records[1]?.chatEvent).toMatchObject({
      pushes: 1,
      bytes: 30,
      onScreenPushes: 1,
      onScreenBytes: 30,
    });
    expect(records[2]?.chatEvent).toMatchObject({
      pushes: 1,
      bytes: 40,
      offScreenPushes: 1,
      offScreenBytes: 40,
    });
  });

  it('follows a declaration made or changed within a window', () => {
    const records: RemotePushSummary[] = [];
    let interest: ChatInterestDeclaration | undefined;
    const summary = new RemotePushSummaryAccumulator(
      () => interest,
      (record) => records.push(record),
    );
    // Pushes before the controller declares count in totals only.
    summary.forwarded('chat:event', chatEvent('visible'), 10);
    interest = focused;
    summary.forwarded('chat:event', chatEvent('visible'), 20);
    // The controller switches chats before the window ends.
    interest = {
      focused: [{ projectId: 'project', worktreeId: 'tree', chatId: 'other' }],
      warm: [],
    };
    summary.forwarded('chat:event', chatEvent('visible'), 40);
    summary.close();
    expect(records[0]).toMatchObject({
      interestDeclared: true,
      chatEvent: {
        pushes: 3,
        bytes: 70,
        onScreenPushes: 1,
        onScreenBytes: 20,
        offScreenPushes: 1,
        offScreenBytes: 40,
      },
    });
  });

  it('counts broadcast duplicates without forwarding them again', () => {
    const records: RemotePushSummary[] = [];
    const summary = new RemotePushSummaryAccumulator(
      () => focused,
      (record) => records.push(record),
    );
    const forwarder = createPushForwarder(
      (channel, args) => summary.forwarded(channel, args, 23),
      () => undefined,
      undefined,
      () => summary.duplicateDropped(),
    );
    const event = chatEvent('visible');
    forwarder.offer('chat:event', event);
    forwarder.offer('chat:event', event);
    summary.close();
    expect(records[0]).toMatchObject({
      duplicateDrops: 1,
      chatEvent: { pushes: 1, bytes: 23 },
    });
  });

  it('does not record an idle session and flushes a partial window on close', () => {
    const records: RemotePushSummary[] = [];
    const summary = new RemotePushSummaryAccumulator(
      () => undefined,
      (record) => records.push(record),
    );
    jest.advanceTimersByTime(30_000);
    expect(records).toEqual([]);
    summary.forwarded('other:event', [], 14);
    jest.advanceTimersByTime(5_000);
    summary.close();
    summary.forwarded('other:event', [], 99);
    expect(records).toMatchObject([
      { windowMs: 5_000, other: { pushes: 1, bytes: 14 } },
    ]);
    jest.advanceTimersByTime(60_000);
    expect(records).toHaveLength(1);
  });

  it('keeps two concurrent sessions independent', () => {
    const first: RemotePushSummary[] = [];
    const second: RemotePushSummary[] = [];
    const a = new RemotePushSummaryAccumulator(
      () => focused,
      (record) => first.push(record),
    );
    const b = new RemotePushSummaryAccumulator(
      () => undefined,
      (record) => second.push(record),
    );
    a.forwarded('chat:event', chatEvent('visible'), 10);
    b.forwarded('chat:event', chatEvent('visible'), 20);
    a.duplicateDropped();
    jest.advanceTimersByTime(30_000);
    expect(first[0]).toMatchObject({
      interestDeclared: true,
      duplicateDrops: 1,
      chatEvent: { pushes: 1, bytes: 10, onScreenPushes: 1 },
    });
    expect(second[0]).toMatchObject({
      interestDeclared: false,
      duplicateDrops: 0,
      chatEvent: { pushes: 1, bytes: 20, onScreenPushes: 0 },
    });
    a.close();
    b.close();
  });
});
