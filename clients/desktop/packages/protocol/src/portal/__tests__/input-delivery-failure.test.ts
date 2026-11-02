import {
  CHAT_INPUT_DELIVERY_FAILURES,
  CHAT_INPUT_REFUSALS,
  chatInputDeliveryFailure,
  chatInputRefusal,
  readChatInputDeliveryFailure,
  readChatInputRefusal,
} from '../input-delivery';

const SENTINEL = 'PAYLOAD-SENTINEL do not record';

describe('input-delivery failure and refusal metadata', () => {
  it('builds failure and refusal metadata from the fixed tables', () => {
    expect(chatInputDeliveryFailure('process-exit')).toEqual({
      class: 'restart',
      code: 'process-exit',
      summary: CHAT_INPUT_DELIVERY_FAILURES['process-exit'].summary,
    });
    expect(chatInputRefusal('output-schema-mismatch')).toEqual({
      code: 'output-schema-mismatch',
      summary: CHAT_INPUT_REFUSALS['output-schema-mismatch'],
    });
  });

  it('rebuilds untrusted metadata from its code and drops anything else', () => {
    expect(
      readChatInputDeliveryFailure({
        class: 'timeout',
        code: 'session-ended',
        summary: SENTINEL,
      }),
    ).toEqual(chatInputDeliveryFailure('session-ended'));
    expect(
      readChatInputRefusal({ code: 'no-active-turn', summary: SENTINEL }),
    ).toEqual(chatInputRefusal('no-active-turn'));

    for (const value of [
      undefined,
      null,
      'session-ended',
      { code: SENTINEL },
      { code: 'toString' },
      { summary: SENTINEL },
    ]) {
      expect(readChatInputDeliveryFailure(value)).toBeUndefined();
      expect(readChatInputRefusal(value)).toBeUndefined();
    }
  });
});
