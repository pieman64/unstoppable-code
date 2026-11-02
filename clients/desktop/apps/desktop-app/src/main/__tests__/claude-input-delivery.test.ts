import { ClaudeInputDelivery } from '../agents/claude-input-delivery';

const capabilities = [
  'msg_lifecycle_v1',
  'interrupt_receipt_v1',
  'interrupt_cancel_queued_v1',
];

function codesFixture(): {
  delivery: ClaudeInputDelivery;
  events: jest.Mock;
  lifecycle: (state: string, id: string) => void;
} {
  const events = jest.fn();
  const delivery = new ClaudeInputDelivery('generation', events, () => false);
  delivery.setQuery({ cancelAsyncMessage: jest.fn(), interrupt: jest.fn() });
  delivery.observe({ type: 'system', subtype: 'init', capabilities });
  const lifecycle = (state: string, id: string): void =>
    delivery.observe({ type: 'command_lifecycle', command_uuid: id, state });
  return { delivery, events, lifecycle };
}

function fixture(): {
  delivery: ClaudeInputDelivery;
  changed: jest.Mock;
  query: { cancelAsyncMessage: jest.Mock; interrupt: jest.Mock };
  init: (advertised?: string[]) => void;
  interrupt: jest.Mock;
} {
  const changed = jest.fn();
  const delivery = new ClaudeInputDelivery(
    'generation',
    jest.fn(),
    () => false,
    changed,
  );
  const interrupt = jest
    .fn()
    .mockResolvedValue({ cancelled: [], still_queued: [] });
  const query = { cancelAsyncMessage: jest.fn(), interrupt };
  const init = (advertised = capabilities): void =>
    delivery.observe({
      type: 'system',
      subtype: 'init',
      capabilities: advertised,
    });
  delivery.setQuery(query);
  init();
  changed.mockClear();
  return { delivery, changed, query, init, interrupt };
}

describe('Claude input delivery eligibility changes', () => {
  it('notifies on binding, unbinding and replacing the query', () => {
    const f = fixture();
    f.delivery.setQuery(undefined);
    expect(f.changed).toHaveBeenCalledTimes(1);
    expect(f.delivery.getCapabilities().steer).toBe(false);
    f.delivery.setQuery(f.query);
    expect(f.changed).toHaveBeenCalledTimes(2);
    expect(f.delivery.getCapabilities().steer).toBe(true);
    f.delivery.setQuery({});
    expect(f.changed).toHaveBeenCalledTimes(3);
    expect(f.delivery.getCapabilities().steer).toBe(false);
  });

  it('notifies on root advertised capabilities in either direction, not subagent init', () => {
    const f = fixture();
    f.init([]);
    expect(f.changed).toHaveBeenCalledTimes(1);
    expect(f.delivery.getCapabilities().steer).toBe(false);
    f.init();
    expect(f.changed).toHaveBeenCalledTimes(2);
    expect(f.delivery.getCapabilities().steer).toBe(true);
    f.delivery.observe({
      type: 'system',
      subtype: 'init',
      parent_tool_use_id: 'child',
      capabilities: [],
    });
    expect(f.changed).toHaveBeenCalledTimes(2);
    expect(f.delivery.getCapabilities().steer).toBe(true);
  });

  it.each(['success', 'rejection', 'invalid receipt'])(
    'notifies on freeze and thaw after sweep %s',
    async (outcome) => {
      const f = fixture();
      let release = (): void => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      f.interrupt.mockImplementation(async (): Promise<unknown> => {
        await gate;
        if (outcome === 'rejection') throw new Error('sweep failed');
        return outcome === 'invalid receipt'
          ? {}
          : { cancelled: [], still_queued: [] };
      });
      const states: boolean[] = [];
      f.changed.mockImplementation(() =>
        states.push(f.delivery.getCapabilities().steer),
      );
      const sweep = f.delivery.sweep();
      expect(states).toEqual([false]);
      expect(f.delivery.getCapabilities().steer).toBe(false);
      release();
      if (outcome === 'success') await expect(sweep).resolves.toBeUndefined();
      else await expect(sweep).rejects.toThrow();
      expect(states).toEqual([false, true]);
      expect(f.delivery.getCapabilities().steer).toBe(true);
    },
  );

  it('notifies on disposal and cannot regain eligibility when a sweep thaws', async () => {
    const f = fixture();
    let release = (): void => undefined;
    f.interrupt.mockReturnValue(
      new Promise((resolve) => {
        release = (): void => resolve({ cancelled: [], still_queued: [] });
      }),
    );
    const sweep = f.delivery.sweep();
    f.delivery.dispose();
    expect(f.changed).toHaveBeenCalledTimes(2);
    release();
    await sweep;
    expect(f.changed).toHaveBeenCalledTimes(3);
    expect(f.delivery.getCapabilities().steer).toBe(false);
    f.delivery.dispose();
    expect(f.changed).toHaveBeenCalledTimes(3);
  });

  it('notifies on endTurn freeze and disposal', () => {
    const f = fixture();
    f.delivery.endTurn();
    expect(f.changed).toHaveBeenCalledTimes(2);
    expect(f.delivery.getCapabilities().steer).toBe(false);
  });
});

