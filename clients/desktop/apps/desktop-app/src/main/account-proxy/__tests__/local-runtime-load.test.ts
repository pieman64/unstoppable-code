// The Electron specs load main-process modules through tsx, where build
// defines such as `__CANOPY_E2E__` do not exist. Loading the proxy runtime
// there must not throw (Internal Release 414, chat-visuals.spec.mjs).

describe('account proxy runtime outside a build', () => {
  const globals: Record<string, unknown> = globalThis;
  let saved: unknown;

  beforeEach(() => {
    saved = globals.__CANOPY_E2E__;
    delete globals.__CANOPY_E2E__;
  });

  afterEach(() => {
    globals.__CANOPY_E2E__ = saved;
  });

  it('loads without the E2E build define', () => {
    expect(() => {
      jest.isolateModules(() => {
        jest.requireActual('../local-runtime');
      });
    }).not.toThrow();
  });
});
