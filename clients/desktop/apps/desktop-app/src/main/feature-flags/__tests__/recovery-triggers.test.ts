import { EventEmitter } from 'node:events';
import { installFeatureFlagRecoveryTriggers } from '../recovery-triggers';

describe('installFeatureFlagRecoveryTriggers', () => {
  function setup(): {
    app: EventEmitter;
    powerMonitor: EventEmitter;
    requestRetry: jest.Mock;
    dispose: () => void;
  } {
    const app = new EventEmitter();
    const powerMonitor = new EventEmitter();
    const requestRetry = jest.fn();
    const dispose = installFeatureFlagRecoveryTriggers(
      { requestRetry },
      { app, powerMonitor },
    );
    return { app, powerMonitor, requestRetry, dispose };
  }

  it('asks for a retry when a window gains focus', () => {
    const { app, requestRetry } = setup();

    app.emit('browser-window-focus');

    expect(requestRetry).toHaveBeenCalledWith('window_focus');
  });

  it.each(['resume', 'unlock-screen'])(
    'asks for a retry on the power monitor %s event',
    (event) => {
      const { powerMonitor, requestRetry } = setup();

      powerMonitor.emit(event);

      expect(requestRetry).toHaveBeenCalledWith('power_resume');
    },
  );

  it('removes every listener on dispose', () => {
    const { app, powerMonitor, requestRetry, dispose } = setup();

    dispose();
    app.emit('browser-window-focus');
    powerMonitor.emit('resume');
    powerMonitor.emit('unlock-screen');

    expect(requestRetry).not.toHaveBeenCalled();
    expect(app.listenerCount('browser-window-focus')).toBe(0);
    expect(powerMonitor.listenerCount('resume')).toBe(0);
    expect(powerMonitor.listenerCount('unlock-screen')).toBe(0);
  });
});
