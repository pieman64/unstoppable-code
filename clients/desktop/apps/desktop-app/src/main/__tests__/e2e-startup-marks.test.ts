import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

  it.each(['present', 'absent', 'unreadable'] as const)(
    'marks the first served fallback read only after its %s state resolves',
    async (state) => {
      const dir = mkdtempSync(join(tmpdir(), 'w5-startup-mark-'));
      const file = join(dir, 'index.json');
      if (state === 'present') writeFileSync(file, '{}');
      setE2eBuild(true);
      try {
        await jest.isolateModulesAsync(async () => {
          const { desktopW5FileStore } =
            await import('../lib/w5-commit-log-file-store');
          const { runW5FallbackRead } = await import('../lib/w5-fallback-read');
          const read = await runW5FallbackRead(() =>
            desktopW5FileStore.read(state === 'unreadable' ? dir : file),
          );
          expect(read.state).toBe(state);
          if (state === 'unreadable') {
            expect(globalThis.__CANOPY_E2E_STARTUP_MARKS__).toBeUndefined();
            await runW5FallbackRead(() => desktopW5FileStore.read(file));
          }
          const marks = globalThis.__CANOPY_E2E_STARTUP_MARKS__;
          expect(Object.keys(marks ?? {})).toEqual(['w5FirstReadServed']);
          expect(typeof marks?.w5FirstReadServed).toBe('number');
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