describe('Claude input delivery failure and refusal codes', () => {
  const SENTINEL = 'payload-sentinel-8c1f';

  afterEach(() => {
    jest.useRealTimers();
  });

  it('keeps an unconfirmed submission unknown with the delivery-deadline code 60 seconds after handoff without the opt-in', async () => {
    jest.useFakeTimers();
    const f = codesFixture();
    const submission = f.delivery.submit(
      `text ${SENTINEL}`,
      'attempt',
      'row',
      () => undefined,
    );
    await Promise.resolve();
    expect(f.delivery.claimYield('attempt')).toBe(true);
    let settled = false;
    void submission.then(() => {
      settled = true;
    });
    await jest.advanceTimersByTimeAsync(5001);
    expect(settled).toBe(false);
    await jest.advanceTimersByTimeAsync(54999);
    const failure = {
      class: 'timeout',
      code: 'delivery-deadline',
      summary:
        'The provider did not confirm the message before the delivery deadline.',
    };
    await expect(submission).resolves.toEqual({
      kind: 'unknown',
      attemptId: 'attempt',
      reason:
        'Delivery was not confirmed. This message will not be resent automatically.',
      failure,
    });
    expect(f.events).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: 'unknown',
        attemptId: 'attempt',
        failure,
      }),
    );
    expect(JSON.stringify(f.events.mock.calls)).not.toContain(SENTINEL);
  });

  it('marks an unsupported submission with the steering-unavailable refusal', async () => {
    const f = codesFixture();
    f.delivery.setQuery(undefined);
    await expect(
      f.delivery.submit('text', 'attempt', 'row', () => undefined),
    ).resolves.toMatchObject({
      kind: 'rejected',
      reason: 'Steering is unavailable for this session',
      refusal: { code: 'steering-unavailable' },
    });
  });

  it('marks a backlogged submission with the delivery-backlog refusal', async () => {
    const f = codesFixture();
    for (let i = 0; i < 1024; i++) {
      const id = `pending-${i}`;
      await f.delivery.submit('text', id, id, () => f.lifecycle('queued', id));
    }
    const result = await f.delivery.submit(
      'text',
      'overflow',
      'overflow',
      () => undefined,
    );
    expect(result).toMatchObject({
      kind: 'rejected',
      refusal: { code: 'delivery-backlog' },
    });
    expect(result).not.toHaveProperty('fallback');
  });

  it('marks a submission rejected by the turn end with the turn-ended refusal and ordinary fallback', async () => {
    const f = codesFixture();
    const submission = f.delivery.submit(
      'text',
      'attempt',
      'row',
      () => undefined,
    );
    f.delivery.endTurn();
    await expect(submission).resolves.toMatchObject({
      kind: 'rejected',
      reason: 'The delegated SDK turn has ended',
      fallback: 'ordinary',
      refusal: {
        code: 'turn-ended',
        summary: 'The turn ended before the message was taken.',
      },
    });
  });

  it('marks a submission interrupted before handoff with the handoff-interrupted refusal', async () => {
    const f = codesFixture();
    f.delivery.setQuery({
      cancelAsyncMessage: jest.fn(),
      interrupt: jest.fn(() =>
        Promise.resolve({ cancelled: [], still_queued: [] }),
      ),
    });
    const submission = f.delivery.submit(
      'text',
      'attempt',
      'row',
      () => undefined,
    );
    await f.delivery.sweep();
    const result = await submission;
    expect(result).toMatchObject({
      kind: 'rejected',
      reason: 'Submission interrupted before handoff',
      refusal: { code: 'handoff-interrupted' },
    });
    expect(result).not.toHaveProperty('fallback');
  });

  it('marks a reused identity with the duplicate-attempt failure', async () => {
    const f = codesFixture();
    await f.delivery.submit('text', 'attempt', 'row', () =>
      f.lifecycle('queued', 'attempt'),
    );
    await expect(
      f.delivery.submit('text', 'attempt', 'row', () => undefined),
    ).resolves.toMatchObject({
      kind: 'unknown',
      reason: 'This submission identity was already used',
      failure: { class: 'transport', code: 'duplicate-attempt' },
    });
  });
});

