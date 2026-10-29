import {
  sanitizePortalEventEnvelope,
  sanitizeStorableJson,
  sanitizeStorableString,
  type PortalEventEnvelope,
} from '../index';

describe('Portal event persistence sanitization', () => {
  it('removes NUL from nested values and object keys', () => {
    expect(
      sanitizeStorableJson({
        'nul\0key': ['before\0after', { nested: 'left\0right' }],
      }),
    ).toEqual({
      nulkey: ['beforeafter', { nested: 'leftright' }],
    });
  });

  it('returns clean strings, arrays, objects, and envelopes unchanged', () => {
    const cleanString = 'clean 😀 text';
    const cleanArray = ['clean', 1, null];
    const cleanObject = { cleanArray };
    const cleanEnvelope: PortalEventEnvelope = {
      eventId: 'event-1',
      clientEventId: 'client-event-1',
      commandId: 'command-1',
      type: 'portal.heartbeat',
      occurredAt: '2026-05-06T00:00:00.000Z',
      payload: cleanObject,
    };

    expect(sanitizeStorableString(cleanString)).toBe(cleanString);
    expect(sanitizeStorableJson(cleanArray)).toBe(cleanArray);
    expect(sanitizeStorableJson(cleanObject)).toBe(cleanObject);
    expect(sanitizePortalEventEnvelope(cleanEnvelope)).toBe(cleanEnvelope);
  });

  it('reallocates only changed paths and retains untouched sibling identity', () => {
    const cleanSibling = { value: 'clean' };
    const changedChild = { value: 'poison\0text' };
    const input = { cleanSibling, changedChild };

    const result = sanitizeStorableJson(input);

    expect(result).not.toBe(input);
    expect(result.cleanSibling).toBe(cleanSibling);
    expect(result.changedChild).not.toBe(changedChild);
    expect(result.changedChild).toEqual({ value: 'poisontext' });
  });

  it('sanitizes deeply nested JSON without overflowing the call stack', () => {
    const depth = 20_000;
    let input: unknown = 'before\0after';
    for (let index = 0; index < depth; index += 1) {
      input = [input];
    }

    let current: unknown = sanitizeStorableJson(input);
    for (let index = 0; index < depth; index += 1) {
      expect(Array.isArray(current)).toBe(true);
      current = (current as unknown[])[0];
    }
    expect(current).toBe('beforeafter');
  });

  it.each([null, undefined, true, false, 42])(
    'passes through primitive %p',
    (value) => {
      expect(sanitizeStorableJson(value)).toBe(value);
    },
  );

  it('passes through non-plain objects', () => {
    const value = new Date('2026-05-06T00:00:00.000Z');
    expect(sanitizeStorableJson(value)).toBe(value);
  });

  it('sanitizes every persisted envelope string field and its payload', () => {
    const event = {
      eventId: 'event\0-1',
      clientEventId: 'client\0-1',
      commandId: 'command\0-1',
      type: 'portal.heart\0beat',
      occurredAt: '2026-05-06T00:00:00.000Z',
      payload: { message: 'hello\0world' },
    } as unknown as PortalEventEnvelope;

    expect(sanitizePortalEventEnvelope(event)).toEqual({
      eventId: 'event-1',
      clientEventId: 'client-1',
      commandId: 'command-1',
      type: 'portal.heartbeat',
      occurredAt: event.occurredAt,
      payload: { message: 'helloworld' },
    });
  });

  it('replaces lone surrogates while retaining valid pairs', () => {
    expect(sanitizeStorableString('high\ud800 low\udc00 emoji😀')).toBe(
      'high� low� emoji😀',
    );
  });

  it('repairs a surrogate pair split by slice', () => {
    const text = 'retained😀';
    const split = text.slice(0, -1);
    expect(sanitizeStorableString(split)).toBe('retained�');
  });

  it('handles mixed NUL and lone-surrogate input', () => {
    expect(sanitizeStorableString('a\0b\ud800c\udc00d')).toBe('ab�c�d');
  });

  it('uses deterministic property order when sanitized keys collide', () => {
    const input = {
      'same\0key': 'first',
      samekey: 'second',
      'third\0': 'before',
      third: 'after',
    };

    expect(sanitizeStorableJson(input)).toEqual({
      samekey: 'second',
      third: 'after',
    });
  });
});
