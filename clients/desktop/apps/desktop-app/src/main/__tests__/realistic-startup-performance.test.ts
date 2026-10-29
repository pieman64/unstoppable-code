const mockIsE2eBuild = jest.fn<boolean, []>();

jest.mock('../lib/e2e-gate', () => ({
  isE2eBuild: (): boolean => mockIsE2eBuild(),
}));

import {
  isRealisticStartupPerformanceEnabled,
  REALISTIC_STARTUP_PERFORMANCE_ENV,
  recordRealisticStartupPerformanceEvent,
  resetRealisticStartupPerformanceEvents,
} from '../lib/realistic-startup-performance';

describe('realistic startup performance diagnostics', () => {
  beforeEach(() => {
    mockIsE2eBuild.mockReturnValue(false);
    delete process.env[REALISTIC_STARTUP_PERFORMANCE_ENV];
    resetRealisticStartupPerformanceEvents();
  });

  afterEach(() => {
    delete process.env[REALISTIC_STARTUP_PERFORMANCE_ENV];
    resetRealisticStartupPerformanceEvents();
  });

  it('cannot be enabled outside the E2E build', () => {
    expect(
      isRealisticStartupPerformanceEnabled(false, {
        [REALISTIC_STARTUP_PERFORMANCE_ENV]: '1',
      }),
    ).toBe(false);
  });

  it('records bounded startup events only for the explicit E2E diagnostic', () => {
    recordRealisticStartupPerformanceEvent('suppressed');
    expect(
      globalThis.__CANOPY_PERFORMANCE_REALISTIC_STARTUP_EVENTS__,
    ).toBeUndefined();

    mockIsE2eBuild.mockReturnValue(true);
    process.env[REALISTIC_STARTUP_PERFORMANCE_ENV] = '1';
    recordRealisticStartupPerformanceEvent('startup:unlock', {
      workspaceCount: 22,
    });

    const events = globalThis.__CANOPY_PERFORMANCE_REALISTIC_STARTUP_EVENTS__;
    expect(events).toHaveLength(1);
    expect(events?.[0]).toMatchObject({
      event: 'startup:unlock',
      details: { workspaceCount: 22 },
    });
    expect(typeof events?.[0]?.atMs).toBe('number');
  });
});
