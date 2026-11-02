const mockStart = jest.fn();
const mockSucceed = jest.fn();
jest.mock('@canopy/desktop-instrumentation/client', () => ({
  startClientOperation: (...args: unknown[]): void => {
    mockStart(...args);
  },
  succeedClientOperation: (...args: unknown[]): void => {
    mockSucceed(...args);
  },
}));

import {
  CREDITS_RECOVERY_VIEW_WINDOW_MS,
  resetCreditsRecoveryTelemetryForTests,
  trackCreditsRecoveryClick,
  trackCreditsRecoveryView,
} from '../creditsRecoveryTelemetry';

function emitted(): Array<[unknown, unknown]> {
  return mockSucceed.mock.calls.map(
    ([name, options]: [unknown, { context: unknown }]) => [
      name,
      options.context,
    ],
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  resetCreditsRecoveryTelemetryForTests();
});

describe('credits recovery telemetry (CAN-4633)', () => {
  it('records a view with its surface and trigger', () => {
    trackCreditsRecoveryView({
      surface: 'chat_banner',
      trigger: 'failed_turn',
      dedupeKey: 'chat-1',
      now: 1_000,
    });

    expect(emitted()).toEqual([
      [
        'canopy.credits_recovery',
        { recovery_surface: 'chat_banner', recovery_trigger: 'failed_turn' },
      ],
    ]);
    expect(mockStart).toHaveBeenCalledTimes(1);
  });

  it('records the same view again only after the window', () => {
    const view = {
      surface: 'chat_banner',
      trigger: 'preflight',
      dedupeKey: 'chat-1',
    } as const;
    trackCreditsRecoveryView({ ...view, now: 1_000 });
    trackCreditsRecoveryView({ ...view, now: 2_000 });
    trackCreditsRecoveryView({
      ...view,
      now: 1_000 + CREDITS_RECOVERY_VIEW_WINDOW_MS,
    });

    expect(emitted()).toHaveLength(2);
  });

  it('keeps views of different chats, surfaces, and triggers apart', () => {
    trackCreditsRecoveryView({
      surface: 'chat_banner',
      trigger: 'preflight',
      dedupeKey: 'chat-1',
      now: 1_000,
    });
    trackCreditsRecoveryView({
      surface: 'chat_banner',
      trigger: 'preflight',
      dedupeKey: 'chat-2',
      now: 1_000,
    });
    trackCreditsRecoveryView({
      surface: 'chat_banner',
      trigger: 'failed_turn',
      dedupeKey: 'chat-1',
      now: 1_000,
    });
    trackCreditsRecoveryView({
      surface: 'turn_error',
      trigger: 'failed_turn',
      dedupeKey: 'chat-1',
      now: 1_000,
    });

    expect(emitted()).toHaveLength(4);
  });

  it('records every click with its surface and action', () => {
    trackCreditsRecoveryClick({
      surface: 'model_recovery',
      action: 'drip_opt_in',
    });
    trackCreditsRecoveryClick({
      surface: 'model_recovery',
      action: 'drip_opt_in',
    });

    expect(emitted()).toEqual([
      [
        'canopy.credits_recovery_action',
        { recovery_surface: 'model_recovery', recovery_action: 'drip_opt_in' },
      ],
      [
        'canopy.credits_recovery_action',
        { recovery_surface: 'model_recovery', recovery_action: 'drip_opt_in' },
      ],
    ]);
  });
});
