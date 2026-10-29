// The quit chain's handle on the proxy this device runs (CAN-4023). The
// runtime registers its shutdown here when it loads, so quitting an app that
// never used the proxy loads nothing and returns at once.

let stopLocalProxy: (() => Promise<void>) | null = null;

export function registerLocalAccountProxyShutdown(
  stop: () => Promise<void>,
): void {
  stopLocalProxy = stop;
}

/** App quit: stop the proxy on this device if this launch started it. */
export async function shutdownLocalAccountProxyAtQuit(): Promise<void> {
  await stopLocalProxy?.();
}