describe('Claude input delivery receipt processing', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('applies root init capabilities once across receipt and admission', () => {
    const changed = jest.fn();
    const delivery = new ClaudeInputDelivery(
      'generation',
      jest.fn(),
      () => false,
      changed,
    );
    delivery.setQuery({ cancelAsyncMessage: jest.fn(), interrupt: jest.fn() });
    changed.mockClear();
    const init = { type: 'system', subtype: 'init', capabilities };

    delivery.receive(init);
    expect(delivery.getCapabilities().steer).toBe(true);
    delivery.observe(init);

    expect(changed).toHaveBeenCalledTimes(1);
    expect(delivery.getCapabilities().steer).toBe(true);
    delivery.receive({
      ...init,
      parent_tool_use_id: 'child',
      capabilities: [],
    });
    expect(changed).toHaveBeenCalledTimes(1);
    expect(delivery.getCapabilities().steer).toBe(true);
  });

  it('ignores a child command lifecycle receipt instead of acknowledging a root submission', async () => {
    jest.useFakeTimers();
    const f = codesFixture();
    const submission = f.delivery.submit(
      'text',
      'attempt',
      'row',
      () => undefined,
      { pendingOnDeadline: true },
    );
    await Promise.resolve();

    f.delivery.receive({
      type: 'command_lifecycle',
      parent_tool_use_id: 'child-tool-use',
      command_uuid: 'attempt',
      state: 'queued',
    });

    expect(f.events).not.toHaveBeenCalled();
    f.delivery.receive({
      type: 'command_lifecycle',
      parent_tool_use_id: null,
      command_uuid: 'attempt',
      state: 'queued',
    });
    await expect(submission).resolves.toEqual({
      kind: 'accepted',
      attemptId: 'attempt',
    });
    expect(f.events).toHaveBeenCalledTimes(1);
    expect(f.events).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'accepted', attemptId: 'attempt' }),
    );
  });

  it('does not replay earlier received init capabilities during ordered admission', () => {
    const changed = jest.fn();
    const events = jest.fn();
    const delivery = new ClaudeInputDelivery(
      'generation',
      events,
      () => false,
      changed,
    );
    delivery.setQuery({ cancelAsyncMessage: jest.fn(), interrupt: jest.fn() });
    changed.mockClear();
    const initA = { type: 'system', subtype: 'init', capabilities };
    const initB = {
      type: 'system',
      subtype: 'init',
      capabilities: ['msg_lifecycle_v1'],
    };

    delivery.receive(initA);
    delivery.receive(initB);
    expect(delivery.getCapabilities().steer).toBe(false);
    expect(changed).toHaveBeenCalledTimes(2);

    delivery.observe(initA);
    delivery.observe(initB);

    expect(delivery.getCapabilities().steer).toBe(false);
    expect(delivery.getCapabilities().withdraw).toBe(true);
    expect(changed).toHaveBeenCalledTimes(2);
    expect(events).not.toHaveBeenCalled();
  });

  it('emits and settles queued admission at receipt without repeating during observe', async () => {
    jest.useFakeTimers();
    const f = codesFixture();
    const submission = f.delivery.submit(
      'text',
      'attempt',
      'row',
      () => undefined,
      { pendingOnDeadline: true },
    );
    await Promise.resolve();
    const queued = {
      type: 'command_lifecycle',
      command_uuid: 'attempt',
      state: 'queued',
    };

    f.delivery.receive(queued);

    await expect(submission).resolves.toEqual({
      kind: 'accepted',
      attemptId: 'attempt',
    });
    expect(f.events).toHaveBeenCalledTimes(1);
    expect(f.events).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'accepted', attemptId: 'attempt' }),
    );
    f.delivery.observe(queued);
    expect(f.events).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('decides pickup at receipt and emits it once in admission order', async () => {
    jest.useFakeTimers();
    const events = jest.fn();
    const pickup = jest.fn(() => true);
    const delivery = new ClaudeInputDelivery('generation', events, pickup);
    delivery.setQuery({ cancelAsyncMessage: jest.fn(), interrupt: jest.fn() });
    delivery.observe({ type: 'system', subtype: 'init', capabilities });
    const submission = delivery.submit(
      'text',
      'attempt',
      'row',
      () => undefined,
    );
    await Promise.resolve();
    const started = {
      type: 'command_lifecycle',
      command_uuid: 'attempt',
      state: 'started',
    };

    delivery.receive(started);

    expect(pickup).toHaveBeenCalledTimes(1);
    expect(pickup).toHaveBeenCalledWith('row');
    expect(events).not.toHaveBeenCalled();
    delivery.observe(started);
    delivery.observe(started);
    expect(pickup).toHaveBeenCalledTimes(1);
    expect(events).toHaveBeenCalledTimes(1);
    expect(events).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: 'picked-up',
        startsTurn: true,
        userMessageId: 'row',
      }),
    );
    await expect(submission).resolves.toEqual({
      kind: 'accepted',
      attemptId: 'attempt',
    });
  });

  it('preserves observe-only pickup behavior for callers without receipt processing', async () => {
    jest.useFakeTimers();
    const events = jest.fn();
    const pickup = jest.fn(() => false);
    const delivery = new ClaudeInputDelivery('generation', events, pickup);
    delivery.setQuery({ cancelAsyncMessage: jest.fn(), interrupt: jest.fn() });
    delivery.observe({ type: 'system', subtype: 'init', capabilities });
    const submission = delivery.submit(
      'text',
      'attempt',
      'row',
      () => undefined,
    );
    await Promise.resolve();

    delivery.observe({
      type: 'command_lifecycle',
      command_uuid: 'attempt',
      state: 'started',
    });

    expect(pickup).toHaveBeenCalledTimes(1);
    expect(events).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'picked-up', attemptId: 'attempt' }),
    );
    await expect(submission).resolves.toEqual({
      kind: 'accepted',
      attemptId: 'attempt',
    });
  });

  it('emits received cancellation and completion once at receipt', async () => {
    jest.useFakeTimers();
    const f = codesFixture();
    const submission = f.delivery.submit(
      'text',
      'attempt',
      'row',
      () => undefined,
      { pendingOnDeadline: true },
    );
    await Promise.resolve();
    const cancelled = {
      type: 'command_lifecycle',
      command_uuid: 'attempt',
      state: 'cancelled',
    };
    const completed = {
      type: 'command_lifecycle',
      command_uuid: 'attempt',
      state: 'completed',
    };

    f.delivery.receive(cancelled);
    expect(f.events).toHaveBeenCalledTimes(1);
    expect(f.events).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'withdrawn', attemptId: 'attempt' }),
    );
    f.delivery.receive(completed);
    expect(f.events).toHaveBeenCalledTimes(2);
    expect(f.events).toHaveBeenLastCalledWith(
      expect.objectContaining({ phase: 'completed', attemptId: 'attempt' }),
    );
    f.delivery.observe(cancelled);
    f.delivery.observe(completed);
    expect(f.events).toHaveBeenCalledTimes(2);
    f.delivery.dispose();
    await expect(submission).resolves.toEqual({
      kind: 'rejected',
      attemptId: 'attempt',
      reason: 'Submission withdrawn before delivery',
      refusal: {
        code: 'handoff-interrupted',
        summary: 'The submission was interrupted before the handoff.',
      },
    });
  });

  it('settles a waiting submit when observe sees cancellation, including when disposed next', async () => {
    jest.useFakeTimers();
    const f = codesFixture();
    const submission = f.delivery.submit(
      'text',
      'attempt',
      'row',
      () => undefined,
      { pendingOnDeadline: true },
    );
    await Promise.resolve();
    f.delivery.observe({
      type: 'command_lifecycle',
      command_uuid: 'attempt',
      state: 'cancelled',
    });
    f.delivery.dispose();

    await expect(submission).resolves.toEqual({
      kind: 'rejected',
      attemptId: 'attempt',
      reason: 'Submission withdrawn before delivery',
      refusal: {
        code: 'handoff-interrupted',
        summary: 'The submission was interrupted before the handoff.',
      },
    });
  });

  it('settles a waiting submit on a sweep cancellation receipt, including when disposed next', async () => {
    jest.useFakeTimers();
    const events = jest.fn();
    const delivery = new ClaudeInputDelivery('generation', events, () => false);
    delivery.setQuery({
      cancelAsyncMessage: jest.fn(),
      interrupt: jest.fn(() =>
        Promise.resolve({ cancelled: ['attempt'], still_queued: [] }),
      ),
    });
    delivery.observe({ type: 'system', subtype: 'init', capabilities });
    const submission = delivery.submit(
      'text',
      'attempt',
      'row',
      () => undefined,
      { pendingOnDeadline: true },
    );
    await Promise.resolve();
    expect(delivery.claimYield('attempt')).toBe(true);

    await delivery.sweep();
    delivery.dispose();

    await expect(submission).resolves.toEqual({
      kind: 'rejected',
      attemptId: 'attempt',
      reason: 'Submission withdrawn before delivery',
      refusal: {
        code: 'handoff-interrupted',
        summary: 'The submission was interrupted before the handoff.',
      },
    });
  });
});

