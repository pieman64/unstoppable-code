import { createPortalPrimaryToolCorrelation } from '../portal-primary-tool-correlation';
import { runtimeChatEventToPortalMessage } from '@canopy/desktop-shared/portal/runtime-chat-projection';
import type { ProviderEventAdmission } from '../../services/provider-event-admission';

function receipt(
  tools: ProviderEventAdmission['tools'],
  revision = 5,
): ProviderEventAdmission {
  return {
    projectId: 'p',
    worktreeId: 'w',
    chatId: 'c',
    mutationId: `m${revision}`,
    turnUserMessageId: 'turn',
    revision,
    tools,
  };
}

describe('per-turn primary source-position correlation', () => {
  it('stamps later frames without promoting an unrelated retained revision', () => {
    const correlation = createPortalPrimaryToolCorrelation();
    correlation.retain(
      'visible',
      receipt([
        {
          sourceToken: '1',
          occurrenceId: 'call#2',
          result: { rowId: 'result', blockOrdinal: 4, needsRead: true },
        },
      ]),
    );
    correlation.retain(
      'visible',
      receipt([{ sourceToken: '2', occurrenceId: 'other#0' }], 50),
    );
    const projected = runtimeChatEventToPortalMessage({
      scope: 'worktree',
      chatId: 'c',
      data: {
        type: 'user',
        message: {
          id: 'visible',
          content: [
            { type: 'text', text: 'ignored' },
            {
              type: 'tool_result',
              tool_use_id: 'duplicate',
              content: 'preview',
            },
          ],
        },
      },
      admission: correlation.forMessage('visible'),
    });
    expect(projected?.parts?.[0]?.occurrence).toEqual({
      id: 'call#2',
      revision: 5,
    });
    expect(projected?.parts?.[0]?.outputLocator).toEqual({
      messageId: 'result',
      blockOrdinal: 4,
      field: 'output',
    });
    expect(correlation.forMessage('another-visible')).toBeUndefined();
  });

  it('limits entries, diagnoses once, and never donates an evicted position', () => {
    const diagnose = jest.fn();
    const correlation = createPortalPrimaryToolCorrelation(diagnose);
    for (let index = 0; index < 256; index++)
      correlation.retain(
        `v${index}`,
        receipt([{ sourceToken: '0', occurrenceId: `r${index}#0` }]),
      );
    correlation.retain(
      'overflow',
      receipt([{ sourceToken: '0', occurrenceId: 'overflow#0' }]),
    );
    correlation.retain(
      'overflow-again',
      receipt([{ sourceToken: '0', occurrenceId: 'overflow#1' }]),
    );
    expect(correlation.forMessage('overflow')).toBeUndefined();
    expect(correlation.forMessage('v0')?.tools[0]?.occurrenceId).toBe('r0#0');
    expect(diagnose.mock.calls).toEqual([['entries']]);
    correlation.forget('v0');
    correlation.retain(
      'new-visible',
      receipt([{ sourceToken: '0', occurrenceId: 'new#0' }]),
    );
    expect(correlation.forMessage('v0')).toBeUndefined();
    expect(correlation.forMessage('new-visible')?.tools[0]?.occurrenceId).toBe(
      'new#0',
    );
  });

  it('limits bytes independently and clears on settlement or owner/turn replacement', () => {
    const diagnose = jest.fn();
    const correlation = createPortalPrimaryToolCorrelation(diagnose);
    // Huge source tokens are counted, not just occurrence ids or entry count.
    correlation.retain(
      'large',
      receipt([{ sourceToken: 'x'.repeat(262144), occurrenceId: 'large#0' }]),
    );
    expect(correlation.forMessage('large')).toBeUndefined();
    expect(diagnose.mock.calls).toEqual([['bytes']]);
    correlation.clear();
    correlation.retain(
      'visible',
      receipt([{ sourceToken: '0', occurrenceId: 'old#0' }]),
    );
    correlation.retain('next', {
      ...receipt([{ sourceToken: '0', occurrenceId: 'next#0' }]),
      turnUserMessageId: 'next-turn',
    });
    expect(correlation.forMessage('visible')).toBeUndefined();
    expect(correlation.forMessage('next')?.tools[0]?.occurrenceId).toBe(
      'next#0',
    );
    correlation.clear();
    expect(correlation.forMessage('next')).toBeUndefined();
  });
});
