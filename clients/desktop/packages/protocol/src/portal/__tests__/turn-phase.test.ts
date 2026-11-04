import { orderedSettingsHeldChanges } from '../index';
import type {
  ChatTurnPhase,
  PortalQueuedMessage,
  QueuedMessageRetryBlockedReason,
  QueuedMessageWaitingReason,
} from '../index';

type Assert<T extends true> = T;
type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <
    Value,
  >() => Value extends Right ? 1 : 2
    ? true
    : false;

const typeChecks: [
  Assert<Equal<ChatTurnPhase, 'idle' | 'background' | 'foreground'>>,
  Assert<Equal<PortalQueuedMessage['turnPhase'], ChatTurnPhase | undefined>>,
  Assert<Equal<QueuedMessageRetryBlockedReason, 'insufficient_credits'>>,
  Assert<
    Equal<
      PortalQueuedMessage['retryBlockedReason'],
      QueuedMessageRetryBlockedReason | undefined
    >
  >,
  Assert<
    Equal<QueuedMessageWaitingReason, 'steer_unavailable' | 'background_work'>
  >,
  Assert<
    Equal<
      PortalQueuedMessage['waitingReason'],
      QueuedMessageWaitingReason | undefined
    >
  >,
] = [true, true, true, true, true, true];

describe('chat turn phase contract', () => {
  it('exports the same optional phase on portal and host queue rows', () => {
    const portalRow: PortalQueuedMessage = {
      id: 'portal-queue-1',
      text: 'Continue in the background',
      origin: 'portal',
      enqueuedAtMs: 1,
      turnPhase: 'background',
      retryBlockedReason: 'insufficient_credits',
    };
    const phases: ChatTurnPhase[] = ['idle', 'background', 'foreground'];

    expect(portalRow.turnPhase).toBe('background');
    expect(phases).toEqual(['idle', 'background', 'foreground']);
    expect(portalRow.retryBlockedReason).toBe('insufficient_credits');
    expect(typeChecks).toEqual([true, true, true, true, true, true]);
  });
});

describe('settings-held change names', () => {
  it('orders known names for display, once each, and drops names it does not know', () => {
    expect(
      orderedSettingsHeldChanges([
        'organization',
        'reasoning_mode',
        'plugins',
        'thinking_level',
        'model',
        'plugins',
      ]),
    ).toEqual(['model', 'thinking_level', 'plugins', 'organization']);
    expect(orderedSettingsHeldChanges([])).toEqual([]);
  });
});
