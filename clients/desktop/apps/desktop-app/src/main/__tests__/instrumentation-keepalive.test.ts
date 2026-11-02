jest.mock('@canopy/desktop-instrumentation/electron/main', () => ({
  keepDesktopInstrumentationSessionAlive: jest.fn(),
}));

import {
  disposeInstrumentationKeepalive,
  startInstrumentationKeepalive,
  type InstrumentationKeepaliveOptions,
  type InstrumentationPowerMonitor,
} from '../lib/instrumentation-keepalive';

interface Harness {
  options: InstrumentationKeepaliveOptions;
  notify: jest.Mock;
  powerMonitorOn: jest.Mock;
  powerMonitorRemove: jest.Mock;
  setIntervalFn: jest.Mock;
  clearIntervalFn: jest.Mock;
  unref: jest.Mock;
  handle: { unref: jest.Mock };
  armedIntervalMs(): number | null;
  tickInterval(): void;
  fireResume(): void;
}

function createHarness(
  overrides?: Partial<InstrumentationKeepaliveOptions>,
): Harness {
  let intervalCallback: (() => void) | null = null;
  let resumeListener: (() => void) | null = null;
  let intervalMs: number | null = null;

  const notify = jest.fn();
  const unref = jest.fn();
  const handle = { unref };
  const clearIntervalFn = jest.fn();
  const setIntervalFn = jest.fn((callback: () => void, ms: number) => {
    intervalCallback = callback;
    intervalMs = ms;
    return handle;
  });

  const powerMonitorOn = jest.fn(
    (_event: 'resume', listener: () => void): void => {
      resumeListener = listener;
    },
  );
  const powerMonitorRemove = jest.fn();
  const powerMonitor: InstrumentationPowerMonitor = {
    on: powerMonitorOn,
    removeListener: powerMonitorRemove,
  };

  const options: InstrumentationKeepaliveOptions = {
    powerMonitor,
    notify,
    setIntervalFn: setIntervalFn as unknown as typeof setInterval,
    clearIntervalFn,
    ...overrides,
  };

  return {
    options,
    notify,
    powerMonitorOn,
    powerMonitorRemove,
    setIntervalFn,
    clearIntervalFn,
    unref,
    handle,
    armedIntervalMs: (): number | null => intervalMs,
    tickInterval: (): void => {
      if (!intervalCallback) {
        throw new Error('interval was not armed');
      }
      intervalCallback();
    },
    fireResume: (): void => {
      if (!resumeListener) {
        throw new Error('resume listener was not registered');
      }
      resumeListener();
    },
  };
}

describe('instrumentation keepalive', () => {
  afterEach(() => {
    // Reset module-level singleton state between tests.
    disposeInstrumentationKeepalive();
  });

  it('arms an unref’d interval and a resume listener on start', () => {
    const harness = createHarness();

    startInstrumentationKeepalive(harness.options);

    expect(harness.setIntervalFn).toHaveBeenCalledTimes(1);
    expect(harness.armedIntervalMs()).toBe(5 * 60 * 1000);
    expect(harness.unref).toHaveBeenCalledTimes(1);
    expect(harness.powerMonitorOn).toHaveBeenCalledWith(
      'resume',
      expect.any(Function),
    );
  });

  it('renews on each interval tick', () => {
    const harness = createHarness();
    startInstrumentationKeepalive(harness.options);

    harness.tickInterval();

    expect(harness.notify).toHaveBeenCalledTimes(1);
  });

  it('renews immediately on resume', () => {
    const harness = createHarness();
    startInstrumentationKeepalive(harness.options);

    harness.fireResume();

    expect(harness.notify).toHaveBeenCalledTimes(1);
  });

  it('honors a custom interval', () => {
    const harness = createHarness({ intervalMs: 1234 });

    startInstrumentationKeepalive(harness.options);

    expect(harness.armedIntervalMs()).toBe(1234);
  });

  it('is idempotent across repeated starts', () => {
    const harness = createHarness();

    startInstrumentationKeepalive(harness.options);
    startInstrumentationKeepalive(harness.options);

    expect(harness.setIntervalFn).toHaveBeenCalledTimes(1);
    expect(harness.powerMonitorOn).toHaveBeenCalledTimes(1);
  });

  it('clears the interval and removes the resume listener on dispose', () => {
    const harness = createHarness();
    startInstrumentationKeepalive(harness.options);

    disposeInstrumentationKeepalive();

    expect(harness.clearIntervalFn).toHaveBeenCalledTimes(1);
    expect(harness.clearIntervalFn).toHaveBeenCalledWith(harness.handle);
    expect(harness.powerMonitorRemove).toHaveBeenCalledWith(
      'resume',
      expect.any(Function),
    );
  });

  it('is idempotent across repeated disposes', () => {
    const harness = createHarness();
    startInstrumentationKeepalive(harness.options);

    disposeInstrumentationKeepalive();
    disposeInstrumentationKeepalive();

    expect(harness.clearIntervalFn).toHaveBeenCalledTimes(1);
    expect(harness.powerMonitorRemove).toHaveBeenCalledTimes(1);
  });
});
