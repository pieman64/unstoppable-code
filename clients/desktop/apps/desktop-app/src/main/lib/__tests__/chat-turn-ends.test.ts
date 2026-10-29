import {
  TURN_END_LIMIT,
  recordedTurnEnd,
  withTurnEnd,
  withoutTurnEnd,
  type TurnEnds,
} from '../chat-turn-ends';

describe('chat turn ends', () => {
  it('records the latest end of a turn and drops it when the turn runs again', () => {
    let ends = withTurnEnd(undefined, 'user-a', 'failed', 1);
    expect(recordedTurnEnd(ends, 'user-a')).toBe('failed');
    ends = withTurnEnd(ends, 'user-a', 'completed', 2);
    expect(recordedTurnEnd(ends, 'user-a')).toBe('completed');
    expect(recordedTurnEnd(ends, 'user-b')).toBeUndefined();
    expect(withoutTurnEnd(ends, 'user-b')).toBe(ends);
    expect(withoutTurnEnd(ends, 'user-a')).toBeUndefined();
  });

  it('keeps failed and cancelled ends past the bound before completed ones', () => {
    let ends: TurnEnds | undefined;
    ends = withTurnEnd(ends, 'failed-oldest', 'failed', 0);
    ends = withTurnEnd(ends, 'cancelled-old', 'cancelled', 1);
    for (let index = 0; index < TURN_END_LIMIT; index += 1) {
      ends = withTurnEnd(ends, `done-${index}`, 'completed', index + 2);
    }

    expect(Object.keys(ends)).toHaveLength(TURN_END_LIMIT);
    expect(recordedTurnEnd(ends, 'failed-oldest')).toBe('failed');
    expect(recordedTurnEnd(ends, 'cancelled-old')).toBe('cancelled');
    expect(recordedTurnEnd(ends, 'done-0')).toBeUndefined();
    expect(recordedTurnEnd(ends, 'done-1')).toBeUndefined();
    expect(recordedTurnEnd(ends, `done-${TURN_END_LIMIT - 1}`)).toBe(
      'completed',
    );
  });

  it('keeps the named end past the bound', () => {
    let ends: TurnEnds | undefined = withTurnEnd(
      undefined,
      'accepted',
      'completed',
      0,
    );
    for (let index = 1; index <= TURN_END_LIMIT; index += 1) {
      ends = withTurnEnd(ends, `failed-${index}`, 'failed', index, 'accepted');
    }

    expect(Object.keys(ends ?? {})).toHaveLength(TURN_END_LIMIT);
    expect(recordedTurnEnd(ends, 'accepted')).toBe('completed');
    expect(recordedTurnEnd(ends, 'failed-1')).toBeUndefined();
    expect(recordedTurnEnd(ends, `failed-${TURN_END_LIMIT}`)).toBe('failed');
  });

  it('drops the oldest failed or cancelled end once only those remain', () => {
    let ends: TurnEnds | undefined;
    for (let index = 0; index <= TURN_END_LIMIT; index += 1) {
      ends = withTurnEnd(ends, `failed-${index}`, 'failed', index);
    }

    expect(Object.keys(ends ?? {})).toHaveLength(TURN_END_LIMIT);
    expect(recordedTurnEnd(ends, 'failed-0')).toBeUndefined();
    expect(recordedTurnEnd(ends, `failed-${TURN_END_LIMIT}`)).toBe('failed');
  });

  it('ignores a malformed persisted end', () => {
    const persisted: unknown = JSON.parse(
      '{"user-a":"failed","user-b":{"outcome":"unknown","endedAt":1}}',
    );
    const ends: TurnEnds = {};
    if (persisted && typeof persisted === 'object') {
      Object.assign(ends, persisted);
    }
    expect(recordedTurnEnd(ends, 'user-a')).toBeUndefined();
    expect(recordedTurnEnd(ends, 'user-b')).toBeUndefined();
  });
});
