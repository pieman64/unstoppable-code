import {
  type ProviderRunGeneration,
  type ProviderRunHandle,
  attachProviderRunEvent,
  classifyProviderRunEvent,
  copyProviderRunProvenance,
  createProviderRunGeneration,
  getProviderRunDescriptor,
  observeProviderRunItem,
  pinProviderRun,
  registerProviderRun,
  retireProviderRunGeneration,
  settleProviderRun,
  unpinProviderRun,
} from '../provider-run-reconciliation';

const scope = { projectId: 'project', worktreeId: 'worktree', chatId: 'chat' };
const identity = {
  threadId: 'thread',
  turnId: 'turn',
  executionUserMessageId: 'prompt',
  origin: 'dispatched' as const,
};
interface CompletionEvent {
  type: string;
  event: {
    type: string;
    thread_id: string;
    turn_id: string;
    item: { type: string; id: string; aggregated_output: string };
  };
}
function completion(
  turnId = 'turn',
  threadId = 'thread',
  id = 'item',
): CompletionEvent {
  return {
    type: 'codex',
    event: {
      type: 'item.completed',
      thread_id: threadId,
      turn_id: turnId,
      item: { type: 'command_execution', id, aggregated_output: 'exact' },
    },
  };
}
function fixture(): {
  generation: ProviderRunGeneration;
  run: ProviderRunHandle;
} {
  const generation = createProviderRunGeneration(scope);
  const run = registerProviderRun(generation, identity);
  observeProviderRunItem(run, 'item', 'command_execution');
  return { generation, run };
}