describe('Claude input delivery handoff deadlines', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('accepts a delegated input acknowledged eight seconds after handoff', async () => {
    jest.useFakeTimers();
    const f = codesFixture();
    const submission = f.delivery.submit(
      'text',
      'attempt',
      'row',
      () => undefined,
    );
    await Promise.resolve();
    expect(f.delivery.claimYield('attempt')).toBe(true);
    await jest.advanceTimersByTimeAsync(8000);
    f.delivery.receive({
      type: 'command_lifecycle',
      command_uuid: 'attempt',
      state: 'queued',
    });
    await expect(submission).resolves.toEqual({
      kind: 'accepted',
      attemptId: 'attempt',
    });
    await jest.advanceTimersByTimeAsync(60000);
    expect(f.events).not.toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'unknown', attemptId: 'attempt' }),
    );
  });

  it('starts the root pending result at five seconds and reports a handoff deadline at sixty seconds', async () => {
    jest.useFakeTimers();
    const f = codesFixture();
    const submission = f.delivery.submit(
      'text',
      'attempt',
      'row',
      () => undefined,
      { pendingOnDeadline: true },
    );
    await Promise.resolve();
    expect(f.delivery.claimYield('attempt')).toBe(true);
    await jest.advanceTimersByTimeAsync(5000);
    await expect(submission).resolves.toEqual({
      kind: 'pending',
      attemptId: 'attempt',
    });
    expect(f.events).not.toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'unknown', attemptId: 'attempt' }),
    );
    await jest.advanceTimersByTimeAsync(54999);
    expect(f.events).not.toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'unknown', attemptId: 'attempt' }),
    );
    await jest.advanceTimersByTimeAsync(1);
    expect(f.events).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: 'unknown',
        attemptId: 'attempt',
        failure: {
          class: 'timeout',
          code: 'delivery-deadline',
          summary:
            'The provider did not confirm the message before the delivery deadline.',
        },
      }),
    );
  });

  it('uses sixty seconds from submit when a delegated input is never handed off', async () => {
    jest.useFakeTimers();
    const f = codesFixture();
    const submission = f.delivery.submit(
      'text',
      'attempt',
      'row',
      () => undefined,
    );
    let settled = false;
    void submission.then(() => {
      settled = true;
    });
    await jest.advanceTimersByTimeAsync(59999);
    expect(settled).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    await expect(submission).resolves.toMatchObject({
      kind: 'unknown',
      attemptId: 'attempt',
      failure: { code: 'delivery-deadline' },
    });
  });

  it.each(['accepted', 'withdrawn', 'disposed'])(
    'does not report a handoff deadline after the attempt is %s',
    async (outcome) => {
      jest.useFakeTimers();
      const f = codesFixture();
      const submission = f.delivery.submit(
        'text',
        'attempt',
        'row',
        () => undefined,
        { pendingOnDeadline: true },
      );
      await Promise.resolve();
      expect(f.delivery.claimYield('attempt')).toBe(true);
      await jest.advanceTimersByTimeAsync(5000);
      if (outcome === 'accepted') {
        f.delivery.receive({
          type: 'command_lifecycle',
          command_uuid: 'attempt',
          state: 'queued',
        });
      } else if (outcome === 'withdrawn') {
        f.delivery.receive({
          type: 'command_lifecycle',
          command_uuid: 'attempt',
          state: 'cancelled',
        });
      } else {
        f.delivery.dispose();
      }
      await submission;
      await jest.advanceTimersByTimeAsync(60000);
      expect(f.events.mock.calls.flat()).not.toContainEqual(
        expect.objectContaining({
          phase: 'unknown',
          failure: {
            class: 'timeout',
            code: 'delivery-deadline',
            summary:
              'The provider did not confirm the message before the delivery deadline.',
          },
        }),
      );
    },
  );
});

