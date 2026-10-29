'use strict';

// A sandboxed preload cannot use ES module imports.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { contextBridge } = require('electron');

// S5-only comparison preload. This never calls the native print function: it
// replaces it in the page's main world with a recorder so hidden probes cannot
// open a native print dialog.
try {
  const result = contextBridge.executeInMainWorld({
    func: () => {
      const calls = Array.isArray(globalThis.__can1570ExecuteInMainWorldCalls)
        ? globalThis.__can1570ExecuteInMainWorldCalls
        : [];

      Object.defineProperty(globalThis, '__can1570ExecuteInMainWorldCalls', {
        configurable: true,
        value: calls,
      });
      Object.defineProperty(globalThis, 'print', {
        configurable: true,
        writable: true,
        value: function can1570PrintProbe() {
          calls.push({
            href: String(location.href),
            isTop: window === window.top,
            at: Date.now(),
          });
        },
      });
      Object.defineProperty(
        globalThis,
        '__can1570ExecuteInMainWorldInstalled',
        {
          configurable: true,
          value: true,
        },
      );

      return true;
    },
  });

  // Consume an asynchronous rejection if this Electron implementation returns
  // one. The harness reads the installed marker and records unsupported or
  // failed injection as evidence rather than allowing the preload to crash.
  if (result && typeof result.catch === 'function') result.catch(() => {});
} catch {
  // The page-side marker remains absent, which the probe records explicitly.
}
