/** @jest-environment <rootDir>/apps/desktop-app/src/__tests__/jestReleasingNodeEnvironment.ts */
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';

const GLOBAL_SEAM = '__CANOPY_TEST_RELEASED_GLOBAL__';

function isGc(value: unknown): value is () => void {
  return typeof value === 'function';
}

function collectGarbage(): void {
  setFlagsFromString('--expose-gc');
  const gc: unknown = runInNewContext('gc');
  if (!isGc(gc)) throw new Error('Expected V8 to expose gc');
  gc();
}

describe('releasing node environment', () => {
  let released: WeakRef<object> | undefined;

  it('installs and removes a global seam', () => {
    const seam = { graph: new Array<number>(1024).fill(1) };
    released = new WeakRef(seam);
    Reflect.set(globalThis, GLOBAL_SEAM, seam);
    Reflect.deleteProperty(globalThis, GLOBAL_SEAM);
  });

  it('lets a later test collect the removed global value', async () => {
    // Leave the previous test's stack before collecting.
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    if (!released) throw new Error('Expected the previous test to run first');
    collectGarbage();
    expect(released.deref()).toBeUndefined();
  });
});
