import { markE2eStartup } from '../lib/e2e-startup-marks';

const MARKS_KEY = '__CANOPY_E2E_STARTUP_MARKS__';

function setE2eBuild(value: boolean): void {
  Object.defineProperty(globalThis, '__CANOPY_E2E__', {
    configurable: true,
    value,
  });
}

describe('E2E startup marks', () => {
  afterEach(() => {
    setE2eBuild(false);
    Reflect.deleteProperty(globalThis, MARKS_KEY);
  });

  it('records nothing outside E2E builds', () => {
    setE2eBuild(false);
    markE2eStartup('mainReady', () => 435);
    expect(Reflect.has(globalThis, MARKS_KEY)).toBe(false);
  });

  it('records each mark once on main clock in E2E builds', () => {
    setE2eBuild(true);
    markE2eStartup('mainReady', () => 435.6);
    markE2eStartup('mainReady', () => 900);
    expect(globalThis.__CANOPY_E2E_STARTUP_MARKS__).toEqual({
      mainReady: 435.6,
    });
  });
});