describe('trusted provider run classification', () => {
  it('keeps receipt-time phase immutable across terminal settlement', () => {
    const { run } = fixture();
    const running = attachProviderRunEvent(completion(), run, 'running');
    settleProviderRun(run);
    const late = attachProviderRunEvent(completion(), run, 'late');
    expect(classifyProviderRunEvent(running, scope).kind).toBe('ordinary');
    expect(classifyProviderRunEvent(late, scope).kind).toBe('transcript_only');
    expect(getProviderRunDescriptor(running)?.phase).toBe('running');
  });
  it('does not trust payload-shaped provenance or a JSON clone', () => {
    const { run } = fixture();
    settleProviderRun(run);
    const event = attachProviderRunEvent(completion(), run, 'late');
    expect(
      classifyProviderRunEvent(JSON.parse(JSON.stringify(event))).kind,
    ).toBe('ordinary');
    const clone = copyProviderRunProvenance(event, { ...event });
    expect(classifyProviderRunEvent(clone, scope).kind).toBe('transcript_only');
  });
  it('keeps already emitted running output ordinary after retirement, without new authority', () => {
    const { generation, run } = fixture();
    const event = attachProviderRunEvent(completion(), run, 'running');
    const classified = classifyProviderRunEvent(event, scope);
    expect(classified.kind).toBe('ordinary');
    if (classified.kind === 'ordinary') {
      expect(classified.run?.executionUserMessageId).toBe('prompt');
    }
    retireProviderRunGeneration(generation);
    expect(classifyProviderRunEvent(event, scope)).toEqual({
      kind: 'ordinary',
      reason: 'retired_generation',
    });
    expect(getProviderRunDescriptor(event)?.executionUserMessageId).toBe(
      'prompt',
    );
  });
  it('keeps running mismatch and derived auth events on ordinary admission', () => {
    const { run } = fixture();
    const nativeMismatch = attachProviderRunEvent(
      completion('other-turn'),
      run,
      'running',
    );
    expect(classifyProviderRunEvent(nativeMismatch)).toEqual({
      kind: 'ordinary',
      reason: 'native_run_mismatch',
    });
    const stampMismatch = attachProviderRunEvent(
      { ...completion(), canopy_turn_user_message_id: 'other-prompt' },
      run,
      'running',
    );
    expect(classifyProviderRunEvent(stampMismatch)).toEqual({
      kind: 'ordinary',
      reason: 'run_stamp_mismatch',
    });
    const running = attachProviderRunEvent(completion(), run, 'running');
    expect(
      classifyProviderRunEvent(running, { ...scope, chatId: 'other-chat' }),
    ).toEqual({ kind: 'ordinary', reason: 'run_scope_mismatch' });
    const auth = copyProviderRunProvenance(running, {
      type: 'canopy_auth_failure',
    });
    expect(classifyProviderRunEvent(auth)).toEqual({
      kind: 'ordinary',
      reason: 'native_run_mismatch',
    });
  });
  it('rejects the queued event after transport replacement', () => {
    const { generation, run } = fixture();
    settleProviderRun(run);
    const event = attachProviderRunEvent(completion(), run, 'late');
    retireProviderRunGeneration(generation);
    expect(classifyProviderRunEvent(event, scope)).toMatchObject({
      kind: 'reject',
      reason: 'retired_generation',
    });
  });
  it.each([
    ['foreign turn', 'other', 'thread', 'item'],
    ['foreign thread', 'turn', 'other', 'item'],
    ['unknown item', 'turn', 'thread', 'unknown'],
  ])('rejects %s', (_name, turn, thread, item) => {
    const { run } = fixture();
    settleProviderRun(run);
    expect(
      classifyProviderRunEvent(
        attachProviderRunEvent(completion(turn, thread, item), run, 'late'),
        scope,
      ).kind,
    ).toBe('reject');
  });
  it('evicts settled provenance without evicting a live run', () => {
    const generation = createProviderRunGeneration(scope);
    const live = registerProviderRun(generation, {
      ...identity,
      turnId: 'live',
    });
    const liveEvent = attachProviderRunEvent(
      {
        type: 'codex',
        event: { type: 'turn.started', thread_id: 'thread', turn_id: 'live' },
      },
      live,
      'running',
    );
    let first: object | undefined;
    let firstRunning: object | undefined;
    for (let i = 0; i < 70; i += 1) {
      const run = registerProviderRun(generation, {
        ...identity,
        turnId: `settled-${i}`,
      });
      observeProviderRunItem(run, 'item', 'command_execution');
      settleProviderRun(run);
      const event = attachProviderRunEvent(
        completion(`settled-${i}`),
        run,
        'late',
      );
      if (i === 0) {
        first = event;
        firstRunning = attachProviderRunEvent(
          completion(`settled-${i}`),
          run,
          'running',
        );
      }
    }
    expect(classifyProviderRunEvent(first).kind).toBe('reject');
    expect(classifyProviderRunEvent(firstRunning)).toEqual({
      kind: 'ordinary',
      reason: 'unknown_run',
    });
    expect(classifyProviderRunEvent(liveEvent).kind).toBe('ordinary');
  });
  it('preserves pinned late command authority beyond the 64-settled-run budget', () => {
    const generation = createProviderRunGeneration(scope);
    const ordinaryRun = registerProviderRun(generation, {
      ...identity,
      turnId: 'ordinary',
    });
    observeProviderRunItem(ordinaryRun, 'ordinary-item', 'command_execution');
    settleProviderRun(ordinaryRun);
    const ordinaryLate = attachProviderRunEvent(
      completion('ordinary', 'thread', 'ordinary-item'),
      ordinaryRun,
      'late',
    );
    const protectedRun = registerProviderRun(generation, {
      ...identity,
      turnId: 'protected',
    });
    observeProviderRunItem(protectedRun, 'protected-item', 'command_execution');
    pinProviderRun(protectedRun);
    settleProviderRun(protectedRun);
    const protectedLate = attachProviderRunEvent(
      completion('protected', 'thread', 'protected-item'),
      protectedRun,
      'late',
    );

    for (let i = 0; i < 65; i += 1) {
      const run = registerProviderRun(generation, {
        ...identity,
        turnId: `newer-${i}`,
      });
      observeProviderRunItem(run, `item-${i}`, 'command_execution');
      settleProviderRun(run);
    }

    expect(classifyProviderRunEvent(protectedLate, scope)).toMatchObject({
      kind: 'transcript_only',
      reason: 'owned_late_command_result',
    });
    expect(classifyProviderRunEvent(ordinaryLate)).toMatchObject({
      kind: 'reject',
      reason: 'unknown_run',
    });
  });
  it('preserves pinned late command authority beyond the 4096-settled-item budget', () => {
    const generation = createProviderRunGeneration(scope);
    const protectedRun = registerProviderRun(generation, {
      ...identity,
      turnId: 'protected-items',
    });
    observeProviderRunItem(protectedRun, 'protected-item', 'command_execution');
    pinProviderRun(protectedRun);
    settleProviderRun(protectedRun);
    const protectedLate = attachProviderRunEvent(
      completion('protected-items', 'thread', 'protected-item'),
      protectedRun,
      'late',
    );

    for (let root = 0; root < 16; root += 1) {
      const run = registerProviderRun(generation, {
        ...identity,
        turnId: `item-budget-${root}`,
      });
      for (let item = 0; item < 256; item += 1) {
        observeProviderRunItem(
          run,
          `item-${root}-${item}`,
          'command_execution',
        );
      }
      settleProviderRun(run);
    }

    expect(classifyProviderRunEvent(protectedLate, scope)).toMatchObject({
      kind: 'transcript_only',
      reason: 'owned_late_command_result',
    });
  });
  it('keeps pinned late authority bound to its original root and prompt stamp', () => {
    const generation = createProviderRunGeneration(scope);
    const oldRun = registerProviderRun(generation, identity);
    observeProviderRunItem(oldRun, 'item', 'command_execution');
    pinProviderRun(oldRun);
    settleProviderRun(oldRun);
    const newerRun = registerProviderRun(generation, {
      ...identity,
      turnId: 'newer-turn',
      executionUserMessageId: 'new-prompt',
    });
    observeProviderRunItem(newerRun, 'newer-item', 'command_execution');
    settleProviderRun(newerRun);

    const newerRootWithOldAuthority = attachProviderRunEvent(
      completion('newer-turn', 'thread', 'item'),
      oldRun,
      'late',
    );
    const oldRootWithNewStamp = attachProviderRunEvent(
      { ...completion(), canopy_turn_user_message_id: 'new-prompt' },
      oldRun,
      'late',
    );

    expect(classifyProviderRunEvent(newerRootWithOldAuthority)).toMatchObject({
      kind: 'reject',
      reason: 'native_run_mismatch',
    });
    expect(classifyProviderRunEvent(oldRootWithNewStamp)).toMatchObject({
      kind: 'reject',
      reason: 'run_stamp_mismatch',
    });
  });
  it('retirement revokes pinned late authority', () => {
    const { generation, run } = fixture();
    pinProviderRun(run);
    settleProviderRun(run);
    const late = attachProviderRunEvent(completion(), run, 'late');
    retireProviderRunGeneration(generation);

    expect(classifyProviderRunEvent(late, scope)).toMatchObject({
      kind: 'reject',
      reason: 'retired_generation',
    });
  });
  it('immediately re-prunes a pinned run when it is unpinned', () => {
    const generation = createProviderRunGeneration(scope);
    const run = registerProviderRun(generation, identity);
    observeProviderRunItem(run, 'item', 'command_execution');
    pinProviderRun(run);
    settleProviderRun(run);
    const late = attachProviderRunEvent(completion(), run, 'late');

    for (let i = 0; i < 65; i += 1) {
      const newerRun = registerProviderRun(generation, {
        ...identity,
        turnId: `unpin-${i}`,
      });
      observeProviderRunItem(newerRun, `item-${i}`, 'command_execution');
      settleProviderRun(newerRun);
    }

    expect(classifyProviderRunEvent(late, scope).kind).toBe('transcript_only');
    unpinProviderRun(run);
    expect(classifyProviderRunEvent(late, scope)).toMatchObject({
      kind: 'reject',
      reason: 'unknown_run',
    });
  });
  it('rejects revival metadata on a late result', () => {
    const { run } = fixture();
    settleProviderRun(run);
    const event = attachProviderRunEvent(
      { ...completion(), canopy_turn_revival: true },
      run,
      'late',
    );
    expect(classifyProviderRunEvent(event)).toMatchObject({
      kind: 'reject',
      reason: 'late_revival_metadata',
    });
  });
  it('rejects an overridden stamp instead of borrowing the new prompt', () => {
    const { run } = fixture();
    settleProviderRun(run);
    const event = attachProviderRunEvent(
      { ...completion(), canopy_turn_user_message_id: 'new-prompt' },
      run,
      'late',
    );
    expect(classifyProviderRunEvent(event, scope)).toMatchObject({
      kind: 'reject',
      reason: 'run_stamp_mismatch',
    });
  });
  it('rejects cross-chat trust and unsupported late lifecycle events', () => {
    const { run } = fixture();
    settleProviderRun(run);
    const late = attachProviderRunEvent(completion(), run, 'late');
    expect(
      classifyProviderRunEvent(late, { ...scope, chatId: 'other' }).kind,
    ).toBe('reject');
    const terminal = attachProviderRunEvent(
      {
        type: 'codex',
        event: { type: 'turn.completed', thread_id: 'thread', turn_id: 'turn' },
      },
      run,
      'late',
    );
    expect(classifyProviderRunEvent(terminal).kind).toBe('reject');
  });
});