describe('Claude input delivery after a late acknowledgement', () => {
  function lateFixture(): {
    delivery: ClaudeInputDelivery;
    events: jest.Mock;
    cancelAsyncMessage: jest.Mock;
    lifecycle: (state: string) => void;
  } {
    const events = jest.fn();
    const cancelAsyncMessage = jest.fn().mockResolvedValue(false);
    const delivery = new ClaudeInputDelivery('generation', events, () => false);
    delivery.setQuery({ cancelAsyncMessage, interrupt: jest.fn() });
    delivery.observe({ type: 'system', subtype: 'init', capabilities });
    const lifecycle = (state: string): void =>
      delivery.observe({
        type: 'command_lifecycle',
        command_uuid: 'attempt',
        state,
      });
    return { delivery, events, cancelAsyncMessage, lifecycle };
  }

  /** A pending submission whose withdrawal went unconfirmed, then acknowledged late. */
  async function lateAcknowledged(): Promise<ReturnType<typeof lateFixture>> {
    jest.useFakeTimers();
    const f = lateFixture();
    const submission = f.delivery.submit(
      'text',
      'attempt',
      'row',
      () => undefined,
      { pendingOnDeadline: true },
    );
    await jest.advanceTimersByTimeAsync(5001);
    await expect(submission).resolves.toEqual({
      kind: 'pending',
      attemptId: 'attempt',
    });
    await expect(f.delivery.withdraw('attempt')).resolves.toMatchObject({
      kind: 'unconfirmed',
    });
    f.lifecycle('queued');
    f.events.mockClear();
    return f;
  }

  afterEach(() => {
    jest.useRealTimers();
  });

  it('confirms a later cancellation as withdrawn', async () => {
    const f = await lateAcknowledged();
    f.cancelAsyncMessage.mockResolvedValue(true);
    await expect(f.delivery.withdraw('attempt')).resolves.toEqual({
      kind: 'withdrawn',
      attemptId: 'attempt',
      evidenceId: 'attempt',
    });
  });

  it('reports a later cancelled lifecycle as withdrawn', async () => {
    const f = await lateAcknowledged();
    f.lifecycle('cancelled');
    expect(f.events).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'withdrawn', attemptId: 'attempt' }),
    );
  });
});

describe('Claude input delivery pickup across disposal', () => {
  it('still records the ordered pickup for a steer read before Stop disposed the session', async () => {
    const events = jest.fn();
    const delivery = new ClaudeInputDelivery('generation', events, () => true);
    delivery.setQuery({ cancelAsyncMessage: jest.fn(), interrupt: jest.fn() });
    delivery.observe({ type: 'system', subtype: 'init', capabilities });
    const submission = delivery.submit(
      'text',
      'attempt',
      'row',
      () => undefined,
    );
    const started = {
      type: 'command_lifecycle',
      command_uuid: 'attempt',
      state: 'started',
    };
    delivery.receive(started);
    await expect(submission).resolves.toEqual({
      kind: 'accepted',
      attemptId: 'attempt',
    });
    delivery.dispose();
    delivery.observe(started);
    expect(events).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: 'picked-up',
        attemptId: 'attempt',
        startsTurn: true,
      }),
    );
    expect(events).not.toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'unknown', attemptId: 'attempt' }),
    );
  });
});
