jest.mock('@canopy/desktop-instrumentation', () => ({
  createDesktopInstrumentationOperationKey: jest.fn(
    (seed: string) => `operation:${seed}`,
  ),
}));

jest.mock('@canopy/desktop-instrumentation/electron/main', () => ({
  startDesktopOperation: jest.fn(),
  succeedDesktopOperation: jest.fn(),
}));

import {
  startDesktopOperation,
  succeedDesktopOperation,
} from '@canopy/desktop-instrumentation/electron/main';
import { recordOnboardingProfileTelemetry } from '../lib/desktop-telemetry';

const mockedStart = jest.mocked(startDesktopOperation);
const mockedSucceed = jest.mocked(succeedDesktopOperation);
const realSetImmediate = globalThis.setImmediate;

async function flushTelemetry(): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve();
  }
}

describe('recordOnboardingProfileTelemetry', () => {
  let setImmediateSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Date, 'now').mockReturnValue(1_000);
    setImmediateSpy = jest
      .spyOn(globalThis, 'setImmediate')
      .mockImplementation((callback: () => void) => {
        const handle = realSetImmediate(() => undefined);
        clearImmediate(handle);
        callback();
        return handle;
      });
  });

  afterEach(() => {
    setImmediateSpy.mockRestore();
    jest.restoreAllMocks();
  });

  test('emits changed enum ids only', async () => {
    recordOnboardingProfileTelemetry({
      previous: {},
      next: { attributionSource: 'search', profileRole: 'designer' },
    });
    await flushTelemetry();

    expect(mockedStart).toHaveBeenCalledTimes(1);
    const [name, options] = mockedStart.mock.calls[0];
    expect(name).toBe('canopy.onboarding_profile');
    expect(options?.context).toEqual({
      attribution_source: 'search',
      profile_role: 'designer',
    });
    expect(mockedSucceed).toHaveBeenCalledTimes(1);
  });

  test('emits only the field that changed', async () => {
    recordOnboardingProfileTelemetry({
      previous: { attributionSource: 'search', profileRole: 'designer' },
      next: { attributionSource: 'search', profileRole: 'student' },
    });
    await flushTelemetry();

    expect(mockedStart).toHaveBeenCalledTimes(1);
    expect(mockedStart.mock.calls[0][1]?.context).toEqual({
      profile_role: 'student',
    });
  });

  test('does not emit when nothing changed', async () => {
    recordOnboardingProfileTelemetry({
      previous: { attributionSource: 'github' },
      next: { attributionSource: 'github' },
    });
    await flushTelemetry();

    expect(mockedStart).not.toHaveBeenCalled();
    expect(mockedSucceed).not.toHaveBeenCalled();
  });
});
